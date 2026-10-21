/**
 * Who is signed in, as the app starts (stores/auth.js), and what it shows
 * when the server can't say.
 *
 * The browser asks the server (/api/auth/status and /api/auth/me) on every
 * load. When that failed (the server down, a gateway's 502 page, a sign-in
 * proxy's page) and the browser had no account of its own to fall back on,
 * the app took the server for a single-user one and opened with no account
 * and no sign-in page. Now only a server that said it has no accounts opens
 * that way; one with accounts gets the sign-in page, which says why with
 * Retry (routes/Login.svelte).
 */

/**
 * The server's own answer to who is signed in: { status, me }. A web page
 * where its JSON should be throws (webPage: a sign-in proxy, or not the
 * server's address), and so does a redirect (the server never redirects
 * these, a sign-in proxy does, often to its own domain: read with
 * redirect 'manual' on the web, it shows as one) and an answer that isn't
 * the server's shape (an empty 200 is never a single-user server: every
 * CookTrace says `active` and `user`). The server's own error answer
 * throws serverError; a gateway's error page or no answer, unreachable.
 */
export async function readAuth(fetchFn, apiUrl, init) {
  // Loaded here, not up top: stores/auth.js imports this module everywhere
  // the app starts, the Android test phone included (scripts/android-sync).
  const { responseJson, webPageError } = await import('./server-signin.js');
  const [statusRes, meRes] = await Promise.all([
    fetchFn(apiUrl('/api/auth/status'), init),
    fetchFn(apiUrl('/api/auth/me'), init),
  ]);
  for (const res of [statusRes, meRes]) if (res.type === 'opaqueredirect') throw webPageError();
  const status = await responseJson(statusRes);
  const me = await responseJson(meRes);
  for (const res of [statusRes, meRes]) {
    if (!res.ok) throw Object.assign(new Error(`The server answered ${res.status}`), { status: res.status, serverError: true });
  }
  if (typeof status.active !== 'boolean' || !('user' in me)) throw webPageError();
  return { status, me };
}

/**
 * How reading the server failed: 'web_page' (something else answered),
 * 'server_error' (the server's own error answer, a 5xx or 429), 'gateway'
 * (a proxy's error page while the server restarts) or 'network' (no answer:
 * offline, the server down, a timeout).
 */
export function failureKind(e) {
  if (e?.webPage) return 'web_page';
  if (e?.serverError) return 'server_error';
  if (e?.unreachable || e?.status) return 'gateway';
  return 'network';
}

/**
 * What to show without the server's answer, from what this device kept:
 * - 'cached': the account it last had (offline, signed in);
 * - 'single_user': the server said it has no accounts, so the app opens;
 * - 'sign_in': a server with accounts, or something in the way: the
 *   sign-in page (the web app says why, with Retry);
 * - 'as_before': nothing kept and simply no answer. A browser that ever
 *   signed in kept the server's word ('1'), and Log Out keeps it, so this is
 *   a single-user install opened offline before the server was asked once
 *   since this version: it opens as it always did, and nothing is kept.
 * cachedUserMgmt is the server's last word on accounts: '1' it has them,
 * '0' single-user, null never heard. failure is failureKind's answer, if any.
 */
export function startState({ cachedUser, cachedUserMgmt, failure }) {
  if (cachedUser) {
    try {
      const user = JSON.parse(cachedUser);
      if (user && user.id != null) return { state: 'cached', user, userMgmtActive: cachedUserMgmt === '1' };
    } catch { /* unreadable: as if none */ }
  }
  if (cachedUserMgmt === '0') return { state: 'single_user' };
  if (cachedUserMgmt == null && failure === 'network') return { state: 'as_before' };
  return { state: 'sign_in' };
}
