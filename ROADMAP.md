# Roadmap

Ideas and planned enhancements. Grouped by area. No commitment to order or timeline.
Items marked ~~strikethrough~~ have been implemented.

Last refreshed 2026-10-04, after v1.4.0 (v1.4.1 in testing).

---

## Recipes

### Recipe revision history, linked to the diary
Requested in [#54](https://github.com/TraceApps/cooktrace/issues/54) (DefectiveConsole), aimed at 1.5.0.
Save a version whenever a recipe changes and record which version each cook
used, so an old diary entry opens the recipe as it was made. Then a History
view with a comparison, restore as a new version, and the reverse: open a
version and see every cook of it with its rating. Traps: every write path has
to snapshot (web, REST, MCP, phone sync), restoring must add a version rather
than rewind, a save that changes nothing should not make one, and revisions
record who saved them now that a Sous Chef can edit a shared recipe.

### Use a recipe as an ingredient (sub-recipes)
Requested in [#58](https://github.com/TraceApps/cooktrace/issues/58)
(herver1971), with a full design. An ingredient row gains an optional
reference to another recipe, instead of a pantry item, so a sauce or a dough
is written once and used everywhere. Pays off in the shopping list (expand
the sub-recipe into its own ingredients), nutrition (contribute per serving
or per gram), and navigation from the recipe view and Cook Mode. Needs a
depth limit and a cycle guard.

**Decide first:** the reference cannot be the recipe's row id. Sync only
translates ids in declared columns, never ids inside the ingredients JSON, so
a phone-created reference would point at the wrong recipe on the server.
`share_token` is not a substitute: it only exists while a recipe is publicly
shared. This wants a stable per-recipe identifier written at creation on both
the server and the phone, which would also serve the revision history above,
export and import, and federation.

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

### ~~Link previews for shared recipes~~ *(done on dev, next minor release)*
A shared `/r/` link shows the recipe's name, a line about it and its photo in chat apps.

### PDF / square / letter alternate card templates
Only the SVG Pinterest card exists today; no PDF endpoint.

### Public share card
`/api/recipes/:id/card.png` is still auth-gated; a `/api/r/:token/card.png` variant would let the shared-link recipient render the card without an account.

---

## Kitchens (multi-user households)

### ~~Kitchen roles~~ *(done, 1.4.0, #52)*
Head Chef, Sous Chef and Line Cook, plus handing a Kitchen to another member.

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

### Merge pantry items, or group them as variants
Asked in [discussion #57](https://github.com/TraceApps/cooktrace/discussions/57). Multi-select already exists (long-press) with only Delete. Add a merge: pick the main item and turn the others into its variants, keeping recipe links. Plus a true merge for plain duplicates ("Medium tomato" into "Tomato") that repoints recipe links and removes the duplicate.

---

## Shopping List

### ~~Quick-add + aisle grouping~~ *(done, Phase 4)*
Name + qty + unit + add. Items grouped by aisle, optimistic check-off, clear-checked bulk.

### ~~Add from recipe + only-missing filter~~ *(done, Phase 4)*
Recipe picker in the Shopping "+" menu, filter to items not already in pantry.

### ~~URL recipe scraper~~ *(done, Phase 4)*
`POST /api/recipes/scrape`, schema.org/Recipe JSON-LD parser, SSRF-guarded fetcher, wired into "+" menu.

### One shopping list per Kitchen
Lists belong to an account today; Kitchens share recipes, not the list, so households share a login to share a list. A Kitchen list would fix that, and needs the sync fix under Android App (an older change must not win) first.

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

### ~~Cook more than one thing at once~~ *(done, 1.4.0)*

### Messages that read professionally (1.5)
A sweep of every toast, summary and error line (about 450 toast calls, 54 still hardcoded in English) to one house style: lead with the result ("Recipe saved", "Imported 119 of 121 Recipes"); give the reason only when something went wrong ("Couldn't save the recipe: the server is offline."); name the next step when there is one ("Opening it."); no filler ("All set", "Oops"), no exclamation marks, no em dashes; toasts and body text in sentence case, titles and buttons in title case. Hardcoded strings move to `en.json` with Spanish alongside. The import messages were done first, in 1.4.1. Same pass in NutriTrace, LiftTrace and NoteTrace, which share the toast patterns.

### Plan your week (1.5 candidate)
What Mealime users miss now that it's closing (2026-10-21), built on what CookTrace already knows: recipe quantities, the pantry with expiry, and planned cooks with servings. Audited 2026-10-04 against Mealime's help center, store listings and the shutdown threads, and against CookTrace's code. One flow: pick the week, see what it costs you to shop and what it uses up, shop from one list.

**Phase 1: foundations and the bugs under them.**
- A shared quantity library on the server (port `parseQty` and the unit families from `qty.js` and `recipe-nutrition.js`), used by every list builder. Today `Number("1/2")` drops fractional amounts from the list, and `/from-recipe` writes raw "1/2" into a number column.
- The plan's grocery list scales each recipe by its planned servings (stored on the diary row, never used), merges the same ingredient across recipes with unit conversion (1 cup + 120 ml), and keeps every origin: a `sources` list per shopping row (recipe, diary entry, amount), synced and offline like the rest.
- Plan a Cook asks for servings (defaulting to the recipe's or the household's).
- Fix the recipe card's Plan action (`/diary?plan=<id>` is never read), scale the amounts shown inside steps, and compute the pantry match on Android (empty there today).
- Mealime exports import in full: the community exporter's schema.org files lose their photo (a relative `../images/` path inside the zip), the user's notes (`comment`) and the original link (`isBasedOn`).

**Phase 2: a Week view and the list's detail sheet.**
- Cook Diary gains a Week view beside List, Month and Photos, which stay as they are. It is one timeline: days behind you show what you cooked (photo, rating, Cooked), days ahead show each planned cook as a card (photo, servings stepper, meal chip), and today's plan has Mark as Cooked. Plus an unscheduled "This week" tray for people who plan a pool of meals rather than days, as Mealime did.
- A plan summary card on the Week view, in the style of the diary's stat tiles: meals planned, items to buy, items already in the pantry, expiring items this plan uses. One button builds or refreshes the list for that week.
- Tap a shopping item to open a sheet: the total, what each recipe needs and on which day, pantry stock and variants, a size hint where the pantry or common densities know one ("medium potato, about 200 g"), and notes. Edit and aisle stay in the long-press menu. Two panes on a foldable or tablet.

**Phase 3: plans that waste less.**
- "Uses up" on the Week view: a strip like the pantry's expiring spotlight, listing perishables the plan only partly uses or that are expiring, each with recipes that use them too. Ranked by shared ingredients with what's planned, pantry match and expiry; honest without package sizes, more precise once pantry items can say what they come in (an optional pack size, later).
- "Build my week": choose how many dinners and servings; get a set ranked by pantry match, shared ingredients, variety and not cooked recently, with a swap button on each card and the summary updating live. Works without AI; Trace can do the same in conversation (`plan_cook` gains servings).

**Phase 4: the household.**
- Household members under Settings: name, diet, allergies, dislikes, and the days they're home (a child there four days a week). Planned servings default to who's home that day.
- Allergens, stored once and shown where a decision is made. Nothing holds allergens today.
  - Vocabulary: the EU's 14 allergens, using Open Food Facts' codes (`en:gluten`, `en:milk`, `en:eggs`, `en:nuts`, `en:peanuts`, `en:soybeans`, `en:sesame-seeds`, `en:fish`, `en:crustaceans`, `en:molluscs`, `en:celery`, `en:mustard`, `en:sulphur-dioxide-and-sulphites`, `en:lupin`); they cover the US's nine.
  - Stored on pantry items (`allergens` and `traces`, JSON arrays of codes): filled from Open Food Facts when a product is scanned or looked up, shown and editable as chips in the item sheet with where they came from ("from the label", "you set this").
  - Stored on household members (allergies, diet, dislikes), the people the warnings are for.
  - Worked out for recipes, not stored: the linked pantry items' allergens, plus a keyword map over ingredient names for unlinked ones ("flour", "soy sauce", "parmesan"), plus a per-recipe correction (add or remove, for a gluten-free flour the map can't know). Computed with the pantry match, on the server and on Android.
  - Shown: a warning chip on recipe cards naming who it affects ("Gluten · Sam"); in the recipe view a line under the title and a mark on the ingredient responsible; on Week view cards; in the shopping item sheet; and "Build my week" leaves out conflicts by default. "May contain" (traces) is shown apart from "contains".
  - Always labeled as a help, not a guarantee: worked out from ingredient names and labels, check packaging. The README's disclaimer already covers allergies.
- Replaces the wizard's dietary question, which is stored but never used today.

Not planned: a curated recipe catalog (CookTrace has none to offer), grocery-delivery hand-off (partner keys, US-only), hands-free wave-to-advance (Cook Mode has voice). Design rules: reuse `Sheet`, chips, stat tiles and the spotlight strip rather than new one-off modals; every new surface works offline and on Android; foldables split where there's room. Each phase updates the docs in the same work (cooktrace/diary.md, shopping.md, pantry.md, recipes.md, settings.md, import.md and features.md as they apply), on `docs/dev` until release. Mockups: the "CookTrace Plan Your Week" design canvas (2026-10-04).


### ~~Mealie / Tandoor / Paprika / schema.org JSON~~ *(done, Phase 7)*
Auto-detected from paste/upload. Paprika `.paprikarecipes` archive (zip of gzipped JSON, multi-recipe).

### ~~Saved-HTML upload + plain-text fallback~~ *(done, Phase 7)*
Same JSON-LD parser as the URL scraper. Plain-text paragraphs become stub steps.

### ~~AI photo import~~ *(done, Phase 15)*
First-class "Import from Photo" entry on the Recipes create menu. Standalone `PhotoImportDialog` runs the Trace tool-use loop with a tight system prompt + `create_recipe`-only catalog, then navigates to the saved recipe.

### ~~CookTrace export passthrough~~ *(done, Phase 7)*

### ~~Tandoor export (zip of zips)~~ *(done, 1.4.1, #72)*

### Ingredient line parser gaps
From [discussion #57](https://github.com/TraceApps/cooktrace/discussions/57): ranges ("4 - 5 roma tomatoes" became qty 4, name "- 5 roma tomatoes"), size words left in the name ("15-ounce can", "Large can", "medium"), and prep after a comma ("onion, diced"). The name feeds pantry auto-link, so these become junk pantry items. Also match before creating (tomato/tomatoes). Check exact source pages first; the reporter was asked for URLs.

### ~~Recipe-import dedup~~ *(done)*
`dedup: 'skip' | 'force'` parameter on the import endpoint checks case-insensitive name and `source_url` matches (see `server/routes/recipes.js:963`).

### Import from a video
An idea, not scheduled. Mealie (3.13+) and Norish both import recipes from video
links; neither makes step pictures (both turn speech or captions into text),
so that and "watch this step" are where CookTrace can do better. Audited
2026-10-04 against their code and a live YouTube test. In layers:

1. **Link to the written recipe, no AI.** Read the video's title,
   description and chapters (yt-dlp, about 28 MB in the image). When the
   description links a recipe page (common), import that page with the normal
   importer and attach the video and its thumbnail.
2. **Trace from captions.** Otherwise send the auto-captions (with
   timestamps) and description to Trace, with any provider including local
   ones. Thumbnail becomes the photo, chapters become step titles. No download
   and no speech-to-text needed: captions came through in testing.
3. **"Watch this step."** Trace returns where each step starts; each step gets
   a button that plays the video from there. Neither competitor has it.
4. **Speech-to-text when there are no captions** (TikTok, Instagram,
   uncaptioned videos): download the audio and send it to an OpenAI-compatible
   transcription endpoint (OpenAI, Groq, local Whisper) or Gemini's own audio
   input. Needs a separate audio model setting.
5. **Upload or share a video file, with real step pictures.** A saved clip
   avoids every platform wall; grab a frame at each step's start for the
   step's photo (per-step photos already exist). Needs ffmpeg (about 125 MB).
   Optionally Gemini watches the clip and reads on-screen text, which covers
   silent videos.

Plus an Android share target (share a YouTube or TikTok link into CookTrace).
Server-only, like the Enhanced tier: local mode can't run yt-dlp, and import
already needs a connection. A first version would be layers 1 to 3 and the
share target; 4 and 5 later.

Traps found in testing and in their issue trackers: YouTube now withholds
video and audio streams (bot check, proof-of-origin tokens), so only captions,
description and tiny storyboards are reliable there; caption fetching needs
specific yt-dlp client modes; yt-dlp must be bumped every few weeks or sites
stop working; Instagram and TikTok often need the user's cookies (copy
Norish's per-user saved cookies); try the cheap sources first (linked page,
captions, post text) before paid speech-to-text; cap length and size before
downloading; say clearly when a site needs sign-in; never let the prompt
invent quantities. Downloading media is against YouTube's terms; reading
captions and descriptions is lighter. Unverified: Instagram and TikTok
fetching, and Gemini taking a YouTube link directly.

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

### ~~Model Context Protocol (MCP) server~~ *(done, 1.2.0)*
Off by default (`MCP_ENABLED=1`), with read, write and destructive tiers each behind its own flag and token scope.

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

### ~~Wear OS app~~ *(done, 1.4.0)*

### ~~Preliminary foldable support~~ *(done, 1.4.0)*

### Sync: an older change must not win
Found 2026-10-04 while answering a Reddit question. The phone's sync push applies whatever a device sends, with no timestamp check, so an offline edit brings back an item someone else cleared, and an offline clear removes an item someone unticked since (both reproduced against a real server). The web app's offline queue is safe: an edit to a removed item is refused and named. Keep a deletion unless the edit is newer, skip a stale delete, and add offline-sync tests for both directions. Check NutriTrace, LiftTrace and NoteTrace, which share the pattern.

---

## i18n

### ~~Trace panel duplicate `trace` block~~ *(done, Phase 19)*
Merged duplicate `trace` block in en.json that was dropping raw keys (`trace.panel_sub`) into the AI panel.

### ~~Full i18n retrofit~~ *(done, 1.1.0)*

### Strings that slipped back, and a lint rule
About 30 hardcoded English strings are back in templates (CookbookView, SettingsUserManagement, Recipes, ManageTaxonomyList, CookHeatmap and others). Move them to `en.json`, and add the CI check from the original plan that fails on new hardcoded text.

---

## Offline

### ~~Offline PWA editing~~ *(done, 1.4.0)*
The installed web app opens and works with no connection: shopping list, pantry, diary, recipes and settings edit offline and go up when it's back; imports, sharing, Kitchens, Trace and admin say they need a connection.

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
- Native iOS app, until there's a Mac and an iPhone to build and test it on (the Ko-fi fund)
