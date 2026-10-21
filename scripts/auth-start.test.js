/**
 * What the app shows when it can't learn who is signed in.
 *
 * The bug: when the browser couldn't read /api/auth/status or /api/auth/me
 * (the server down, a gateway's 502 page, a sign-in proxy's page) and had
 * no account of its own to fall back on, it took the server for a
 * single-user one and opened with no account and no sign-in page. Now only
 * a server that said it has no accounts opens that way; anything else gets
 * the sign-in page, which says why with Retry (routes/Login.svelte). These
 * run the real stores/auth.js.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { get } from 'svelte/store';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window ??= { location: { hash: '' }, addEventListener() {}, dispatchEvent() {} };

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const A = await import('../src/stores/auth.js');
const { startState } = await import('../src/lib/auth-load.js');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const page = (html, status = 200) => new Response(html, { status, headers: { 'Content-Type': 'text/html' } });
const PROXY_PAGE = '<!doctype html><html><head><title>Sign in</title></head><body>VoidAuth</body></html>';
const GATEWAY_PAGE = '<html><body><h1>502 Bad Gateway</h1></body></html>';
const WITH_ACCOUNTS = { active: true, setup_required: false };
const SINGLE_USER = { active: false, setup_required: false, single_user_mode: true };
const ANN = { id: 7, username: 'ann', role: 'user' };

// The server, as /api/auth/status and /api/auth/me answer.
function serve(answer) {
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^.*?(\/api\/)/, '/api/');
    const a = typeof answer === 'function' ? answer(path) : answer;
    if (a instanceof Error) throw a;
    return a[path] instanceof Response ? a[path].clone() : a[path];
  };
}
const down = () => serve(new TypeError('Failed to fetch'));
const answers = (status, me) => serve({ '/api/auth/status': json(status), '/api/auth/me': json(me) });
const shows = () => {
  const said = get(A.authUnreachable);
  if (get(A.userMgmtActive) && !get(A.currentUser)) {
    if (!said) return 'sign-in';
    if (said === 'Something in front of your server is asking you to sign in. Sign in there, then reload this page.') return 'sign-in, says a sign-in proxy is in front';
    if (said === 'Your server answered with an error. Try again in a moment.') return 'sign-in, says the server answered with an error';
    if (said === "Can't reach your server right now. Check that it's running, then Retry.") return "sign-in, says it can't reach the server";
    return `sign-in, says: ${said}`;
  }
  assert.equal(said, null, 'nothing said over the app');
  return get(A.currentUser) ? `app as ${get(A.currentUser).username}` : 'app with no account';
};
const fresh = (flag = null) => {
  store.clear();
  if (flag != null) store.set('ct:cachedUserMgmt', flag);
  A.currentUser.set(null); A.userMgmtActive.set(false); A.authUnreachable.set(null); A.setupRequired.set(false);
};
const REDIRECT = { type: 'opaqueredirect', ok: false, status: 0, text: async () => '' };
const empty = (status = 200) => new Response(status === 204 ? null : '', { status });

test("a server with accounts that can't be read: the sign-in page, saying why", async () => {
  for (const [label, setup, said] of [
    ['server down', down, "sign-in, says it can't reach the server"],
    ['a gateway 502 page', () => serve({ '/api/auth/status': page(GATEWAY_PAGE, 502), '/api/auth/me': page(GATEWAY_PAGE, 502) }), "sign-in, says it can't reach the server"],
    ['a gateway 504 page', () => serve({ '/api/auth/status': page(GATEWAY_PAGE, 504), '/api/auth/me': page(GATEWAY_PAGE, 504) }), "sign-in, says it can't reach the server"],
    ["the server's own error", () => serve({ '/api/auth/status': json({ error: 'boom' }, 500), '/api/auth/me': json({ error: 'boom' }, 500) }), 'sign-in, says the server answered with an error'],
    ['the server busy (429)', () => serve({ '/api/auth/status': json({ error: 'Too many requests' }, 429), '/api/auth/me': json({ user: null }) }), 'sign-in, says the server answered with an error'],
    ["a sign-in proxy's page", () => serve({ '/api/auth/status': page(PROXY_PAGE), '/api/auth/me': page(PROXY_PAGE) }), 'sign-in, says a sign-in proxy is in front'],
    // A proxy's redirect (to its own domain, say), read with redirect: 'manual'.
    ["a sign-in proxy's redirect", () => serve({ '/api/auth/status': REDIRECT, '/api/auth/me': REDIRECT }), 'sign-in, says a sign-in proxy is in front'],
  ]) {
    fresh('1');
    setup();
    await A.loadAuthState();
    assert.equal(shows(), said, label);
  }
  // Once the server answers, nothing is said any more.
  answers(WITH_ACCOUNTS, { user: null, csrf: null });
  await A.loadAuthState();
  assert.equal(shows(), 'sign-in');
});

test('an empty answer is never a single-user server', async () => {
  for (const [flag, res] of [['1', () => empty(200)], ['1', () => empty(204)], [null, () => empty(200)], ['1', () => json({})]]) {
    fresh(flag);
    serve({ '/api/auth/status': res(), '/api/auth/me': res() });
    await A.loadAuthState();
    assert.equal(shows(), 'sign-in, says a sign-in proxy is in front', `flag ${flag}`);
    assert.equal(localStorage.getItem('ct:cachedUserMgmt'), flag, 'nothing new remembered');
  }
  // /status right but /me without a user key: not the server either.
  fresh('1');
  serve({ '/api/auth/status': json(WITH_ACCOUNTS), '/api/auth/me': json({}) });
  await A.loadAuthState();
  assert.equal(shows(), 'sign-in, says a sign-in proxy is in front');
});

test('a server with accounts is remembered without anyone signed in, and when someone signs in', async () => {
  fresh();
  answers(WITH_ACCOUNTS, { user: null, csrf: null });
  await A.loadAuthState();
  assert.equal(localStorage.getItem('ct:cachedUserMgmt'), '1');
  fresh();
  answers(WITH_ACCOUNTS, { user: ANN, csrf: 'c' });
  await A.loadAuthState();
  assert.equal(localStorage.getItem('ct:cachedUserMgmt'), '1');
  // Log Out drops the account, keeps the server's word, so a later outage is the sign-in page.
  const auth = read('../src/stores/auth.js');
  const logout = auth.slice(auth.indexOf('export async function logout'));
  assert.match(logout, /localStorage\.removeItem\('ct:cachedUser'\)/);
  assert.doesNotMatch(logout, /removeItem\('ct:cachedUserMgmt'\)/);
  localStorage.removeItem('ct:cachedUser');
  A.currentUser.set(null);
  down();
  await A.loadAuthState();
  assert.equal(shows(), "sign-in, says it can't reach the server");
});

test("a single-user server opens the app, online and when it can't be reached", async () => {
  fresh();
  answers(SINGLE_USER, { user: null, csrf: null });
  await A.loadAuthState();
  assert.equal(shows(), 'app as local');
  assert.equal(localStorage.getItem('ct:cachedUserMgmt'), '0', 'remembered: nobody signs in to it');
  for (const setup of [down, () => serve({ '/api/auth/status': page(GATEWAY_PAGE, 502), '/api/auth/me': page(GATEWAY_PAGE, 502) })]) {
    setup();
    await A.loadAuthState();
    assert.equal(shows(), 'app as local');
  }
});

test('never heard from the server: no answer at all opens as before, anything else is the sign-in page', async () => {
  // A single-user install whose first load of this version is offline.
  fresh();
  down();
  await A.loadAuthState();
  assert.equal(shows(), 'app with no account');
  assert.equal(localStorage.getItem('ct:cachedUserMgmt'), null, 'nothing remembered');
  for (const [label, setup] of [
    ['a gateway 502 page', () => serve({ '/api/auth/status': page(GATEWAY_PAGE, 502), '/api/auth/me': page(GATEWAY_PAGE, 502) })],
    ["a sign-in proxy's page", () => serve({ '/api/auth/status': page(PROXY_PAGE), '/api/auth/me': page(PROXY_PAGE) })],
    ["the server's own error", () => serve({ '/api/auth/status': json({ error: 'boom' }, 503), '/api/auth/me': json({ error: 'boom' }, 503) })],
  ]) {
    fresh();
    setup();
    await A.loadAuthState();
    assert.match(shows(), /^sign-in, says/, label);
  }
});

test("setting up a fresh server: a failed check keeps the wizard", async () => {
  fresh();
  answers({ active: false, setup_required: true }, { user: null, csrf: null });
  await A.loadAuthState();
  assert.equal(get(A.setupRequired), true);
  assert.equal(localStorage.getItem('ct:cachedUserMgmt'), null, "a fresh server isn't single-user");
  down();
  await A.loadAuthState();
  assert.equal(get(A.setupRequired), true);
  assert.equal(get(A.userMgmtActive), false, 'not the sign-in page');
  assert.equal(get(A.authUnreachable), null);
});

test("signed in, then the server gone: this browser's own copy of the account", async () => {
  fresh();
  answers(WITH_ACCOUNTS, { user: ANN, csrf: 'c' });
  await A.loadAuthState();
  assert.equal(shows(), 'app as ann');
  down();
  A.currentUser.set(null);
  await A.loadAuthState();
  assert.equal(shows(), 'app as ann');
  assert.equal(get(A.userMgmtActive), true);
});

test('signing in clears what the sign-in page said', async () => {
  fresh('1');
  down();
  await A.loadAuthState();
  assert.ok(get(A.authUnreachable));
  A.currentUser.set(ANN);
  assert.equal(get(A.authUnreachable), null);
});

test('the Android app after Log Out starts at its sign-in page, never the app with no token', () => {
  assert.equal(startState({ cachedUser: null, cachedUserMgmt: '1' }).state, 'sign_in');
  assert.equal(startState({ cachedUser: null, cachedUserMgmt: null }).state, 'sign_in', 'never heard: sign-in, not the app');
  assert.equal(startState({ cachedUser: null, cachedUserMgmt: '0' }).state, 'single_user');
  assert.equal(startState({ cachedUser: '{not json', cachedUserMgmt: '1' }).state, 'sign_in');
  assert.deepEqual(startState({ cachedUser: JSON.stringify(ANN), cachedUserMgmt: '1' }), { state: 'cached', user: ANN, userMgmtActive: true });
  // The Android start uses the same rule, with no failure kind: never "as before".
  assert.match(read('../src/stores/auth.js'), /getStore\(currentUser\) == null && startState\(\{ cachedUserMgmt: localStorage\.getItem\('ct:cachedUserMgmt'\) \}\)\.state === 'sign_in'\) userMgmtActive\.set\(true\);/);
});

test('the sign-in page says why, with Retry that asks again (and on coming back online); the app has no separate screen', () => {
  const login = read('../src/routes/Login.svelte');
  assert.match(login, /\{#if \$authUnreachable\}[\s\S]{0,200}on:click=\{retryServer\}/);
  assert.match(login, /window\.addEventListener\('online', backOnline\);/);
  assert.doesNotMatch(read('../src/App.svelte'), /authUnreachable|authProblem|cant_reach/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.equal(en.server_signin.unreachable, "Can't reach your server right now. Check that it's running, then Retry.");
  assert.equal(en.connect.cant_reach_title, undefined);
});

test("the Android app keeps #36's line for a web page; the browser says to sign in to the proxy", async () => {
  const S = await import('../src/lib/server-signin.js');
  const web = S.webPageError();
  assert.match(S.serverProblemText(web, { native: true }), /^Something other than CookTrace answered with a web page/);
  assert.equal(S.serverProblemText(web), 'Something in front of your server is asking you to sign in. Sign in there, then reload this page.');
  assert.equal(S.serverProblemText(Object.assign(new Error('x'), { serverError: true, status: 503 })), 'Your server answered with an error. Try again in a moment.');
  assert.equal(S.serverProblemText(new TypeError('Failed to fetch')), "Can't reach your server right now. Check that it's running, then Retry.");
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.equal(en.server_signin.proxy_sign_in, 'Something in front of your server is asking you to sign in. Sign in there, then reload this page.');
  assert.equal(en.server_signin.server_error, 'Your server answered with an error. Try again in a moment.');
  // The web reads these without following redirects.
  assert.match(read('../src/stores/auth.js'), /\.\.\.\(isNative \? \{\} : \{ redirect: 'manual' \}\)/);
});

test('the sign-in page says one line with the real reason, from the options load too (web and Android)', async () => {
  const S = await import('../src/lib/server-signin.js');
  const say = (e, native) => S.serverProblemText(e, { native, otherwise: 'options' });
  const UNREACHABLE = "Can't reach your server right now. Check that it's running, then Retry.";
  const OPTIONS = "Couldn't load this server's sign-in options. Retry, or sign in with your password if the server allows it.";
  const native = (answers) => { S._useHttpForTests({ get: async ({ url }) => { const a = answers[new URL(url).pathname]; if (a instanceof Error) throw a; return a; }, post: async () => ({ status: 500, data: {} }) }); };
  const reason = async (native_) => { try { await S.discoverSignIn('https://cook.example'); return 'loaded'; } catch (e) { return say(e, native_); } };
  // Android after Log Out, server stopped: CapacitorHttp throws (no answer).
  native({ '/api/auth/status': new Error('Failed to connect to cook.example') });
  assert.equal(await reason(true), UNREACHABLE);
  // A gateway's 502 / 504 / Cloudflare 52x page while the server restarts.
  for (const status of [502, 504, 522]) {
    native({ '/api/auth/status': { status, data: '<html><h1>Bad Gateway</h1></html>' } });
    assert.equal(await reason(true), UNREACHABLE, `${status}`);
  }
  // The server's own error answer, and a busy server.
  for (const status of [500, 503, 429]) {
    native({ '/api/auth/status': { status, data: { error: 'boom' } } });
    assert.equal(await reason(true), 'Your server answered with an error. Try again in a moment.', `${status}`);
  }
  // A sign-in proxy's page: #36's line in the app, the proxy line in a browser.
  native({ '/api/auth/status': { status: 200, data: '<!doctype html><title>Sign in</title>' } });
  assert.match(await reason(true), /^Something other than CookTrace answered with a web page/);
  assert.equal(await reason(false), 'Something in front of your server is asking you to sign in. Sign in there, then reload this page.');
  // Only an otherwise unreadable reply keeps the options line.
  assert.equal(say(new Error('something odd'), true), OPTIONS);
  // In a browser fetch fails with a TypeError, and a timeout is a TimeoutError: no answer.
  assert.equal(say(new TypeError('Failed to fetch'), false), UNREACHABLE);
  assert.equal(say(Object.assign(new Error('timed out'), { name: 'TimeoutError' }), false), UNREACHABLE);
  S._useHttpForTests(null);
  // One notice: the startup line first, else the options line, never both.
  const login = read('../src/routes/Login.svelte');
  assert.match(login, /\{#if \$authUnreachable\}[\s\S]*?\{:else if optionsError\}/);
  assert.match(login, /optionsError = serverProblemText\(e, \{ native: isNative, otherwise: 'options' \}\);/);
  assert.match(login, /redirect: 'manual'/);
});
