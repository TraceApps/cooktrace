# Changelog

All notable changes to CookTrace are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

- **In-app updates.** New Settings → Updates panel checks GitHub Releases for a newer version and, on Android, downloads the signed APK and hands off to the system installer via FileProvider. One primary button drives the whole flow (Check Now → Download & Install → Downloading X%). Skip This Version link when an update's available. Collapsible "What's new" panel below the button renders the release notes inline (markdown) with a "View on GitHub" link. Silent shade notification when the OS notification permission is granted; top-of-app banner as fallback when permission's denied. Opt-in Stable or Dev channels. Same shared TraceApps signing key means Android upgrades in place with no reinstall.
- **Accent-tinted browser chrome.** The browser tab bar / address strip now picks up your current accent color via `<meta name="theme-color">`. Running CookTrace alongside NutriTrace / LiftTrace? Pick a distinct accent per install and the tabs read as visually different at a glance. Favicon stays the branded CookTrace mark.

### Changed

- **SMTP "Username" field relabeled to "Email or Username".** Most SMTP providers want the full email as the username; label change removes the guesswork.

- **Full i18n retrofit across the app.** Every hardcoded UI string has been extracted into `src/i18n/en.json` and reads via `svelte-i18n`. Covers Settings (main page + Backup, Notifications, ServerConnection, Auth, ImportFromNT, Email, Trace, UserManagement, Kitchens, Import, Federation, Nutrition), Pantry (PantryItemSheet + PantryEditor + Pantry + PantryView), Recipes (Recipes + RecipeEditor + RecipeView + CookbookView + PublicRecipe + import/comment/cook dialogs + NutritionFacts), core routes (CookDiary, Shopping, NativeSetup, Login, Wizard, Profile, Manage), manage tables (Cookbooks, Units, Pantry/Recipe Categories, Taxonomy), Trace AI, and shared UI (BarcodeScanner, TimePicker, CookHeatmap, ImagePicker, IconPicker, timer pills, Sidebar). ~460 new keys added, Weblate-ready. Chicago-style title case for labels/buttons/headings, sentence case for body prose / errors / placeholders / toasts. Uses paired `<key>_desc` sibling keys and column-aligned values (Fathom-inspired conventions carried across the TraceApps family) so translators get inline context.

### Fixed

- **App icon no longer shows a white halo.** The bundled icon PNGs had ~15px of solid white padding baked into their corners. On tinted browser chrome the halo was visible around the tab favicon; in-app the icon looked framed. Corners now clear cleanly. Icon URLs also cache-busted with the app version so shipped icon fixes actually take effect without users needing to clear their browser cache.
- **Create Admin form password field no longer crushed** (parity with NT #122). The password input on the Enable User Management form was rendering as a colored sliver because of a flex-layout bug. Password + Confirm now sit symmetrically side-by-side, each with its own eye toggle sharing show/hide state.

---

## [1.0.3] - 2026-07-28

### Fixed

- **Backups, SMTP config, and other admin panels now work in single-user mode.** With User Management turned off, `POST /api/full-backup`, `PUT /api/app-config`, `POST /api/app-config/test-email`, `POST /api/off-local/refresh`, and `GET /api/updates/server-status` all returned 403 "Admin only", even though CookTrace's own frontend correctly identifies the sole owner as effectively-admin. `requireAdmin` middleware now passes through when User Management is off, mirroring `requireAuth`. Fourteen previously-broken admin routes come back to life. LiftTrace already had this fix; parity restored.

---

## [1.0.2] - 2026-07-28

### Added

- **Unified docs site** at [traceapps.github.io/docs/](https://traceapps.github.io/docs/) covering CookTrace, LiftTrace, and NutriTrace in one place. Docker install, OIDC recipes for Authentik / Keycloak / Pocket-ID / Authelia / Google / Auth0, Trace AI setup for every provider, mobile install, backups, troubleshooting, and full per-app feature guides.
- **Documentation badge** in the README hero pointing at the new docs section, plus a transparent-background logo and a jump strip near the top.
- **GPT-5.6 chat parameter support.** When the configured OpenAI model is GPT-5.6 or newer, requests use `max_completion_tokens` + `reasoning_effort` instead of the legacy `max_tokens` shape. Older models are unaffected.

### Fixed

- **Backup JSON export was silently missing 12 tables.** `user_settings`, `ai_chat_history`, `recipe_categories`, `recipe_comments`, `pantry_categories`, `custom_units`, `disabled_units`, `cookbooks`, `recipe_cookbook_links`, `recipe_shares`, `cookbook_shares`, and `kitchens` + `kitchen_members` were not captured by the portable JSON export. Restore now brings everything the ZIP contains.
- **Kitchen-share restore ordering bug.** Restoring a backup nulled out `via_kitchen_id` on every kitchen-fanned share because `kitchens` restored after `recipe_shares` / `cookbook_shares`, triggering the `ON DELETE SET NULL` cascade on the just-inserted rows. Kitchens are now restored first, provenance survives.
- **Gemini AI default bumped** to `gemini-2.5-flash` (was `gemini-1.5-flash`, which Google is retiring). Saved configs that still point at any retired 1.5 / 2.0 ID auto-remap server-side so requests never 404 against a dead endpoint.
- **oai-compat vision requests** (LiteLLM, LM Studio, LocalAI, vLLM) now work end-to-end. Image content is normalized to OpenAI wire shape at the proxy boundary, so strict-schema endpoints stop rejecting requests that mix the internal `{type:'image', dataUrl}` shape with OpenAI's `{type:'image_url', image_url}` shape.
- **README env-var defaults corrected.** `IMPORT_ZIP_MAX_MB` and `BACKUP_UPLOAD_MAX_MB` were misdocumented as `256` and `1024`; both actually default to `512`.

### Changed

- **README restructured** from 491 to 185 lines using a headline-features + docs-links pattern. Deep feature explanations moved to the docs site.
- **Welcome-on-registration email removed** for parity with LiftTrace and NutriTrace. Invited users already received the invite email; self-registered users no longer receive a redundant confirmation. Password reset, invites, and weekly summaries still send.
- **Hybrid dev-release model documented in DEPLOY.md.** Rolling `dev-latest` remains the primary tester channel; occasional milestone `v<version>-dev.N` pre-releases exist for anyone who wants to pin a specific build.

---

## [1.0.1] - 2026-07-25

### Added

- **Origin-country flag on OFF search results in Pantry.** Each Open
  Food Facts result now shows a small flag emoji next to the food name
  when OFF has origin data for it (from `origins_tags`, falling back
  to `manufacturing_places_tags`). Lets you see at a glance whether
  that "olive oil" is Italian, Greek, or Spanish without opening the
  entry. Countries OFF doesn't have origin data for show no flag
  rather than a misleading placeholder.
- **Data-completeness indicator on OFF search results in Pantry.**
  Small colored dot next to each OFF row: green when the entry has
  most nutriment fields filled in, orange for partial, grey for
  sparse. Long-press or hover shows the exact percentage.
- **USDA data-type badge on USDA search results in Pantry.** Small
  color-coded label next to each USDA row (Foundation / SR Legacy /
  Survey / Branded / Experimental) so you can favor curated Foundation
  entries over manufacturer-submitted branded ones for common
  ingredients.
- **Per-source tier filter dropdowns on Pantry search.** A caret next
  to the OFF and USDA source chips opens a checkbox panel to narrow
  results by tier. Defaults to all tiers active; a small dot on the
  source chip signals when a subset is applied. Filter is client-side
  (no extra API calls) and also applies in All-mode and multi-source
  mode.
- **All-mode Pantry search.** New "All" chip fans out to Pantry + OFF
  + USDA in parallel with per-row source badges, so you can compare
  local matches against external DBs in one list.
- **Long-press to combine sources on Pantry search.** Long-press any
  external source chip to pin it alongside another — results become a
  merged multi-source view with per-row source badges (same fan-out as
  All-mode, but limited to your pinned set). Long-press an
  already-pinned chip to remove it. Regular tap exits multi mode back
  to single-source.
- **"Custom…" option on the Model dropdown for Claude, OpenAI, and
  Gemini.** Enter any model ID the vendor supports without waiting for
  the preset list to catch up. Same behavior the OpenAI Compatible
  provider has always had.
- **Retirement remap for retired Gemini models.** Saved selections of
  `gemini-1.5-*` or `gemini-2.0-*` (both retired by Google) are
  quietly upgraded to the current default at request time.
- **SSO-only mode via environment variable.** Set
  `OIDC_ENABLE_EMAIL_PASSWORD_LOGIN=0` (or `false` / `no`) at boot to
  disable password login server-wide, so users must sign in via an
  OIDC provider. Locks the corresponding admin UI toggle with an
  env-lock note. Mirrors the pattern across the TraceApps family
  (asked for on LT #16).
- **Settings search covers new territory:** auto-share, send test,
  cookbook sharing.

### Changed

- **OFF search results in Pantry are now sorted by data quality within
  each fetched page.** Entries with images and more complete nutrition
  data surface higher than sparse ones. OFF's server-side relevance
  still picks the initial batch; the re-rank runs within the batch to
  reduce the "many near-identical variants" search noise.
- **USDA search results in Pantry are now sorted by data-type tier
  within each fetched page.** Foundation and SR Legacy entries surface
  above the millions of Branded entries that would otherwise dominate
  common searches like "chicken" or "milk".
- **Claude model presets refreshed.** Sonnet bumped to Sonnet 5, Opus
  4.8 added as a "smartest" tier option, older Sonnet 4.6 removed.

### Fixed

- **AI Assistant section in Settings would not expand.** The Trace
  settings component ran an initialization block that referenced a
  Svelte `$:` reactive variable before Svelte had a chance to run the
  reactive declaration, throwing `TypeError: Cannot read properties of
  undefined (reading 'includes')` at mount time. That crash left the
  parent `openSections` state half-applied, so tapping the
  section-toggle looked like nothing happened. Fixed by inlining the
  lookup so no reactive dependency is required at init.
- **OIDC sign-in now works on Android first-install for OIDC-only
  servers.** NativeSetup previously required a username + password to
  submit, blocking users on Authentik / Keycloak / Authelia-backed
  servers with password login disabled. The setup form is now a
  two-step flow: enter server URL → app fetches `/api/auth/status` →
  renders whichever auth methods the server actually supports
  (password fields only when enabled, OIDC provider buttons with logos
  when configured, both when both).
- **OIDC callbacks no longer fail on the first attempt** with a
  spurious `callback_failed`. openid-client v5's default 3.5 s
  outgoing HTTP timeout was tight enough that cold token-exchange
  requests to slower IdPs would sometimes time out. Bumped to 10
  seconds.

### Security

- **fast-uri bumped to 3.1.4** (GHSA-4c8g-83qw-93j6, high). ReDoS in
  URI parsing.
- **brace-expansion bumped to 5.0.8** (GHSA-mh99-v99m-4gvg, high). DoS
  via unbounded expansion length.
- **body-parser bumped to 2.3.0** (GHSA-v422-hmwv-36x6, low). DoS when
  an invalid `limit` value silently disables size enforcement.

---

## [1.0.0] - 2026-07-18

Retiring `-rc.N`. This release and every future one uses strict semver
(PATCH for fixes, MINOR for features, MAJOR for breaking). Docker
images now publish under multiple tags (`:1.0.0`, `:1.0`, `:1`,
`:latest`, `:dev`). Existing rc.N image tags stay live indefinitely.

### Added

- **Multi-Tag Docker Publishing.** `:1.0.0` exact, `:1.0` for
  auto-patch, `:1` for auto-minor, `:latest` for absolute latest.
- **`:dev` Docker Tag.** Rolling image built from the `dev` branch.
  Not recommended for production.
- **Send Test Email Dialog.** Settings → Email → Send Test now asks
  where to send the test, pre-filled with your account email.
- **Public Contributor Docs.** New `ARCHITECTURE.md` and `ROADMAP.md`
  at the repo root.

### Changed

- **Retired the `-rc.N` suffix.** CookTrace now follows strict semver.
- **Send Test actually sends an email.** Was verifying SMTP handshake
  only; now sends a branded HTML email so you get end-to-end proof.
- **Email section moved under Admin** (matches NutriTrace and
  LiftTrace).
- **Password field uses a Change button** when the server has a
  stored value, instead of showing fake dots.

### Fixed

- **Recipes on the Android app showed the first-connect date instead
  of the real creation date.** Existing libraries heal on the next
  sync after upgrade.
- **Email settings blank on the Android app.** SMTP form now loads
  from the server correctly on Android server-connected mode.
- **Trace AI chef hat clipped at the top of the FAB.**

### Security

- **adm-zip 0.5.x → 0.6.0** (CVE-2026-39244, high). Crafted ZIP file
  could trigger a 4GB memory allocation during full-backup restore.

---

## [1.0.0-rc.5] - 2026-07-13

### Added

- **Auto-Share with a Kitchen.** Turn on Auto-Share Your Recipes
  in any Kitchen and every recipe you own (past and future) is
  shared with current members automatically. New members who
  join later pick up existing members' recipes too. Great for
  household setups where everyone should see the same library
  without having to share each recipe by hand.
- **Shared Recipes Tab.** A dedicated Shared tab sits between
  Recipes and Cookbooks and lists every recipe others have
  shared with you, directly or via a Kitchen. Each card shows
  a chip for which Kitchen the grant came through, plus a count
  badge on the tab itself.
- **Blend Shared Recipes into Main List (Optional).** Toggle
  under Settings → Cooking. Off by default. On to see your own
  and shared recipes together in the main Recipes tab.
- **Cookbook Sharing.** Share a cookbook with specific users or
  a whole Kitchen. Shared cookbooks appear alongside your own
  with a Shared chip. Recipes inside a shared cookbook that you
  haven't been granted individually appear as a locked
  placeholder, so cookbook access can't be used to bypass
  recipe permissions.
- **Cookbooks Can Hold Shared Recipes.** Previously you could
  only add your own recipes to your cookbooks. Now anything
  someone else has shared with you can be organized into your
  cookbooks the same way.

### Changed

- **Leaving a Kitchen Leaves Your Contributions Behind.** If
  you leave or are removed from a Kitchen, recipes and
  cookbooks you shared into it stay with the remaining members.
  Only incoming grants (things others shared with you via that
  Kitchen) are revoked.

### Fixed

- **Trace AI panel raw keys.** A duplicate `trace` block in the
  English translation file was silently dropped by the JSON
  parser, so several AI-panel labels rendered as their raw key
  (e.g. `trace.panel_sub`). Merged and de-duped.

---

## [1.0.0-rc.4] - 2026-07-10

### Added

- **AI Base URL support in env-locked mode.** Self-hosters who run
  their LLM on a private Docker network (Ollama, LM Studio,
  LocalAI, or any OpenAI-compatible endpoint) can now proxy Trace
  chat through the server via `AI_BASE_URL`. Previously the
  OpenAI-compatible flow ran client-only, meaning the browser had
  to reach the LLM directly, awkward when the LLM lives on a
  private network the browser can't see. `AI_PROVIDER=oai-compat`
  plus `AI_BASE_URL=http://ollama:11434` in `.env` now works
  end-to-end.

### Fixed

- **Kitchens created on the PWA now appear on the Android app.**
  Same class of bug also affected the pending invites list, users
  list, share peers, session config, and the Mealie / Tandoor /
  Paprika ZIP import — all silently returned empty on Android in
  server-connected mode because the local API layer was catching
  those calls before they could reach the server.
- **Pending invites populate correctly.** The User Management
  section's data-load hook was orphaned, so opening Settings →
  Users showed empty state even when invites had been created.
  Fires on section open now.
- **Full-backup restore no longer silently drops recipe columns.**
  Restore was using hardcoded INSERT column lists — any column
  added by later ALTER migrations (`rest_minutes`, `total_minutes`,
  `category_id`, `share_token`, `video_url`) would silently vanish
  on restore. Now schema-driven so future ALTER TABLE additions
  are automatically covered.

---

## [1.0.0-rc.3] - 2026-07-05

### Added

- **Shopping List Aisle Grouping.** The list can now group by aisle
  in addition to by recipe or flat. Every pantry category picks up
  an optional Default Aisle label (Produce, Dairy, Bakery, whatever
  your store calls it); anything added to the shopping list from a
  linked pantry row inherits that aisle automatically. A chip row
  at the top of the list toggles between By Aisle, By Recipe, and
  Flat. The choice sticks per user across devices.
- **Change Aisle Per Item.** Long-press a shopping row and pick a
  known aisle from a chip list or type a fresh label. Custom aisles
  work as their own groups without any pantry-category setup, write
  "Freezer" once and it becomes a group.
- **Drag to Reorder Shopping Items.** Grab a row's handle to
  reorder within a group. Cross-group drops in By Aisle mode
  reassign the moved item's aisle to match where you dropped it,
  so shuffling the list is the same gesture as reclassifying an
  item.
- **Hide Checked Items Toggle.** New Shopping List section under
  Settings → Cooking. Choose Sink to Bottom (default; items stay
  visible so you can uncheck by mistake) or Hide (items disappear
  from view with a one-tap "Show N Checked" toggle in the status
  bar).
- **AI Scan Label for Pantry Nutrition.** Take a photo of a
  nutrition label from the pantry item editor and Trace extracts
  name, brand, serving size, and every nutrient it can read.
  Complementary to the existing barcode scanner: barcode looks up
  Open Food Facts for name-brand products, label scan handles
  store-brand jars, homemade batches, and imports OFF doesn't
  cover. Requires an AI provider configured in Settings.
- **Per-Row Edit on Shopping Rows.** Long-press any row for Edit,
  Change Aisle, or Delete. Edit opens a modal for name, quantity,
  and unit so refining items after add is a two-tap loop.

### Changed

- **Simplified Shopping Quick-Add.** The primary add row is now
  name plus optional qty plus a labeled Add pill, matching Google
  Keep, Bring!, AnyList, and OurGroceries. Unit moved to the
  per-row Edit modal so a "milk, eggs, bread" sweep is
  name-tap-Add-repeat, not three fields per item. The Add pill
  carries a real text label so it's visible in portrait at every
  phone size.
- **Consolidated Bulk-Add into a + Menu.** The header shrinks to
  two buttons: Share and a single + button. Tapping + opens an
  action sheet with Add from Recipe and Add from Planned Cooks,
  each with a proper label instead of a bare icon.
- **"Add from Meal Plan" Renamed to "Add from Planned Cooks".**
  Matches the Diary's language everywhere else (Plan a Cook,
  Planned tag).
- **Recipe Editor Ingredient Rows on Mobile.** The three per-row
  action buttons (link to pantry, section divider, delete) collapse
  behind a single kebab menu on small screens so the ingredient
  name field has room to read. Adding a note is one tap in the
  kebab; the note appears on a second inline row. Small indicator
  icons on the row signal what's stashed behind the menu. Desktop
  layout is unchanged.
- **Multi-Select on Pantry and Recipes.** Enter selection mode from
  the long-press menu on any item. The header title flips to "N
  Selected" and the top-right buttons become trash + cancel on
  Pantry, or trash + add-to-cookbook + cancel on Recipes. Matches
  NutriTrace's pattern. Replaces the old floating action pill.
- **Recipe Editor Landscape on Phone.** Ingredients and Steps stay
  stacked when a phone rotates to landscape. The two-column view
  only kicks in on tablet-landscape widths and up, so the fields
  no longer get crushed on the pivot.

### Fixed

- Cook Mode reliably keeps the screen awake on Android. The Web
  Wake Lock path silently stopped working on some Android WebView
  versions; the Android app now uses the native `KeepAwake`
  plugin. PWA continues to use the Web Wake Lock API.
- Cook photos taken during a diary log render immediately on the
  Diary Photos tab. Older photos still render via a backstop
  conversion.
- Bulk-add from a recipe or planned cook populates each row's
  aisle from the linked pantry item's category, so items land
  pre-grouped instead of piling into Uncategorized.
- Long-pressing a Shopping row no longer lets you drag it while
  the action menu is open. The finger-hold that opened the menu
  was still feeding pointer moves into the reorder tracker.
- Cancel out of Pantry multi-select no longer leaves an invisible
  layer blocking taps until reload.
- The Shopping quick-add box no longer freezes the app on mobile
  when the pantry has hundreds of items. The suggestion list is
  now capped so Android WebView doesn't try to render every pantry
  row at once.

### Security

- **Dependency Security Updates.** Bumped `multer` 1.4.5-lts.1 →
  2.2.0 (patches three high-severity DoS CVEs on the LTS line),
  `nodemailer` 8.0.7 → 9.0.3 (patches five CVEs including a TLS
  OAuth certificate-validation bypass and CRLF header injection),
  and `vite` 7.3.3 → 7.3.6 (dev-only, patches a `server.fs.deny`
  bypass on Windows). Package overrides pull `esbuild` forward to
  ^0.25.0 to clear a dev-server CORS advisory nested under
  svelte-i18n. Clears every actionable Dependabot alert. No
  user-facing changes; self-hosters running Docker just need to
  pull the new image.

---

## [1.0.0-rc.2] - 2026-07-02

### Added

- **Pantry Variants.** A pantry row can now carry brand-specific
  rows underneath it. Recipes link to the parent (Whole Milk); each
  variant (Greenwise, Publix) has its own barcode, photo, stock,
  and expiration date. Add Variant with inline suggestions: type
  a brand and existing pantry items surface as tap-to-attach chips.
  Delete of a parent with variants asks whether to keep the variants
  as standalone items (default, safer) or remove them together.
- **Recipe Nutrition Source on the Parent.** A generic pantry item
  can either use its own nutrition numbers (default) or pull from
  one of its variants, so recipe math reflects the label of the
  product you actually cook with.
- **Pantry Expiration Dates.** Every pantry row gains an Expires On
  field with an in-sheet calendar picker. Amber pill on cards for
  anything expiring within two weeks, red for past. Expiring Soon
  filter chip surfaces the whole set in one tap. Variant expiries
  surface as chips inside the parent sheet's Variants list.
- **Expiration Digest Notification.** Once-a-day roll-up covering
  everything expiring within a chosen window (1 / 3 / 5 / 7 / 14
  days), delivered at a chosen time. Push goes out through Apprise,
  Gotify, or ntfy plus the local device channel. Past-expiry items
  always included regardless of window. Settings → Notifications →
  Reminders → Expiration Digest.
- **Rest Time Field on Recipes.** Any hands-off period, bread rise,
  meat rest, dough chill, marinate, soak, ferment. Left blank stays
  hidden on the recipe view; set adds a Rest meta pill next to Prep
  and Cook. Rolls into the auto-calculated Total Time below.
- **Total Time Manual Override.** Optional field in the recipe
  editor. Leave blank and the app auto-calculates from prep + cook
  + rest; set a value and it wins. Placeholder shows the auto-calc
  live so you see the fallback before overriding.
- **Clear Link on the Category Picker.** A small Clear link appears
  in the pantry item's Category label when a category is set,
  wiping the selection in one tap.
- **New Preserves Recipe Category.** Jams, pickles, curds,
  chutneys, ferments, canning recipes, none of which fit cleanly
  under Sauce, Bread, or Dessert. Added to the default seeded
  chapter list with a berry / pomegranate color that reads clearly
  distinct from Bread. Existing accounts keep their category list
  untouched; only fresh installs get the new default automatically
  (add it in Settings → Recipe Categories if you want it on an
  existing account).
- **Animated Variant Expand and Collapse.** Chevron rotates
  smoothly on the parent card, variant cards drop in from above
  with a spring easing on expand, slide back up on collapse.
  Honors OS-level reduce-motion preferences.
- **Import Cookbook.** A single multi-recipe PDF (a whole cookbook,
  a printed booklet, a folder of scanned recipe pages) can now
  import as multiple recipes in one pass. The AI parser splits the
  file into individual recipes, previews each, you pick which to
  save. (Issue #2 phase 3)
- **Bulk File Import.** Pick a folder or a ZIP archive of recipe
  files and import everything in one go. Per-file preview and
  dedup before commit. (Issue #2 phase 2)
- **Hybrid File Import.** PDF, RTF, TXT, and Markdown files import
  through a heuristic parser first (fast, no AI cost); the AI
  parser catches anything the heuristic can't structure. Both
  paths land in the same preview + edit flow.
- **Batch URL Import.** Paste a list of recipe URLs and import them
  all in one pass. Scanned PDFs and image-only pages route through
  an AI vision fallback so they parse instead of failing silently.
- **Use Camera Shortcut in File Import.** Snap a photo of a
  handwritten recipe card or a printed page directly from the
  import dialog, alongside the file picker.
- **Swedish Translation.** Contributed by @olsson82 via PR #3.
  Switch in Settings → Regional & Units → Language. Coverage is
  what @olsson82 translated at PR time: primarily the auth flows
  (Login, Register, Reset Password, Accept Invite, Profile),
  User Management, sidebar labels, and a couple of common UI
  components. The rest of the app went through an i18n
  instrumentation pass this release so a much larger set of
  strings (bottom nav, main-route titles, empty states, Settings
  section headers, Recipe view labels, Recipe editor fields,
  Pantry item sheet, Trace welcome) is now extractable and
  registered under English keys. Those newly-extracted keys
  fall through to English for Swedish users until a Swedish
  speaker translates them in a follow-up PR — we didn't want
  to put in-house wording into @olsson82's file. A pull request
  filling in the remaining sv.json entries is warmly welcome.
- **Language Picker.** Regional & Units gains a Language dropdown
  populated from the registered locale list, so Swedish (and any
  future translation) is actually reachable from the UI. The
  translation existed in PR #3, but the picker to select it was
  never wired.

### Changed

- **Animated Page Banners.** The illustrated SVG headers on
  Recipes, Pantry, Diary, Shopping, and Settings are retired in
  favor of four animated background styles picked in Settings →
  Appearance: Shimmer (subtle sweep, default), Drift (slow
  horizontal float), Pulse (color breathe), and Aurora (Northern
  Lights sweep). All four honor the OS's reduce-motion preference.
- **Import Menu Collapsed.** URL and File imports used to be two
  separate top-level entries; they now sit under a single Import
  entry that expands to show both sub-options. Same functionality,
  cleaner surface.
- **Password Rule Hints for Autofill.** Password inputs on the
  wizard, register, reset, and profile screens now declare their
  requirements via the `passwordrules` attribute, so iOS and
  Chrome autofill generate a password that actually passes CookTrace's
  8-plus-mixed-plus-symbol check instead of one that gets rejected.
- **Recipe Category Colors Tightened.** Snack, Sauce, and the new
  Preserves each moved off crowded hue bands so the chip row scans
  cleanly at a glance. Snack shifted from yellow to teal (was too
  close to Breakfast's amber), Sauce shifted from violet to indigo
  (was too close to Appetizer's purple), and Preserves sits at
  berry / pomegranate rather than rust (was too close to Bread).
  Existing accounts keep their current colors; only fresh installs
  get the new palette.
- **Recipe Times Show Hours and Minutes.** Every recipe-time display
  now reads in hours and minutes instead of raw minutes. A 75-minute
  recipe shows as `1h 15m` on list cards, detail view, cookbook
  cards, public share pages, the shareable card, and the
  file-import preview. The editor input still takes raw minutes.
- **Smart Pantry Search Under Variants.** Query the parent name and
  you get the parent card alone. Query only a variant's brand and
  you get that variant alone with a "Variant of Whole Milk"
  subtitle, no duplicate parent. Query both and the parent expands
  with the matching variant nested underneath.
- **Expires On Uses the In-Sheet Calendar Picker.** Matches every
  other date entry in the app instead of the browser's default
  `mm/dd/yyyy` widget.
- **Tandoor Imports: `waiting_time` Maps to Rest.** Tandoor's
  waiting_time is a hands-off signal by convention, so it lands in
  Rest Time instead of Cook Time. Working_time still maps to Prep.
  Cook stays null on Tandoor imports; the auto-calculated Total
  covers everything correctly.
- **Native Pantry Updates Only Write Fields the Payload Carries.**
  A stock toggle no longer rewrites brand, category, or FK columns
  as a side effect. Prevents unrelated data from getting nulled
  on partial edits.

### Fixed

- **Pantry Stock Toggle No Longer Crashes on Native.** The
  top-right quick-toggle on any pantry card threw "NOT NULL
  constraint failed: pantry_items.name" because the partial update
  was writing every column with undefined placeholders. Only
  present fields get written now.
- **Variant Relationships Survive Mobile Edits.** Setting Greenwise
  as a variant of Whole Milk on the PWA now stays set on the phone
  through unrelated stock toggles, quantity bumps, and brand edits.
  Was silently reverting because the sync order was push-then-pull,
  so a stale local row propagated back to the server before the
  server's fresher state pulled down. Order is pull-then-push now,
  and the server preserves FK columns via COALESCE when the client
  sends NULL.
- **`[object Object]` Category Pill on Mobile.** The category pill
  on the pantry sheet was rendering the raw category object rather
  than its name on Android. Native queries now join the category
  the same way the PWA server does.
- **Category Casing Mismatch Between PWA and Mobile.** "Dairy &
  eggs" on Android vs "Dairy & Eggs" on the PWA. The pill now
  reads the live category row instead of falling into a hardcoded
  slug-to-label map with older casing.
- **Dropdown Menus Close on Outside Scroll.** Combobox dropdowns
  portaled to the body layer were blocking wheel and touchmove
  events from reaching the sheet underneath, so scrolling the page
  while a dropdown was open did nothing. Outside scroll now closes
  the dropdown and lets the scroll through.
- **Confirm Dialogs Stack Correctly Over the Sheet.** "Remove from
  pantry?" and similar confirms were rendering behind the item's
  own edit surface, making the buttons invisible.
- **Native DB Init Survives Upgrades.** A pantry index creation
  ran against an old schema on first launch after an APK upgrade
  and blocked the whole database from initializing. Moved the
  index into the migration that adds the column so it runs after
  the ALTER.
- **Trace AI Provider Fields Are Read-Only After Save.** Once an
  AI provider config is saved in Settings → Trace, the API key
  and Base URL fields lock so you can't accidentally overwrite
  them by tapping through the form. Editing requires an explicit
  Change toggle. (Issue #5)
- **Animated Banner Sticky Pinning.** The animated header was
  picking up an explicit `position: sticky` that broke pinning on
  Recipes, Pantry, Diary, Shopping, and Settings. The redundant
  declaration is dropped and the sticky wrapper handles the
  pinning cleanly.
- **Recipe Editor Dropdowns Are Scrollable Again.** Opening the
  Category, Tags, or Kitchen Gear picker in the recipe editor was
  capping the list at eight items, so anything past the eighth
  entry could only be reached by typing to filter. The cap is
  removed so the whole catalog is browseable via the popover's
  own scroll.

---

## v1.0.0-rc.1 (2026-06-07)

First public release candidate. Brings the dev branch to feature
completeness and parity with the wider TraceApps family (NutriTrace,
LiftTrace), then layers polish, dependency upgrades, and the Android
local-mode build that lets CookTrace run standalone on a phone
without a server.

### Android app — standalone or server-connected
- **First-launch wizard** offers Use Locally (pure offline, on-device
  SQLite) or Connect to Server (URL + login). Mode is switchable later
  in Settings, with a merge dialog when bringing existing local data
  to a server for the first time.
- **Differential sync engine** with 30-second background timer +
  visibilitychange resume. Push pending writes, pull recent changes,
  surface real failure messages in the sync banner.
- **Offline image cache**: sync downloads every server image to the
  device so recipe / pantry / diary thumbnails render without a
  connection. Cache filenames are hashed so cross-product collisions
  on OpenFoodFacts URLs no longer overwrite each other.
- **Native barcode scanning** via ML Kit. Capacitor 8 base. Shared
  TraceApps release keystore so reinstalling between dev and release
  builds doesn't wipe local data.

### Recipe importers
- **Mealie**, **Tandoor**, **Paprika** export-zip importers with
  per-recipe selection, dedup, and category / tag carryover.
- **Mealie timeline import**: pulls cook-event history (with photos
  and notes), backdates recipe created_at to the original add date,
  matches cook events to your existing recipes.
- Drag-and-drop file picker, scan + commit two-step flow.

### NutriTrace federation
- **Smart View on OFF / Share to OFF dual button** in the pantry item
  editor. When the barcode already exists on Open Food Facts, the
  button switches to "View on OFF" and opens the product page; when
  it doesn't, the button uploads the local row and reports back with a
  verify status row ("Confirmed live on Open Food Facts" / "Submitted,
  may take a few minutes to appear").
- **Persistent Connected pill** in Settings → NutriTrace federation so
  you can see at a glance whether the integration is working without
  re-running the test.
- **OFF nutriment _modifier filter**: values OFF flags as algorithmic
  estimates (rather than label-derived facts) no longer get imported
  as real measured values.
- **UPC-A → EAN-13 canonical-form normalization** in the OFF lookup so
  12-digit scans hit the same product as their 13-digit equivalents.

### Trace AI assistant
- **Hold-to-record voice on the FAB** for hands-free Smart Log. Hold
  the FAB to start recording (haptic + beep), release to send to the
  AI, slide your finger >100px away to cancel mid-recording. Status
  pill above the FAB shows the gesture state ("Listening… Release to
  Send" / "✕ Release to Cancel").
- **Chat panel** now slides up as a full-width mobile bottom sheet
  with a drag handle, dimmed backdrop, and rounded top corners.
  Desktop keeps the floating-card layout, anchored bottom-right.
- **Always-visible Clear Chat button** in the panel header (was
  hidden when there were no messages).
- **In-chat mic button removed** for parity with NutriTrace and
  LiftTrace — voice now lives only on the FAB hold gesture.

### Nutrition Facts box
- **FDA-correct sodium placement**: sodium moves up into the macros
  block (between Cholesterol and Total Carbohydrate) where it belongs
  on a real food label, rather than sitting under Protein in its own
  rule.
- **Servings per recipe** line added above the Serving Size, matching
  the "Servings Per Container" pattern on packaging.
- **Per-serving grams when computable**: the Serving Size line shows
  `~85g` instead of `1 of 8` when every ingredient in the recipe
  resolves to a known weight or density. Otherwise it falls back to
  `1 of N` or `Per serving`.

### Pantry item editor (single unified surface)
- **Slide-up sheet** is now the single editor for every pantry-item
  flow (view, edit, create, barcode scan). The full-page editor is
  retired from the navigation surface.
- **Inline edit**: view-mode fields flip to inputs in place within the
  same two-column grid so the surface doesn't change shape.
- **Header actions** (Edit / Delete in view, Cancel / Save in edit)
  sit as icon buttons in the top right of the sheet, mirroring
  RecipeView's chrome pattern. Red Close + Delete + Cancel, green
  Save.
- **In Stock derives from quantity** — `quantity === 0` reads as out
  of stock, `null` or `> 0` reads as in stock. The explicit toggle
  was retired. Items you keep but never count (salt, oil) stay in
  stock without needing a number.

### Appearance + chrome
- **Trace Every Recipe — From Pantry to Plate**: new tagline across
  the README, sidebar, About card, Wizard welcome, and PWA manifest.
- **Gradient page-header banner** as a middle option between Animated
  and Off. New users land on Gradient as the default; existing users
  keep whatever they had.
- **Compact page header** when banners are off — saves ~40px on
  every page without the illustrated SVG.
- **"You're All Set" Wizard celebration** before landing on the
  Recipes tab — trophy icon + confetti, ~1.8s beat. Honors
  prefers-reduced-motion.
- **Title case sweep** across UI chrome: relative times ("3 Days
  Ago"), heatmap stats ("117 Cooks · 80 Active Days"), recipe header
  ("Last Cooked", "Cooked N Times"), nutrition box ("Servings Per
  Recipe").
- **Native number-input spinner buttons hidden** globally — every
  number input across the app renders without the up/down arrows.
- **40×40 page-header action buttons** standardized across routes to
  match the floating menu button. No more mixed 30/34/40 px sizing.

### Scheduled backups
- **Auto-backup**: schedule full backups daily, weekly, or monthly on
  the server side, plus a local-mode equivalent on Android. Optional
  retention window auto-prunes older snapshots.
- **Backup error toasts** when the list fetch fails (was a silent
  empty list).

### OIDC SSO
- **RP-initiated logout** on PWA and Android — signing out of
  CookTrace also signs you out of the identity provider when the
  provider supports the end-session endpoint.

### Dependency upgrades
- **Svelte 4 → 5** with the `runes: false` + `compatibility.componentApi: 4`
  compat shim. Same component API, smaller runtime.
- **Vite 5 → 7** + **vite-plugin-pwa 0.19 → 1.3**.
- **Express 4 → 5** with the new `path-to-regexp` v8 wildcard syntax.
- **bcryptjs 2 → 3** (ESM).
- **nodemailer 8.0.3 → 8.0.7**.

### Diagnostics
- **Image cache URL hashing** — fixes a collision bug where two
  OpenFoodFacts products whose URLs end with the same filename
  (`front_en.4.400.jpg`) would overwrite each other in the local
  cache and display each other's pictures.
- **Log + crash file share via Directory.Cache** so the receiving app
  (Drive, Files, Solid Explorer) actually gets the file contents
  instead of the share-intent's title text.

## v0.11.0-beta.1 (2026-05-11)

Polish and power pass across every primary surface. Diary, Recipes,
Pantry, Shopping, Manage, and the share flow all picked up real
features without changing the underlying shape of the app.

### Diary v2
- **Meal-type slots** on planned and logged cooks (breakfast, lunch,
  dinner, snack) with a chip picker in the planner and the log dialog
- **Per-cook rating** separate from the recipe's overall rating, so
  one bad attempt doesn't drag down a five-star recipe
- **Stats card** at the top with This Week, Current Streak, Longest
  Streak, and Most Cooked This Month. Current-streak has a grace
  window so today not being cooked yet doesn't reset the run
- **Cook activity heatmap**: GitHub-style contribution graph over
  the last year, sized to fill the card on desktop and horizontally
  scrollable on phones. Click a cell to jump the Month view there
- **Photos view**: chronological tile grid of every cook photo, with
  rating and multi-photo indicators. The lightbox pages between
  siblings on multi-photo cooks
- **Filter by recipe**: chip and picker apply across List, Month,
  and Photos. Dedicated empty state when the filter has no matches
  in the visible range
- **Dashboard layout on wide screens**: heatmap and stats card go
  side-by-side at 1280px and above instead of stacking, freeing
  screen room for the actual entries

### Sharing
- **Recipe card** moved from a server-rendered URL to a client-side
  PNG attached to the share sheet. Works fully offline, every
  recipient gets a real image inline regardless of channel
- **Full recipe content** on the card (hero, title, ingredients,
  numbered steps) instead of a teaser image. Plain-text version
  rides along in the share text body so Mail, SMS, and iMessage
  carry the recipe too
- **Pagination for long recipes**: one PNG per page (about 1500px
  tall max) so nothing gets cut off, and the share sheet receives
  all pages when the platform supports multi-file sharing
- **Shopping list card**: same client-side aesthetic as the recipe
  card, plus a Share as Text option for plain clipboard / SMS use
- **Brand mark** in every share-card footer next to the wordmark
- **Recipe View share icon** in the header so you don't have to back
  out to the list and long-press to share what you're reading
- **Desktop multi-page download fix**: staggered downloads so
  Chromium delivers every page after the user approves the prompt

### Pantry
- **Expiration dates** UI on items: date picker in the editor, an
  amber or red banner on the list when anything is within seven
  days (or already past), and a per-card expiry pill
- **Recipe usage pill** ("Used in N") on every card, with the count
  computed via a single ingredient-scan pass
- **Sort menu** in the toolbar: A to Z, Last Updated, Most Used,
  Expires Soon. Non-default sorts flatten the category grouping
  so the order isn't fighting the structure

### Shopping
- **Add from Meal Plan** bulk-imports the ingredients from every
  planned cook in a date range. Dedupes by name and unit (summing
  quantities when both sides have one), honours the existing
  "only missing from pantry" filter
- **Share** action in the header with image or plain-text options

### Recipes
- **Bulk Add to Cookbook** from the multi-select toolbar so a batch
  of recipes lands in a cookbook in one operation

### Manage hub
- **Usage badges** on Recipe Categories, Pantry Categories, and
  Units (in addition to Tags and Kitchen Gear, which already had
  them). Mint pill when in use, dim border-only pill when zero,
  so stale taxonomies stand out
- **Material Symbols icon picker** for Pantry Categories: visual
  grid with search instead of typing icon names from memory
- **Drag-reorder** on Recipe and Pantry Categories matching the
  existing Cookbooks pattern

### Micro-interactions
- **Heart pop** on the recipe favorite toggle and **star pop** on
  per-cook ratings: small scale-up-and-settle keyframes that
  honour `prefers-reduced-motion`

## v0.10.0-beta.1 — first beta (2026-05-08)

First beta tag on the dev repo. Everything from the build-out plus
the polish phases (1–11) is shipped, end-to-end, and documented.
README is a complete tour. No public release repo yet.

### What landed since v0.1.0-dev
- **Importers** — URL scrape, paste/upload (txt, JSON, JSON-LD,
  schema.org), and Mealie / Tandoor / Paprika export-zip flows
- **NutriTrace federation** — proxy + Settings UI + connectivity test;
  ingredient food-link picker; cooked-recipe → NT diary log
- **Recipe view polish** — sticky search, sticky save bar in editor,
  drag-reorder for ingredients AND steps, step text markdown
  formatting, print stylesheet, recipe-card SVG share, route
  transitions, category color stripe along card edge
- **Pantry polish** — slide-up sheet with in-place edit, inline
  nutrient cards with FDA-style %DV, sub-sheet for linked recipes,
  inline cross-family unit converter (~250-entry density catalog),
  cookbook fraction typography
- **Recipe extras** — categories with color, comments (rich-text,
  bold/italic/lists), cookbooks collections, recipe sharing,
  kitchens, kitchen gear field
- **Trace AI** — persistent chat history per user with rate limiting,
  multi-provider config (OpenAI / Anthropic / Gemini / Ollama)
- **Backup audit** — full-backup now captures recipe_categories,
  recipe_comments, pantry_categories, custom_units, disabled_units,
  cookbooks, recipe_cookbook_links, recipe_shares, kitchens,
  kitchen_members in addition to core tables
- **i18n sweep** — 442-key en.json, zero missing keys

## v0.1.0-dev — full app build-out (2026-05-04)

CookTrace went from an empty shell to a feature-complete recipe app
across a single intensive day of dev work. Every tab is real, every
Slice 1–2 item is shipped, and Phases 3–6 of the roadmap are in.

### Recipes
- Full recipe model: name, description, hero image, **rating (★)**,
  **favorite (♥)**, **yield text** (e.g. "12 cookies"), prep / cook
  minutes, default servings, **scaling chips** (×0.5/×1/×2/×3) plus a
  custom serving input
- **Ingredient groups** — Mealie-style sections like "Sauce" or
  "Dough"; default is one unnamed group rendering as a flat list
- Steps support an **optional summary** rendering as "Step 1: Preheat
  Oven" when filled
- **FDA-style Nutrition Facts box** between Steps and Notes — full
  nutriment catalog (31 fields), sub-row indenting, %DV column,
  vitamins/minerals separated by a thick rule. Sodium ↔ salt
  auto-derives via the EU regulatory factor with a calculator-icon
  badge on the derived row
- **Cook history** list (date / notes / photo / edit / delete) below
  the box once you've cooked it at least once
- "I cooked this" opens a **Cook Log dialog** (date picker + notes +
  photo) rather than a one-click log
- **Cook Mode** — "Start cooking" button requests Screen Wake Lock,
  enlarges body text, persists ingredient + step checkboxes per
  recipe in localStorage so a stove interruption doesn't lose your
  place. Sticky banner with Reset Checks + Exit
- **Long-press / right-click** any recipe card → context menu: Open ·
  Favorite · Plan a cook · Add to shopping list · Duplicate · Share
  card · Delete

### Recipes list cards
- Hero image, favorite-heart overlay, 5-star rating row, time +
  serves + last-cooked + **pantry-match pill** (color-coded full /
  partial / none — counts ingredients you have in stock)
- Search, action-sheet "+" with four import paths (Manual · URL ·
  Paste/upload · Photo when Trace AI is configured)

### Pantry
- Real CRUD page replacing the stub: alphabetical list with in-stock
  toggle (optimistic), search, filter chips (All / In stock / Out),
  Add modal with name + quantity + unit (UnitPicker) + notes +
  optional image. 36×36 thumbnail in the list row.
- **Auto-populates from recipe saves** — every ingredient name you
  use in a recipe becomes a pantry row (case-insensitive dedup, "Flour"
  + "flour" share one entry). Recipe ingredient → `pantry_item_id`
  links happen server-side in a single transaction on save.
- "X / Y in pantry" pill on every recipe card, computed server-side
  from the user's in-stock set.

### Diary (Phase 3)
- Two views: **List** (60d back / 30d forward, grouped by date with
  Planned/Past separators) and **Month** (calendar grid with pill
  entries per day, today ringed in accent color)
- **Plan-a-cook** modal: date picker + searchable recipe picker → one
  click writes a `kind=planned` cook_diary row
- Each entry: clickable thumbnail navigates to the recipe; "Cooked"
  button on planned entries one-taps the conversion; delete on every row

### Shopping (Phase 4)
- Quick-add row at the top: name + quantity + UnitPicker + add
- Items grouped by aisle (Other pinned bottom), checkboxes per row
  with optimistic toggle + revert-on-error
- "X remaining · Y checked" status bar with bulk Clear-Checked action
- **"Add from recipe"** opens a modal with searchable recipe picker
  + "only add what's missing from pantry" toggle (default on). One
  tap pulls the missing ingredients onto the list with their quantity
  + unit + pantry_id link
- Empty state CTA points at the same flow

### URL recipe scraper (Phase 4)
- POST `/api/recipes/scrape` fetches any URL, parses
  schema.org/Recipe JSON-LD, normalises into our shape (handles @graph
  nesting, HowToSection trees, ISO 8601 durations, all standard
  nutrition fields, keyword splitting), then runs through the regular
  create flow so pantry-linking + sodium/salt derivation apply.
- SSRF-guarded: http(s)-only, blocks loopback + private IP ranges,
  8s timeout, 5MB cap, identifies as CookTrace via User-Agent.
- Wired into the "+" menu URL import dialog.

### Recipe-card share (Phase 6)
- GET `/api/recipes/:id/card.png` returns a server-rendered
  Pinterest-style 600×800 SVG (hero image with bottom-fade overlay,
  word-wrapped name, time/serves/yield subtitle, COOKTRACE
  watermark). Renders correctly in browsers, Slack, Discord, iMessage
  link previews. Wired into the long-press menu Share action via
  navigator.share / clipboard fallback.

### NutriTrace federation (Phase 5)
- Settings → "NutriTrace federation" section: URL + access-token
  fields, show/hide on the token, **Test** button (proxies through
  the server to NT `/api/auth/me`), enable toggle (gated on
  URL+token).
- `/api/nt/test`, `/api/nt/foods`, `/api/nt/log-meal` server proxy —
  bearer token never leaves the server.
- Foundation ready; auto-log-cooked-to-NT-diary + Pantry NT food
  picker land as consumer wiring tickets next.

### Trace AI assistant (Phase 5)
- Floating chat FAB on every page (gradient circle with the TraceFace
  mascot) — only renders when AI is enabled in Settings.
- Slide-up chat panel with conversation history, "thinking" dots,
  refresh-to-clear, multi-line input that submits on Enter.
- Settings → Trace Assistant: enable toggle, assistant name, provider
  dropdown (Claude / OpenAI / Gemini / OpenAI-compatible), API key
  with show/hide, custom base URL when "OpenAI-compat" is picked,
  model dropdown / freeform field, **Test** button. envLocks.ai
  disables the key field when AI is configured server-side via env
  vars.
- Server proxy at `/api/ai/chat` was already in place — Trace.svelte
  just calls it. API key never reaches the WebView.

### Ingredient unit picker
- Replaced the previous datalist with a full **UnitPicker** combobox.
  37 cooking units in 5 categories (Volume US, Volume Metric, Weight
  US, Weight Metric, Count / descriptive). Click opens for browse
  (shows everything regardless of saved value); type to switch into
  search mode and filter. Free-text fallback for splash / drizzle /
  to taste / etc. Custom units configurable via a `customUnits`
  setting (Setting UI to pick coming).

### Image picker (Slice 2D)
- `ImagePicker.svelte` — three buttons (Camera / Upload / URL), ghost
  styling, capped 420px-wide centered preview. Camera works on PWA
  via `getUserMedia` (in-page popup with capture button) and on
  Capacitor via `@capacitor/camera`. Wired into RecipeEditor,
  CookLogDialog, and Pantry edit modal.

### Settings (refactored to NT-uniform)
- Every section is now collapsible (chevron toggles, slide
  animation, closed by default). Header: accent-colored material
  icon in a rounded square.
- Theme is a `<select>` dropdown ("System default" / "Dark" /
  "Light"). Navigation style + measurement system also dropdowns.
- 12 named accent presets (Mint, Blue, Red, Purple, Orange, Teal,
  Pink, Yellow, Indigo, Lime, Rose, Cyan) plus a custom-color swatch
  with conic-gradient rainbow.
- **Custom color picker sheet** — live colored preview with hex
  readout, Hue slider, Saturation slider (gradient updates as
  hue/lightness change), Lightness slider, RGB inputs (R / G / B
  three-up), Hex input with color dot. All math copied verbatim from
  NutriTrace.
- New sections: **Nutrition** (visible-nutriments picker — checkbox
  per nutriment grouped by category, defaults / show-all buttons),
  **NutriTrace federation**, **Trace Assistant** (real config),
  **Notifications** (still placeholder for cook-day reminders).

### Internationalization
- **Energy unit** — independent setting (Calories / Kilojoules), not
  tied to measurement system. Most metric countries (UK / EU / Canada)
  still default to kcal; AU / NZ use kJ. Stored values always stay in
  kcal — switching is display-only (1 kcal = 4.184 kJ).
- **Wizard locale auto-detect** — `navigator.language` seeds the
  defaults: `en-AU` / `en-NZ` → kJ + metric, `en-US` → kcal + imperial,
  everyone else → kcal + metric. Fully overridable in Settings.
- **Trace AI prompt** — system prompt tells the assistant the user's
  preferred measurement system + energy unit so its responses come back
  in the right units on the first try (no "convert this for me"
  round-trip).

### Other
- `feedback_dev_versioning.md` honored — no version bump.
- `cheerio` added to server dependencies for the URL scraper.
- Banner: open stockpot with rising animated steam (no lid, no
  bubbles, no chef-hat).

## v0.1.0-dev.0 — Foundation fork (2026-05-03)

Initial CookTrace fork from NutriTrace v1.0.0-rc.14. Carries over the auth,
OIDC SSO, settings sync, sidebar/bottom-nav layout, Capacitor shell, and
Docker deploy stack. NutriTrace-specific food/diary/wellness/Fitbit/Garmin/
Withings/Mealie code stripped; CookTrace recipe/pantry/cook-diary/shopping
schema added (empty stubs in this version — feature work follows in Phase 1+).

This release is a runnable empty shell suitable for further development.
Nothing is end-user usable yet.
