/**
 * MCP tools that change a recipe after it's made (#74): update_recipe and
 * set_recipe_image (write tier), import_recipe_from_url (destructive tier,
 * like create_recipe), and the nutrition shape create_recipe shares.
 *
 * Every change saves through updateRecipe (routes/recipes.js), the code
 * the app's own edit uses: the copy it replaces is kept as an earlier
 * version, a change to what you cook is a new version in the recipe's
 * history, pantry links and the wipe guard apply, and phones get it on
 * their next sync. So an agent's edit can always be undone in the app.
 * Only the caller's own recipes, as with the read tools.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError, safeJson } from '../_util.js';
import { updateRecipe, importRecipeFromUrl } from '../../../routes/recipes.js';
import { downloadImage, saveImageBase64 } from '../../image-localizer.js';
import { envOn } from '../../outbound-policy.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// The nutrients a recipe keeps, per serving (src/lib/nutriments.js; a test
// keeps the two lists the same).
export const NUTRIENT_KEYS = [
  'calories', 'kilojoules', 'fat', 'saturated-fat', 'trans-fat', 'polyunsaturated-fat', 'monounsaturated-fat',
  'cholesterol', 'sodium', 'salt', 'carbohydrates', 'fiber', 'sugars', 'added-sugars', 'proteins',
  'vitamin-d', 'calcium', 'iron', 'potassium', 'vitamin-a', 'vitamin-c', 'vitamin-e', 'vitamin-k',
  'b1', 'b2', 'b3', 'b6', 'b9', 'b12', 'magnesium', 'zinc', 'phosphorus', 'caffeine', 'alcohol',
];

// Per serving, by key; null takes a value out. Grams, except calories
// (kcal), kilojoules (kJ), and the mg/mcg ones the app labels.
// Every key optional (a record keyed by an enum wants all of them), and
// no others.
export const nutritionSchema = z.object(Object.fromEntries(NUTRIENT_KEYS.map(k => [k, z.number().min(0).max(100000).nullable().optional()]))).strict()
  .describe(`Per serving. Keys: ${NUTRIENT_KEYS.join(', ')}. Grams, except calories (kcal), kilojoules (kJ), and cholesterol, sodium, calcium, iron, potassium, magnesium, zinc, phosphorus, caffeine, vitamin C and E, B1-B6 (mg) and vitamin A, D, K, B9, B12 (mcg). null removes a value.`);

/**
 * Values merged onto what's there: a key sent as null goes, the rest stay.
 * Sodium and salt are one value in two units (the app works out whichever
 * is missing): setting or removing one drops the other unless both are
 * sent, as the pantry sheet's editor does.
 */
export function mergeNutrition(existing, patch) {
  const out = { ...(existing && typeof existing === 'object' ? existing : {}) };
  const derived = { ...(out._derived && typeof out._derived === 'object' ? out._derived : {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v == null) delete out[k];
    else out[k] = v;
    delete derived[k];
    if (k === 'sodium' || k === 'salt') {
      const other = k === 'sodium' ? 'salt' : 'sodium';
      if (!(other in (patch || {}))) { delete out[other]; delete derived[other]; }
    }
  }
  if (Object.keys(derived).length) out._derived = derived; else delete out._derived;
  return out;
}

// Who may make the server fetch an address on its own network over MCP:
// only an owner who said so (ALLOW_PRIVATE_RECIPE_URLS). An admin may in the
// app, choosing the link; an agent can be steered by what a page says.
const _mcpPrivate = () => envOn(process.env.ALLOW_PRIVATE_RECIPE_URLS);

export const ingredientSchema = z.object({
  name: z.string().min(1).max(200),
  qty:  z.union([z.string(), z.number()]).optional(),
  unit: z.string().max(20).optional(),
  note: z.string().max(200).optional(),
});

// The recipe as the app's save takes it: every field, so what an update
// doesn't send stays as it is.
function _asBody(row) {
  return {
    name: row.name, description: row.description, img_url: row.img_url,
    servings: row.servings, yield_text: row.yield_text,
    prep_minutes: row.prep_minutes, cook_minutes: row.cook_minutes,
    rest_minutes: row.rest_minutes, total_minutes: row.total_minutes,
    rating: row.rating, favorite: !!row.favorite,
    ingredients: safeJson(row.ingredients, []), steps: safeJson(row.steps, []),
    tags: safeJson(row.tags, []), tools: safeJson(row.tools, []),
    nutrition: safeJson(row.nutrition, {}),
    source_url: row.source_url, notes: row.notes, visibility: row.visibility,
    category_id: row.category_id, video_url: row.video_url,
  };
}

// New ingredients as one group, as the editor makes them. One that was
// there under the same name keeps its id (a step's ingredient chips point
// at it) and its pantry link; a new one gets an id of its own.
function _ingredients(list, existing) {
  const before = new Map();
  const walk = items => { for (const it of items || []) if (it && it.name) before.set(String(it.name).trim().toLowerCase(), it); };
  for (const g of Array.isArray(existing) ? existing : []) {
    if (g && Array.isArray(g.items)) walk(g.items); else walk([g]);
  }
  return [{
    name: '',
    items: list.map(it => {
      const name = it.name.trim();
      const was = before.get(name.toLowerCase());
      before.delete(name.toLowerCase());
      return {
        id: was?.id || crypto.randomUUID(),
        name, qty: it.qty != null ? String(it.qty) : '', unit: it.unit || '', note: it.note || '',
        ...(was?.pantry_item_id ? { pantry_item_id: was.pantry_item_id } : {}),
      };
    }),
  }];
}

const _steps = list => list.map(s => ({ title: '', text: s.trim(), refIds: [], imgUrl: '' }));

function _own(recipeId, userId) {
  return db.prepare(`SELECT * FROM recipes WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).get(recipeId, userId);
}

// A stored column, or a row already turned into objects (an import's).
const _val = (v, fallback) => (typeof v === 'string' ? safeJson(v, fallback) : (v ?? fallback));

function _summary(r) {
  const groups = _val(r.ingredients, []);
  const count = groups.reduce((n, g) => n + (Array.isArray(g?.items) ? g.items.length : 1), 0);
  return {
    id: r.id, name: r.name, servings: r.servings ?? null,
    ingredient_count: count, step_count: _val(r.steps, []).length,
    img_url: r.img_url ?? r.imgUrl ?? null, nutrition: _val(r.nutrition, {}),
  };
}

function _save(recipeId, body, ctx) {
  const r = updateRecipe(recipeId, body, { u: ctx.userId, role: ctx.role ?? null });
  if (r.status !== 200) return toolError(r.body?.error || `Couldn't save the recipe (${r.status}).`);
  const row = db.prepare(`SELECT * FROM recipes WHERE id = ?`).get(recipeId);
  return toolResult({ ok: true, updated: _summary(row) });
}

export function registerUpdateRecipe(server, ctx) {
  server.registerTool(
    'update_recipe',
    {
      title: 'Update Recipe',
      description:
        'Change one of your recipes. Only the fields you send change. Sending ingredients or steps ' +
        'replaces that whole list (ingredients keep their pantry links by name). nutrition is merged: ' +
        'send only the values to set, null to remove one. The replaced copy is kept as an earlier ' +
        'version in the app, so an edit can be undone there.',
      inputSchema: {
        recipe_id:    z.number().int().positive(),
        name:         z.string().min(1).max(200).optional(),
        description:  z.string().max(2000).nullable().optional(),
        servings:     z.number().int().positive().max(1000).optional(),
        prep_minutes: z.number().int().min(0).max(10000).nullable().optional(),
        cook_minutes: z.number().int().min(0).max(10000).nullable().optional(),
        rest_minutes: z.number().int().min(0).max(10000).nullable().optional(),
        ingredients:  z.array(ingredientSchema).min(1).optional(),
        steps:        z.array(z.string().min(1).max(2000)).min(1).optional(),
        tags:         z.array(z.string().min(1).max(50)).max(20).optional(),
        source_url:   z.string().url().max(500).nullable().optional(),
        notes:        z.string().max(2000).nullable().optional(),
        nutrition:    nutritionSchema.optional(),
      },
    },
    async (args) => {
      const row = _own(args.recipe_id, ctx.userId);
      if (!row) return toolError(`recipe_id ${args.recipe_id} not found in your recipes.`);
      const body = _asBody(row);
      for (const f of ['name', 'description', 'servings', 'prep_minutes', 'cook_minutes', 'rest_minutes', 'tags', 'source_url', 'notes']) {
        if (args[f] !== undefined) body[f] = typeof args[f] === 'string' && f !== 'description' && f !== 'notes' ? args[f].trim() : args[f];
      }
      if (args.ingredients) body.ingredients = _ingredients(args.ingredients, body.ingredients);
      if (args.steps) body.steps = _steps(args.steps);
      if (args.nutrition) {
        body.nutrition = mergeNutrition(body.nutrition, args.nutrition);
        // The save keeps the values there when it's sent none (a guard
        // against a stale copy wiping them), so say so rather than pretend.
        if (!Object.keys(body.nutrition).some(k => k !== '_derived')) {
          return toolError('nutrition would end up empty, which a save keeps from happening: leave at least one value, or remove them in the app.');
        }
      }
      const changed = Object.keys(args).filter(k => k !== 'recipe_id' && args[k] !== undefined);
      if (!changed.length) return toolError('Nothing to change: send at least one field besides recipe_id.');
      return _save(row.id, body, ctx);
    }
  );
}

export function registerSetRecipeImage(server, ctx) {
  server.registerTool(
    'set_recipe_image',
    {
      title: 'Set Recipe Image',
      description:
        "Set a recipe's photo, from image_url (a public http or https address the server downloads) " +
        'or image_data (base64, with or without a data: prefix). JPEG, PNG, WebP, GIF, AVIF or HEIC, ' +
        'up to 12 MB. The previous photo stays in the earlier version the app keeps.',
      inputSchema: {
        recipe_id:  z.number().int().positive(),
        image_url:  z.string().url().max(2000).optional(),
        image_data: z.string().max(17 * 1024 * 1024).optional(),
      },
    },
    async ({ recipe_id, image_url, image_data }) => {
      if (!image_url === !image_data) return toolError('Send either image_url or image_data, not both.');
      const row = _own(recipe_id, ctx.userId);
      if (!row) return toolError(`recipe_id ${recipe_id} not found in your recipes.`);
      let saved;
      try {
        saved = image_url
          ? await downloadImage(image_url, { allowPrivate: _mcpPrivate() })
          : saveImageBase64(image_data);
      } catch (e) {
        return toolError(`Couldn't use that image: ${e.message}.`);
      }
      // Read again after the download: an edit made meanwhile stays.
      const now = _own(recipe_id, ctx.userId);
      const out = now ? _save(now.id, { ..._asBody(now), img_url: saved }, ctx) : toolError(`recipe_id ${recipe_id} was removed meanwhile.`);
      if (out.isError) _forget(saved);
      return out;
    }
  );
}

// A photo saved for a change that didn't go in.
function _forget(saved) {
  try { fs.unlinkSync(path.join(process.env.UPLOADS_PATH || './uploads', path.basename(saved))); } catch { /* gone already */ }
}

export function registerImportRecipeFromUrl(server, ctx) {
  server.registerTool(
    'import_recipe_from_url',
    {
      title: 'Import Recipe from URL',
      description:
        "Import a recipe from a web page, as the app's URL import does. Requires confirm=true. tier: " +
        "standard (the page's own recipe data only, no AI), enhanced (site-specific parsers, when the " +
        "server has them) or smart (the AI provider set up for Trace); without it, the user's own " +
        'choice in Settings. A recipe already in the library (same name or link) is not imported twice.',
      inputSchema: {
        confirm: z.boolean(),
        url:     z.string().url().max(2000),
        tier:    z.enum(['standard', 'enhanced', 'smart']).optional(),
      },
    },
    async ({ confirm, url, tier }) => {
      if (confirm !== true) {
        return toolError('import_recipe_from_url requires confirm=true, as it adds a recipe to the library. Set confirm to true and call it again if you mean to.');
      }
      const r = await importRecipeFromUrl(url, { u: ctx.userId, role: ctx.role ?? null, username: ctx.username ?? null, tier: tier || null, allowPrivate: _mcpPrivate() });
      if (r.error) return toolError(r.details?.length ? `${r.error}: ${r.details.join('; ')}` : r.error);
      if (r.skipped) return toolResult({ ok: true, skipped: 'already in your library', existing_id: r.existing_id, name: r.name });
      return toolResult({ ok: true, tier: r.tier, created: _summary(r.recipe) });
    }
  );
}
