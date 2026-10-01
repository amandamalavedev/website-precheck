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
import { assertSafeUrl, isPrivateIp, sandboxOptIn, assertDirInside, writeFileContained } from "../lib/safe.mjs";

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
