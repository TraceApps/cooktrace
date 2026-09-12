# Public REST API

General-purpose REST routes under `/api/v1`, for your own scripts and
automations that want plain JSON over HTTP, rather than the Model
Context Protocol CookTrace also speaks. Off by default. Pull-based, if
you want to be notified the instant something happens instead of
polling, see [outgoing webhooks](webhooks.md).

This is distinct from the NutriTrace federation routes
(`GET /api/v1/recipes`, `GET /api/v1/pantry`): federation is a stable
wire contract for a sister TraceApp and is always on. The routes on
this page (`/api/v1/cook-diary`, `/api/v1/shopping`, and the pantry
stock write route) are for your own personal automation and are gated
behind the flags below.

## Enabling it

Set these in your server environment (see `.env.example`):

```
PUBLIC_API_ENABLED=1        # turns on the read routes below
PUBLIC_API_WRITE_ENABLED=1  # optional, turns on the write routes too
```

## Authentication

Same personal access tokens as MCP and federation: create one in
Settings, API Tokens (admin, multi-user mode only, a token needs a real
account to own it). Send it as a bearer token:

```
Authorization: Bearer ct_pat_...
```

A token's `mcp:read`/`mcp:write` scopes govern both MCP tools and these
routes the same way: a token with `mcp:read` can read via either
interface, `mcp:write` unlocks the write routes on either interface
too. There is no separate REST-only scope to create.

## Rate limiting

Each token is limited to 60 requests per minute by default
(`API_RATE_LIMIT_PER_MIN` to change it). Responses carry
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`; a
`429` response also carries `Retry-After`.

## Errors

A bad request (an invalid date, a recipe id with no match) returns
`400` with `{"error": "..."}`. A missing or invalid token returns
`401`; a token lacking the required scope returns `403`.

## Endpoints

### Read (require `mcp:read`)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/cook-diary?date_from=&date_to=&kind=&limit=` | Cook diary entries (logged and planned cooks), newest first. Optionally bound by a date range or `kind` (`cooked`/`planned`). |
| GET | `/api/v1/shopping?include_checked=` | The current shopping list, unchecked items only by default. |

### Write (require `mcp:write` and `PUBLIC_API_WRITE_ENABLED=1`)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/v1/cook-diary` | `{recipe_id, date?, servings?, notes?, meal_type?, rating?}` | Logs that you cooked a recipe. `recipe_id` comes from the recipes federation endpoint or the app's own search. |
| PATCH | `/api/v1/shopping/:id/check` | `{checked}` | Marks a shopping list item checked or unchecked. |
| PATCH | `/api/v1/pantry/:id/stock` | `{in_stock?, quantity?}` | Updates an existing pantry item's stock state and/or quantity. Does not create new pantry rows. |

Not yet exposed here: creating a recipe, adding a pantry or shopping
item, or deleting a diary/shopping entry. Those stay MCP-only for now
(`create_recipe`, `add_pantry_item`, `add_shopping_item`,
`remove_shopping_item`, `delete_cook_diary_entry` in the MCP setup
guide), since each requires `MCP_DESTROY_ENABLED` plus the
`mcp:destroy` scope plus `confirm: true` on the MCP side, and this
surface has not needed that capability yet.

## Examples

```bash
# Recent cook diary entries
curl -H "Authorization: Bearer ct_pat_..." \
  https://your-cooktrace.example.com/api/v1/cook-diary

# Log a cook
curl -X POST -H "Authorization: Bearer ct_pat_..." -H "Content-Type: application/json" \
  -d '{"recipe_id": 42, "servings": 4}' \
  https://your-cooktrace.example.com/api/v1/cook-diary

# Check off a shopping list item
curl -X PATCH -H "Authorization: Bearer ct_pat_..." -H "Content-Type: application/json" \
  -d '{"checked": true}' \
  https://your-cooktrace.example.com/api/v1/shopping/7/check
```
