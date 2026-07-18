import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, requireAdmin, userMgmtActive } from '../middleware/auth.js';
import { testSmtp, isSmtpEnvLocked } from '../email.js';
import { isAiEnvLocked } from '../ai.js';

const router = Router();

const ALLOWED_KEYS = new Set([
  'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from',
  'ai_enabled', 'ai_provider', 'ai_api_key', 'ai_model',
  'session_hours',
  'sharing_enabled', 'default_recipe_visibility',
  'password_policy',
]);

// ── GET /api/app-config/env-locks — which sections are locked by env vars ──
// Any authenticated user can read this (needed to disable UI fields)
router.get('/env-locks', requireAuth, wrap(async (req, res) => {
  // Lazy import — oidc-env is only meaningful when OIDC is configured.
  const { getEnvLockedProviderIds } = await import('../lib/oidc-env.js');
  // Surface ai_enabled when env-locked so the client can flip the toggle
  // ON visually. Mirrors NutriTrace #36.
  const aiLocked = isAiEnvLocked();
  let ai_enabled = false;
  if (aiLocked) {
    const row = db.prepare(`SELECT value FROM app_config WHERE key = 'ai_enabled'`).get();
    ai_enabled = row?.value === 'true';
  }
  // backup_locked: BACKUP_SCHEDULE / BACKUP_TIME / BACKUP_RETENTION env
  // var → Auto Backup UI inputs disable, PUT /api/full-backup/schedule
  // returns 409. Mirrors NT for TraceApps parity.
  const { isBackupEnvLocked } = await import('./full-backup.js').catch(() => ({}));
  const backup_locked = typeof isBackupEnvLocked === 'function' ? isBackupEnvLocked() : false;
  res.json({
    smtp: isSmtpEnvLocked(),
    ai: aiLocked,
    ai_enabled,
    oidc_provider_ids: getEnvLockedProviderIds(),
    backup_locked,
  });
}));

// ── GET /api/app-config/sharing — sharing status + recipe count (any auth user) ───
router.get('/sharing', requireAuth, wrap((req, res) => {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get('sharing_enabled');
  const enabled = row?.value === 'true';
  if (!enabled) return res.json({ sharing_enabled: false, recipes: 0 });

  const u = userMgmtActive() ? req.user.id : null;
  if (u == null) return res.json({ sharing_enabled: true, recipes: 0 });

  const recipes = db.prepare(
    `SELECT COUNT(*) as c FROM recipes WHERE user_id != ? AND visibility = 'group' AND deleted_at IS NULL`
  ).get(u).c;
  res.json({ sharing_enabled: true, recipes });
}));

// ── GET /api/app-config — return all config (passwords redacted) ───────────
router.get('/', requireAuth, requireAdmin, wrap((req, res) => {
  const rows = db.prepare('SELECT key, value FROM app_config').all();
  const out = {};
  for (const { key, value } of rows) {
    const redacted = key === 'smtp_pass' || key === 'ai_api_key';
    out[key] = redacted ? (value ? '••••••••' : '') : (value || '');
  }
  res.json(out);
}));

// ── PUT /api/app-config — upsert one key ──────────────────────────────────
router.put('/', requireAuth, requireAdmin, wrap((req, res) => {
  const { key, value } = req.body;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'Unknown config key' });
  // Block writes to env-locked sections
  if (key.startsWith('smtp_') && isSmtpEnvLocked()) return res.status(403).json({ error: 'SMTP is configured via environment variables and cannot be changed here.' });
  if (key.startsWith('ai_')   && isAiEnvLocked())   return res.status(403).json({ error: 'AI is configured via environment variables and cannot be changed here.' });
  // Don't overwrite secrets with the redaction placeholder
  if ((key === 'smtp_pass' || key === 'ai_api_key') && value === '••••••••') return res.json({ ok: true });
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value || null);

  // When disabling sharing, reset all recipes to private.
  if (key === 'sharing_enabled' && value !== 'true') {
    db.prepare(`UPDATE recipes SET visibility = 'private' WHERE visibility != 'private'`).run();
  }

  res.json({ ok: true });
}));

// ── POST /api/app-config/test-email — actually send a test email ─────────
router.post('/test-email', requireAuth, requireAdmin, wrap(async (req, res) => {
  // Optional body: SMTP field overrides so the user can test unsaved
  // form values without saving first. Blocked when the env-lock is on
  // (config is baked into env vars, not the request).
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const envLocked = isSmtpEnvLocked();
  const overrides = envLocked ? undefined : {
    smtp_host:   body.smtp_host,
    smtp_port:   body.smtp_port,
    smtp_secure: body.smtp_secure,
    smtp_user:   body.smtp_user,
    // Never accept the redaction mask as a real password
    smtp_pass:   body.smtp_pass === '••••••••' ? undefined : body.smtp_pass,
    smtp_from:   body.smtp_from,
  };
  // Recipient: prefer the current user's email so admins get proof the
  // email actually delivers, not just that SMTP accepted the handoff.
  const to = req.user?.email || undefined;
  try {
    const result = await testSmtp({ overrides, to });
    res.json({ ok: true, to: result.to });
  } catch (e) {
    res.status(400).json({ error: e?.message || 'SMTP test failed' });
  }
}));

export default router;
