#!/usr/bin/env node
// Automated accessibility check: drive headless Chrome, inject axe-core, report WCAG violations.
// Usage:  node a11y-check.mjs <url> [--wait 2000] [--full]
//   --wait   ms to wait after load for JS-rendered content (default 2000)
//   --full   include "best-practice" rules too, not just WCAG A/AA
//
// Needs puppeteer-core + a Chrome install. If puppeteer-core isn't present:
//   npm install --no-save puppeteer-core
// axe-core is loaded from cdnjs at run time (no install). Set CHROME_PATH if Chrome isn't found.
// Reports violations by severity with the offending elements and fix guidance. Exit code = violation
// count (0 = none found — but automation only catches ~a third of issues; still do the manual pass).
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { assertSafeUrl, sandboxOptIn, flag } from "./safe.mjs";
// Resolve puppeteer-core from the PROJECT being tested (its node_modules), not this script's folder.
const require = createRequire(pathToFileURL(join(process.cwd(), "resolve-from-here.js")));

const args = process.argv.slice(2);
const rawUrl = args.find((a) => /^https?:\/\//.test(a));
if (!rawUrl) { console.error("Usage: node a11y-check.mjs <url> [--wait 2000] [--full] [--allow-private]"); process.exit(2); }
// Validate + SSRF-guard before we point a browser at it (F2).
let url;
try { url = await assertSafeUrl(rawUrl, { allowPrivate: flag(args, "allow-private") }); }
catch (e) { console.error("Refused: " + e.message); process.exit(2); }
const waitIdx = args.indexOf("--wait");
const waitMs = waitIdx >= 0 && args[waitIdx + 1] ? Number(args[waitIdx + 1]) : 2000;
const full = args.includes("--full");

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const guesses = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium",
  ];
  const fs = require("node:fs");
  return guesses.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

let puppeteer;
try { puppeteer = require("puppeteer-core"); }
catch { console.error("puppeteer-core not found. Run: npm install --no-save puppeteer-core"); process.exit(3); }

const AXE_CDN = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js";
const SEV = { critical: 0, serious: 1, moderate: 2, minor: 3 };

(async () => {
  const exe = findChrome();
  if (!exe) { console.error("Chrome not found. Set CHROME_PATH to the Chrome executable."); process.exit(3); }
  // Sandbox stays ON by default (we load an untrusted page); opt out only via WG_NO_SANDBOX=1 or --no-sandbox (F3).
  const launchArgs = ["--disable-gpu", ...(sandboxOptIn(args) ? ["--no-sandbox"] : [])];
  const browser = await puppeteer.launch({ executablePath: exe, headless: "new", args: launchArgs });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  // A well-hardened site has a strict CSP (script-src 'self') that would block injecting axe-core.
  // Bypass CSP for this testing session only — it affects this headless run, never the live site.
  await page.setBypassCSP(true);
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  } catch (e) { console.error("Could not load " + url + ": " + e.message); await browser.close(); process.exit(3); }
  await new Promise((r) => setTimeout(r, waitMs));
  try { await page.addScriptTag({ url: AXE_CDN }); }
  catch { console.error("Could not load axe-core from cdnjs — check network access."); await browser.close(); process.exit(3); }

  const tags = full
    ? ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]
    : ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
  const results = await page.evaluate(async (runTags) => {
    return await window.axe.run(document, { runOnly: { type: "tag", values: runTags } });
  }, tags);
  await browser.close();

  const v = results.violations.sort((a, b) => (SEV[a.impact] ?? 9) - (SEV[b.impact] ?? 9));
  const total = v.reduce((n, x) => n + x.nodes.length, 0);
  console.log(`\n=== Accessibility (axe-core ${results.testEngine?.version || ""}, WCAG 2.1 ${full ? "A/AA + best-practice" : "A/AA"}) ===`);
  console.log(`URL: ${url}`);
  const byImpact = v.reduce((m, x) => ((m[x.impact] = (m[x.impact] || 0) + x.nodes.length), m), {});
  console.log(`Violations: ${total} across ${v.length} rule(s)` + (total ? ` — ${["critical", "serious", "moderate", "minor"].filter((k) => byImpact[k]).map((k) => `${byImpact[k]} ${k}`).join(", ")}` : ""));
  console.log(`Passed checks: ${results.passes.length} · Incomplete (needs a human): ${results.incomplete.length}\n`);

  for (const rule of v) {
    console.log(`[${(rule.impact || "?").toUpperCase()}] ${rule.help}  (${rule.id}) ×${rule.nodes.length}`);
    console.log(`   Why: ${rule.description}`);
    console.log(`   Fix: ${rule.helpUrl}`);
    for (const node of rule.nodes.slice(0, 4)) console.log(`   → ${node.target.join(" ")}   ${(node.html || "").replace(/\s+/g, " ").slice(0, 110)}`);
    if (rule.nodes.length > 4) console.log(`   … and ${rule.nodes.length - 4} more`);
    console.log("");
  }
  if (results.incomplete.length) {
    console.log(`Needs manual review (axe couldn't decide): ${results.incomplete.map((r) => r.id).join(", ")}`);
  }
  console.log(`\nRemember: axe catches ~30-50% of issues. Still do the manual keyboard/contrast/structure pass (see wcag-checklist.md).`);
  process.exit(Math.min(total, 250));
})();
