/**
 * Talking to a server before the app is signed in to it: the Android app's
 * first run (routes/NativeSetup.svelte), Settings > Server Connection, and
 * the sign-in page (TraceApps/notetrace#36). The same as NoteTrace's.
 *
 * A sign-in proxy in front of the server (an Authentik or Authelia outpost,
 * Cloudflare Access) answers the app with its own web page, often with a
 * 200; so does a wrong address (the server answers any unknown path with
 * its web app). That's never taken for the server, nor read as JSON ("Unexpected
 * token '<'"): it's said plainly. And when the server's sign-in options
 * can't be read, the screen says so and offers Retry, instead of quietly
 * showing a password form that may not work.
 */
import { get, writable } from 'svelte/store';
import { _ } from 'svelte-i18n';
import { healthNeedsSetup, explainConnectError } from './platform.js';

const WEB_PAGE = "Something other than CookTrace answered with a web page: often a sign-in proxy (Authentik, Authelia, Cloudflare Access), or this isn't your server's address. Let the app reach /api on your server.";
const UNREACHABLE = "Can't reach your server right now. Check that it's running, then Retry.";
const PROXY_SIGN_IN = "Something in front of your server is asking you to sign in. Sign in there, then reload this page.";
const SERVER_ERROR = "Your server answered with an error. Try again in a moment.";
const OPTIONS_FAILED = "Couldn't load this server's sign-in options. Retry, or sign in with your password if the server allows it.";

/** A translated string, or the English one when i18n isn't loaded. */
function _say(key, english) {
  try {
    const t = get(_);
    const said = typeof t === 'function' ? t(key) : null;
    if (said && said !== key) return said;
  } catch { /* i18n not loaded */ }
  return english;
}

/** The error for a web page where the server's JSON should be. */
export function webPageError() {
  return Object.assign(new Error(_say('server_signin.web_page', WEB_PAGE)), { webPage: true });
}

/** No answer at all: offline, the server down, a timeout, a gateway's error page. */
function _noAnswer(e) {
  return !!(e?.unreachable || e?.network || e instanceof TypeError || e?.name === 'TimeoutError' || e?.name === 'AbortError');
}

/**
 * The one line the sign-in page says when the server couldn't be read, at
 * startup (who is signed in) or for its sign-in options: never two. A web
 * page in the way: in a browser, a sign-in proxy to sign in to first (the
 * browser can, the app can't); in the app, #36's line. The server's own
 * error answer says so, no answer is the server out of reach, and anything
 * else unreadable is `otherwise`: out of reach at startup, the options line
 * for the sign-in options.
 */
export function serverProblemText(e, { native = false, otherwise = 'unreachable' } = {}) {
  if (e?.webPage) return native ? e.message : _say('server_signin.proxy_sign_in', PROXY_SIGN_IN);
  if (e?.serverError) return _say('server_signin.server_error', SERVER_ERROR);
  if (_noAnswer(e) || otherwise !== 'options') return _say('server_signin.unreachable', UNREACHABLE);
  return _say('server_signin.options_failed', OPTIONS_FAILED);
}

/**
 * A reply that's neither the server's JSON nor a sign-in page: a gateway's
 * error page while the server restarts (502, 504, Cloudflare's 52x). That's
 * "can't reach the server", with the status kept for the log.
 */
function _unreachable(status) {
  return Object.assign(new Error(_say('common.errors.cant_reach_server', "Couldn't reach the server.")), { status, unreachable: true });
}

// A web page with one of these is a sign-in proxy answering: an outpost
// that sends its sign-in page (after a redirect, or straight away with a
// 401 or 403). Anything else that isn't JSON is the server out of reach.
const _proxyStatus = (s) => (s >= 200 && s < 300) || s === 401 || s === 403;

/** Text to JSON, or null when it isn't a JSON object. */
function _parse(text) {
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

function _json(status, data) {
  if (data && typeof data === 'object') return data;
  if (data == null || (typeof data === 'string' && !data.trim())) return {};
  const j = typeof data === 'string' ? _parse(data) : null;
  if (j) return j;
  if (_proxyStatus(status)) throw webPageError();
  console.warn('[server-signin] not the server\'s JSON, status', status);
  throw _unreachable(status);
}

/**
 * The JSON a server answered, from a CapacitorHttp reply ({ status, data }),
 * which hands back text for anything it doesn't take for JSON. An empty body
 * is {}. Whatever the status, the server's own JSON comes back for the
 * caller to judge; a web page is a sign-in proxy or the server out of reach.
 */
export function serverJson(res) {
  return _json(res?.status, res?.data);
}

/** The same for a fetch() Response. */
export async function responseJson(res) {
  return _json(res.status, await res.text());
}

// CapacitorHttp through lib/native-http.js, replaceable in tests.
let _httpImpl = null;
// A Capacitor plugin answers every property, `then` included, so an async
// function that returns it never settles (sign-in hung at "Checking..."):
// hand back plain methods instead.
export const _wrapHttp = (plugin) => ({ get: (o) => plugin.get(o), post: (o) => plugin.post(o) });
async function _http() {
  if (_httpImpl) return _httpImpl;
  const { NativeHttp } = await import('./native-http.js');
  return _wrapHttp(NativeHttp);
}
export function _useHttpForTests(http) { _httpImpl = http; }

const _ok = (res) => res.status >= 200 && res.status < 300;

/**
 * Throws unless `url` is a CookTrace server ready to sign in to: one that
 * isn't set up yet (marked needsSetup), a sign-in proxy's page (webPage),
 * or no answer / an error (unreachable).
 */
export async function checkServer(url) {
  const http = await _http();
  const res = await http.get({ url: `${url}/api/health` });
  if (healthNeedsSetup(res)) {
    throw Object.assign(new Error(_say('connect.needs_setup', "This server isn't set up yet. Open it in a browser to create the first account, then connect here.")), { needsSetup: true });
  }
  const data = serverJson(res);
  if (!_ok(res)) throw _unreachable(res.status);
  // Every CookTrace answers { ok: true }; anything else that answers 200
  // (an empty page, another app's JSON) isn't it.
  if (data.ok !== true) throw webPageError();
}

/**
 * Which ways the server offers to sign in: { providers, passwordLoginEnabled,
 * status } (status: the whole /api/auth/status answer). Throws when they
 * can't be read (no answer, an error, a web page), so the screen can say so
 * and offer Retry. A server from before SSO says nothing about it: password only.
 */
export async function discoverSignIn(url) {
  const http = await _http();
  const res = await http.get({ url: `${url}/api/auth/status` }).catch((err) => { throw Object.assign(err, { network: true }); });
  const data = serverJson(res);
  if (!_ok(res)) {
    console.warn('[server-signin] sign-in options: status', res.status);
    // The server's own error answer (JSON), or nothing readable (an empty body).
    throw Object.keys(data).length ? Object.assign(new Error(`status ${res.status}`), { status: res.status, serverError: true }) : _unreachable(res.status);
  }
  return {
    providers: Array.isArray(data?.oidc?.providers) ? data.oidc.providers : [],
    passwordLoginEnabled: data?.oidc?.enable_email_password_login !== false,
    status: data,
  };
}

/** Username and password sign-in: the server's { token, user }. */
export async function passwordSignIn(url, username, password) {
  const http = await _http();
  const res = await http.post({
    url: `${url}/api/auth/login`,
    headers: { 'Content-Type': 'application/json' },
    data: { username, password },
  });
  const body = serverJson(res);
  if (!_ok(res)) throw new Error(body.error || _say('native_setup_ui.login_failed', 'Sign-in failed'));
  return body;
}

/** The account a token signs in as, asked of a server the app isn't connected to yet. */
export async function accountFor(url, token) {
  const http = await _http();
  const res = await http.get({ url: `${url}/api/auth/me`, headers: { Authorization: `Bearer ${token}` } });
  const data = serverJson(res);
  if (!_ok(res) || !data.user) throw new Error(data.error || _say('native_setup_ui.login_failed', 'Sign-in failed'));
  return data.user;
}

/** What went wrong connecting, in words a person can act on. */
export function explainSignInError(e, url) {
  return e?.webPage || e?.needsSetup ? e.message : explainConnectError(e, url);
}

/** The SSO sign-in page for the app's browser hand-off (lib/oidc-app-handoff.js). */
export async function ssoSignInUrl(url, providerId) {
  const { appChallengeParam } = await import('./oidc-app-handoff.js');
  return `${url}/api/auth/oidc/login/${providerId}?mobile=1&return=${encodeURIComponent('#/')}${await appChallengeParam()}`;
}

/** Opens the server's SSO sign-in in the in-app browser; the app link comes back to App.svelte. */
export async function openSso(url, providerId) {
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url: await ssoSignInUrl(url, providerId), presentationStyle: 'popover' });
}

// ── The sign-in options on Settings > Server Connection ───────────────
/**
 * The options for whatever address is in the field, as a store:
 * { state: '' | 'checking' | 'ok' | 'failed', providers, passwordLoginEnabled, error, url }.
 * Typing clears them at once (no buttons for the address that was there),
 * and an answer for an address that's gone is dropped. A host half typed
 * isn't an error: a failure while typing shows nothing, and is said when
 * the field is left or on Retry.
 */
export function createSignInOptions({ discover = discoverSignIn, delay = 700 } = {}) {
  const blank = { state: '', providers: [], passwordLoginEnabled: true, error: '', url: '' };
  const store = writable(blank);
  let timer = null;
  let asked = 0;
  let target = '';
  const clean = (raw) => String(raw || '').trim().replace(/\/$/, '');
  // While typing, only an address that looks whole (a dot in the host, or
  // localhost or an IP); once the field is left, any http(s) address
  // (a name on the home network, like http://nas:3003).
  const looksWhole = (url) => /^https?:\/\/([^\s/.]+\.[^\s/]*[^\s/.]|localhost|[\d.]+)(:\d+)?(\/|$)/i.test(url);
  const isAddress = (url) => /^https?:\/\/[^\s/]+/i.test(url);

  async function load(url, quiet) {
    const mine = ++asked;
    store.set({ ...blank, state: 'checking', url });
    try {
      const found = await discover(url);
      if (mine !== asked) return;
      store.set({ ...blank, state: 'ok', url, providers: found.providers, passwordLoginEnabled: found.passwordLoginEnabled });
    } catch (e) {
      if (mine !== asked) return;
      if (quiet) { store.set({ ...blank, url }); return; }
      store.set({ ...blank, state: 'failed', url,
        error: serverProblemText(e, { native: true, otherwise: 'options' }) });
    }
  }

  return {
    subscribe: store.subscribe,
    /** The field changed: clear what's shown, and look the address up once typing settles. */
    typed(raw) {
      clearTimeout(timer);
      asked++;
      target = clean(raw);
      store.set(blank);
      if (looksWhole(target)) timer = setTimeout(() => load(target, true), delay);
    },
    /** The field was left: look it up now, and say if that fails. */
    left(raw) {
      clearTimeout(timer);
      target = clean(raw);
      const now = get(store);
      if (!isAddress(target)) { asked++; store.set(blank); return; }
      if (now.url === target && (now.state === 'ok' || now.state === 'checking' || now.state === 'failed')) return;
      load(target, false);
    },
    retry() { clearTimeout(timer); if (target) load(target, false); },
    stop() { clearTimeout(timer); asked++; },
  };
}

// ── SSO from Settings > Server Connection ─────────────────────────────
// The phone is still in local mode while the browser is open, so the app
// link that comes back (App.svelte) can't take the token for the app's own
// server: it hands it to Server Connection, which moves the phone's data
// over exactly as a password sign-in does.
const PENDING = 'ct:sso_connect';
const PENDING_FOR_MS = 30 * 60 * 1000;

export function rememberSsoConnect(url) {
  try { localStorage.setItem(PENDING, JSON.stringify({ url, at: Date.now() })); } catch { /* storage unavailable */ }
}

/**
 * The server a Settings SSO sign-in is for, if one was started in the last
 * half hour and the phone is still in local mode (`mode`: getNativeMode()).
 * Connected to a server, a sign-in link is that server's own.
 */
export function pendingSsoConnect(mode) {
  if (mode !== 'local') return null;
  try {
    const p = JSON.parse(localStorage.getItem(PENDING) || 'null');
    if (p?.url && Date.now() - (p.at || 0) < PENDING_FOR_MS) return p;
  } catch { /* none */ }
  return null;
}

export function forgetSsoConnect() {
  try { localStorage.removeItem(PENDING); } catch { /* storage unavailable */ }
}

/** Settings' SSO: remember the server, open its sign-in, and forget it again if that fails. */
export async function openSsoForConnect(url, providerId, open = openSso) {
  rememberSsoConnect(url);
  try { await open(url, providerId); } catch (e) { forgetSsoConnect(); throw e; }
}

/** { url, token, idTokenHint, providerId } from the app link, for Server Connection to finish. */
export const ssoConnectResult = writable(null);

/**
 * What to do with a cooktrace://oidc-callback link.
 *   { do: 'error' }                  the server said why sign-in failed
 *   { do: 'redeem', server }         swap the single-use code (server: null = the app's own)
 *   { do: 'token' }                  a bare token (a server from before the code hand-off)
 *   { do: 'refuse' }                 a bare token for a Settings sign-in that asked for a code
 *   { do: 'none' }
 * `connecting`: the pending Settings sign-in, if any; `challengeSent`: the
 * app asked for a code (lib/oidc-app-handoff.js). A bare token is taken
 * only where it's the only way an older server signs in: never for a
 * Settings sign-in that asked for a code, where any app could hand over a
 * token of its own and have the phone's recipes go to that account.
 */
export function ssoCallbackAction({ code, token, error, connecting, challengeSent }) {
  if (error) return { do: 'error' };
  if (code) return { do: 'redeem', server: connecting?.url || null };
  if (token) return connecting && challengeSent ? { do: 'refuse' } : { do: 'token' };
  return { do: 'none' };
}

const LOGOUT_HINT = 'ct:oidc_logout_hint';

/**
 * The SSO session Log Out also ends ({ providerId, idTokenHint }), or none:
 * a password sign-in or Disconnect clears it, so an old hint never goes to
 * another server.
 */
export function keepSsoLogoutHint(hint) {
  try {
    if (hint?.providerId && hint?.idTokenHint) localStorage.setItem(LOGOUT_HINT, JSON.stringify(hint));
    else localStorage.removeItem(LOGOUT_HINT);
  } catch { /* storage unavailable */ }
}
