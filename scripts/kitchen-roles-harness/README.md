# Kitchen roles harness

Drives the real `kitchens`, `recipes` and `cookbooks` routers over HTTP
against an in-memory database, to check who may do what once a member is
a Sous Chef. It exists because `better-sqlite3` has no prebuilt binding
in every dev environment, and because the `scripts/*.test.js` suite is
static text analysis that cannot answer "does a demoted member actually
get a 403".

It is not part of `npm test`: it needs `node:sqlite` (Node 22+) and the
server's own `express`, so run it from `server/`:

```bash
cd server
node --import ../scripts/kitchen-roles-harness/register.mjs \
             ../scripts/kitchen-roles-harness/run.mjs
```

Every case prints PASS or FAIL and the process exits non-zero if any
failed. The module hooks swap `db.js` for a `node:sqlite` shim and stub
the modules the routes import but these paths never use (mail, push,
scrapers, image handling).
