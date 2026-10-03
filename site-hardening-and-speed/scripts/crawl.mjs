// Find the pages of a site the way a visitor would: follow the site's own links (and its sitemap.xml),
// same origin only, HTML pages only. Used by `precheck report` to check every page, not just the one URL
// it was given (Amanda, 2026-10-02: a leak on /about is as bad as one on the home page, and checking page
// by page in dev tools is a pain). Every fetch goes through safeFetch, so private addresses stay refused.
import { assertSafeUrl, safeFetch, readTextCapped } from "./safe.mjs";

// Not pages: files a link can point at that we shouldn't treat as a page to check.
const NOT_A_PAGE = /\.(?:pdf|zip|gz|rar|7z|docx?|xlsx?|pptx?|csv|txt|xml|json|jsonl|rss|atom|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|m4v|mp3|wav|ogg|woff2?|ttf|otf|eot|css|js|mjs|map|exe|dmg|apk)$/i;

/** One page's address in the form we compare on: no #fragment, no ?query, "/index.html" → "/". */
export function normalizePageUrl(u) {
  const x = new URL(u);
  x.hash = ""; x.search = "";
  x.pathname = x.pathname.replace(/\/index\.html?$/i, "/");
  return x.href;
}

/** Same-origin page links in a chunk of HTML, normalized and de-duplicated, in page order. */
export function extractLinks(html, pageUrl) {
  const origin = new URL(pageUrl).origin;
  const base = /<base\s[^>]*href=["']([^"']+)["']/i.exec(html)?.[1];
  const out = [];
  for (const m of String(html).matchAll(/<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!raw || raw.startsWith("#") || /^(?:mailto|tel|sms|javascript|data|blob|ftp):/i.test(raw)) continue;
    let abs;
    try { abs = new URL(raw, base ? new URL(base, pageUrl) : pageUrl); } catch { continue; }
    if (abs.origin !== origin || NOT_A_PAGE.test(abs.pathname)) continue;
    const n = normalizePageUrl(abs.href);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Page addresses listed in a sitemap.xml (same origin only). Sitemap indexes are followed one level. */
export function sitemapLocs(xml, origin) {
  return [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"))
    .filter((u) => { try { return new URL(u).origin === origin; } catch { return false; } });
}

const UA = { "User-Agent": "website-precheck/1.0 (+page-finder)" };

async function fetchPage(url, allowPrivate) {
  try {
    const { res, finalUrl } = await safeFetch(url, { allowPrivate, init: { headers: UA } });
    const type = res.headers.get("content-type") || "";
    if (res.status !== 200 || !/text\/html|application\/xhtml/i.test(type)) { try { await res.body?.cancel(); } catch {} return { status: res.status, finalUrl, html: null }; }
    return { status: 200, finalUrl, html: await readTextCapped(res, 3_000_000) };
  } catch (e) { return { status: 0, error: e.message, html: null }; }
}

/**
 * Find up to maxPages pages, starting at `rawUrl` (always first). Breadth-first, so the pages linked from
 * the home page (the main menu) come before deeper ones. Returns { pages: [url…], found, capped, viaSitemap }.
 * `found` counts every distinct page address seen, so the report can say "checked 20 of 34".
 */
export async function discoverPages(rawUrl, { allowPrivate = false, maxPages = 20, maxDepth = 3 } = {}) {
  const start = normalizePageUrl(await assertSafeUrl(rawUrl, { allowPrivate }));
  const origin = new URL(start).origin;
  const seen = new Set([start]);        // every address queued or visited
  const pages = [];                     // confirmed HTML pages, in check order (final addresses)
  const finals = new Set();
  const queue = [{ url: start, depth: 0 }];
  let viaSitemap = 0;

  // sitemap.xml seeds pages that aren't linked from anywhere obvious
  const seedSitemap = async (path, depth = 0) => {
    try {
      const { res } = await safeFetch(origin + path, { allowPrivate, init: { headers: UA } });
      if (res.status !== 200) { try { await res.body?.cancel(); } catch {} return; }
      const xml = await readTextCapped(res, 2_000_000);
      for (const loc of sitemapLocs(xml, origin)) {
        if (/\.xml$/i.test(new URL(loc).pathname)) { if (depth < 1) await seedSitemap(new URL(loc).pathname, depth + 1); continue; }
        if (NOT_A_PAGE.test(new URL(loc).pathname)) continue;
        const n = normalizePageUrl(loc);
        if (!seen.has(n)) { seen.add(n); queue.push({ url: n, depth: 1 }); viaSitemap++; }
      }
    } catch {}
  };

  while (queue.length && pages.length < maxPages) {
    const { url, depth } = queue.shift();
    const r = await fetchPage(url, allowPrivate);
    if (!r.html) continue;
    let final;
    try { final = normalizePageUrl(r.finalUrl || url); } catch { continue; }
    if (new URL(final).origin !== origin || finals.has(final)) continue; // redirected off-site, or a duplicate (/about.html → /about)
    finals.add(final); seen.add(final);
    pages.push(final);
    if (pages.length === 1) await seedSitemap("/sitemap.xml");
    if (depth >= maxDepth) continue;
    for (const link of extractLinks(r.html, final)) if (!seen.has(link)) { seen.add(link); queue.push({ url: link, depth: depth + 1 }); }
  }
  return { pages, found: Math.max(pages.length, finals.size + queue.length), capped: queue.length > 0, viaSitemap };
}
