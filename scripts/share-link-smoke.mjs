/**
 * share-link-smoke.mjs: public recipe links end to end.
 *
 * Run ONLY against a throwaway instance: it registers accounts and creates
 * recipes.
 *
 *   docker run -d -p 3003:3003 -e JWT_SECRET=... <image>
 *   COOKTRACE_URL=http://localhost:3003 node scripts/share-link-smoke.mjs
 */
const B = process.env.COOKTRACE_URL || 'http://localhost:3003';
let token = '';
let failures = 0;
const ok = (cond, msg) => { if (cond) console.log('  ok  ', msg); else { failures++; console.log('  FAIL', msg); } };
async function api(method, path, body, tok = token) {
  const res = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

await api('POST', '/api/auth/register', { username: 'admin', password: 'Phase1!Test', full_name: 'Admin' });
token = (await api('POST', '/api/auth/login', { username: 'admin', password: 'Phase1!Test' })).json.token;
ok(!!token, 'login');
const inv = (await api('POST', '/api/auth/invite', { role: 'user' })).json;
const invToken = new URL(inv.inviteUrl.replace('/#/', '/')).searchParams.get('token');
await api('POST', '/api/auth/accept-invite', { token: invToken, username: 'sam', password: 'Share!Test9', full_name: 'Sam' });
const sam = (await api('POST', '/api/auth/login', { username: 'sam', password: 'Share!Test9' })).json.token;
ok(!!sam, 'second account signs in');

console.log('public link');
const r = (await api('POST', '/api/recipes', { name: 'Lime rice', description: 'Bright jasmine rice.', servings: 4, img_url: '/uploads/lime.jpg',
  ingredients: [{ name: 'Jasmine rice', qty: 2, unit: 'cup' }], steps: ['Rinse', 'Simmer 15 minutes'] })).json;
ok((await api('POST', `/api/recipes/${r.id}/share`, null, sam)).status === 403, 'another account cannot make a link');
const first = (await api('POST', `/api/recipes/${r.id}/share`)).json.share_token;
ok(/^[A-Za-z0-9_-]{22}$/.test(first || ''), 'owner makes a link');
const pub = await api('GET', `/api/r/${first}`, null, '');
ok(pub.status === 200 && pub.json.name === 'Lime rice', 'anyone with the link reads the recipe without signing in');
const leaked = ['user_id', 'visibility', 'share_token', 'favorite'].filter(k => k in pub.json);
ok(leaked.length === 0, `public view leaks no account fields (leaked: ${leaked.join() || 'none'})`);
ok((await api('GET', '/api/r/short', null, '')).status === 400 && (await api('GET', `/api/r/${first.slice(0, -1)}x`, null, '')).status === 404, 'a wrong token reads nothing');

const page = await fetch(`${B}/r/${first}`);
const html = await page.text();
ok(page.status === 200 && html.includes('<meta property="og:title" content="Lime rice" />') && html.includes('og:image" content="http'), 'the link page carries the preview tags');
ok(html.includes('<base href="/" />') && page.headers.get('referrer-policy') === 'no-referrer' && /noindex/.test(page.headers.get('x-robots-tag') || ''), 'the page loads from the root and keeps the token private');
ok((await fetch(`${B}/r/AAAAAAAAAAAAAAAAAAAAAA`)).status === 404, 'an unknown link page is a 404');

const xss = (await api('POST', '/api/recipes', { name: '"><script>alert(1)</script>', description: '<img src=x onerror=alert(1)>' })).json;
const xssTok = (await api('POST', `/api/recipes/${xss.id}/share`)).json.share_token;
const xssHtml = await (await fetch(`${B}/r/${xssTok}`)).text();
ok(!xssHtml.includes('<script>alert(1)') && !xssHtml.includes('<img src=x'), 'preview tags are escaped');

// A device still holding the link after it was removed must not bring it back.
await api('DELETE', `/api/recipes/${r.id}/share`);
ok((await api('GET', `/api/r/${first}`, null, '')).status === 404, 'removing the link stops it at once');
const push = await api('POST', '/api/sync/push', { tables: { recipes: [{ client_id: 1, server_id: r.id, name: 'Lime rice', share_token: first, updated_at: '2099-01-01 00:00:00' }] } });
ok(push.status === 200 && (await api('GET', `/api/r/${first}`, null, '')).status === 404, 'a stale device cannot revive a removed link');
const chosen = await api('POST', '/api/sync/push', { tables: { recipes: [{ client_id: 2, name: 'Pushed', share_token: 'chosen-by-device-1', updated_at: '2099-01-01 00:00:00' }] } });
ok(chosen.status === 200 && (await api('GET', '/api/r/chosen-by-device-1', null, '')).status === 404, 'a device cannot choose a link');
const second = (await api('POST', `/api/recipes/${r.id}/share`)).json.share_token;
const pull = (await api('GET', '/api/sync/pull?since=1970-01-01')).json;
ok(pull.tables.recipes.find(x => x.id === r.id)?.share_token === second, 'devices still learn the link through sync');
ok(second !== first && (await api('GET', `/api/r/${first}`, null, '')).status === 404, 'a new link never revives the old one');

await api('DELETE', `/api/recipes/${r.id}`);
ok((await api('GET', `/api/r/${second}`, null, '')).status === 404, 'a deleted recipe is not public');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
