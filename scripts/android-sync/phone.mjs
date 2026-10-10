// One phone, running the app's own sync code (src/lib/sync.js,
// db-native.js, api-native.js) against a real CookTrace server that
// android-sync.test.js starts, through one scenario, while "the web" edits
// the same recipes through the REST API as the web app does. Prints its
// findings as JSON on the last line, after @@.
//
//   CT_SERVER=http://127.0.0.1:<port> CT_TOKEN=<token> [PHONE_SKEW_MS=<ms>] [PHONE_DELAY_MS=<ms>]
//   node --import ./scripts/android-sync/register.mjs scripts/android-sync/phone.mjs <scenario>

const realFetch = globalThis.fetch;
const server = process.env.CT_SERVER;
const token = process.env.CT_TOKEN;
const skew = Number(process.env.PHONE_SKEW_MS || 0);
const delayMax = Number(process.env.PHONE_DELAY_MS || 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The phone's network: as slow as asked (a different delay each time),
// able to fail one request on purpose, to hold requests (holdFor: ms, by
// url), or to lose one answer after the server has the request
// (dropAnswer). Every request is noted, with the session it carried.
let failNext = null;
let holdFor = () => 0;
let dropAnswer = null;
const sent = [];
const authOf = init => { const h = init?.headers || {}; return String(h.Authorization || h.authorization || '').replace(/^Bearer /, ''); };
globalThis.fetch = async (url, init) => {
  if (failNext && failNext(String(url), init)) { failNext = null; throw new TypeError('Failed to fetch'); }
  if (delayMax) await sleep(Math.floor(Math.random() * delayMax));
  // The cookie jar (per host) goes with every request, as on Android.
  const jarAll = globalThis.__cookieJar ??= new Map();
  let reqHost = ''; try { reqHost = new URL(String(url)).host; } catch { /* relative */ }
  const jar = jarAll.get(reqHost) || new Map();
  if (jar.size) {
    init = { ...(init || {}), headers: { ...(init?.headers || {}), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } };
  }
  const entry = { url: String(url).replace(server, ''), method: init?.method || 'GET', token: authOf(init), cookie: !!jar.size, at: Date.now() };
  sent.push(entry);
  const hold = holdFor(String(url), init);
  // Held as a slow server would: an abort ends the wait at once.
  if (hold) entry.held = true;
  if (hold) await new Promise(r => { const t = setTimeout(r, hold); init?.signal?.addEventListener?.('abort', () => { clearTimeout(t); r(); }); });
  if (init?.signal?.aborted) { entry.aborted = true; throw new DOMException('aborted', 'AbortError'); }
  const res = await realFetch(url, init);
  // Capacitor keeps what a native request receives at the request's host
  // and again at the app's own address (CapacitorCookieManager.put).
  for (const c of res.headers.getSetCookie?.() || []) {
    const [kv] = c.split(';'); const i = kv.indexOf('=');
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    for (const h of [reqHost, new URL(globalThis.location.origin).host]) {
      if (!jarAll.has(h)) jarAll.set(h, new Map());
      if (!v || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) jarAll.get(h).delete(k); else jarAll.get(h).set(k, v);
    }
  }
  if (dropAnswer && dropAnswer(String(url), init)) { dropAnswer = null; await res.text(); throw new TypeError('Failed to fetch'); }
  return res;
};
globalThis.window = globalThis;
// The app's own address (Capacitor's local hostname).
globalThis.location ??= { origin: 'https://app.cooktrace.local', href: 'https://app.cooktrace.local/', hash: '' };
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
// What the app tells the pages (ct:sync-complete), noted.
const events = [];
globalThis.CustomEvent ??= class { constructor(type, o) { this.type = type; this.detail = o?.detail; } };
globalThis.dispatchEvent = e => { events.push({ type: e?.type, detail: e?.detail }); return true; };
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
const store = new Map();
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), key: i => [...store.keys()][i] ?? null, get length() { return store.size; } }, configurable: true });

// The web: plain requests, on the server's clock.
async function web(method, path, body, tok = token) {
  const r = await realFetch(server + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) { const e = new Error(`${method} ${path} ${r.status} ${t.slice(0, 160)}`); e.status = r.status; throw e; }
  return t ? JSON.parse(t) : null;
}
// A save as the web app makes it: with the copy the page had.
async function webSave(id, change) {
  const r = await web('GET', `/api/recipes/${id}`);
  const now = new Date(Date.now() - skew).toISOString();
  return web('PUT', `/api/recipes/${id}`, { ...r, ...change, _sync: { base_synced_at: r.synced_at, changed: Object.keys(change), edited_at: now, client_now: now } });
}

const dbn = await import('../../src/lib/db-native.js');
const { dbInit, getDb } = dbn;
await dbInit();
const { fullSync } = await import('../../src/lib/sync.js');
const { CtApiNative: api } = await import('../../src/lib/api-native.js');
const db = await getDb();
const sync = async () => { const r = await fullSync({ silent: true }, true); if (!r.ok) throw new Error('sync ' + JSON.stringify(r)); return r; };
const local = async sid => (await db.query(`SELECT * FROM recipes WHERE server_id = ?`, [sid])).values[0];
const localRecipe = async sid => api.getRecipe((await local(sid)).id);
const phoneEdit = async (sid, tag) => { const x = await localRecipe(sid); await api.updateRecipe(x.id, { ...x, name: `Soup (${tag})`, notes: `${tag} notes` }); };
const webEdit = (sid, tag) => webSave(sid, { name: `Soup (${tag})`, notes: `${tag} notes` });
const versions = async sid => (await web('GET', `/api/recipes/${sid}/versions`).catch(() => [])).map(v => v.data.name);
const newRecipe = async (extra = {}) => (await web('POST', '/api/recipes', { name: 'Soup', ingredients: [{ items: [{ name: 'water' }] }], steps: ['Boil'], notes: 'original', ...extra })).id;
const both = async sid => {
  const s = await web('GET', `/api/recipes/${sid}`).catch(e => ({ gone: e.status }));
  const p = await local(sid);
  return {
    server: s.gone ? `gone ${s.gone}` : { name: s.name, rating: s.rating, favorite: !!s.favorite, visibility: s.visibility, cook_count: s.cook_count, servings: s.servings },
    phone: p ? { name: p.name, rating: p.rating, favorite: !!p.favorite, cook_count: p.cook_count, deleted: p.deleted_at != null, pending: p.sync_status === 'pending' } : null,
  };
};
const out = {};
// Who the server says a session is.
const me = async tok => (await web('GET', '/api/auth/me', null, tok)).user;
// Signing in or out on the phone: the session the app sends from now on.
const signIn = tok => { if (tok == null) delete process.env.CT_TOKEN; else process.env.CT_TOKEN = tok; };
// Rows of the account's tables still on the phone.
const ACCOUNT_TABLES = ['recipes', 'pantry_items', 'cook_diary', 'shopping_list', 'recipe_categories', 'pantry_categories', 'custom_units', 'cookbooks', 'recipe_comments', 'ai_chat_history', 'recipe_cookbook_links', 'user_settings', 'sync_deletes'];
const rowsHere = async () => {
  let n = 0;
  for (const t of ACCOUNT_TABLES) n += (await db.query(`SELECT COUNT(*) AS n FROM ${t}`)).values[0].n;
  return n;
};

const scenarios = {
  // An edit made offline on the phone, older than one made on the web since.
  async olderPhone() {
    const id = await newRecipe(); await sync();
    await phoneEdit(id, 'phone'); await sleep(3100); await webEdit(id, 'web');
    await sync();
    Object.assign(out, await both(id), { versions: await versions(id) });
  },
  async newerPhone() {
    const id = await newRecipe(); await sync();
    await webEdit(id, 'web'); await sleep(3100); await phoneEdit(id, 'phone');
    await sync();
    Object.assign(out, await both(id), { versions: await versions(id) });
  },
  // Only the phone edits, over several syncs, then edits the web's copy.
  async noConflict() {
    const id = await newRecipe(); await sync();
    for (const n of [1, 2, 3]) { await phoneEdit(id, `phone${n}`); await sync(); await sleep(1100); }
    await webEdit(id, 'web'); await sync(); await sleep(1100);
    await phoneEdit(id, 'phone4'); await sync();
    Object.assign(out, await both(id), { versions: await versions(id) });
  },
  // The web changes the content; the phone then rates, favorites and logs a
  // cook (no servings set and no picture: values a save used to rewrite).
  async metaOnly() {
    const id = await newRecipe({ servings: null }); await sync();
    await webEdit(id, 'web'); await sleep(1100);
    let x = await localRecipe(id); await api.updateRecipe(x.id, { ...x, rating: 4 });
    x = await localRecipe(id); await api.updateRecipe(x.id, { ...x, favorite: true });
    x = await localRecipe(id); await api.markCooked(x.id, { date: '2026-10-06' });
    await sync();
    Object.assign(out, await both(id), { versions: await versions(id) });
  },
  // Rating, favorite and visibility set on the web, two cooks logged there;
  // a cook logged on the phone later doesn't undo any of it.
  async cookAfterWeb() {
    const id = await newRecipe(); await sync();
    await webSave(id, { rating: 5, favorite: true, visibility: 'group' });
    await web('POST', `/api/recipes/${id}/cooked`, { date: '2026-10-04' });
    await web('POST', `/api/recipes/${id}/cooked`, { date: '2026-10-05' });
    await sleep(1100);
    const x = await localRecipe(id); await api.markCooked(x.id, { date: '2026-10-06' });
    await sync();
    Object.assign(out, await both(id), { versions: await versions(id) });
  },
  // The phone edits offline; the web deletes the recipe later.
  async webDeletesLater() {
    const id = await newRecipe(); await sync();
    await phoneEdit(id, 'phone'); await sleep(3100);
    await web('DELETE', `/api/recipes/${id}`);
    await sync();
    Object.assign(out, await both(id), { id });
  },
  // The web deletes the recipe; the phone edits it later, offline.
  async phoneEditsAfterDelete() {
    const id = await newRecipe(); await sync();
    await web('DELETE', `/api/recipes/${id}`); await sleep(3100);
    await phoneEdit(id, 'phone');
    await sync();
    Object.assign(out, await both(id));
  },
  // A category changed twice on the phone, the second time before the
  // first push comes back in a pull (with whatever clock and delay).
  async echoCategory() {
    const id = await newRecipe();
    const cats = {};
    for (const n of ['Alpha', 'Beta']) cats[n] = (await web('POST', '/api/recipes/categories', { name: n })).id;
    await sync();
    const localCat = async n => (await db.query(`SELECT id FROM recipe_categories WHERE server_id = ?`, [cats[n]])).values[0].id;
    const setCat = async n => { const x = await localRecipe(id); await api.updateRecipe(x.id, { ...x, category_id: await localCat(n) }); };
    await setCat('Alpha'); await sync();
    await sleep(1100); await setCat('Beta');
    await sync(); await sync();
    const s = await web('GET', `/api/recipes/${id}`);
    const p = await local(id);
    out.server = s.category?.name ?? null;
    out.phone = (await db.query(`SELECT name FROM recipe_categories WHERE id = ?`, [p.category_id])).values[0]?.name ?? null;
  },
  // An item checked off on the phone while the web renamed it: both stay.
  async shoppingFields() {
    const it = await web('POST', '/api/shopping', { name: 'Milk' }); await sync();
    const localItem = async () => (await db.query(`SELECT * FROM shopping_list WHERE server_id = ?`, [it.id])).values[0];
    await api.toggleShoppingChecked((await localItem()).id, true);
    await sleep(1100);
    const cur = await web('GET', '/api/shopping').then(l => (Array.isArray(l) ? l : l.items || []).find(x => x.id === it.id));
    await web('PUT', `/api/shopping/${it.id}`, { ...cur, name: 'Oat Milk' });
    await sync();
    const s = await web('GET', '/api/shopping').then(l => (Array.isArray(l) ? l : l.items || []).find(x => x.id === it.id));
    const p = await localItem();
    out.server = { name: s.name, checked: !!s.checked };
    out.phone = { name: p.name, checked: !!p.checked };
  },
  // The phone's clock is 10 minutes slow when it edits, offline, a recipe
  // the web edited a few seconds before; it is set right before the sync.
  // Its edit is the newer one.
  async clockFixedBeforePush() {
    const id = await newRecipe(); await sync();
    const x0 = await localRecipe(id); await api.updateRecipe(x0.id, { ...x0, rating: 1 }); await sync(); // the server says the offset
    await webEdit(id, 'web'); await sleep(3100);
    await phoneEdit(id, 'phone');
    (await import('./clock.mjs')).setSkew(0);
    await sync();
    Object.assign(out, await both(id), { versions: await versions(id) });
  },
  // The server keeps its own copy, and the pull that would bring it down
  // fails: the phone mustn't take that copy as its own until it has it.
  async repullFails() {
    const id = await newRecipe(); await sync();
    const before = (await local(id)).server_synced_at;
    await phoneEdit(id, 'phone'); await sleep(3100); await webEdit(id, 'web');
    let pulls = 0;
    failNext = url => url.includes('/api/sync/pull') && ++pulls === 2;
    const failed = await fullSync({ silent: true }, true);
    out.firstSync = failed.ok ? 'ok' : 'failed';
    const mid = await local(id);
    out.stampKept = mid.server_synced_at === before;
    out.phoneAfterFail = mid.name;
    await sync();
    const end = await local(id);
    out.phoneAfter = end.name;
    out.stampMoved = end.server_synced_at !== before;
    out.server = (await web('GET', `/api/recipes/${id}`)).name;
  },

  // ── Accounts on one phone (lib/local-account.js) ──────────────────────
  // Alice (CT_TOKEN) leaves a change that never went up; Bob (CT_TOKEN_B)
  // signs in on the same phone.
  async accountSwitch() {
    const la = await import('../../src/lib/local-account.js');
    const B_TOKEN = process.env.CT_TOKEN_B;
    const A = await me(token), B = await me(B_TOKEN);
    await web('POST', '/api/recipes', { name: 'Bob Web Soup', ingredients: [], steps: [] }, B_TOKEN);
    await la.prepareLocalAccount(A, { confirm: async () => true });
    await sync();
    await api.createRecipe({ name: 'Alice Waiting', ingredients: [], steps: [] });
    // Bob signs in. Before the app has checked, a sync is refused.
    signIn(B_TOKEN);
    out.early = (await fullSync({ silent: true }, true)).reason;
    // He says no: nothing changes, and Alice's change goes up as hers.
    let asked = null;
    out.no = await la.prepareLocalAccount(B, { confirm: async n => { asked = n; return false; } });
    out.asked = asked;
    signIn(token);
    await la.prepareLocalAccount(A, { confirm: async () => { throw new Error('asked Alice'); } });
    await sync();
    // Alice leaves another; Bob says yes this time.
    await api.createRecipe({ name: 'Alice Discarded', ingredients: [], steps: [] });
    signIn(B_TOKEN);
    out.yes = await la.prepareLocalAccount(B, { confirm: async () => true });
    out.leftAfterClear = await rowsHere();
    await sync();
    out.bobPhone = (await api.getRecipes()).map(r => r.name).sort();
    out.bobTokenSentAliceRows = sent.filter(x => x.token === B_TOKEN && x.url.startsWith('/api/sync/push')).length;
    // Bob signs out with a change waiting and back in: nothing asked or lost.
    await api.createRecipe({ name: 'Bob Waiting', ingredients: [], steps: [] });
    signIn(null); signIn(B_TOKEN);
    let askedBob = false;
    out.same = await la.prepareLocalAccount(B, { confirm: async () => { askedBob = true; return true; } });
    out.askedBob = askedBob;
    await sync();
  },

  // A sync is running for Alice (its download held up) when Bob signs in
  // and says yes: the copy changes hands only once the sync has stopped,
  // and nothing of Alice's lands after the clear.
  async switchDuringSync() {
    const la = await import('../../src/lib/local-account.js');
    const B_TOKEN = process.env.CT_TOKEN_B;
    const A = await me(token), B = await me(B_TOKEN);
    await la.prepareLocalAccount(A, { confirm: async () => true });
    await sync();
    await web('POST', '/api/recipes', { name: 'Alice Late Soup', ingredients: [], steps: [] });
    holdFor = url => (url.includes('/api/sync/pull') ? 2500 : 0);
    const running = fullSync({ silent: true }, true);
    await sleep(300);
    signIn(B_TOKEN);
    out.yes = await la.prepareLocalAccount(B, { confirm: async () => true });
    out.run = (await running).reason || 'ok';
    holdFor = () => 0;
    await sleep(3000);
    out.leftAfterClear = await rowsHere();
    await sync();
    out.bobPhone = (await api.getRecipes()).map(r => r.name);
  },

  // Signing out pushes what's waiting with the session signing out, for a
  // few seconds at most; a push held longer is cut off, and nothing goes
  // up afterwards under the next account's session.
  async signOutMidPush() {
    const la = await import('../../src/lib/local-account.js');
    const { pushBeforeSignOut } = await import('../../src/lib/sync.js');
    const B_TOKEN = process.env.CT_TOKEN_B;
    const A = await me(token);
    await la.prepareLocalAccount(A, { confirm: async () => true });
    await sync();
    await api.createRecipe({ name: 'Alice Slow', ingredients: [], steps: [] });
    holdFor = url => (url.includes('/api/sync/push') ? 6000 : 0);
    const t0 = Date.now();
    await pushBeforeSignOut();
    out.took = Date.now() - t0;
    la.bumpAccountGeneration();
    signIn(B_TOKEN);
    // Bob's app starts syncing before the account check has run: refused.
    out.bobSync = (await fullSync({ silent: true }, true)).reason;
    await sleep(7000);
    holdFor = () => 0;
    out.aliceSoupOnServer = (await web('GET', '/api/recipes')).filter(r => r.name === 'Alice Slow').length;
    out.pushes = sent.filter(x => x.url.startsWith('/api/sync/push')).map(x => (x.token === token ? 'alice' : x.token === B_TOKEN ? 'bob' : 'other') + (x.aborted ? ' (cut off)' : ''));
  },

  // Every trigger at once (app start, coming back, the timer, Sync Now):
  // one sync runs, the new recipe is made once, and an edit made while it
  // runs goes up right after it.
  async syncTriggersAtOnce() {
    await sync();
    await api.createRecipe({ name: 'Kill Test Recipe', ingredients: [], steps: [] });
    holdFor = url => (url.includes('/api/sync/push') ? 800 : 0);
    const runs = [fullSync(true), fullSync(true), fullSync({ silent: true }, true), fullSync(false, true, true)];
    await sleep(200);
    const x = (await api.getRecipes()).find(r => r.name === 'Kill Test Recipe');
    await api.updateRecipe(x.id, { ...(await api.getRecipe(x.id)), notes: 'edited while syncing' });
    await Promise.all(runs);
    holdFor = () => 0;
    await sleep(2500);
    out.pushes = sent.filter(x => x.url.startsWith('/api/sync/push')).length;
    out.overlapping = sent.filter(x => x.url.startsWith('/api/sync/pu')).some((x, i, a) => i > 0 && x.at - a[i - 1].at < 50 && x.url === a[i - 1].url);
    out.server = (await web('GET', '/api/recipes')).filter(r => r.name === 'Kill Test Recipe').map(r => r.notes);
    out.phone = (await api.getRecipes()).filter(r => r.name === 'Kill Test Recipe').length;
  },

  // The answer to a push is lost after the server made the new recipe:
  // the next sync sends it again, and it is still one recipe.
  async lostAnswer() {
    await sync();
    await api.createRecipe({ name: 'Lost Answer Soup', ingredients: [], steps: [] });
    dropAnswer = url => url.includes('/api/sync/push');
    out.first = (await fullSync({ silent: true }, true)).ok;
    await sync();
    out.server = (await web('GET', '/api/recipes')).filter(r => r.name === 'Lost Answer Soup').length;
    out.phone = (await db.query(`SELECT server_id FROM recipes WHERE name = 'Lost Answer Soup'`)).values.map(r => !!r.server_id);
  },

  // The phone can't read whose data it holds: it shows none of it, says
  // so, and Retry works once it can.
  async gateError() {
    const la = await import('../../src/lib/local-account.js');
    const { get } = await import('svelte/store');
    const A = await me(token);
    await db.execute('ALTER TABLE sync_meta RENAME TO sync_meta_away');
    out.first = await la.ensureLocalAccount(A, { confirm: async () => true });
    const g = get(la.accountGate);
    out.state = g.state;
    out.shown = la.accountReadyFor(g, A.id);
    await db.execute('ALTER TABLE sync_meta_away RENAME TO sync_meta');
    out.second = await la.ensureLocalAccount(A, { confirm: async () => true });
    out.shownAfter = la.accountReadyFor(get(la.accountGate), A.id);
    // Asked twice at once for the same account: one check, one answer.
    la.resetAccountGate();
    const both = await Promise.all([la.ensureLocalAccount(A), la.ensureLocalAccount(A)]);
    out.together = both;
  },

  // Disconnect, use the phone on its own, then connect as Bob and choose
  // Upload: no question at sign-in, every row on Bob's account once.
  async disconnectUpload() {
    const la = await import('../../src/lib/local-account.js');
    const B_TOKEN = process.env.CT_TOKEN_B;
    const A = await me(token), B = await me(B_TOKEN);
    await la.prepareLocalAccount(A, { confirm: async () => true });
    await newRecipe({ name: 'Alice Synced' });
    await sync();
    // Settings > Disconnect.
    await la.setLocalOwner();
    const url = server;
    process.env.CT_SERVER = ''; signIn(null);
    await api.createRecipe({ name: 'Made Alone', ingredients: [], steps: [] });
    // Made a while before it goes up, as a recipe made on the phone is: the
    // server's own time for the row differs from the phone's.
    await db.run(`UPDATE recipes SET created_at = datetime('now', '-1 hour') WHERE name = 'Made Alone'`);
    const madeAt = (await db.query(`SELECT created_at FROM recipes WHERE name = 'Made Alone'`)).values[0].created_at;
    // Settings > Connect as Bob > Upload, as SettingsServerConnection does:
    // signed in, the upload sent to the address given, and the app switched
    // to that server only once the copy is claimed.
    signIn(B_TOKEN);
    const { uploadLocalToServer } = await import('../../src/lib/migrate.js');
    const summary = await uploadLocalToServer({ serverUrl: url, authToken: B_TOKEN });
    out.errors = summary.errors;
    await la.claimForServer(url, B.id, { uploaded: summary.uploaded, created: B.created_at });
    process.env.CT_SERVER = url;
    let asked = null;
    out.ok = await la.prepareLocalAccount(B, { confirm: async n => { asked = n; return false; } });
    out.asked = asked;
    await sync(); await sync();
    out.madeAtKept = (await db.query(`SELECT created_at FROM recipes WHERE name = 'Made Alone'`)).values[0].created_at === madeAt;
    // The same upload again (an answer lost): still once.
    await uploadLocalToServer({ serverUrl: url, authToken: B_TOKEN }).catch(() => {});
    const bob = (await web('GET', '/api/recipes', null, B_TOKEN)).map(r => r.name).sort();
    out.bobServer = bob;
    out.bobPhone = (await api.getRecipes()).map(r => r.name).sort();
    // Categories: the account's own, matched, never a second copy of each.
    const serverCats = (await web('GET', '/api/recipes/categories', null, B_TOKEN)).map(c => c.slug).sort();
    out.serverCatDupes = serverCats.filter(x => /-\d+$/.test(x));
    out.phoneCats = (await db.query(`SELECT slug FROM recipe_categories ORDER BY slug`)).values.map(r => r.slug);
    out.serverCats = serverCats;
  },

  // The same server at another address (its LAN IP and its name): the
  // same account, nothing cleared. An address whose server can't be told
  // apart: asked, and nothing goes up unless the answer is the same server.
  async otherAddress() {
    const la = await import('../../src/lib/local-account.js');
    const A = await me(token);
    await la.prepareLocalAccount(A, { confirm: async () => true });
    await newRecipe({ name: 'Kept Soup' });
    await sync();
    const url = server;
    process.env.CT_SERVER = url.replace('127.0.0.1', 'localhost');
    let asked = false;
    out.sameServer = await la.prepareLocalAccount(A, { confirm: async () => { asked = true; return true; }, sameServer: async () => { asked = true; return false; } });
    out.askedSame = asked;
    out.keptSame = (await api.getRecipes()).map(r => r.name);
    // Now an address whose server never named itself: the tag has no id.
    const owner = JSON.parse((await db.query(`SELECT value FROM sync_meta WHERE key = 'account'`)).values[0].value);
    await db.run(`UPDATE sync_meta SET value = ? WHERE key = 'account'`, [JSON.stringify({ s: 'http://old-name.example', u: owner.u, c: owner.c })]);
    let question = 0;
    out.saidYes = await la.prepareLocalAccount(A, { confirm: async () => true, sameServer: async () => { question++; return true; } });
    out.keptYes = (await api.getRecipes()).length;
    await db.run(`UPDATE sync_meta SET value = ? WHERE key = 'account'`, [JSON.stringify({ s: 'http://old-name.example', u: owner.u, c: owner.c })]);
    out.saidNo = await la.prepareLocalAccount(A, { confirm: async () => true, sameServer: async () => { question++; return false; } });
    out.keptNo = (await api.getRecipes()).length;
    out.questions = question;
    process.env.CT_SERVER = url;
  },

  // The first sync after signing in tells the pages it brought recipes
  // down, so the list shows them at once; a sync with nothing new doesn't.
  async firstSyncTellsPages() {
    const la = await import('../../src/lib/local-account.js');
    const A = await me(token);
    await newRecipe({ name: 'Waiting On The Server' });
    await la.prepareLocalAccount(A, { confirm: async () => true });
    await sync();
    await sync();
    out.told = events.filter(e => e.type === 'ct:sync-complete').map(e => ({ ok: e.detail?.ok, changed: e.detail?.changed }));
  },

  // The phone's cookie jar still holds Alice's sign-in when Bob signs in:
  // the server answers Bob's requests as Bob, and the jar is emptied when
  // the phone changes hands.
  async cookieJar() {
    const la = await import('../../src/lib/local-account.js');
    const { CapacitorHttp } = await import('@capacitor/core');
    const B_TOKEN = process.env.CT_TOKEN_B;
    const A = await me(token), B = await me(B_TOKEN);
    const { CapacitorCookies } = await import('@capacitor/core');
    await CapacitorHttp.post({ url: `${server}/api/auth/login`, headers: { 'Content-Type': 'application/json' }, data: { username: 'cook', password: 'Str0ng-Pass-88!y' } });
    // A sign-in gate's cookies, in front of the server and on its own host.
    await CapacitorCookies.setCookie({ url: server, key: 'authelia_session', value: 'gate' });
    await CapacitorCookies.setCookie({ url: 'https://gate.example.com', key: 'CF_Authorization', value: 'gate' });
    out.jarAfterLogin = await CapacitorCookies._all();
    await la.prepareLocalAccount(A, { confirm: async () => true });
    await sync();
    signIn(B_TOKEN);
    out.serverSays = (await (await fetch(`${server}/api/auth/me`, { headers: { Authorization: `Bearer ${B_TOKEN}` } })).json()).user?.username;
    out.yes = await la.prepareLocalAccount(B, { confirm: async () => true });
    out.jarAfterSwitch = await CapacitorCookies._all();
    out.host = new URL(server).host;
    await web('POST', '/api/recipes', { name: 'Bob Only', ingredients: [], steps: [] }, B_TOKEN);
    await sync();
    out.bobPhone = (await api.getRecipes()).map(r => r.name);
  },

  // An account cached by an earlier sign-in (before a Disconnect and a
  // connect as someone else) is never taken for the one signed in now.
  async cachedAccount() {
    const A = await me(token), B_TOKEN = process.env.CT_TOKEN_B;
    localStorage.setItem('ct:serverUrl', server);
    localStorage.setItem('ct:cachedUser', JSON.stringify(A));
    signIn(B_TOKEN);
    const { currentUser, loadAuthState } = await import('../../src/stores/auth.js');
    const { get } = await import('svelte/store');
    await loadAuthState();
    out.atOnce = get(currentUser)?.username ?? null;
    await sleep(1500);
    out.afterServer = get(currentUser)?.username ?? null;
  },

  // Settings are kept per account and server: another account never reads
  // the last one's.
  async settingsPerAccount() {
    const { DB } = await import('../../src/lib/db.js');
    const A = await me(token), B = await me(process.env.CT_TOKEN_B);
    localStorage.setItem('ct:serverUrl', server);
    localStorage.setItem('wl:userId', String(A.id));
    DB.setSetting('aiApiKey', 'alice-key');
    localStorage.setItem('wl:userId', String(B.id));
    out.bobReads = DB.getSetting('aiApiKey', null);
    localStorage.setItem('wl:userId', String(A.id));
    out.aliceReads = DB.getSetting('aiApiKey', null);
    out.keys = [...store.keys()].filter(k => k.includes('aiApiKey'));
  },

  // One phone (PHONE_DB, PHONE_MARKER), across runs: makes the recipe in
  // RECIPE_NAME and syncs it. Run on a copy of another phone's database
  // (a backup put back on a second phone), it must not send that phone's
  // keys.
  async cloneMake() {
    // Made before this run's first sync, as on a phone that was offline.
    const made = await api.createRecipe({ name: process.env.RECIPE_NAME, ingredients: [], steps: [] });
    const { dbInstallId } = await import('../../src/lib/db-native.js');
    out.install = await dbInstallId();
    out.localId = made?.id ?? (await db.query(`SELECT id FROM recipes WHERE name = ?`, [process.env.RECIPE_NAME])).values[0]?.id;
    await sync();
    out.serverId = (await db.query(`SELECT server_id FROM recipes WHERE id = ?`, [out.localId])).values[0]?.server_id ?? null;
  },

  // Upload with links: a variant under its item, the item's nutrition
  // source, a shopping item and an ingredient linked to the variant. The
  // server gets its own ids for every link, and the phone keeps the same
  // links after the first pull.
  async uploadLinks() {
    const la = await import('../../src/lib/local-account.js');
    const B_TOKEN = process.env.CT_TOKEN_B;
    const B = await me(B_TOKEN);
    // Bob's server already has items, so ids on the phone and there differ.
    for (const n of ['Bob Salt', 'Bob Pepper', 'Bob Oil']) await web('POST', '/api/pantry', { name: n }, B_TOKEN);
    const url = server;
    process.env.CT_SERVER = ''; signIn(null);
    await la.setLocalOwner();
    const milk = await api.createPantryItem({ name: 'Milk' });
    const oat = await api.createPantryItem({ name: 'Oat Milk', generic_parent_id: milk.id });
    await api.updatePantryItem(milk.id, { nutrition_source_variant_id: oat.id });
    await api.addShoppingItem({ name: 'Oat Milk', pantry_id: oat.id });
    await api.createRecipe({ name: 'Porridge', ingredients: [{ items: [{ name: 'oat milk', pantry_item_id: oat.id }] }], steps: ['Stir'] });
    signIn(B_TOKEN);
    const { uploadLocalToServer } = await import('../../src/lib/migrate.js');
    const summary = await uploadLocalToServer({ serverUrl: url, authToken: B_TOKEN });
    out.errors = summary.errors;
    await la.claimForServer(url, B.id, { uploaded: summary.uploaded, created: B.created_at });
    process.env.CT_SERVER = url;
    await la.prepareLocalAccount(B, { confirm: async () => true });
    await sync(); await sync();
    const sp = await web('GET', '/api/pantry', null, B_TOKEN);
    const sId = n => sp.find(p => p.name === n)?.id;
    const sRow = n => sp.find(p => p.name === n);
    const sShop = (await web('GET', '/api/shopping', null, B_TOKEN));
    const shopRow = (Array.isArray(sShop) ? sShop : sShop.items).find(x => x.name === 'Oat Milk');
    const sRecipe = (await web('GET', '/api/recipes', null, B_TOKEN)).find(r => r.name === 'Porridge');
    const full = await web('GET', `/api/recipes/${sRecipe.id}`, null, B_TOKEN);
    out.server = {
      variantParentIsMilk: sRow('Oat Milk')?.generic_parent_id === sId('Milk'),
      sourceIsOat: sRow('Milk')?.nutrition_source_variant_id === sId('Oat Milk'),
      shoppingIsOat: shopRow?.pantry_id === sId('Oat Milk'),
      ingredientIsOat: full.ingredients?.[0]?.items?.[0]?.pantry_item_id === sId('Oat Milk'),
    };
    const lp = (await db.query(`SELECT id, name, generic_parent_id, nutrition_source_variant_id FROM pantry_items WHERE deleted_at IS NULL`)).values;
    const lId = n => lp.find(p => p.name === n)?.id;
    const lShop = (await db.query(`SELECT pantry_id FROM shopping_list WHERE name = 'Oat Milk' AND deleted_at IS NULL`)).values;
    out.phone = {
      variantParentIsMilk: lp.find(p => p.name === 'Oat Milk')?.generic_parent_id === lId('Milk'),
      sourceIsOat: lp.find(p => p.name === 'Milk')?.nutrition_source_variant_id === lId('Oat Milk'),
      shoppingIsOat: lShop.length === 1 && lShop[0].pantry_id === lId('Oat Milk'),
      counts: { milk: lp.filter(p => p.name === 'Milk').length, oat: lp.filter(p => p.name === 'Oat Milk').length },
    };
  },

  // A setting changed here that never went up counts as a change waiting:
  // another account signing in is asked before it's dropped.
  async settingWaits() {
    const la = await import('../../src/lib/local-account.js');
    const A = await me(token), B = await me(process.env.CT_TOKEN_B);
    await la.prepareLocalAccount(A, { confirm: async () => true });
    await sync();
    await dbn.dbUpsertSetting('measurementSystem', 'metric');
    signIn(process.env.CT_TOKEN_B);
    // Bob's own settings, written as his app starts, before the check.
    const { mirrorSetting } = await import('../../src/stores/settings.js');
    await mirrorSetting('timezone', 'Europe/Oslo');
    let asked = null;
    out.ok = await la.prepareLocalAccount(B, { confirm: async n => { asked = n; return false; } });
    out.asked = asked;
    // Nothing of Alice's waiting: Bob's own start-up settings ask nothing.
    signIn(token);
    await la.prepareLocalAccount(A, { confirm: async () => true });
    await sync();
    signIn(process.env.CT_TOKEN_B);
    await mirrorSetting('timezone', 'Europe/Oslo');
    // Signed out, the app starting on the sign-in screen sets a default.
    signIn(null);
    await mirrorSetting('timezone', 'America/New_York');
    signIn(process.env.CT_TOKEN_B);
    let askedAgain = null;
    out.ownOk = await la.prepareLocalAccount(B, { confirm: async n => { askedAgain = n; return false; } });
    out.askedAgain = askedAgain;
  },

  // A category with an edit waiting here, whose name another device moved
  // to another category: the pull still goes through, the edit still goes
  // up, and both categories are on the phone.
  async categoryNameMoved() {
    const cat = await web('POST', '/api/recipes/categories', { name: 'Soups' });
    await sync();
    const local = (await db.query(`SELECT * FROM recipe_categories WHERE server_id = ?`, [cat.id])).values[0];
    await api.updateRecipeCategory(local.id, { name: local.name, color: '#ff0000' });
    // Another device renames it (and its slug) and makes a new "Soups".
    await sleep(1100);
    const copy = (await web('GET', '/api/sync/pull?since=1970-01-01&synced_at=1')).tables.recipe_categories.find(c => c.id === cat.id);
    const row = { ...copy, client_id: 999, server_id: cat.id, server_synced_at: copy.synced_at, name: 'Stews', slug: 'stews', updated_at: new Date(Date.now() - skew).toISOString().replace('T', ' ').slice(0, 19), edit_clock: 'server', changed: ['name', 'slug'] };
    delete row.id; delete row.synced_at;
    const now = new Date(Date.now() - skew).toISOString();
    await web('POST', '/api/sync/push', { fk_ids: 'server', client_now: now, tables: { recipe_categories: [row] } });
    await web('POST', '/api/recipes/categories', { name: 'Soups' });
    const r1 = await fullSync({ silent: true }, true);
    const r2 = await fullSync({ silent: true }, true);
    out.syncs = [r1.ok ? 'ok' : r1.error, r2.ok ? 'ok' : r2.error];
    const server = await web('GET', '/api/recipes/categories');
    out.server = server.filter(c => ['soups', 'stews'].includes(c.slug)).map(c => ({ slug: c.slug, color: c.color })).sort((a, b) => a.slug.localeCompare(b.slug));
    out.phone = (await db.query(`SELECT slug, color, sync_status FROM recipe_categories WHERE slug IN ('soups', 'stews') ORDER BY slug`)).values;
  },

  // A switch while the sync is downloading pictures: the switch doesn't
  // wait for them.
  async switchDuringImages() {
    const la = await import('../../src/lib/local-account.js');
    const A = await me(token), B = await me(process.env.CT_TOKEN_B);
    await la.prepareLocalAccount(A, { confirm: async () => true });
    await sync();
    holdFor = (url, init) => (/\/api\/recipes$/.test(url) && (init?.method || 'GET') === 'GET' ? 8000 : 0);
    const running = fullSync({ silent: true }, true);
    await sleep(1500);
    signIn(process.env.CT_TOKEN_B);
    const t0 = Date.now();
    out.yes = await la.prepareLocalAccount(B, { confirm: async () => true });
    out.switchMs = Date.now() - t0;
    out.run = (await running).reason || 'ok';
    out.sent = sent.map(x => (x.at - t0) + ' ' + x.url.slice(0, 30) + (x.aborted ? ' (aborted)' : '') + (x.held ? ' held' : ''));
    holdFor = () => 0;
  },

  // The pictures of the account's recipes are found for keeping offline.
  async imagesFound() {
    await web('POST', '/api/recipes', { name: 'Pictured', img_url: '/uploads/pictured.jpg', ingredients: [], steps: [] });
    await sync();
    const { cacheAllImages } = await import('../../src/lib/image-cache.js');
    out.total = (await cacheAllImages()).total;
  },

  // Started offline with a cached account the session isn't for: the
  // sign-in screen, never the copy with nobody signed in.
  async cachedAccountOffline() {
    const A = await me(token), B_TOKEN = process.env.CT_TOKEN_B;
    process.env.CT_SERVER = 'http://127.0.0.1:9';
    localStorage.setItem('ct:serverUrl', process.env.CT_SERVER);
    localStorage.setItem('ct:cachedUser', JSON.stringify(A));
    localStorage.setItem('ct:cachedUserMgmt', '1');
    signIn(B_TOKEN);
    const { currentUser, userMgmtActive, loadAuthState } = await import('../../src/stores/auth.js');
    const { get } = await import('svelte/store');
    await loadAuthState();
    await sleep(500);
    out.user = get(currentUser)?.username ?? null;
    out.userMgmt = get(userMgmtActive);
    process.env.CT_SERVER = server;
  },

  // An ingredient linked to a pantry item, on the phone in server mode,
  // where the item's id here differs from its id on the server: the link is
  // the right one on both sides, made new, edited offline, and from the web.
  async ingredientLinks() {
    for (const n of ['Salt', 'Pepper', 'Oil', 'Vinegar']) await web('POST', '/api/pantry', { name: n });
    // The phone makes its own items first, so its ids run ahead of the server's.
    await api.createPantryItem({ name: 'Flour' });
    await api.createPantryItem({ name: 'Sugar' });
    await sync();
    const here = async n => (await db.query(`SELECT id, server_id FROM pantry_items WHERE name = ?`, [n])).values[0];
    const flour = await here('Flour'), sugar = await here('Sugar'), oil = await here('Oil');
    out.idsDiffer = flour.id !== flour.server_id && sugar.id !== sugar.server_id;
    // A new item and a recipe that links it, both made before a sync.
    const butter = await api.createPantryItem({ name: 'Butter' });
    const r = await api.createRecipe({ name: 'Cake', ingredients: [{ items: [{ name: 'flour', pantry_item_id: flour.id }, { name: 'butter', pantry_item_id: butter.id }] }], steps: ['Bake'] });
    await sync();
    const linkOnServer = async (rid, i) => (await web('GET', `/api/recipes/${rid}`)).ingredients[0].items[i]?.pantry_item_id ?? null;
    const sid = (await db.query(`SELECT server_id FROM recipes WHERE id = ?`, [r.id])).values[0].server_id;
    const butterHere = await here('Butter');
    out.made = { server: [await linkOnServer(sid, 0), await linkOnServer(sid, 1)], want: [flour.server_id, butterHere.server_id] };
    // Edited offline: the butter link swapped for sugar.
    const x = await api.getRecipe(r.id);
    const g = x.ingredients;
    g[0].items[1] = { name: 'sugar', pantry_item_id: sugar.id };
    await api.updateRecipe(r.id, { ...x, ingredients: g });
    await sync();
    out.edited = { server: await linkOnServer(sid, 1), want: sugar.server_id };
    const phoneLinks = async rid => JSON.parse((await db.query(`SELECT ingredients FROM recipes WHERE id = ?`, [rid])).values[0].ingredients)[0].items.map(i => i.pantry_item_id ?? null);
    out.phoneAfter = { got: await phoneLinks(r.id), want: [flour.id, sugar.id] };
    // A recipe made on the web, linked to an item by its server id.
    const w = await web('POST', '/api/recipes', { name: 'Dressing', ingredients: [{ items: [{ name: 'oil', pantry_item_id: oil.server_id }] }], steps: ['Shake'] });
    await sync();
    const wl = (await db.query(`SELECT id FROM recipes WHERE server_id = ?`, [w.id])).values[0].id;
    out.fromWeb = { got: await phoneLinks(wl), want: [oil.id] };
  },
  // A week's plan onto the list, on the phone and on the web: the amounts
  // scale to the planned servings and add up, the list rows keep their
  // recipes and cooks as each side's ids, building again replaces a
  // cook's share, and a cancelled cook takes its share out.
  async planList() {
    const day1 = '2030-01-07', day2 = '2030-01-08';
    const shak = await api.createRecipe({
      name: 'Shakshuka', servings: 2, steps: [{ text: 'Cook' }],
      ingredients: [{ items: [{ id: 'a', name: 'Tomatoes', qty: '3' }, { id: 'b', name: 'olive oil', qty: '1/2', unit: 'tbsp' }] }],
    });
    const cook1 = await api.createDiaryEntry({ recipe_id: shak.id, date: day1, kind: 'planned', servings: 4 });
    out.phoneBuild = await api.shopFromPlan({ from: day1, to: day2 });
    await sync();
    const list = async () => (await web('GET', '/api/shopping')).filter(x => !x.checked);
    const row = (l, n) => l.find(x => x.name.toLowerCase().startsWith(n));
    const shakServer = (await db.query(`SELECT server_id FROM recipes WHERE id = ?`, [shak.id])).values[0].server_id;
    const cook1Server = (await db.query(`SELECT server_id FROM cook_diary WHERE id = ?`, [cook1.id ?? cook1])).values[0].server_id;
    const s1 = row(await list(), 'tomato');
    out.afterPhone = {
      qty: s1.quantity, oil: row(await list(), 'olive').quantity,
      ids: s1.sources.map(x => [x.recipe_id, x.diary_id]), want: [[shakServer, cook1Server]],
    };
    // The web plans tacos on day 2 and builds the same week again.
    const tacos = await web('POST', '/api/recipes', { name: 'Tacos', servings: 4, steps: ['Fold'], ingredients: [{ items: [{ name: 'tomato', qty: '2' }] }] });
    const cook2 = await web('POST', '/api/cook-diary', { recipe_id: tacos.id, date: day2, kind: 'planned', servings: 4 });
    out.webBuild = await web('POST', `/api/shopping/from-plan?from=${day1}&to=${day2}`, {});
    const l2 = await list();
    out.afterWeb = { rows: l2.filter(x => x.name.toLowerCase().startsWith('tomato')).length, qty: row(l2, 'tomato').quantity };
    await sync();
    const local = (await db.query(`SELECT * FROM shopping_list WHERE deleted_at IS NULL AND lower(name) LIKE 'tomato%'`)).values;
    const tacosLocal = (await db.query(`SELECT id FROM recipes WHERE server_id = ?`, [tacos.id])).values[0].id;
    const cook2Local = (await db.query(`SELECT id FROM cook_diary WHERE server_id = ?`, [cook2.id])).values[0].id;
    out.phoneAfterPull = {
      rows: local.length, qty: local[0].quantity,
      ids: JSON.parse(local[0].sources).map(x => [x.recipe_id, x.diary_id]).sort(),
      want: [[shak.id, cook1.id ?? cook1], [tacosLocal, cook2Local]].sort(),
    };
    // The phone cancels the Shakshuka cook and builds the week again.
    await api.deleteDiaryEntry(cook1.id ?? cook1);
    out.phoneRebuild = await api.shopFromPlan({ from: day1, to: day2 });
    await sync();
    const l3 = await list();
    out.afterCancel = { tomato: row(l3, 'tomato')?.quantity ?? null, oil: row(l3, 'olive')?.quantity ?? 'gone' };
  },
  // The recipe card's "you have N of M" on the phone, as the server counts
  // it: in stock, or a generic item with a variant in stock.
  async pantryMatch() {
    const flour = await api.createPantryItem({ name: 'Flour', in_stock: true });
    const sugar = await api.createPantryItem({ name: 'Sugar', in_stock: false });
    const milk = await api.createPantryItem({ name: 'Milk', in_stock: false });
    await api.createPantryItem({ name: 'Oat Milk', in_stock: true, generic_parent_id: milk.id });
    const r = await api.createRecipe({ name: 'Cake', steps: [{ text: 'Bake' }], ingredients: [{ items: [
      { name: 'flour', pantry_item_id: flour.id }, { name: 'sugar', pantry_item_id: sugar.id },
      { name: 'milk', pantry_item_id: milk.id }, { name: 'love' },
    ] }] });
    out.list = (await api.getRecipes()).find(x => x.id === r.id).pantry_match;
    const cb = await api.createCookbook({ name: 'Baking' });
    await api.addRecipesToCookbook(cb.id, [r.id]);
    out.cookbook = (await api.getCookbook(cb.id)).recipes.find(x => x.id === r.id).pantry_match;
  },
  // An import links each ingredient to the pantry: "tomato" to the
  // "Tomatoes" already there, and a new item (out of stock) for the rest,
  // on the phone as on the server.
  async importLinksPantry() {
    const toms = await api.createPantryItem({ name: 'Tomatoes', in_stock: true });
    const jsonld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Recipe', name: 'Salsa',
      recipeIngredient: ['2 tomato, diced', '1 small onion', '1 onions', '2 cloves garlic, minced'],
      recipeInstructions: [{ '@type': 'HowToStep', text: 'Chop.' }] });
    const r = await api.importRecipe({ text: jsonld });
    const pantry = await api.getPantry();
    const nameOf = id => pantry.find(p => p.id === id)?.name ?? null;
    const items = (await api.getRecipe(r.id)).ingredients[0].items;
    out.phone = {
      links: items.map(i => nameOf(i.pantry_item_id)),
      tomatoesLinked: items[0].pantry_item_id === toms.id,
      made: pantry.filter(p => p.id !== toms.id).map(p => [p.name, !!p.in_stock]).sort(),
    };
    // The web: an import with "tomato" and "Tomatoes" links both to one item.
    await sync();
    const w = await web('POST', '/api/recipes/import', { text: JSON.stringify({ '@context': 'https://schema.org', '@type': 'Recipe',
      name: 'Web Salsa', recipeIngredient: ['1 tomato', '2 Tomatoes'], recipeInstructions: [{ '@type': 'HowToStep', text: 'Chop.' }] }) });
    const webPantry = await web('GET', '/api/pantry');
    const list = Array.isArray(webPantry) ? webPantry : (webPantry.items || []);
    const ids = w.ingredients[0].items.map(i => i.pantry_item_id);
    out.web = { names: ids.map(id => list.find(p => p.id === id)?.name ?? null), same: ids[0] != null && ids[0] === ids[1] };
  },
  // A planned cook for "any day" of a week, and a note on a list item,
  // made on the phone and edited on the web, both ways.
  async laterFields() {
    const r = await api.createRecipe({ name: 'Curry', steps: [{ text: 'Cook' }], ingredients: [{ items: [{ name: 'rice' }] }] });
    const cook = await api.createDiaryEntry({ recipe_id: r.id, date: '2030-01-07', kind: 'planned', any_day: true, servings: 2 });
    const milk = await api.addShoppingItem({ name: 'Milk', notes: 'oat' });
    await sync();
    const sCook = (await db.query(`SELECT server_id FROM cook_diary WHERE id = ?`, [cook.id])).values[0].server_id;
    const sMilk = (await db.query(`SELECT server_id FROM shopping_list WHERE id = ?`, [milk.id])).values[0].server_id;
    const diary = await web('GET', '/api/cook-diary?from=2030-01-07&to=2030-01-07');
    const list = await web('GET', '/api/shopping');
    out.server = { anyDay: diary.find(x => x.id === sCook)?.any_day, notes: list.find(x => x.id === sMilk)?.notes };
    await web('PUT', `/api/shopping/${sMilk}`, { notes: 'whole' });
    await web('PUT', `/api/cook-diary/${sCook}`, { date: '2030-01-09', any_day: false });
    await sync();
    const here = async (t, id) => (await db.query(`SELECT * FROM ${t} WHERE id = ?`, [id])).values[0];
    out.phone = { notes: (await here('shopping_list', milk.id)).notes, anyDay: (await here('cook_diary', cook.id)).any_day, date: (await here('cook_diary', cook.id)).date };
    out.ids = { cook: sCook, milk: sMilk };
  },
};

const name = process.argv[2];
if (!scenarios[name]) throw new Error('no scenario ' + name);
await scenarios[name]();
process.stdout.write('\n@@' + JSON.stringify(out) + '\n');
process.exit(0);
