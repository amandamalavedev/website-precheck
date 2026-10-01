#!/usr/bin/env node
// Privacy check: distinct from Governance (what THIS site sets in a visitor's browser) — this is
// about what THIRD PARTIES the page exposes visitors to, and whether that's disclosed. Finds
// external script/iframe/image origins, labels the well-known trackers among them, and checks for
// a privacy policy link. Deliberately conservative: an unrecognized third-party origin (a CDN, a
// webfont host) is listed in the inventory but never treated as a violation on its own — only a
// known tracker with no privacy policy link is a flagged finding, to avoid false positives on
// ordinary infrastructure.
import { pathToFileURL } from "node:url";
import { assertSafeUrl, safeFetch, flag } from "./safe.mjs";

// The page being scanned is untrusted content (that's the whole point of this check) — an
// attacker-controlled response could serve megabytes of garbage specifically to make the regexes
// below expensive to run (a huge single tag with no ">", a multi-megabyte attribute value with no
// closing quote). Neither regex has nested unbounded quantifiers (not classic catastrophic/
// exponential ReDoS), but both are still O(n^2)-ish on pathological input, which is enough to stall
// on a large enough page. Cap what we scan rather than trust pattern analysis alone — no real
// privacy policy link or tracker script needs anything close to this much HTML to appear in.
const MAX_SCAN_CHARS = 2_000_000;

const KNOWN_TRACKERS = {
  "google-analytics.com": "Google Analytics",
  "googletagmanager.com": "Google Tag Manager",
  "analytics.google.com": "Google Analytics",
  "doubleclick.net": "Google Ads / DoubleClick",
  "googlesyndication.com": "Google Ads",
  "connect.facebook.net": "Meta Pixel",
  "facebook.net": "Meta Pixel",
  "hotjar.com": "Hotjar",
  "clarity.ms": "Microsoft Clarity",
  "segment.com": "Segment",
  "segment.io": "Segment",
  "mixpanel.com": "Mixpanel",
  "amplitude.com": "Amplitude",
  "platform.twitter.com": "Twitter/X widget",
  "ads-twitter.com": "Twitter/X Ads",
  "snap.licdn.com": "LinkedIn Insight",
  "px.ads.linkedin.com": "LinkedIn Insight",
  "analytics.tiktok.com": "TikTok Pixel",
  "intercom.io": "Intercom",
  "widget.intercom.io": "Intercom",
  "cdn.heapanalytics.com": "Heap",
  "fullstory.com": "FullStory",
  "cdn.mouseflow.com": "Mouseflow",
};

export async function checkPrivacy(rawUrl, { allowPrivate = false } = {}) {
  const url = await assertSafeUrl(rawUrl, { allowPrivate });
  // safeFetch re-validates every redirect hop — a bare fetch() follows redirects by default and
  // would happily land on an internal address a redirect pointed it to (SSRF bypass).
  const { res, finalUrl } = await safeFetch(url, { allowPrivate, init: { headers: { "User-Agent": "website-precheck/1.0 (+privacy-check)" } } });
  const html = (await res.text()).slice(0, MAX_SCAN_CHARS);
  const base = new URL(finalUrl);

  const origins = new Set();
  for (const m of html.matchAll(/<(?:script|iframe)[^>]+src=["']([^"']+)["']/gi)) {
    try { const u = new URL(m[1], base); if (u.origin !== base.origin) origins.add(u.origin); } catch {}
  }

  const thirdParty = [...origins].map((origin) => {
    const host = new URL(origin).host;
    const known = Object.entries(KNOWN_TRACKERS).find(([domain]) => host === domain || host.endsWith("." + domain));
    return { origin, host, label: known ? known[1] : null };
  });

  const hasPrivacyLink = /<a\b[^>]*href=["'][^"']*privacy[^"']*["']/i.test(html);

  return { url, thirdParty, trackers: thirdParty.filter((t) => t.label), hasPrivacyLink };
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] || "").href; } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  const rawUrl = args.find((a) => /^https?:\/\//.test(a));
  if (!rawUrl) { console.error("Usage: node privacy.mjs <url> [--allow-private]"); process.exit(2); }
  let r;
  try { r = await checkPrivacy(rawUrl, { allowPrivate: flag(args, "allow-private") }); }
  catch (e) { console.error(/private|local|valid URL/i.test(e.message) ? "Refused: " + e.message : e.message); process.exit(/private|local|valid URL/i.test(e.message) ? 2 : 1); }
  console.log(`Privacy policy link found: ${r.hasPrivacyLink}`);
  if (!r.thirdParty.length) console.log("No third-party scripts/iframes found.");
  for (const t of r.thirdParty) console.log(`${t.host}${t.label ? ` — ${t.label}` : ""}`);
}
