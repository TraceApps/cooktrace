import 'dotenv/config';
// Forward-proxy support (#177). Self-installs an undici
// EnvHttpProxyAgent as the global fetch dispatcher when
// HTTP_PROXY / HTTPS_PROXY / NO_PROXY (or lowercase equivalents)
// are set. No-op when unset. Must import right after dotenv/config
// so any downstream module-init outbound fetch already sees it.
import './lib/proxy-agent.js';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import proxyRoutes  from './routes/proxy.js';
import authRoutes   from './routes/auth.js';
import dataRoutes   from './routes/data.js';
import uploadRoutes from './routes/upload.js';
import settingsRoutes  from './routes/settings.js';
import appConfigRoutes  from './routes/app-config.js';
import aiRoutes         from './routes/ai.js';
import fullBackupRoutes from './routes/full-backup.js';
import syncRoutes       from './routes/sync.js';
import oidcRoutes       from './routes/oidc.js';
import oidcAdminRoutes  from './routes/oidc-admin.js';
import recipesRoutes    from './routes/recipes.js';
import pantryRoutes     from './routes/pantry.js';
import cookDiaryRoutes  from './routes/cook-diary.js';
import shoppingRoutes   from './routes/shopping.js';
import ntFederationRoutes from './routes/nt-federation.js';
import notifyRoutes       from './routes/notify.js';
import unitsRoutes        from './routes/units.js';
import cookbooksRoutes    from './routes/cookbooks.js';
import shareRoutes        from './routes/share.js';
import kitchensRoutes     from './routes/kitchens.js';
import updatesRoutes      from './routes/updates.js';
import { logger }   from './logger.js';
import { authenticate, userMgmtActive } from './middleware/auth.js';
import { csrfProtect } from './middleware/csrf.js';
import { seedSmtpFromEnv } from './email.js';
import { seedAiFromEnv } from './ai.js';
import { seedOidcFromEnv } from './lib/oidc-env.js';

// Initialise DB (runs schema)
import db from './db.js';

// Seed config from env vars if provided (env vars take priority over UI)
seedSmtpFromEnv();
seedAiFromEnv();
seedOidcFromEnv();

const app  = express();
const PORT = process.env.PORT || 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Reverse-proxy / subpath support ───────────────────────────────────────
// BASE_URL lets users mount CookTrace at a path other than root, e.g. for
// `https://example.com/cooktrace/` set BASE_URL=/cooktrace. Empty string
// (default) keeps current root-mounted behavior — no migration needed for
// existing installs.
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
if (BASE_URL && !BASE_URL.startsWith('/')) {
  console.error(`[server] BASE_URL must start with '/' — got: ${BASE_URL}`);
  process.exit(1);
}
// Everything route-related goes on this router; mounted at BASE_URL or '/'.
// Using a sub-router keeps `req.path` in middleware (e.g. csrf.js skip lists)
// relative to the mount point so existing path checks keep working.
const router = express.Router();

// Per-route JSON limits for endpoints that legitimately handle large payloads
// (full data export/import, full-history sync push). Registered BEFORE the
// global parser so they win — by the time the global parser runs, req.body
// is already populated and it short-circuits.
router.use('/api/data/import', express.json({ limit: '25mb' }));
router.use('/api/sync/push',   express.json({ limit: '25mb' }));
// Global cap: 1 MB. Prevents a single authed user from filling memory with
// repeated large requests. Anything above belongs on a per-route opt-in.
router.use(express.json({ limit: '1mb' }));
router.use(cookieParser());

// CORS — allow cross-origin requests from the Android app + same-origin.
// Capacitor WebView origins accepted:
//   https://localhost              — legacy default (kept for older APKs)
//   http://localhost               — legacy http scheme
//   https://app.cooktrace.local    — current app identity (see
//                                    capacitor.config.ts for why)
// Same-host origins (PWA served from this instance) always allowed.
router.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers.host;
    const isCapacitor = origin === 'https://localhost'
      || origin === 'http://localhost'
      || origin === 'https://app.cooktrace.local';
    const isSameHost = host && origin.includes(host);
    if (isCapacitor || isSameHost) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
  }
  next();
});

// Serve uploaded images BEFORE auth — images are public (needed for Android WebView
// which can't send Authorization headers on <img src> requests)
const uploadsPath = process.env.UPLOADS_PATH || './uploads';
router.use('/uploads', express.static(uploadsPath, {
  setHeaders(res) { res.set('Cache-Control', 'public, max-age=3600'); }
}));

// Proxy also before auth — used by Android WebView to load external images
// (DuckDuckGo, Walmart, etc. block direct WebView requests)
router.use('/api/proxy', proxyRoutes);

router.use(authenticate);   // attach req.user on every request
router.use(csrfProtect);   // CSRF protection for cookie-based sessions

// ── Request logging ────────────────────────────────────────────────────────
router.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms   = Date.now() - start;
    const lvl  = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[lvl](`${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// Prevent browser/proxy caching of all API responses
router.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Setup enforcement — block data APIs until the first user account is created.
// /api/auth/* is allowed so the client can register the admin. /api/r/*
// (public share-link reads) is also allowed so a recipient with a
// shared link doesn't 503 on a fresh install (the token still has to
// exist in the DB to return anything).
//
// In intentional single-user mode (admin explicitly disabled user management
// via DELETE /api/auth/management or POST /api/auth/recover), there are no
// users by design and data APIs should be open. The single_user_mode flag in
// app_config distinguishes this from a true fresh install. Mirrors the
// NutriTrace #34 part-2 fix.
router.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth')) return next();
  if (req.path.startsWith('/r/'))   return next();
  if (userMgmtActive()) return next();             // users exist — normal operation
  const singleUser = db.prepare(`SELECT value FROM app_config WHERE key = 'single_user_mode'`).get()?.value === '1';
  if (singleUser) return next();                   // intentional single-user mode — let data APIs through
  res.status(503).json({ error: 'Setup required', setup_required: true });
});

// API routes
// OIDC public routes mount BEFORE authRoutes so /api/auth/oidc/* never falls
// into authRoutes' 404 path. Both are exempt from the setup-required gate
// above (it allows anything under /auth) so OIDC can bootstrap a fresh
// install.
router.use('/api/auth/oidc', oidcRoutes);
router.use('/api/auth',   authRoutes);
// OIDC admin (provider CRUD) — gated by requireAuth + requireAdmin inside
// the router; setup-required gate blocks it until a user exists, which is
// the right ordering (no admin UI before the first user).
router.use('/api/admin/oidc', oidcAdminRoutes);
// proxy already registered before auth (line 64)
router.use('/api/data',         dataRoutes);
router.use('/api/upload',       uploadRoutes);
router.use('/api/settings',     settingsRoutes);
router.use('/api/app-config',   appConfigRoutes);
router.use('/api/ai',           aiRoutes);
router.use('/api/full-backup',  fullBackupRoutes);
router.use('/api/updates',      updatesRoutes);
router.use('/api/sync',         syncRoutes);
router.use('/api/recipes',      recipesRoutes);
router.use('/api/pantry',       pantryRoutes);
router.use('/api/cook-diary',   cookDiaryRoutes);
router.use('/api/shopping',     shoppingRoutes);
router.use('/api/nt',           ntFederationRoutes);
router.use('/api/notify',       notifyRoutes);
router.use('/api/units',        unitsRoutes);
router.use('/api/cookbooks',    cookbooksRoutes);
router.use('/api/kitchens',     kitchensRoutes);
router.use('/api/r',            shareRoutes);   // public share-link reads
router.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve Svelte frontend (production build) — anything except index.html.
// Content-hashed assets (in /assets/) are safe to cache forever — new deploy =
// new filename. The index.html itself goes through the SPA fallback below so
// it can be templated with __CT_CONFIG__.
router.use(express.static(path.join(__dirname, 'dist'), {
  index: false,                  // skip index.html — handled by templated fallback
  setHeaders(res, filePath) {
    if (filePath.includes('/assets/')) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.set('Cache-Control', 'no-cache');
    }
  }
}));

// Read the built index.html once at startup and inject __CT_CONFIG__ so the
// client knows its base path at runtime. Empty BASE_URL → empty basePath →
// behaviorally identical to a deploy without this feature.
const _indexHtmlPath = path.join(__dirname, 'dist', 'index.html');
let _indexHtmlTemplated = '';
try {
  const raw = fs.readFileSync(_indexHtmlPath, 'utf8');
  _indexHtmlTemplated = raw.replace(
    '</head>',
    `<script>window.__CT_CONFIG__ = { basePath: ${JSON.stringify(BASE_URL)} };</script></head>`
  );
} catch (e) {
  logger.warn(`[server] could not pre-template dist/index.html: ${e.message}`);
}

// SPA fallback — serves the templated index.html for any route under BASE_URL.
// Express 5 / path-to-regexp 8 requires named splat syntax for catch-alls;
// `/{*splat}` matches every path including the root, so the SPA HTML is
// served for any non-API GET that fell through.
router.get('/{*splat}', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  if (_indexHtmlTemplated) {
    res.set('Content-Type', 'text/html').send(_indexHtmlTemplated);
  } else {
    res.sendFile(_indexHtmlPath);
  }
});

// Mount the router at BASE_URL (or root if unset).
app.use(BASE_URL || '/', router);

// ── Global error handler ───────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  logger.error(`${req.method} ${req.path} — ${err.stack || err.message}`);
  if (!res.headersSent) {
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
});

// ── Process-level safety nets ─────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err.stack || err.message);
  process.exit(1);
});

app.listen(PORT, async () => {
  logger.info(`CookTrace running on port ${PORT}`);

  // One-time repair for instances that enabled user management on a build
  // where the handover was incomplete (TraceApps/docs#2). No-op once clean.
  try {
    const { repairOrphanedData } = await import('./lib/claim-anonymous-data.js');
    const r = repairOrphanedData();
    if (r.ambiguous) {
      logger.warn(`[claim] ${r.rows} row(s) from single-user mode are unowned, but this instance has more than one account so they cannot be attributed automatically. See https://traceapps.github.io/docs/auth/local-users/`);
    } else if (r.rows) {
      logger.info(`[claim] adopted ${r.rows} row(s) left over from single-user mode into user ${r.repaired}`);
    }
  } catch (e) {
    logger.warn(`[claim] orphan repair skipped: ${e.message}`);
  }

  // Start the notification + sync scheduler
  import('./lib/scheduler.js').then(({ startScheduler }) => startScheduler()).catch(e => {
    logger.warn(`[scheduler] failed to start: ${e.message}`);
  });

});
