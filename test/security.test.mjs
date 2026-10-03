// Security tests for the precheck safety layer — one abuse case and a normal control per
// finding from the pre-publish review. Fast and offline (no network, no browser).
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, linkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { connect } from "node:net";
import { assertSafeUrl, safeFetch, isPrivateIp, sandboxOptIn, assertDirInside, writeFileContained } from "../lib/safe.mjs";
import { createStaticServer } from "../lib/serve-with-headers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WG = join(HERE, "..", "bin", "precheck.mjs");

// ── F1: command injection — input never reaches a shell ──────────────────────────────────────────
test("F1 abuse: non-http(s) schemes and malformed URLs are refused before anything runs", async () => {
  await assert.rejects(assertSafeUrl("file:///etc/passwd", { allowPrivate: true }), /http/i);
  await assert.rejects(assertSafeUrl("javascript:alert(1)", { allowPrivate: true }), /http/i);
  await assert.rejects(assertSafeUrl("http://", { allowPrivate: true }), /valid URL/i);
});
test("F1 abuse: even a validated URL is passed as ONE argument (no shell runs it)", () => {
  // shell:false means a '&echo' in the argument is inert — it's just characters in one argv slot.
  const injected = "https://example.com/?a=1&echo WGINJECT";
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(process.argv[1]||'')", injected],
    { encoding: "utf8", shell: false });
  assert.equal(r.stdout, injected);              // received verbatim as a single argument
  assert.doesNotMatch(r.stdout, /\n/);           // no second line → no second command ran
});
test("F1 control: a normal URL with ?a=1 validates and is returned", async () => {
  const href = await assertSafeUrl("http://93.184.216.34/?a=1", { allowPrivate: false }); // public IP literal
  assert.match(href, /\?a=1$/);
});

// ── F2: SSRF — private/internal/metadata addresses refused by default ─────────────────────────────
test("F2 abuse: loopback, private and cloud-metadata addresses are refused", async () => {
  for (const u of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/", "http://10.0.0.5/"]) {
    await assert.rejects(assertSafeUrl(u), /private|local/i, `should refuse ${u}`);
  }
});
test("F2 abuse: localhost by name is refused", async () => {
  await assert.rejects(assertSafeUrl("http://localhost:3030/"), /private|local/i);
});
test("F2 control: a public IP is allowed; and localhost is allowed WITH --allow-private", async () => {
  await assert.doesNotReject(assertSafeUrl("http://8.8.8.8/", { allowPrivate: false }));
  await assert.doesNotReject(assertSafeUrl("http://localhost:3030/", { allowPrivate: true }));
});
test("F2 unit: isPrivateIp classifies ranges correctly", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "::1", "fe80::1", "fc00::1", "100.64.0.1", "0.0.0.0"]) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"]) assert.equal(isPrivateIp(ip), false, ip);
});
test("F2 regression: canonical IPv6 forms and IPv4-mapped metadata are NOT a bypass", async () => {
  // These slipped past the original hand-rolled check; ipaddr.js canonicalizes them.
  for (const ip of ["0:0:0:0:0:0:0:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:127.0.0.1", "::"]) {
    assert.equal(isPrivateIp(ip), true, `isPrivateIp should block ${ip}`);
  }
  for (const u of ["http://[::1]/", "http://[0:0:0:0:0:0:0:1]/", "http://[::ffff:169.254.169.254]/"]) {
    await assert.rejects(assertSafeUrl(u), /private|local/i, `assertSafeUrl should refuse ${u}`);
  }
});
test("F1 end-to-end: the CLI rejects an injection-shaped URL before spawning Lighthouse", () => {
  // Malformed authority → new URL() throws at the validation gate, so the payload never reaches a
  // subprocess. (Deterministic offline; a well-formed URL is separately proven inert as one argv.)
  const r = spawnSync(process.execPath, [WG, "lighthouse", "http:// &echo WGPWNED", "--runs", "1"], { encoding: "utf8" });
  assert.notEqual(r.status, 0, "should exit non-zero");
  assert.match(r.stdout + r.stderr, /Refused|valid URL/i);
  assert.doesNotMatch(r.stdout + r.stderr, /WGPWNED executed|^WGPWNED$/m); // never ran
});

// ── F3: Chrome sandbox stays on unless explicitly opted out ───────────────────────────────────────
test("F3 control: sandbox stays ON by default", () => {
  assert.equal(sandboxOptIn([]), false);
});
test("F3 abuse->opt-in: only a deliberate flag or env var turns the sandbox off", () => {
  assert.equal(sandboxOptIn(["--no-sandbox"]), true);
  const prev = process.env.WG_NO_SANDBOX;
  process.env.WG_NO_SANDBOX = "1";
  try { assert.equal(sandboxOptIn([]), true); } finally { if (prev === undefined) delete process.env.WG_NO_SANDBOX; else process.env.WG_NO_SANDBOX = prev; }
});

// ── F4: file writes stay inside the allowed directory ─────────────────────────────────────────────
test("F4 abuse: a path outside the base directory is refused", () => {
  const base = mkdtempSync(join(tmpdir(), "wg-"));
  try {
    assert.throws(() => assertDirInside(join(base, "..", "escape"), base), /outside/i);
    assert.throws(() => assertDirInside(process.platform === "win32" ? "C:/Windows" : "/etc", base), /outside/i);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
test("F4 control: a subdirectory of the base is allowed", () => {
  const base = mkdtempSync(join(tmpdir(), "wg-"));
  try {
    const ok = assertDirInside(join(base, "public"), base);
    assert.ok(ok.startsWith(base));
  } finally { rmSync(base, { recursive: true, force: true }); }
});
test("F4 regression (file-level): a HARD-LINKED output file cannot be written through to escape", () => {
  // The reviewer's exact bypass: an individual output file is a hard link to a file outside the dir.
  const root = mkdtempSync(join(tmpdir(), "wg-"));
  const site = join(root, "site"); mkdirSync(site);
  const secret = join(root, "secret.txt"); writeFileSync(secret, "ORIGINAL");
  const out = join(site, "out.txt");
  linkSync(secret, out);                                   // hard link inside the site dir
  try {
    writeFileContained(site, out, "REPLACED");
    assert.equal(readFileSync(secret, "utf8"), "ORIGINAL", "external hard-link target must be untouched");
    assert.equal(readFileSync(out, "utf8"), "REPLACED", "the in-dir file is updated");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("F4 regression (file-level): a SYMLINKED output file is replaced, not written through", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wg-"));
  const site = join(root, "site"); mkdirSync(site);
  const secret = join(root, "secret.txt"); writeFileSync(secret, "ORIGINAL");
  const out = join(site, "out.txt");
  try { symlinkSync(secret, out, "file"); } catch { return t.skip("cannot create symlink here"); }
  try {
    writeFileContained(site, out, "REPLACED");
    assert.equal(readFileSync(secret, "utf8"), "ORIGINAL", "external symlink target must be untouched");
    assert.equal(readFileSync(out, "utf8"), "REPLACED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("F4 regression: a symlink/junction inside the base that points OUT is refused", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wg-"));
  const base = join(root, "site"); mkdirSync(base);
  const outside = join(root, "outside"); mkdirSync(outside);
  const link = join(base, "escape");
  try { symlinkSync(outside, link, "junction"); }           // junction works without admin on Windows
  catch { try { symlinkSync(outside, link, "dir"); } catch { return t.skip("cannot create symlink here"); } }
  try {
    // Lexical checks are fooled because base/escape/... textually looks inside base; realpath isn't.
    assert.throws(() => assertDirInside(join(link, "sub"), base), /outside/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── F6: redirect targets are re-validated, not just the initial URL (safeFetch) ───────────────────
// Found by Codex's adversarial review (2026-10-01): cookies.mjs/privacy.mjs/media.mjs called a bare
// fetch() with its default redirect:"follow" — a site that passes assertSafeUrl and then issues a
// 302 to a private/internal address sails straight through. safeFetch() is the fix: it follows
// redirects by hand and re-validates every hop's target through assertSafeUrl. A private-IP redirect
// target specifically needs DNS control to test hermetically, so this proves the mechanism that
// would ALSO catch that case: assertSafeUrl's protocol/forbidden-character checks fire on every
// redirect hop, not just the first request.
function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
test("F6 regression: safeFetch re-validates a redirect's Location target (bad scheme)", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/go") { res.writeHead(302, { Location: "javascript:alert(1)" }); res.end(); }
    else { res.writeHead(200); res.end("ok"); }
  });
  const port = await listen(server);
  try {
    await assert.rejects(
      safeFetch(`http://127.0.0.1:${port}/go`, { allowPrivate: true }),
      /http/i,
      "a redirect to a non-http(s) scheme must be refused even though the initial hop was allowed"
    );
  } finally { server.close(); }
});
test("F6 regression: safeFetch re-validates a redirect's Location target (forbidden characters)", async () => {
  // Note: "<" / ">" / "^" / backtick are auto-percent-encoded by the URL constructor itself before
  // FORBIDDEN_URL_CHARS ever sees them — not a gap, just means they're the wrong payload to prove
  // this with. "|" survives URL normalization verbatim, so it's the one that actually exercises the
  // check (confirmed empirically, not assumed).
  const server = createServer((req, res) => {
    if (req.url === "/go") { res.writeHead(302, { Location: "http://example.com/a|b" }); res.end(); }
    else { res.writeHead(200); res.end("ok"); }
  });
  const port = await listen(server);
  try {
    await assert.rejects(
      safeFetch(`http://127.0.0.1:${port}/go`, { allowPrivate: true }),
      /not allowed/i,
      "a redirect target containing forbidden characters must be refused"
    );
  } finally { server.close(); }
});
test("F6 control: safeFetch follows a normal same-origin redirect and returns the final response", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/go") { res.writeHead(302, { Location: "/landed" }); res.end(); }
    else { res.writeHead(200); res.end("ok"); }
  });
  const port = await listen(server);
  try {
    const { res, finalUrl } = await safeFetch(`http://127.0.0.1:${port}/go`, { allowPrivate: true });
    assert.equal(res.status, 200);
    assert.match(finalUrl, /\/landed$/);
  } finally { server.close(); }
});

// ── F7: the local static server (serve-with-headers.mjs) can't be escaped or crashed by a request ──
// Found by Codex's adversarial review (2026-10-01): it served a file outside its root through a
// directory junction (the old code only checked the URL text for ".." — a junction inside the root
// that points out is reached by a perfectly normal-looking path), and a malformed percent-encoded
// URL (decodeURIComponent throwing on e.g. "%zz") crashed the request handler uncaught.
function rawRequest(port, rawPath) {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("end", () => resolve(data));
    sock.on("error", reject);
  });
}
test("F7 regression: a directory junction inside the served root cannot be used to escape it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wg-serve-"));
  const outside = mkdtempSync(join(tmpdir(), "wg-outside-"));
  writeFileSync(join(outside, "secret.txt"), "SHOULD NOT BE SERVED");
  const link = join(root, "escape");
  try { symlinkSync(outside, link, "junction"); }
  catch { try { symlinkSync(outside, link, "dir"); } catch { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); return t.skip("cannot create symlink here"); } }
  return (async () => {
    const server = createStaticServer(root);
    const port = await listen(server);
    try {
      const raw = await rawRequest(port, "/escape/secret.txt");
      assert.doesNotMatch(raw, /SHOULD NOT BE SERVED/, "the junction target must not be served");
      assert.match(raw, /403|404/, "should be refused, not served");
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  })();
});
test("F7 regression: a malformed percent-encoded URL returns 400, not a crash", async () => {
  const root = mkdtempSync(join(tmpdir(), "wg-serve-"));
  writeFileSync(join(root, "index.html"), "hi");
  const server = createStaticServer(root);
  const port = await listen(server);
  try {
    const raw = await rawRequest(port, "/%zz");       // invalid percent-encoding — decodeURIComponent throws
    assert.match(raw, /400/, "should respond 400, proving the handler didn't crash on this request");
    // server must still be alive for the next request
    const raw2 = await rawRequest(port, "/index.html");
    assert.match(raw2, /200/);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});
test("F7 control: a normal file under the root is served with its headers applied", async () => {
  const root = mkdtempSync(join(tmpdir(), "wg-serve-"));
  writeFileSync(join(root, "_headers"), "/*\n  X-Test: yes\n");
  writeFileSync(join(root, "index.html"), "hi");
  const server = createStaticServer(root);
  const port = await listen(server);
  try {
    const raw = await rawRequest(port, "/index.html");
    assert.match(raw, /200/);
    assert.match(raw, /X-Test: yes/i);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

// ── F8: scanning untrusted page content can't be turned into a resource-exhaustion lever ──────────
// Found by Codex's adversarial review (2026-10-01): privacy.mjs's and media.mjs's regex scans over
// fetched HTML took over a second against pathological input. Neither regex has nested unbounded
// quantifiers (not classic catastrophic backtracking), but both are still roughly O(n^2) on
// adversarial input, which is enough to stall on an attacker-sized page. The fix caps how much HTML
// is scanned; this proves the cap actually bounds the time regardless of pattern complexity.
test("F8 regression: scanning a pathological multi-megabyte page stays fast", async () => {
  // A single unclosed tag with no ">" forces [^>]+ to consume to the end before backtracking to look
  // for "src=", repeated across the whole (capped) input — the worst case the cap is meant to bound.
  const evil = "<script " + "a".repeat(5_000_000);
  const server = createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(evil); });
  const port = await listen(server);
  try {
    const { checkPrivacy } = await import("../lib/privacy.mjs");
    const start = Date.now();
    const result = await checkPrivacy(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 3000, `checkPrivacy took ${elapsed}ms against pathological input — the scan cap isn't bounding it`);
    assert.deepEqual(result.thirdParty, []);
  } finally { server.close(); }
});

// ── F9: structured data (schema.org/JSON-LD) detection and scoring ────────────────────────────────
test("F9 control: a complete Organization block scores 100%", async () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Organization","name":"Acme","url":"https://acme.test","logo":"https://acme.test/logo.png","sameAs":["https://x.com/acme"]}
  </script></head><body></body></html>`;
  const server = createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); });
  const port = await listen(server);
  try {
    const { checkSchema } = await import("../lib/schema.mjs");
    const r = await checkSchema(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    assert.equal(r.hasSchema, true);
    assert.equal(r.blocks.length, 1);
    assert.equal(r.blocks[0].type, "Organization");
    assert.equal(r.blocks[0].score, 100);
    assert.equal(r.malformed, 0);
  } finally { server.close(); }
});
test("F9 regression: an incomplete block reports exactly which fields are missing", async () => {
  const html = `<script type="application/ld+json">{"@type":"LocalBusiness","name":"Acme Shop"}</script>`;
  const server = createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); });
  const port = await listen(server);
  try {
    const { checkSchema } = await import("../lib/schema.mjs");
    const r = await checkSchema(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    assert.equal(r.blocks[0].score, 25); // 1 of 4 recommended fields (name) present
    assert.deepEqual(r.blocks[0].missing.sort(), ["address", "telephone", "url"]);
  } finally { server.close(); }
});
test("F9 regression: malformed JSON-LD is flagged, not silently dropped or crashed on", async () => {
  const html = `<script type="application/ld+json">{"@type":"Organization", "name": "Acme",}</script>`; // trailing comma — invalid JSON
  const server = createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); });
  const port = await listen(server);
  try {
    const { checkSchema } = await import("../lib/schema.mjs");
    const r = await checkSchema(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    assert.equal(r.malformed, 1);
    assert.equal(r.blocks.length, 0);
  } finally { server.close(); }
});
test("F9 control: no structured data on the page is reported honestly, not as an error", async () => {
  const server = createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html><body>hi</body></html>"); });
  const port = await listen(server);
  try {
    const { checkSchema } = await import("../lib/schema.mjs");
    const r = await checkSchema(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    assert.equal(r.hasSchema, false);
    assert.equal(r.overallScore, null);
  } finally { server.close(); }
});
test("F9 regression: structurally odd but valid JSON-LD doesn't crash the check", async () => {
  // @graph as an object (not an array), @graph as a string, and a bare null are all valid JSON but
  // not the shape flattenJsonLd expected — each previously threw (items.filter is not a function /
  // reading '@graph' of null) and aborted the entire SEO check for the page. Now absorbed, not thrown.
  for (const body of [`{"@graph":{"@type":"Organization","name":"x"}}`, `{"@graph":"nope"}`, `null`]) {
    const html = `<script type="application/ld+json">${body}</script>`;
    const server = createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); });
    const port = await listen(server);
    try {
      const { checkSchema } = await import("../lib/schema.mjs");
      const r = await checkSchema(`http://127.0.0.1:${port}/`, { allowPrivate: true }); // must not reject
      assert.equal(r.malformed, 0);       // it parsed fine — it's just an odd shape, not broken JSON
      assert.ok(Array.isArray(r.blocks)); // a usable result came back instead of a crash
    } finally { server.close(); }
  }
});
test("F9 regression: a valid block in an oversized response is still found, bounded by the read cap", async () => {
  // The body is far larger than MAX_SCAN_CHARS. readTextCapped must stream-and-stop rather than buffer
  // the whole thing via res.text() — the block is at the top, so it's captured well within the cap.
  const block = `<script type="application/ld+json">{"@type":"Organization","name":"Acme","url":"https://acme.test","logo":"https://acme.test/l.png","sameAs":["https://x.com/a"]}</script>`;
  const server = createServer((req, res) => {
    res.on("error", () => {});            // the client cancels mid-stream once it hits the cap; ignore the reset
    res.writeHead(200, { "Content-Type": "text/html" });
    res.write(block);
    res.end("x".repeat(6_000_000));       // 6MB of filler past the 2MB cap
  });
  const port = await listen(server);
  try {
    const { checkSchema } = await import("../lib/schema.mjs");
    const start = Date.now();
    const r = await checkSchema(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    const elapsed = Date.now() - start;
    assert.equal(r.hasSchema, true);
    assert.equal(r.blocks[0].score, 100);
    assert.ok(elapsed < 3000, `took ${elapsed}ms on a 6MB body — the read cap isn't bounding the download`);
  } finally { server.close(); }
});

// ── F10: non-web URLs get a plain refusal, not a confusing usage line (found 2026-10-02) ─────────────
test("F10 abuse: file:// and ftp:// URLs are refused with a clear message by every check", () => {
  for (const cmd of ["headers", "cookies", "privacy", "media", "schema"]) {
    for (const bad of ["file:///etc/passwd", "ftp://example.com/"]) {
      const r = spawnSync(process.execPath, [WG, cmd, bad], { encoding: "utf8" });
      assert.equal(r.status, 2, `${cmd} ${bad} should exit 2`);
      assert.match(r.stderr, /Refused: only http:\/\/ and https:\/\/ URLs/, `${cmd} ${bad}: ${r.stderr}`);
    }
  }
});
test("F10 control: a Windows path argument is not mistaken for a URL", () => {
  const r = spawnSync(process.execPath, [WG, "headers", "C:\\out"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage:/);
});

// ── F11: the skills ship physical copies of lib/ — they must never drift from it (found 2026-10-02) ──
test("F11: every script a skill shares with lib/ is byte-identical to lib/", async () => {
  const { readdirSync, existsSync } = await import("node:fs");
  const root = join(HERE, "..");
  const drift = [];
  for (const skill of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const dir = join(root, skill.name, "scripts");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const twin = join(root, "lib", f);
      if (existsSync(twin) && readFileSync(twin, "utf8") !== readFileSync(join(dir, f), "utf8")) drift.push(`${skill.name}/scripts/${f}`);
    }
  }
  assert.deepEqual(drift, [], "copy lib/ into these after changing it: " + drift.join(", "));
});

// ── F12: the HTML report must say which website it assessed, up top (found 2026-10-02) ──────────────
// A forwarded or printed report that only said "Website Precheck" couldn't be tied to a site.
test("F12: the HTML report names the assessed site in its header, escaped", async () => {
  const { toHTML } = await import("../lib/report.mjs");
  const report = JSON.parse(readFileSync(join(HERE, "fixtures", "report-example.json"), "utf8"));
  const html = toHTML(report);
  const top = html.slice(html.indexOf("<body"), html.indexOf('class="top-gauges"'));
  assert.match(top, /class="assessed-lbl">Website assessed</);
  assert.match(top, /class="assessed-site"[^>]*>example\.com</);
  assert.ok(top.includes("https://example.com/"), "full URL shown under the site name");

  // a hostile URL in the report data can't break out of the attribute or inject markup
  const evil = { ...report, url: 'https://example.com/"><script>alert(1)</script>' };
  const out = toHTML(evil);
  assert.ok(!out.includes("<script>alert(1)</script>"), "URL must be HTML-escaped");
});

// ── F13: "Fix this first" ranks by real impact, not by which check ran first (found 2026-10-02) ──────
test("F13: a 'serious' accessibility issue no longer outranks security; ties go Security first", async () => {
  const { rankFindings } = await import("../lib/report.mjs");
  const ranked = rankFindings([
    { severity: "medium", category: "Accessibility", title: "Low colour contrast (axe: serious)" },
    { severity: "medium", category: "Speed", title: "Render-blocking CSS" },
    { severity: "medium", category: "Security", title: "Missing X-Frame-Options" },
    { severity: "low", category: "Security", title: "Server header" },
    { severity: "high", category: "Security", title: "Missing CSP" },
  ]).map((f) => f.title);
  assert.deepEqual(ranked, ["Missing CSP", "Missing X-Frame-Options", "Low colour contrast (axe: serious)", "Render-blocking CSS", "Server header"]);
});
test("F13 control: a truly critical accessibility blocker still ranks above a medium security gap", async () => {
  const { rankFindings } = await import("../lib/report.mjs");
  const ranked = rankFindings([
    { severity: "medium", category: "Security", title: "Missing X-Frame-Options" },
    { severity: "high", category: "Accessibility", title: "Button unreachable by keyboard (axe: critical)" },
  ]).map((f) => f.title);
  assert.equal(ranked[0], "Button unreachable by keyboard (axe: critical)");
});

// ── F14: site-specific fixes (2026-10-02: "it provides generic fixes") ───────────────────────────────
test("F14: CSP is built from what the page loads; inline scripts get their exact sha256", async () => {
  const { profileFromHtml, buildCsp } = await import("../lib/specifics.mjs");
  const html = `<html lang="en"><head><title>Acme &amp; Co · Widgets for everyone</title>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
    <script src="https://cdn.example.net/lib.js"></script><script>console.log(1)</script></head>
    <body><img src="https://img.example.org/a.png"><button onclick="go()">Go</button></body></html>`;
  const p = profileFromHtml(html, "https://acme.test/");
  const csp = buildCsp(p).value;
  assert.match(csp, /script-src 'self' https:\/\/cdn\.example\.net 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /font-src 'self' https:\/\/fonts\.gstatic\.com/);
  assert.match(csp, /style-src 'self' https:\/\/fonts\.googleapis\.com/);
  assert.match(csp, /img-src 'self' data: https:\/\/img\.example\.org/);
  assert.equal(p.inlineHandlers.length, 1, "inline onclick handler is reported (a CSP would block it)");
  assert.deepEqual(p.scriptsWithoutSri, ["https://cdn.example.net/lib.js"]);
});
test("F14: host detection drives the fix format (Netlify → _headers, nginx → add_header)", async () => {
  const { detectPlatform, headerFixFor, headerValues } = await import("../lib/specifics.mjs");
  const pairs = headerValues(["x-frame-options", "referrer-policy"], "default-src 'self'");
  const netlify = headerFixFor(detectPlatform({ server: "Netlify" }), pairs);
  assert.match(netlify.where, /_headers/);
  assert.equal(netlify.code, "/*\n  X-Frame-Options: SAMEORIGIN\n  Referrer-Policy: strict-origin-when-cross-origin");
  const nginx = headerFixFor(detectPlatform({ server: "nginx/1.25" }), pairs);
  assert.match(nginx.code, /^add_header X-Frame-Options "SAMEORIGIN" always;/);
  assert.equal(detectPlatform({ "x-vercel-id": "x" }).id, "vercel");
});
test("F14: contrast fix returns a colour that actually passes; schema name is clean", async () => {
  const { contrastFix, contrastRatio, profileFromHtml, schemaFor } = await import("../lib/specifics.mjs");
  const fix = contrastFix("#999999", "#ffffff", 4.5);
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  assert.ok(contrastRatio(rgb(fix.color), [255, 255, 255]) >= 4.5, `${fix.color} must reach 4.5:1`);
  const p = profileFromHtml(`<title>Acme &amp; Co · Widgets for everyone</title><meta name="description" content="We make widgets.">`, "https://acme.test/");
  assert.match(schemaFor(p).code, /"name": "Acme & Co"/);
});

// ── F15: whole-site report — every page is found and checked; a leak on an inner page is caught ──
test("F15: page finder keeps same-site pages only and folds /index.html into /", async () => {
  const { extractLinks, normalizePageUrl } = await import("../lib/crawl.mjs");
  const links = extractLinks(`<a href="/">h</a><a href="about.html">a</a><a href="/about.html#team">a2</a><a href="https://other.test/x">o</a>
    <a href="mailto:x@site.test">m</a><a href="/brochure.pdf">p</a><a href="javascript:void(0)">j</a><a href=/build?ref=nav>b</a><a href="index.html">i</a>`, "https://site.test/");
  assert.deepEqual(links, ["https://site.test/", "https://site.test/about.html", "https://site.test/build"]);
  assert.equal(normalizePageUrl("https://site.test/blog/index.html?x=1#y"), "https://site.test/blog/");
});

test("F15: a key in a data file loaded only by an inner page fails the SITE, naming that page and file", async () => {
  const { discoverPages } = await import("../lib/crawl.mjs");
  const { readPageProfile, securityChecklist } = await import("../lib/specifics.mjs");
  const { mergeChecklists } = await import("../lib/report.mjs");
  const fakeKey = "sk-" + "ant-" + "api03-" + "Zq7".repeat(12);      // built at runtime so no real-looking key sits in the repo
  const files = {
    "/": `<html><body><a href="/about">About</a><a href="/contact.html">Contact</a></body></html>`,
    "/about": `<html><body><a href="/">Home</a><script src="/assets/app.js"></script></body></html>`,
    "/contact.html": `<html><body>Contact</body></html>`,
    "/assets/app.js": `fetch("data/team.json").then(r => r.json());`,
    "/data/team.json": JSON.stringify({ team: [{ name: "Pat Lee", email: "pat.lee@site-staff.test" }], apiKey: fakeKey }),
  };
  const srv = createServer((q, r) => {
    const body = files[q.url];
    if (!body) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { "content-type": q.url.endsWith(".js") ? "text/javascript" : q.url.endsWith(".json") ? "application/json" : "text/html" });
    r.end(body);
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const found = await discoverPages(base + "/", { allowPrivate: true });
    assert.deepEqual(found.pages.map((u) => new URL(u).pathname), ["/", "/about", "/contact.html"]);
    const cache = new Map();
    const perPage = [];
    for (const u of found.pages) {
      const profile = await readPageProfile(u, { allowPrivate: true });
      const checklist = await securityChecklist({ url: u, headers: null, cookies: null, privacy: null, profile, platform: { id: "unknown", name: "x" }, allowPrivate: true, probeCache: cache });
      for (const i of checklist.items) i.section = "Security";
      perPage.push({ path: new URL(u).pathname, checklist });
    }
    const site = mergeChecklists(perPage);
    const secrets = site.items.find((i) => i.id === "secrets-in-code");
    assert.equal(secrets.status, "fail");
    assert.deepEqual(secrets.pages, ["/about"]);
    assert.match(secrets.detail, /data\/team\.json/);
    assert.ok(!secrets.detail.includes(fakeKey), "the key must be masked in the report");
    const emails = site.items.find((i) => i.id === "emails-in-code");
    assert.equal(emails.status, "warn");
    assert.match(emails.detail, /pa…@site-staff\.test/);
  } finally { srv.close(); }
});

test("F15: the same footer element on every page is listed once, with its pages; site issues merge", async () => {
  const { mergeFindings } = await import("../lib/report.mjs");
  const tap = (extra = []) => ({ key: "mobile:tap-targets", category: "Mobile", severity: "medium", title: "x", plain: "x", count: 1 + extra.length,
    elements: [{ target: "footer a.privacy", summary: "16px tall" }, ...extra], code: "footer a.privacy { min-height: 24px; }" });
  const merged = mergeFindings([
    { path: "/", findings: [tap()] },
    { path: "/about", findings: [tap([{ target: "a.cwe", summary: "17px tall" }])] },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].pages, ["/", "/about"]);
  assert.equal(merged[0].elements.length, 2);
  assert.deepEqual(merged[0].elements.find((e) => e.target === "footer a.privacy").pages, ["/", "/about"]);
  assert.match(merged[0].plain, /^2 buttons\/links/);
});
