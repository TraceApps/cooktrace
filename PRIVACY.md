# Privacy Policy: CookTrace

**Last updated:** August 3, 2026

## Overview

CookTrace is a self-hosted recipe, pantry, and cooking tracker. Your data is stored on **your own server**, not on any central server, not in the cloud, and not shared with third parties.

## Data Collection

### What CookTrace stores on YOUR server:

- Recipes (ingredients, steps, photos, cook mode state, per-recipe notes, cook log entries with dates + photos)
- Pantry items (stock levels, variants, expiration dates, barcodes, brand + category, per-item notes, uploaded photos)
- Cook Diary and Meal Planner entries (planned and logged cooks by date, ratings, per-cook notes)
- Shopping list (items, aisle groupings, checked state, recipe provenance)
- Cookbooks (named collections, smart-filter definitions, member recipes)
- Kitchens (multi-user soft groups with per-member share grants, Auto-Share settings)
- Recipe and cookbook sharing grants (per-user and public-link share tokens)
- AI chat history (if Trace is enabled)
- User account information (username, hashed password, optional email, optional display name, optional avatar)
- OIDC SSO links (provider, subject claim)
- App settings and preferences

### What CookTrace does NOT collect:

- We do not operate any central server that receives your data
- We do not collect analytics, telemetry, or usage statistics
- We do not serve advertisements
- We do not sell, share, or transmit your data to third parties
- We do not use tracking cookies or fingerprinting

## Third-Party Services

CookTrace connects to the following external services **only when you explicitly enable them**:

- **Open Food Facts.** Food product lookups by barcode or name via the OFF public API (search-a-licious). Subject to [OFF privacy policy](https://world.openfoodfacts.org/privacy). See [LICENSES.md](LICENSES.md) for ODbL attribution notes.
- **USDA FoodData Central.** Optional food nutrition lookups. Requires the user's own [api.data.gov](https://api.data.gov/) key. Subject to [USDA privacy policy](https://www.usda.gov/privacy-policy).
- **Mealie** (per user). Live queries against the user's own Mealie instance for bulk recipe import. User provides URL + API token; the token is stored on your CookTrace server.
- **Paprika and Tandoor imports.** Bulk imports via user-uploaded export files. No live connection; CookTrace acts only as an importer.
- **recipe-scrapers (URL imports).** When the user pastes a public web URL, CookTrace one-shot scrapes schema.org/Recipe JSON-LD (with an optional Python-side fallback via the `recipe-scrapers` library if `PYTHON_BIN` is configured). Each source website's terms of use apply to the scraped content.
- **OIDC providers (Authentik, Keycloak, Pocket-ID, Authelia, Google, Auth0, or any OIDC 1.0 provider).** If admins configure SSO, sign-in is delegated to your chosen identity provider. Client secrets are stored encrypted at rest.
- **AI providers (Claude, OpenAI, Gemini, OpenAI-compatible).** If Trace is enabled, your conversation and relevant recipe / pantry / diary context is sent to the provider you choose. Subject to their respective privacy policies. Your API key is stored on your server, not ours. The "OpenAI Compatible" provider (Ollama, LM Studio, LocalAI, vLLM, DeepSeek, Groq, and similar) connects directly from the browser to the endpoint you configure; the CookTrace server never sees those requests in per-user mode.
- **Push notification services (Apprise, Gotify, ntfy).** Optional. If configured, notification content (expiration digest, cook-day reminder, thaw alert, shopping-list nudge, recipe comments, backup-failed alert) is sent to your self-hosted push server. Only one provider is active at a time.
- **SMTP (email).** Optional. If configured, password reset emails, user invites, weekly summary emails, and share-notification emails are sent via your SMTP provider. See the [Email / SMTP docs](https://traceapps.github.io/docs/integrations/smtp/) for details.

## Data Retention

Your data is retained on your server until you delete it. You can:

- Delete individual recipes, pantry items, cook diary entries, cookbooks, kitchens, or shares at any time
- Export all your data via JSON export or full backup (ZIP)
- Delete your account and all associated data
- Wipe the database entirely

## Android App

The CookTrace Android app stores data locally on your device in a SQLite database within the app's private data directory. When connected to a server, data syncs bidirectionally. The app requests the following permissions:

- **Internet.** Server sync, OFF / USDA lookups, AI chat, in-app updates
- **Camera.** Recipe hero photos, per-step photos, pantry item photos, barcode scanning, Trace image attachments
- **Notifications.** Expiration digest, cook-day reminder, thaw alert, shopping-list nudge, backup-failed alert
- **Schedule / use exact alarm.** Precise reminder delivery even when the app is backgrounded
- **Receive boot completed.** Re-arm scheduled reminders after device reboot
- **External storage (Android 12 and below).** Save exported backups to your Downloads folder
- **Foreground service.** Long-running import operations
- **Install packages.** In-app self-updater (`Settings > Updates`) hands the downloaded APK to the system installer

CookTrace does **not** request Health Connect, wearable, fitness sync, contacts, location, or microphone permissions.

### Local data at rest

CookTrace does not add its own SQLite-level encryption (e.g. SQLCipher) on top of the database. Instead, it relies on Android's built-in file-based encryption (FBE), which has been the default on every Android device since Android 7 (2016). FBE encrypts the app's private data directory using a key derived from your device PIN, password, or biometric, meaning a locked phone is already encrypted at rest, and the contents of the database are inaccessible to anyone without your unlock credential. This matches the approach used by other self-hosted lifestyle apps (Immich, Joplin, Obsidian, AnkiDroid).

An attacker with physical access to your *locked* device cannot read your data. An attacker with physical access to your *unlocked* device can read it, but they could also simply open the app. If your threat model includes nation-state-level adversaries with extended access to your unlocked device, no cooking tracker (and few apps in any category) will protect you, and you should be using a hardened device profile separate from this app.

The local database is the same database used by all your data: recipes, pantry, cook diary, shopping list, cookbooks, kitchens, settings, AI chat history. Full backups (ZIP exports) are also unencrypted by default; keep them in trusted storage if you back up off-device.

## Children's Privacy

CookTrace is not directed at children under 13. We do not knowingly collect data from children.

## Changes to This Policy

This privacy policy may be updated from time to time. Changes will be noted in the changelog.

## Contact

For privacy questions, open an issue at [github.com/traceapps/cooktrace](https://github.com/traceapps/cooktrace/issues).
