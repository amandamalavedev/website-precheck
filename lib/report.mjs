#!/usr/bin/env node
// One run -> three outputs: JSON (source of truth), a self-contained HTML report (shareable, no
// server, Lighthouse-style), and a short Markdown summary (terminal/PR). The curated judgment — a
// plain-English translation of every finding, a prioritized "fix this first" list, and findings
// grouped by severity with why-it-matters-to-you + what-to-do — is what makes this worth more than
// pasting raw tool output at someone who doesn't already know what `permissions-policy` means.
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSafeUrl, flag, writeFileContained } from "./safe.mjs";
import { checkHeaders } from "./headers.mjs";
import { checkA11y } from "./a11y.mjs";
import { runLighthouse } from "./lighthouse.mjs";
import { checkCookies } from "./cookies.mjs";
import { checkVideoAssets } from "./media.mjs";
import { checkPrivacy } from "./privacy.mjs";
import { checkSchema } from "./schema.mjs";

const SEV_RANK = { high: 0, medium: 1, low: 2 };
const SEV_LABEL = { high: "High", medium: "Medium", low: "Low" };
const IMPACT_TO_SEV = { critical: "high", serious: "high", moderate: "medium", minor: "low" };

// ---- Plain-English translation layer. A scanner that prints `MISS permissions-policy` and leaves
// you to Google it is only useful to someone who already knows what that means. Every finding gets
// a human label, a "why this matters to you" sentence, and a plain fix; the technical name/id stays
// available but demoted to a <details> aside, never the headline. This dictionary covers the checks
// we run today — anything not listed falls back to a de-jargoned version of the raw tool text. ----
const HEADER_LABEL = {
  "content-security-policy": "Script & content control (CSP)",
  "strict-transport-security": "Force-encrypt connections (HSTS)",
  "x-content-type-options": "File-type guessing lockdown",
  "x-frame-options": "Clickjacking protection",
  "referrer-policy": "Link-click privacy",
  "permissions-policy": "Camera/mic/location lockdown",
  "x-powered-by": "Server software disclosure",
  "server": "Server software disclosure",
};

const TRANSLATE = {
  "header:content-security-policy": {
    plain: "Your site doesn't tell browsers which scripts are allowed to run on it.",
    impact: "If an attacker ever sneaks code onto a page — through a comment box, an ad, or a compromised third-party script — nothing stops it from running. It could steal visitor data or deface the page, and visitors would have no way to tell.",
    fixPlain: "Add a Content-Security-Policy header that only allows scripts from your own domain.",
  },
  "header:strict-transport-security": {
    plain: "Browsers aren't told to always use the encrypted (https://) version of your site.",
    impact: "A visitor's very first request — before HTTPS even kicks in, say on public wifi — could be quietly downgraded and read or tampered with by someone else on the network.",
    fixPlain: "Add a Strict-Transport-Security header so browsers go straight to HTTPS for your domain from then on.",
  },
  "header:x-content-type-options": {
    plain: "Browsers are left to guess what kind of file they're loading instead of trusting what you specify.",
    impact: "In older browsers, a malicious file disguised as an image could get executed as a script.",
    fixPlain: "Add X-Content-Type-Options: nosniff.",
  },
  "header:x-frame-options": {
    plain: "Nothing stops another website from loading your page inside an invisible frame.",
    impact: "This enables “clickjacking” — e.g. a fake “claim your prize” page could hide your real donate or login button underneath, so a visitor thinks they're clicking one thing and actually clicks another.",
    fixPlain: "Add an X-Frame-Options header (or a CSP frame-ancestors rule) so your pages can't be framed by other sites.",
  },
  "header:referrer-policy": {
    plain: "When someone clicks a link off your site, their browser can leak the full page address they came from to whatever site they land on.",
    impact: "If any of your URLs ever contain something sensitive — a tracking token, a draft page name — that leaks to outside sites.",
    fixPlain: "Add a Referrer-Policy header (strict-origin-when-cross-origin is a safe default).",
  },
  "header:permissions-policy": {
    plain: "Browser features like camera, microphone, and location aren't explicitly turned off for your site.",
    impact: "A bug or a bad third-party script embedded on your page has access to more than it needs.",
    fixPlain: "Add a Permissions-Policy header that disables the features you don't use.",
  },
  "unwanted:x-powered-by": {
    plain: "Your server is announcing exactly what software runs it.",
    impact: "That makes it faster for an attacker to look up known weaknesses in that specific software version.",
    fixPlain: "Turn off the X-Powered-By header (e.g. app.disable('x-powered-by') in Express).",
  },
  "unwanted:server": {
    plain: "Your server is naming or versioning itself in every response.",
    impact: "Same risk as above — it narrows down what an attacker needs to guess.",
    fixPlain: "Blank or shorten the Server header at your server or platform edge.",
  },
  "https-redirect": {
    plain: "Typing your address without “https://”, or clicking an old http:// link, lands on the unencrypted version of your site instead of the secure one.",
    impact: "Anyone on that unencrypted connection, even briefly, can see or tamper with the page before any redirect happens.",
    fixPlain: "Make every http:// request redirect to https:// automatically at your server or hosting platform.",
  },
  "lh:uses-long-cache-ttl": { plain: "Returning visitors re-download files that haven't changed.", impact: "Every repeat visit feels slower than it needs to, and costs you bandwidth.", fixPlain: "Tell the browser to cache images, CSS, and JS files for longer.", tool: "Set Cache-Control: public, max-age=31536000, immutable on static assets. Netlify/Vercel: a _headers or vercel.json rule; Express: app.use(express.static(dir, { maxAge: '1y', immutable: true }))." },
  "lh:modern-image-formats": { plain: "Images are served in an older, larger format than necessary.", impact: "Pages take longer to load, especially on mobile data.", fixPlain: "Convert images to WebP or AVIF.", tool: "npx @squoosh/cli --webp '{}' <file> (CLI), or squoosh.app (drag-and-drop, no install) — both free." },
  "lh:uses-responsive-images": { plain: "Phones are downloading full desktop-sized images.", impact: "Mobile visitors wait longer and use more data than they should.", fixPlain: "Serve a smaller image size to smaller screens.", tool: "Generate 2-3 widths and use <img srcset> / sizes, or sharp in Node: sharp(file).resize(800).toFile(out)." },
  "lh:uses-optimized-images": { plain: "Images aren't compressed as much as they could be without losing visible quality.", impact: "Every page load is heavier than it needs to be.", fixPlain: "Run images through a compressor before uploading them.", tool: "npx @squoosh/cli --mozjpeg '{}' <file> for photos, --oxipng '{}' for PNGs; or squoosh.app." },
  "lh:efficiently-encode-images": { plain: "Images aren't compressed as much as they could be without losing visible quality.", impact: "Every page load is heavier than it needs to be.", fixPlain: "Run images through a compressor before uploading them.", tool: "npx @squoosh/cli --mozjpeg '{}' <file> for photos, --oxipng '{}' for PNGs; or squoosh.app." },
  "lh:unminified-css": { plain: "Your stylesheet is shipped with extra spacing and comments visitors never see.", impact: "A small, free speed win is being left on the table.", fixPlain: "Minify CSS during your build/deploy step.", tool: "npx lightningcss-cli --minify <file> -o <out>, or let your bundler (Vite/esbuild) minify on build — most already do in production mode." },
  "lh:unminified-javascript": { plain: "Your scripts are shipped with extra spacing and comments visitors never see.", impact: "A small, free speed win is being left on the table.", fixPlain: "Minify JavaScript during your build/deploy step.", tool: "npx esbuild <file> --minify --outfile=<out>, or let your bundler (Vite/esbuild) minify on build." },
  "lh:render-blocking-resources": { plain: "Some files have to fully load before anything can appear on screen.", impact: "Visitors stare at a blank page longer than they should.", fixPlain: "Defer or inline the styles/scripts that aren't needed for the very first paint.", tool: "Add defer to <script> tags not needed immediately; inline critical above-the-fold CSS and load the rest with <link rel=\"preload\" as=\"style\">." },
  "lh:unused-css-rules": { plain: "Most of the styling code sent to visitors isn't even used on this page.", impact: "Visitors download CSS they'll never see applied.", fixPlain: "Remove unused CSS or split it per-page.", tool: "Chrome DevTools > Coverage tab to see exactly what's unused on this page; or npx -y purgecss --css <file> --content <html,js>." },
  "lh:total-byte-weight": { plain: "This page is unusually heavy to download in total.", impact: "Slower loads, especially for visitors on mobile data or weak connections.", fixPlain: "Trim the largest images, scripts, or fonts contributing to the total.", tool: "Chrome DevTools > Network tab, sort by Size, to see exactly what's heaviest on this page." },
  "lh:uses-text-compression": { plain: "Text-based files (HTML/CSS/JS) are sent uncompressed.", impact: "Everything takes longer to arrive than it should for a nearly-free fix.", fixPlain: "Turn on gzip or brotli compression at your server.", tool: "Most hosts (Netlify, Vercel, Cloudflare) do this automatically — if self-hosting Express, add the compression npm package: app.use(compression())." },
  "lh:largest-contentful-paint-element": { plain: "The biggest visible thing on the page (often a hero image) takes a while to show up.", impact: "This is usually what a visitor experiences as “is this page actually loading?”", fixPlain: "Preload or shrink that specific image/element.", tool: "Add <link rel=\"preload\" as=\"image\" href=\"...\"> for it, and compress it per the image-format fix above." },
  "lh:font-display": { plain: "Text can stay invisible while a custom font is still downloading.", impact: "Visitors sometimes see a blank flash before text appears.", fixPlain: "Add font-display: swap to your @font-face rules.", tool: "Edit the @font-face block in your CSS directly — one line, no tool needed." },
  "lh:viewport": { plain: "The page isn't telling mobile browsers how to size itself.", impact: "Phones may render the page zoomed out and hard to read without pinching.", fixPlain: "Add a <meta name=\"viewport\"> tag.", tool: "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> to <head> directly — one line, no tool needed." },
  // Lighthouse 12 "Insights" — replace/sit alongside the legacy audit ids above on newer runs.
  "lh:cache-insight": { plain: "Returning visitors re-download files that haven't changed.", impact: "Every repeat visit feels slower than it needs to, and costs you bandwidth.", fixPlain: "Tell the browser to cache images, CSS, and JS files for longer.", tool: "Set Cache-Control: public, max-age=31536000, immutable on static assets. Netlify/Vercel: a _headers or vercel.json rule; Express: app.use(express.static(dir, { maxAge: '1y', immutable: true }))." },
  "lh:image-delivery-insight": { plain: "Images are larger or less compressed than they need to be for how they're displayed.", impact: "Pages take longer to load, especially on mobile data.", fixPlain: "Compress and right-size the specific images listed below.", tool: "npx @squoosh/cli --webp '{}' <file> to convert, or squoosh.app (drag-and-drop, no install)." },
  "lh:document-latency-insight": { plain: "The page itself takes a while to start arriving from the server.", impact: "Everything else on the page waits on this first response before it can even start.", fixPlain: "Speed up the server response (caching, a faster host/region, or a CDN).", tool: "Chrome DevTools > Network tab > check \"Waiting (TTFB)\" time on the main document request." },
  "lh:lcp-discovery-insight": { plain: "The browser discovers the page's biggest visible element later than it could.", impact: "This delays the point where the page visibly “finishes loading” for a visitor.", fixPlain: "Make sure that image/element is discoverable straight from the HTML, not injected later by JavaScript.", tool: "Add <link rel=\"preload\" as=\"image\"> for it, or avoid lazy-loading it if it's above the fold." },
  "lh:network-dependency-tree-insight": { plain: "Loading one file forces the browser to wait, then request another, then another, in a chain.", impact: "Each link in that chain adds delay before the page is usable.", fixPlain: "Shorten the chain — preload key resources instead of letting the browser discover them late.", tool: "Chrome DevTools > Network tab, enable the waterfall view, to see the exact dependency chain." },
  "lh:uses-rel-preconnect": { plain: "The browser doesn't find out about other domains it needs (fonts, a CDN, an API) until it's already parsing the page.", impact: "Each new domain costs a DNS lookup + TLS handshake before the first byte even arrives — a few hundred ms, paid again for every one of those domains.", fixPlain: "Add a preconnect hint for each external domain the page actually depends on." },
  "a11y:color-contrast": { plain: "Some text doesn't stand out enough from its background.", impact: "Visitors with low vision, or anyone in bright sunlight, may not be able to read it.", fixPlain: "Darken the text or lighten the background until they meet a 4.5:1 contrast ratio." },
  "a11y:image-alt": { plain: "Some images have no description text behind them.", impact: "A visitor using a screen reader hears nothing where that image is — it's effectively invisible to them.", fixPlain: "Add a short, meaningful alt attribute to every image that conveys information." },
  "a11y:label": { plain: "Some form fields (like a search box or email field) aren't labeled in a way assistive tech can read.", impact: "A screen reader user can't tell what a field is for, so they can't fill out your form.", fixPlain: "Give every input a visible <label> or an aria-label." },
  "a11y:link-name": { plain: "Some links have no readable text (e.g. just an icon with nothing else).", impact: "A screen reader announces “link” with no indication of where it goes.", fixPlain: "Add descriptive text or an aria-label to the link." },
  "a11y:button-name": { plain: "Some buttons have no readable text or label.", impact: "A screen reader user can't tell what the button does before pressing it.", fixPlain: "Add visible text or an aria-label to the button." },
  "a11y:html-has-lang": { plain: "The page doesn't declare what language it's written in.", impact: "Screen readers may use the wrong pronunciation rules, and translation tools may misfire.", fixPlain: "Add lang=\"en\" (or the right language code) to the <html> tag." },
  "a11y:document-title": { plain: "The browser tab has no descriptive title, or a blank one.", impact: "Visitors with many tabs open — or using a screen reader — can't tell which tab this is.", fixPlain: "Give every page a unique, descriptive <title>." },
};

// Fallback for anything not in the dictionary above — Lighthouse/axe cover 100+ possible ids
// between them, and the dictionary only needs to beat "here's the raw tool text," not replace it.
function translateFinding(key, f) {
  const hit = TRANSLATE[key];
  if (hit) return hit;
  if (f.category === "Speed") return { plain: f.title, impact: f.why, fixPlain: f.fix, tool: "Chrome DevTools > Network/Performance tab to see exactly which request this is." };
  if (f.category === "Accessibility") return { plain: f.title, impact: `This can make the site hard or impossible for some visitors to use — for example people using a screen reader or keyboard navigation. ${f.why}`, fixPlain: f.fix };
  return { plain: f.title, impact: f.why, fixPlain: f.fix };
}

// ---- Real, ready-to-paste code for THIS site — not "use a compressor," the actual command with
// the actual file this run found; not "add caching," the actual header block. A report that names
// the problem is advice; a report with the literal diff you'd commit is what you can't get from
// Lighthouse, PageSpeed Insights, or GTmetrix directly, because generating it means resolving the
// finding against the real response (real filenames, real origins) — that's the whole point of
// running checks instead of just reading a static checklist. ----
function siteRelative(u) { try { return new URL(u).pathname.replace(/^\//, ""); } catch { return String(u); } }

function generateCode(f, siteUrl) {
  const files = (f.urls || []).map(siteRelative);
  const file = files[0] || null;
  // Universal snippets (no site-specific file needed) vs. file-dependent ones: never fabricate a
  // "<file>"-style placeholder when we don't have a real resolved value — fall back to the prose
  // `tool` text (already set by the translation dictionary) instead of showing fake-looking code.
  switch (f.key) {
    case "header:content-security-policy":
      return `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`;
    case "header:strict-transport-security":
      return `Strict-Transport-Security: max-age=31536000; includeSubDomains`;
    case "header:x-content-type-options":
      return `X-Content-Type-Options: nosniff`;
    case "header:x-frame-options":
      return `X-Frame-Options: DENY`;
    case "header:referrer-policy":
      return `Referrer-Policy: strict-origin-when-cross-origin`;
    case "header:permissions-policy":
      return `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`;
    case "unwanted:x-powered-by":
      return `// Express:\napp.disable("x-powered-by");`;
    case "https-redirect": {
      let host = "yourdomain.com"; try { host = new URL(siteUrl).host; } catch {}
      return `# Netlify/Cloudflare Pages _redirects file:\nhttp://${host}/*  https://${host}/:splat  301!`;
    }
    case "lh:cache-insight":
    case "lh:uses-long-cache-ttl":
      return `# _headers file (Netlify / Cloudflare Pages):\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n# Express:\napp.use(express.static(dir, { maxAge: "1y", immutable: true }));`
        + (files.length ? `\n\n# Applies to, right now:\n${files.map((u) => `#   ${u}`).join("\n")}` : "");
    case "lh:modern-image-formats":
    case "lh:uses-optimized-images":
    case "lh:efficiently-encode-images":
    case "lh:image-delivery-insight":
      if (!files.length) return null;
      return files.map((u) => `npx @squoosh/cli --webp '{"quality":80}' "${u}"`).join("\n")
        + `\n\n# Or drag-and-drop: squoosh.app / tinypng.com (TinyPNG also handles JPEG, despite the name).`;
    case "lh:uses-responsive-images":
      if (!file) return null;
      return files.map((u) => `npx @squoosh/cli --resize '{"width":800}' --webp '{"quality":80}' "${u}"`).join("\n")
        + `\n\n<!-- then serve the right one per screen: -->\n<img srcset="${file.replace(/\.\w+$/, "")}-800.webp 800w, ${file} 1600w" sizes="(max-width: 600px) 100vw, 800px" src="${file}" alt="">`;
    case "lh:unminified-css":
      if (!files.length) return null;
      return files.map((u) => `npx lightningcss-cli --minify "${u}" -o "${u.replace(/\.css$/, ".min.css")}"`).join("\n");
    case "lh:unminified-javascript":
      if (!files.length) return null;
      return files.map((u) => `npx esbuild "${u}" --minify --outfile="${u.replace(/\.js$/, ".min.js")}"`).join("\n");
    case "lh:render-blocking-resources":
      if (!files.length) return null;
      return files.map((u) => u.endsWith(".css")
        ? `<link rel="preload" href="${u}" as="style" onload="this.onload=null;this.rel='stylesheet'">`
        : `<script src="${u}" defer></script>`).join("\n");
    case "lh:unused-css-rules":
      if (!files.length) return null;
      return files.map((u) => `npx -y purgecss --css "${u}" --content "**/*.html,**/*.js" -o ./purged/`).join("\n");
    case "lh:uses-text-compression":
      return `// Express:\nconst compression = require("compression");\napp.use(compression());\n\n# Netlify/Vercel/Cloudflare Pages already do this automatically — if you see this finding there, re-check after your next deploy.`;
    case "lh:largest-contentful-paint-element":
    case "lh:lcp-discovery-insight":
      if (!file) return null;
      return `<link rel="preload" as="image" href="${file}" fetchpriority="high">\n<!-- on the <img> itself: -->\n<img src="${file}" fetchpriority="high" alt="">`;
    case "lh:font-display":
      if (!file) return null;
      return `@font-face {\n  font-family: "YourFont";\n  src: url("${file}") format("woff2");\n  font-display: swap;\n}`;
    case "lh:viewport":
      return `<meta name="viewport" content="width=device-width, initial-scale=1">`;
    case "lh:uses-rel-preconnect": {
      const origins = [...new Set((f.urls || []).map((u) => { try { return new URL(u).origin; } catch { return null; } }).filter(Boolean))];
      if (!origins.length) return null;
      return origins.map((o) => `<link rel="preconnect" href="${o}" crossorigin>`).join("\n");
    }
    default:
      return null;
  }
}

// ---- Run every check that succeeds; a failed optional check becomes a "skipped" note, not a crash
// for the whole report — a site with no Chrome available should still get its header findings. ----
export async function runReport(rawUrl, {
  allowPrivate = false, skipLighthouse = false, skipA11y = false, skipCookies = false, skipVideo = false, skipPrivacy = false, skipSchema = false,
  lighthouseRuns = 3, lighthouseForm = "mobile", outDir = "lighthouse-reports", brand = null,
} = {}) {
  const url = await assertSafeUrl(rawUrl, { allowPrivate }); // fail fast, before running anything
  const startedAt = new Date().toISOString();
  const skipped = [];
  const findings = [];

  // ---- Security headers (always runs — fast, no browser needed) ----
  let headers = null;
  try {
    headers = await checkHeaders(url, { allowPrivate });
    for (const c of headers.checks) {
      if (!c.present) findings.push({ severity: c.severity, category: "Security", title: `Missing ${c.name} header`, label: HEADER_LABEL[c.name] || c.name, why: c.why, fix: `Add the \`${c.name}\` response header.`, meta: c.name, key: `header:${c.name}` });
    }
    for (const c of headers.unwanted) {
      if (c.present) findings.push({ severity: "low", category: "Security", title: `${c.name} header reveals server details`, label: HEADER_LABEL[c.name] || c.name, why: c.why, fix: `Remove or blank the \`${c.name}\` header (e.g. \`app.disable('x-powered-by')\` in Express).`, meta: c.name, key: `unwanted:${c.name}` });
    }
    if (headers.httpsRedirect === false) findings.push({ severity: "high", category: "Security", title: "HTTP does not redirect to HTTPS", label: "Automatic HTTPS redirect", why: "Visitors on a plain http:// link stay unencrypted.", fix: "Redirect all HTTP traffic to HTTPS at the server or platform edge.", key: "https-redirect" });
  } catch (e) { skipped.push({ check: "headers", reason: e.message }); }

  // ---- Lighthouse (slower — several Chrome launches) ----
  let lighthouse = null;
  if (!skipLighthouse) {
    try {
      lighthouse = await runLighthouse(url, { runs: lighthouseRuns, form: lighthouseForm, allowPrivate, outDir });
      // The LCP-element audits often carry no `url` in their own details (Lighthouse reports a DOM
      // snippet instead) — but the element's actual src is usually recoverable from the captured
      // LCP snippet (lighthouse.lcpElement), so pull it out rather than leaving the finding fileless.
      const lcpSrc = lighthouse.lcpElement && /\bsrc="([^"]+)"/.exec(lighthouse.lcpElement)?.[1];
      for (const f of lighthouse.failing) {
        const extra = [f.metricSavingMs ? `~${f.metricSavingMs}ms metric saving` : "", f.bytes ? `~${Math.round(f.bytes / 1024)} KiB` : ""].filter(Boolean).join(", ");
        const urls = f.urls.length || !lcpSrc || !/lcp/.test(f.id) ? f.urls : [new URL(lcpSrc, url).href];
        findings.push({
          severity: f.metricSavingMs > 500 || f.bytes > 100000 ? "high" : "medium", category: "Speed",
          title: f.title, label: f.title,
          why: f.displayValue ? `Measured: ${f.displayValue}` : "Lighthouse flagged this as a performance opportunity.",
          fix: extra ? `Potential improvement: ${extra}.` : "See the Lighthouse audit id for guidance.",
          meta: f.id, key: `lh:${f.id}`,
          urls, savingMs: f.metricSavingMs, savingKiB: f.bytes ? Math.round(f.bytes / 1024) : null,
        });
      }
    } catch (e) { skipped.push({ check: "lighthouse", reason: e.message }); }
  } else skipped.push({ check: "lighthouse", reason: "skipped by request" });

  // ---- Accessibility (needs puppeteer-core + Chrome; skip quietly if unavailable) ----
  let a11y = null;
  if (!skipA11y) {
    try {
      a11y = await checkA11y(url, { allowPrivate });
      for (const v of a11y.violations) {
        findings.push({ severity: IMPACT_TO_SEV[v.impact] || "medium", category: "Accessibility", title: v.help, label: v.help, why: v.description, fix: `See ${v.helpUrl} — affects ${v.count} element(s).`, meta: v.id, key: `a11y:${v.id}` });
      }
    } catch (e) { skipped.push({ check: "a11y", reason: e.message }); }
  } else skipped.push({ check: "a11y", reason: "skipped by request" });

  // ---- Governance: what does this site actually set in the visitor's browser? ----
  let cookies = null;
  if (!skipCookies) {
    try {
      cookies = await checkCookies(url, { allowPrivate });
      for (const c of cookies.cookies) {
        if (cookies.isHttps && !c.secure) {
          findings.push({
            severity: "high", category: "Governance", title: `Cookie "${c.name}" is missing Secure`,
            label: `Cookie: ${c.name}`, why: "Without Secure, a browser may send this cookie over an unencrypted http:// connection too, not just https://.",
            fix: "Add the Secure attribute when this cookie is set.", meta: c.name, key: `cookie:secure:${c.name}`,
            plain: `The "${c.name}" cookie can be sent over an unencrypted connection.`,
            impact: "If a visitor ever hits a plain http:// version of a page (an old link, a typo), this cookie goes out unencrypted and could be intercepted on the network.",
            fixPlain: `Add the Secure attribute to the "${c.name}" cookie when it's set.`,
            code: c.raw.toLowerCase().includes("secure") ? null : `${c.raw}; Secure`,
          });
        }
        if (!c.sameSite) {
          findings.push({
            severity: "medium", category: "Governance", title: `Cookie "${c.name}" has no SameSite attribute`,
            label: `Cookie: ${c.name}`, why: "Without SameSite, browser defaults vary and the cookie's cross-site behavior isn't something you've deliberately chosen.",
            fix: "Set SameSite explicitly (Lax for most cookies, Strict for anything sensitive, None only if it must work cross-site and Secure is also set).", meta: c.name, key: `cookie:samesite:${c.name}`,
            plain: `The "${c.name}" cookie doesn't say whether other sites can trigger it.`,
            impact: "Leaving this unset relies on the browser's default behavior instead of a deliberate choice — the kind of gap that shows up in a data/cookie governance review.",
            fixPlain: `Set SameSite=Lax on the "${c.name}" cookie (or Strict if it's never needed cross-site).`,
            code: `${c.raw}; SameSite=Lax`,
          });
        }
      }
    } catch (e) { skipped.push({ check: "cookies", reason: e.message }); }
  } else skipped.push({ check: "cookies", reason: "skipped by request" });

  // ---- Video weight: not a stock Lighthouse audit, but often the single biggest asset on a page ----
  let video = null;
  if (!skipVideo) {
    try {
      video = await checkVideoAssets(url, { allowPrivate });
      for (const v of video.heavy) {
        const name = siteRelative(v.url);
        const compressed = name.replace(/\.\w+$/, "-compressed.mp4");
        findings.push({
          severity: v.bytes / 1024 / 1024 > 5 ? "high" : "medium", category: "Speed",
          title: `Video "${name}" is ${(v.bytes / 1024 / 1024).toFixed(1)} MB`, label: `Video: ${name}`,
          why: "Large video files are usually the single biggest contributor to page weight, bigger than any image.",
          fix: "Re-encode at a lower bitrate/resolution; most sites don't need source-quality video for a background/hero clip.",
          meta: name, key: `video:${name}`,
          plain: `The video "${name}" is ${(v.bytes / 1024 / 1024).toFixed(1)} MB.`,
          impact: "On mobile data especially, a multi-megabyte video can dominate the entire page's load time by itself.",
          fixPlain: "Re-encode it at a lower bitrate/resolution — most hero/background video doesn't need source quality.",
          code: `ffmpeg -i "${name}" -vcodec libx264 -crf 28 -preset slower -vf "scale='min(1280,iw)':-2" -movflags +faststart -an "${compressed}"\n\n# Or HandBrake (GUI, handbrake.fr) with the "Fast 1080p30" preset and Constant Quality ~26-28.\n# -an strips audio — drop that flag if the video needs sound.`,
        });
      }
    } catch (e) { skipped.push({ check: "video", reason: e.message }); }
  } else skipped.push({ check: "video", reason: "skipped by request" });

  // ---- Privacy: what THIRD PARTIES this page exposes visitors to, and whether that's disclosed.
  // Distinct from Governance above (what THIS site itself sets) — a page can set zero cookies of its
  // own and still hand visitor data to Google Analytics, a Meta Pixel, etc. ----
  let privacy = null;
  if (!skipPrivacy) {
    try {
      privacy = await checkPrivacy(url, { allowPrivate });
      if (privacy.trackers.length && !privacy.hasPrivacyLink) {
        const names = [...new Set(privacy.trackers.map((t) => t.label))];
        findings.push({
          severity: "high", category: "Privacy", title: `Third-party trackers present with no privacy policy link`,
          label: "Third-party disclosure", why: `Detected: ${names.join(", ")}.`,
          fix: "Add a visible privacy policy link disclosing what's collected and by whom.",
          meta: names.join(", "), key: "privacy:undisclosed-trackers",
          plain: `This page loads ${names.join(" and ")}, but there's no privacy policy link telling visitors about it.`,
          impact: `${names.join(" and ")} can see that this visitor came to this page — standard behavior for these tools, but visitors have no way to know it's happening without a disclosure.`,
          fixPlain: "Add a privacy policy page (linked from the footer is standard) that names what's collected and who it's shared with.",
        });
      }
    } catch (e) { skipped.push({ check: "privacy", reason: e.message }); }
  } else skipped.push({ check: "privacy", reason: "skipped by request" });

  // ---- SEO: structured data (schema.org/JSON-LD) — present, and actually filled in ----
  let schema = null;
  if (!skipSchema) {
    try {
      schema = await checkSchema(url, { allowPrivate });
      if (!schema.hasSchema) {
        findings.push({
          severity: "medium", category: "SEO", title: "No structured data (JSON-LD) found",
          label: "Structured data", why: "No <script type=\"application/ld+json\"> block was found on the page.",
          fix: "Add JSON-LD structured data for the page's type (Organization, LocalBusiness, Article, etc.).",
          key: "schema:missing",
          plain: "This page has no structured data (schema.org/JSON-LD) at all.",
          impact: "Search engines and AI answer engines have nothing machine-readable to lift facts from — you're relying entirely on them parsing prose correctly, which they often don't.",
          fixPlain: "Add a JSON-LD block for what this page actually is (Organization, LocalBusiness, Article, FAQPage, etc.).",
        });
      }
      if (schema.malformed > 0) {
        findings.push({
          severity: "high", category: "SEO", title: `${schema.malformed} malformed JSON-LD block(s)`,
          label: "Structured data", why: "The content inside a <script type=\"application/ld+json\"> tag isn't valid JSON.",
          fix: "Fix the JSON syntax — validate with a JSON-LD linter before deploying.",
          key: "schema:malformed",
          plain: `${schema.malformed} structured-data block(s) on this page are broken (invalid JSON).`,
          impact: "A malformed JSON-LD block is silently ignored by search engines — it looks present in the page source, but contributes nothing, and nobody notices because it doesn't error visibly.",
          fixPlain: "Validate the JSON-LD with a linter (e.g. Google's Rich Results Test) and fix the syntax error.",
        });
      }
      for (const b of schema.blocks) {
        if (b.recognized && b.score < 100) {
          findings.push({
            severity: b.score < 50 ? "medium" : "low", category: "SEO", title: `${b.type} structured data is missing fields`,
            label: `Structured data: ${b.type}`, why: `Present: ${b.present.join(", ") || "(none)"}. Missing: ${b.missing.join(", ")}.`,
            fix: `Add ${b.missing.join(", ")} to the ${b.type} JSON-LD block.`,
            meta: b.type, key: `schema:incomplete:${b.type}`,
            plain: `The ${b.type} structured data on this page is only ${b.score}% filled in.`,
            impact: `Missing fields (${b.missing.join(", ")}) are exactly what a search result or AI answer would otherwise lift directly — leaving them out means a weaker or missing rich result.`,
            fixPlain: `Add ${b.missing.join(", ")} to the ${b.type} block.`,
          });
        }
      }
    } catch (e) { skipped.push({ check: "schema", reason: e.message }); }
  } else skipped.push({ check: "schema", reason: "skipped by request" });

  // Attach the plain-English translation to every finding before sorting — this is the field the
  // renderers lead with; `title`/`why`/`fix` stay as the technical record underneath. Findings that
  // already set plain/impact/fixPlain directly (cookies, video) pass through unchanged, since the
  // fallback branch derives the same fields from title/why/fix.
  for (const f of findings) Object.assign(f, translateFinding(f.key, f));
  // Real, ready-to-paste code comes after translation so a dictionary hit's `tool` prose and the
  // generated code can sit side by side — code wins the spot in the card; tool text becomes context.
  for (const f of findings) if (f.code === undefined) f.code = generateCode(f, url);

  // Lighthouse 12 sometimes fires both a legacy audit id and its newer "Insight" replacement for
  // the same underlying problem (e.g. uses-long-cache-ttl + cache-insight) — same translated text,
  // same files, different id. Dedupe on the content actually shown, not the id, so the reader never
  // sees the identical card twice.
  const seen = new Set();
  const deduped = findings.filter((f) => {
    const dupeKey = `${f.category}|${f.plain}|${(f.urls || []).join(",")}`;
    if (seen.has(dupeKey)) return false;
    seen.add(dupeKey);
    return true;
  });
  findings.length = 0;
  findings.push(...deduped);

  findings.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  const counts = { high: findings.filter((f) => f.severity === "high").length, medium: findings.filter((f) => f.severity === "medium").length, low: findings.filter((f) => f.severity === "low").length };
  const verdict = counts.high > 0 ? "urgent" : counts.medium > 0 ? "attention" : "good";

  // One gauge per thing actually tested — Security / Governance / Privacy / Speed / Accessibility /
  // SEO — not just a single Lighthouse score. Security/Governance/Privacy/Accessibility are a flat
  // deduction from their own findings' severity; Speed uses Lighthouse's own calibrated score when
  // it ran (the real, familiar number), falling back to the same deduction scheme when skipped; SEO
  // uses the structured-data completeness score directly when schema was found (a real, specific
  // measurement, not just "fewer findings = higher score").
  const SEV_WEIGHT = { high: 25, medium: 10, low: 4 };
  const deductionScore = (cat) => Math.max(0, 100 - findings.filter((f) => f.category === cat).reduce((sum, f) => sum + (SEV_WEIGHT[f.severity] || 0), 0));
  const categoryScores = {
    Security: deductionScore("Security"),
    Governance: deductionScore("Governance"),
    Privacy: deductionScore("Privacy"),
    Speed: lighthouse ? lighthouse.categoryScores.performance?.score ?? deductionScore("Speed") : deductionScore("Speed"),
    Accessibility: deductionScore("Accessibility"),
    SEO: schema ? (schema.overallScore ?? 0) : deductionScore("SEO"),
  };

  return {
    tool: "website-precheck", version: "0.1.0", url, startedAt, finishedAt: new Date().toISOString(),
    scores: lighthouse ? Object.fromEntries(Object.entries(lighthouse.categoryScores).map(([k, v]) => [k, v.score])) : null,
    categoryScores, brand,
    headers, lighthouse, a11y, cookies, video, privacy, schema, findings, counts, verdict, skipped,
  };
}

// ============================= Renderers =============================

export function toJSON(report) { return JSON.stringify(report, null, 2); }

const VERDICT_SUMMARY = {
  urgent: (c) => `${c.high} urgent issue${c.high === 1 ? "" : "s"} could expose visitors or your site to real harm — start there before anything else.`,
  attention: (c) => `Nothing urgent, but ${c.medium} issue${c.medium === 1 ? "" : "s"} are worth fixing soon.`,
  good: () => `No high or medium issues found. Nice work — a manual review still catches things automation can't.`,
};

export function toMarkdown(report) {
  const { url, counts, verdict, findings, scores, skipped, brand } = report;
  const lines = [`# Website Precheck — ${url}`, ""];
  if (brand?.name) lines.push(`_by ${brand.name}${brand.tagline ? " — " + brand.tagline : ""}_`, "");
  lines.push(
    "_This is engineering guidance, not a certification or legal advice. Automated checks are defense in" +
    " depth, not a guarantee — they catch real, common issues but not everything. For anything with real" +
    " legal or compliance exposure (GDPR, CCPA, ADA, a security incident), a qualified professional should" +
    " review it._", ""
  );
  lines.push(`Run: ${report.startedAt}`, "", VERDICT_SUMMARY[verdict](counts), "");
  if (scores) lines.push(`**Lighthouse:** ${Object.entries(scores).map(([k, v]) => `${k} ${v}`).join(" · ")}`, "");
  lines.push(`**Findings:** ${counts.high} high · ${counts.medium} medium · ${counts.low} low`, "");
  if (findings.length) {
    lines.push("## Fix this first", "");
    for (const f of findings.slice(0, 10)) {
      lines.push(`- **[${f.category} · ${SEV_LABEL[f.severity]}]** ${f.plain}`);
      lines.push(`  - Why it matters: ${f.impact}`);
      lines.push(`  - What to do: ${f.fixPlain}`);
      if (f.urls && f.urls.length) lines.push(`  - Affected file(s): ${f.urls.map((u) => String(u).split("/").pop() || u).join(", ")}`);
      if (f.code) { lines.push("  - Code:", "    ```", ...f.code.split("\n").map((l) => `    ${l}`), "    ```"); }
      else if (f.tool) lines.push(`  - Tool / command: ${f.tool}`);
    }
    lines.push("");
  } else {
    lines.push("No findings. 🎉", "");
  }
  if (skipped.length) {
    lines.push("## Skipped checks", "");
    for (const s of skipped) lines.push(`- ${s.check}: ${s.reason}`);
    lines.push("");
  }
  lines.push(
    "_Generated by [website-precheck](https://github.com/amandamalavedev/website-precheck) — a free, open" +
    " tool. Not legal advice, not a certification of compliance — see the disclaimer above._"
  );
  return lines.join("\n");
}

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
/** The site's name as people say it ("example.com"), for the report header; falls back to the raw URL. */
function siteName(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return String(u ?? ""); } }
function scoreBand(score) { return score >= 90 ? "good" : score >= 50 ? "mid" : "bad"; }

function gauge(label, score) {
  if (score == null) return "";
  const band = scoreBand(score);
  const deg = Math.round((score / 100) * 360);
  return `<div class="gauge">
    <div class="gauge-ring ${band}" style="--deg:${deg}deg"><span>${score}</span></div>
    <div class="gauge-label">${esc(label)}</div>
  </div>`;
}

// Each finding leads with the plain-English translation; the raw tool title/meta becomes a
// collapsed technical aside — present for anyone who wants it, never the thing you read first.
function findingCard(f) {
  const measured = [f.savingMs ? `~${f.savingMs}ms faster` : "", f.savingKiB ? `~${f.savingKiB} KiB smaller` : ""].filter(Boolean).join(" · ");
  const fileList = f.urls && f.urls.length
    ? `<p class="files"><strong>Affected file${f.urls.length > 1 ? "s" : ""}:</strong></p>
       <ul class="file-list">${f.urls.map((u) => `<li><code>${esc(String(u).split("/").pop() || u)}</code></li>`).join("")}</ul>`
    : "";
  // Real, copy-paste-ready code wins the spot — it's the thing you'd otherwise have to go write
  // yourself from the "what to do" sentence. `tool` (prose) only shows when there's no code to give.
  const codeBlock = f.code
    ? `<div class="code-block"><div class="code-label">Code for this site</div><pre><code>${esc(f.code)}</code></pre></div>`
    : (f.tool ? `<p class="tool"><strong>Tool / command:</strong> ${esc(f.tool)}</p>` : "");
  return `<article class="finding sev-${f.severity}">
    <div class="finding-head">
      <span class="badge sev-${f.severity}">${SEV_LABEL[f.severity]}</span>
      <span class="cat-pill">${esc(f.category)}</span>
      <h4>${esc(f.plain)}</h4>
    </div>
    ${measured ? `<p class="measured">${esc(measured)} if fixed</p>` : ""}
    <p class="why"><strong>Why it matters:</strong> ${esc(f.impact)}</p>
    <p class="do"><strong>What to do:</strong> ${esc(f.fixPlain)}</p>
    ${fileList}
    ${codeBlock}
    <details class="tech">
      <summary>Technical details</summary>
      <p>${esc(f.title)}${f.meta ? ` <code>${esc(f.meta)}</code>` : ""}</p>
      <p class="muted">${esc(f.why)}</p>
    </details>
  </article>`;
}

export function toHTML(report) {
  const { url, startedAt, categoryScores, counts, verdict, findings, headers, a11y, cookies, privacy, schema, lighthouse, skipped, brand } = report;
  const date = new Date(startedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  // One gauge per thing this report actually checks — the familiar Lighthouse-style gauge row, but
  // for our own pillars (Security, Governance, Privacy, Speed, Accessibility) instead of theirs.
  const topGauges = Object.entries(categoryScores).map(([k, v]) => gauge(k, v)).join("");

  const fmtMs = (v) => (v == null ? "—" : v >= 1000 ? (v / 1000).toFixed(2) + " s" : v + " ms");
  // Never just say "mobile" or "4G" — state exactly what device and network profile Lighthouse
  // actually emulated, pulled from its own configSettings/environment, not asserted.
  const tc = lighthouse?.testConditions;
  const testedAs = tc
    ? `<p class="tested-as">Tested as: <strong>${esc(tc.device)}</strong> emulation${tc.screen ? `, ${esc(tc.screen)} screen` : ""} on <strong>${esc(tc.networkLabel)}</strong>${tc.rttMs != null ? ` (${tc.rttMs}ms round-trip, ${tc.downloadKbps} Kbps down / ${tc.uploadKbps} Kbps up, ${tc.cpuSlowdown}× CPU slowdown)` : ""}.</p>`
    : "";
  const speedDetail = lighthouse
    ? `${testedAs}<div class="metrics-row">
        <div class="metric"><div class="metric-val">${fmtMs(lighthouse.metrics.lcpMs)}</div><div class="metric-label">LCP</div></div>
        <div class="metric"><div class="metric-val">${fmtMs(lighthouse.metrics.fcpMs)}</div><div class="metric-label">FCP</div></div>
        <div class="metric"><div class="metric-val">${fmtMs(lighthouse.metrics.tbtMs)}</div><div class="metric-label">TBT</div></div>
        <div class="metric"><div class="metric-val">${lighthouse.metrics.cls?.toFixed(3) ?? "—"}</div><div class="metric-label">CLS</div></div>
        <div class="metric"><div class="metric-val">${fmtMs(lighthouse.metrics.speedIndexMs)}</div><div class="metric-label">Speed Index</div></div>
        <div class="metric"><div class="metric-val">${fmtMs(lighthouse.metrics.ttfbMs)}</div><div class="metric-label">TTFB</div></div>
       </div>${lighthouse.lcpElement ? `<p class="muted">Largest Contentful Paint element: <code>${esc(lighthouse.lcpElement.slice(0, 160))}</code></p>` : ""}`
    : `<p class="muted">Lighthouse wasn't run for this report${skipped.find((s) => s.check === "lighthouse") ? " (" + esc(skipped.find((s) => s.check === "lighthouse").reason) + ")" : ""}.</p>`;

  const top5 = findings.slice(0, 5);
  const topFixes = top5.map(findingCard).join("") || `<p class="all-clear">No findings — nothing to fix right now.</p>`;

  // "All findings" is the full record grouped by category, but skip what's already shown above —
  // repeating the same 5 cards verbatim just makes the page twice as long with nothing new to read.
  const rest = findings.slice(5);
  const byCategory = {};
  for (const f of rest) (byCategory[f.category] ??= []).push(f);
  const CAT_INTRO = {
    Security: "Things that could let someone attack your site or its visitors.",
    Speed: "Things slowing the page down for real visitors.",
    Accessibility: "Things that make the site hard or impossible for some visitors to use.",
    Governance: "What this site itself collects and stores in a visitor's browser.",
    Privacy: "What third parties this site exposes visitors to, and whether that's disclosed.",
    SEO: "Whether search engines and AI answer engines have structured facts to work with.",
  };
  const findingsHTML = Object.entries(byCategory).map(([cat, items]) => `
    <section class="cat-section">
      <h3>${esc(cat)} <span class="count">${items.length}</span></h3>
      ${CAT_INTRO[cat] ? `<p class="cat-intro">${esc(CAT_INTRO[cat])}</p>` : ""}
      ${items.map(findingCard).join("")}
    </section>`).join("") || (findings.length ? `<p class="all-clear">Everything else is covered in “Fix this first” above — nothing more to add.</p>` : `<p class="all-clear">No findings in any category — nothing to fix right now.</p>`);

  const headersChecklist = headers ? `
    <ul class="checklist checklist-why">
      ${headers.checks.map((c) => `<li class="${c.present ? "pass" : "fail"}">
        <span class="tick">${c.present ? "✓" : "✗"}</span>
        <div><div class="checklist-name">${esc(HEADER_LABEL[c.name] || c.name)} <code>${esc(c.name)}</code></div><div class="checklist-why-text">${esc(c.why)}</div></div>
      </li>`).join("")}
    </ul>` : `<p class="muted">Not checked${skipped.find((s) => s.check === "headers") ? ": " + esc(skipped.find((s) => s.check === "headers").reason) : ""}.</p>`;

  const a11yFindings = findings.filter((f) => f.category === "Accessibility");
  const a11ySection = a11y
    ? (a11yFindings.length
        ? a11yFindings.map(findingCard).join("")
        : `<p class="all-clear">No automated accessibility violations found.</p>`) +
      `<p class="muted">Checked ${a11y.passes} rule(s) automatically; ${a11y.incomplete.length} need a human look (automated tools can't fully judge these). Automated checks catch roughly a third to half of real accessibility issues — pair this with a manual pass.</p>`
    : `<p class="muted">Not checked${skipped.find((s) => s.check === "a11y") ? ": " + esc(skipped.find((s) => s.check === "a11y").reason) : ""}.</p>`;

  const governanceFindings = findings.filter((f) => f.category === "Governance");
  const cookieInventory = cookies
    ? (cookies.cookies.length
        ? `<ul class="checklist">${cookies.cookies.map((c) => `<li class="${c.secure && c.sameSite ? "pass" : "fail"}"><span class="tick">${c.secure && c.sameSite ? "✓" : "!"}</span> ${esc(c.name)} <code>Secure=${c.secure} · SameSite=${esc(c.sameSite || "not set")} · HttpOnly=${c.httpOnly}</code></li>`).join("")}</ul>`
        : `<p class="all-clear">No cookies set on the first response.</p>`)
    : `<p class="muted">Not checked${skipped.find((s) => s.check === "cookies") ? ": " + esc(skipped.find((s) => s.check === "cookies").reason) : ""}.</p>`;
  const governanceSection = cookieInventory + governanceFindings.map(findingCard).join("")
    + `<p class="muted">This lists what's set on the first response only, and doesn't judge whether HttpOnly should be on or off — a cookie a script needs to read (like a CSRF token) is sometimes correctly non-HttpOnly. This is engineering guidance, not legal advice — a full consent/compliance review (GDPR, CCPA, etc.) needs a qualified professional.</p>`;

  const privacyFindings = findings.filter((f) => f.category === "Privacy");
  const trackerInventory = privacy
    ? (privacy.thirdParty.length
        ? `<ul class="checklist">${privacy.thirdParty.map((t) => `<li class="${t.label ? "fail" : "pass"}"><span class="tick">${t.label ? "!" : "·"}</span> ${esc(t.label || t.host)} <code>${esc(t.host)}</code></li>`).join("")}
           <li class="${privacy.hasPrivacyLink ? "pass" : "fail"}"><span class="tick">${privacy.hasPrivacyLink ? "✓" : "✗"}</span> Privacy policy link ${privacy.hasPrivacyLink ? "found" : "not found"}</li></ul>`
        : `<p class="all-clear">No third-party scripts or embeds detected on this page.</p>`)
    : `<p class="muted">Not checked${skipped.find((s) => s.check === "privacy") ? ": " + esc(skipped.find((s) => s.check === "privacy").reason) : ""}.</p>`;
  const privacySection = trackerInventory + privacyFindings.map(findingCard).join("")
    + `<p class="muted">Third-party origins are listed for transparency, not flagged on their own — a CDN or webfont host isn't a tracker. Only a recognized analytics/ad/tracking service with no privacy policy link becomes a finding.</p>`;

  const schemaFindings = findings.filter((f) => f.category === "SEO");
  const schemaInventory = schema
    ? (schema.hasSchema
        ? `<ul class="checklist">${schema.blocks.map((b) => `<li class="${!b.recognized ? "pass" : b.score === 100 ? "pass" : "fail"}"><span class="tick">${!b.recognized ? "·" : b.score === 100 ? "✓" : "!"}</span> ${esc(b.type)} ${b.recognized ? `<code>${b.score}% complete</code>` : "<code>not scored</code>"}</li>`).join("")}</ul>`
        : `<p class="all-clear" style="color:var(--mid);">No structured data (JSON-LD) found on this page.</p>`)
    : `<p class="muted">Not checked${skipped.find((s) => s.check === "schema") ? ": " + esc(skipped.find((s) => s.check === "schema").reason) : ""}.</p>`;
  const schemaSection = schemaInventory + schemaFindings.map(findingCard).join("")
    + `<p class="muted">Scored against a baseline set of recommended properties per type (Organization, LocalBusiness, Article, etc.) — "100%" means the common fields are filled in, not that every possible schema.org property is present.</p>`;

  const VERDICT_TITLE = { urgent: "Urgent issues found", attention: "A few things worth fixing", good: "Looking good" };
  const verdictText = VERDICT_SUMMARY[verdict](counts);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Website Precheck — ${esc(url)}</title>
<style>
  :root{
    --ink:#0f172a; --ink-dim:#475569; --ink-faint:#94a3b8; --bg:#f8fafc; --card:#ffffff; --line:#e2e8f0;
    --good:#1a7f37; --good-bg:#e9f7ee; --mid:#9a6700; --mid-bg:#fff6e5; --bad:#c92a2a; --bad-bg:#fdeeee;
    --accent:#2563eb;
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      --ink:#f1f5f9; --ink-dim:#cbd5e1; --ink-faint:#64748b; --bg:#0b1220; --card:#121a2b; --line:#1e293b;
      --good-bg:#0f2a1a; --mid-bg:#2a2108; --bad-bg:#2a1414;
    }
  }
  :root[data-theme="dark"]{
    --ink:#f1f5f9; --ink-dim:#cbd5e1; --ink-faint:#64748b; --bg:#0b1220; --card:#121a2b; --line:#1e293b;
    --good-bg:#0f2a1a; --mid-bg:#2a2108; --bad-bg:#2a1414;
  }
  *{box-sizing:border-box;}
  body{margin:0; padding:24px 16px; background:var(--bg); color:var(--ink); font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;}
  .wrap{max-width:860px; margin:0 auto;}
  header.top{display:flex; flex-wrap:wrap; justify-content:space-between; align-items:baseline; gap:8px; margin-bottom:24px;}
  header.top h1{font-size:20px; margin:0; word-break:break-all;}
  header.top .meta{color:var(--ink-faint); font-size:13px;}
  .verdict{display:flex; flex-wrap:wrap; align-items:center; gap:16px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px 22px; margin-bottom:20px; border-left:5px solid var(--verdict-color,var(--good));}
  .verdict.urgent{--verdict-color:var(--bad);}
  .verdict.attention{--verdict-color:var(--mid);}
  .verdict.good{--verdict-color:var(--good);}
  .verdict h2{margin:0 0 4px; font-size:19px; color:var(--verdict-color,var(--ink));}
  .verdict p{margin:0; color:var(--ink-dim);}
  .verdict .target{word-break:break-all; color:var(--ink-faint); font-size:13px; margin-top:2px;}
  .card{background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px 22px; margin-bottom:20px;}
  .card h2{font-size:14px; text-transform:uppercase; letter-spacing:.04em; color:var(--ink-dim); margin:0 0 14px;}
  .gauges{display:flex; flex-wrap:wrap; gap:28px; justify-content:center; padding:8px 0;}
  .gauge{display:flex; flex-direction:column; align-items:center; gap:8px; width:96px;}
  .gauge-ring{position:relative; width:84px; height:84px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:24px; font-weight:700;}
  .gauge-ring::before{content:""; position:absolute; inset:0; border-radius:50%; background:conic-gradient(var(--ring-color,var(--good)) var(--deg,0deg), var(--line) 0);}
  .gauge-ring::after{content:""; position:absolute; inset:8px; border-radius:50%; background:var(--card);}
  .gauge-ring span{position:relative; z-index:1;}
  .gauge-ring.good{--ring-color:var(--good); color:var(--good);}
  .gauge-ring.mid{--ring-color:var(--mid); color:var(--mid);}
  .gauge-ring.bad{--ring-color:var(--bad); color:var(--bad);}
  .gauge-label{font-size:12px; color:var(--ink-dim); text-transform:capitalize; text-align:center;}
  .counts{display:flex; gap:10px; flex-wrap:wrap; margin-top:4px;}
  .pill{border-radius:999px; padding:6px 14px; font-size:13px; font-weight:700;}
  .pill.high{background:var(--bad-bg); color:var(--bad);}
  .pill.medium{background:var(--mid-bg); color:var(--mid);}
  .pill.low{background:var(--good-bg); color:var(--good);}
  .badge{display:inline-block; border-radius:6px; padding:2px 8px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; flex-shrink:0;}
  .badge.sev-high{background:var(--bad-bg); color:var(--bad);}
  .badge.sev-medium{background:var(--mid-bg); color:var(--mid);}
  .badge.sev-low{background:var(--good-bg); color:var(--good);}
  .cat-pill{display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:11px; font-weight:600; color:var(--ink-dim); flex-shrink:0;}
  .top-gauges{display:flex; flex-wrap:wrap; gap:24px; justify-content:center; padding:4px 0 4px;}
  .top-gauges .gauge-ring{width:72px; height:72px; font-size:20px;}
  .skill-desc{background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 20px; margin-bottom:20px; color:var(--ink-dim); font-size:13.5px; line-height:1.6;}
  .skill-desc strong{color:var(--ink);}
  .skill-desc .disclaimer{display:block; font-size:12px; color:var(--ink-faint); font-style:italic;}
  .cat-section{margin-bottom:18px;}
  .cat-section h3{font-size:15px; margin:0 0 4px; color:var(--ink);}
  .cat-section .count{color:var(--ink-faint); font-weight:400;}
  .cat-intro{color:var(--ink-faint); font-size:13px; margin:0 0 10px;}
  article.finding{border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin-bottom:10px; background:var(--bg);}
  .finding-head{display:flex; align-items:baseline; gap:8px; margin-bottom:8px;}
  .finding-head h4{margin:0; font-size:14.5px; color:var(--ink); line-height:1.45;}
  article.finding p{margin:5px 0; font-size:13.5px; color:var(--ink-dim);}
  article.finding p.do{color:var(--ink);}
  article.finding p strong{color:var(--ink);}
  article.finding p.measured{display:inline-block; background:var(--good-bg); color:var(--good); font-size:12px; font-weight:700; border-radius:6px; padding:2px 8px; margin:0 0 8px;}
  article.finding p.tool{background:var(--bg); border-left:3px solid var(--accent); padding:6px 10px; border-radius:4px;}
  article.finding p.files{margin-bottom:2px;}
  ul.file-list{list-style:none; margin:0 0 8px; padding:0; display:flex; flex-wrap:wrap; gap:6px;}
  ul.file-list li{font-size:12px;}
  .code-block{margin:8px 0; border-radius:6px; overflow:hidden; border:1px solid var(--line);}
  .code-label{background:var(--line); color:var(--ink-dim); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; padding:5px 10px;}
  .code-block pre{margin:0; padding:12px 14px; overflow-x:auto; background:#0b1220; color:#d6e2f5; font-size:12.5px; line-height:1.55;}
  .code-block pre code{background:none; border:none; padding:0; color:inherit; font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace; white-space:pre;}
  details.tech{margin-top:8px;}
  details.tech summary{cursor:pointer; font-size:12px; color:var(--ink-faint); list-style:none;}
  details.tech summary::-webkit-details-marker{display:none;}
  details.tech summary::before{content:"▸ "; }
  details.tech[open] summary::before{content:"▾ "; }
  details.tech p{margin:6px 0 0; font-size:12.5px;}
  .all-clear{color:var(--good); font-weight:600;}
  ul.checklist{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; font-size:13.5px;}
  ul.checklist li{display:flex; align-items:center; gap:8px;}
  ul.checklist .tick{font-weight:700; width:16px; text-align:center;}
  ul.checklist li.pass .tick{color:var(--good);}
  ul.checklist li.fail .tick{color:var(--bad);}
  ul.checklist li.fail{color:var(--ink-dim);}
  ul.checklist code{margin-left:auto; color:var(--ink-faint);}
  ul.checklist-why li{align-items:flex-start;}
  ul.checklist-why .checklist-name{font-weight:600; color:var(--ink);}
  ul.checklist-why .checklist-name code{margin-left:6px; font-weight:400;}
  ul.checklist-why .checklist-why-text{color:var(--ink-faint); font-size:12.5px; margin-top:1px;}
  code{background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:1px 5px; font-size:12.5px;}
  .muted{color:var(--ink-faint); font-size:13px;}
  .assessed{display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 12px; margin:-6px 0 18px; padding:14px 18px; background:var(--card, #fff); border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:12px;}
  .assessed-lbl{width:100%; font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-faint);}
  .assessed-site{font-size:24px; font-weight:800; color:var(--ink); text-decoration:none; word-break:break-all;}
  .assessed-site:hover{text-decoration:underline;}
  .assessed-url{font-size:13px; color:var(--ink-faint); word-break:break-all;}
  .brand-block{display:flex; align-items:center; gap:10px;}
  .brand-block img{width:36px; height:36px; border-radius:8px; flex-shrink:0;}
  .brand-block .brand-text h1{font-size:19px; margin:0;}
  .brand-block .brand-text .brand-by{font-size:12px; color:var(--ink-faint);}
  .metrics-row{display:flex; flex-wrap:wrap; gap:18px; justify-content:center; padding:4px 0;}
  .metric{text-align:center; min-width:72px;}
  .metric-val{font-size:18px; font-weight:700; color:var(--ink); font-variant-numeric:tabular-nums;}
  .metric-label{font-size:11px; color:var(--ink-faint); text-transform:uppercase; letter-spacing:.03em; margin-top:2px;}
  p.tested-as{font-size:13px; color:var(--ink-dim); text-align:center; margin:0 0 10px;}
  p.tested-as strong{color:var(--ink);}
  footer{text-align:center; color:var(--ink-faint); font-size:12px; margin-top:24px;}
  footer a{color:var(--accent);}
  @media print{ body{background:#fff;} .card,.verdict{break-inside:avoid; border-color:#ccc;} }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    ${brand?.logoDataUri
      ? `<div class="brand-block"><img src="${brand.logoDataUri}" alt="${esc(brand.name || "")} logo"><div class="brand-text"><h1>Website Precheck</h1><div class="brand-by">by ${esc(brand.name || "")}</div></div></div>`
      : `<h1>Website Precheck</h1>`}
    <div class="meta">${esc(date)}</div>
  </header>
  <!-- which site this is about, up top — a forwarded or printed report must say what it assessed -->
  <div class="assessed">
    <span class="assessed-lbl">Website assessed</span>
    <a class="assessed-site" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(siteName(url))}</a>
    <span class="assessed-url">${esc(url)}</span>
  </div>

  <div class="card">
    <div class="top-gauges">${topGauges}</div>
  </div>

  <div class="skill-desc">
    This report checks six things on <strong>${esc(url)}</strong>: <strong>Security</strong> (headers,
    cookie flags, HTTPS), <strong>Governance</strong> (what data and cookies the site itself sets in a
    visitor's browser), <strong>Privacy</strong> (what third parties the site exposes visitors to, and
    whether that's disclosed), <strong>Speed</strong> (Lighthouse performance, Core Web Vitals, video
    weight), <strong>Accessibility</strong> (automated WCAG 2.1 A/AA checks), and <strong>SEO</strong>
    (structured data — present, and actually filled in). Every finding below
    says why it matters in plain terms and, where one can be generated, the actual code to fix it on
    this site — not generic advice.${brand?.tagline ? `<br><br><strong>Why ${esc(brand.name || "we")} built this:</strong> ${esc(brand.tagline)}` : ""}
    <br><br><span class="disclaimer">This is engineering guidance, not a certification or legal advice. Automated checks are defense in depth, not a guarantee — they catch real, common issues but not everything. For anything with real legal or compliance exposure (GDPR, CCPA, ADA, a security incident), a qualified professional should review it.</span>
  </div>

  <div class="verdict ${verdict}">
    <div>
      <h2>${VERDICT_TITLE[verdict]}</h2>
      <p>${esc(verdictText)}</p>
      <div class="target">${esc(url)}</div>
    </div>
    <div class="counts">
      <span class="pill high">${counts.high} high</span>
      <span class="pill medium">${counts.medium} medium</span>
      <span class="pill low">${counts.low} low</span>
    </div>
  </div>

  <div class="card">
    <h2>Fix this first</h2>
    ${topFixes}
  </div>

  <div class="card">
    <h2>Speed detail (Core Web Vitals)</h2>
    ${speedDetail}
  </div>

  <div class="card">
    <h2>All findings</h2>
    ${findingsHTML}
  </div>

  <div class="card">
    <h2>Security checklist</h2>
    ${headersChecklist}
  </div>

  <div class="card">
    <h2>Governance (data &amp; cookies)</h2>
    ${governanceSection}
  </div>

  <div class="card">
    <h2>Privacy (third parties)</h2>
    ${privacySection}
  </div>

  <div class="card">
    <h2>SEO (structured data)</h2>
    ${schemaSection}
  </div>

  <div class="card">
    <h2>Accessibility</h2>
    ${a11ySection}
  </div>

  <footer>Generated by <a href="https://github.com/amandamalavedev/website-precheck">website-precheck</a>${brand?.url ? ` · <a href="${esc(brand.url)}">${esc(brand.name)}</a>` : ""} — a free, open tool. Automated checks catch real issues but not everything; pair with a manual pass.<br>Not legal advice, not a certification of compliance — see the disclaimer above.${brand?.copyright ? `<br>${esc(brand.copyright)}` : ""}</footer>
</div>
</body>
</html>`;
}

// Write all three outputs to outDir, confined (F4) — never trust an LLM-chosen path blindly.
export function writeReportFiles(report, outDir, baseDir = process.cwd()) {
  mkdirSync(resolve(outDir), { recursive: true });
  const files = {
    json: join(outDir, "precheck-report.json"),
    html: join(outDir, "precheck-report.html"),
    md: join(outDir, "precheck-report.md"),
  };
  writeFileContained(baseDir, files.json, toJSON(report));
  writeFileContained(baseDir, files.html, toHTML(report));
  writeFileContained(baseDir, files.md, toMarkdown(report));
  return files;
}

// ---- CLI wrapper ----
const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] || "").href; } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  const rawUrl = args.find((a) => /^[a-z][a-z0-9+.-]+:\/\//i.test(a));
  if (!rawUrl) { console.error("Usage: node report.mjs <url> [--out dir] [--skip-lighthouse] [--skip-a11y] [--skip-cookies] [--skip-video] [--skip-privacy] [--skip-schema] [--allow-private] [--brand-name N] [--brand-logo path] [--brand-tagline T] [--brand-url U] [--brand-copyright C]"); process.exit(2); }
  if (!/^https?:\/\//i.test(rawUrl)) { console.error(`Refused: only http:// and https:// URLs can be checked (got "${rawUrl.split(':')[0]}:").`); process.exit(2); }
  const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
  const outDir = opt("out", "precheck-report");

  // Branding is opt-in and never shipped by this open-source tool by default — pass --brand-* to
  // stamp a report with your own identity (logo embedded as a data URI so the HTML stays portable).
  let brand = null;
  const brandName = opt("brand-name");
  if (brandName) {
    const logoPath = opt("brand-logo");
    let logoDataUri;
    if (logoPath) {
      const ext = logoPath.split(".").pop().toLowerCase();
      const mime = { webp: "image/webp", png: "image/png", svg: "image/svg+xml", jpg: "image/jpeg", jpeg: "image/jpeg" }[ext] || "application/octet-stream";
      logoDataUri = `data:${mime};base64,${readFileSync(resolve(logoPath)).toString("base64")}`;
    }
    brand = { name: brandName, logoDataUri, tagline: opt("brand-tagline"), url: opt("brand-url"), copyright: opt("brand-copyright") };
  }

  let report;
  try {
    report = await runReport(rawUrl, {
      allowPrivate: flag(args, "allow-private"),
      skipLighthouse: flag(args, "skip-lighthouse"),
      skipA11y: flag(args, "skip-a11y"),
      skipCookies: flag(args, "skip-cookies"),
      skipVideo: flag(args, "skip-video"),
      skipPrivacy: flag(args, "skip-privacy"),
      skipSchema: flag(args, "skip-schema"),
      lighthouseRuns: Number(opt("runs", "3")) || 3,
      lighthouseForm: opt("form", "mobile"),
      brand,
    });
  } catch (e) {
    console.error(/private|local|valid URL/i.test(e.message) ? "Refused: " + e.message : e.message);
    process.exit(/private|local|valid URL/i.test(e.message) ? 2 : 1);
  }

  let files;
  try { files = writeReportFiles(report, outDir); }
  catch (e) { console.error("Could not write report: " + e.message); process.exit(1); }

  console.log(toMarkdown(report));
  console.log(`\nWrote:\n  ${files.json}\n  ${files.html}\n  ${files.md}`);
  process.exitCode = Math.min(report.counts.high, 250);
}
