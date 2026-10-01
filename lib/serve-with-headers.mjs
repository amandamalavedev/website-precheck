#!/usr/bin/env node
// Serve a static site locally the way Netlify/Cloudflare Pages actually serve it in production:
// honoring the `_headers` file. Node's `http-server`, Python's `http.server`, and most other local
// static servers silently ignore `_headers` — it's a platform-specific convention, not a web
// standard — so a security-header check run against a plain local static server will always show
// "missing" headers even when they're correctly configured and will work once deployed. That false
// signal is worse than no signal: it makes a real report.mjs run look wrong, or (worse) trains
// someone to "fix" headers that were never broken. Use this instead of python -m http.server / npx
// http-server whenever you need to test a static site's headers locally before deploying it.
//
// Usage: node serve-with-headers.mjs [dir] [--port 4747]
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute, extname } from "node:path";
import { pathToFileURL } from "node:url";

const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json", ".pdf": "application/pdf",
};

// Minimal Netlify/Cloudflare Pages `_headers` parser: blank-line-separated blocks, first line of
// each block is a path pattern, subsequent indented lines are "Name: value". Supports an exact
// path, a `/*` trailing wildcard prefix, and an unprefixed `/*` catch-all. Good enough for the
// common case; not a full implementation of Netlify's redirect/header matching engine.
export function parseHeadersFile(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) { current = null; continue; }
    if (!/^\s/.test(raw)) {
      current = { pattern: line.trim(), headers: [] };
      rules.push(current);
    } else if (current) {
      const m = line.trim().match(/^([^:]+):\s*(.*)$/);
      if (m) current.headers.push([m[1].trim(), m[2].trim()]);
    }
  }
  return rules;
}

function matches(pattern, urlPath) {
  if (pattern === urlPath) return true;
  if (pattern.endsWith("/*")) return urlPath.startsWith(pattern.slice(0, -1));
  return false;
}

export function headersForPath(rules, urlPath) {
  const out = {};
  for (const rule of rules) if (matches(rule.pattern, urlPath)) for (const [name, value] of rule.headers) out[name] = value;
  return out;
}

export function createStaticServer(root, { headersFile = "_headers" } = {}) {
  const rootDir = resolve(root);
  const rootReal = realpathSync(rootDir); // the serve root itself must exist
  const headersPath = join(rootDir, headersFile);
  const rules = existsSync(headersPath) ? parseHeadersFile(readFileSync(headersPath, "utf8")) : [];

  // The lexical ".." check below is a fast-path, not the real protection: a directory junction
  // (Windows) or symlink sitting INSIDE rootDir that points OUTSIDE it is reached by a perfectly
  // normal-looking path with no ".." anywhere in it, and Node's fs calls follow it transparently.
  // Confirmed as a real bypass in this codebase (2026-10-01) — a request for a path through such a
  // junction served a file outside the root. realpath the resolved file and re-check containment
  // against the root's realpath before ever reading it; this is the same class of defense
  // assertDirInside()/writeFileContained() in safe.mjs use for writes, applied here to reads.
  function containedRealPath(candidate) {
    let real;
    try { real = realpathSync(candidate); } catch { return null; }
    const rel = relative(rootReal, real);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return real;
    return null;
  }

  return createServer((req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent((req.url || "/").split("?")[0]); }
    catch { res.writeHead(400).end("Bad request"); return; } // malformed percent-encoding (e.g. "%zz") throws
    if (urlPath.includes("..")) { res.writeHead(400).end("Bad request"); return; }
    let filePath = join(rootDir, urlPath);
    if (urlPath.endsWith("/") || !existsSync(filePath)) {
      const indexCandidate = join(filePath, "index.html");
      if (existsSync(indexCandidate)) filePath = indexCandidate;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      const notFound = join(rootDir, "404.html");
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(existsSync(notFound) ? readFileSync(notFound) : "Not found");
      return;
    }
    const realFilePath = containedRealPath(filePath);
    if (!realFilePath) { res.writeHead(403).end("Forbidden"); return; }
    const applied = headersForPath(rules, urlPath);
    for (const [name, value] of Object.entries(applied)) res.setHeader(name, value);
    res.setHeader("Content-Type", MIME[extname(realFilePath)] || "application/octet-stream");
    res.writeHead(200);
    res.end(readFileSync(realFilePath));
  });
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] || "").href; } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--")) || ".";
  const portArg = args.indexOf("--port");
  const port = portArg >= 0 ? Number(args[portArg + 1]) : 4747;
  const server = createStaticServer(dir);
  server.listen(port, "127.0.0.1", () => {
    console.log(`Serving ${resolve(dir)} at http://localhost:${port}/ (honoring ./_headers)`);
  });
}
