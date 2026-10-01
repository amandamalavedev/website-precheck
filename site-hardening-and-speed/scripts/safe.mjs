// Shared safety helpers for the web-guardrails checks.
// A distributed skill carries its own copy of this file next to the script that imports it.
//
// These exist because the toolkit may be driven by an AI agent acting on untrusted input (a web
// page, a README) — so a URL or path reaching a check could be attacker-chosen. We never pass input
// through a shell (see each script), refuse internal/metadata addresses by default (SSRF), keep
// Chrome's sandbox on, and keep file writes inside an allowed directory.
import net from "node:net";
import dns from "node:dns/promises";
import { resolve, relative, isAbsolute } from "node:path";

// Characters that must never appear in a URL we hand to a subprocess or fetch. Defense in depth — we
// also remove the shell everywhere — so this blocks obvious breakout characters (quotes, backtick,
// pipe, redirects, braces, parens, whitespace) without rejecting legitimate query strings, where
// ?, &, =, %, # and friends are all fine.
const FORBIDDEN_URL_CHARS = /[\s"'`\\|^<>(){}]/;

export function isPrivateIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p[0] === 127) return true;                                   // loopback
    if (p[0] === 10) return true;                                    // private
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;       // private
    if (p[0] === 192 && p[1] === 168) return true;                   // private
    if (p[0] === 169 && p[1] === 254) return true;                   // link-local incl. 169.254.169.254 cloud metadata
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;      // CGNAT
    if (p[0] === 0) return true;                                     // 0.0.0.0/8
    return false;
  }
  if (v === 6) {
    const a = ip.toLowerCase();
    if (a === "::1" || a === "::") return true;                      // loopback / unspecified
    if (a.startsWith("fe80")) return true;                          // link-local
    if (a.startsWith("fc") || a.startsWith("fd")) return true;       // unique-local fc00::/7
    if (a.startsWith("::ffff:")) return isPrivateIp(a.slice(7));     // v4-mapped
    return false;
  }
  return false;
}

// Validate a URL and, unless allowPrivate, refuse one that resolves to a loopback/private/link-local/
// metadata address. Returns the normalized href, or throws Error with a clear message.
export async function assertSafeUrl(input, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(input); } catch { throw new Error(`Not a valid URL: ${input}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Only http/https URLs are allowed (got ${u.protocol}).`);
  if (FORBIDDEN_URL_CHARS.test(u.href)) throw new Error("URL contains characters that are not allowed.");
  if (!allowPrivate) {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (/^(localhost|.*\.localhost)$/i.test(host)) throw new Error(privateMsg(host));
    let addrs;
    if (net.isIP(host)) addrs = [host];
    else {
      try { addrs = (await dns.lookup(host, { all: true })).map((a) => a.address); }
      catch { throw new Error(`Could not resolve host: ${host}`); }
    }
    const bad = addrs.find(isPrivateIp);
    if (bad) throw new Error(privateMsg(bad));
  }
  return u.href;
}
const privateMsg = (who) => `Refusing to connect to a private/local address (${who}). Use --allow-private only for a site you trust on your own network.`;

// Chrome's sandbox stays ON by default — these tools load untrusted pages. Only disable it on an
// explicit opt-in (WG_NO_SANDBOX=1, or a --no-sandbox flag), e.g. a CI container running as root.
export function sandboxOptIn(args = []) {
  return process.env.WG_NO_SANDBOX === "1" || args.includes("--no-sandbox");
}

// Keep a chosen output directory inside an allowed base (default: the current working directory),
// so a tricked agent can't write sitemap.xml/robots.txt/llms.txt anywhere on disk.
export function assertDirInside(outDir, baseDir = process.cwd()) {
  const out = resolve(outDir);
  const base = resolve(baseDir);
  const rel = relative(base, out);
  if (rel === "") return out;
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Refusing to write outside ${base}: ${out}`);
  return out;
}

export function flag(args, name) { return args.includes("--" + name); }
