/**
 * Password rules — single source of truth. Mirrors the server's validator
 * in server/routes/auth.js. Any change here should be reflected there too.
 *
 * Required:
 *   - 8+ characters
 *   - at least one lowercase
 *   - at least one uppercase
 *   - at least one digit
 *   - at least one special character
 */
import { get } from 'svelte/store';
import { _ } from 'svelte-i18n';

const t = key => get(_)(key);

export function validatePassword(pw) {
  if (!pw || pw.length < 8) return t('password.too_short');
  if (!/[a-z]/.test(pw)) return t('password.needs_lower');
  if (!/[A-Z]/.test(pw)) return t('password.needs_upper');
  if (!/[0-9]/.test(pw)) return t('password.needs_number');
  if (!/[^a-zA-Z0-9]/.test(pw)) return t('password.needs_symbol');
  return null;
}

/** Return a 0–4 strength score + label for UI indicators. */
export function passwordStrength(pw) {
  if (!pw) return { score: 0, label: '' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^a-zA-Z0-9]/.test(pw)) score++;
  score = Math.min(4, score);
  return { score, label: t(`password.strength_${score}`) };
}
