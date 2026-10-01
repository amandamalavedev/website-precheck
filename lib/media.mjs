#!/usr/bin/env node
// Video weight check: Lighthouse's default audits don't flag an oversized <video> the way they
// flag images — there's no "modern video formats" audit in the stock set. Heavy hero/background
// video is still one of the biggest, most common page-weight problems in practice (bigger than any
// single image usually is), so this is worth checking directly: find every local <video>/<source>
// the page references, HEAD each one for its real size, and flag the ones worth compressing.
import { pathToFileURL } from "node:url";
import { assertSafeUrl, flag } from "./safe.mjs";

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?.*)?$/i;

export async function checkVideoAssets(rawUrl, { allowPrivate = false, thresholdKiB = 2000 } = {}) {
  const url = await assertSafeUrl(rawUrl, { allowPrivate });
  const res = await fetch(url, { headers: { "User-Agent": "website-precheck/1.0 (+video-weight-check)" } });
  const html = await res.text();
  const base = new URL(url);
  const srcs = new Set();
  for (const m of html.matchAll(/<(?:video|source)[^>]+src=["']([^"']+)["']/gi)) if (VIDEO_EXT.test(m[1])) srcs.add(m[1]);

  const videos = [];
  for (const src of srcs) {
    let abs;
    try { abs = await assertSafeUrl(new URL(src, base).href, { allowPrivate }); } catch { continue; } // skip anything off-origin/private — not this site's asset to flag
    try {
      const head = await fetch(abs, { method: "HEAD", headers: { "User-Agent": "website-precheck/1.0 (+video-weight-check)" } });
      const bytes = Number(head.headers.get("content-length") || 0);
      videos.push({ url: abs, bytes });
    } catch { /* unreachable — skip rather than fail the whole report */ }
  }
  return { url, thresholdKiB, videos, heavy: videos.filter((v) => v.bytes / 1024 > thresholdKiB) };
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] || "").href; } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  const rawUrl = args.find((a) => /^https?:\/\//.test(a));
  if (!rawUrl) { console.error("Usage: node media.mjs <url> [--allow-private]"); process.exit(2); }
  let r;
  try { r = await checkVideoAssets(rawUrl, { allowPrivate: flag(args, "allow-private") }); }
  catch (e) { console.error(/private|local|valid URL/i.test(e.message) ? "Refused: " + e.message : e.message); process.exit(/private|local|valid URL/i.test(e.message) ? 2 : 1); }
  if (!r.videos.length) console.log("No local <video> sources found on the page.");
  for (const v of r.videos) console.log(`${v.url} — ${(v.bytes / 1024).toFixed(0)} KiB${v.bytes / 1024 > r.thresholdKiB ? "  [heavy]" : ""}`);
}
