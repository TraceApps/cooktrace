/**
 * Connecting the Android app to a server (TraceApps/notetrace#36).
 *
 * The report: the server had SSO, the web app showed "Sign In with OIDC",
 * the Android app's setup showed only a username and password. A sign-in
 * proxy in front of the server (an Authentik or Authelia outpost, Cloudflare
 * Access) answered the app with its own web page: setup took it for the
 * server, couldn't read the sign-in options and quietly showed a password
 * form, and a password then failed with "Unexpected token '<'". Settings >
 * Server Connection had no SSO at all. Now a web page in the way is said
 * plainly, options that can't be read are said with Retry (setup, Settings
 * and the sign-in page), and Settings signs in with SSO too, taking only the
 * single-use code it asked for.
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
const S = await import('../src/lib/server-signin.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const WEB_PAGE = /^Something other than CookTrace answered with a web page: often a sign-in proxy \(Authentik, Authelia, Cloudflare Access\), or this isn't your server's address\. Let the app reach \/api on your server\.$/;
const PROXY_PAGE = '<!doctype html><html><head><title>Sign in</title></head><body>Authentik</body></html>';
const GATEWAY_PAGE = '<html><body><h1>502 Bad Gateway</h1></body></html>';
const isWebPage = (e) => e.webPage === true && WEB_PAGE.test(e.message) && !/Unexpected token/.test(e.message);
const isUnreachable = (status) => (e) => e.unreachable === true && e.status === status && !e.webPage;

// CapacitorHttp as a table of answers: path -> { status, data }.
function fakeHttp(answers) {
  const calls = [];
  const answer = (method) => async (opts) => {
    calls.push({ method, ...opts });
    const a = answers[new URL(opts.url).pathname] ?? answers['*'];
    if (!a) throw new Error('Unable to resolve host');
    return typeof a === 'function' ? a(opts) : a;
  };
  return { get: answer('GET'), post: answer('POST'), calls };
}
const URL_ = 'https://cook.example.com';
const proxy = (status = 200) => fakeHttp({ '*': { status, data: PROXY_PAGE } });

test('a web page is a sign-in proxy only where a proxy sends one; a gateway error page is the server out of reach', async () => {
  assert.deepEqual(S.serverJson({ status: 200, data: { ok: true } }), { ok: true });
  assert.deepEqual(S.serverJson({ status: 200, data: '{"ok":true}' }), { ok: true }, 'CapacitorHttp may hand back text');
  assert.deepEqual(S.serverJson({ status: 204, data: '' }), {});
  assert.deepEqual(S.serverJson({ status: 500, data: { error: 'boom' } }), { error: 'boom' }, "the server's own error comes back to judge");
  // Authelia behind Traefik answers an app with 401, Cloudflare Access with 403.
  for (const status of [200, 401, 403]) {
    for (const data of [PROXY_PAGE, 'OK']) assert.throws(() => S.serverJson({ status, data }), isWebPage, `${status} ${data}`);
  }
  // While the server restarts: a gateway's page, not a sign-in proxy.
  for (const status of [502, 504, 521, 404]) assert.throws(() => S.serverJson({ status, data: GATEWAY_PAGE }), isUnreachable(status), String(status));
  // The same for fetch() (the sign-in page on the web).
  const res = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(S.responseJson(res(200, PROXY_PAGE)), isWebPage);
  await assert.rejects(S.responseJson(res(502, GATEWAY_PAGE)), isUnreachable(502));
  assert.deepEqual(await S.responseJson(new Response('{"token":"t"}', { status: 200 })), { token: 't' });
});

test('the server check stops at a sign-in proxy, a fresh server, or one out of reach', async () => {
  for (const status of [200, 401, 403]) {
    S._useHttpForTests(proxy(status));
    await assert.rejects(S.checkServer(URL_), isWebPage, String(status));
  }
  S._useHttpForTests(fakeHttp({ '/api/health': { status: 502, data: GATEWAY_PAGE } }));
  await assert.rejects(S.checkServer(URL_), isUnreachable(502));
  S._useHttpForTests(fakeHttp({ '/api/health': { status: 200, data: { ok: true, setup_required: true } } }));
  await assert.rejects(S.checkServer(URL_), (e) => e.needsSetup && /isn't set up yet/.test(e.message));
  for (const data of ['', '{}', { status: 'up' }]) {
    S._useHttpForTests(fakeHttp({ '/api/health': { status: 200, data } }));
    await assert.rejects(S.checkServer(URL_), isWebPage, `not CookTrace: ${JSON.stringify(data)}`);
  }
  S._useHttpForTests(fakeHttp({ '/api/health': { status: 200, data: { ok: true } } }));
  await S.checkServer(URL_);
  // Said as it is, not wrapped as "couldn't connect: ...".
  S._useHttpForTests(proxy());
  const e = await S.checkServer(URL_).catch((x) => x);
  assert.equal(S.explainSignInError(e, URL_), e.message);
});

test('sign-in options: what the server has, or an error to say with Retry, never a silent password form', async () => {
  const status = (oidc) => fakeHttp({ '/api/auth/status': { status: 200, data: { active: true, oidc } } });
  const p = [{ id: 1, display_name: 'Authentik' }];
  S._useHttpForTests(status({ providers: p, enable_email_password_login: true }));
  assert.deepEqual((({ providers, passwordLoginEnabled }) => ({ providers, passwordLoginEnabled }))(await S.discoverSignIn(URL_)), { providers: p, passwordLoginEnabled: true });
  S._useHttpForTests(status({ providers: p, enable_email_password_login: false }));
  assert.equal((await S.discoverSignIn(URL_)).passwordLoginEnabled, false);
  S._useHttpForTests(status(undefined));
  assert.deepEqual((await S.discoverSignIn(URL_)).providers, [], 'a server without SSO');
  S._useHttpForTests(fakeHttp({ '/api/auth/status': { status: 500, data: { error: 'boom' } } }));
  // The server's own error answer is said as one (not out of reach, not "couldn't load").
  await assert.rejects(S.discoverSignIn(URL_), (e) => e.serverError === true && e.status === 500 && !e.webPage);
  S._useHttpForTests(fakeHttp({}));
  await assert.rejects(S.discoverSignIn(URL_), /Unable to resolve host/);
  S._useHttpForTests(proxy());
  await assert.rejects(S.discoverSignIn(URL_), isWebPage);
});

test('a password sign-in judges the status before blaming a proxy', async () => {
  for (const status of [200, 401, 403]) {
    S._useHttpForTests(proxy(status));
    await assert.rejects(S.passwordSignIn(URL_, 'ann', 'pw'), isWebPage, String(status));
  }
  // A gateway page while the server restarts is the server out of reach, not a proxy.
  for (const status of [502, 504]) {
    S._useHttpForTests(fakeHttp({ '/api/auth/login': { status, data: GATEWAY_PAGE } }));
    await assert.rejects(S.passwordSignIn(URL_, 'ann', 'pw'), isUnreachable(status), String(status));
  }
  S._useHttpForTests(fakeHttp({ '/api/auth/login': { status: 401, data: { error: 'Invalid credentials' } } }));
  await assert.rejects(S.passwordSignIn(URL_, 'ann', 'pw'), /Invalid credentials/);
  const ok = fakeHttp({ '/api/auth/login': { status: 200, data: { token: 't1', user: { id: 7 } } } });
  S._useHttpForTests(ok);
  assert.deepEqual(await S.passwordSignIn(URL_, 'ann', 'pw'), { token: 't1', user: { id: 7 } });
  assert.deepEqual(ok.calls[0].data, { username: 'ann', password: 'pw' });
});

test('after SSO the account is read with the new token', async () => {
  S._useHttpForTests(fakeHttp({ '/api/auth/me': ({ headers }) => ({ status: 200, data: { user: headers.Authorization === 'Bearer tok' ? { id: 9 } : null } }) }));
  assert.deepEqual(await S.accountFor(URL_, 'tok'), { id: 9 });
  await assert.rejects(S.accountFor(URL_, 'wrong'), /Sign-in failed/);
  S._useHttpForTests(proxy());
  await assert.rejects(S.accountFor(URL_, 'tok'), isWebPage);
});

test('a Settings SSO sign-in is remembered only in local mode, for half an hour, and forgotten if the browser fails to open', async () => {
  store.clear();
  S.rememberSsoConnect(URL_);
  assert.equal(S.pendingSsoConnect('local')?.url, URL_);
  // Connected to a server, a sign-in link is that server's own.
  assert.equal(S.pendingSsoConnect('server'), null);
  assert.equal(S.pendingSsoConnect(null), null, 'the web app');
  store.set('ct:sso_connect', JSON.stringify({ url: URL_, at: Date.now() - 31 * 60_000 }));
  assert.equal(S.pendingSsoConnect('local'), null, 'an abandoned one runs out');
  store.set('ct:sso_connect', '{not json');
  assert.equal(S.pendingSsoConnect('local'), null);
  store.clear();
  await assert.rejects(S.openSsoForConnect(URL_, 1, async () => { throw new Error('no browser'); }), /no browser/);
  assert.equal(store.has('ct:sso_connect'), false, 'nothing left waiting');
  await S.openSsoForConnect(URL_, 1, async () => {});
  assert.equal(S.pendingSsoConnect('local')?.url, URL_);
  S.forgetSsoConnect();
  assert.equal(S.pendingSsoConnect('local'), null);
});

test('a sign-in link: Settings takes only the code it asked for, never a bare token', () => {
  const connecting = { url: URL_ };
  assert.deepEqual(S.ssoCallbackAction({ error: 'denied', code: 'c', connecting }), { do: 'error' });
  assert.deepEqual(S.ssoCallbackAction({ code: 'c', connecting, challengeSent: true }), { do: 'redeem', server: URL_ });
  assert.deepEqual(S.ssoCallbackAction({ code: 'c' }), { do: 'redeem', server: null }, "first run: the app's own server");
  // Another app could hand over a token of its own: refused, the phone's recipes stay put.
  assert.deepEqual(S.ssoCallbackAction({ token: 't', connecting, challengeSent: true }), { do: 'refuse' });
  // First run and the sign-in page still take an older server's bare token.
  assert.deepEqual(S.ssoCallbackAction({ token: 't', challengeSent: true }), { do: 'token' });
  assert.deepEqual(S.ssoCallbackAction({ token: 't', connecting, challengeSent: false }), { do: 'token' }, 'no code was asked for');
  assert.deepEqual(S.ssoCallbackAction({}), { do: 'none' });
});

test('the address field: typing clears the options, an old answer is dropped, a half-typed host is no error', async () => {
  const waits = new Map();
  const discover = (url) => new Promise((resolve, reject) => waits.set(url, { resolve, reject }));
  const opts = S.createSignInOptions({ discover, delay: 5 });
  const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
  opts.typed('https://cook');
  await tick();
  assert.equal(get(opts).state, '', 'not a whole host: nothing asked');
  opts.typed('https://cook.example.com');
  await tick();
  assert.equal(get(opts).state, 'checking');
  opts.typed('https://cook.example.co');
  assert.equal(get(opts).state, '', 'cleared at once');
  waits.get('https://cook.example.com').resolve({ providers: [{ id: 1 }], passwordLoginEnabled: true });
  await new Promise((r) => setImmediate(r)); // before the new address is looked up
  assert.deepEqual([get(opts).state, get(opts).providers], ['', []], "the old address's answer is dropped");
  await tick();
  waits.get('https://cook.example.co').reject(new Error('Unable to resolve host'));
  await tick();
  assert.equal(get(opts).state, '', 'a failure while typing says nothing');
  opts.left('https://cook.example.co');
  waits.get('https://cook.example.co').reject(new Error('Unable to resolve host'));
  await tick();
  assert.equal(get(opts).state, 'failed', 'said once the field is left');
  opts.retry();
  waits.get('https://cook.example.co').resolve({ providers: [{ id: 2 }], passwordLoginEnabled: false });
  await tick();
  assert.deepEqual([get(opts).state, get(opts).providers.length, get(opts).passwordLoginEnabled], ['ok', 1, false]);
  opts.left('nas');
  assert.equal(get(opts).state, '', 'not an address');
  opts.stop();
});

test('the IdP logout hint is kept only for an SSO sign-in, and cleared otherwise', () => {
  store.clear();
  S.keepSsoLogoutHint({ providerId: '1', idTokenHint: 'h' });
  assert.deepEqual(JSON.parse(store.get('ct:oidc_logout_hint')), { providerId: '1', idTokenHint: 'h' });
  S.keepSsoLogoutHint(null);
  assert.equal(store.has('ct:oidc_logout_hint'), false);
});

test('the screens use it: setup, Settings, the sign-in page and the app link', () => {
  const setup = read('../src/routes/NativeSetup.svelte');
  assert.doesNotMatch(setup, /leave defaults|JSON\.parse/, 'no silent fallback, no raw parse');
  assert.match(setup, /await checkServer\(url\);/);
  assert.match(setup, /optionsError = serverProblemText\(e, \{ native: true, otherwise: 'options' \}\);/);
  assert.match(setup, /\{#if optionsError\}[\s\S]*?on:click=\{retryOptions\}/);
  assert.match(setup, /if \(connecting\) return;\s*connecting = true;\s*setServerUrl\(validatedUrl\);/, 'one browser at a time');

  const sc = read('../src/components/settings/SettingsServerConnection.svelte');
  // Leaving the field looks the address up, after a plain-HTTP address's warning (TraceApps/nutritrace#194).
  assert.match(sc, /on:input=\{\(\) => signInOptions\.typed\(serverUrl\)\}\s*on:blur=\{addressLeft\}/);
  assert.match(sc, /async function addressLeft\(\) \{[\s\S]{0,400}signInOptions\.left\(serverUrl\);/);
  assert.match(sc, /async function connectWithSso\(providerId\) \{\s*if \(busy\) return;/);
  assert.match(sc, /const body = await passwordSignIn\(url, username\.trim\(\), password\);\s*_pendingLogoutHint = null;\s*forgetSsoConnect\(\);\s*await _signedIn\(url, body\.token, body\.user\);/);
  assert.match(sc, /const user = await accountFor\(url, token\);[\s\S]*?await _signedIn\(url, token, user\);/);
  // The hint is kept once connected, not on the hand-back.
  assert.match(sc, /keepSsoLogoutHint\(_pendingLogoutHint\);\s*setServerUrl\(_pendingServerUrl\);/);
  assert.doesNotMatch(sc.slice(sc.indexOf('async function _finishSso'), sc.indexOf('async function _signedIn')), /localStorage|keepSsoLogoutHint/);
  assert.match(sc, /keepSsoLogoutHint\(null\); \/\/ this server's SSO session/, 'Disconnect clears it');
  assert.doesNotMatch(sc, /JSON\.parse/);

  const login = read('../src/routes/Login.svelte');
  assert.match(login, /if \(isNative\) data = \(await discoverSignIn\(getServerUrl\(\)\)\)\.status;/);
  assert.match(login, /\{[#:](?:else )?if optionsError\}[\s\S]*?on:click=\{loadSignInOptions\}/);
  assert.doesNotMatch(login, /\.json\(\)/, 'every reply through the web-page check');
  assert.doesNotMatch(login, /\} catch \{\}\s*\}\);/, 'no silent catch on the options');

  const app = read('../src/App.svelte');
  assert.match(app, /const connecting = pendingSsoConnect\(getNativeMode\(\)\);/);
  assert.match(app, /if \(action\.do === 'refuse'\) \{[\s\S]*?server_signin\.token_refused[\s\S]*?return;/);
  assert.match(app, /redeemHandoff\(code, action\.server\)/);
  assert.match(read('../src/lib/oidc-app-handoff.js'), /fetch\(baseUrl \? `\$\{baseUrl\}\/api\/auth\/oidc\/handoff` : apiUrl\('\/api\/auth\/oidc\/handoff'\)/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.match(en.server_signin.web_page, WEB_PAGE);
  for (const k of ['options_failed', 'token_refused', 'retry', 'checking']) assert.ok(en.server_signin[k], k);
});

test('the native HTTP plugin is handed over as plain methods, so awaiting it settles', async () => {
  const { _wrapHttp } = await import('../src/lib/server-signin.js');
  // Like a Capacitor plugin: every property is a function, `then` included,
  // and that `then` never calls back.
  const plugin = new Proxy({}, { get: (_, key) => (key === 'then' ? () => {} : async (o) => ({ status: 200, data: { key, url: o.url } })) });
  const settles = (p) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 200))]);
  assert.equal(await settles((async () => plugin)()), false, 'the plugin itself never settles');
  const http = await (async () => _wrapHttp(plugin))();
  assert.deepEqual(await http.get({ url: 'https://x' }), { status: 200, data: { key: 'get', url: 'https://x' } });
  assert.deepEqual((await http.post({ url: 'https://y' })).data.key, 'post');
});
