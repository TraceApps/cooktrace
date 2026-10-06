/**
 * The recipe share card (GET /api/recipes/:id/card.png, an SVG).
 *
 * Three problems, each reproduced against the server before the fix: an
 * image link with a quote in it ran script as the app when the card was
 * opened (stored XSS, the card is served from this origin); a private
 * recipe's card was sent Cache-Control: public, so a shared cache could keep
 * it for others; and an app image's link took its host from the request.
 * A name was also stripped of & and < instead of escaped.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('../server/routes/recipes.js', import.meta.url), 'utf8');
const route = src.slice(src.indexOf("router.get('/:id/card.png'"), src.indexOf('function _textWrap'));
const fn = (name) => src.slice(src.indexOf(`function ${name}(`), src.indexOf('\n}\n', src.indexOf(`function ${name}(`)) + 2);
const helpers = (base = '') => new Function(`const _BASE_PATH = ${JSON.stringify(base)};\n${fn('_escapeXml')}\n${fn('_absoluteUrl')}\n${fn('_textWrap')}\nreturn { _escapeXml, _absoluteUrl, _textWrap };`)();

test('names and links are escaped, not stripped', () => {
  const { _escapeXml, _textWrap } = helpers();
  assert.equal(_textWrap('Mac & Cheese <Deluxe>', 22), 'Mac &amp; Cheese &lt;Deluxe&gt;');
  assert.equal(_escapeXml('x.jpg" onerror="alert(1)'), 'x.jpg&quot; onerror=&quot;alert(1)');
  assert.match(route, /<image href="\$\{_escapeXml\(heroUrl\)\}"/);
});

test('an image link is a web address or an app path on this origin, nothing else', () => {
  const h = helpers();
  assert.equal(h._absoluteUrl({}, 'https://img.test/a.jpg'), 'https://img.test/a.jpg');
  assert.equal(h._absoluteUrl({}, '/uploads/a.jpg'), '/uploads/a.jpg');
  assert.equal(h._absoluteUrl({}, 'javascript:alert(1)'), '');
  assert.equal(h._absoluteUrl({}, '//evil.test/a.jpg'), '');
  assert.equal(helpers('/cook')._absoluteUrl({}, '/uploads/a.jpg'), '/cook/uploads/a.jpg', 'under BASE_URL');
  assert.equal(helpers('/cook')._absoluteUrl({}, '/cook/uploads/a.jpg'), '/cook/uploads/a.jpg', 'not twice');
  assert.doesNotMatch(fn('_absoluteUrl'), /x-forwarded-host|headers\.host/);
});

test('who may see the card is who may see the recipe', () => {
  assert.match(route, /const isOwner = \(u == null && recipe\.user_id == null\) \|\| recipe\.user_id === u;/);
  assert.match(route, /SELECT 1 FROM recipe_shares WHERE recipe_id = \? AND grantee_id = \?/);
  assert.match(route, /if \(!isOwner && !isShared && recipe\.visibility !== 'group'\)/);
});

test('the card is private to caches and cannot run script', () => {
  assert.match(route, /res\.setHeader\('Cache-Control', 'private, no-store'\);/);
  assert.match(route, /Content-Security-Policy', "default-src 'none'; img-src 'self' https: http: data:; style-src 'unsafe-inline'; sandbox"/);
  assert.doesNotMatch(route, /'public, max-age/);
});
