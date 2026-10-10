/**
 * MCP tool: set_recipe_image (write)
 *
 * Set the hero image of one of the token owner's recipes, from a URL or
 * from base64 image bytes. Either way the image becomes a file under
 * /uploads/ like one uploaded in the app, so it never depends on the
 * source staying up:
 *
 * - image_url goes through localizeImage (lib/image-localizer.js), the
 *   same download the importers use, with its private-address guard. That
 *   path doesn't check what it downloaded, so the file is checked here by
 *   its magic bytes and removed if it isn't an image.
 * - image_data goes through localizeDataUrl, the path offline photos take:
 *   magic-byte checked and capped at 12 MB. The MCP route's 1 MB request
 *   limit bounds it further (~700 KB of image once base64-encoded).
 *
 * The copy being replaced is kept as an earlier version, as update_recipe
 * does, so a wrong image can be undone from the recipe page.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';
import { localizeImage, localizeDataUrl } from '../../image-localizer.js';
import { detectImageType } from '../../image-magic.js';
import { saveRecipeVersion } from '../../recipe-versions.js';

const UPLOADS_DIR = process.env.UPLOADS_PATH || './uploads';

async function _fromUrl(imageUrl) {
  let parsed;
  try { parsed = new URL(imageUrl); } catch { return { error: 'image_url is not a valid URL.' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'image_url must be http(s).' };
  }
  const local = await localizeImage(imageUrl);
  // localizeImage hands back the original URL when it refuses or fails.
  if (typeof local !== 'string' || !local.startsWith('/uploads/')) {
    return { error: 'Could not download image_url (unreachable, refused as a private address, or not found).' };
  }
  const filePath = path.join(UPLOADS_DIR, path.basename(local));
  let type = null;
  try { type = await detectImageType(filePath); } catch { type = null; }
  if (!type) {
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    return { error: 'image_url did not return an image.' };
  }
  return { imgUrl: local };
}

function _fromData(imageData, mimeType) {
  const b64 = imageData.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  const local = localizeDataUrl(`data:${mimeType};base64,${b64}`);
  if (!local) return { error: 'image_data is not a valid image (or is larger than 12 MB).' };
  return { imgUrl: local };
}

export function registerSetRecipeImage(server, { userId }) {
  server.registerTool(
    'set_recipe_image',
    {
      title: 'Set Recipe Image',
      description:
        "Set a recipe's hero image from image_url (downloaded and stored on the server) " +
        'or from image_data (base64 image bytes, for a local file; keep it under ~700 KB). ' +
        'Send exactly one. The previous copy is kept as an earlier version.',
      inputSchema: {
        recipe_id:  z.number().int().positive(),
        image_url:  z.string().url().max(2000).optional(),
        image_data: z.string().min(1).optional(),
        mime_type:  z.enum(['image/jpeg', 'image/png', 'image/webp']).optional()
          .describe('Type of image_data; defaults to image/jpeg.'),
      },
    },
    async ({ recipe_id, image_url, image_data, mime_type }) => {
      if ((image_url ? 1 : 0) + (image_data ? 1 : 0) !== 1) {
        return toolError('Send exactly one of image_url or image_data.');
      }
      const existing = db.prepare(
        `SELECT * FROM recipes WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
      ).get(recipe_id, userId);
      if (!existing) return toolError(`recipe_id ${recipe_id} not found in your recipes.`);

      const result = image_url
        ? await _fromUrl(image_url)
        : _fromData(image_data, mime_type || 'image/jpeg');
      if (result.error) return toolError(result.error);

      db.transaction(() => {
        saveRecipeVersion(existing.id, existing.user_id, existing, {
          reason: 'replaced',
          editedBy: existing.last_edited_by ?? existing.user_id,
        });
        db.prepare(
          `UPDATE recipes SET img_url = ?, last_edited_by = NULL, updated_at = datetime('now')
           WHERE id = ? AND user_id = ?`
        ).run(result.imgUrl, existing.id, userId);
      })();

      return toolResult({ ok: true, recipe_id, img_url: result.imgUrl });
    }
  );
}
