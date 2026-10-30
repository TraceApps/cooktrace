# Deploying CookTrace

## Quick start (Docker Compose)

```bash
git clone https://github.com/traceapps/cooktrace.git
cd cooktrace
cp .env.example .env
# Edit .env, at minimum set JWT_SECRET to a long random value
docker compose up -d
# Open http://localhost:3003
```

Opening the app from another device at a plain `http://` address (a LAN IP, an Unraid WebUI link)? Signing in only sticks over HTTPS, or with `INSECURE_COOKIES=1` on a trusted LAN; the sign-in and setup screens say so. `http://localhost` on the server itself works in Chrome and Firefox either way. See [Plain-HTTP LAN](https://traceapps.github.io/docs/getting-started/lan-http/).

## Image tags

Every release publishes a multi-arch (linux/amd64 + linux/arm64) image to
**two registries** with an identical tag set. GHCR is primary; Docker Hub
is a discoverability mirror. Both are first-class; pick whichever fits.

- **`ghcr.io/traceapps/cooktrace`** (primary)
- **`traceapps/cooktrace`** on [Docker Hub](https://hub.docker.com/r/traceapps/cooktrace) (mirror)

Two tags are published (examples below use GHCR; swap the prefix for
Docker Hub if preferred):

| Tag | Updates when | Use case |
|-----|--------------|----------|
| `ghcr.io/traceapps/cooktrace:latest` | Every stable release | Running the app |
| `ghcr.io/traceapps/cooktrace:dev` | Every push to `dev` branch | Leading edge, not for production |

There are no version-number tags (`:1`, `:1.4`, `:1.4.0`); the ones published
for the first releases stopped updating and were retired. To hold a server on
one exact build, pin it by digest
(`ghcr.io/traceapps/cooktrace@sha256:...`; `docker inspect --format
'{{index .RepoDigests 0}}' ghcr.io/traceapps/cooktrace:latest` prints the one you run).

## Testing pre-release builds

Two mechanisms cover pre-release testing between stable releases.

### `dev-latest` (rolling, primary)

Every dev-worthy build refreshes the [`dev-latest`](https://github.com/traceapps/cooktrace/releases/tag/dev-latest) GitHub pre-release. The APK is signed with the same keystore as stable releases, so it upgrades in place. Same guarantees as the Docker `:dev` tag, which auto-publishes on every push to `dev`. This is the default channel for testers who want "always the newest thing."

### Milestone `v<version>-devNN` (occasional, pinnable)

When a specific feature or fix is worth its own tester milestone (a new AI capability, a wearable integration, a big backup change), a numbered pre-release gets cut: `v1.0.4-dev01`, `v1.1.0-dev01`, etc. These get their own permanent GH release, their own tester-facing notes, but no Docker tag of their own: the server side of a milestone is the `:dev` image. `dev-latest` is refreshed to point at the same commit.

Iteration numbers are zero-padded two digits for 1 through 9 (`dev01`, `dev02`, …, `dev09`) and natural two digits from 10 onward (`dev10`, `dev11`, …). No dot between `dev` and the number. That keeps the identifier inside SemVer 2.0.0 §9 and gives correct lex ordering everywhere (GitHub Tags, `gh release list`).

Use numbered dev builds when reporting bugs ("I saw this on `v1.1.0-dev02`") or if you want to install a specific milestone and stay on it. Everyone else, `dev-latest` covers you.

Both channels use the shared TraceApps keystore, so upgrading between them (or from either back to stable) works in place.

## Connecting from Android

The Android app connects to your CookTrace server over HTTPS, or over plain HTTP to a server on your own network. Local mode (no server) needs neither. For HTTPS (a real domain with Let's Encrypt, a tunnel, or your own CA installed on the phone), see [HTTPS on your LAN](https://traceapps.github.io/docs/self-hosting/lan-https/).

Enter the `http://` address, such as `http://192.168.1.20:3003`. The app first asks **Connect Without Encryption?**: the connection isn't encrypted, and anyone on the same network can read and change what's sent, including your password. Use it only on your home network or over a VPN. Choose **Connect Anyway** and the app remembers the answer for that server. Settings > Server Connection then shows **Not Encrypted** under the address.

Plain HTTP works only with a server at one of these addresses:

- a private IPv4 address: `10.x.x.x`, `172.16.x.x` to `172.31.x.x`, `192.168.x.x`;
- a Tailscale address (`100.64.x.x` to `100.127.x.x`), loopback `127.x.x.x` or link-local `169.254.x.x`;
- an IPv6 unique local (`fc00::/7`), link-local (`fe80::/10`) or `::1` address;
- a one-word name, such as `http://cooktrace:3003`;
- a name ending in `.local`, `.home.arpa`, `.internal` or `.lan`.

Any other `http://` address (a public domain or IP) is refused before the app sends anything, and the app points to the HTTPS options. Over a VPN such as Tailscale or WireGuard, the tunnel already encrypts the traffic.

`INSECURE_COOKIES` makes no difference to the app: it signs in with a token, not the cookie. Set it only if browsers also open CookTrace over plain HTTP.

The Wear OS app uses plain HTTP only to the server the phone confirmed, and gets that with the server address the next time the phone app opens. Everything else the app and the watch reach directly (update checks, push services, AI providers, pictures from elsewhere) is still HTTPS-only, as before.

Coming from a build that allowed plain HTTP without asking (a debug build you built yourself)? On first start the app asks the same question before it contacts the server. Until you choose Connect Anyway it works with what's on the phone, nothing syncs, and it asks again on the next start. A saved `http://` server that isn't on your own network is refused the same way; to switch it to an HTTPS address, disconnect in Settings > Server Connection and connect again.

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

- `RECOVERY_TOKEN`: Locked Out? on the sign-in page. It resets two-step
  sign-in for one account (16 characters or more for this) or disables user
  management. See [Two-step sign-in](#two-step-sign-in).
- `TWO_STEP_KEY`: the key that locks two-step sign-in secrets, kept apart
  from `JWT_SECRET`. Unset, CookTrace makes `two-step.key` next to the
  database (the `/data/db` volume) the first time someone sets up two-step
  sign-in. Set it (or `TWO_STEP_KEY_FILE`, 32 characters or more) only to
  keep it outside the data folder. If it changes or is lost, codes from
  authenticator apps stop working until reset; recovery codes still sign in.
- `OIDC_APP_LINK_TOKEN`: `off` refuses single sign-on from Android builds
  that take their sign-in in the deep link (from before the one-time code).
  On by default. See [Sessions](#sessions).
- `TOKEN_ENC_KEY` — at-rest key for OIDC client secrets. Defaults to a
  key derived from `JWT_SECRET`.
- `PUBLIC_URL`: the full address people open the app at, subpath included
  (e.g. `https://recipes.example.com`). Links in password reset, invite,
  recipe sharing and weekly summary emails use it. Unset, they use an
  address an admin has opened the app at; until an admin has opened it once,
  only an admin's own request sends an email. Never taken from request
  headers, so a forged Host can't point a reset link at someone else's site.
  It's also the app's own address for two security checks: the one web
  address besides the Android app's that may call the API with your sign-in
  (CORS), and the address changes are accepted from when your reverse proxy
  passes neither the public `Host` nor `X-Forwarded-Host` (otherwise changes
  from a browser are refused with 403 `cross_site`).
- `FRAME_ANCESTORS`: addresses allowed to show CookTrace inside a frame, several separated by spaces or commas (`https://*.example.com` covers a whole domain). By default only CookTrace itself may, so no other site can frame it to trick a click. If you show CookTrace inside a dashboard (Homarr, Organizr, Home Assistant), set it to the dashboard's address, or CookTrace shows blank there.

Only for plain HTTP:

- `INSECURE_COOKIES`: Set `1` to send the sign-in cookie over plain HTTP too. The cookie is HTTPS-only by default, so at a plain `http://` address other than `localhost` (a LAN IP, an Unraid WebUI link) the browser drops it and signing in loops back to the sign-in page; the sign-in and setup screens say so. Use `1` only on a trusted LAN, and leave it `0` behind HTTPS. See [Plain-HTTP LAN](https://traceapps.github.io/docs/getting-started/lan-http/).

Optional integrations:

- `SMTP_*` — outgoing email for password resets and household invites.
- `OIDC_*` — Single Sign-On via any standard OIDC provider (Authentik,
  Keycloak, Auth0). Multi-provider supported.
- `AI_*` — Trace assistant config (Phase 5+).

- `PUBLIC_API_ENABLED` / `PUBLIC_API_WRITE_ENABLED`: general-purpose REST routes for your own scripts and automations. See `docs/public-api.md`.
- `WEBHOOKS_ENABLED` / `ALLOW_PRIVATE_WEBHOOK_URLS`: outgoing webhooks. See `docs/webhooks.md`.

## Two-step sign-in

People who sign in with a password can turn on two-step sign-in in Settings > Profile: after the password, CookTrace asks for a 6-digit code from an authenticator app. Their secrets are locked with `two-step.key` in the database folder (or `TWO_STEP_KEY`), never stored in the clear; recovery codes are kept only as hashes. Back up the key file with the database: a backup restored on a server with another key keeps everyone's recovery codes working, but codes from authenticator apps can't be checked until two-step sign-in is reset.

Getting back in, always for one account and never with SQL:

1. **A recovery code**, on the sign-in page (Use a Recovery Code).
2. **An admin**: Settings > Users, the person's Reset Two-Step Sign-In button. The admin gives their own password (and their own code when they use two-step sign-in), and can't reset their own this way.
3. **The owner**: Locked Out? on the sign-in page, with `RECOVERY_TOKEN` (16 characters or more) and the username. Or on the server:

   ```bash
   docker exec -it cooktrace npm run reset-2fa -- <username>
   ```

   Run it with no username to list the accounts that have two-step sign-in on.

Every reset is logged, and the person is emailed when the server sends email. Single sign-on never links itself by email (Auto-Link) to an account that uses two-step sign-in, or that must set it up; a provider linked to an account before is trusted to do its own two-step sign-in. Linking a provider from Profile asks for the password (and code) first, and finishes only in the browser it started in; an email changed in Profile waits for the same check before single sign-on links by it or a password reset goes to it. Admins can require two-step sign-in for everyone in Settings > Users: anyone who signs in with a password sets it up right after their password. Single sign-on accounts, API tokens and saved sign-ins (biometric unlock) are unchanged.

## Sessions

A sign-in lasts until it expires (Settings > Users > Session Duration, up to a year) or until the account signs its sessions out. Changing the password (in Profile, with an emailed reset link, or by an admin), turning two-step sign-in on or off, any reset of it, and **Sign Out Everywhere** in Settings > Profile sign out every browser, phone and watch signed in to the account. The device that made the change stays signed in. The others go to the sign-in page, which says they were signed out, and anything they saved offline waits there and goes up at the next sign-in. A paired watch signs in again with the phone: it keeps what it logged, and takes the phone's new sign-in the next time the phone is opened. Sessions from before this keep working until one of those happens.

API tokens and MCP tokens are separate credentials: none of this signs them out, and each has its own Revoke in Settings > API Tokens. Creating a token asks for the password (and the two-step code when that's on); an account that signs in with single sign-on only must have signed in within the last 15 minutes. A token can expire after 30 days, 90 days or a year, or never; tokens made before this keep working.

The Android app finishes single sign-on with a one-time code that only it can swap for its sign-in. Android builds from before that code get their sign-in in the deep link itself (`cooktrace://oidc-callback`), which another app on the phone could catch. They still sign in, and the server log says so each time; set `OIDC_APP_LINK_TOKEN=off` to refuse them (they're told to update CookTrace). Off will become the default after the next main release.

## Reverse proxy

CookTrace listens on port 3003 inside the container, exposed on host port
3003 by default (family port sequence is NutriTrace 3001, LiftTrace 3002,
CookTrace 3003, NoteTrace 3004, all avoiding the common `:3000` default).
Front with Caddy / Nginx / Traefik on 443. Upgrading from before 1.3.0,
when the container listened on 3001? See [Updating](#updating).

If hosting at a subpath (e.g. `https://example.com/cooktrace/`), set
`BASE_URL=/cooktrace` in the environment.

**A sign-in proxy in front (an Authentik or Authelia outpost, VoidAuth, Cloudflare
Access):** the Android app can't get past its login page, and says so
("something other than CookTrace answered with a web page"). Let `/api/*`
through to CookTrace without the proxy's sign-in (CookTrace checks every
request itself), and keep the proxy for the web pages if you like. Single
Sign-On still works in the app through CookTrace's own OIDC (`OIDC_*` above),
which can use the same provider. The same message also shows when the address
in the app isn't the server's (a wrong subpath, for one).

## Updating

```bash
docker compose pull
docker compose up -d
```

Always back up `cooktrace.db` before a major version bump.

**Upgrading to 1.3.0 or later from an earlier version:** the container now
listens on `3003` instead of `3001`. Change the right-hand side of your
compose mapping from `"3003:3001"` to `"3003:3003"`, and point any reverse
proxy that talks to the container directly (`cooktrace:3001`, a Traefik
`loadbalancer.server.port` label) at `3003`. If you set `PORT` yourself, nothing
changes.

## Backups

The mounted `${DATA_DB_PATH}` (SQLite database) and `${DATA_UPLOADS_PATH}`
(recipe images) directories should be in your normal backup rotation.
