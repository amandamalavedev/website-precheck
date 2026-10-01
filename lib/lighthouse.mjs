#!/usr/bin/env node
// Run Lighthouse from the command line and print a short, decision-ready summary — so Claude can
// measure a page itself instead of asking the user to paste a DevTools report.
//
// Usage:
//   node lighthouse.mjs <url> [--runs 3] [--form mobile|desktop] [--throttle simulate|devtools|none]
//                       [--out <dir>] [--categories performance,accessibility,best-practices,seo]
//
// Defaults: 3 runs, mobile, simulated slow 4G (Lighthouse's standard mobile profile), performance only.
// Prints the MEDIAN run (by performance score) — single Lighthouse runs vary by ±5–10 points.
// Full JSON reports are kept in --out (default: ./lighthouse-reports) for deeper digging.
// Requires Node 18+ and Chrome installed; uses `npx -y lighthouse@12` (no install needed).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { assertSafeUrl, sandboxOptIn, flag } from "./safe.mjs";

const args = process.argv.slice(2);
const rawUrl = args.find((a) => /^https?:\/\//.test(a));
if (!rawUrl) {
  console.error("Usage: node lighthouse.mjs <url> [--runs 3] [--form mobile|desktop] [--throttle simulate|devtools|none] [--out dir] [--allow-private]");
  process.exit(2);
}
// Validate + SSRF-guard the INITIAL URL before it reaches the subprocess (F1/F2). Note: Lighthouse
// drives its own Chrome, so it isn't filtered per-request the way the a11y check is — a page that
// redirects to an internal address is a residual risk. Run it against sites you trust; for an
// untrusted target the headers/a11y checks are the guarded ones.
let url;
try { url = await assertSafeUrl(rawUrl, { allowPrivate: flag(args, "allow-private") }); }
catch (e) { console.error("Refused: " + e.message); process.exit(2); }

const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const runs = Math.max(1, Math.min(5, Number(opt("runs", "3")) || 3));
const form = opt("form", "mobile") === "desktop" ? "desktop" : "mobile";
const throttle = ["simulate", "devtools", "none"].includes(opt("throttle", "simulate")) ? opt("throttle", "simulate") : "simulate";
const categories = opt("categories", "performance");
const outDir = resolve(opt("out", "lighthouse-reports"));
mkdirSync(outDir, { recursive: true });

// Run npx WITHOUT a shell (F1): spawn node on npm's npx-cli.js, so nothing is ever cmd.exe-parsed.
// Fall back to the plain binary name only on non-Windows, where it isn't a .cmd.
const npxCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
const useNpxCli = existsSync(npxCli);
const chromeFlags = ["--headless=new", "--disable-gpu", ...(sandboxOptIn(args) ? ["--no-sandbox"] : [])].join(" ");

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const reports = [];
for (let i = 1; i <= runs; i++) {
  const outPath = join(outDir, `lh-${stamp}-${form}-${i}.json`);
  const lhArgs = [
    "-y", "lighthouse@12", url,
    `--only-categories=${categories}`,
    `--form-factor=${form}`,
    `--output=json`, `--output-path=${outPath}`,
    "--quiet",
    `--chrome-flags=${chromeFlags}`,
  ];
  if (form === "desktop") lhArgs.push("--preset=desktop");
  if (throttle === "none") lhArgs.push("--throttling-method=provided");
  else lhArgs.push(`--throttling-method=${throttle}`);
  process.stderr.write(`Run ${i}/${runs}… `);
  // shell:false always. On Windows we invoke node + npx-cli.js (a .js, not a .cmd); elsewhere npx.
  const r = useNpxCli
    ? spawnSync(process.execPath, [npxCli, ...lhArgs], { encoding: "utf8", shell: false })
    : spawnSync("npx", lhArgs, { encoding: "utf8", shell: false });
  if (!existsSync(outPath)) {
    console.error(`\nLighthouse failed (exit ${r.status}).\n${(r.stderr || "").slice(-1500)}`);
    console.error("If Chrome isn't found, set CHROME_PATH to the Chrome executable.");
    process.exit(1);
  }
  const lhr = JSON.parse(readFileSync(outPath, "utf8"));
  reports.push({ path: outPath, lhr });
  process.stderr.write(`score ${Math.round((lhr.categories.performance?.score ?? 0) * 100)}\n`);
}

// Median by performance score
reports.sort((a, b) => (a.lhr.categories.performance?.score ?? 0) - (b.lhr.categories.performance?.score ?? 0));
const median = reports[Math.floor(reports.length / 2)];
const lhr = median.lhr;
const a = lhr.audits;
const ms = (id) => (a[id]?.numericValue != null ? Math.round(a[id].numericValue) : null);
const fmt = (v) => (v == null ? "—" : v >= 1000 ? (v / 1000).toFixed(2) + " s" : v + " ms");

console.log(`\n=== Lighthouse ${lhr.lighthouseVersion} · ${form} · ${throttle} throttling · median of ${runs} ===`);
console.log(`URL: ${lhr.finalDisplayedUrl || url}`);
console.log(`Scores (all runs): ${reports.map((r) => Math.round((r.lhr.categories.performance?.score ?? 0) * 100)).join(", ")}`);
for (const [k, c] of Object.entries(lhr.categories)) console.log(`${c.title}: ${Math.round((c.score ?? 0) * 100)}`);
console.log(`\nFCP ${fmt(ms("first-contentful-paint"))} · LCP ${fmt(ms("largest-contentful-paint"))} · TBT ${fmt(ms("total-blocking-time"))} · CLS ${a["cumulative-layout-shift"]?.numericValue?.toFixed(3) ?? "—"} · Speed Index ${fmt(ms("speed-index"))} · TTFB ${fmt(ms("server-response-time"))}`);

// LCP element and its phase breakdown (where the LCP time actually goes)
const lcpEl = a["largest-contentful-paint-element"] || a["lcp-breakdown-insight"] || a["lcp-phases-insight"];
const findItems = (d, out = []) => {
  if (!d || typeof d !== "object") return out;
  if (Array.isArray(d.items)) for (const it of d.items) { out.push(it); findItems(it, out); }
  for (const v of Object.values(d)) if (v && typeof v === "object" && !Array.isArray(v)) findItems(v, out);
  return out;
};
if (lcpEl?.details) {
  const items = findItems(lcpEl.details);
  const node = items.find((it) => it.node)?.node || items.find((it) => it.type === "node");
  if (node) console.log(`\nLCP element: ${(node.snippet || node.nodeLabel || "").slice(0, 200)}`);
  const phases = items.filter((it) => (it.phase || it.subpart || it.label) && (it.timing != null || it.duration != null));
  if (phases.length) {
    console.log("LCP breakdown:");
    for (const p of phases) console.log(`  ${String(p.phase || p.subpart || p.label).padEnd(28)} ${fmt(Math.round(p.timing ?? p.duration))}`);
  }
}

// What to fix: failing audits/insights, biggest savings first
const skipModes = new Set(["notApplicable", "manual", "informative"]);
const failing = Object.values(a)
  .filter((x) => x.score != null && x.score < 0.9 && !skipModes.has(x.scoreDisplayMode))
  .map((x) => ({ x, saving: x.metricSavings ? Math.max(0, ...Object.values(x.metricSavings).map(Number).filter(Number.isFinite)) : 0, bytes: x.details?.overallSavingsBytes || 0 }))
  .sort((p, q) => q.saving - p.saving || q.bytes - p.bytes);
console.log(`\nFailing audits (${failing.length}):`);
for (const { x, saving, bytes } of failing.slice(0, 15)) {
  const extra = [saving ? `~${fmt(Math.round(saving))} metric saving` : "", bytes ? `~${Math.round(bytes / 1024)} KiB` : ""].filter(Boolean).join(", ");
  console.log(`- ${x.title}${x.displayValue ? " — " + x.displayValue : ""}${extra ? " (" + extra + ")" : ""}  [${x.id}]`);
  const urls = findItems(x.details).map((it) => it.url || it.source?.url).filter(Boolean);
  for (const u of [...new Set(urls)].slice(0, 3)) console.log(`    ${String(u).slice(0, 140)}`);
}
console.log(`\nFull report (median run): ${median.path}`);
console.log(`Open in a browser: npx -y lighthouse@12 ${url} --view  (or drop the JSON on https://googlechrome.github.io/lighthouse/viewer/)`);
