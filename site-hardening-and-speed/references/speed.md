# Speed: measure with Lighthouse, fix the LCP

Don't guess at performance and don't trust a pasted report at face value. Measure the page yourself,
read where the time actually goes, fix the biggest item, measure again.

## Run Lighthouse yourself

`scripts/lighthouse.mjs` runs Lighthouse via `npx -y lighthouse@12` (no install) and prints a
decision-ready summary. Use it instead of asking the user to paste DevTools output — you get the full
structured result and can act on it directly.

```
node scripts/lighthouse.mjs https://example.com                 # 3 runs, mobile, simulated slow 4G
node scripts/lighthouse.mjs http://localhost:3030/ --runs 1 --allow-private  # quick local check
node scripts/lighthouse.mjs https://example.com --form desktop
```

It prints: the scores for every run (single runs vary ±5–10 points, so it reports the **median**),
Core Web Vitals (FCP, LCP, TBT, CLS, Speed Index, TTFB), the **LCP element and its phase breakdown**,
and the failing audits ranked by estimated saving with the offending URLs. Full JSON reports land in
`./lighthouse-reports/` for deeper digging; view one with `npx -y lighthouse@12 <url> --view` or the
online viewer.

Needs Chrome installed. If it can't find Chrome, set `CHROME_PATH` to the executable.

Test against production for the real number, and against a local dev server to check a fix fast. For
a before/after on a slow connection, a throttled puppeteer run (CPU 4×, ~1.6 Mbps, 150 ms latency)
measuring the `largest-contentful-paint` PerformanceObserver entry gives a quick A/B without a full
Lighthouse pass.

## Read the LCP breakdown — it tells you what to fix

LCP (Largest Contentful Paint) splits into four phases. Whichever is biggest is your fix:

- **TTFB** (time to first byte) — server/CDN slow. Cache, move closer, Cloudflare.
- **Load delay** — the browser *found* the LCP resource late. This is the usual culprit for an image
  injected by JavaScript: the browser can't start fetching until the script downloads and runs. Fix
  by making the resource **discoverable in the initial HTML** (see below).
- **Load time** — the resource is too big. Right-size and recompress it.
- **Render delay** — blocked by CSS/JS or late layout. Reduce main-thread work, defer non-critical JS.

## The high-value LCP fixes (in order)

1. **Make the LCP image discoverable in the HTML.** If the hero image is added by client JS (a
   framework or a `applySavedPhotos()`-style loader), the browser doesn't see it until that script
   runs — often 1-2 s of pure "load delay". Write the `<img>` into the HTML at build/render time so
   the preload scanner finds it immediately. Have the JS loader skip a slot that already has its
   `<img>` so you don't get two copies.
2. **Preload it with high priority:** `<link rel="preload" as="image" href="hero.webp"
   fetchpriority="high">` in the `<head>`, and `fetchpriority="high"` on the `<img>` too.
3. **Never `loading="lazy"` on the LCP image.** Lazy-loading the above-the-fold hero delays the one
   paint that defines the score. Lazy-load everything *below* the fold instead.
4. **Give the `<img>` explicit `width`/`height`** (or an aspect-ratio box) so it reserves space —
   protects CLS (layout shift) and avoids reflow.
5. **Right-size and compress.** Serve an image no bigger than its displayed size (a 1600-wide file
   shown at 400 CSS px wastes bytes and looks soft on retina at the same time). Re-encode to WebP/AVIF
   at quality ~75-82. If Lighthouse still flags "improve image delivery" on an already-small file,
   the source is low-resolution — advise re-uploading a larger original; don't recompress a small
   file twice (it only degrades it).

## Caching and delivery

- **Content-hash the URL of every static asset** (`app.js?v=<sha1>`), then serve those with
  `Cache-Control: public, max-age=31536000, immutable`. A changed file gets a new hash → new URL →
  fetched at once; an unchanged file is kept for a year. Serve the HTML itself `no-cache` so new hashes
  are always picked up.
- **Self-host fonts** (`@font-face` + local `woff2`) instead of Google Fonts — removes a cross-origin
  connection and a render-blocking stylesheet. `font-display: swap`.
- **Defer non-critical JS** (`<script defer>` at end of body, or a deferred external file) and preload
  it so the parser isn't blocked but the fetch still starts early.
- Compress responses (gzip/brotli). Keep the DOM reasonable — a huge DOM shows up as main-thread work
  and "excessive DOM size".

## Verify

After a fix, re-run `scripts/lighthouse.mjs` against production and confirm the number moved and the
LCP element/phase changed as intended. State the before/after honestly — if an audit (e.g. "improve
image delivery") persists because the source asset is the limit, say so rather than claiming a win.
