#!/usr/bin/env node
// Check a site's HTTP security headers — a fast, non-destructive GET. Reports which recommended
// headers are present and which are missing, plus a couple of things that should NOT be there.
// Usage:  node headers.mjs <url>
import process from "node:process";
import { assertSafeUrl, flag } from "./safe.mjs";

const args = process.argv.slice(2);
const rawUrl = args.find((a) => /^https?:\/\//.test(a));
if (!rawUrl) { console.error("Usage: node headers.mjs <url> [--allow-private]"); process.exit(2); }
const allowPrivate = flag(args, "allow-private");
// SSRF guard before we fetch anything (F2).
let url;
try { url = await assertSafeUrl(rawUrl, { allowPrivate }); }
catch (e) { console.error("Refused: " + e.message); process.exit(2); }

const WANT = [
  ["content-security-policy", "Controls what can load/run — the big one. Lock script-src to 'self'."],
  ["strict-transport-security", "Forces HTTPS (HSTS)."],
  ["x-content-type-options", "Stops MIME-sniffing. Should be: nosniff"],
  ["x-frame-options", "Blocks clickjacking (or use CSP frame-ancestors)."],
  ["referrer-policy", "Limits what you leak in the Referer header."],
  ["permissions-policy", "Turns off camera/mic/geolocation etc."],
];
const UNWANTED = [
  ["x-powered-by", "Advertises your server software — turn it off."],
  ["server", "If it names/versions the server, consider hiding it."],
];

(async () => {
  // Follow redirects by hand, re-validating each hop — otherwise a redirect to an internal address
  // would be an SSRF bypass (F2). Cap the hops.
  let current = url, res, finalUrl = url;
  try {
    for (let hop = 0; ; hop++) {
      res = await fetch(current, { redirect: "manual", headers: { "User-Agent": "web-guardrails/1.0 (+security-header-check)" } });
      finalUrl = current;
      const loc = res.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(res.status) && loc && hop < 5) {
        const next = new URL(loc, current).href;
        current = await assertSafeUrl(next, { allowPrivate }); // throws if the redirect target is private
        continue;
      }
      break;
    }
  } catch (e) { console.error("Could not reach " + current + ": " + e.message); process.exit(1); }

  const h = res.headers;
  console.log(`\n=== Security headers · ${finalUrl} (${res.status}) ===\n`);
  let missing = 0;
  console.log("Recommended:");
  for (const [name, why] of WANT) {
    const v = h.get(name);
    if (v) console.log(`  PASS  ${name}: ${v.slice(0, 90)}`);
    else { missing++; console.log(`  MISS  ${name}  — ${why}`); }
  }
  console.log("\nShould be absent / quiet:");
  for (const [name, why] of UNWANTED) {
    const v = h.get(name);
    if (v) console.log(`  WARN  ${name}: ${v}  — ${why}`);
    else console.log(`  ok    ${name} not sent`);
  }
  // HTTPS redirect check
  if (url.startsWith("http://")) {
    console.log(finalUrl.startsWith("https://") ? "\n  PASS  HTTP redirected to HTTPS" : "\n  MISS  HTTP did not redirect to HTTPS");
  }
  console.log(`\n${missing === 0 ? "All recommended headers present." : missing + " recommended header(s) missing."} See the site-hardening-and-speed skill to add them.`);
  // Set exitCode and let the process end on its own — calling process.exit() here races the
  // fetch keep-alive socket teardown and throws a libuv assertion on Windows.
  process.exitCode = Math.min(missing, 250);
})();
