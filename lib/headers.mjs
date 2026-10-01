#!/usr/bin/env node
// Check a site's HTTP security headers — a fast, non-destructive GET. Reports which recommended
// headers are present and which are missing, plus a couple of things that should NOT be there.
// Usage:  node headers.mjs <url>
import process from "node:process";

const url = process.argv.slice(2).find((a) => /^https?:\/\//.test(a));
if (!url) { console.error("Usage: node headers.mjs <url>"); process.exit(2); }

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
  let res;
  try {
    res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "web-guardrails/1.0 (+security-header-check)" } });
  } catch (e) { console.error("Could not reach " + url + ": " + e.message); process.exit(1); }

  const h = res.headers;
  console.log(`\n=== Security headers · ${res.url} (${res.status}) ===\n`);
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
    console.log(res.url.startsWith("https://") ? "\n  PASS  HTTP redirected to HTTPS" : "\n  MISS  HTTP did not redirect to HTTPS");
  }
  console.log(`\n${missing === 0 ? "All recommended headers present." : missing + " recommended header(s) missing."} See the site-hardening-and-speed skill to add them.`);
  // Set exitCode and let the process end on its own — calling process.exit() here races the
  // fetch keep-alive socket teardown and throws a libuv assertion on Windows.
  process.exitCode = Math.min(missing, 250);
})();
