---
name: site-hardening-and-speed
description: >-
  A repeatable method for auditing and fixing a small web app's SECURITY, SPEED, and PRIVACY/cookie
  compliance — built for a Node/Express server that also serves a static public site and a gated
  React SPA, but the method generalises. Use this whenever the user wants to harden a site, do a
  security pass or audit, "make sure nothing is exposed", lock down endpoints, run Lighthouse or
  improve a performance/LCP/Core Web Vitals score, review what data the site collects, add or fix a
  cookie banner or privacy notice, or get a site "launch-ready" — even if they only mention one of
  these. Prefer this over ad-hoc fixes: it tests as a real outsider, measures with Lighthouse
  directly instead of trusting a pasted report, and batches deploys. Also use it when the user pastes
  a security-audit or Lighthouse/DevTools report and wants it acted on — verify each claim against the
  code first; audit tools routinely report stale or hallucinated issues.
---

# Hardening, speed, and privacy for a small web app

This skill captures a method proven on a live campaign site: an Express server that serves a static
public site at `/` and a gated React SPA at `/hq`, data kept in JSON files, deployed on a platform
that redeploys on every git push. Adapt the specifics; keep the method.

## The one rule that saves you

**Verify before you act, test as a real outsider, measure don't guess.** Three habits:

1. **Audit reports lie.** When the user pastes a security or Lighthouse report, or an AI tool's
   findings, treat every claim as unverified. Check it against the actual code or a live request
   first. A large fraction of pasted findings are stale (already fixed) or hallucinated. Fixing a
   phantom wastes effort and can add risk.
2. **"Can anyone see X?" is answered by fetching X with no cookie, not by reasoning.** Obfuscation
   and minification are not protection. A hard-to-guess URL is not protection. If a stranger's
   request returns the bytes, it's exposed. See `references/security-audit.md`.
3. **Browser-enforced behaviour needs a real browser.** CSP, cookies, auth gates, cache headers,
   LCP — curl and reasoning miss what the browser actually does. Drive headless Chrome (puppeteer)
   or run Lighthouse. See `references/speed.md`.

## Workflow

1. **Scope.** Confirm the stack, where it's deployed, and which of the three tracks the user wants:
   security, speed, privacy/cookies — or all three for a launch. Confirm you're working on the
   user's own site (this method tests your own property only).
2. **Inventory, then audit.** For security, list every route and its auth guard first
   (`references/security-audit.md` → "Route inventory"). For speed, run Lighthouse to get a baseline
   (`scripts/lighthouse.mjs`, or `scripts/report.mjs` for the combined security+speed+a11y check with
   a shareable output). For privacy, list what the site actually collects and what it sets in the
   browser (`references/privacy-cookies-us.md`).
3. **Close the loop in the repo — this is the step a standalone scanner can't do, and it's the
   actual value of running this as a skill instead of pasting a Lighthouse/PageSpeed report.** Naming
   the offending file and its byte savings is table stakes; every scanner already does that. For each
   high/medium finding that names a resource (performance findings carry an `urls` list in
   `report.mjs`'s JSON output), `grep`/search the repo for where it's referenced — the `<img>` tag,
   the `import`, the server middleware setting (or not setting) the header — read the surrounding
   code, and either:
   - **apply the fix directly**: compress/resize the actual image file in place and update the
     reference, add the missing header to the actual server config, add `srcset`/`width`/`height`/
     `loading`/`fetchpriority` to the actual `<img>` tag, minify/defer the actual script tag; or
   - if it's a judgment call the user should see first (a redesign, a dependency swap, anything with
     a visible tradeoff), **say exactly which file and line** and propose the specific diff — not "run
     a compressor on this file," but "here's the compressed replacement, here's the one-line `srcset`
     change in `src/components/Hero.tsx:42`."
   A report that stops at naming the file is advice the user still has to go act on themselves; tracing
   it into their actual code and fixing or proposing the exact change is what they can't get from
   Lighthouse, PageSpeed Insights, or GTmetrix, because none of those tools can see their source.
4. **Fix in batches, not one-at-a-time.** If the platform redeploys on every push (Railway, Render,
   Fly, most PaaS), each push restarts the site and interrupts users — many small pushes in a day
   look like repeated crashing. Group related fixes into one commit, test locally, push once.
5. **Re-test against the live site after the deploy.** The fix isn't done until the outsider probe,
   the Lighthouse run, or the browser check passes against production, not just locally.
6. **Keep a running checklist** the user can see — what's fixed-and-verified, what's open, and what
   only the user can do (rotate secrets, enable 2FA, add env vars, legal sign-off). Mark severity.

## The three tracks

Read the matching reference file before working a track; each has the concrete patterns and the
pitfalls that are easy to miss.

- **Security** → `references/security-audit.md`. Outsider testing, the route-inventory method,
  session/cookie/CSRF patterns, rate-limit and header-trust pitfalls (a forgeable `CF-Connecting-IP`
  is a real bypass), secrets and git history, upload safety, dependency audits, safe file writes and
  backups. Includes a non-destructive outsider-probe recipe (run against your own site only).
- **Speed** → `references/speed.md`. Running Lighthouse dynamically with `scripts/lighthouse.mjs`,
  reading the LCP phase breakdown, the biggest wins (make the LCP image discoverable in the HTML,
  preload with `fetchpriority=high`, never lazy-load the LCP image, right-size/compress, cache with
  content-hashed URLs, defer non-critical JS), and measuring in a throttled real browser.
- **Privacy & cookies (US)** → `references/privacy-cookies-us.md`. What to collect (minimise),
  consent and disclosure, cookie categories and a compliant banner pattern, data-subject
  access/deletion requests, and writing a privacy notice. **Engineering guidance, not legal advice —
  a lawyer signs off for anything real.**

## Scripts

- `scripts/report.mjs <url>` — **start here for a launch/handoff check.** Runs all four checks below
  against one URL — Security, Governance (cookies), Speed (Lighthouse + video weight), Accessibility
  — and writes a shareable report in three forms: `precheck-report.json` (the raw data),
  `precheck-report.html` (a self-contained page — score gauges, a "fix this first" list, every finding
  with a plain-English why + fix **and the actual code for this site** where one can be generated — no
  server needed, just send the file), and `precheck-report.md` (a short summary for a terminal or PR
  comment). `node scripts/report.mjs https://example.com --out ./report`. A check that can't run (no
  Chrome, no puppeteer-core) degrades to a noted "skipped" entry rather than failing the whole report.
  Add `--allow-private` for a local dev URL, `--skip-a11y`/`--skip-lighthouse`/`--skip-cookies`/
  `--skip-video` to go faster.
- `scripts/headers.mjs <url>` — just the security-header check on its own, printed to the terminal.
- `scripts/lighthouse.mjs <url>` — just Lighthouse on its own: scores, Core Web Vitals, the LCP element
  and its phase breakdown, and the failing audits ranked by saving, each with the offending URLs.
  `node scripts/lighthouse.mjs https://example.com --runs 3 --form mobile`.
- `scripts/a11y.mjs <url>` — just the accessibility check on its own (see also the
  `accessibility-launch-readiness` skill, which vendors the same check as `a11y-check.mjs` alongside
  the manual WCAG pass).
- `scripts/cookies.mjs <url>` — the Governance check on its own: every cookie the first response
  sets, flagged for missing `Secure`/`SameSite`. Deliberately doesn't judge `HttpOnly` — a cookie a
  script needs to read (a CSRF token) is sometimes correctly non-HttpOnly, so that's a human call.
- `scripts/media.mjs <url>` — finds `<video>`/`<source>` tags pointing at local video files and
  reports their real size. Not a stock Lighthouse audit, but a heavy hero/background video is
  routinely the single biggest thing on a page — bigger than any image.
- `scripts/serve-with-headers.mjs <dir> [--port 4747]` — **use this, not `python -m http.server` or
  `npx http-server`, to preview a static site locally before testing it.** Those ignore the `_headers`
  file entirely (it's a Netlify/Cloudflare Pages-only convention, not a web standard), so running
  `report.mjs` against a plain local static server will always show security headers as "missing" —
  even when they're correctly configured in `_headers` and will work the moment it's deployed. That
  false signal is worse than no signal: it makes a correct config look broken. This server actually
  parses and applies `_headers`, so local testing reflects what the real deploy will serve.

Use `report.mjs` instead of asking the user to paste a DevTools/Lighthouse report, and instead of
running each check separately and hand-assembling the findings. But treat its output as the
**diagnosis, not the deliverable** — it's the input to step 3 above (close the loop in the repo).
Any scanner can produce a report that says what's wrong, with the offending file and the byte count —
Lighthouse, PageSpeed Insights, and GTmetrix all already do that. `report.mjs` goes one step further
and generates the actual code for a resolvable fix (the real `Cache-Control` block, the real
`squoosh`/`ffmpeg` command with the real filename, the real `<link rel="preconnect">` for a domain the
page actually loads from) — but it still can't see the user's source. Finding every place that file is
referenced and fixing it in their actual code, or proposing the exact diff, is what only running this
as a skill inside their repo can do. Never fabricate a placeholder (`<file>`, `yourdomain.com` when a
real host is known) in a finding's code — if a check didn't resolve a real value, say so in prose
rather than making the code look more finished than it is.

## When you finish

Give the user: what changed and was verified (say how — "re-tested live, forged header now blocked"),
what's still open with severity, and the short list of things only they can do. If deploys were
batched, say so. Never claim a fix is live until you've confirmed it against production.
