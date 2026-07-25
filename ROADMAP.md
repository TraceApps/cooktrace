# Roadmap

What's shipped, what's planned, what's parked. Phase numbers
track internal build order; skip to the last few phases for the
current state.
## Phase A: Foundation ✅ DONE
- [x] NT fork stripped to runnable empty shell
- [x] CookTrace branding, schema, settings categorization
- [x] Android Java package rename (`com.nutritrace.app` → `com.cooktrace.app`)
- [x] Boot verification + first commit
- [x] CookTrace icon pack applied (PWA + Android mipmaps + email logo)

## Phase 1: Recipes ✅ DONE
- [x] Recipe CRUD (server + UI + image upload via 3-button picker)
- [x] Per-recipe history (last cooked, cook count, full cook diary entries)
- [x] Recipe rating (★) + favorite (♥)
- [x] Step summaries ("Step 1: Preheat Oven")
- [x] Created-by + dates footer
- [x] Long-press / right-click context menu (open / favorite / plan / shop /
      duplicate / share / delete)

## Phase 2: Pantry + scaling + ingredient groups ✅ DONE
- [x] Pantry library with in-stock toggle, quantity, unit, image, notes
- [x] Auto-create pantry rows from recipe ingredient names (case-insensitive
      dedup, single transaction on save)
- [x] Recipe ingredients reference `pantry_item_id`
- [x] "X / Y in pantry" pill on every recipe card (color-coded full /
      partial / none)
- [x] Ingredient groups (Mealie-style sections, "Sauce", "Dough")
- [x] Recipe scaling: ×0.5 / ×1 / ×2 / ×3 chips + custom servings input.
      Quantity parser handles fractions ("1/2", "1 1/2") and snaps results
      to common cooking fractions; "to taste" passes through.
- [x] FDA-style Nutrition Facts box + sodium↔salt auto-derive +
      `visibleNutriments` setting + per-recipe nutrition entry
- [x] Proper UnitPicker combobox (37 cooking units, 5 categories,
      browse vs search, free-text fallback)

## Phase 3: Cook Diary + Meal Planner ✅ DONE
- [x] Diary tab, combined past cooks + planned cooks
- [x] List view (60d back / 30d forward, grouped by date)
- [x] Month calendar grid view with pill entries
- [x] Plan-a-cook modal (date + searchable recipe picker)
- [x] One-tap convert planned → cooked
- [x] Cook-history list inside each recipe (delete + edit)
- [x] Cook Mode (wake lock + bigger fonts + ingredient/step checkboxes
      persisted per recipe)

## Phase 4: Shopping List ✅ DONE
- [x] Quick-add row (name + qty + unit + add)
- [x] Items grouped by aisle, optimistic check-off, clear-checked bulk
- [x] "Add from recipe" picker with "only missing" filter
- [x] URL recipe scraper (`POST /api/recipes/scrape`, schema.org/Recipe
      JSON-LD parser, SSRF-guarded fetcher, wired into "+" menu)

## Phase 5: NutriTrace federation + Trace AI ✅ DONE
- [x] Settings → NutriTrace federation: URL + access token + Test button
- [x] Server proxy at `/api/nt/*`, bearer token never leaves the server
- [x] Real Trace AI assistant: floating chat FAB on every page, settings
      configuration (provider / API key / model / base URL), `/api/ai/chat`
      server-side proxy already in place
- [x] Pantry NT-food-link picker (Settings → Import from NutriTrace,
      SettingsImportFromNT.svelte, search + bulk-import with nutrition
      + image)
- [x] Cooking-specific Trace tools via AI tool-use (find_recipes_from_pantry,
      add_to_shopping, set_pantry_density, add_to_cookbook,
      import_recipe_from_url, create_recipe, plus every read tool ,
      see src/lib/aiChat.js)
- [ ] Auto-log cooked-recipe → NT diary as a meal entry. Server proxy
      `/api/nt/log-meal` exists; missing the client-side wiring to
      fire it from CookLogDialog

## Phase 6: Recipe-card sharing ✅ DONE (basic + public read)
- [x] `GET /api/recipes/:id/card.png`, server-rendered Pinterest-style
      600×800 SVG with hero image + name + meta + CookTrace watermark.
      Wired into long-press menu Share action.
- [x] Public-recipe variant, `share_token` mint / rotate / revoke,
      `/r/:token` public route + PublicRecipe.svelte, `/api/r/:token`
      endpoint bypasses the setup-required gate (Phase 12)
- [ ] PDF / square / letter alternate templates. Only the SVG
      Pinterest card exists today; no PDF endpoint
- [ ] Public share card, `/api/recipes/:id/card.png` is still
      auth-gated; a `/api/r/:token/card.png` variant would let the
      shared-link recipient render the card without an account

## Phase 7: Importers ✅ DONE
- [x] Mealie JSON export (auto-detected from paste/upload)
- [x] Tandoor JSON export (auto-detected from paste/upload)
- [x] Paprika `.paprikarecipes` archive (zip of gzipped JSON, multi-recipe)
- [x] Saved-HTML upload, same JSON-LD parser as the URL scraper
- [x] Schema.org/Recipe JSON paste
- [x] CookTrace export passthrough
- [x] Plain-text paste fallback (paragraphs become stub steps)
- [x] AI photo import, shipped in Phase 15 (first-class "Import from
      Photo" entry on the Recipes create menu, PhotoImportDialog)
- [ ] (Defer to v2: PDF import via server-side OCR)

## Phase 8: Recipe layout redesign ✅ DONE (small edge cases open)
- [x] Two-column body on ≥960px, ingredients ↔ steps side-by-side, sticky
      ingredients column, mobile stacks
- [x] Hero image no-crop (`object-fit: contain`)
- [x] Print stylesheet, `@media print` + `@page` rules in RecipeView.svelte
- [ ] Sticky ingredients column boundaries (avoid header overlap on
      certain viewport heights)
- [ ] Cook Mode reflow (single-column kitchen view stays; verify on
      narrow tablets in landscape)

## Phase 9: Pantry: nutrition auto-calc ✅ DONE
- [x] Schema: category, serving_size, serving_unit, serving_label,
      nutrition (JSON) on pantry_items
- [x] Edit modal: category dropdown + collapsible nutrition section
- [x] Toolbar: category filter chip row
- [x] Recipe editor: "Auto-calc from pantry" button (volume↔volume,
      weight↔weight conversions)
- [x] Cross-family conversions via per-pantry-row density (`g_per_cup`) ,
      shipped in Phase 15 with `set_pantry_density` Trace tool
- [x] NutriTrace foods → pantry import dialog, shipped as
      SettingsImportFromNT (see Phase 5)
- [x] Recipe view "Recompute" button + "computed from N/M" badge ,
      shipped in Phase 17 alongside the built-in ~70-ingredient
      density lookup table

## Phase 10: Backup + notifications ✅ DONE (scheduler live)
- [x] Server full-backup ZIP (DB + uploads). Create / list / download /
      delete / restore-from-server / upload-restore.
- [x] Settings → Backup & Data UI with all of the above + the JSON
      local-export.
- [x] Push delivery via Apprise / Gotify / ntfy (server-side secrets).
- [x] Settings → Notifications UI: device toggle, push-service config,
      Send-test button, per-reminder toggles.
- [x] Server scheduler (15-min tick) firing cook-day + shopping-nudge
      + weekly-summary + expiration-digest reminders, deduped per user
      per day via `notification_log`.
- [x] Expiration Digest with user-picked delivery time + window
      (1 / 3 / 5 / 7 / 14 days), rolls up every expiring pantry row
      into one push per day. Past-expiry items always included.
- [ ] Thaw alert (needs a recipe-level thaw-24h-ahead signal or NLP
      over ingredients; deferred to avoid false alarms)
- [ ] Native cook-day reminders via Capacitor LocalNotifications
      (mirror notifLocalEnabled toggle)

## Phase 11: Recipe page redesign II ✅ DONE (2026-05-06)
- [x] Recipe categories, `recipe_categories` + `recipes.category_id`,
      twelve seeded chapters per user, manage in Settings → Recipe
      Categories. Pill above recipe title; chip filter row +
      `?category=<slug>` URL state on Recipes list.
- [x] Comments, `recipe_comments` table, flat threading with
      `parent_id` reserved. Edit/delete by author or admin.
- [x] 3-col responsive layout, ≥1280px adds Nutrition column on the
      right (sticky); 960–1279 keeps the existing 2-col with Nutrition
      full-width below; <960 stacks. Notes flow with Steps in the
      middle column on wide screens.
- [x] Kitchen Gear, `tools` data renamed in the UI, lifted out of
      the chip row into its own checklist component (icon-mapped)
      under Ingredients in the left column. Schema.org `tool` field
      now wired through the importer.
- [x] Byline under title, "Added by X · May 4, 2026 · From
      example.com", replaces the standalone Source section.
- [x] "Last Updated" small italic line at the bottom of the page
      (only when `updated_at != created_at`).
- [x] Meta labels: Prep Time / Cook Time / Total Time. "Last Cooked"
      formats with `dateFormat` setting and shows cook count.

## Phase 12: Manage hub + cook timers + sharing + scheduler ✅ DONE
- [x] Master-list Manage hub at /manage with Recipe Categories,
      Tags, Kitchen Gear, Pantry Categories, Units (built-in
      disable + custom CRUD), and Cookbooks editors
- [x] Combobox component, used in RecipeEditor + PantryEditor for
      type-to-filter + inline-create on category, tags, Kitchen Gear
- [x] Cookbooks (regular and smart). Smart cookbooks evaluate a saved
      filter (category + tags + favorites_only + min_rating + max
      total minutes) live on every read.
- [x] Cook timers, global running-timer store with WebAudio chime,
      browser notification, +1 min / Snooze / dismiss, persistent
      across page reload via localStorage. Inline play buttons next
      to detected duration mentions in step text ("30 min", "2 hours",
      "30-45 minutes", etc.). Floating bottom rail on every page.
- [x] Public share links, `recipes.share_token` mint / rotate / revoke
      via long-press menu. Public read at `/r/<token>` works without
      auth, scoped to a single recipe. New `/api/r/:token` endpoint
      bypasses the setup-required gate.
- [x] Server scheduler, 15-min tick that fires cook-day reminders
      (one push per planned recipe per day) and shopping nudges
      (once/day if any item has been sitting unchecked 3+ days).
      `notification_log` table dedupes across ticks.

## Phase 13: Trace AI tool-use + per-user sharing + photo import ✅ DONE
- [x] Trace AI now uses function-calling across all providers
      (Claude, OpenAI, Gemini, OpenAI-compatible). Mirrors the
      NutriTrace + LiftTrace pattern via `src/lib/aiChat.js`.
- [x] Cooking-domain tool catalog: read tools (get_recipes,
      get_recipe, get_pantry, find_recipes_from_pantry, get_diary,
      get_shopping_list, get_cookbooks, get_cookbook), write tools
      (log_cook, plan_cook, add_to_shopping, add_to_pantry,
      set_pantry_stock, add_to_cookbook, create_recipe).
- [x] Image attach in Trace panel, paperclip button, provider-
      specific message format. Powers AI photo import: snap a
      cookbook page, ask Trace to "import this", create_recipe
      tool fires.
- [x] Per-user recipe sharing, `recipe_shares` table with explicit
      grants. New endpoints: /api/recipes/peers,
      /api/recipes/shared-with-me, /api/recipes/:id/shares CRUD.
      Share dialog grew a "Share with Users" checkbox list (each
      tick is an immediate grant/revoke). Recipes page gained a
      "Shared" segment alongside Recipes / Cookbooks; shared cards
      show a "Shared by X" badge.

## Phase 14: Trace voice + URL import + cookbook polish + threading + bundle ✅ DONE
- [x] Trace AI gains a `import_recipe_from_url` tool that wraps the
      existing scrape endpoint. "Import this from <url>" works in chat.
- [x] Voice smart-logging, mic button in the Trace footer toggles
      Web Speech API recording, transcript flows live into the input
      so the user reviews + sends. Tool catalog handles the intent
      (add to pantry, log a cook, search recipes, import from URL,
      create from dictation, etc.).
- [x] Cookbook cover image upload via `cover_image_url` (already on
      the schema). Inline edit shows the cover; tap-to-upload via
      `/api/upload`.
- [x] Cookbook reorder, ↑/↓ buttons on each row in
      ManageCookbooks. Recipes inside a cookbook get ←/→ buttons on
      the card hover (not for smart cookbooks). Bulk PUT endpoints
      `/api/cookbooks/order` + `/api/cookbooks/:id/recipes/order`.
- [x] Threaded comments. Reply button per top-level comment, replies
      render in an indented sub-list under their parent. parent_id
      column was already reserved; no schema change.
- [x] Bundle splitting via `manualChunks` + `wrap()` lazy-loaded
      routes. Initial bundle dropped from 843KB to 392KB
      (uncompressed, 248→118KB gzipped). Manage, Settings, Wizard,
      and PublicRecipe ship as their own chunks.

## Phase 15: Photo import, Cook Mode rail, cross-family, drag-drop, notifications ✅ DONE
- [x] First-class "Import from Photo" entry on the Recipes create
      menu (Phase 7). Standalone PhotoImportDialog runs the same
      Trace tool-use loop with a tight system prompt + create_recipe-
      only catalog, then navigates to the saved recipe.
- [x] Cook Mode embeds the timer rail inline in the cook-mode-bar
      (was floating globally). cookModeActive store hands off
      between App.svelte and RecipeView.
- [x] Cookbook drag-and-drop reorder via native HTML5 DnD,
      alongside the existing ↑/↓ arrows.
- [x] Cookbook bulk ops: per-card Move/Copy button on every recipe
      inside a cookbook detail page, opens a small modal with target
      cookbook picker + Move/Copy radio.
- [x] Comment-reply notifications. New notifyCommentReply helper +
      hook in the comments POST route. New `notifRecipeComments`
      toggle in Settings → Notifications (default on).
- [x] Cross-family unit conversions via per-pantry-row density
      (`g_per_cup`). recipe-nutrition.js gains a convertQty() that
      bridges volume↔weight when the pantry row has g_per_cup set.
      New Trace tool `set_pantry_density` lets users ask Trace to
      backfill densities ("set densities for everything that doesn't
      have one"). Skip badge now hints at "set density to enable".
- [x] aiChat.js exposes onToolResult callback alongside onToolCall
      for callers (PhotoImportDialog uses it to capture the new
      recipe id).

## Phase 16: Email parity ✅ DONE
- [x] SMTP form in Settings → Email (host / port / TLS / user / pass /
      from / Save / Test). Mirrors NutriTrace, respects env-locks.
- [x] Welcome email on user registration (`sendWelcome`, wired into
      /api/auth/register).
- [x] Recipe-shared-with-you email on per-user grant
      (`sendRecipeShared`, wired into /api/recipes/:id/shares POST).
- [x] Invite copy de-NutriTraced ("self-hosted recipe box, pantry
      tracker, and meal planner" instead of nutrition tracker).

## Phase 17: Recompute bundle + weekly summary ✅ DONE
- [x] Built-in density lookup table (~70 common ingredients) in
      recipe-nutrition.js. Used by both the recipe Recompute UI and
      PantryEditor's "Look it up" button.
- [x] RecipeView gains a "Recompute from Pantry" button below the
      FDA box. Surfaces "Computed from N of M ingredients" plus a
      list of skipped entries with their reason. Each skipped row
      that we can fix gets an inline "Set N g/cup" button that
      writes the density and re-runs the calc. "Save This Calculation"
      commits the totals to the recipe.
- [x] PantryEditor gains a Density (g per cup) field next to Serving
      Size, with a "Look it up" button that pulls from the same table.
- [x] Weekly summary email, replaces the Phase A stub with a
      CookTrace-domain implementation: cooks logged, all-time favorite,
      new recipes added, what's planned next 7 days, pantry-out and
      shopping-pending counts. Skips silently when there's no activity.
- [x] Scheduler fires the weekly summary on Sundays 8-9am, deduped
      via notification_log. Honors notifWeeklySummary setting.
- [x] Settings → Notifications gains the Weekly summary toggle
      (default off so dormant users don't get cold-emailed).

## Phase 18: Pantry variants + expiration + recipe total override ✅ DONE (v1.0.0-rc.2)
- [x] Pantry variant hierarchy (Issue #4). `pantry_items.generic_parent_id`
      self-referencing FK. Recipe links point at the generic; each
      variant carries its own barcode / photo / stock / expiry.
      Three-level nesting server-rejected.
- [x] Recipe Nutrition Source picker on the generic
      (`nutrition_source_variant_id`), defaults to the generic's own
      numbers.
- [x] Three-way search classifier: parent-only, parent-expanded,
      variant-standalone (with "Variant of…" subtitle). Fixes
      "greenwise whole milk" and prevents duplicate parent+variant
      cards.
- [x] Variant animate-in / animate-out via CSS keyframes on the
      variant card (bypasses Svelte transitions which don't fire in
      this tree). Two-phase manual collapse. Honors
      prefers-reduced-motion.
- [x] Pantry `expires_on` column + Expiring Soon filter chip + card
      pill (warn / past states).
- [x] Expiration Digest notification. Once-per-day roll-up delivered
      through the same Apprise / Gotify / ntfy pipeline as every
      other reminder. User picks the window and the time of day.
- [x] Recipe `total_minutes` optional manual override (null = auto).
      Importers pick up a distinct Total from Mealie / Paprika /
      schema.org when the source states it.
- [x] Recipe `rest_minutes`, generic hands-off slot covering rise /
      rest / marinate / chill / soak / ferment. Rolls into the
      auto-calc for total_minutes. Tandoor `waiting_time` maps to
      rest; heuristic text parser matches every synonym.
- [x] All recipe times render as `1h 15m` via a shared
      `formatDuration()` helper.
- [x] Android sync fixes: `updatePantryItem` writes only present
      fields; sync order is pull-then-push; server push uses
      `COALESCE` on FK columns; pull orders self-referencing tables
      so parents arrive first; idempotent ALTER migration for the
      new columns.

## Phase 19: Kitchen auto-share + Shared tab + cookbook sharing ✅ DONE (v1.0.0-rc.5)
- [x] Kitchen Auto-Share Your Recipes. Per-user `kitchen_members.auto_share`
      flag. Turning it on backfills every recipe you own into the
      Kitchen; new recipes you create thereafter fan out automatically.
      New members joining later pick up existing auto-sharers'
      recipes.
- [x] Dedicated Shared tab between Recipes and Cookbooks, sourced
      from `GET /api/recipes/shared-with-me`. Each card shows a chip
      for the via-Kitchen source when the grant came through a
      Kitchen (recipe_shares.via_kitchen_id tag).
- [x] Optional "Blend Shared Recipes into Main List" setting under
      Settings → Cooking. Off by default.
- [x] Cookbook sharing. `cookbook_shares` table mirrors
      `recipe_shares` shape (grantee_id, granted_by, granted_at,
      via_kitchen_id). Owner dialog shares to individual users or
      fans out to a whole Kitchen. Shared cookbooks appear in the
      Cookbooks tab with a Shared chip. Recipes inside a shared
      cookbook that the reader hasn't been granted individually
      render as `{ id, name, locked: true }` locked-placeholder
      cards, so cookbook access can't bypass recipe permissions.
- [x] Cookbooks can now contain shared recipes. The
      `POST /api/cookbooks/:id/recipes` accessibility filter now
      accepts recipes the reader can independently access (own or
      granted via recipe_shares), not just their own.
- [x] Leaving or being removed from a Kitchen revokes only incoming
      grants; contributions stay with the remaining members.
      Applies to both recipe_shares and cookbook_shares.
- [x] Full-backup dump + schema-driven restore extended to cover
      `cookbook_shares`, `kitchen_members.auto_share`, and
      `recipe_shares.via_kitchen_id`.
- [x] i18n: merged duplicate `trace` block in en.json that was
      dropping raw keys (`trace.panel_sub`) into the AI panel.

## Smaller follow-ups
- [x] Recipe-import dedup, shipped. `dedup: 'skip' | 'force'`
      parameter on the import endpoint checks case-insensitive name
      and `source_url` matches (see server/routes/recipes.js:963).
- [ ] Native cook-day reminders via Capacitor LocalNotifications.
      src/lib/notifications.js is still a Phase A stub; server-side
      push works, the local-alarm mirror doesn't yet.
- [ ] Thaw alert. Needs a recipe-level thaw-24h-ahead flag or NLP
      over ingredients (raw meat / frozen dough) to fire without
      false alarms.

## Dependency major-version upgrades

Standing policy: only bump majors on CVE, EOL of current major, or
concrete benefit worth the cost. Audit cadence is monthly (see memory
`project_cooktrace_dep_audit.md`). Status as of rc.3:

- ✅ **Svelte 4 → 5**: now on `^5.55.9` (with compat mode
  `runes: false` + `componentApi: 4` per the Trace-family Svelte 5
  rule). Bundled with:
- ✅ **Vite 5 → 7**: now on `^7.3.3`.
- ✅ **`@sveltejs/vite-plugin-svelte` 3 → 6**: now on `^6.2.4`.
- ✅ **Express 4 → 5**: now on `^5.2.1`.
- ✅ **bcryptjs 2 → 3**: now on `^3.0.3`.
- ✅ **nodemailer 8 → 9**: bumped in rc.3 to clear five CVEs.
- ✅ **multer 1.4.5-lts.1 → 2.2.0**: bumped in rc.3 to clear three
  DoS CVEs on the LTS line (which stopped getting patches).
- [ ] **openid-client 5 → 6** (borderline). Complete rewrite,
  cleaner API. Deferred unless iterating on OIDC.
- **Skip**: better-sqlite3 already on 11.x (further bumps need no
  CookTrace-specific reason).

## Planned for v1.1.0

### Full i18n Coverage

Baseline as of v1.0.0 is ~50% coverage: 535 keys in `en.json`, ~500
strings still hardcoded across the 76 `.svelte` files (roughly 346 in
text content + 285 in attributes, minus overlap). Section headers and
some routes are covered; SettingsEmail, SettingsKitchens, cookbook
sharing UI, most dialogs, and most attribute strings (placeholder,
title, aria-label) are not.

Scope:

- Extract every remaining user-facing string into a key
- Extend `en.json` to the full set
- Stub matching keys in `sv.json` so the community translator can fill
- Add a CI lint rule that fails if a new component adds hardcoded
  English (Svelte template `>Some Text<` or `placeholder="Some Text"`
  without a `$_()` wrap), so coverage doesn't backslide after this
  release
- Sizing: 1-2 focused days

Apply the same sweep to LT and NT in their respective v1.1.0 releases
once the CT pattern is proven.

## Out of scope (until requested)
- Multi-database (Postgres etc.), SQLite-only, intentionally
- Built-in barcode scanner (use Pantry add-by-name)
- Native iOS app
