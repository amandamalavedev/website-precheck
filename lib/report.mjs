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
import { checkMobile } from "./mobile.mjs";
import { detectPlatform, readPageProfile, buildCsp, schemaFor, pageSchemaFor, contrastFix, securityChecklist } from "./specifics.mjs";
import { discoverPages } from "./crawl.mjs";

const SEV_RANK = { high: 0, medium: 1, low: 2 };
const SEV_LABEL = { high: "High", medium: "Medium", low: "Low" };
// axe-core impact → our severity. Only "critical" (blocks a disabled visitor outright — e.g. a control
// that can't be reached by keyboard) is High. "serious" (e.g. low colour contrast) used to map to High
// too, which put a contrast nit at the top of "Fix this first", above real security gaps (2026-10-02).
const IMPACT_TO_SEV = { critical: "high", serious: "medium", moderate: "low", minor: "low" };
// Tie-break within a severity: what can hurt visitors or the owner most comes first. Without it, ties
// fell in whatever order the checks happened to run.
// Checklist items whose failure is High (and costs 25 points): encryption, injection protection, and
// anything that exposes code, keys or files. Other failures are Medium (10); warnings are Low (4).
const CRITICAL_CHECKS = new Set(["https", "http-redirect", "csp", "exposed-files", "mixed-content", "secrets-in-code", "source-maps", "server-files"]);
// How each failed/warned checklist item reads as an ISSUE (the checklist itself states the goal).
const CHECK_PROBLEM = {
  https: "The site isn't served over HTTPS", "http-redirect": "Plain http:// doesn't redirect to https://",
  hsts: "Browsers aren't told to always use HTTPS (HSTS)", csp: "No Content-Security-Policy — an injected script could run freely",
  clickjacking: "Other sites can load your pages in a hidden frame (clickjacking)", nosniff: "Browsers are allowed to guess file types (X-Content-Type-Options missing)",
  referrer: "Full page addresses leak to the sites you link to (Referrer-Policy missing)", permissions: "Camera, microphone and location aren't switched off (Permissions-Policy missing)",
  disclosure: "The server advertises its software", "mixed-content": "Some files load over unencrypted http://",
  sri: "Scripts from other sites have no tamper-proof fingerprint (SRI)", "exposed-files": "Secret files (.git / .env) can be downloaded",
  "source-maps": "Your original source code can be downloaded (source maps)", "secrets-in-code": "API keys, tokens or passwords are visible in your site's code",
  "emails-in-code": "Staff email addresses are visible in your site's scripts", "server-files": "Server code or config files can be downloaded",
  "security-txt": "No security contact published (security.txt)",
};
const CATEGORY_RANK = { Security: 0, Privacy: 1, Governance: 2, Accessibility: 3, Mobile: 4, Speed: 5, Schema: 6 };
/** Order findings for "Fix this first": severity, then category, then how much of the page it affects. */
export function rankFindings(findings) {
  const reach = (f) => (f.pages?.length || 0) * 5 + (f.count || 0) + (f.urls?.length || 0) + (f.savingMs ? f.savingMs / 100 : 0);
  return findings.sort((a, b) =>
    (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9)
    || (CATEGORY_RANK[a.category] ?? 9) - (CATEGORY_RANK[b.category] ?? 9)
    || reach(b) - reach(a));
}

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

/** The corrected markup or CSS for ONE failing accessibility element (null when there's no safe
 *  mechanical fix — then the card shows axe's own reason for that element instead). */
function a11yFixFor(ruleId, node, profile) {
  const html = node.html || "";
  const addAttr = (attr) => html.replace(/^<(\w+)/, `<$1 ${attr}`);
  switch (ruleId) {
    case "image-alt": case "input-image-alt": case "role-img-alt": case "svg-img-alt":
      return `${addAttr('alt="Describe what this image shows"')}\n<!-- purely decorative image? use alt="" instead -->`;
    case "html-has-lang": case "html-lang-valid": case "html-xml-lang-mismatch":
      return `<html lang="${(profile?.lang && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(profile.lang)) ? profile.lang : "en"}">`;
    case "color-contrast": case "color-contrast-enhanced": {
      const c = node.contrast;
      if (!c) return null;
      const fix = contrastFix(c.fg, c.bg, c.required || 4.5);
      if (!fix) return null;
      return `${node.target} { color: ${fix.color}; }\n/* now ${c.fg} on ${c.bg} = ${c.ratio}:1, needs ${c.required}:1 → ${fix.color} gives ${fix.ratio}:1 */`;
    }
    case "link-name":
      return addAttr('aria-label="Where this link goes"');
    case "button-name":
      return addAttr('aria-label="What this button does"');
    case "label": case "select-name": {
      const id = /\bid="([^"]+)"/.exec(html)?.[1];
      return id ? `<label for="${id}">Name of this field</label>\n${html}` : `<label>Name of this field\n  ${html}\n</label>`;
    }
    case "document-title":
      return `<title>${profile?.meta?.title || "Page name — Site name"}</title>`;
    case "meta-viewport": case "meta-viewport-large":
      return `<meta name="viewport" content="width=device-width, initial-scale=1">`;
    case "frame-title":
      return addAttr('title="What this embedded content is"');
    default:
      return null;
  }
}

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
    case "lh:uses-responsive-images": {
      if (!file) return null;
      // Work out the width to resize to from Lighthouse's own numbers: bytes scale roughly with area, so the
      // displayed width ≈ original × √(kept ÷ total); doubled for sharp phone screens, rounded up to 50px.
      const kib = (b) => `${Math.round(b / 1024)} KiB`;
      const rows = (f.items || []).filter((it) => it.url).slice(0, 3);
      if (!rows.length) rows.push({ url: f.urls[0] });
      const lines = rows.map((it) => {
        const name = siteRelative(it.url);
        const keep = it.totalBytes && it.wastedBytes ? Math.max(0.04, (it.totalBytes - it.wastedBytes) / it.totalBytes) : null;
        const width = f.lcpWidth && keep ? Math.min(f.lcpWidth, Math.max(200, Math.ceil((f.lcpWidth * Math.sqrt(keep) * 2) / 50) * 50)) : 800;
        const out = name.replace(/\.\w+$/, `-${width}.webp`);
        return `# ${name}: ${it.totalBytes ? kib(it.totalBytes) : "?"} now${it.wastedBytes ? `, ${kib(it.wastedBytes)} of it never shown at the size it's displayed` : ""}\n`
          + `npx @squoosh/cli --resize '{"width":${width}}' --webp '{"quality":80}' -s "-${width}" "${name}"\n`
          + `<!-- then: --> <img src="${out}" srcset="${out} ${width}w, ${name} ${f.lcpWidth || 1600}w" sizes="(max-width: 600px) 100vw, ${Math.round(width / 2)}px" alt="…">`;
      });
      return lines.join("\n\n");
    }
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
// ---- Steps shared by the one-page run and the whole-site merge ----
const SEV_WEIGHT = { high: 25, medium: 10, low: 4 };

/** Failed/warned SECURITY checklist items → Security findings (one source for score, ✓/✗ list and fixes). */
function securityFindingsFrom(checklist) {
  return checklist.items.filter((i) => i.section === "Security" && i.status !== "pass").map((i) => ({
    severity: i.status === "fail" ? (CRITICAL_CHECKS.has(i.id) ? "high" : "medium") : "low",
    category: "Security", key: `check:${i.id}`, title: CHECK_PROBLEM[i.id] || i.label, label: i.label,
    plain: CHECK_PROBLEM[i.id] || i.label, impact: i.detail, fixPlain: i.where || "", why: i.detail, fix: i.where || "",
    where: i.where || null, code: i.code ?? null, checkStatus: i.status, ...(i.pages ? { pages: i.pages } : {}),
  }));
}

function securityScore(checklist) {
  return Math.max(0, 100 - checklist.items.filter((i) => i.section === "Security")
    .reduce((s, i) => s + (i.status === "fail" ? (CRITICAL_CHECKS.has(i.id) ? 25 : 10) : i.status === "warn" ? 4 : 0), 0));
}

/** Plain-English fields, ready-to-paste code, de-duplication and ranking — in place. */
function finishFindings(findings, url) {
  // Fill in plain-English fields only where a finding hasn't already written its own.
  for (const f of findings) { const t = translateFinding(f.key, f); for (const k of Object.keys(t)) if (f[k] == null || f[k] === "") f[k] = t[k]; }
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
  rankFindings(findings);
  return findings;
}

const countsOf = (findings) => ({ high: findings.filter((f) => f.severity === "high").length, medium: findings.filter((f) => f.severity === "medium").length, low: findings.filter((f) => f.severity === "low").length });
const verdictOf = (counts) => (counts.high > 0 ? "urgent" : counts.medium > 0 ? "attention" : "good");

// One page, every check. `role: "inner"` marks a page other than the one the report started from (its
// schema suggestion is a WebPage block, not the Organization); `probeCache` shares site-wide probes
// (/.git, /.env, security.txt…) across pages so a multi-page run asks for each address once.
async function runPageReport(rawUrl, {
  allowPrivate = false, skipLighthouse = false, skipA11y = false, skipCookies = false, skipVideo = false, skipPrivacy = false, skipSchema = true, skipMobile = false,
  lighthouseRuns = 3, lighthouseForm = "mobile", outDir = "lighthouse-reports", brand = null, role = "home", probeCache = null,
} = {}) {
  const url = await assertSafeUrl(rawUrl, { allowPrivate }); // fail fast, before running anything
  const startedAt = new Date().toISOString();
  const skipped = [];
  const findings = [];

  // ---- Security headers + which host serves the site + what the page loads. Security FINDINGS come from
  // the security checklist further down (so the Security score, its ✓/✗ list and its fixes always agree),
  // with every fix written for this host (a Netlify _headers file, vercel.json, nginx config…). ----
  let headers = null, platform = { id: "unknown", name: "an unidentified host" }, profile = null;
  try {
    headers = await checkHeaders(url, { allowPrivate });
    platform = detectPlatform(headers.responseHeaders);
  } catch (e) { skipped.push({ check: "headers", reason: e.message }); }
  try { profile = await readPageProfile(url, { allowPrivate }); }
  catch (e) { skipped.push({ check: "page", reason: e.message }); }

  // ---- Lighthouse (slower — several Chrome launches) ----
  let lighthouse = null;
  if (!skipLighthouse) {
    try {
      lighthouse = await runLighthouse(url, { runs: lighthouseRuns, form: lighthouseForm, allowPrivate, outDir });
      // The LCP-element audits often carry no `url` in their own details (Lighthouse reports a DOM
      // snippet instead) — but the element's actual src is usually recoverable from the captured
      // LCP snippet (lighthouse.lcpElement), so pull it out rather than leaving the finding fileless.
      const lcpSrc = lighthouse.lcpElement && /\bsrc="([^"]+)"/.exec(lighthouse.lcpElement)?.[1];
      const lcpWidth = lighthouse.lcpElement ? Number(/\bwidth="(\d+)"/.exec(lighthouse.lcpElement)?.[1]) || null : null;
      for (const f of lighthouse.failing) {
        const extra = [f.metricSavingMs ? `about ${f.metricSavingMs} ms faster` : "", f.bytes ? `about ${Math.round(f.bytes / 1024)} KiB smaller` : ""].filter(Boolean).join(", ");
        const urls = f.urls.length || !lcpSrc || !/lcp/.test(f.id) ? f.urls : [new URL(lcpSrc, url).href];
        const items = (f.items || []).filter((it) => it.url || it.element);
        findings.push({
          severity: f.metricSavingMs > 500 || f.bytes > 100000 ? "high" : "medium", category: "Speed",
          title: f.title, label: f.title,
          why: f.displayValue ? `Lighthouse measured: ${f.displayValue}.` : "Lighthouse flagged this as slowing the page down.",
          fix: extra ? `Fixing it would make the page ${extra}.` : items.length ? "The exact files involved are listed below." : "Lighthouse didn't name a single file for this one — the full Lighthouse report (linked in the Speed section) shows the trace.",
          meta: f.id, key: `lh:${f.id}`,
          urls, items, savingMs: f.metricSavingMs, savingKiB: f.bytes ? Math.round(f.bytes / 1024) : null,
          lcpWidth: lcpSrc && urls.some((u) => u.endsWith(lcpSrc.split("/").pop())) ? lcpWidth : null,
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
        const elements = v.nodes.map((n) => ({ ...n, fixed: a11yFixFor(v.id, n, profile) }));
        findings.push({
          severity: IMPACT_TO_SEV[v.impact] || "medium", category: "Accessibility", title: v.help, label: v.help, why: v.description,
          fix: `Fix the ${v.count} element${v.count === 1 ? "" : "s"} listed below${v.count > elements.length ? ` (first ${elements.length} shown)` : ""}.`,
          meta: v.id, key: `a11y:${v.id}`, elements, count: v.count, helpUrl: v.helpUrl, axeImpact: v.impact,
        });
      }
    } catch (e) { skipped.push({ check: "a11y", reason: e.message }); }
  } else skipped.push({ check: "a11y", reason: "skipped by request" });

  // ---- Mobile readiness: the page as a phone loads it (viewport, sideways scroll, tap size, text size) ----
  let mobile = null;
  if (!skipMobile) {
    try {
      mobile = await checkMobile(url, { allowPrivate });
      const c = mobile.checks;
      if (!c.viewport.ok) findings.push({
        severity: c.viewport.value == null ? "high" : "medium", category: "Mobile", key: c.viewport.value == null ? "mobile:no-viewport" : "mobile:zoom-blocked",
        title: c.viewport.value == null ? "No mobile viewport tag" : "Viewport blocks pinch-zoom",
        why: c.viewport.value == null ? "Without it, phones draw the page at desktop width and shrink it, so everything is tiny." : `The viewport tag ("${c.viewport.value}") stops visitors zooming in — people with low vision rely on that.`,
        fix: "Use the standard viewport tag in <head> on every page.",
        where: "In the <head> of every page (replace the existing viewport tag if there is one):",
        code: `<meta name="viewport" content="width=device-width, initial-scale=1">`,
      });
      if (!c.overflow.ok) findings.push({
        severity: "high", category: "Mobile", key: "mobile:overflow", title: `Page scrolls sideways on a phone (${c.overflow.scrollWidth}px content on a ${c.overflow.screenWidth}px screen)`,
        why: "Visitors have to drag left and right to read it — the most common reason a site 'feels broken' on a phone.",
        fix: "Stop the listed elements growing wider than the screen.",
        elements: c.overflow.elements.map((e) => ({ target: e.selector, html: e.html, summary: `${e.width}px wide, reaches ${e.right}px on a ${c.overflow.screenWidth}px screen`, fixed: `${e.selector} { max-width: 100%; box-sizing: border-box; overflow-wrap: anywhere; }` })),
        where: "Add to your main stylesheet (the rule for images/video/tables fixes most cases on its own):",
        code: `img, video, iframe, table, pre { max-width: 100%; height: auto; }\n${c.overflow.elements.map((e) => `${e.selector} { max-width: 100%; box-sizing: border-box; overflow-wrap: anywhere; }`).join("\n")}`,
      });
      if (!c.tap.ok) findings.push({
        severity: "medium", category: "Mobile", key: "mobile:tap-targets", title: `${c.tap.small.length} button${c.tap.small.length === 1 ? "" : "s"}/link${c.tap.small.length === 1 ? "" : "s"} too small to tap reliably`,
        why: "Targets under 24×24px get mis-tapped — the visitor hits the wrong link or nothing at all (WCAG 2.2 target size).",
        fix: "Give each listed element at least 24×24px of tappable area (padding counts).",
        elements: c.tap.small.map((e) => ({ target: e.selector, html: e.html, summary: `${e.w}×${e.h}px — needs at least 24×24px`, fixed: `${e.selector} { display: inline-block; min-width: 24px; min-height: 24px; padding: ${Math.max(0, Math.ceil((24 - e.h) / 2))}px ${Math.max(0, Math.ceil((24 - e.w) / 2))}px; }` })),
        where: "Add to your main stylesheet:",
        code: c.tap.small.map((e) => `${e.selector} { display: inline-block; min-width: 24px; min-height: 24px; padding: ${Math.max(0, Math.ceil((24 - e.h) / 2))}px ${Math.max(0, Math.ceil((24 - e.w) / 2))}px; }`).join("\n"),
      });
      if (!c.text.ok) findings.push({
        severity: "low", category: "Mobile", key: "mobile:small-text", title: `${c.text.tiny.length} piece${c.text.tiny.length === 1 ? "" : "s"} of text smaller than 12px`,
        why: "Text under 12px is hard to read on a phone without zooming, especially outdoors or for older visitors.",
        fix: "Raise the listed text to at least 12px (14px or more for anything people need to read).",
        elements: c.text.tiny.map((e) => ({ target: e.selector, html: `"${e.text}"`, summary: `${e.px}px`, fixed: `${e.selector} { font-size: 12px; }` })),
        where: "Add to your main stylesheet:",
        code: [...new Set(c.text.tiny.map((e) => `${e.selector} { font-size: 12px; } /* was ${e.px}px */`))].join("\n"),
      });
    } catch (e) { skipped.push({ check: "mobile", reason: e.message }); }
  } else skipped.push({ check: "mobile", reason: "skipped by request" });

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

  // ---- Schema: structured data (schema.org/JSON-LD) — present, and actually filled in ----
  let schema = null;
  if (!skipSchema) {
    try {
      schema = await checkSchema(url, { allowPrivate });
      if (!schema.hasSchema && role === "inner") {
        const gen = profile ? pageSchemaFor(profile) : null;
        findings.push({
          severity: "low", category: "Schema", title: "No structured data (JSON-LD) on this page",
          label: "Structured data", why: "No <script type=\"application/ld+json\"> block was found on the page.",
          fix: "Add the WebPage block below.", key: "schema:missing-inner",
          plain: "Inner pages have no structured data.",
          impact: "Search engines and AI answer engines can still read your home page's details, but they can't tell what each of these pages is about or that it belongs to your site.",
          fixPlain: gen ? `Paste a WebPage block into each page's <head>, filled in from that page's own title and description${gen.missing.length ? ` — add ${gen.missing.join(", ")}` : ""}.` : "Add a WebPage JSON-LD block to each page.",
          where: "Inside <head> on each page listed. Check it afterwards at search.google.com/test/rich-results",
          code: gen ? gen.code : null,
        });
      } else if (!schema.hasSchema) {
        const gen = profile ? schemaFor(profile) : null;
        findings.push({
          severity: "medium", category: "Schema", title: "No structured data (JSON-LD) found",
          label: "Structured data", why: "No <script type=\"application/ld+json\"> block was found on the page.",
          fix: "Add the JSON-LD block below.",
          key: "schema:missing",
          plain: "This page has no structured data (schema.org/JSON-LD) at all.",
          impact: "Search engines and AI answer engines have nothing machine-readable to lift facts from — you're relying entirely on them parsing prose correctly, which they often don't.",
          fixPlain: gen
            ? `Paste the block below into your home page. It's already filled in from your page's own title, description, logo${gen.missing.length ? "" : " and social links"}${gen.missing.length ? ` — add ${gen.missing.join(", ")} yourself, the page didn't say` : ""}.`
            : "Add a JSON-LD block for what this page actually is (Organization, LocalBusiness, Article, FAQPage, etc.).",
          where: "Inside <head> on your home page (one per page; other pages can describe themselves, e.g. Article or Product). Check it afterwards at search.google.com/test/rich-results",
          code: gen ? gen.code : null,
        });
      }
      if (schema.malformed > 0) {
        findings.push({
          severity: "high", category: "Schema", title: `${schema.malformed} malformed JSON-LD block(s)`,
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
            severity: b.score < 50 ? "medium" : "low", category: "Schema", title: `${b.type} structured data is missing fields`,
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
  }

  // Attach the plain-English translation to every finding before sorting — this is the field the
  // renderers lead with; `title`/`why`/`fix` stay as the technical record underneath. Findings that
  // already set plain/impact/fixPlain directly (cookies, video) pass through unchanged, since the
  // fallback branch derives the same fields from title/why/fix.
  // ---- The security checklist (needs cookies + privacy, so it runs last). Its failed/warned SECURITY
  // items become the Security findings — one source for the Security score, its ✓/✗ list and its fixes.
  // Cookie and tracker items belong to the Governance and Privacy sections (which have their own findings).
  let checklist = null;
  try {
    checklist = await securityChecklist({ url, headers, cookies, privacy, profile, platform, allowPrivate, probeCache });
    const SECTION_OF = { cookies: "Governance", trackers: "Privacy", "privacy-link": "Privacy" };
    for (const i of checklist.items) i.section = SECTION_OF[i.id] || "Security";
    findings.push(...securityFindingsFrom(checklist));
  } catch (e) { skipped.push({ check: "checklist", reason: e.message }); }

  finishFindings(findings, url);
  const counts = countsOf(findings);
  const verdict = verdictOf(counts);

  // One score per section; how each is calculated is spelled out in the report (SCORE_METHOD) so the
  // number is never a mystery. null = that check didn't run (shown as "not checked", never as 0 or 100).
  const deductionScore = (cat) => Math.max(0, 100 - findings.filter((f) => f.category === cat).reduce((sum, f) => sum + (SEV_WEIGHT[f.severity] || 0), 0));
  const categoryScores = {
    Security: checklist ? securityScore(checklist) : (headers ? deductionScore("Security") : null),
    Governance: cookies ? deductionScore("Governance") : null,
    Privacy: privacy ? deductionScore("Privacy") : null,
    Speed: lighthouse ? (lighthouse.categoryScores.performance?.score ?? null) : null,
    Accessibility: a11y ? deductionScore("Accessibility") : null,
    Mobile: mobile ? mobile.score : null,
    ...(skipSchema ? {} : { Schema: schema ? (schema.overallScore ?? 0) : null }),
  };

  return {
    tool: "website-precheck", version: "0.2.0", url, startedAt, finishedAt: new Date().toISOString(),
    scores: lighthouse ? Object.fromEntries(Object.entries(lighthouse.categoryScores).map(([k, v]) => [k, v.score])) : null,
    categoryScores, brand, platform,
    page: profile ? { origins: profile.origins, inlineScripts: profile.inlineScriptHashes.length, lang: profile.lang } : null,
    checklist, mobile,
    headers, lighthouse, a11y, cookies, video, privacy, schema, findings, counts, verdict, skipped,
  };
}

// ============================= Whole site =============================
// `runReport` checks every page it can find (following the site's own links, up to maxPages), then merges:
// an issue on several pages becomes ONE finding that names its pages; the same header/footer element on
// every page is listed once. Site scores: Security from the merged checklist (a check that fails on any
// page fails for the site), Governance/Privacy = the lowest page (one bad page is a site problem), and
// Speed/Accessibility/Mobile/Schema = the average of the pages, each page's own score in "Page by page".

const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return String(u); } };
const listPages = (paths) => (paths.length <= 6 ? paths.join(", ") : `${paths.slice(0, 6).join(", ")} and ${paths.length - 6} more`);
const STATUS_RANK = { fail: 0, warn: 1, pass: 2 };

function pageSummary(r) {
  return {
    url: r.url, path: pathOf(r.url), categoryScores: r.categoryScores, counts: r.counts, verdict: r.verdict,
    metrics: r.lighthouse?.metrics ? { lcpMs: r.lighthouse.metrics.lcpMs, cls: r.lighthouse.metrics.cls, tbtMs: r.lighthouse.metrics.tbtMs } : null,
    lighthouseRuns: r.lighthouse?.runs ?? null,
    findings: r.findings.map((f) => ({ key: f.key || `${f.category}|${f.plain}`, severity: f.severity, category: f.category, plain: f.plain })),
    skipped: r.skipped,
  };
}

/** One checklist for the site: each item's worst status across pages, naming the pages where it failed. */
export function mergeChecklists(list) {
  const byId = new Map();
  for (const { path, checklist } of list) {
    if (!checklist) continue;
    for (const i of checklist.items) { if (!byId.has(i.id)) byId.set(i.id, []); byId.get(i.id).push({ ...i, path }); }
  }
  const distinct = (arr, k) => [...new Map(arr.map((i) => [i[k] ?? "", i])).values()];
  const items = [];
  for (const [id, inst] of byId) {
    const worst = [...inst].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])[0];
    const bad = inst.filter((i) => i.status !== "pass");
    let detail;
    const scannedAll = inst.some((i) => i.scanned) ? [...new Set(inst.flatMap((i) => i.scanned || []))] : null;
    if (!bad.length && scannedAll) {
      const files = scannedAll.map((u) => (/^https?:/.test(u) ? pathOf(u.replace(/ \(inline scripts\)$/, "")) + (/\(inline scripts\)$/.test(u) ? " (inline)" : "") : u));
      const what = { "source-maps": "public source maps", "secrets-in-code": "API keys, tokens, private keys and hard-coded passwords", "emails-in-code": "email addresses" }[id] || "problems";
      detail = `Checked on all ${inst.length} pages: ${files.length} file${files.length === 1 ? "" : "s"} scanned for ${what} (${files.slice(0, 15).join(", ")}${files.length > 15 ? ` and ${files.length - 15} more` : ""}) — none found.`;
    } else if (!bad.length) {
      const ds = distinct(inst, "detail");
      detail = ds.length === 1 ? (inst.length > 1 ? `${ds[0].detail} (checked on all ${inst.length} pages)` : ds[0].detail) : `Passed on all ${inst.length} pages. On ${inst[0].path}: ${inst[0].detail}`;
    } else {
      const ds = distinct(bad, "detail");
      detail = ds.length === 1 && bad.length === inst.length ? ds[0].detail
        : ds.map((d) => `On ${listPages(bad.filter((b) => b.detail === d.detail).map((b) => b.path))}: ${d.detail}`).join("  ·  ");
    }
    const codes = distinct(bad.filter((b) => b.code), "code");
    items.push({
      id, label: worst.label, section: worst.section, status: worst.status, detail,
      ...(worst.where ? { where: worst.where } : {}),
      ...(codes.length ? { code: codes.map((c) => c.code).join("\n\n") } : {}),
      pages: bad.map((b) => b.path), checkedOn: inst.length,
    });
  }
  const counts = { pass: items.filter((i) => i.status === "pass").length, warn: items.filter((i) => i.status === "warn").length, fail: items.filter((i) => i.status === "fail").length };
  return { items, counts, allMissingHeaders: list.find((l) => l.checklist)?.checklist.allMissingHeaders ?? null };
}

/** Findings from every page → one finding per problem, with the pages it's on. Security check findings are
 *  rebuilt from the merged checklist instead, so they're skipped here. */
export function mergeFindings(perPage) {
  const groups = new Map();
  for (const { path, findings } of perPage) for (const f of findings) {
    if (f.category === "Security" && String(f.key || "").startsWith("check:")) continue;
    const k = f.key || `${f.category}|${f.plain}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ f, path });
  }
  const out = [];
  for (const inst of groups.values()) {
    inst.sort((a, b) => SEV_RANK[a.f.severity] - SEV_RANK[b.f.severity]);
    const m = structuredClone(inst[0].f);
    m.pages = [...new Set(inst.map((i) => i.path))];
    if (inst.some((i) => i.f.items?.length)) {
      const seen = new Map();
      for (const { f } of inst) for (const it of f.items || []) { const k = it.url || it.element; if (!seen.has(k)) seen.set(k, it); }
      m.items = [...seen.values()];
    }
    if (inst.some((i) => i.f.urls?.length)) m.urls = [...new Set(inst.flatMap((i) => i.f.urls || []))];
    // the same header/footer element on every page is listed once, with the pages it's on
    if (inst.some((i) => i.f.elements?.length)) {
      const el = new Map(); let unlisted = 0;
      for (const { f, path } of inst) {
        for (const e of f.elements || []) {
          const k = `${e.target}|${e.summary || ""}`;
          if (!el.has(k)) el.set(k, { ...e, pages: [] });
          if (!el.get(k).pages.includes(path)) el.get(k).pages.push(path);
        }
        unlisted += Math.max(0, (f.count || 0) - (f.elements || []).length);
      }
      m.elements = [...el.values()];
      if (m.count != null) m.count = m.elements.length + unlisted;
    }
    const codes = [...new Map(inst.filter((i) => i.f.code).map((i) => [i.f.code, i])).values()];
    if (codes.length > 1) {
      if (m.category === "Mobile") m.code = [...new Set(codes.flatMap((c) => c.f.code.split("\n")))].join("\n");
      // Speed fixes are generated from the files involved — rebuild ONE block from the merged file list
      // rather than near-identical copies that differ only in which files they name
      else if (m.category === "Speed" && (m.items?.length || m.urls?.length)) m.code = undefined;
      else { m.variants = codes.map((c) => ({ pages: inst.filter((i) => i.f.code === c.f.code).map((i) => i.path), code: c.f.code })); m.code = null; }
    }
    const maxOf = (k) => Math.max(...inst.map((i) => i.f[k] || 0)) || null;
    m.savingMs = maxOf("savingMs"); m.savingKiB = maxOf("savingKiB");
    const n = m.elements?.length || 0;
    if (m.key === "mobile:tap-targets") m.title = m.plain = `${n} button${n === 1 ? "" : "s"}/link${n === 1 ? "" : "s"} too small to tap reliably`;
    if (m.key === "mobile:small-text") m.title = m.plain = `${n} piece${n === 1 ? "" : "s"} of text smaller than 12px`;
    out.push(m);
  }
  return out;
}

function mergePageReports(results, { crawl, startedAt, failed = [], maxPages }) {
  const home = results[0];
  const n = results.length;
  const perPage = results.map((r) => ({ path: pathOf(r.url), r }));
  const checklist = results.some((r) => r.checklist) ? mergeChecklists(perPage.map(({ path, r }) => ({ path, checklist: r.checklist }))) : null;
  const security = checklist ? finishFindings(securityFindingsFrom(checklist), home.url) : [];
  const merged = mergeFindings(perPage.map(({ path, r }) => ({ path, findings: r.findings })));
  for (const f of merged) if (f.code === undefined) f.code = generateCode(f, home.url);
  const findings = rankFindings([...merged, ...security]);
  const counts = countsOf(findings);
  const scoresOf = (cat) => results.map((r) => r.categoryScores[cat]).filter((v) => v != null);
  const avg = (cat) => { const v = scoresOf(cat); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const min = (cat) => { const v = scoresOf(cat); return v.length ? Math.min(...v) : null; };
  const categoryScores = {
    Security: checklist ? securityScore(checklist) : min("Security"), Governance: min("Governance"), Privacy: min("Privacy"),
    Speed: avg("Speed"), Accessibility: avg("Accessibility"), Mobile: avg("Mobile"),
    ...(results.some((r) => "Schema" in r.categoryScores) ? { Schema: avg("Schema") } : {}),
  };
  const sk = new Map();
  for (const { path, r } of perPage) for (const s of r.skipped) {
    const k = `${s.check}|${s.reason}`;
    if (!sk.has(k)) sk.set(k, { ...s, pages: [] });
    sk.get(k).pages.push(path);
  }
  const skipped = [...sk.values()].map((s) => ({ check: s.check, reason: s.pages.length === n ? s.reason : `${s.reason} (on ${listPages(s.pages)})` }));
  for (const f of failed) skipped.push({ check: `page ${f.page}`, reason: f.reason });
  return {
    ...home, startedAt, finishedAt: new Date().toISOString(),
    categoryScores, checklist, findings, counts, verdict: verdictOf(counts), skipped,
    pages: results.map(pageSummary),
    crawl: { found: crawl.found, checked: n, capped: crawl.capped, viaSitemap: crawl.viaSitemap, maxPages },
  };
}

/**
 * The report. By default it checks every page it can find from `rawUrl` by following the site's own links
 * (and sitemap.xml), up to `maxPages` (default 20); `maxPages: 1` checks only that page. The first page gets
 * the full Lighthouse median (`lighthouseRuns`); the others one Lighthouse run each, to keep the run short.
 */
export async function runReport(rawUrl, { maxPages = 20, onProgress = null, ...pageOpts } = {}) {
  if (!(maxPages > 1)) { const r = await runPageReport(rawUrl, pageOpts); return { ...r, pages: [pageSummary(r)], crawl: null }; }
  const startedAt = new Date().toISOString();
  const url = await assertSafeUrl(rawUrl, { allowPrivate: pageOpts.allowPrivate });
  onProgress?.(`Finding pages on ${new URL(url).host}…`);
  const crawl = await discoverPages(url, { allowPrivate: pageOpts.allowPrivate, maxPages });
  const list = crawl.pages.length ? crawl.pages : [url];
  onProgress?.(`Found ${list.length} page${list.length === 1 ? "" : "s"}${crawl.capped ? ` (stopped at ${maxPages}; raise --max-pages to check more)` : ""}: ${list.map(pathOf).join("  ")}`);
  const probeCache = new Map();
  const results = [], failed = [];
  for (const [i, page] of list.entries()) {
    onProgress?.(`Checking page ${i + 1} of ${list.length}: ${pathOf(page)}`);
    try {
      results.push(await runPageReport(page, { ...pageOpts, role: i === 0 ? "home" : "inner", probeCache, lighthouseRuns: i === 0 ? (pageOpts.lighthouseRuns ?? 3) : 1 }));
    } catch (e) { failed.push({ page: pathOf(page), reason: e.message }); }
  }
  if (!results.length) throw new Error(`No page could be checked: ${failed.map((f) => `${f.page}: ${f.reason}`).join("; ")}`);
  if (results.length === 1 && !failed.length) return { ...results[0], pages: [pageSummary(results[0])], crawl: { found: crawl.found, checked: 1, capped: crawl.capped, viaSitemap: crawl.viaSitemap, maxPages } };
  return mergePageReports(results, { crawl, startedAt, failed, maxPages });
}

// ============================= Renderers =============================

export function toJSON(report) { return JSON.stringify(report, null, 2); }

const VERDICT_SUMMARY = {
  urgent: (c) => `${c.high} urgent issue${c.high === 1 ? "" : "s"} could expose visitors or your site to real harm — start there before anything else.`,
  attention: (c) => `Nothing urgent, but ${c.medium} issue${c.medium === 1 ? "" : "s"} are worth fixing soon.`,
  good: () => `No high or medium issues found. Nice work — a manual review still catches things automation can't.`,
};

export function toMarkdown(report) {
  const { url, counts, verdict, findings, categoryScores = {}, checklist, skipped, brand, pages = [], crawl } = report;
  const N = pages.length || 1;
  const multi = N > 1;
  const fence = (code) => ["```", ...String(code).split("\n"), "```"];
  const findingMd = (f) => {
    const out = [`#### [${SEV_LABEL[f.severity]}] ${f.plain}`, ""];
    if (multi && f.pages?.length) out.push(`- **Found on ${f.pages.length === N ? `every page checked (${N})` : `${f.pages.length} of ${N} pages`}:** ${f.pages.map((p) => "`" + p + "`").join(", ")}`);
    out.push(`- **Why it matters:** ${f.impact}`);
    if (f.fixPlain && f.fixPlain !== f.where) out.push(`- **What to do:** ${f.fixPlain}`);
    for (const it of (f.items || []).filter((i) => i.url || i.element).slice(0, 6)) {
      out.push(`- \`${it.url ? siteRelative(it.url) + (it.line ? ":" + it.line : "") : it.element}\`${it.totalBytes ? ` — ${Math.round(it.totalBytes / 1024)} KiB` : ""}${it.wastedBytes ? `, could save ${Math.round(it.wastedBytes / 1024)} KiB` : ""}`);
    }
    if (!(f.items || []).length && f.urls?.length) out.push(`- **File(s):** ${f.urls.map((u) => "`" + siteRelative(u) + "`").join(", ")}`);
    for (const e of (f.elements || [])) {
      out.push(`- \`${e.target}\`${e.summary ? ` — ${e.summary}` : ""}${multi && e.pages?.length ? ` (${pagesPhrase(e.pages, N)})` : ""}`);
      if (e.fixed) out.push("", ...fence(e.fixed), "");
    }
    const solo = (f.elements || []).length === 1 && f.elements[0].fixed;
    if (f.where) out.push(`- **Where it goes:** ${f.where}`);
    if (f.code && !solo) out.push("", ...fence(f.code));
    else if (!f.code && f.tool && !f.variants) out.push(`- **Tool / command:** ${f.tool}`);
    for (const v of f.variants || []) out.push("", `On ${listPages(v.pages)}:`, ...fence(v.code));
    return [...out, ""];
  };

  const lines = [`# Website Precheck — ${url}`, "", `**Website assessed:** ${siteName(url)} (${url}) · ${report.startedAt}`, ""];
  if (multi) lines.push(`**${N} pages checked**${crawl?.capped ? ` (the first ${N} found — use --max-pages to check more)` : ""}: ${pages.map((p) => "`" + p.path + "`").join(" ")}`, "", `_Whole-site scores across ${N} pages:_`, "");
  if (brand?.name) lines.push(`_by ${brand.name}${brand.tagline ? " — " + brand.tagline : ""}_`, "");
  const order = SECTION_ORDER.filter((s) => s in categoryScores);
  lines.push(`| ${order.join(" | ")} |`, `|${order.map(() => "---").join("|")}|`, `| ${order.map((s) => categoryScores[s] == null ? "—" : categoryScores[s]).join(" | ")} |`, "");
  lines.push(`${VERDICT_SUMMARY[verdict](counts)} (${counts.high} high · ${counts.medium} medium · ${counts.low} low)`, "");

  lines.push("## 1 · What to do first", "");
  if (findings.length) for (const f of findings.slice(0, 5)) lines.push(...findingMd(f));
  else lines.push("Nothing to fix right now.", "");

  lines.push(`## 2 · All issues (${findings.length})`, "");
  if (findings.length) {
    lines.push(`| Priority | Section | Issue |${multi ? " Pages |" : ""}`, `|---|---|---|${multi ? "---|" : ""}`);
    for (const f of findings) lines.push(`| ${SEV_LABEL[f.severity]} | ${f.category} | ${f.plain.replace(/\|/g, "\\|")} |${multi ? ` ${!f.pages?.length ? "—" : f.pages.length === N ? `all ${N}` : f.pages.join(", ")} |` : ""}`);
    lines.push("");
  }

  if (multi) {
    lines.push(`## 3 · Page by page (${N} pages)`, "", `| Page | ${order.join(" | ")} | Issues (high/med/low) |`, `|---|${order.map(() => "---").join("|")}|---|`);
    for (const p of pages) lines.push(`| \`${p.path}\` | ${order.map((k) => p.categoryScores[k] ?? "—").join(" | ")} | ${p.counts.high}/${p.counts.medium}/${p.counts.low} |`);
    lines.push("");
    for (const p of pages) {
      lines.push(`**\`${p.path}\`** — ${p.findings.length ? `${p.findings.length} issue${p.findings.length === 1 ? "" : "s"}` : "no issues"}`, "");
      for (const f of p.findings) lines.push(`- [${SEV_LABEL[f.severity]}] ${f.category}: ${f.plain}`);
      if (p.findings.length) lines.push("");
    }
  }

  lines.push(`## ${multi ? 4 : 3} · Section by section`, "");
  for (const cat of order) {
    const s = categoryScores[cat];
    lines.push(`### ${SECTION_TITLE[cat]} — ${s == null ? "not checked" : `${s}/100 (${bandLabel(s)})`}`, "");
    lines.push(`**Why it matters:** ${SECTION_WHY[cat]}`, "", `**How this score is calculated:** ${SECTION_METHOD[cat]}${multi ? ` ${SITE_METHOD[cat]}` : ""}`, "");
    if (multi) lines.push(`**Score by page:** ${pages.map((p) => `\`${p.path}\` ${p.categoryScores[cat] ?? "—"}`).join(" · ")}`, "");
    const items = (checklist?.items || []).filter((i) => i.section === cat);
    if (items.length) {
      lines.push("**What we checked:**", "");
      for (const i of items) lines.push(`- ${i.status === "pass" ? "✓" : i.status === "fail" ? "✗" : "!"} ${i.label} — ${i.detail}`);
      lines.push("");
    }
    const fs = findings.filter((f) => f.category === cat);
    lines.push(fs.length ? "**What to do:**" : "Nothing to fix in this section.", "");
    for (const f of fs) lines.push(...findingMd(f));
  }

  if (skipped.length) {
    lines.push("## Checks that didn't run", "");
    for (const s of skipped) lines.push(`- ${s.check}: ${s.reason}`);
    lines.push("");
  }
  lines.push(
    "_This is engineering guidance, not a certification or legal advice. Automated checks are defense in depth, not a guarantee." +
    " For anything with real legal or compliance exposure (GDPR, CCPA, ADA, a security incident), a qualified professional should review it._", "",
    "_Generated by [website-precheck](https://github.com/amandamalavedev/website-precheck) — a free, open tool._"
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

const pagesPhrase = (pages, total) => (pages.length === total ? "on every page" : `on ${listPages(pages)}`);

// Each finding leads with the plain-English translation; the raw tool title/meta becomes a
// collapsed technical aside — present for anyone who wants it, never the thing you read first.
function findingCard(f, { anchor = true, total = 1 } = {}) {
  const measured = [f.savingMs ? `~${f.savingMs}ms faster` : "", f.savingKiB ? `~${f.savingKiB} KiB smaller` : ""].filter(Boolean).join(" · ");
  const kib = (b) => (b == null ? "—" : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KiB`);
  const ttl = (ms) => (ms == null ? null : ms === 0 ? "not cached" : ms < 3600000 ? `${Math.round(ms / 60000)} min` : ms < 86400000 ? `${Math.round(ms / 3600000)} h` : `${Math.round(ms / 86400000)} days`);
  // Speed: the exact files (size · could save · cache time · line)
  const items = (f.items || []).filter((it) => it.url || it.element);
  const itemTable = items.length ? `<table class="items"><thead><tr><th>File or element</th><th>Size</th><th>Could save</th>${items.some((i) => i.cacheTtlMs != null) ? "<th>Cached for</th>" : ""}</tr></thead><tbody>
      ${items.map((it) => `<tr><td><code>${esc(it.url ? siteRelative(it.url) + (it.line ? `:${it.line}` : "") : it.element)}</code></td><td>${kib(it.totalBytes)}</td><td>${it.wastedBytes ? kib(it.wastedBytes) : it.wastedMs ? `${it.wastedMs} ms` : "—"}</td>${items.some((i) => i.cacheTtlMs != null) ? `<td>${esc(ttl(it.cacheTtlMs) || "—")}</td>` : ""}</tr>`).join("")}
    </tbody></table>`
    : (f.urls && f.urls.length ? `<p class="files"><strong>File${f.urls.length > 1 ? "s" : ""}:</strong> ${f.urls.map((u) => `<code>${esc(siteRelative(u))}</code>`).join(" ")}</p>` : "");
  // Accessibility / Mobile: each failing element, why it fails, and its exact fix
  const elements = (f.elements || []).length ? `<div class="elements"><p class="el-head"><strong>Exactly where:</strong>${f.count > f.elements.length ? ` <span class="muted">(first ${f.elements.length} of ${f.count})</span>` : ""}</p>
      ${f.elements.map((e) => `<div class="el"><div><code>${esc(e.target)}</code>${total > 1 && e.pages?.length ? ` <span class="el-pages">${esc(pagesPhrase(e.pages, total))}</span>` : ""}</div>${e.html ? `<div class="el-html"><code>${esc(e.html)}</code></div>` : ""}${e.summary ? `<div class="el-why">${esc(e.summary)}</div>` : ""}${e.fixed ? `<div class="code-block small"><div class="code-label">Change it to</div><pre><code>${esc(e.fixed)}</code></pre></div>` : ""}</div>`).join("")}
    </div>` : "";
  // one element already shows its own fix — don't repeat the identical code underneath
  const soloElementFix = (f.elements || []).length === 1 && f.elements[0].fixed;
  const codeBlock = f.code && !soloElementFix
    ? `${f.where ? `<p class="where"><strong>Where it goes:</strong> ${esc(f.where)}</p>` : ""}<div class="code-block"><div class="code-label">Paste this</div><pre><code>${esc(f.code)}</code></pre></div>`
    : f.where ? `<p class="where"><strong>How to fix:</strong> ${esc(f.where)}</p>` : (f.tool ? `<p class="tool"><strong>Tool / command:</strong> ${esc(f.tool)}</p>` : "");
  const doLine = f.fixPlain && f.fixPlain !== f.where ? `<p class="do"><strong>What to do:</strong> ${esc(f.fixPlain)}</p>` : "";
  // pages that need different code (e.g. each page's own schema block) get one block each
  const variants = f.variants?.length ? f.variants.map((v) => `<div class="code-block"><div class="code-label">Paste this on ${esc(listPages(v.pages))}</div><pre><code>${esc(v.code)}</code></pre></div>`).join("") : "";
  const onPages = total > 1 && f.pages?.length ? `<p class="on-pages"><strong>Found on ${f.pages.length === total ? `every page checked (${total})` : `${f.pages.length} of ${total} pages`}:</strong> ${f.pages.slice(0, 12).map((p) => `<code>${esc(p)}</code>`).join(" ")}${f.pages.length > 12 ? ` and ${f.pages.length - 12} more` : ""}</p>` : "";
  return `<article class="finding sev-${f.severity}"${anchor && f._id ? ` id="${f._id}"` : ""}>
    <div class="finding-head">
      <span class="badge sev-${f.severity}">${SEV_LABEL[f.severity]}</span>
      <span class="cat-pill">${esc(f.category)}</span>
      <h4>${esc(f.plain)}</h4>
    </div>
    ${onPages}
    ${measured ? `<p class="measured">${esc(measured)} if fixed</p>` : ""}
    <p class="why"><strong>Why it matters:</strong> ${esc(f.impact)}</p>
    ${doLine}
    ${itemTable}
    ${elements}
    ${codeBlock}
    ${variants}
    ${f.notes?.length ? `<ul class="notes">${f.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
    <details class="tech">
      <summary>Technical details</summary>
      <p>${esc(f.title)}${f.meta ? ` <code>${esc(f.meta)}</code>` : ""}${f.axeImpact ? ` · axe impact: ${esc(f.axeImpact)}` : ""}${f.helpUrl ? ` · <a href="${esc(f.helpUrl)}" target="_blank" rel="noopener noreferrer">rule documentation</a>` : ""}</p>
      ${f.why && f.why !== f.impact ? `<p class="muted">${esc(f.why)}</p>` : ""}
    </details>
  </article>`;
}

// Order, wording and scoring method for each section — the same as the gauges at the top (Schema only with --with-schema).
const SECTION_ORDER = ["Security", "Governance", "Privacy", "Speed", "Accessibility", "Mobile", "Schema"];
const SECTION_TITLE = { Security: "Security", Governance: "Governance (data & cookies)", Privacy: "Privacy (third parties)", Speed: "Speed", Accessibility: "Accessibility", Mobile: "Mobile ready", Schema: "Schema (structured data)" };
const SECTION_WHY = {
  Security: "Whether someone could attack the site or its visitors: steal what they type, inject their own code, trick them into clicking, or read your code, keys and private files.",
  Governance: "The data your own site stores in a visitor's browser (cookies). A badly configured cookie can be stolen or sent where it shouldn't, and privacy laws (GDPR, CCPA) expect you to know and justify every one.",
  Privacy: "Which outside companies learn that someone visited — analytics, advertising and social trackers. Visitors, and laws like GDPR and CCPA, expect each one to be disclosed.",
  Speed: "Slow pages lose visitors — many mobile visitors leave a page that takes over 3 seconds — and Google ranks faster pages higher.",
  Accessibility: "About 1 in 4 adults has a disability. Screen-reader and keyboard users need these basics to use the site at all, and inaccessible US sites face ADA lawsuits.",
  Mobile: "Most visits happen on phones. A page that scrolls sideways, has buttons too small to tap, or tiny text feels broken and gets abandoned.",
  Schema: "Structured data (schema.org JSON-LD) is how Google and AI answer engines read facts about you — your name, logo, contact details and what you offer — for rich search results and accurate AI answers.",
};
const SECTION_METHOD = {
  Security: "Starts at 100. Each failed critical check (HTTPS, the http→https redirect, the Content-Security-Policy, insecure content, or anything that exposes your code, keys or private files) costs 25 points; each other failed check costs 10; each warning costs 4.",
  Governance: "Starts at 100. Each High issue costs 25 points, each Medium 10, each Low 4 — e.g. a cookie missing Secure is High, a cookie missing SameSite is Medium.",
  Privacy: "Starts at 100. Each High issue costs 25 points, each Medium 10, each Low 4 — e.g. trackers loading with no privacy policy linked is High.",
  Speed: "Google Lighthouse's Performance score, taken as the middle (median) of several runs. It blends five measurements: Total Blocking Time 30%, Largest Contentful Paint 25%, Cumulative Layout Shift 25%, First Contentful Paint 10%, Speed Index 10%.",
  Accessibility: "Starts at 100. The axe-core engine tests the WCAG 2.1 A/AA rules; each failing rule costs 25 points if it's critical (blocks a disabled visitor outright), 10 if serious, 4 if moderate or minor.",
  Mobile: "Four checks on a 390×844 phone screen, 25 points each: a mobile viewport tag, no sideways scrolling, buttons and links at least 24×24px, and text at least 12px.",
  Schema: "How complete your structured data is: the share of each type's recommended properties that are filled in, averaged over the blocks found. No structured data at all scores 0.",
};
// Added to "How this score is calculated" when the report covers several pages
const SITE_METHOD = {
  Security: "Across the whole site: every page is checked, and a check that fails on any page fails for the site.",
  Governance: "Across the whole site: the lowest page's score counts — one badly set cookie is a site problem.",
  Privacy: "Across the whole site: the lowest page's score counts — one undisclosed tracker is a site problem.",
  Speed: "Across the whole site: the average of every page's score (the starting page uses the median of several runs, the others one run each).",
  Accessibility: "Across the whole site: the average of every page's score.",
  Mobile: "Across the whole site: the average of every page's score.",
  Schema: "Across the whole site: the average of every page's score (a page with no structured data scores 0).",
};
const fmtSec = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)} s`);
const bandLabel = (s) => (s == null ? "Not checked" : s >= 90 ? "Good" : s >= 50 ? "Needs improvement" : "Poor");

// Core Web Vitals thresholds, as Google publishes them (good ≤ first number, poor > second)
const CWV = [
  ["lcpMs", "Largest Contentful Paint (LCP)", "When the main content (usually the biggest image or heading) appears", 2500, 4000, "ms"],
  ["tbtMs", "Total Blocking Time (TBT)", "How long the page is frozen by scripts while loading (stands in for responsiveness)", 200, 600, "ms"],
  ["cls", "Cumulative Layout Shift (CLS)", "How much the layout jumps around as it loads", 0.1, 0.25, ""],
  ["fcpMs", "First Contentful Paint (FCP)", "When anything first appears on screen", 1800, 3000, "ms"],
  ["speedIndexMs", "Speed Index", "How quickly the visible page fills in", 3400, 5800, "ms"],
  ["ttfbMs", "Server response (TTFB)", "How long the server takes to start answering", 800, 1800, "ms"],
];

export function toHTML(report) {
  const { url, startedAt, categoryScores, counts, verdict, findings, headers, a11y, cookies, privacy, schema, lighthouse, mobile, checklist, platform, page, skipped, brand, pages = [], crawl } = report;
  const N = pages.length || 1;
  const multi = N > 1;
  const date = new Date(startedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  findings.forEach((f, i) => { f._id = `f${i + 1}`; });
  const idByKey = new Map(findings.map((f) => [f.key || `${f.category}|${f.plain}`, f._id]));
  const pageSlug = (p) => "page-" + (p.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home");
  const skipNote = (check) => { const s = skipped.find((x) => x.check === check); return `<p class="muted">Not checked${s ? ": " + esc(s.reason) : ""}.</p>`; };
  const sections = SECTION_ORDER.filter((s) => s in categoryScores);
  const slug = (s) => "sec-" + s.toLowerCase();

  const topGauges = sections.map((k) => `<a class="gauge-link" href="#${slug(k)}">${categoryScores[k] == null
    ? `<div class="gauge"><div class="gauge-ring none"><span>—</span></div><div class="gauge-label">${esc(k)}</div></div>`
    : gauge(k, categoryScores[k])}</a>`).join("");

  // ---------- WHAT TO DO FIRST
  const first = findings.slice(0, 5);
  const firstHTML = first.map((f) => findingCard(f, { anchor: false, total: N })).join("") || `<p class="all-clear">Nothing to fix right now.</p>`;

  // ---------- ALL ISSUES
  const pagesCell = (f) => !f.pages?.length ? "—" : f.pages.length === N ? `All ${N}` : f.pages.length <= 3 ? f.pages.map((p) => `<code>${esc(p)}</code>`).join(" ") : `${f.pages.length} pages`;
  const allRows = findings.map((f) => `<tr><td><span class="badge sev-${f.severity}">${SEV_LABEL[f.severity]}</span></td><td>${esc(f.category)}</td><td><a href="#${f._id}">${esc(f.plain)}</a></td>${multi ? `<td class="pages-cell">${pagesCell(f)}</td>` : ""}</tr>`).join("");
  const allHTML = findings.length
    ? `<table class="all-issues"><thead><tr><th>Priority</th><th>Section</th><th>Issue (click for the fix)</th>${multi ? "<th>Pages</th>" : ""}</tr></thead><tbody>${allRows}</tbody></table>`
    : `<p class="all-clear">No issues found in any section.</p>`;

  // ---------- PAGE BY PAGE (whole-site runs)
  const cell = (s) => s == null ? `<td class="sc none">—</td>` : `<td class="sc ${scoreBand(s)}">${s}</td>`;
  const pageRows = pages.map((p) => `<tr><td><a href="#${pageSlug(p.path)}"><code>${esc(p.path)}</code></a></td>${sections.map((k) => cell(p.categoryScores[k])).join("")}<td class="issues-cell">${p.counts.high ? `<span class="pill high">${p.counts.high}</span>` : ""}${p.counts.medium ? `<span class="pill medium">${p.counts.medium}</span>` : ""}${p.counts.low ? `<span class="pill low">${p.counts.low}</span>` : ""}${!p.findings.length ? `<span class="ok">✓ none</span>` : ""}</td></tr>`).join("");
  const pageDetails = pages.map((p) => `<details class="page-detail" id="${pageSlug(p.path)}"${p.findings.some((f) => f.severity === "high") ? " open" : ""}>
      <summary><code>${esc(p.path)}</code> <span class="muted">— ${p.findings.length ? `${p.findings.length} issue${p.findings.length === 1 ? "" : "s"}` : "no issues"}</span></summary>
      <p class="muted"><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url)}</a>${p.metrics ? ` · LCP ${fmtSec(p.metrics.lcpMs)} · CLS ${p.metrics.cls == null ? "—" : Number(p.metrics.cls).toFixed(3)} · TBT ${p.metrics.tbtMs == null ? "—" : Math.round(p.metrics.tbtMs) + " ms"}${p.lighthouseRuns ? ` (${p.lighthouseRuns === 1 ? "1 Lighthouse run" : `median of ${p.lighthouseRuns} runs`})` : ""}` : ""}</p>
      ${p.findings.length ? `<ul class="page-issues">${p.findings.map((f) => `<li><span class="badge sev-${f.severity}">${SEV_LABEL[f.severity]}</span> <span class="cat-pill">${esc(f.category)}</span> ${idByKey.has(f.key) ? `<a href="#${idByKey.get(f.key)}">${esc(f.plain)}</a>` : esc(f.plain)}</li>`).join("")}</ul>` : `<p class="all-clear">Nothing to fix on this page.</p>`}
    </details>`).join("");
  const pageByPage = multi ? `<div class="card">
    <h2>3 · Page by page (${N} pages)</h2>
    <p class="muted">Each page's own scores. Click a page for its issues; each issue links to its fix above.</p>
    <div class="table-scroll"><table class="pages-table"><thead><tr><th>Page</th>${sections.map((k) => `<th>${esc(k === "Accessibility" ? "A11y" : k === "Governance" ? "Gov." : k)}</th>`).join("")}<th>Issues</th></tr></thead><tbody>${pageRows}</tbody></table></div>
    ${pageDetails}
  </div>` : "";
  const scoreByPage = (cat) => !multi ? "" : `<details class="by-page"><summary>Score by page</summary><table class="items"><thead><tr><th>Page</th><th>Score</th>${cat === "Speed" ? "<th>LCP</th><th>CLS</th><th>TBT</th>" : ""}</tr></thead><tbody>${pages.map((p) => `<tr><td><a href="#${pageSlug(p.path)}"><code>${esc(p.path)}</code></a></td>${cell(p.categoryScores[cat])}${cat === "Speed" ? `<td>${p.metrics ? fmtSec(p.metrics.lcpMs) : "—"}</td><td>${p.metrics?.cls != null ? Number(p.metrics.cls).toFixed(3) : "—"}</td><td>${p.metrics?.tbtMs != null ? Math.round(p.metrics.tbtMs) + " ms" : "—"}</td>` : ""}</tr>`).join("")}</tbody></table></details>`;

  // ---------- per-section "what we checked"
  const tick = (st) => (st === "pass" ? "✓" : st === "fail" ? "✗" : "!");
  const checkList = (items) => `<ul class="checklist checklist-why">${items.map((i) => `<li class="${i.status}"><span class="tick">${tick(i.status)}</span><div><div class="checklist-name">${esc(i.label)}</div><div class="checklist-why-text">${esc(i.detail)}</div></div></li>`).join("")}</ul>`;
  const fmtMs = (v) => (v == null ? "—" : v >= 1000 ? (v / 1000).toFixed(2) + " s" : Math.round(v) + " ms");

  const checked = {
    Security: () => checklist ? checkList(checklist.items.filter((i) => i.section === "Security")) + `<p class="muted">Host detected: <strong>${esc(platform?.name || "unknown")}</strong> — every fix below is written for it.</p>` : skipNote("headers"),
    Governance: () => !cookies ? skipNote("cookies") : (checklist ? checkList(checklist.items.filter((i) => i.section === "Governance")) : "")
      + (cookies.cookies.length ? `<table class="items"><thead><tr><th>Cookie</th><th>Secure</th><th>SameSite</th><th>HttpOnly</th></tr></thead><tbody>${cookies.cookies.map((c) => `<tr><td><code>${esc(c.name)}</code></td><td>${c.secure ? "✓" : "✗"}</td><td>${esc(c.sameSite || "✗ not set")}</td><td>${c.httpOnly ? "✓" : "—"}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">The page set no cookies when first loaded. (Cookies set later — after a login, or after accepting a banner — aren't seen by this check.)</p>`),
    Privacy: () => !privacy ? skipNote("privacy") : (checklist ? checkList(checklist.items.filter((i) => i.section === "Privacy")) : "")
      + (privacy.thirdParty.length ? `<p><strong>Outside servers this page loads from:</strong></p><ul class="checklist">${privacy.thirdParty.map((t) => `<li class="${t.label ? "warn" : "pass"}"><span class="tick">${t.label ? "!" : "·"}</span> <code>${esc(t.host)}</code> ${t.label ? `<strong>${esc(t.label)}</strong> — a tracker` : "— not a known tracker (e.g. a font or file host)"}</li>`).join("")}</ul>` : `<p class="muted">The page loads nothing from outside servers.</p>`),
    Speed: () => !lighthouse ? skipNote("lighthouse") : `${lighthouse.testConditions ? `<p class="tested-as">Tested as <strong>${esc(lighthouse.testConditions.device)}</strong> on <strong>${esc(lighthouse.testConditions.networkLabel)}</strong>${lighthouse.testConditions.rttMs != null ? ` (${lighthouse.testConditions.rttMs} ms round-trip, ${lighthouse.testConditions.downloadKbps} Kbps down, ${lighthouse.testConditions.cpuSlowdown}× slower CPU)` : ""} — ${lighthouse.runs === 1 ? "1 run, scored " + lighthouse.scores[0] : lighthouse.runs + " runs scored " + lighthouse.scores.join(", ") + "; the middle one counts"}.</p>` : ""}
      <table class="cwv"><thead><tr><th>Measurement</th><th>Your page</th><th>Good</th><th>Poor</th><th>Rating</th></tr></thead><tbody>
      ${CWV.map(([k, name, what, good, poor, unit]) => { const v = lighthouse.metrics[k]; const r = v == null ? "—" : v <= good ? "Good" : v <= poor ? "Needs improvement" : "Poor"; const show = (x) => unit ? fmtMs(x) : (x ?? 0).toFixed(3).replace(/0+$/, "").replace(/\.$/, ""); return `<tr><td><strong>${esc(name)}</strong><div class="muted">${esc(what)}</div></td><td>${v == null ? "—" : show(v)}</td><td>≤ ${show(good)}</td><td>&gt; ${show(poor)}</td><td><span class="rating ${r === "Good" ? "good" : r === "Poor" ? "bad" : "mid"}">${r}</span></td></tr>`; }).join("")}
      </tbody></table>
      ${lighthouse.lcpElement ? `<p class="muted">The "main content" Lighthouse timed (LCP element): <code>${esc(lighthouse.lcpElement.slice(0, 160))}</code></p>` : ""}
      ${lighthouse.reportPath ? `<p class="muted">Full Lighthouse report (every audit and trace): <code>${esc(lighthouse.reportPath)}</code></p>` : ""}`,
    Accessibility: () => !a11y ? skipNote("a11y") : `<p>${a11y.passes} automated rule${a11y.passes === 1 ? "" : "s"} passed; ${a11y.violations.length} failed${a11y.violations.length ? ` (${a11y.total} element${a11y.total === 1 ? "" : "s"} in total)` : ""}.</p>
      ${a11y.incompleteDetail?.length ? `<p><strong>Check these by eye</strong> — the automated check couldn't decide (e.g. text over an image or a gradient):</p><ul class="checklist">${a11y.incompleteDetail.map((r) => `<li class="warn"><span class="tick">!</span><div><div class="checklist-name">${esc(r.help)} (${r.count})</div><div class="checklist-why-text">${r.nodes.map((n) => `<code>${esc(n.target)}</code>`).join(" ")}</div></div></li>`).join("")}</ul>` : ""}
      <p class="muted">Automated checks catch roughly a third to half of real accessibility problems — also try the site with only a keyboard (Tab, Enter) and with a screen reader.</p>`,
    Mobile: () => !mobile ? skipNote("mobile") : checkList([
      { status: mobile.checks.viewport.ok ? "pass" : "fail", label: "Mobile viewport tag", detail: mobile.checks.viewport.value ? `<meta name="viewport" content="${mobile.checks.viewport.value}">${mobile.checks.viewport.zoomBlocked ? " — blocks pinch-zoom" : ""}` : "Missing — phones will show a shrunken desktop page." },
      { status: mobile.checks.overflow.ok ? "pass" : "fail", label: "No sideways scrolling", detail: `Page is ${mobile.checks.overflow.scrollWidth}px wide on a ${mobile.checks.overflow.screenWidth}px screen.` },
      { status: mobile.checks.tap.ok ? "pass" : "fail", label: "Buttons and links big enough to tap (24×24px)", detail: `${mobile.checks.tap.small.length} of ${mobile.checks.tap.checked} too small.` },
      { status: mobile.checks.text.ok ? "pass" : "fail", label: "Text readable without zooming (12px+)", detail: `${mobile.checks.text.tiny.length} piece${mobile.checks.text.tiny.length === 1 ? "" : "s"} of text too small.` },
    ]) + `<p class="muted">Tested as: ${esc(mobile.device)}.</p>`,
    Schema: () => !schema ? skipNote("schema") : schema.hasSchema
      ? `<ul class="checklist">${schema.blocks.map((b) => `<li class="${!b.recognized || b.score === 100 ? "pass" : "warn"}"><span class="tick">${!b.recognized ? "·" : b.score === 100 ? "✓" : "!"}</span> ${esc(b.type)} ${b.recognized ? `— ${b.score}% complete${b.missing?.length ? ` (missing: ${esc(b.missing.join(", "))})` : ""}` : "— present, not scored"}</li>`).join("")}</ul>`
      : `<p class="muted">No structured data on this page. The block in "What to do" below is ready to paste.</p>`,
  };

  const sectionHTML = sections.map((cat) => {
    const s = categoryScores[cat];
    const items = findings.filter((f) => f.category === cat);
    return `<section class="card section" id="${slug(cat)}">
      <div class="sec-head"><h2>${esc(SECTION_TITLE[cat])}</h2><div class="sec-score ${s == null ? "none" : scoreBand(s)}"><span>${s == null ? "—" : s}</span><small>${s == null ? "" : "/100 · "}${bandLabel(s)}</small></div></div>
      <p class="sec-why"><strong>Why it matters:</strong> ${esc(SECTION_WHY[cat])}</p>
      <p class="sec-method"><strong>How this score is calculated:</strong> ${esc(SECTION_METHOD[cat])}${multi ? ` ${esc(SITE_METHOD[cat])}` : ""}</p>
      <h3>What we checked</h3>
      ${scoreByPage(cat)}
      ${multi && cat !== "Security" ? `<p class="home-label">In detail, ${esc(pages[0].path)} (the page the check started from):</p>` : ""}
      ${checked[cat]()}
      <h3>What to do${items.length ? ` <span class="count">${items.length}</span>` : ""}</h3>
      ${items.length ? items.map((f) => findingCard(f, { total: N })).join("") : `<p class="all-clear">Nothing to fix in this section.</p>`}
    </section>`;
  }).join("");

  const VERDICT_TITLE = { urgent: "Urgent issues found", attention: "A few things worth fixing", good: "Looking good" };

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
  .wrap{max-width:900px; margin:0 auto;}
  a{color:var(--accent);}
  header.top{display:flex; flex-wrap:wrap; justify-content:space-between; align-items:baseline; gap:8px; margin-bottom:24px;}
  header.top h1{font-size:20px; margin:0;}
  header.top .meta{color:var(--ink-faint); font-size:13px;}
  .assessed{display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 12px; margin:-6px 0 18px; padding:14px 18px; background:var(--card); border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:12px;}
  .assessed-lbl{width:100%; font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-faint);}
  .assessed-site{font-size:24px; font-weight:800; color:var(--ink); text-decoration:none; word-break:break-all;}
  .assessed-url{font-size:13px; color:var(--ink-faint); word-break:break-all;}
  .card{background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px 22px; margin-bottom:20px;}
  .card > h2, .part-title{font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--ink-dim); margin:0 0 14px;}
  .part-title{margin:28px 0 12px; font-size:15px; color:var(--ink);}
  .top-gauges{display:flex; flex-wrap:wrap; gap:18px; justify-content:center;}
  .gauge-link{text-decoration:none; color:inherit;}
  .gauge{display:flex; flex-direction:column; align-items:center; gap:8px; width:90px;}
  .gauge-ring{position:relative; width:72px; height:72px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:20px; font-weight:700;}
  .gauge-ring::before{content:""; position:absolute; inset:0; border-radius:50%; background:conic-gradient(var(--ring-color,var(--good)) var(--deg,0deg), var(--line) 0);}
  .gauge-ring::after{content:""; position:absolute; inset:8px; border-radius:50%; background:var(--card);}
  .gauge-ring span{position:relative; z-index:1;}
  .gauge-ring.good{--ring-color:var(--good); color:var(--good);}
  .gauge-ring.mid{--ring-color:var(--mid); color:var(--mid);}
  .gauge-ring.bad{--ring-color:var(--bad); color:var(--bad);}
  .gauge-ring.none{--ring-color:var(--line); color:var(--ink-faint);}
  .gauge-label{font-size:12px; color:var(--ink-dim); text-align:center;}
  .legend{text-align:center; font-size:12px; color:var(--ink-faint); margin-top:10px;}
  .intro{color:var(--ink-dim); font-size:13.5px;}
  .intro .disclaimer{display:block; margin-top:8px; font-size:12px; color:var(--ink-faint); font-style:italic;}
  .verdict{display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; border-left:5px solid var(--verdict-color,var(--good));}
  .verdict.urgent{--verdict-color:var(--bad);} .verdict.attention{--verdict-color:var(--mid);} .verdict.good{--verdict-color:var(--good);}
  .verdict h2{margin:0 0 4px; font-size:19px; color:var(--verdict-color); text-transform:none; letter-spacing:0;}
  .verdict p{margin:0; color:var(--ink-dim);}
  .counts{display:flex; gap:8px; flex-wrap:wrap;}
  .pill{border-radius:999px; padding:5px 12px; font-size:13px; font-weight:700;}
  .pill.high{background:var(--bad-bg); color:var(--bad);} .pill.medium{background:var(--mid-bg); color:var(--mid);} .pill.low{background:var(--good-bg); color:var(--good);}
  .badge{display:inline-block; border-radius:6px; padding:2px 8px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; flex-shrink:0;}
  .badge.sev-high{background:var(--bad-bg); color:var(--bad);} .badge.sev-medium{background:var(--mid-bg); color:var(--mid);} .badge.sev-low{background:var(--good-bg); color:var(--good);}
  .cat-pill{display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:11px; font-weight:600; color:var(--ink-dim); flex-shrink:0;}
  table{width:100%; border-collapse:collapse; font-size:13.5px; margin:8px 0 12px;}
  th{text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--ink-faint); padding:6px 8px; border-bottom:2px solid var(--line);}
  td{padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; color:var(--ink-dim);}
  td code{word-break:break-all;}
  .all-issues td:first-child{width:90px;} .all-issues td:nth-child(2){width:120px; font-weight:600; color:var(--ink);}
  .rating{font-weight:700; font-size:12px; border-radius:6px; padding:2px 8px; white-space:nowrap;}
  .rating.good{background:var(--good-bg); color:var(--good);} .rating.mid{background:var(--mid-bg); color:var(--mid);} .rating.bad{background:var(--bad-bg); color:var(--bad);}
  .section{scroll-margin-top:12px;}
  .sec-head{display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; border-bottom:1px solid var(--line); padding-bottom:12px; margin-bottom:12px;}
  .sec-head h2{margin:0; font-size:20px; text-transform:none; letter-spacing:0; color:var(--ink);}
  .sec-score{display:flex; align-items:baseline; gap:6px; font-weight:800;}
  .sec-score span{font-size:30px;} .sec-score small{font-size:13px; font-weight:600; color:var(--ink-dim);}
  .sec-score.good span{color:var(--good);} .sec-score.mid span{color:var(--mid);} .sec-score.bad span{color:var(--bad);} .sec-score.none span{color:var(--ink-faint);}
  .sec-why,.sec-method{font-size:13.5px; color:var(--ink-dim); margin:6px 0;}
  .sec-method{background:var(--bg); border-radius:8px; padding:8px 12px;}
  .section h3{font-size:14px; margin:18px 0 8px; color:var(--ink);}
  .section h3 .count{color:var(--ink-faint); font-weight:400;}
  article.finding{border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin-bottom:10px; background:var(--bg); scroll-margin-top:12px;}
  article.finding:target{outline:2px solid var(--accent);}
  .finding-head{display:flex; align-items:baseline; gap:8px; margin-bottom:8px; flex-wrap:wrap;}
  .finding-head h4{margin:0; font-size:14.5px; color:var(--ink); line-height:1.45;}
  article.finding p{margin:5px 0; font-size:13.5px; color:var(--ink-dim);}
  article.finding p strong{color:var(--ink);}
  article.finding p.measured{display:inline-block; background:var(--good-bg); color:var(--good); font-size:12px; font-weight:700; border-radius:6px; padding:2px 8px;}
  p.where{background:var(--card); border-left:3px solid var(--accent); padding:6px 10px; border-radius:4px;}
  .elements{margin:8px 0;}
  .el{border-top:1px dashed var(--line); padding:8px 0;}
  .el-html code{font-size:12px; color:var(--ink-faint);}
  .el-why{font-size:12.5px; color:var(--bad); margin-top:2px;}
  .code-block{margin:8px 0; border-radius:6px; overflow:hidden; border:1px solid var(--line);}
  .code-label{background:var(--line); color:var(--ink-dim); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; padding:5px 10px;}
  .code-block pre{margin:0; padding:12px 14px; overflow-x:auto; background:#0b1220; color:#d6e2f5; font-size:12.5px; line-height:1.55;}
  .code-block.small pre{padding:8px 12px; font-size:12px;}
  .code-block pre code{background:none; border:none; padding:0; color:inherit; font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace; white-space:pre;}
  ul.notes{margin:6px 0; padding-left:18px; font-size:12.5px; color:var(--ink-dim);}
  details.tech{margin-top:8px;}
  details.tech summary{cursor:pointer; font-size:12px; color:var(--ink-faint);}
  details.tech p{margin:6px 0 0; font-size:12.5px;}
  .all-clear{color:var(--good); font-weight:600;}
  ul.checklist{list-style:none; margin:0 0 10px; padding:0; display:flex; flex-direction:column; gap:7px; font-size:13.5px;}
  ul.checklist li{display:flex; align-items:flex-start; gap:8px;}
  ul.checklist .tick{font-weight:800; width:16px; text-align:center; flex-shrink:0;}
  ul.checklist li.pass .tick{color:var(--good);} ul.checklist li.fail .tick{color:var(--bad);} ul.checklist li.warn .tick{color:var(--mid);}
  .checklist-name{font-weight:600; color:var(--ink);}
  .checklist-why-text{color:var(--ink-faint); font-size:12.5px;}
  code{background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:1px 5px; font-size:12.5px;}
  .muted{color:var(--ink-faint); font-size:13px;}
  p.tested-as{font-size:13px; color:var(--ink-dim);}
  .brand-block{display:flex; align-items:center; gap:10px;}
  .brand-block img{width:36px; height:36px; border-radius:8px;}
  .brand-block .brand-text h1{font-size:19px; margin:0;}
  .brand-block .brand-text .brand-by{font-size:12px; color:var(--ink-faint);}
  .assessed-pages{width:100%; font-size:13px; color:var(--ink-dim); margin-top:6px; line-height:1.9;}
  .assessed-pages code, .on-pages code, .pages-cell code{white-space:nowrap;}
  p.on-pages{background:var(--card); border:1px dashed var(--line); border-radius:6px; padding:6px 10px; font-size:13px;}
  .el-pages{font-size:12px; color:var(--ink-faint); margin-left:6px;}
  .table-scroll{overflow-x:auto;}
  .pages-table th, .pages-table td{text-align:center; white-space:nowrap;}
  .pages-table th:first-child, .pages-table td:first-child{text-align:left;}
  td.sc{font-weight:800;} td.sc.good{color:var(--good);} td.sc.mid{color:var(--mid);} td.sc.bad{color:var(--bad);} td.sc.none{color:var(--ink-faint);}
  .issues-cell .pill{padding:2px 8px; margin-right:3px; font-size:12px;} .issues-cell .ok{color:var(--good); font-weight:600; font-size:12.5px;}
  details.page-detail{border-top:1px solid var(--line); padding:8px 0; scroll-margin-top:12px;}
  details.page-detail summary{cursor:pointer; font-weight:600;}
  details.page-detail:target{outline:2px solid var(--accent); border-radius:6px;}
  ul.page-issues{list-style:none; margin:6px 0 4px; padding:0; display:flex; flex-direction:column; gap:6px; font-size:13.5px;}
  details.by-page{margin:0 0 10px;} details.by-page summary{cursor:pointer; font-size:13px; font-weight:600; color:var(--accent);}
  .home-label{font-size:12.5px; color:var(--ink-faint); margin:4px 0 6px; font-style:italic;}
  footer{text-align:center; color:var(--ink-faint); font-size:12px; margin-top:24px;}
  @media print{ body{background:#fff;} .card,article.finding{break-inside:avoid; border-color:#ccc;} }
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
    ${multi ? `<span class="assessed-pages"><strong>${N} pages checked</strong>${crawl?.capped ? ` (the first ${N} found — run with <code>--max-pages</code> to check more)` : ""}, found by following the site's own links${crawl?.viaSitemap ? " and its sitemap.xml" : ""}: ${pages.map((p) => `<a href="#${pageSlug(p.path)}"><code>${esc(p.path)}</code></a>`).join(" ")}</span>` : crawl ? `<span class="assessed-pages">1 page checked — no other pages were linked from it.</span>` : ""}
  </div>

  <div class="card">
    <div class="top-gauges">${topGauges}</div>
    <p class="legend">${multi ? `Whole-site scores across ${N} pages · ` : ""}Scores out of 100 · 90+ Good · 50–89 Needs improvement · under 50 Poor · click a score to jump to its section</p>
  </div>

  <div class="card verdict ${verdict}">
    <div><h2>${VERDICT_TITLE[verdict]}</h2><p>${esc(VERDICT_SUMMARY[verdict](counts))}</p></div>
    <div class="counts"><span class="pill high">${counts.high} high</span><span class="pill medium">${counts.medium} medium</span><span class="pill low">${counts.low} low</span></div>
  </div>

  <div class="card">
    <h2>1 · What to do first</h2>
    ${firstHTML}
  </div>

  <div class="card">
    <h2>2 · All issues (${findings.length})</h2>
    ${allHTML}
  </div>

  ${pageByPage}

  <h2 class="part-title">${multi ? 4 : 3} · Section by section</h2>
  ${sectionHTML}

  <div class="card intro">
    <strong>About this report.</strong> It checks ${sections.length} things on ${multi ? `${N} pages of ${esc(siteName(url))}` : esc(url)} — Security, Governance (data &amp; cookies), Privacy (third parties), ${sections.map((k) => esc(SECTION_TITLE[k])).join(", ")} — from the outside, the way any visitor's browser sees the site.${platform?.id && platform.id !== "unknown" ? ` The site is served by ${esc(platform.name)}, so fixes are written for it.` : ""} Your own code can't be seen from outside: for anything that lives in your project, the Claude skill (site-hardening-and-speed) finds the exact file and makes the change.${brand?.tagline ? `<br><br><strong>Why ${esc(brand.name || "we")} built this:</strong> ${esc(brand.tagline)}` : ""}
    <span class="disclaimer">This is engineering guidance, not a certification or legal advice. Automated checks are defense in depth, not a guarantee — they catch real, common issues but not everything. For anything with real legal or compliance exposure (GDPR, CCPA, ADA, a security incident), a qualified professional should review it.</span>
  </div>

  <footer>Generated by <a href="https://github.com/amandamalavedev/website-precheck">website-precheck</a>${brand?.url ? ` · <a href="${esc(brand.url)}">${esc(brand.name)}</a>` : ""} — a free, open tool.${brand?.copyright ? `<br>${esc(brand.copyright)}` : ""}</footer>
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
  if (!rawUrl) { console.error("Usage: node report.mjs <url> [--out dir] [--max-pages N (default 20)] [--single] [--with-schema] [--skip-lighthouse] [--skip-a11y] [--skip-cookies] [--skip-video] [--skip-privacy] [--skip-schema] [--allow-private] [--brand-name N] [--brand-logo path] [--brand-tagline T] [--brand-url U] [--brand-copyright C]"); process.exit(2); }
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
      skipMobile: flag(args, "skip-mobile"),
      skipCookies: flag(args, "skip-cookies"),
      skipVideo: flag(args, "skip-video"),
      skipPrivacy: flag(args, "skip-privacy"),
      skipSchema: !flag(args, "with-schema"),
      lighthouseRuns: Number(opt("runs", "3")) || 3,
      lighthouseForm: opt("form", "mobile"),
      brand,
      maxPages: flag(args, "single") ? 1 : Math.max(1, Math.min(100, Number(opt("max-pages", "20")) || 20)),
      onProgress: (msg) => process.stderr.write(`\n▸ ${msg}\n`),
    });
  } catch (e) {
    console.error(/private|local|valid URL/i.test(e.message) ? "Refused: " + e.message : e.message);
    process.exit(/private|local|valid URL/i.test(e.message) ? 2 : 1);
  }

  let files;
  try { files = writeReportFiles(report, outDir); }
  catch (e) { console.error("Could not write report: " + e.message); process.exit(1); }

  console.log(toMarkdown(report));
  // Full locations, not paths relative to wherever the command happened to run — people couldn't
  // tell where the report went or how to open it (2026-10-02).
  const abs = (p) => resolve(p);
  console.log(`
────────────────────────────────────────────────────────────
  Your report is ready.

  Paste this in your browser to see the full report:
    ${pathToFileURL(abs(files.html)).href}

  Or open this folder and double-click precheck-report.html:
    ${resolve(outDir)}

  Also saved (same folder): precheck-report.md (text) · precheck-report.json (data)
────────────────────────────────────────────────────────────`);
  process.exitCode = Math.min(report.counts.high, 250);
}
