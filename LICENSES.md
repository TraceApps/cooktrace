# Licenses & Data Sources

CookTrace's source code is licensed under [AGPL-3.0](LICENSE). Some of the integrations and data sources it can talk to are covered by separate licenses. This file lists them so operators and contributors know what applies to what.

## Code

- **CookTrace**: AGPL-3.0 (see [LICENSE](LICENSE)). Applies to the entire codebase in this repository including the Android app source.

## Data sources

CookTrace does not bundle any food or recipe database inside the Docker image. All external data is either created by the user or queried live from the source's own public endpoint.

| Source                       | License                          | How CookTrace uses it                                                                                                                                    |
| ---------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Open Food Facts**          | [ODbL 1.0][odbl]                 | Live queries against the OFF public API (search-a-licious). Only foods the user actually searches are cached locally in that user's SQLite.              |
| **USDA FoodData Central**    | Public Domain (US Government)    | Live queries with the user's own [api.data.gov][usda] key. No license restrictions.                                                                      |
| **Mealie** (per user)        | User-owned; Mealie itself is AGPL-3.0 | Live queries against the user's own Mealie instance (user provides URL + API token). Bulk recipe import via `.zip` drop.                            |
| **Paprika**                  | User's own recipes               | Bulk import via `.paprikarecipes` (zip) export. CookTrace acts only as an importer.                                                                     |
| **Tandoor**                  | User's own recipes               | Bulk import via Tandoor's JSON export. CookTrace acts only as an importer.                                                                              |
| **recipe-scrapers (URL)**    | Library: [MIT][rs-mit]; scraped content: source website's | User pastes a public web URL; CookTrace one-shot scrapes schema.org/Recipe JSON-LD (or falls through to the `recipe-scrapers` Python library if `PYTHON_BIN` is configured). |
| **Local Recipes and Pantry** | Owned by the self-hoster         | Created via the app UI, photo dictation, or bulk JSON/CSV import.                                                                                        |

[odbl]: https://opendatacommons.org/licenses/odbl/1-0/
[usda]: https://api.data.gov/
[rs-mit]: https://github.com/hhursev/recipe-scrapers/blob/main/LICENSE

## Notes for operators

### Open Food Facts (ODbL 1.0)

Individual per-request records are queried on demand. Only a small per-user cache of foods actually searched accumulates in each user's local SQLite. No substantial derived database is redistributed by CookTrace, so ODbL's share-alike terms don't apply to the default configuration.

If a future release introduces a local OFF mirror (as NutriTrace has), operators running a multi-user or public CookTrace instance with the mirror enabled would inherit OFF's ODbL obligations for that operation. Not applicable today.

### USDA FoodData Central

Public domain data from the US Department of Agriculture. No attribution is legally required, but it's still nice to mention.

### Mealie

Each user brings their own Mealie instance and API token. The recipes and data pulled from Mealie belong to whoever owns that Mealie instance. CookTrace acts only as a client.

### Paprika and Tandoor imports

The user exports from their own account and drops the file into CookTrace's bulk-import flow. The recipes remain owned by the original author (the user, or whoever authored the recipe on the source site). CookTrace does not phone home or redistribute them.

### recipe-scrapers (URL imports)

The [`recipe-scrapers`][rs] Python library is MIT-licensed. The recipe content it scrapes belongs to the source website; the user is expected to comply with each source's own terms of use when importing.

[rs]: https://github.com/hhursev/recipe-scrapers

## Third-party code dependencies

Bundled Node.js dependencies (Express, better-sqlite3, Svelte, Capacitor plugins, etc.) each carry their own permissive licenses (MIT / Apache-2.0 / BSD variants). See `package.json` and `server/package.json` for the full dependency lists; run `npm ls --long` or `npx license-checker` in either directory for machine-readable output.

## Questions

If any of the above needs clarification or you spot something worth correcting, open an issue on the [GitHub repository][repo] and it'll get looked at.

[repo]: https://github.com/TraceApps/cooktrace/issues
