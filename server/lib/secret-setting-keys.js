/**
 * CookTrace's secrets in user settings (lib/secret-settings.js).
 *
 * WRITE_ONLY: only the server uses them, so they're never sent back.
 * ENCRYPTED: the app uses them itself (it calls the AI provider, USDA and
 * Open Food Facts directly), so the account's own app still gets them.
 */
export const WRITE_ONLY_SETTINGS = new Set(['ntInstanceToken', 'ntfyToken', 'gotifyToken']);
export const ENCRYPTED_SETTINGS = new Set(['aiApiKey', 'usdaApiKey', 'offPassword']);
