#!/usr/bin/env node
// Check a site's HTTP security headers — a fast, non-destructive GET. Reports which recommended
// headers are present and which are missing, plus a couple of things that should NOT be there.
// Usage:  node headers.mjs <url>
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSafeUrl, safeFetch, flag } from "./safe.mjs";

export const WANT = [
  ["content-security-policy", "Controls what can load/run — the big one. Lock script-src to 'self'.", "high"],
  ["strict-transport-security", "Forces HTTPS (HSTS).", "high"],
  ["x-content-type-options", "Stops MIME-sniffing. Should be: nosniff", "medium"],
  ["x-frame-options", "Blocks clickjacking (or use CSP frame-ancestors).", "medium"],
  ["referrer-policy", "Limits what you leak in the Referer header.", "low"],
  ["permissions-policy", "Turns off camera/mic/geolocation etc.", "low"],
];
export const UNWANTED = [
  ["x-powered-by", "Advertises your server software — turn it off."],
  ["server", "If it names/versions the server, consider hiding it."],
];

// Core check, importable from report.mjs / the MCP server. Returns structured data, never prints
// or calls process.exit() — that's the CLI wrapper's job, below.
export async function checkHeaders(rawUrl, { allowPrivate = false } = {}) {
  const url = await assertSafeUrl(rawUrl, { allowPrivate }); // throws on refusal — caller decides how to report it
  // safeFetch re-validates every redirect hop — a bare fetch() would transparently follow a
  // redirect to an internal/metadata address, bypassing the check above entirely (F2).
  const { res, finalUrl } = await safeFetch(url, { allowPrivate, init: { headers: { "User-Agent": "website-precheck/1.0 (+security-header-check)" } } });

  const h = res.headers;
  const checks = WANT.map(([name, why, severity]) => {
    const value = h.get(name);
    return { name, present: !!value, value: value ? value.slice(0, 200) : null, why, severity };
  });
  const unwanted = UNWANTED.map(([name, why]) => ({ name, present: !!h.get(name), value: h.get(name) || null, why }));
  const httpsRedirect = url.startsWith("http://") ? finalUrl.startsWith("https://") : null; // null = started on https already, n/a

  return {
    url, finalUrl, status: res.status,
    checks, unwanted, httpsRedirect,
    missing: checks.filter((c) => !c.present).map((c) => c.name),
  };
}

// ---- CLI wrapper: only runs when this file is executed directly, not when imported ----
const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] || "").href; } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  const rawUrl = args.find((a) => /^https?:\/\//.test(a));
  if (!rawUrl) { console.error("Usage: node headers.mjs <url> [--allow-private]"); process.exit(2); }
  const allowPrivate = flag(args, "allow-private");

  let result;
  try { result = await checkHeaders(rawUrl, { allowPrivate }); }
  catch (e) { console.error(/private|local/i.test(e.message) ? "Refused: " + e.message : "Could not reach " + rawUrl + ": " + e.message); process.exit(e.message?.startsWith("Refus") || /private|local/i.test(e.message || "") ? 2 : 1); }

  console.log(`\n=== Security headers · ${result.finalUrl} (${result.status}) ===\n`);
  console.log("Recommended:");
  for (const c of result.checks) {
    console.log(c.present ? `  PASS  ${c.name}: ${c.value}` : `  MISS  ${c.name}  — ${c.why}`);
  }
  console.log("\nShould be absent / quiet:");
  for (const c of result.unwanted) {
    console.log(c.present ? `  WARN  ${c.name}: ${c.value}  — ${c.why}` : `  ok    ${c.name} not sent`);
  }
  if (result.httpsRedirect !== null) {
    console.log(result.httpsRedirect ? "\n  PASS  HTTP redirected to HTTPS" : "\n  MISS  HTTP did not redirect to HTTPS");
  }
  const missing = result.missing.length;
  console.log(`\n${missing === 0 ? "All recommended headers present." : missing + " recommended header(s) missing."} See the site-hardening-and-speed skill to add them.`);
  // Set exitCode and let the process end on its own — calling process.exit() here races the
  // fetch keep-alive socket teardown and throws a libuv assertion on Windows.
  process.exitCode = Math.min(missing, 250);
}
