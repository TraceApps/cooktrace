# Roadmap

Ideas and planned enhancements. Grouped by area. No commitment to order or timeline.
Items marked ~~strikethrough~~ have been implemented.

Last refreshed at v1.0.1 (2026-08-09).

---

## Planned for v1.1.0

### Full i18n Coverage

Baseline as of v1.0.0 is ~50% coverage: 535 keys in `en.json`, ~500 strings still hardcoded across the 76 `.svelte` files (roughly 346 in text content + 285 in attributes, minus overlap). Section headers and some routes are covered; SettingsEmail, SettingsKitchens, cookbook sharing UI, most dialogs, and most attribute strings (placeholder, title, aria-label) are not.

Scope:

- Extract every remaining user-facing string into a key
- Extend `en.json` to the full set
- Stub matching keys in `sv.json` so the community translator can fill
- Add a CI lint rule that fails if a new component adds hardcoded English (Svelte template `>Some Text<` or `placeholder="Some Text"` without a `$_()` wrap), so coverage doesn't backslide after this release
- Sizing: 1-2 focused days

Apply the same sweep to LT and NT in their respective v1.1.0 releases once the CT pattern is proven.

---

## Recipes

### ~~Recipe CRUD~~ *(done, Phase 1)*
Server + UI + image upload via 3-button picker.

### ~~Per-recipe history~~ *(done, Phase 1)*
Last cooked, cook count, full cook diary entries.

### ~~Rating + favorite + long-press context menu~~ *(done, Phase 1)*
Star rating, heart favorite, right-click / long-press menu (open / favorite / plan / shop / duplicate / share / delete).

### ~~Recipe scaling + fraction parser~~ *(done, Phase 2)*
×0.5 / ×1 / ×2 / ×3 chips + custom servings input. Handles fractions ("1/2", "1 1/2") and snaps to common cooking fractions; "to taste" passes through.

### ~~Recipe categories~~ *(done, Phase 11, 2026-05-06)*
`recipe_categories` + `recipes.category_id`, twelve seeded chapters per user, manage in Settings → Recipe Categories. Pill above title; chip filter row + `?category=<slug>` URL state on Recipes list.

### ~~Threaded comments~~ *(done, Phase 11 + 14)*
`recipe_comments` table, flat threading with `parent_id`. Edit/delete by author or admin. Phase 14 wired the reply button + indented sub-list rendering.

### ~~3-col responsive layout~~ *(done, Phase 11)*
≥1280px adds Nutrition column on the right (sticky); 960-1279 keeps the 2-col with Nutrition full-width below; <960 stacks. Notes flow with Steps in the middle column on wide screens.

### ~~Two-column body on ≥960px~~ *(done, Phase 8)*
Ingredients ↔ steps side-by-side, sticky ingredients column, mobile stacks. Hero image no-crop (`object-fit: contain`). Print stylesheet via `@media print` + `@page` in RecipeView.

### ~~Byline + Last Updated + meta labels~~ *(done, Phase 11)*
"Added by X · May 4, 2026 · From example.com" replaces standalone Source. "Last Updated" italic footer only when `updated_at != created_at`. Meta labels: Prep Time / Cook Time / Total Time. "Last Cooked" formats with `dateFormat` setting and shows cook count.

### ~~Recipe `total_minutes` override + `rest_minutes`~~ *(done, Phase 18)*
Optional manual total override (null = auto). Importers pick up distinct Total from Mealie / Paprika / schema.org. `rest_minutes` covers rise / rest / marinate / chill / soak / ferment; rolls into auto-calc. All times render via shared `formatDuration()` helper (`1h 15m`).

### ~~Kitchen Gear~~ *(done, Phase 11)*
`tools` data renamed in the UI, lifted out of the chip row into its own checklist component (icon-mapped) under Ingredients in the left column. Schema.org `tool` field wired through the importer.

### Sticky ingredients column boundaries
Avoid header overlap on certain viewport heights.

### Cook Mode reflow verification
Single-column kitchen view stays; verify on narrow tablets in landscape.

---

## Recipe Sharing

### ~~Per-user recipe sharing~~ *(done, Phase 13)*
`recipe_shares` table with explicit grants. Endpoints: `/api/recipes/peers`, `/api/recipes/shared-with-me`, `/api/recipes/:id/shares` CRUD. Share dialog has a "Share with Users" checkbox list (each tick is an immediate grant/revoke). Recipes page has a Shared segment alongside Recipes / Cookbooks; shared cards show a "Shared by X" badge.

### ~~Recipe-card sharing (Pinterest-style SVG)~~ *(done, Phase 6)*
`GET /api/recipes/:id/card.png`, server-rendered 600×800 SVG with hero image + name + meta + CookTrace watermark. Wired into long-press menu Share action.

### ~~Public share links~~ *(done, Phase 6 + 12)*
`recipes.share_token` mint / rotate / revoke via long-press menu. Public read at `/r/<token>` works without auth, scoped to a single recipe. `/api/r/:token` endpoint bypasses the setup-required gate.

### PDF / square / letter alternate card templates
Only the SVG Pinterest card exists today; no PDF endpoint.

### Public share card
`/api/recipes/:id/card.png` is still auth-gated; a `/api/r/:token/card.png` variant would let the shared-link recipient render the card without an account.

---

## Kitchens (multi-user households)

### ~~Kitchen Auto-Share Your Recipes~~ *(done, Phase 19, v1.0.0-rc.5)*
Per-user `kitchen_members.auto_share` flag. Turning it on backfills every recipe you own into the Kitchen; new recipes you create thereafter fan out automatically. New members joining later pick up existing auto-sharers' recipes.

### ~~Dedicated Shared tab~~ *(done, Phase 19)*
Between Recipes and Cookbooks, sourced from `GET /api/recipes/shared-with-me`. Each card shows a chip for the via-Kitchen source when the grant came through a Kitchen (`recipe_shares.via_kitchen_id` tag).

### ~~Cookbook sharing~~ *(done, Phase 19)*
`cookbook_shares` table mirrors `recipe_shares` shape (grantee_id, granted_by, granted_at, via_kitchen_id). Owner dialog shares to individual users or fans out to a whole Kitchen. Shared cookbooks appear in the Cookbooks tab with a Shared chip. Recipes inside a shared cookbook that the reader hasn't been granted individually render as `{ id, name, locked: true }` locked-placeholder cards, so cookbook access can't bypass recipe permissions.

### ~~Blend Shared Recipes into Main List~~ *(done, Phase 19)*
Optional setting under Settings → Cooking, off by default.

### ~~Kitchen leave/remove revokes only incoming grants~~ *(done, Phase 19)*
Contributions stay with the remaining members. Applies to both recipe_shares and cookbook_shares.

---

## Pantry

### ~~Pantry library~~ *(done, Phase 2)*
In-stock toggle, quantity, unit, image, notes.

### ~~Auto-create pantry rows from recipe ingredient names~~ *(done, Phase 2)*
Case-insensitive dedup, single transaction on save. Recipe ingredients reference `pantry_item_id`. "X / Y in pantry" pill on every recipe card (color-coded full / partial / none).

### ~~Ingredient groups~~ *(done, Phase 2)*
Mealie-style sections ("Sauce", "Dough").

### ~~Pantry nutrition auto-calc~~ *(done, Phase 9)*
Schema: category, serving_size, serving_unit, serving_label, nutrition (JSON) on pantry_items. Edit modal: category dropdown + collapsible nutrition section. Toolbar: category filter chip row.

### ~~Cross-family unit conversions (density)~~ *(done, Phase 15)*
Per-pantry-row `g_per_cup` bridges volume↔weight in `recipe-nutrition.js`. `set_pantry_density` Trace tool + skip-badge hint ("set density to enable"). Built-in ~70-ingredient density lookup table added in Phase 17; PantryEditor gains "Look it up" button.

### ~~Recipe "Recompute from Pantry" + skipped list~~ *(done, Phase 17)*
Button below the FDA box. "Computed from N of M ingredients" plus a list of skipped entries with reasons. Each skipped row that we can fix gets an inline "Set N g/cup" button that writes the density and re-runs the calc. "Save This Calculation" commits totals to the recipe.

### ~~Pantry variants (parent → variants)~~ *(done, Phase 18, v1.0.0-rc.2, issue #4)*
`pantry_items.generic_parent_id` self-referencing FK. Recipe links point at the generic; each variant carries its own barcode / photo / stock / expiry. Three-level nesting server-rejected. Nutrition Source picker on generic (`nutrition_source_variant_id`), defaults to generic's own numbers. Three-way search classifier: parent-only, parent-expanded, variant-standalone (with "Variant of…" subtitle).

### ~~Pantry `expires_on` + Expiring Soon filter~~ *(done, Phase 18)*
Column + Expiring Soon filter chip + card pill (warn / past states).

### ~~UnitPicker combobox~~ *(done, Phase 2)*
37 cooking units, 5 categories, browse vs search, free-text fallback.

### ~~FDA-style Nutrition Facts box + sodium↔salt auto-derive~~ *(done, Phase 2)*
`visibleNutriments` setting + per-recipe nutrition entry.

---

## Shopping List

### ~~Quick-add + aisle grouping~~ *(done, Phase 4)*
Name + qty + unit + add. Items grouped by aisle, optimistic check-off, clear-checked bulk.

### ~~Add from recipe + only-missing filter~~ *(done, Phase 4)*
Recipe picker in the Shopping "+" menu, filter to items not already in pantry.

### ~~URL recipe scraper~~ *(done, Phase 4)*
`POST /api/recipes/scrape`, schema.org/Recipe JSON-LD parser, SSRF-guarded fetcher, wired into "+" menu.

---

## Cook Diary + Meal Planner

### ~~List + calendar views~~ *(done, Phase 3)*
Diary tab combines past cooks + planned cooks. List view (60d back / 30d forward, grouped by date). Month calendar grid view with pill entries.

### ~~Plan-a-cook + one-tap convert~~ *(done, Phase 3)*
Plan-a-cook modal (date + searchable recipe picker). One-tap convert planned → cooked. Cook-history list inside each recipe (delete + edit).

### ~~Cook Mode~~ *(done, Phase 3)*
Wake lock + bigger fonts + ingredient/step checkboxes persisted per recipe.

### ~~Cook timers~~ *(done, Phase 12)*
Global running-timer store with WebAudio chime, browser notification, +1 min / Snooze / dismiss, persistent across page reload via localStorage. Inline play buttons next to detected duration mentions in step text ("30 min", "2 hours", "30-45 minutes"). Floating bottom rail on every page.

### ~~Cook Mode inline timer rail~~ *(done, Phase 15)*
Timer rail embedded inline in the cook-mode-bar (was floating globally). `cookModeActive` store hands off between App.svelte and RecipeView.

---

## Importers

### ~~Mealie / Tandoor / Paprika / schema.org JSON~~ *(done, Phase 7)*
Auto-detected from paste/upload. Paprika `.paprikarecipes` archive (zip of gzipped JSON, multi-recipe).

### ~~Saved-HTML upload + plain-text fallback~~ *(done, Phase 7)*
Same JSON-LD parser as the URL scraper. Plain-text paragraphs become stub steps.

### ~~AI photo import~~ *(done, Phase 15)*
First-class "Import from Photo" entry on the Recipes create menu. Standalone `PhotoImportDialog` runs the Trace tool-use loop with a tight system prompt + `create_recipe`-only catalog, then navigates to the saved recipe.

### ~~CookTrace export passthrough~~ *(done, Phase 7)*

### ~~Recipe-import dedup~~ *(done)*
`dedup: 'skip' | 'force'` parameter on the import endpoint checks case-insensitive name and `source_url` matches (see `server/routes/recipes.js:963`).

### PDF import via server-side OCR
Deferred to v2.

---

## Cookbooks

### ~~Regular + smart cookbooks~~ *(done, Phase 12)*
Smart cookbooks evaluate a saved filter (category + tags + favorites_only + min_rating + max total minutes) live on every read.

### ~~Cookbook cover image upload~~ *(done, Phase 14)*
`cover_image_url` on the schema. Inline edit shows the cover; tap-to-upload via `/api/upload`.

### ~~Cookbook reorder + drag-and-drop~~ *(done, Phase 14 + 15)*
↑/↓ buttons per row in ManageCookbooks. Recipes inside a cookbook get ←/→ buttons on card hover (not for smart cookbooks). Bulk PUT endpoints `/api/cookbooks/order` + `/api/cookbooks/:id/recipes/order`. Phase 15 added native HTML5 DnD alongside the arrows.

### ~~Cookbook bulk Move / Copy~~ *(done, Phase 15)*
Per-card Move/Copy button on every recipe inside a cookbook detail page. Modal with target cookbook picker + Move/Copy radio.

---

## Trace AI (in-app assistant)

### ~~Chat FAB + provider proxy~~ *(done, Phase 5)*
Floating chat FAB on every page; settings for provider / API key / model / base URL. `/api/ai/chat` server-side proxy.

### ~~Cooking-domain tool-use (all providers)~~ *(done, Phase 13)*
Function-calling across Claude, OpenAI, Gemini, OpenAI-compatible. Mirrors NT + LT via `src/lib/aiChat.js`.

Read tools: `get_recipes`, `get_recipe`, `get_pantry`, `find_recipes_from_pantry`, `get_diary`, `get_shopping_list`, `get_cookbooks`, `get_cookbook`.

Write tools: `log_cook`, `plan_cook`, `add_to_shopping`, `add_to_pantry`, `set_pantry_stock`, `add_to_cookbook`, `create_recipe`.

### ~~URL import tool~~ *(done, Phase 14)*
`import_recipe_from_url` wraps the scrape endpoint. "Import this from `<url>`" works in chat.

### ~~Image attach + AI photo import~~ *(done, Phase 13)*
Paperclip button, provider-specific message format. Powers AI photo import: snap a cookbook page, ask Trace to "import this", `create_recipe` tool fires.

### ~~Voice smart-logging~~ *(done, Phase 14)*
Mic button in Trace footer toggles Web Speech API recording; transcript flows live into the input so the user reviews + sends. Tool catalog handles the intent (add to pantry, log a cook, search recipes, import from URL, create from dictation).

### ~~`onToolResult` callback~~ *(done, Phase 15)*
Alongside `onToolCall`, so callers (PhotoImportDialog) can capture the new recipe id.

---

## External Integrations

### ~~NutriTrace federation~~ *(done, Phase 5)*
Settings → NutriTrace federation: URL + access token + Test button. Server proxy at `/api/nt/*`, bearer token never leaves the server. Pantry NT-food-link picker (Settings → Import from NutriTrace, `SettingsImportFromNT.svelte`, search + bulk-import with nutrition + image).

### Auto-log cooked-recipe → NT diary
Server proxy `/api/nt/log-meal` exists; missing the client-side wiring to fire it from CookLogDialog.

### Model Context Protocol (MCP) server

Expose CookTrace to external AI clients (Claude Desktop, Cursor, Codex, VS Code) the same way NutriTrace does starting with `v1.2.0-dev01`. Recipe / pantry / shopping / cook-diary workflows are inherently conversational, which is exactly what agent-driven tools shine at. "What can I make from what's in the pantry?" → "add these to shopping" → "I cooked it, mark done" is one continuous back-and-forth.

Off by default; opt in with `MCP_ENABLED=1` env + a new `mcp:read` scope on the token. Write and destructive tiers gated behind `MCP_WRITE_ENABLED=1` + `mcp:write` and `MCP_DESTROY_ENABLED=1` + `mcp:destroy` respectively, matching the NT model. Each destructive call also requires `confirm: true` in the arguments.

Natural tool set (~15, most map directly from Trace AI):

- **Read**: `search_recipes`, `get_recipe`, `find_recipes_from_pantry`, `get_pantry`, `get_shopping_list`, `get_cookbooks`, `get_cookbook`, `get_cook_diary`
- **Write**: `log_cook`, `plan_cook`, `add_to_shopping`, `add_to_pantry`, `set_pantry_stock`, `add_to_cookbook`
- **Destructive**: `delete_shopping_item`, `remove_from_pantry`, `create_recipe`, `import_recipe_from_url`

Wait until NT's MCP has real usage feedback (~week or two after the v1.2.0 stable release) so any design tweaks land in NT first, then port. Roughly 2-4 days of work; see the NT `server/lib/mcp/` layout for the exact pattern to replicate.

---

## Manage Hub

### ~~/manage hub~~ *(done, Phase 12)*
Master-list Manage hub at `/manage` with Recipe Categories, Tags, Kitchen Gear, Pantry Categories, Units (built-in disable + custom CRUD), and Cookbooks editors.

### ~~Combobox component~~ *(done, Phase 12)*
Used in RecipeEditor + PantryEditor for type-to-filter + inline-create on category, tags, Kitchen Gear.

---

## Notifications

### ~~Push delivery (Apprise / Gotify / ntfy)~~ *(done, Phase 10)*
Server-side secrets. Settings → Notifications UI: device toggle, push-service config, Send-test button, per-reminder toggles.

### ~~Server scheduler (15-min tick)~~ *(done, Phase 10 + 12)*
Cook-day + shopping-nudge + weekly-summary + expiration-digest reminders, deduped per user per day via `notification_log`.

### ~~Expiration Digest~~ *(done, Phase 10 + 18)*
Once-per-day roll-up delivered through the same Apprise / Gotify / ntfy pipeline. User picks the window (1 / 3 / 5 / 7 / 14 days) and time of day. Past-expiry items always included.

### ~~Weekly summary email~~ *(done, Phase 17)*
Replaces the Phase A stub with a CookTrace-domain implementation: cooks logged, all-time favorite, new recipes added, what's planned next 7 days, pantry-out and shopping-pending counts. Skips silently when there's no activity. Scheduler fires Sundays 8-9am, deduped via `notification_log`. Settings toggle default off.

### ~~Comment-reply notifications~~ *(done, Phase 15)*
`notifyCommentReply` helper + hook in the comments POST route. `notifRecipeComments` toggle in Settings → Notifications, default on.

### Native cook-day reminders via Capacitor LocalNotifications
`src/lib/notifications.js` is still a Phase A stub; server-side push works, the local-alarm mirror doesn't yet.

### Thaw alert
Needs a recipe-level thaw-24h-ahead signal or NLP over ingredients (raw meat / frozen dough) to fire without false alarms. Deferred.

---

## Email

### ~~SMTP form in Settings → Email~~ *(done, Phase 16)*
Host / port / TLS / user / pass / from / Save / Test. Mirrors NutriTrace, respects env-locks.

### ~~Welcome email on registration~~ *(done, Phase 16)*
`sendWelcome`, wired into `/api/auth/register`.

### ~~Recipe-shared-with-you email~~ *(done, Phase 16)*
`sendRecipeShared`, wired into `/api/recipes/:id/shares` POST.

### ~~Invite copy de-NutriTraced~~ *(done, Phase 16)*
"Self-hosted recipe box, pantry tracker, and meal planner" instead of nutrition tracker.

---

## Backup & Data

### ~~Server full-backup ZIP~~ *(done, Phase 10)*
DB + uploads. Create / list / download / delete / restore-from-server / upload-restore. Settings → Backup & Data UI with all of the above + JSON local-export.

### ~~Full-backup extended for Kitchens/Sharing~~ *(done, Phase 19)*
Full-backup dump + schema-driven restore extended to cover `cookbook_shares`, `kitchen_members.auto_share`, and `recipe_shares.via_kitchen_id`.

---

## Android App (Capacitor)

### ~~Android sync fixes for variants + expiration~~ *(done, Phase 18)*
`updatePantryItem` writes only present fields; sync order is pull-then-push; server push uses `COALESCE` on FK columns; pull orders self-referencing tables so parents arrive first; idempotent ALTER migration for the new columns.

### ~~Bundle splitting~~ *(done, Phase 14)*
`manualChunks` + `wrap()` lazy-loaded routes. Initial bundle dropped from 843KB to 392KB (uncompressed, 248→118KB gzipped). Manage, Settings, Wizard, and PublicRecipe ship as their own chunks.

### Native cook-day reminders via Capacitor LocalNotifications
Mirror the `notifLocalEnabled` toggle. Server-side push works; the local-alarm mirror doesn't yet.

---

## i18n

### ~~Trace panel duplicate `trace` block~~ *(done, Phase 19)*
Merged duplicate `trace` block in en.json that was dropping raw keys (`trace.panel_sub`) into the AI panel.

### Full coverage sweep (v1.1.0)
See top of file.

---

## Tech debt

### `openid-client 5 → 6`
Borderline. Complete rewrite, cleaner API. Deferred unless iterating on OIDC. Monthly `npm audit` cadence continues (see memory `project_cooktrace_dep_audit.md`).

### ~~Svelte 4 → 5~~ *(done, `^5.55.9` with compat mode `runes: false` + `componentApi: 4`)*

### ~~Vite 5 → 7~~ *(done, `^7.3.3`)*

### ~~`@sveltejs/vite-plugin-svelte` 3 → 6~~ *(done, `^6.2.4`)*

### ~~Express 4 → 5~~ *(done, `^5.2.1`)*

### ~~bcryptjs 2 → 3~~ *(done, `^3.0.3`)*

### ~~nodemailer 8 → 9~~ *(done, rc.3, cleared five CVEs)*

### ~~multer 1.4.5-lts.1 → 2.2.0~~ *(done, rc.3, cleared three DoS CVEs on the LTS line)*

**Skip**: better-sqlite3 already on 11.x (further bumps need no CookTrace-specific reason).

---

## Out of scope (until requested)

- Multi-database (Postgres etc.), SQLite-only, intentionally
- Built-in barcode scanner (use Pantry add-by-name)
- Native iOS app
