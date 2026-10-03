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
import { pathToFileURL } from "node:url";
import { assertSafeUrl, sandboxOptIn, flag } from "./safe.mjs";

// Core check, importable from report.mjs / the MCP server. Returns structured data; throws on
// anything that stops it from producing a result (never calls process.exit()).
export async function runLighthouse(rawUrl, {
  runs = 3, form = "mobile", throttle = "simulate", categories = "performance",
  outDir = "lighthouse-reports", allowPrivate = false, noSandbox = false,
} = {}) {
  // Validate + SSRF-guard the INITIAL URL before it reaches the subprocess (F1/F2). Note: Lighthouse
  // drives its own Chrome, so it isn't filtered per-request the way the a11y check is — a page that
  // redirects to an internal address is a residual risk. Run it against sites you trust; for an
  // untrusted target the headers/a11y checks are the guarded ones.
  const url = await assertSafeUrl(rawUrl, { allowPrivate });

  runs = Math.max(1, Math.min(5, Number(runs) || 3));
  form = form === "desktop" ? "desktop" : "mobile";
  throttle = ["simulate", "devtools", "none"].includes(throttle) ? throttle : "simulate";
  const resolvedOutDir = resolve(outDir);
  mkdirSync(resolvedOutDir, { recursive: true });

  // Run npx WITHOUT a shell (F1): spawn node on npm's npx-cli.js, so nothing is ever cmd.exe-parsed.
  // Fall back to the plain binary name only on non-Windows, where it isn't a .cmd.
  const npxCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  const useNpxCli = existsSync(npxCli);
  const chromeFlags = ["--headless=new", "--disable-gpu", ...(sandboxOptIn(noSandbox ? ["--no-sandbox"] : []) ? ["--no-sandbox"] : [])].join(" ");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reports = [];
  const failedRuns = [];
  for (let i = 1; i <= runs; i++) {
    const outPath = join(resolvedOutDir, `lh-${stamp}-${form}-${i}.json`);
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
    // A run Lighthouse itself couldn't measure (e.g. NO_NAVSTART: "something went wrong recording the
    // trace") comes back with a null score — it is NOT a score of 0. Retry it once; if it fails again,
    // leave it out of the median rather than dragging the page to 0 (found 2026-10-02 on /training).
    for (let attempt = 1; attempt <= 2; attempt++) {
      process.stderr.write(attempt === 1 ? `Run ${i}/${runs}… ` : "retrying… ");
      // shell:false always. On Windows we invoke node + npx-cli.js (a .js, not a .cmd); elsewhere npx.
      const r = useNpxCli
        ? spawnSync(process.execPath, [npxCli, ...lhArgs], { encoding: "utf8", shell: false })
        : spawnSync("npx", lhArgs, { encoding: "utf8", shell: false });
      if (!existsSync(outPath)) {
        throw new Error(`Lighthouse failed (exit ${r.status}).\n${(r.stderr || "").slice(-1500)}\nIf Chrome isn't found, set CHROME_PATH to the Chrome executable.`);
      }
      const lhr = JSON.parse(readFileSync(outPath, "utf8"));
      if (lhr.runtimeError || lhr.categories.performance?.score == null) {
        failedRuns.push(lhr.runtimeError?.code || "no score");
        process.stderr.write(`couldn't measure (${lhr.runtimeError?.code || "no score"}) `);
        continue;
      }
      reports.push({ path: outPath, lhr });
      process.stderr.write(`score ${Math.round(lhr.categories.performance.score * 100)}\n`);
      break;
    }
  }
  if (!reports.length) {
    throw new Error(`Lighthouse couldn't measure this page (${[...new Set(failedRuns)].join(", ")} — Lighthouse's own recording failed; running it again usually works). No speed score is given rather than a wrong one.`);
  }

  // Median by performance score
  reports.sort((a, b) => (a.lhr.categories.performance?.score ?? 0) - (b.lhr.categories.performance?.score ?? 0));
  const median = reports[Math.floor(reports.length / 2)];
  const lhr = median.lhr;
  const a = lhr.audits;
  const ms = (id) => (a[id]?.numericValue != null ? Math.round(a[id].numericValue) : null);

  const categoryScores = {};
  for (const [k, c] of Object.entries(lhr.categories)) categoryScores[k] = { title: c.title, score: Math.round((c.score ?? 0) * 100) };

  // LCP element and its phase breakdown (where the LCP time actually goes)
  const lcpEl = a["largest-contentful-paint-element"] || a["lcp-breakdown-insight"] || a["lcp-phases-insight"];
  const findItems = (d, out = []) => {
    if (!d || typeof d !== "object") return out;
    if (Array.isArray(d.items)) for (const it of d.items) { out.push(it); findItems(it, out); }
    for (const v of Object.values(d)) if (v && typeof v === "object" && !Array.isArray(v)) findItems(v, out);
    return out;
  };
  let lcpElement = null, lcpPhases = [];
  if (lcpEl?.details) {
    const items = findItems(lcpEl.details);
    const node = items.find((it) => it.node)?.node || items.find((it) => it.type === "node");
    if (node) lcpElement = (node.snippet || node.nodeLabel || "").slice(0, 200);
    lcpPhases = items
      .filter((it) => (it.phase || it.subpart || it.label) && (it.timing != null || it.duration != null))
      .map((p) => ({ phase: String(p.phase || p.subpart || p.label), ms: Math.round(p.timing ?? p.duration) }));
  }

  // What to fix: failing audits/insights, biggest savings first. Exclude pure metric-measurement
  // audits (LCP/FCP/TBT/etc as their own "audit") — they're outcomes, not actions; the Insight/
  // opportunity audits below already say what to actually do about them, so including both just
  // shows the same problem twice under a different name.
  const metricOnlyIds = new Set(["largest-contentful-paint", "first-contentful-paint", "total-blocking-time", "cumulative-layout-shift", "speed-index", "server-response-time", "max-potential-fid", "interactive", "first-meaningful-paint"]);
  const skipModes = new Set(["notApplicable", "manual", "informative"]);
  // Some audits (e.g. unused-css-rules on an inline <style> block) put source text where a URL goes —
  // only genuinely URL-shaped values count, so no code snippet is ever built against stylesheet text.
  const isUrlish = (u) => typeof u === "string" && u.length < 300 && !/[{}\n]/.test(u) && /^(https?:\/\/|\/|\.\.?\/|[\w.-]+\/[\w./-]+\.\w+$)/.test(u);
  const failing = Object.values(a)
    .filter((x) => x.score != null && x.score < 0.9 && !skipModes.has(x.scoreDisplayMode) && !metricOnlyIds.has(x.id))
    .map((x) => ({ x, saving: x.metricSavings ? Math.max(0, ...Object.values(x.metricSavings).map(Number).filter(Number.isFinite)) : 0, bytes: x.details?.overallSavingsBytes || 0 }))
    .sort((p, q) => q.saving - p.saving || q.bytes - p.bytes)
    .slice(0, 15)
    .map(({ x, saving, bytes }) => ({
      id: x.id, title: x.title, displayValue: x.displayValue || null,
      metricSavingMs: saving || null, bytes: bytes || null,
      // Some audits (e.g. unused-css-rules on an inline <style> block) put the actual CSS/JS source
      // text in this field instead of a URL — reject anything that isn't genuinely URL-shaped so a
      // code snippet downstream never gets built against a chunk of someone's stylesheet by mistake.
      urls: [...new Set(findItems(x.details).map((it) => it.url || it.source?.url).filter(isUrlish))].slice(0, 3),
      // per-file detail, so the report can say "logo.webp is 120 KiB, could be 12 KiB" instead of just
      // naming the audit — size, potential saving, cache lifetime, source line, or the element itself
      items: findItems(x.details)
        .filter((it) => isUrlish(it.url || it.source?.url) || it.node?.snippet)
        .slice(0, 6)
        .map((it) => ({
          url: isUrlish(it.url || it.source?.url) ? (it.url || it.source.url) : null,
          line: it.source?.line != null ? it.source.line + 1 : null,
          element: it.node?.snippet ? String(it.node.snippet).replace(/\s+/g, " ").slice(0, 160) : null,
          totalBytes: Number.isFinite(it.totalBytes) ? it.totalBytes : null,
          wastedBytes: Number.isFinite(it.wastedBytes) ? it.wastedBytes : null,
          wastedMs: Number.isFinite(it.wastedMs) ? Math.round(it.wastedMs) : null,
          cacheTtlMs: Number.isFinite(it.cacheLifetimeMs) ? it.cacheLifetimeMs : null,
        })),
    }));

  // What was actually measured — never just say "mobile" or "4G": Lighthouse's own configSettings
  // name the exact simulated network profile and CPU slowdown, and the device it emulates is in its
  // own reported user agent string. Pull both out so the report can state them precisely instead of
  // leaving the reader to guess which "4G" or which phone.
  const cs = lhr.configSettings || {};
  const t = cs.throttling || {};
  // The UA's parenthetical often nests one level deep — "(Linux; Android 11; moto g power (2022))" —
  // so a naive [^)]* stops at the inner ")" and truncates the device name. Match one level of nesting.
  const deviceMatch = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)/.exec(lhr.environment?.networkUserAgent || "");
  const device = form === "desktop" ? "Desktop (no device emulation)"
    : (deviceMatch ? deviceMatch[1].split(";").pop().trim() : "Mobile (device not reported)");
  const networkLabel = cs.throttlingMethod === "simulate" && t.rttMs === 150 && Math.round(t.throughputKbps || 0) === 1638
    ? "Simulated Slow 4G"
    : cs.throttlingMethod === "devtools" ? "DevTools-applied throttling" : cs.throttlingMethod === "provided" ? "No throttling (raw connection)" : "Simulated throttling";

  return {
    url: lhr.finalDisplayedUrl || url, version: lhr.lighthouseVersion, form, throttle, runs: reports.length, failedRuns,
    scores: reports.map((r) => Math.round((r.lhr.categories.performance?.score ?? 0) * 100)),
    categoryScores,
    testConditions: {
      device, networkLabel,
      rttMs: t.rttMs ?? null, downloadKbps: t.downloadThroughputKbps ? Math.round(t.downloadThroughputKbps) : null,
      uploadKbps: t.uploadThroughputKbps ? Math.round(t.uploadThroughputKbps) : null, cpuSlowdown: t.cpuSlowdownMultiplier ?? null,
      screen: cs.screenEmulation ? `${cs.screenEmulation.width}×${cs.screenEmulation.height} @${cs.screenEmulation.deviceScaleFactor}x` : null,
    },
    metrics: {
      fcpMs: ms("first-contentful-paint"), lcpMs: ms("largest-contentful-paint"),
      tbtMs: ms("total-blocking-time"), cls: a["cumulative-layout-shift"]?.numericValue ?? null,
      speedIndexMs: ms("speed-index"), ttfbMs: ms("server-response-time"),
    },
    lcpElement, lcpPhases, failing,
    reportPath: median.path,
  };
}

// ---- CLI wrapper: only runs when this file is executed directly, not when imported ----
const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] || "").href; } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  const rawUrl = args.find((a) => /^[a-z][a-z0-9+.-]+:\/\//i.test(a));
  if (!rawUrl) {
  if (!/^https?:\/\//i.test(rawUrl)) { console.error(`Refused: only http:// and https:// URLs can be checked (got "${rawUrl.split(':')[0]}:").`); process.exit(2); }
    console.error("Usage: node lighthouse.mjs <url> [--runs 3] [--form mobile|desktop] [--throttle simulate|devtools|none] [--out dir] [--allow-private]");
    process.exit(2);
  }
  const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };

  let r;
  try {
    r = await runLighthouse(rawUrl, {
      runs: opt("runs", "3"), form: opt("form", "mobile"), throttle: opt("throttle", "simulate"),
      categories: opt("categories", "performance"), outDir: opt("out", "lighthouse-reports"),
      allowPrivate: flag(args, "allow-private"), noSandbox: flag(args, "no-sandbox"),
    });
  } catch (e) {
    console.error(/private|local|valid URL/i.test(e.message) ? "Refused: " + e.message : e.message);
    process.exit(/private|local|valid URL/i.test(e.message) ? 2 : 1);
  }

  const fmt = (v) => (v == null ? "—" : v >= 1000 ? (v / 1000).toFixed(2) + " s" : v + " ms");
  console.log(`\n=== Lighthouse ${r.version} · ${r.form} · ${r.throttle} throttling · median of ${r.runs} ===`);
  console.log(`URL: ${r.url}`);
  console.log(`Tested as: ${r.testConditions.device} · ${r.testConditions.networkLabel}${r.testConditions.rttMs != null ? ` (${r.testConditions.rttMs}ms RTT, ${r.testConditions.downloadKbps} Kbps down, ${r.testConditions.cpuSlowdown}x CPU slowdown)` : ""}`);
  console.log(`Scores (all runs): ${r.scores.join(", ")}`);
  for (const c of Object.values(r.categoryScores)) console.log(`${c.title}: ${c.score}`);
  console.log(`\nFCP ${fmt(r.metrics.fcpMs)} · LCP ${fmt(r.metrics.lcpMs)} · TBT ${fmt(r.metrics.tbtMs)} · CLS ${r.metrics.cls?.toFixed(3) ?? "—"} · Speed Index ${fmt(r.metrics.speedIndexMs)} · TTFB ${fmt(r.metrics.ttfbMs)}`);
  if (r.lcpElement) console.log(`\nLCP element: ${r.lcpElement}`);
  if (r.lcpPhases.length) { console.log("LCP breakdown:"); for (const p of r.lcpPhases) console.log(`  ${p.phase.padEnd(28)} ${fmt(p.ms)}`); }
  console.log(`\nFailing audits (${r.failing.length}):`);
  for (const f of r.failing) {
    const extra = [f.metricSavingMs ? `~${fmt(f.metricSavingMs)} metric saving` : "", f.bytes ? `~${Math.round(f.bytes / 1024)} KiB` : ""].filter(Boolean).join(", ");
    console.log(`- ${f.title}${f.displayValue ? " — " + f.displayValue : ""}${extra ? " (" + extra + ")" : ""}  [${f.id}]`);
    for (const u of f.urls) console.log(`    ${String(u).slice(0, 140)}`);
  }
  console.log(`\nFull report (median run): ${r.reportPath}`);
  console.log(`Open in a browser: npx -y lighthouse@12 ${r.url} --view  (or drop the JSON on https://googlechrome.github.io/lighthouse/viewer/)`);
}
