// Shared safety helpers for the web-guardrails checks.
// A distributed skill carries its own copy of this file next to the script that imports it.
//
// These exist because the toolkit may be driven by an AI agent acting on untrusted input (a web
// page, a README) — so a URL or path reaching a check could be attacker-chosen. We never pass input
// through a shell (see each script), refuse internal/metadata addresses by default (SSRF), keep
// Chrome's sandbox on, and keep file writes inside an allowed directory.
//
// IP classification is delegated to ipaddr.js (the library Express uses) rather than hand-rolled —
// hand-rolled IPv6 handling missed canonical forms (expanded ::1, IPv4-mapped metadata like
// ::ffff:169.254.169.254), which were real SSRF bypasses. Requires `ipaddr.js` to be installed.
import net from "node:net";
import dns from "node:dns/promises";
import ipaddr from "./ipaddr.cjs"; // vendored (see lib/ipaddr.cjs) so standalone skills need no install
import { realpathSync, existsSync, writeFileSync, renameSync, lstatSync, unlinkSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";

// Characters that must never appear in a URL we hand to a subprocess or fetch. Defense in depth — we
// also remove the shell everywhere — so this blocks obvious breakout characters (quotes, backtick,
// pipe, redirects, braces, parens, whitespace) without rejecting legitimate query strings, where
// ?, &, =, %, # and friends are all fine.
const FORBIDDEN_URL_CHARS = /[\s"'`\\|^<>(){}]/;

// Only a public, global-unicast address is allowed to be reached. Everything else — loopback,
// link-local (incl. 169.254.169.254 cloud metadata), unique-local, private, CGNAT, reserved,
// multicast, unspecified — is refused. ipaddr canonicalizes every IPv6 form and unwraps
// IPv4-mapped addresses, so no textual variation slips through. Unparseable → refuse (fail safe).
export function isPrivateIp(ip) {
  let addr;
  try { addr = ipaddr.parse(ip); } catch { return true; }
  if (addr.kind() === "ipv6" && addr.isIPv4MappedAddress()) addr = addr.toIPv4Address();
  return addr.range() !== "unicast";
}

// Resolve a hostname (or accept an IP literal) and decide whether it is safe to connect to. Caches
// per host. Used both for the initial URL and for every browser request (redirects/subresources).
const hostDecision = new Map();
export async function hostIsPublic(host) {
  if (!host) return true;                                   // non-network (data:/about:/blob:)
  const key = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostDecision.has(key)) return hostDecision.get(key);
  let ok;
  if (/^(localhost|.*\.localhost)$/i.test(key)) ok = false;
  else if (net.isIP(key)) ok = !isPrivateIp(key);
  else {
    try {
      const addrs = (await dns.lookup(key, { all: true })).map((a) => a.address);
      ok = addrs.length > 0 && !addrs.some(isPrivateIp);
    } catch { ok = false; }
  }
  hostDecision.set(key, ok);
  return ok;
}

// Validate a URL and, unless allowPrivate, refuse one that resolves to a non-public address.
// Returns the normalized href, or throws Error with a clear message.
export async function assertSafeUrl(input, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(input); } catch { throw new Error(`Not a valid URL: ${input}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Only http/https URLs are allowed (got ${u.protocol}).`);
  if (FORBIDDEN_URL_CHARS.test(u.href)) throw new Error("URL contains characters that are not allowed.");
  if (!allowPrivate && !(await hostIsPublic(u.hostname))) {
    throw new Error(`Refusing to connect to a private/local address (${u.hostname}). Use --allow-private only for a site you trust on your own network.`);
  }
  return u.href;
}

// Chrome's sandbox stays ON by default — these tools load untrusted pages. Only disable it on an
// explicit opt-in (WG_NO_SANDBOX=1, or a --no-sandbox flag), e.g. a CI container running as root.
export function sandboxOptIn(args = []) {
  return process.env.WG_NO_SANDBOX === "1" || args.includes("--no-sandbox");
}

// Keep a chosen output directory inside an allowed base (default: the current working directory),
// so a tricked agent can't write files anywhere. Resolves symlinks/junctions on the existing part
// of the path first — a purely lexical check accepts a junction inside the base that points out.
export function assertDirInside(outDir, baseDir = process.cwd()) {
  let base = resolve(baseDir);
  try { base = realpathSync(base); } catch { /* base may not exist yet; use the lexical path */ }
  const out = resolve(outDir);
  // realpath the deepest existing ancestor so a symlink/junction anywhere on the path is resolved,
  // even when the final directory doesn't exist yet.
  let probe = out;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  let realProbe = probe;
  try { realProbe = realpathSync(probe); } catch { /* keep lexical */ }
  const realOut = resolve(realProbe, relative(probe, out));
  const rel = relative(base, realOut);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) throw new Error(`Refusing to write outside ${base}: ${realOut}`);
  return realOut;
}

// Write a file so it can't escape its directory through a symlink OR a hard link.
// assertDirInside() confines the DIRECTORY, but the individual target file could itself be a hard
// link or symlink pointing outside, and a plain writeFileSync would follow it and clobber the
// external file. Defenses: (1) confirm the containing dir is inside base; (2) if the target is a
// symlink, unlink it first (replace the link, never write through it); (3) write to a fresh temp file
// with exclusive-create, then rename over the target — rename swaps the directory ENTRY without
// touching the aliased inode, so a hard link's other name keeps its old content.
export function writeFileContained(baseDir, targetPath, content) {
  const target = resolve(targetPath);
  assertDirInside(dirname(target), baseDir);
  try { if (lstatSync(target).isSymbolicLink()) unlinkSync(target); } catch { /* doesn't exist — fine */ }
  const tmp = join(dirname(target), `.wg-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, content, { flag: "wx" }); // wx: exclusive create, never follow an existing link
  try { renameSync(tmp, target); }
  catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; }
}

export function flag(args, name) { return args.includes("--" + name); }
