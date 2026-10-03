#!/usr/bin/env node
// Automated accessibility check: drive headless Chrome, inject axe-core, report WCAG violations.
// Usage:  node a11y.mjs <url> [--wait 2000] [--full]
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
import { assertSafeUrl, sandboxOptIn, flag, hostIsPublic } from "./safe.mjs";
// Resolve puppeteer-core reliably: first from THIS script's package (where an npm install of the
// toolkit puts its optionalDependency), then from the project being tested (cwd).
const requireHere = createRequire(import.meta.url);
const requireCwd = createRequire(pathToFileURL(join(process.cwd(), "resolve-from-here.js")));

const AXE_CDN = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js";
const SEV = { critical: 0, serious: 1, moderate: 2, minor: 3 };

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const guesses = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium",
  ];
  const fs = requireHere("node:fs");
  return guesses.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

// Core check, importable from report.mjs / the MCP server. Returns structured data; throws on
// anything that stops it from producing a result (never calls process.exit()).
/** One failing element: where it is, its markup, why it fails — and for colour contrast, the actual
 *  colours and ratios, so the report can name the exact colour that would pass. */
function nodeDetail(n) {
  const out = { target: n.target.join(" "), html: (n.html || "").replace(/\s+/g, " ").slice(0, 160) };
  const summary = (n.failureSummary || "").replace(/^Fix (any|all) of the following:\s*/i, "").replace(/\s+/g, " ").trim();
  if (summary) out.summary = summary.slice(0, 240);
  const d = [...(n.any || []), ...(n.all || [])].map((c) => c.data).find((x) => x && x.fgColor && x.bgColor);
  if (d) out.contrast = { fg: d.fgColor, bg: d.bgColor, ratio: d.contrastRatio, required: parseFloat(String(d.expectedContrastRatio || "4.5")), fontSize: d.fontSize || null, fontWeight: d.fontWeight || null };
  return out;
}

/**
 * axe can't judge text over an image or gradient, so it asks a human. Measure it instead: hide the text, take a
 * screenshot of exactly what's behind it, and compute the contrast of the text colour against every background
 * pixel. "worst" is the 5th-percentile contrast (a few stray pixels don't count); "typical" is the median.
 * Pass = readable over (nearly) all of it; fail = unreadable over most of it; partly = unreadable over some of it.
 */
async function verifyContrast(page, nodes) {
  const sels = nodes.filter((n) => Array.isArray(n.target) && n.target.length === 1 && typeof n.target[0] === "string").map((n) => ({ sel: n.target[0], html: (n.html || "").replace(/\s+/g, " ").slice(0, 160) }));
  if (!sels.length) return [];
  // 1. Each element's text colour, size and box, read while the page is untouched — and a screenshot WITH its text
  const shots = [];
  for (const { sel, html } of sels) {
    const meta = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const cs = getComputedStyle(el);
      // gradient-filled text (background-clip: text) has no single colour to measure — leave it to a human
      if ([cs.backgroundClip, cs.webkitBackgroundClip].includes("text")) return null;
      // decorative icons hidden from screen readers are outside the contrast rule
      if (el.closest('[aria-hidden="true"]')) return null;
      // SVG text is painted with fill, not color
      const fg = el instanceof SVGElement ? cs.fill : cs.color;
      if (!/^rgba?\(/.test(fg) || /rgba\([^)]*,\s*0\)$/.test(fg)) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      return { fg, size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10) || 400, clip: { x: r.left + scrollX, y: r.top + scrollY, width: Math.min(r.width, 1200), height: Math.min(r.height, 400) } };
    }, sel).catch(() => null);
    if (!meta) continue;
    try { await new Promise((r) => setTimeout(r, 50)); shots.push({ sel, html, meta, withText: await page.screenshot({ clip: meta.clip, encoding: "base64" }) }); } catch { /* skip */ }
  }
  if (!shots.length) return [];
  // 2. Hide ALL text on the page and take the same shots again: what changed between the two is exactly where the
  //    letters are, and the second shot shows what's behind them. Only those pixels are measured — an outline,
  //    border or a neighbour's words inside the element's box no longer count as "background".
  await page.evaluate(() => {
    const st = document.createElement("style"); st.id = "__pc-hide-text";
    st.textContent = "*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important;transition:none!important;animation-play-state:paused!important}svg text,svg tspan,svg textPath{fill:transparent!important;stroke:transparent!important}";
    document.head.appendChild(st);
  });
  const out = [];
  try {
    for (const { sel, html, meta, withText } of shots) {
      let noText;
      try {
        await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), sel);
        await new Promise((r) => setTimeout(r, 50));
        noText = await page.screenshot({ clip: meta.clip, encoding: "base64" });
      } catch { continue; }
      const stats = await page.evaluate(async (a64, b64, fg) => {
        const load = async (d) => { const img = new Image(); img.src = "data:image/png;base64," + d; await img.decode(); const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
        const A = await load(a64), B = await load(b64);
        if (A.length !== B.length) return null;
        const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        const lum = (r, gg, b) => 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b);
        const m = /rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(fg); if (!m) return null;
        const lf = lum(+m[1], +m[2], +m[3]);
        const glyph = [], all = [];
        for (let k = 0; k < B.length; k += 4) {
          const ratio = ((lb) => (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05))(lum(B[k], B[k + 1], B[k + 2]));
          all.push(ratio);
          if (Math.abs(A[k] - B[k]) + Math.abs(A[k + 1] - B[k + 1]) + Math.abs(A[k + 2] - B[k + 2]) > 40) glyph.push(ratio);
        }
        const use = glyph.length >= 12 ? glyph : all; // too few changed pixels (e.g. text same colour as background): fall back to the whole box
        use.sort((x, y) => x - y);
        return { worst: +use[Math.floor(use.length * 0.05)].toFixed(2), typical: +use[Math.floor(use.length / 2)].toFixed(2), lightText: lf > 0.4, glyphPixels: glyph.length };
      }, withText, noText, meta.fg).catch(() => null);
      if (!stats) continue;
      const required = meta.size >= 24 || (meta.size >= 18.66 && meta.weight >= 700) ? 3 : 4.5;
      out.push({ target: sel, html, fg: meta.fg, required, ...stats, status: stats.worst >= required ? "pass" : stats.typical < required ? "fail" : "partly" });
    }
  } finally {
    await page.evaluate(() => document.getElementById("__pc-hide-text")?.remove()).catch(() => {});
  }
  return out;
}

export async function checkA11y(rawUrl, { wait = 2000, full = false, allowPrivate = false } = {}) {
  const url = await assertSafeUrl(rawUrl, { allowPrivate }); // throws on refusal

  let puppeteer;
  for (const r of [requireHere, requireCwd]) { try { puppeteer = r("puppeteer-core"); break; } catch { /* try next */ } }
  if (!puppeteer) throw new Error("puppeteer-core not found. Run: npm install puppeteer-core");

  const exe = findChrome();
  if (!exe) throw new Error("Chrome not found. Set CHROME_PATH to the Chrome executable.");

  // Sandbox stays ON by default (we load an untrusted page); opt out only via WG_NO_SANDBOX=1 or --no-sandbox (F3).
  const launchArgs = ["--disable-gpu", ...(sandboxOptIn(allowPrivate ? ["--no-sandbox"] : []) ? ["--no-sandbox"] : [])];
  const browser = await puppeteer.launch({ executablePath: exe, headless: "new", args: launchArgs });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    // A well-hardened site has a strict CSP (script-src 'self') that would block injecting axe-core.
    // Bypass CSP for this testing session only — it affects this headless run, never the live site.
    await page.setBypassCSP(true);
    // Block the browser from reaching private/internal hosts on ANY request — redirects and
    // subresources included, not just the initial URL (F2). Skipped when allowPrivate is set.
    if (!allowPrivate) {
      await page.setRequestInterception(true);
      // page.on() doesn't await its listener's return value, so a rejected promise from inside
      // this handler fires as a process-level unhandledRejection — completely outside checkA11y()'s
      // own try/catch, and outside guarded() in the MCP server. Confirmed as a real crash path
      // (2026-10-01): req.continue()/req.abort() can themselves throw (the request was already
      // handled, or the page navigated away while hostIsPublic's DNS lookup was in flight), and
      // that was only half-caught — the catch block's own req.abort("failed") call was unguarded.
      // Every failure point below is now caught at its own layer, with a final catch as a backstop.
      page.on("request", (req) => {
        (async () => {
          const u = req.url();
          if (!/^https?:/i.test(u)) { try { req.continue(); } catch { /* already handled */ } return; }
          let allow = false;
          try { allow = await hostIsPublic(new URL(u).hostname); } catch { allow = false; } // fail closed
          try { allow ? req.continue() : req.abort("addressunreachable"); }
          catch { /* request already handled/page navigated away — nothing more to do */ }
        })().catch(() => {}); // backstop: nothing above should reject, but never let this surface
      });
    }
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    } catch (e) { throw new Error("Could not load " + url + ": " + e.message); }
    await new Promise((r) => setTimeout(r, wait));
    try { await page.addScriptTag({ url: AXE_CDN }); }
    catch { throw new Error("Could not load axe-core from cdnjs — check network access."); }

    const tags = full
      ? ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]
      : ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
    const results = await page.evaluate(async (runTags) => {
      return await window.axe.run(document, { runOnly: { type: "tag", values: runTags } });
    }, tags);

    // text axe couldn't judge (over images/gradients): measured from the pixels instead of "check by eye"
    const contrastUnsure = results.incomplete.find((r) => r.id === "color-contrast")?.nodes || [];
    let contrastVerified = [];
    try { contrastVerified = await verifyContrast(page, contrastUnsure.slice(0, 40)); } catch { contrastVerified = []; }
    const verifiedTargets = new Set(contrastVerified.map((v) => v.target));

    const violations = results.violations.sort((a, b) => (SEV[a.impact] ?? 9) - (SEV[b.impact] ?? 9));
    const total = violations.reduce((n, x) => n + x.nodes.length, 0);
    const byImpact = violations.reduce((m, x) => ((m[x.impact] = (m[x.impact] || 0) + x.nodes.length), m), {});
    return {
      url, engine: results.testEngine?.version || "", full,
      violations: violations.map((rule) => ({
        id: rule.id, impact: rule.impact || "minor", help: rule.help, description: rule.description, helpUrl: rule.helpUrl,
        count: rule.nodes.length,
        nodes: rule.nodes.slice(0, 6).map(nodeDetail),
      })),
      total, byImpact,
      passes: results.passes.length, incomplete: results.incomplete.map((r) => r.id),
      // what axe couldn't decide (e.g. text over an image) — named elements, so a human can check them
      incompleteDetail: results.incomplete
        .map((r) => ({ ...r, nodes: r.id === "color-contrast" ? r.nodes.filter((n) => !verifiedTargets.has(n.target?.[0])) : r.nodes }))
        .filter((r) => r.nodes.length).slice(0, 5)
        .map((r) => ({ id: r.id, help: r.help, count: r.nodes.length, nodes: r.nodes.slice(0, 4).map(nodeDetail) })),
      contrastVerified,
    };
  } finally {
    await browser.close();
  }
}

// ---- CLI wrapper: only runs when this file is executed directly, not when imported ----
const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] || "").href; } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  const rawUrl = args.find((a) => /^[a-z][a-z0-9+.-]+:\/\//i.test(a));
  if (!rawUrl) { console.error("Usage: node a11y.mjs <url> [--wait 2000] [--full] [--allow-private]"); process.exit(2); }
  if (!/^https?:\/\//i.test(rawUrl)) { console.error(`Refused: only http:// and https:// URLs can be checked (got "${rawUrl.split(':')[0]}:").`); process.exit(2); }
  const waitIdx = args.indexOf("--wait");
  const wait = waitIdx >= 0 && args[waitIdx + 1] ? Number(args[waitIdx + 1]) : 2000;
  const full = args.includes("--full");
  const allowPrivate = flag(args, "allow-private");

  let r;
  try { r = await checkA11y(rawUrl, { wait, full, allowPrivate }); }
  catch (e) {
    const code = /Refus|private|local/i.test(e.message) ? 2 : /puppeteer-core|Chrome not found/.test(e.message) ? 3 : 1;
    console.error(code === 2 ? "Refused: " + e.message : e.message);
    process.exit(code);
  }

  console.log(`\n=== Accessibility (axe-core ${r.engine}, WCAG 2.1 ${r.full ? "A/AA + best-practice" : "A/AA"}) ===`);
  console.log(`URL: ${r.url}`);
  console.log(`Violations: ${r.total} across ${r.violations.length} rule(s)` + (r.total ? ` — ${["critical", "serious", "moderate", "minor"].filter((k) => r.byImpact[k]).map((k) => `${r.byImpact[k]} ${k}`).join(", ")}` : ""));
  console.log(`Passed checks: ${r.passes} · Incomplete (needs a human): ${r.incomplete.length}\n`);

  for (const rule of r.violations) {
    console.log(`[${rule.impact.toUpperCase()}] ${rule.help}  (${rule.id}) ×${rule.count}`);
    console.log(`   Why: ${rule.description}`);
    console.log(`   Fix: ${rule.helpUrl}`);
    for (const node of rule.nodes) console.log(`   → ${node.target}   ${node.html}`);
    if (rule.count > rule.nodes.length) console.log(`   … and ${rule.count - rule.nodes.length} more`);
    console.log("");
  }
  if (r.incomplete.length) console.log(`Needs manual review (axe couldn't decide): ${r.incomplete.join(", ")}`);
  console.log(`\nRemember: axe catches ~30-50% of issues. Still do the manual keyboard/contrast/structure pass (see wcag-checklist.md).`);
  process.exitCode = Math.min(r.total, 250);
}
