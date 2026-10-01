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
