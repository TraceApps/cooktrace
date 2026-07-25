# Deploying CookTrace

## Quick start (Docker Compose)

```bash
git clone https://github.com/traceapps/cooktrace.git
cd cooktrace
cp .env.example .env
# Edit .env, at minimum set JWT_SECRET to a long random value
docker compose up -d
# Open http://localhost:3000
```

## Image tags

Every release publishes a multi-arch (linux/amd64 + linux/arm64) image
under several tags so you can pin to whatever risk level fits:

| Tag | Updates when | Use case |
|-----|--------------|----------|
| `ghcr.io/traceapps/cooktrace:1.0.0` | Never (pinned exact) | Reproducible pin to a specific version |
| `ghcr.io/traceapps/cooktrace:1.0` | Any 1.0.x patch release | Auto-receive bug fixes, no new features |
| `ghcr.io/traceapps/cooktrace:1` | Any 1.x.y minor release | Auto-minor within a major, no breaking |
| `ghcr.io/traceapps/cooktrace:latest` | Every stable release | Absolute latest stable |
| `ghcr.io/traceapps/cooktrace:dev` | Every push to `dev` branch | Leading edge, not for production |

Legacy `1.0.0-rc.N` tags from before the semver switch remain published
indefinitely; anyone pinned to a specific rc release is unaffected.

## Testing pre-release builds

For beta-testing incoming fixes and features before they hit a stable
release:

- **Docker:** switch your compose image to `ghcr.io/traceapps/cooktrace:dev`
  and run `docker compose pull && docker compose up -d`. Rebuilt on
  every push to the `dev` branch.
- **Android APK:** grab the rolling APK from the
  [`dev-latest`](https://github.com/traceapps/cooktrace/releases/tag/dev-latest)
  pre-release. Signed with the same key as stable releases, so it
  upgrades over a stable install in place. Android blocks the reverse
  (dev → stable) without an uninstall, so back up first if you plan
  to switch back.

## Pinning Android to a specific version

Sideloaded APKs don't auto-update the way docker containers do. Every
version has its own APK on the [Releases page](https://github.com/traceapps/cooktrace/releases):

- **[Latest stable](https://github.com/traceapps/cooktrace/releases/latest)** —
  auto-redirects to the newest stable release
- **`/releases/tag/v1.0.0`** (or any version) — exact-version pin,
  won't change
- **`/releases/tag/dev-latest`** — rolling dev channel

To "auto-patch" on Android, redownload from the latest URL whenever
you want to upgrade. Because APKs are signed with the same shared
key across every stable version and dev-latest, in-place upgrade to a
newer version is always allowed. Downgrading requires an uninstall.

## Environment variables

See [.env.example](.env.example) for the full list. Required for any
multi-user deploy:

- `JWT_SECRET` — long random string (64+ chars). Rotating this invalidates
  every existing session.

Recommended:

- `RECOVERY_TOKEN` — used by the login-page lockout-recovery flow.
- `TOKEN_ENC_KEY` — at-rest key for OIDC client secrets. Defaults to a
  key derived from `JWT_SECRET`.

Optional integrations:

- `SMTP_*` — outgoing email for password resets and household invites.
- `OIDC_*` — Single Sign-On via any standard OIDC provider (Authentik,
  Keycloak, Auth0). Multi-provider supported.
- `AI_*` — Trace assistant config (Phase 5+).

## Reverse proxy

CookTrace listens on port 3001 inside the container, exposed on host port
3000 by default. Front with Caddy / Nginx / Traefik on 443.

If hosting at a subpath (e.g. `https://example.com/cooktrace/`), set
`BASE_URL=/cooktrace` in the environment.

## Updating

```bash
docker compose pull
docker compose up -d
```

Always back up `cooktrace.db` before a major version bump.

## Backups

The mounted `${DATA_DB_PATH}` (SQLite database) and `${DATA_UPLOADS_PATH}`
(recipe images) directories should be in your normal backup rotation.
