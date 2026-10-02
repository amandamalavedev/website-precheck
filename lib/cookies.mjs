#!/usr/bin/env node
// Data/cookie governance: what does this site actually set in the visitor's browser, and is it set
// safely? Not a full consent/compliance audit (see references/privacy-cookies-us.md for the manual
// pass) — this is the automatable slice: list every cookie the first response sets, flag the ones
// missing Secure or SameSite. Deliberately does NOT flag a missing HttpOnly as a violation — a
// double-submit CSRF token is a legitimate, common case where JS needs to read the cookie, so that
// call is a judgment call for a human, not an automated finding.
import { pathToFileURL } from "node:url";
import { assertSafeUrl, safeFetch, flag } from "./safe.mjs";

export async function checkCookies(rawUrl, { allowPrivate = false } = {}) {
  const url = await assertSafeUrl(rawUrl, { allowPrivate });
  // safeFetch re-validates every redirect hop — a bare fetch() follows redirects by default and
  // would happily land on an internal address a redirect pointed it to (SSRF bypass).
  const { res } = await safeFetch(url, { allowPrivate, init: { headers: { "User-Agent": "website-precheck/1.0 (+cookie-governance-check)" } } });
  const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const cookies = setCookie.map((raw) => {
    const parts = raw.split(";").map((p) => p.trim());
    const name = parts[0].split("=")[0];
    const flags = parts.slice(1);
    const has = (f) => flags.some((p) => p.toLowerCase() === f);
    const sameSite = flags.find((p) => p.toLowerCase().startsWith("samesite="))?.split("=")[1] || null;
    return { name, raw, secure: has("secure"), httpOnly: has("httponly"), sameSite };
  });
  return { url, isHttps: url.startsWith("https://"), cookies };
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] || "").href; } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  const rawUrl = args.find((a) => /^[a-z][a-z0-9+.-]+:\/\//i.test(a));
  if (!rawUrl) { console.error("Usage: node cookies.mjs <url> [--allow-private]"); process.exit(2); }
  if (!/^https?:\/\//i.test(rawUrl)) { console.error(`Refused: only http:// and https:// URLs can be checked (got "${rawUrl.split(':')[0]}:").`); process.exit(2); }
  let r;
  try { r = await checkCookies(rawUrl, { allowPrivate: flag(args, "allow-private") }); }
  catch (e) { console.error(/private|local|valid URL/i.test(e.message) ? "Refused: " + e.message : e.message); process.exit(/private|local|valid URL/i.test(e.message) ? 2 : 1); }
  if (!r.cookies.length) console.log("No cookies set on the first response.");
  for (const c of r.cookies) {
    console.log(`${c.name}: Secure=${c.secure} SameSite=${c.sameSite || "(not set)"} HttpOnly=${c.httpOnly}`);
  }
}
