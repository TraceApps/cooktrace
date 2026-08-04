# Deploying CookTrace

## Quick start (Docker Compose)

```bash
git clone https://github.com/traceapps/cooktrace.git
cd cooktrace
cp .env.example .env
# Edit .env, at minimum set JWT_SECRET to a long random value
docker compose up -d
# Open http://localhost:3001
```

## Image tags

Every release publishes a multi-arch (linux/amd64 + linux/arm64) image to
**two registries** with an identical tag set. GHCR is primary; Docker Hub
is a discoverability mirror. Both are first-class; pick whichever fits.

- **`ghcr.io/traceapps/cooktrace`** (primary)
- **`traceapps/cooktrace`** on [Docker Hub](https://hub.docker.com/r/traceapps/cooktrace) (mirror)

Pin to whatever risk level fits (examples below use GHCR; swap the prefix
for Docker Hub if preferred):

| Tag | Updates when | Use case |
|-----|--------------|----------|
| `ghcr.io/traceapps/cooktrace:1.0.0` | Never (pinned exact) | Reproducible pin to a specific version |
| `ghcr.io/traceapps/cooktrace:1.0` | Any 1.0.x patch release | Auto-receive bug fixes, no new features |
| `ghcr.io/traceapps/cooktrace:1` | Any 1.x.y minor release | Auto-minor within a major, no breaking |
| `ghcr.io/traceapps/cooktrace:latest` | Every stable release | Absolute latest stable |
| `ghcr.io/traceapps/cooktrace:dev` | Every push to `dev` branch | Leading edge, not for production |

Legacy `1.0.0-rc.N` tags from before the semver switch remain published
indefinitely on GHCR; anyone pinned to a specific rc release is unaffected.
Docker Hub mirroring started post-1.0, so it only carries stable-era tags.

## Testing pre-release builds

Two mechanisms cover pre-release testing between stable releases.

### `dev-latest` (rolling, primary)

Every dev-worthy build refreshes the [`dev-latest`](https://github.com/traceapps/cooktrace/releases/tag/dev-latest) GitHub pre-release. The APK is signed with the same keystore as stable releases, so it upgrades in place. Same guarantees as the Docker `:dev` tag, which auto-publishes on every push to `dev`. This is the default channel for testers who want "always the newest thing."

### Milestone `v<version>-devNN` (occasional, pinnable)

When a specific feature or fix is worth its own tester milestone (a new AI capability, a wearable integration, a big backup change), a numbered pre-release gets cut: `v1.0.4-dev01`, `v1.1.0-dev01`, etc. These get their own permanent GH release, their own tester-facing notes, and their own Docker tag (`ghcr.io/traceapps/cooktrace:1.0.4-dev01`) alongside `:dev`. `dev-latest` is refreshed to point at the same commit.

Iteration numbers are zero-padded two digits for 1 through 9 (`dev01`, `dev02`, …, `dev09`) and natural two digits from 10 onward (`dev10`, `dev11`, …). No dot between `dev` and the number. That keeps the identifier inside SemVer 2.0.0 §9 and gives correct lex ordering everywhere (GitHub Tags, `gh release list`, Docker Hub).

Use numbered dev builds when reporting bugs ("I saw this on `v1.1.0-dev02`") or if you want to install a specific milestone and stay on it. Everyone else, `dev-latest` covers you.

Both channels use the shared TraceApps keystore, so upgrading between them (or from either back to stable) works in place.

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
3001 by default (sits between NutriTrace's 3000 and LiftTrace's 3002 for a
clean 3000/3001/3002 sequence across the family). Front with Caddy / Nginx
/ Traefik on 443.

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
