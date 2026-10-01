# Security audit method

The goal: find what a stranger on the internet can **see** or **do** without signing in, and close
it. Work defensively and against your own property only.

## 1. Route inventory first (the single highest-value step)

Before testing anything, list every server route and its auth guard. For Express:

```
grep -nE 'app\.(get|post|put|delete|patch|all|use)\(' server.ts
```

Make a table: `METHOD /path  →  guard`. Classify each route:

- **Public on purpose** — the sign-up form, a health check, the static site, published government
  figures. Fine to be open.
- **Any signed-in user** — officer workflows, AI calls that cost money. Must require a session.
- **Admin only** — user management, data export, site editing, session revocation. Must require an
  admin session.

The bugs you're hunting: a route that *should* require a session but has no guard, and a route whose
guard is weaker than its blast radius (an admin action behind a plain any-user check). Also check the
**public reads you left open on purpose** are genuinely safe to expose (e.g. a `GET /api/sources`
that returns only public data).

Then write the inventory to a file, one `METHOD /path` per line, and use it as your outsider test
list — every private line must answer 401/403 with no cookie.

## 2. Test as a real outsider

Fetch each private URL with **no cookie** and confirm it refuses. Cover, for each private prefix
(e.g. `/hq`):

- The app's HTML/entry page, its JS/CSS bundles, its source files, any `.map` files, `index.html`.
- Every private API route from the inventory.
- Config and data: `.env`, `/data/*.json`, backup files, anything under the served directory.

**A served directory leaks everything in it.** A build that writes the server bundle (or source
maps) into the same folder the app is served from will serve `/app/server.cjs` and `/app/*.map` to
anyone — which can contain seed passwords, internal emails, API logic. Explicitly 404 those paths,
and check source maps aren't served.

Key truths:
- **Obfuscation/minification ≠ protection.** If the bytes come back, the content is obtained.
- **A secret URL ≠ protection.** Links leak via email, chat, referrers, history. Design as if the
  URL is public (it will be at launch).
- Gate code behind the session: an outsider should get a tiny login page and nothing else; the real
  bundle should 401. Mark the gated app `Cache-Control: private, no-store` so a CDN can't cache it
  and hand it to someone else.

## 3. Sign-in, sessions, cookies, CSRF

- **Session token in an HttpOnly, Secure, SameSite cookie only.** Remove any fallback that reads the
  session from the URL query, request body, or a non-HttpOnly header — URLs end up in logs and
  history, and a readable token defeats HttpOnly. Don't echo the session ID back in any response.
- **Expire sessions server-side**: an idle timeout (e.g. 2 h) and an absolute cap (e.g. 12 h). A
  heartbeat should only count *real* interaction, not the app's own background polling, or an open
  tab never times out.
- **Double-submit CSRF** on every state-changing request: a CSRF value in a JS-readable cookie must
  match an `x-csrf-token` header.
- **Don't reveal who's a user.** Sign-in and "send me a code" must give the *same* reply for a known
  and unknown identity; a wrong password must not name the account. Enumeration is a real leak.
- **Passwords**: hash with scrypt/argon2/bcrypt, never plaintext; require length; reject guessable
  ones. On a platform where the code was ever public, refuse any shipped demo passwords outright.

## 4. Rate limits and the header-trust trap

Per-IP limits only work if you know the real IP. **The trap:** trusting a proxy header like
`CF-Connecting-IP`, `X-Forwarded-For`, or `X-Real-IP` that a client can forge. If the CDN isn't
actually in front yet, an attacker sends the header with a random value per request and every limit
resets — unlimited password guessing, forged entries in your own logs, bypassed IP locks.

- Trust a CDN header **only** when the CDN is genuinely in front AND the origin refuses traffic that
  didn't come through it. Gate it behind an explicit env flag (`TRUST_CLOUDFLARE_HEADER=true`) that's
  off until both are true.
- Know your platform: some edges (e.g. Railway) overwrite `X-Real-IP`/`X-Forwarded-For` with the
  true client IP, so those are safe to read there — but verify, don't assume.
- Add a **global** cap (e.g. 40 failed sign-ins / 15 min across all IPs) so guessing spread over many
  addresses still trips a brake.

**How to test a rate limit (own site, non-destructive):** send the small number of requests the
limit allows to one endpoint until it returns 429, then send one more request with a *forged*
client-IP header. If that one is also 429, the limit holds; if it returns 200, the header bypasses
it. Keep it to a dozen requests to a login or send-code endpoint with deliberately wrong input —
enough to see the 429, not a flood. Do this only against your own site.

## 5. Secrets, git history, and the repo

- `curl -sI` the GitHub repo URL anonymously (or the API) — a 404 means private, 200 means public.
- Scan history for leaked keys/files: `git log --all -p | grep -E 'AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9]{20,}|ghp_|xox[bp]-|BEGIN.*PRIVATE'` and `git log --all --name-only --format= | sort -u | grep -iE 'passw|\.env|credential|\.pem|\.key'`.
- Ensure `.env*`, `data/*.json`, backups, and `Password*.docx`/`~$*` are gitignored. A secrets file
  belongs in a password manager, not on disk next to the code.
- Only the Gemini/API key preview should ever leave the server (first/last 4 chars), never the key.

## 6. Uploads, user text, and injection

- **Media**: strip EXIF/GPS on upload (re-encode with sharp — `.rotate()` then resize/convert bakes
  orientation and drops metadata). Scan published images AND videos for GPS/device data; videos
  often aren't re-encoded, so advise recording with location off. Faces of at-risk people need
  consent or blurring.
- **Uploaded text shown in an admin UI**: render as text, never `innerHTML`/`dangerouslySetInnerHTML`.
  A strict CSP (`script-src 'self'`) blocks injected scripts. CSV exports must neutralise formula
  injection (prefix a cell starting with `= + - @` with `'`).
- **Body size**: a JSON body is parsed *before* the route's auth check, so a blanket 25 MB limit lets
  any stranger make the server read 25 MB per request. Cap public/unauthenticated bodies small (~32
  KB); allow the large limit only for a signed-in user.

## 7. Headers, dependencies, resilience

- Security headers: CSP (lock `script-src` to `'self'` + hashes), HSTS, `X-Content-Type-Options:
  nosniff`, frame protection, `Referrer-Policy`, `Permissions-Policy` (disable camera/mic/geo). Turn
  off `x-powered-by`. Public error responses must not echo server details (file paths, stack traces).
- `npm audit` — but trace whether a flagged dependency is actually reachable before calling it
  critical (a vuln in a script that never runs at runtime isn't exploitable). Pin fixes with
  `overrides`.
- **Safe writes**: write to a temp file then rename over the target, so a crash mid-write can't leave
  a half-written (unreadable) store that then reads as empty and gets overwritten with nothing.
- **Graceful shutdown**: handle SIGTERM/SIGINT, flush in-memory state, exit 0 — on PaaS this stops
  every redeploy showing as "crashed" and prevents cut-off writes.
- **Backups**: snapshot data daily; keep an *encrypted* copy somewhere other than the same volume.
- **Encrypt sensitive data at rest** (names, phone numbers) with AES-256-GCM, key in platform env
  only. If the key is missing, the store should refuse writes rather than silently overwrite.

## Severity and reporting

Rank findings Critical / High / Medium and separate "only the user can do this" (rotate secrets,
enable 2FA on the host/registrar/email, add env vars, legal sign-off). A finding isn't closed until
re-tested against the live site. Keep the running checklist visible to the user.
