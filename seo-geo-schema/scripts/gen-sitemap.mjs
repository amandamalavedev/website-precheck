#!/usr/bin/env node
// Generate sitemap.xml (+ a robots.txt and an llms.txt starter) for a PUBLIC site.
// Usage:
//   node gen-sitemap.mjs --dir ./public-site --base https://example.com   # find .html files in a built dir
//   node gen-sitemap.mjs --urls urls.txt --base https://example.com       # one path or URL per line
//   add --out ./public-site  to write the files somewhere other than --dir
// Does NOT overwrite an existing robots.txt or llms.txt (prints them so you can merge); always
// writes sitemap.xml.
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { assertDirInside, flag, writeFileContained } from "./safe.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const base = (opt("base", "") || "").replace(/\/$/, "");
if (!base || !/^https?:\/\//.test(base)) { console.error("Need --base https://example.com"); process.exit(2); }
try { new URL(base); } catch { console.error("Invalid --base URL."); process.exit(2); }
const dir = opt("dir", null);
const urlsFile = opt("urls", null);
// Keep every write inside the source dir (or the given --out, but that must sit under the source
// dir, or under cwd when writing from a URL list) so a tricked agent can't write files anywhere (F4).
let outDir;
try { outDir = assertDirInside(opt("out", dir || "."), dir ? resolve(dir) : process.cwd()); }
catch (e) { console.error("Refused: " + e.message); process.exit(2); }
const overwrite = flag(args, "overwrite");

// Build the URL list
let paths = [];
if (urlsFile) {
  paths = readFileSync(urlsFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => (/^https?:\/\//.test(l) ? l.replace(base, "") : l));
} else if (dir) {
  const root = resolve(dir);
  const walk = (d) => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (statSync(p).isDirectory()) return n === "node_modules" || n.startsWith(".") ? [] : walk(p);
    return n.endsWith(".html") ? [p] : [];
  });
  paths = walk(root).map((p) => {
    let rel = "/" + relative(root, p).split(sep).join("/");
    rel = rel.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
    return rel || "/";
  });
} else { console.error("Need --dir <built site> or --urls <file>"); process.exit(2); }

// Dedupe, drop obviously-private pages, sort (home first)
const isPrivate = (u) => /\/(hq|admin|login|dashboard|_)/i.test(u);
const urls = [...new Set(paths)].filter((u) => !isPrivate(u)).sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
const today = new Date().toISOString().slice(0, 10);
const loc = (u) => base + (u.startsWith("/") ? u : "/" + u);
mkdirSync(outDir, { recursive: true });

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>\n    <loc>${loc(u)}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`).join("\n")}
</urlset>
`;
const sitemapPath = join(outDir, "sitemap.xml");
if (existsSync(sitemapPath) && !overwrite) {
  console.error(`sitemap.xml already exists at ${sitemapPath}. Re-run with --overwrite to replace it.`);
  process.exit(1);
}
writeFileContained(outDir, sitemapPath, sitemap); // atomic + alias-safe: can't write through a hard/symlink out of outDir
console.log(`Wrote ${sitemapPath} — ${urls.length} URL(s):`);
for (const u of urls) console.log("  " + loc(u));

const robots = `User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`;
const robotsPath = join(outDir, "robots.txt");
if (existsSync(robotsPath)) {
  console.log(`\nrobots.txt already exists — not overwriting. Make sure it contains:\n${robots}`);
} else {
  writeFileContained(outDir, robotsPath, robots);
  console.log(`\nWrote ${robotsPath}`);
}

const llmsPath = join(outDir, "llms.txt");
if (!existsSync(llmsPath)) {
  const llms = `# <Brand>\n\n> <One sentence: what this is and who it's for.>\n\n## Key facts\n- <what it does, where, for whom>\n\n## Pages\n${urls.map((u) => `- [${u === "/" ? "Home" : u}](${loc(u)}): <what's here>`).join("\n")}\n\n## Contact\n<email>\n`;
  writeFileContained(outDir, llmsPath, llms);
  console.log(`Wrote ${llmsPath} (a starter — fill in the <…> placeholders with real facts).`);
} else {
  console.log(`\nllms.txt already exists — not overwriting.`);
}
