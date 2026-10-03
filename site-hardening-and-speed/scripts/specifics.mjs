// Site-specific answers for the report — so a finding says WHAT exactly, WHERE exactly, and WHAT TO
// PASTE for this site, instead of a template (Amanda, 2026-10-02: "it provides generic fixes — it does
// not tell you specifically what to fix").
//
//   detectPlatform(headers)          which host serves the site, from its own response headers
//   readPageProfile(url)             one fetch of the page: what it loads, from where, and its metadata
//   buildCsp(profile)                a Content-Security-Policy built from what the page actually loads
//   headerFixFor(platform, headers)  ALL missing headers as one ready-to-paste config for that host
//   contrastFix(fg, bg, ratio)       the nearest colour that passes, for an axe colour-contrast failure
//   schemaFor(profile)               a JSON-LD block pre-filled from the page's own title/description/logo
//
// No dependencies; regex-level HTML reading is enough for "what does this page reference" and keeps the
// tool installable anywhere. Everything here is advisory output — nothing is executed or written.
import { createHash } from "node:crypto";
import { safeFetch, readTextCapped } from "./safe.mjs";

const MAX_PAGE_CHARS = 2_000_000;

// ---------------------------------------------------------------- hosting platform
/** Identify the host from response headers. `h` is a plain object of lowercased header names. */
export function detectPlatform(h = {}) {
  const has = (k) => h[k] != null;
  const server = String(h.server || "").toLowerCase();
  if (server.includes("netlify") || has("x-nf-request-id")) return { id: "netlify", name: "Netlify" };
  if (server.includes("vercel") || has("x-vercel-id")) return { id: "vercel", name: "Vercel" };
  if (has("cf-ray") && (has("cf-pages") || String(h["x-powered-by"] || "").includes("Cloudflare Pages"))) return { id: "cloudflare-pages", name: "Cloudflare Pages" };
  if (server.includes("github.com")) return { id: "github-pages", name: "GitHub Pages" };
  if (server.startsWith("railway")) return { id: "railway", name: "Railway" };
  if (has("x-render-origin-server") || has("rndr-id")) return { id: "render", name: "Render" };
  if (has("fly-request-id")) return { id: "fly", name: "Fly.io" };
  if (has("x-amz-cf-id") || server === "amazons3") return { id: "aws", name: "AWS (CloudFront/S3)" };
  if (has("x-firebase-hosting") || server.includes("google frontend") && has("x-cloud-trace-context")) return { id: "google", name: "Google Cloud / Firebase" };
  if (has("cf-ray")) return { id: "cloudflare", name: "Cloudflare (in front of your server)" };
  if (String(h["x-powered-by"] || "").toLowerCase().includes("express")) return { id: "express", name: "Node.js / Express" };
  if (server.startsWith("nginx")) return { id: "nginx", name: "nginx" };
  if (server.startsWith("apache")) return { id: "apache", name: "Apache" };
  if (server.includes("microsoft-iis")) return { id: "iis", name: "Microsoft IIS" };
  return { id: "unknown", name: "an unidentified host" };
}

// ---------------------------------------------------------------- the page itself
const attr = (tag, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag); return m ? (m[2] ?? m[3] ?? m[4] ?? "").trim() : null; };
const originOf = (u, base) => { try { const x = new URL(u, base); return /^https?:$/.test(x.protocol) ? x.origin : null; } catch { return null; } };
const decodeEntities = (s) => s == null ? s : String(s)
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const sha256 = (s) => "'sha256-" + createHash("sha256").update(s, "utf8").digest("base64") + "'";

/** Read the page once and describe what it loads (by type and origin) and what it says about itself. */
export async function readPageProfile(rawUrl, { allowPrivate = false } = {}) {
  const { res, finalUrl } = await safeFetch(rawUrl, { allowPrivate, init: { headers: { "User-Agent": "website-precheck/1.0 (+page-profile)" } } });
  const html = await readTextCapped(res, MAX_PAGE_CHARS);
  return profileFromHtml(html, finalUrl || rawUrl);
}

export function profileFromHtml(html, pageUrl) {
  const self = originOf(pageUrl, pageUrl);
  const ext = (u) => { const o = originOf(u, pageUrl); return o && o !== self ? o : null; };
  const add = (set, v) => { if (v) set.add(v); };
  const scripts = new Set(), styles = new Set(), fonts = new Set(), images = new Set(), frames = new Set(), forms = new Set(), connects = new Set();
  const inlineScriptHashes = [];
  let inlineStyles = false;
  const inlineHandlers = [];
  const mixedContent = [];      // http:// subresources on an https page — browsers block or warn
  const scriptsWithoutSri = []; // third-party <script src> with no integrity= fingerprint
  const firstPartyScripts = []; // the site's own JS files — scanned for leaked keys and source maps
  const isHttpsPage = /^https:/i.test(pageUrl);
  const noteMixed = (u) => { if (isHttpsPage && /^http:\/\//i.test(u || "") && mixedContent.length < 8) mixedContent.push(u); };

  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attrs, body] = m;
    const src = attr(attrs, "src");
    const type = (attr(attrs, "type") || "").toLowerCase();
    if (src) {
      add(scripts, ext(src)); noteMixed(src);
      if (!ext(src)) { try { const u = new URL(src, pageUrl).href; if (firstPartyScripts.length < 12 && !firstPartyScripts.includes(u)) firstPartyScripts.push(u); } catch {} }
      if (ext(src) && !attr(attrs, "integrity") && scriptsWithoutSri.length < 8) scriptsWithoutSri.push(src);
    }
    else if (body.trim() && !/json|template|text\/(x-)?(template|html)/.test(type)) inlineScriptHashes.push(sha256(body));
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0]; const rel = (attr(tag, "rel") || "").toLowerCase(); const href = attr(tag, "href");
    if (!href) continue;
    if (rel.includes("stylesheet")) noteMixed(href);
    if (rel.includes("stylesheet") || attr(tag, "as") === "style") {
      add(styles, ext(href));
      if (/fonts\.googleapis\.com/.test(href)) fonts.add("https://fonts.gstatic.com");
    } else if (attr(tag, "as") === "font") add(fonts, ext(href));
    else if (attr(tag, "as") === "image" || rel.includes("icon")) add(images, ext(href));
    else if (rel.includes("preconnect") || rel.includes("dns-prefetch")) add(connects, ext(href));
  }
  for (const m of html.matchAll(/<(img|source)\b[^>]*>/gi)) {
    add(images, ext(attr(m[0], "src") || "")); noteMixed(attr(m[0], "src"));
    for (const part of (attr(m[0], "srcset") || "").split(",")) add(images, ext(part.trim().split(/\s+/)[0] || ""));
  }
  for (const m of html.matchAll(/<(iframe|embed)\b[^>]*>/gi)) { add(frames, ext(attr(m[0], "src") || "")); noteMixed(attr(m[0], "src")); }
  for (const m of html.matchAll(/<form\b[^>]*>/gi)) add(forms, ext(attr(m[0], "action") || ""));
  if (/<style\b/i.test(html) || /\sstyle\s*=\s*["']/i.test(html)) inlineStyles = true;
  for (const m of html.matchAll(/<(\w+)\b[^>]*\s(on[a-z]+)\s*=\s*["'][^"']*["'][^>]*>/gi)) {
    if (inlineHandlers.length < 5) inlineHandlers.push(`<${m[1]} ${m[2]}="…">`);
  }
  // CSS url(...) in inline <style> blocks — background images and @font-face files from other origins
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const u of m[1].matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      const o = ext(u[1]); if (!o) continue;
      (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(u[1]) ? fonts : images).add(o);
    }
    for (const u of m[1].matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/gi)) {
      add(styles, ext(u[1])); if (/fonts\.googleapis\.com/.test(u[1])) fonts.add("https://fonts.gstatic.com");
    }
  }

  const meta = (key) => {
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
      const t = m[0];
      if ((attr(t, "name") || attr(t, "property") || "").toLowerCase() === key) return attr(t, "content");
    }
    return null;
  };
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() || null;
  const canonical = (() => { for (const m of html.matchAll(/<link\b[^>]*>/gi)) if ((attr(m[0], "rel") || "").toLowerCase() === "canonical") return attr(m[0], "href"); return null; })();
  const icon = (() => { for (const m of html.matchAll(/<link\b[^>]*>/gi)) { const r = (attr(m[0], "rel") || "").toLowerCase(); if (r.includes("apple-touch-icon") || r === "icon") return attr(m[0], "href"); } return null; })();
  const logoImg = (() => { for (const m of html.matchAll(/<img\b[^>]*>/gi)) { const t = m[0]; if (/logo/i.test(attr(t, "src") || "") || /logo/i.test(attr(t, "alt") || "") || /logo/i.test(attr(t, "class") || "")) return attr(t, "src"); } return null; })();
  const abs = (u) => { try { return u ? new URL(u, pageUrl).href : null; } catch { return null; } };
  const SOCIAL = /^(https?:)?\/\/(www\.)?(linkedin\.com|github\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|youtube\.com|tiktok\.com|threads\.net|mastodon\.)/i;
  const socials = [...new Set([...html.matchAll(/<a\b[^>]*>/gi)].map((m) => attr(m[0], "href")).filter((h) => h && SOCIAL.test(h)).map(abs))].slice(0, 8);
  const lang = attr(/<html\b[^>]*>/i.exec(html)?.[0] || "", "lang");

  return {
    url: pageUrl, origin: self, lang,
    origins: { scripts: [...scripts], styles: [...styles], fonts: [...fonts], images: [...images], frames: [...frames], forms: [...forms], connects: [...connects] },
    inlineScriptHashes, inlineStyles, inlineHandlers, mixedContent, scriptsWithoutSri, firstPartyScripts,
    inlineScriptText: [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n").slice(0, 400_000),
    meta: {
      title: decodeEntities(meta("og:title") || titleTag), siteName: decodeEntities(meta("og:site_name")), description: decodeEntities(meta("description") || meta("og:description")),
      image: abs(meta("og:image")), logo: abs(logoImg || icon), canonical: abs(canonical) || pageUrl, socials,
      email: /mailto:([^"'?\s>]+)/i.exec(html)?.[1] || null,
    },
  };
}

// ---------------------------------------------------------------- Content-Security-Policy, for THIS page
/** A CSP that allows exactly what this page loads today (plus 'self'), with hashes for its own inline
 *  scripts — so pasting it doesn't break the site the way a blanket 'self'-only template would. */
export function buildCsp(p) {
  const list = (base, extra) => [...new Set([...base, ...extra])].join(" ");
  const scriptSrc = list(["'self'"], [...p.origins.scripts, ...p.inlineScriptHashes]);
  const notes = [];
  if (p.inlineScriptHashes.length) notes.push(`${p.inlineScriptHashes.length} inline <script> block(s) on this page are allowed by their exact fingerprint (the 'sha256-…' values). If you edit one of them, its fingerprint changes — re-run this check and update the header, or move the script into a .js file.`);
  if (p.inlineHandlers.length) notes.push(`This page uses inline event handlers (${p.inlineHandlers.join(", ")}). A CSP blocks these — move them into a script file with addEventListener before turning the policy on, or those buttons/links will stop working.`);
  notes.push("Turn it on safely: send it first as Content-Security-Policy-Report-Only, browse your site, and check the browser console (F12 → Console) for anything reported as blocked — e.g. an analytics or chat script added later. When it's clean, rename the header to Content-Security-Policy.");
  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    `style-src ${list(["'self'"], [...(p.inlineStyles ? ["'unsafe-inline'"] : []), ...p.origins.styles])}`,
    `font-src ${list(["'self'"], p.origins.fonts)}`,
    `img-src ${list(["'self'", "data:"], p.origins.images)}`,
    `connect-src ${list(["'self'"], [...p.origins.connects, ...p.origins.scripts])}`,
    ...(p.origins.frames.length ? [`frame-src ${p.origins.frames.join(" ")}`] : []),
    "object-src 'none'",
    "base-uri 'self'",
    `form-action ${list(["'self'"], p.origins.forms)}`,
    "frame-ancestors 'self'",
    "upgrade-insecure-requests",
  ];
  return { value: directives.join("; "), notes };
}

// ---------------------------------------------------------------- where the headers go, per host
const HEADER_NAME = {
  "content-security-policy": "Content-Security-Policy", "strict-transport-security": "Strict-Transport-Security",
  "x-content-type-options": "X-Content-Type-Options", "x-frame-options": "X-Frame-Options",
  "referrer-policy": "Referrer-Policy", "permissions-policy": "Permissions-Policy",
};
/** Recommended value for each header; CSP comes from buildCsp so it fits this page. */
export function headerValues(missing, csp) {
  const v = {
    "content-security-policy": csp,
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
  return missing.filter((k) => v[k]).map((k) => [HEADER_NAME[k] || k, v[k]]);
}

/** One ready-to-paste config that adds every missing header, in the format THIS host uses, plus where it goes. */
export function headerFixFor(platform, pairs) {
  if (!pairs.length) return null;
  const q = (s) => s.replace(/"/g, '\\"');
  switch (platform.id) {
    case "netlify":
    case "cloudflare-pages":
      return {
        where: `Create (or add to) a file named _headers in the folder ${platform.name} publishes — your site's root folder, or its build output folder such as dist/, build/ or public/. Commit it and redeploy.`,
        code: `/*\n${pairs.map(([k, v]) => `  ${k}: ${v}`).join("\n")}`,
      };
    case "vercel":
      return {
        where: "Add this to vercel.json in the root of your project (create the file if it doesn't exist), then redeploy.",
        code: JSON.stringify({ headers: [{ source: "/(.*)", headers: pairs.map(([key, value]) => ({ key, value })) }] }, null, 2),
      };
    case "github-pages":
      return {
        where: "GitHub Pages can't send custom headers. You can add the Content-Security-Policy as a <meta> tag inside <head> on every page (below); for the other headers, put a free Cloudflare proxy in front of the site and add them there as a Transform Rule.",
        code: pairs.filter(([k]) => k === "Content-Security-Policy").map(([, v]) => `<meta http-equiv="Content-Security-Policy" content="${q(v.replace(/;\s*frame-ancestors[^;]*/, ""))}">`).join("\n") || null,
      };
    case "cloudflare":
      return {
        where: "Cloudflare is in front of this site: Cloudflare dashboard → your domain → Rules → Transform Rules → Modify Response Header → Create rule → \"All incoming requests\" → add each header below with \"Set static\". (Or set them on your origin server.)",
        code: pairs.map(([k, v]) => `${k}: ${v}`).join("\n"),
      };
    case "nginx":
      return {
        where: "Add these lines inside the server { … } block for this site in your nginx config (often /etc/nginx/sites-available/<site>), then run: sudo nginx -t && sudo systemctl reload nginx",
        code: pairs.map(([k, v]) => `add_header ${k} "${q(v)}" always;`).join("\n"),
      };
    case "apache":
      return {
        where: "Add these lines to the site's .htaccess file (or its <VirtualHost> block). Needs mod_headers: sudo a2enmod headers && sudo systemctl reload apache2",
        code: `<IfModule mod_headers.c>\n${pairs.map(([k, v]) => `  Header always set ${k} "${q(v)}"`).join("\n")}\n</IfModule>`,
      };
    case "iis":
      return {
        where: "Add this inside <system.webServer> in the site's web.config.",
        code: `<httpProtocol>\n  <customHeaders>\n${pairs.map(([k, v]) => `    <add name="${k}" value="${q(v)}" />`).join("\n")}\n  </customHeaders>\n</httpProtocol>`,
      };
    default: // Express, and app platforms (Railway, Render, Fly…) where your own server code sends headers
      return {
        where: platform.id === "unknown"
          ? "We couldn't tell which host serves this site. If it's a Node.js/Express app, add this before your routes. (Netlify/Cloudflare Pages use a _headers file; Vercel uses vercel.json; nginx/Apache use their config — run the Claude skill in your project and it will put this in the right file.)"
          : `${platform.name} passes headers through from your own server code. In a Node.js/Express app, add this before your routes (other frameworks have an equivalent "set response header" hook).`,
        code: `// Security headers — add before your routes\napp.use((req, res, next) => {\n${pairs.map(([k, v]) => `  res.setHeader("${k}", "${q(v)}");`).join("\n")}\n  next();\n});`,
      };
  }
}

// ---------------------------------------------------------------- colour contrast: the colour that passes
const hexToRgb = (hex) => { const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim()); if (!m) return null; let h = m[1]; if (h.length === 3) h = h.split("").map((c) => c + c).join(""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const rgbToHex = (rgb) => "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
export const contrastRatio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** The closest text colour to `fg` (same hue, darker or lighter) that meets `required` against `bg`. */
export function contrastFix(fgHex, bgHex, required = 4.5) {
  const fg = hexToRgb(fgHex), bg = hexToRgb(bgHex);
  if (!fg || !bg) return null;
  if (contrastRatio(fg, bg) >= required) return { color: rgbToHex(fg), ratio: +contrastRatio(fg, bg).toFixed(2) };
  const target = lum(bg) > 0.18 ? [0, 0, 0] : [255, 255, 255]; // light background → darken the text; dark → lighten
  for (let t = 0.02; t <= 1.0001; t += 0.02) {
    const c = fg.map((v, i) => v + (target[i] - v) * t);
    if (contrastRatio(c, bg) >= required) return { color: rgbToHex(c), ratio: +contrastRatio(c, bg).toFixed(2) };
  }
  return { color: rgbToHex(target), ratio: +contrastRatio(target, bg).toFixed(2) };
}

// ---------------------------------------------------------------- structured data, from the page itself
/** A JSON-LD block filled in from what the page already says about itself. Placeholders only where the
 *  page gave us nothing — and those are called out, never invented. */
export function schemaFor(p) {
  let host = ""; try { host = new URL(p.url).hostname.replace(/^www\./, ""); } catch {}
  // "Brand · tagline" / "Page | Brand": the brand is the shortest side of the separator — never the tagline
  const parts = (p.meta.title || "").split(/\s[|·•–—-]\s/).map((s) => s.trim()).filter(Boolean);
  const name = p.meta.siteName || (parts.length > 1 ? parts.reduce((a, b) => (b.length < a.length ? b : a)) : parts[0]) || host;
  const org = { "@type": "Organization", name, url: p.origin + "/" };
  if (p.meta.logo) org.logo = p.meta.logo;
  if (p.meta.description) org.description = p.meta.description;
  if (p.meta.email) org.email = p.meta.email;
  if (p.meta.socials.length) org.sameAs = p.meta.socials;
  const site = { "@type": "WebSite", name, url: p.origin + "/" };
  const missing = [!p.meta.logo && "a logo URL", !p.meta.description && "a description", !p.meta.socials.length && "your social profile links (sameAs)"].filter(Boolean);
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": [org, site] }, null, 2);
  return { code: `<script type="application/ld+json">\n${json}\n</script>`, missing };
}

/** A WebPage block for an inner page (the Organization belongs on the home page only), filled in from the
 *  page's own title and description and tied to the site, e.g. "About | Brand" → name "About". */
export function pageSchemaFor(p) {
  // Inner pages are titled "Page · Brand" (the brand LAST — "About · Acme", "Guide · Use case | Acme"),
  // so the brand is og:site_name if set, else the last part; everything before it is the page's name.
  const parts = (p.meta.title || "").split(/\s[|·•–—-]\s/).map((s) => s.trim()).filter(Boolean);
  const brand = p.meta.siteName && parts.includes(p.meta.siteName) ? p.meta.siteName : parts.length > 1 ? parts[parts.length - 1] : null;
  const name = (brand ? parts.filter((s) => s !== brand).join(" · ") : parts[0]) || new URL(p.url).pathname;
  const page = { "@context": "https://schema.org", "@type": "WebPage", name, url: p.url };
  if (p.meta.description) page.description = p.meta.description;
  page.isPartOf = { "@type": "WebSite", ...(brand || p.meta.siteName ? { name: p.meta.siteName || brand } : {}), url: p.origin + "/" };
  const missing = [!p.meta.description && "a description (the page has no meta description)"].filter(Boolean);
  return { code: `<script type="application/ld+json">\n${JSON.stringify(page, null, 2)}\n</script>`, missing };
}

// ---------------------------------------------------------------- the security checklist
// Every item is pass / fail / warn with a plain explanation; every fail or warn carries the exact fix
// for this site — where it goes on this host and what to paste (Amanda, 2026-10-02: "if it's an X then
// we've got to tell them how to fix it"). Probes are read-only GETs of the site's own public URLs.
const PLATFORM_MANAGED = new Set(["netlify", "vercel", "cloudflare-pages", "github-pages", "railway", "render", "fly", "aws", "google", "cloudflare"]);

// Scripts and data files are read whole (up to 3 MB): a key sitting past the first 20 KB of a bundle was
// invisible to the first version of this check. `cache` (a Map) lets a multi-page report probe each
// address once for the whole site instead of once per page.
async function probe(url, { allowPrivate, maxBytes = 20_000, cache = null }) {
  const key = url + "|" + maxBytes;
  if (cache?.has(key)) return cache.get(key);
  const run = (async () => {
    try {
      const { res, finalUrl } = await safeFetch(url, { allowPrivate, init: { headers: { "User-Agent": "website-precheck/1.0 (+checklist)" } } });
      const text = res.status === 200 ? (await readTextCapped(res, maxBytes)) : "";
      if (res.status !== 200) { try { await res.body?.cancel(); } catch {} }
      return { status: res.status, finalUrl, text, type: res.headers.get("content-type") || "" };
    } catch { return null; }
  })();
  cache?.set(key, run);
  return run;
}
const WHOLE_FILE = 3_000_000;

// Data files a site's own scripts load (fetch("/data/users.json"), "mcp-evidence/results.json"…) — every
// visitor can download them too, so they get the same leak scan as the scripts.
const DATA_FILE = /["'`]((?:\.{0,2}\/)?[\w@.~-]+(?:\/[\w@.~-]+)*\.(?:json|jsonl|ndjson|csv|tsv|txt|xml|ya?ml|env|ini|conf|cfg|sql|log))["'`]/gi;
// A relative path in a script is resolved by fetch() against the PAGE, not the script file (found
// 2026-10-02: /assets/app.js loading "data/x.json" fetches /data/x.json) — so try the page first, then
// the script's own folder (for import.meta.url-style loads); addresses that 404 are skipped later.
export function dataFilesIn(scriptText, scriptUrl, origin, pageUrl = scriptUrl) {
  const out = [];
  for (const m of String(scriptText).matchAll(DATA_FILE)) {
    for (const base of [pageUrl, scriptUrl]) {
      let u; try { u = new URL(m[1], base); } catch { continue; }
      if (u.origin !== origin || /package(-lock)?\.json$|manifest\.json$|tsconfig|\.min\./i.test(u.pathname)) continue;
      if (!out.includes(u.href)) out.push(u.href);
    }
  }
  return out;
}

export async function securityChecklist({ url, headers, cookies, privacy, profile, platform, allowPrivate = false, probeCache = null }) {
  const probe_ = (u, o = {}) => probe(u, { allowPrivate, cache: probeCache, ...o });
  const items = [];
  const H = headers?.responseHeaders || {};
  const has = (k) => H[k] != null && String(H[k]).trim() !== "";
  const csp = String(H["content-security-policy"] || "");
  const cspValue = profile ? buildCsp(profile).value : null;
  const fixHeaders = (names) => headerFixFor(platform, headerValues(names, cspValue || "default-src 'self'"));
  const item = (id, label, status, detail, fix = null) => items.push({ id, label, status, detail, ...(fix ? { where: fix.where, code: fix.code } : {}) });
  let origin = "", host = ""; try { origin = new URL(url).origin; host = new URL(url).host; } catch {}

  // 1-2. HTTPS, and plain http:// sending people to it
  const isHttps = /^https:/i.test(url);
  item("https", "Site loads over HTTPS (encrypted)", isHttps ? "pass" : "fail",
    isHttps ? "The page is served over https://." : "The page is served over plain http:// — anything typed into it can be read on the network.",
    isHttps ? null : { where: PLATFORM_MANAGED.has(platform.id) ? `${platform.name} provides free HTTPS: turn on "HTTPS" / "Force HTTPS" for your domain in its dashboard.` : "Get a free certificate from Let's Encrypt (e.g. sudo certbot --nginx) and serve the site on https://.", code: null });
  if (isHttps && headers) {
    const httpUrl = url.replace(/^https:/i, "http:");
    const p = await probe_(httpUrl);
    const redirects = !!(p && /^https:/i.test(p.finalUrl || ""));
    let fix = null;
    if (p && !redirects) {
      fix = platform.id === "netlify" || platform.id === "cloudflare-pages"
        ? { where: "Add this line to the _redirects file in your publish folder (or turn on \"Force HTTPS\" in the dashboard):", code: `http://${host}/*  https://${host}/:splat  301!` }
        : { where: "Redirect all http:// requests to https:// at your server or host (most hosts have a \"Force HTTPS\" switch).", code: platform.id === "nginx" ? `server {\n  listen 80;\n  server_name ${host};\n  return 301 https://$host$request_uri;\n}` : null };
    }
    item("http-redirect", "Plain http:// redirects to https://", p == null ? "warn" : redirects ? "pass" : "fail",
      p == null ? "Couldn't reach the http:// version to check." : redirects ? `${httpUrl} sends visitors to the https:// version.` : `${httpUrl} still serves the page unencrypted instead of redirecting.`, fix);
  }

  // 3-8. Security headers
  const hsts = String(H["strict-transport-security"] || "");
  const maxAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] || 0);
  item("hsts", "Browsers are told to always use HTTPS (HSTS)", !hsts ? "fail" : maxAge >= 15552000 ? "pass" : "warn",
    !hsts ? "No Strict-Transport-Security header — a visitor's first visit on public wifi can be downgraded to unencrypted." : maxAge >= 15552000 ? `Strict-Transport-Security: ${hsts}` : `HSTS is set, but only for ${Math.round(maxAge / 86400)} days; at least 180 days (ideally a year) is recommended.`,
    !hsts || maxAge < 15552000 ? fixHeaders(["strict-transport-security"]) : null);
  const weakCsp = !!csp && ((/script-src[^;]*'unsafe-inline'/.test(csp) && !/'nonce-|'sha256-/.test(csp)) || /script-src[^;]*\s\*(\s|;|$)/.test(csp));
  item("csp", "Only approved scripts can run (Content-Security-Policy)", !csp ? "fail" : weakCsp ? "warn" : "pass",
    !csp ? "No Content-Security-Policy — if an attacker ever injects a script (a comment box, a compromised plugin), nothing stops it running. The policy below was built from what this page actually loads, so it won't break it." : weakCsp ? "A CSP is set, but its script-src allows 'unsafe-inline' or *, which lets injected scripts run anyway." : "A Content-Security-Policy is set.",
    !csp || weakCsp ? fixHeaders(["content-security-policy"]) : null);
  const frameOk = has("x-frame-options") || /frame-ancestors/.test(csp);
  item("clickjacking", "Other sites can't frame your pages (clickjacking)", frameOk ? "pass" : "fail",
    frameOk ? "X-Frame-Options or CSP frame-ancestors is set." : "Any site can load your pages in a hidden frame and trick visitors into clicking your buttons.",
    frameOk ? null : fixHeaders(["x-frame-options"]));
  const nosniff = String(H["x-content-type-options"] || "").toLowerCase() === "nosniff";
  item("nosniff", "Browsers don't guess file types (X-Content-Type-Options)", nosniff ? "pass" : "fail",
    nosniff ? "X-Content-Type-Options: nosniff" : "Browsers may treat an uploaded or mislabelled file as a script.", nosniff ? null : fixHeaders(["x-content-type-options"]));
  item("referrer", "Page addresses don't leak to other sites (Referrer-Policy)", has("referrer-policy") ? "pass" : "fail",
    has("referrer-policy") ? `Referrer-Policy: ${H["referrer-policy"]}` : "Full page addresses (which can contain tokens or private page names) are sent to every site you link to.", has("referrer-policy") ? null : fixHeaders(["referrer-policy"]));
  item("permissions", "Camera, microphone and location are switched off (Permissions-Policy)", has("permissions-policy") ? "pass" : "warn",
    has("permissions-policy") ? `Permissions-Policy: ${String(H["permissions-policy"]).slice(0, 120)}` : "Not set — a compromised third-party script could ask visitors for camera, microphone or location.", has("permissions-policy") ? null : fixHeaders(["permissions-policy"]));

  // 9. Software disclosure
  const powered = H["x-powered-by"];
  const serverVer = /\d+\.\d+/.test(String(H.server || ""));
  let discFix = null;
  if (powered) discFix = { where: "Turn it off in your server code.", code: /express/i.test(powered) ? `app.disable("x-powered-by");` : /php/i.test(powered) ? "; in php.ini\nexpose_php = Off" : null };
  else if (serverVer) discFix = { where: platform.id === "nginx" ? "In nginx.conf (inside the http { } block):" : platform.id === "apache" ? "In apache2.conf / httpd.conf:" : "Hide the version in your web server's config.", code: platform.id === "nginx" ? "server_tokens off;" : platform.id === "apache" ? "ServerTokens Prod\nServerSignature Off" : null };
  item("disclosure", "Server doesn't advertise its software version", powered ? "fail" : serverVer ? "warn" : "pass",
    powered ? `X-Powered-By: ${powered} tells attackers exactly which software to look up exploits for.` : serverVer ? `Server: ${H.server} includes a version number.` : PLATFORM_MANAGED.has(platform.id) && H.server ? `Server: ${H.server} is set by ${platform.name} and only names the host — fine.` : "No version details are advertised.", discFix);

  // 10. Cookies
  if (cookies) {
    const bad = cookies.cookies.filter((c) => (isHttps && !c.secure) || !c.sameSite);
    item("cookies", "Cookies are locked down (Secure, SameSite)", bad.length ? "fail" : "pass",
      !cookies.cookies.length ? "The page sets no cookies on first load." : bad.length ? `${bad.length} cookie(s) missing Secure or SameSite: ${bad.map((c) => c.name).join(", ")}.` : `All ${cookies.cookies.length} cookie(s) have Secure and SameSite.`,
      bad.length ? { where: "Wherever your code sets these cookies, add the missing attributes. The corrected Set-Cookie lines:", code: bad.map((c) => `Set-Cookie: ${c.raw}${isHttps && !c.secure ? "; Secure" : ""}${!c.sameSite ? "; SameSite=Lax" : ""}`).join("\n") } : null);
  }

  // 11-12. What the page loads
  if (profile) {
    item("mixed-content", "Nothing on the page loads over plain http://", profile.mixedContent.length ? "fail" : "pass",
      profile.mixedContent.length ? `These load unencrypted on an encrypted page (browsers block or flag them): ${profile.mixedContent.join(", ")}` : "No insecure http:// files on the page.",
      profile.mixedContent.length ? { where: "Change each address to https:// in your HTML (check the file opens at the https:// address first):", code: profile.mixedContent.map((u) => `${u}\n  → ${u.replace(/^http:/i, "https:")}`).join("\n") } : null);
    item("sri", "Scripts from other sites can't be swapped out (Subresource Integrity)", profile.scriptsWithoutSri.length ? "warn" : "pass",
      profile.scriptsWithoutSri.length ? `If one of these outside servers is ever hacked, the attacker's code runs on your site: ${profile.scriptsWithoutSri.join(", ")}` : profile.origins.scripts.length ? "Every third-party script carries an integrity fingerprint." : "The page loads no third-party scripts.",
      profile.scriptsWithoutSri.length ? { where: "For each script, add integrity= and crossorigin= — get the hash from the provider's install snippet, or run the command and paste its output after sha384-. Skip scripts that change constantly, such as analytics loaders.", code: profile.scriptsWithoutSri.map((u) => `curl -s ${u} | openssl dgst -sha384 -binary | openssl base64 -A\n<script src="${u}" integrity="sha384-PASTE_HASH_HERE" crossorigin="anonymous"></script>`).join("\n\n") } : null);
  }

  // 13. Files that must never be public
  if (origin) {
    const exposed = [];
    const git = await probe_(origin + "/.git/HEAD");
    if (git && git.status === 200 && /^ref:\s|^[0-9a-f]{40}\s*$/m.test(git.text)) exposed.push("/.git/ (your whole source code and its history)");
    for (const p of ["/.env", "/.env.local", "/.env.production", "/.env.development", "/.env.bak"]) {
      const env = await probe_(origin + p);
      if (env && env.status === 200 && !/html/i.test(env.type) && /^[A-Z][A-Z0-9_]*\s*=/m.test(env.text)) exposed.push(`${p} (passwords and API keys)`);
    }
    let fix = null;
    if (exposed.length) fix = platform.id === "nginx"
      ? { where: "Block them in your nginx server block, delete them from the deployed folder, and rotate every secret they contained:", code: "location ~ /\\.(git|env) { deny all; return 404; }" }
      : platform.id === "apache"
        ? { where: "Block them in .htaccess, delete them from the deployed folder, and rotate every secret they contained:", code: `<FilesMatch "^\\.(git|env)">\n  Require all denied\n</FilesMatch>\nRedirectMatch 404 /\\.git` }
        : { where: `Remove them from what you deploy to ${platform.name} — they should never be in the publish folder — then rotate every secret they contained.`, code: null };
    item("exposed-files", "Secret files aren't downloadable (.git, .env)", exposed.length ? "fail" : "pass",
      exposed.length ? `Anyone can download: ${exposed.join("; ")}. Treat every key in them as stolen — rotate them now.` : "/.git/ and /.env are not publicly readable.", fix);
  }

  // 13b-d. What the public can read inside your own code — the leaks found on a real site in Sept 2026:
  // a downloadable server bundle containing passcodes, readable source, and staff names in responses.
  if (profile && origin) {
    const scanned = [];   // { url, text }
    const maps = [];      // exposed source maps
    const dataFiles = [];
    for (const s of profile.firstPartyScripts.slice(0, 10)) {
      const r = await probe_(s, { maxBytes: WHOLE_FILE });
      if (!r || r.status !== 200) continue;
      scanned.push({ url: s, text: r.text });
      for (const d of dataFilesIn(r.text, s, origin, profile.url)) if (!dataFiles.includes(d)) dataFiles.push(d);
      const mapRef = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/m.exec(r.text)?.[1];
      const mapUrl = mapRef && !/^data:/i.test(mapRef) ? new URL(mapRef, s).href : s + ".map";
      const m = await probe_(mapUrl);
      if (m && m.status === 200 && /"sources"\s*:/.test(m.text)) maps.push(mapUrl);
    }
    const scriptCount = scanned.length;
    if (profile.inlineScriptText) {
      scanned.push({ url: profile.url + " (inline scripts)", text: profile.inlineScriptText });
      for (const d of dataFilesIn(profile.inlineScriptText, profile.url, origin)) if (!dataFiles.includes(d)) dataFiles.push(d);
    }
    let dataCount = 0;
    for (const d of dataFiles.slice(0, 20)) {
      const r = await probe_(d, { maxBytes: WHOLE_FILE });
      if (!r || r.status !== 200 || /text\/html/i.test(r.type)) continue;
      scanned.push({ url: d, text: r.text, data: true });
      dataCount++;
    }
    const scannedWhat = `${scriptCount} script file(s)${profile.inlineScriptText ? ", the page's inline scripts" : ""}${dataCount ? ` and ${dataCount} data file(s) the scripts load` : ""}`;

    item("source-maps", "Your original source code isn't downloadable (source maps)", maps.length ? "fail" : "pass",
      maps.length ? `These source maps are public — they hand anyone your original, readable source code, comments and all: ${maps.join(", ")}` : `Checked ${scriptCount} script file(s): no public source maps.`,
      maps.length ? { where: "Stop publishing source maps in production: turn them off in your build tool (or delete the .map files from the deployed folder) and redeploy.", code: "// Vite (vite.config.js):\nexport default { build: { sourcemap: false } }\n\n// webpack (webpack.config.js):\nmodule.exports = { devtool: false }\n\n// esbuild: remove --sourcemap from the build command\n// Next.js (next.config.js):\nmodule.exports = { productionBrowserSourceMaps: false }" } : null);

    // API keys, tokens and passwords in code every visitor downloads. Masked in the report — never printed in full.
    const SECRET = [
      ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/g, "fail"],
      ["OpenAI API key", /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, "fail"],
      ["Stripe secret key", /[sr]k_live_[0-9a-zA-Z]{20,}/g, "fail"],
      ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g, "fail"],
      ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, "fail"],
      ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "fail"],
      ["Private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, "fail"],
      ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g, "warn"],
      ["Password or secret written into the code", /\b(?:password|passwd|passcode|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'`][^"'`\s]{6,}["'`]/gi, "warn"],
    ];
    const mask = (s) => s.length <= 12 ? s.slice(0, 4) + "…" : s.slice(0, 8) + "…" + s.slice(-3);
    const hits = [];
    for (const { url: where, text } of scanned) {
      for (const [label, re, sev] of SECRET) for (const m of text.matchAll(re)) {
        if (/your|example|xxxx|placeholder|changeme|<|\$\{/i.test(m[0])) continue;
        if (hits.length < 10) hits.push({ label, sev, where, value: mask(m[0]) });
      }
      // Supabase/Firebase-style JWTs: only a problem when the token carries an admin role
      for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.eyJ([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)) {
        try { if (/service_role|"admin"/.test(Buffer.from(m[1], "base64url").toString())) hits.push({ label: "Admin (service_role) token", sev: "fail", where, value: mask(m[0]) }); } catch {}
      }
    }
    const worst = hits.some((h) => h.sev === "fail") ? "fail" : hits.length ? "warn" : "pass";
    item("secrets-in-code", "No API keys, tokens or passwords in code visitors download", worst,
      hits.length ? `Found in files every visitor downloads: ${hits.map((h) => `${h.label} (${h.value}) in ${h.where}`).join("; ")}.${hits.some((h) => h.label === "Google API key") ? " Google API keys for Maps/Firebase are designed to be public, but only if they're restricted to your domain." : ""}` : `Scanned ${scannedWhat} for API keys, tokens, private keys and hard-coded passwords: none found.`,
      hits.length ? { where: "1) Revoke/rotate every key listed — assume it's already been copied. 2) Move the secret to your server (an environment variable) and have the browser call your own server, which adds the key. 3) Rebuild and redeploy. For Google browser keys: Google Cloud Console → APIs & Services → Credentials → the key → \"Website restrictions\" → add your domain.", code: "// Server side (Node/Express) — the key never reaches the browser:\napp.post(\"/api/ask\", async (req, res) => {\n  const r = await fetch(\"https://api.provider.com/v1/…\", {\n    headers: { Authorization: `Bearer ${process.env.PROVIDER_API_KEY}` },\n    method: \"POST\", body: JSON.stringify(req.body),\n  });\n  res.status(r.status).send(await r.text());\n});" } : null);

    // Email addresses / usernames baked into scripts (not the page's public contact links)
    const pageEmail = (profile.meta.email || "").toLowerCase();
    // (2+ character names only: one-letter addresses like a@b.co are test data, not people)
    const emailAt = new Map();
    for (const { url: where, text } of scanned) for (const m of text.matchAll(/\b[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g)) {
      const e = m[0].toLowerCase();
      if (e === pageEmail || /example\.|sentry|w3\.org|schema\.org|\.(png|jpg|webp|svg|gif)$|@\d|noreply|no-reply|^[0-9a-f]{20,}@/i.test(e)) continue;
      if (!emailAt.has(e)) emailAt.set(e, where);
    }
    const emails = [...emailAt].slice(0, 8);
    item("emails-in-code", "No staff emails or usernames inside the site's scripts or data files", emails.length ? "warn" : "pass",
      emails.length ? `These addresses are inside files any visitor can download (useful to phishers and password-guessers): ${emails.map(([e, w]) => `${e.replace(/^(.{2}).*(@.*)$/, "$1…$2")} in ${w}`).join("; ")}` : `No email addresses found inside ${scannedWhat}.`,
      emails.length ? { where: "Remove them from the front-end code and public data files (seed data, config, comments, test accounts). Anything that needs them should load from your server after sign-in.", code: null } : null);
    // which files each scan covered — a whole-site report totals these across pages
    const scannedFiles = scanned.map((x) => x.url);
    for (const i of items) if (["source-maps", "secrets-in-code", "emails-in-code"].includes(i.id)) i.scanned = i.id === "source-maps" ? scannedFiles.slice(0, scriptCount) : scannedFiles;

    // Server-side files that must never sit in the public folder
    const leaked = [];
    const SERVER_PROBES = [
      ["/server.js", (r) => /require\(|process\.env|express\(|createServer/.test(r.text), "your server code"],
      ["/server.cjs", (r) => /require\(|process\.env|express\(|createServer/.test(r.text), "your server code"],
      ["/server.mjs", (r) => /import .* from|process\.env|createServer/.test(r.text), "your server code"],
      ["/.npmrc", (r) => /_authToken|registry/.test(r.text), "npm credentials"],
      ["/.DS_Store", (r) => r.text.includes("Bud1") || r.status === 200 && !/html/i.test(r.type), "a list of your file names"],
      ["/package.json", (r) => /"(?:dependencies|scripts|devDependencies)"\s*:/.test(r.text), "your software list and versions"],
      ["/.htpasswd", (r) => /^[\w.-]+:\S{8,}/m.test(r.text), "password hashes", true],
      ["/wp-config.php.bak", (r) => /DB_PASSWORD/.test(r.text), "database password", true],
      ["/config.json", (r) => /"[^"]*(?:password|secret|token|api[_-]?key|private)[^"]*"\s*:/i.test(r.text), "a config file with secret-looking fields"],
      ["/secrets.json", (r) => r.text.trim().startsWith("{"), "a secrets file", true],
      ["/credentials.json", (r) => r.text.trim().startsWith("{"), "a credentials file", true],
      ["/docker-compose.yml", (r) => /^\s*services\s*:/m.test(r.text), "your server setup"],
      ["/Dockerfile", (r) => /^\s*FROM\s+\S+/im.test(r.text), "your server setup"],
      ["/CLAUDE.md", (r) => r.text.length > 40, "instructions for your AI assistant (often names internal paths, tools and accounts)"],
      ["/.claude/settings.json", (r) => r.text.trim().startsWith("{"), "your AI assistant's settings"],
      ["/.cursorrules", (r) => r.text.length > 40, "instructions for your AI editor"],
      ["/.vscode/settings.json", (r) => r.text.trim().startsWith("{"), "your editor settings"],
      ["/backup.zip", (r) => r.text.startsWith("PK"), "a backup of your site", true],
      ["/site.zip", (r) => r.text.startsWith("PK"), "a copy of your site", true],
      ["/backup.sql", (r) => /CREATE TABLE|INSERT INTO/i.test(r.text), "a copy of your database", true],
      ["/dump.sql", (r) => /CREATE TABLE|INSERT INTO/i.test(r.text), "a copy of your database", true],
    ];
    const SERVER_PROBE_COUNT = SERVER_PROBES.length;
    for (const [path, test, what, always] of SERVER_PROBES) {
      const r = await probe_(origin + path);
      if (r && r.status === 200 && !/text\/html/i.test(r.type) && test(r)) {
        const secret = !!always || SECRET.some(([, re, sev]) => sev === "fail" && new RegExp(re.source, re.flags.replace("g", "")).test(r.text))
          || /\b(?:password|passcode|secret|api[_-]?key)\s*[:=]\s*["'`][^"'`\s]{6,}/i.test(r.text) || path === "/.npmrc";
        leaked.push({ path, label: `${path} (${what})`, secret, always: !!always });
      }
    }
    const anySecret = leaked.some((l) => l.secret);
    item("server-files", "Server code, config files and backups aren't public (server.js, .env backups, .zip/.sql, AI config…)", anySecret ? "fail" : leaked.length ? "warn" : "pass",
      !leaked.length ? `None of the ${SERVER_PROBE_COUNT} usual addresses for server code, config files, backups, database dumps and AI-assistant notes are publicly readable.`
        : anySecret ? `Anyone can download: ${leaked.map((l) => l.label + (l.always ? " — treat everything in it as exposed" : l.secret ? " — contains what looks like a password or key" : "")).join("; ")}. Rotate every secret in it now.`
        : `Anyone can download: ${leaked.map((l) => l.label).join("; ")}. No passwords or keys were found in it, so this is low risk today — but it shows how the site works, and the next edit could add a secret. It doesn't belong in the public folder.`,
      leaked.length ? { where: PLATFORM_MANAGED.has(platform.id) ? `Remove these from the folder you deploy to ${platform.name} — only the built front-end belongs there — then redeploy and rotate any secrets they contained.` : "Remove them from the web root (only public files belong there), or block them in your server config, then rotate any secrets they contained.", code: platform.id === "netlify" || platform.id === "cloudflare-pages"
        ? `# _redirects in your publish folder — a 404 for each file (the ! forces it even though the file exists):\n${leaked.map((l) => `${l.path}  /404  404!`).join("\n")}`
        : platform.id === "nginx" ? leaked.map((l) => `location = ${l.path} { deny all; return 404; }`).join("\n") : null } : null);
  }

  // 14. security.txt
  if (origin) {
    const st = await probe_(origin + "/.well-known/security.txt");
    const ok = !!(st && st.status === 200 && /^contact:/im.test(st.text));
    const expires = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const contact = profile?.meta?.email || "security@" + host.replace(/^www\./, "");
    item("security-txt", "Security researchers know how to reach you (security.txt)", ok ? "pass" : "warn",
      ok ? "/.well-known/security.txt is published." : "No /.well-known/security.txt — someone who finds a hole in your site has no safe, official way to tell you.",
      ok ? null : { where: `Create the file .well-known/security.txt in your site's publish folder, so it's served at ${origin}/.well-known/security.txt:`, code: `Contact: mailto:${contact}\nExpires: ${expires}T00:00:00.000Z\nPreferred-Languages: en\nCanonical: ${origin}/.well-known/security.txt` });
  }

  // 15-16. Privacy
  if (privacy) {
    const names = privacy.trackers.map((t) => (typeof t === "string" ? t : t.label || t.name || t.host || t.domain || "")).filter(Boolean).slice(0, 5);
    item("trackers", "No third-party trackers load without being disclosed", privacy.trackers.length && !privacy.hasPrivacyLink ? "fail" : privacy.trackers.length ? "warn" : "pass",
      privacy.trackers.length ? `The page loads trackers (${names.join(", ")})${privacy.hasPrivacyLink ? " — make sure your privacy policy names each one." : " and links no privacy policy."}` : "No known third-party trackers load on this page.",
      privacy.trackers.length ? { where: "Name every tracker in your privacy policy (what it collects, why, how to opt out). If you have EU, UK or California visitors, load them only after the visitor agrees.", code: null } : null);
    item("privacy-link", "A privacy policy is linked from the page", privacy.hasPrivacyLink ? "pass" : "fail",
      privacy.hasPrivacyLink ? "A privacy policy link was found." : "No privacy policy link was found on the page.",
      privacy.hasPrivacyLink ? null : { where: "Publish a privacy page and link it in your footer:", code: `<a href="/privacy">Privacy policy</a>` });
  }

  const counts = { pass: items.filter((i) => i.status === "pass").length, warn: items.filter((i) => i.status === "warn").length, fail: items.filter((i) => i.status === "fail").length };
  return { items, counts, allMissingHeaders: headers?.missing?.length ? fixHeaders(headers.missing) : null };
}
