/**
 * public-recipe-meta.js: the <head> tags for a public recipe link, so a
 * chat app or social site that fetches the link shows the recipe's name, a
 * line about it, and its photo. Crawlers don't run the app, so these go
 * into the HTML the server sends. Pure, so it's testable without a
 * database. Same shape as NoteTrace's public-note-meta.js.
 */

const DESCRIPTION_CHARS = 200;

/** Escape for an HTML attribute value or text node. */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One plain-text line for og:description: the description, else the ingredients. */
export function publicRecipeDescription(recipe) {
  let text = String(recipe.description || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    const names = (recipe.ingredients || [])
      .flatMap(g => g.items || [])
      .map(i => String(i?.name || '').trim())
      .filter(Boolean);
    if (names.length) text = names.join(', ');
  }
  if (text.length > DESCRIPTION_CHARS) text = text.slice(0, DESCRIPTION_CHARS).replace(/\s+\S*$/, '') + '…';
  return text;
}

/** An absolute URL for the photo, or null when it isn't one a crawler can fetch. */
function absoluteUrl(url, origin, basePath) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `${origin}${basePath}${url}`;
  return null;
}

/**
 * The tags to put in <head>, as one string.
 *   recipe    what getPublicRecipe returned
 *   origin    scheme and host the link was opened on (no trailing slash)
 *   basePath  BASE_URL ('' at the root)
 *   pageUrl   the full public link
 */
export function publicRecipeHead(recipe, { origin, basePath = '', pageUrl }) {
  const title = (recipe.name || '').trim() || 'Recipe';
  const description = publicRecipeDescription(recipe);
  const image = absoluteUrl(recipe.img_url, origin, basePath);
  const icon = `${origin}${basePath}/icons/icon-512.png`;
  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    // Unlisted: the link works for whoever has it, but search engines skip it,
    // and following a link out of the recipe doesn't hand its token to that site.
    `<meta name="robots" content="noindex, nofollow" />`,
    `<meta name="referrer" content="no-referrer" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="CookTrace" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:url" content="${escapeHtml(pageUrl)}" />`,
    `<meta property="og:image" content="${escapeHtml(image || icon)}" />`,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
  ];
  if (description) {
    tags.push(
      `<meta name="description" content="${escapeHtml(description)}" />`,
      `<meta property="og:description" content="${escapeHtml(description)}" />`,
      `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    );
  }
  return tags.join('\n  ');
}

/**
 * The app's index.html as served at /r/<token>. The build links its scripts
 * and styles relative to the page (./assets/...), which from /r/ would point
 * at /r/assets/, so a <base> sends them back to the app's root.
 */
export function publicPageHtml(html, basePath = '') {
  return html.replace(/<head>/i, `<head>\n  <base href="${escapeHtml(basePath)}/" />`);
}

/** The page with its <title> swapped for the recipe's tags. */
export function injectPublicHead(html, head) {
  const swapped = html.replace(/<title>[^<]*<\/title>/, '');
  return swapped.replace('</head>', `  ${head}\n</head>`);
}
