/**
 * The <head> tags a public recipe link sends to chat apps and social sites.
 * Everything here comes from the recipe, so it all has to be escaped.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml, publicRecipeDescription, publicRecipeHead, injectPublicHead, publicPageHtml } from '../server/lib/public-recipe-meta.js';

const ctx = { origin: 'https://cook.example.com', basePath: '/ct', pageUrl: 'https://cook.example.com/ct/r/abc' };

test('escapes everything that could close an attribute or open a tag', () => {
  assert.equal(escapeHtml(`"><script>&'`), '&quot;&gt;&lt;script&gt;&amp;&#39;');
});

test('a hostile name cannot break out of the tags', () => {
  const head = publicRecipeHead({ name: '"><script>alert(1)</script>', description: '<img src=x onerror=alert(1)>' }, ctx);
  assert.ok(!head.includes('<script>'));
  assert.ok(!head.includes('<img'));
  assert.match(head, /<title>&quot;&gt;&lt;script&gt;/);
});

test('the description falls back to the ingredients, cut short', () => {
  assert.equal(publicRecipeDescription({ description: '  Bright\n rice  ' }), 'Bright rice');
  const d = publicRecipeDescription({ ingredients: [{ name: '', items: [{ name: 'Rice' }, { name: 'Lime' }] }] });
  assert.equal(d, 'Rice, Lime');
  const long = publicRecipeDescription({ description: 'word '.repeat(80) });
  assert.ok(long.length <= 201 && long.endsWith('…'));
});

test('the photo is the preview image, under the base path or as given', () => {
  assert.match(publicRecipeHead({ name: 'Rice', img_url: '/uploads/r.jpg' }, ctx), /og:image" content="https:\/\/cook\.example\.com\/ct\/uploads\/r\.jpg"/);
  assert.match(publicRecipeHead({ name: 'Rice', img_url: 'https://site.example/r.jpg' }, ctx), /og:image" content="https:\/\/site\.example\/r\.jpg"/);
  const head = publicRecipeHead({ name: 'Rice' }, ctx);
  assert.match(head, /og:image" content="https:\/\/cook\.example\.com\/ct\/icons\/icon-512\.png"/);
  assert.match(head, /twitter:card" content="summary"/);
});

test('the page keeps the token out of referrers and search engines', () => {
  const head = publicRecipeHead({ name: 'x' }, ctx);
  assert.match(head, /name="referrer" content="no-referrer"/);
  assert.match(head, /name="robots" content="noindex, nofollow"/);
});

test('the page loads the app from its root and has one title', () => {
  const html = '<html><head><meta charset="UTF-8" /><title>CookTrace</title><script src="./assets/index.js"></script></head></html>';
  const page = publicPageHtml(html, '/ct');
  assert.ok(page.indexOf('<base href="/ct/" />') < page.indexOf('./assets/'));
  const out = injectPublicHead(page, publicRecipeHead({ name: 'Rice' }, ctx));
  assert.equal((out.match(/<title>/g) || []).length, 1);
  assert.match(out, /<title>Rice<\/title>/);
});
