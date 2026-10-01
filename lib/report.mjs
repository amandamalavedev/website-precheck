#!/usr/bin/env node
// One run -> three outputs: JSON (source of truth), a self-contained HTML report (shareable, no
// server, Lighthouse-style), and a short Markdown summary (terminal/PR). The curated judgment — a
// prioritized "fix this first" list, findings grouped by severity with a plain-English why + fix —
// is what makes this worth more than pasting raw tool output.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSafeUrl, flag, writeFileContained } from "./safe.mjs";
import { checkHeaders } from "./headers.mjs";
import { checkA11y } from "./a11y.mjs";
import { runLighthouse } from "./lighthouse.mjs";

const SEV_RANK = { high: 0, medium: 1, low: 2 };
const SEV_LABEL = { high: "High", medium: "Medium", low: "Low" };
const IMPACT_TO_SEV = { critical: "high", serious: "high", moderate: "medium", minor: "low" };

// ---- Run every check that succeeds; a failed optional check becomes a "skipped" note, not a crash
// for the whole report — a site with no Chrome available should still get its header findings. ----
export async function runReport(rawUrl, {
  allowPrivate = false, skipLighthouse = false, skipA11y = false,
  lighthouseRuns = 3, lighthouseForm = "mobile", outDir = "lighthouse-reports",
} = {}) {
  const url = await assertSafeUrl(rawUrl, { allowPrivate }); // fail fast, before running anything
  const startedAt = new Date().toISOString();
  const skipped = [];
  const findings = [];

  // ---- Security headers (always runs — fast, no browser needed) ----
  let headers = null;
  try {
    headers = await checkHeaders(url, { allowPrivate });
    for (const c of headers.checks) {
      if (!c.present) findings.push({ severity: c.severity, category: "Security", title: `Missing ${c.name} header`, why: c.why, fix: `Add the \`${c.name}\` response header. See the site-hardening-and-speed skill for exact values.` });
    }
    for (const c of headers.unwanted) {
      if (c.present) findings.push({ severity: "low", category: "Security", title: `${c.name} header reveals server details`, why: c.why, fix: `Remove or blank the \`${c.name}\` header (e.g. \`app.disable('x-powered-by')\` in Express).` });
    }
    if (headers.httpsRedirect === false) findings.push({ severity: "high", category: "Security", title: "HTTP does not redirect to HTTPS", why: "Visitors on a plain http:// link stay unencrypted.", fix: "Redirect all HTTP traffic to HTTPS at the server or platform edge." });
  } catch (e) { skipped.push({ check: "headers", reason: e.message }); }

  // ---- Lighthouse (slower — several Chrome launches) ----
  let lighthouse = null;
  if (!skipLighthouse) {
    try {
      lighthouse = await runLighthouse(url, { runs: lighthouseRuns, form: lighthouseForm, allowPrivate, outDir });
      for (const f of lighthouse.failing) {
        const extra = [f.metricSavingMs ? `~${f.metricSavingMs}ms metric saving` : "", f.bytes ? `~${Math.round(f.bytes / 1024)} KiB` : ""].filter(Boolean).join(", ");
        findings.push({ severity: f.metricSavingMs > 500 || f.bytes > 100000 ? "high" : "medium", category: "Performance", title: f.title, why: f.displayValue ? `Measured: ${f.displayValue}` : "Lighthouse flagged this as a performance opportunity.", fix: extra ? `Potential improvement: ${extra}.` : "See the Lighthouse audit id for guidance.", meta: f.id });
      }
    } catch (e) { skipped.push({ check: "lighthouse", reason: e.message }); }
  } else skipped.push({ check: "lighthouse", reason: "skipped by request" });

  // ---- Accessibility (needs puppeteer-core + Chrome; skip quietly if unavailable) ----
  let a11y = null;
  if (!skipA11y) {
    try {
      a11y = await checkA11y(url, { allowPrivate });
      for (const v of a11y.violations) {
        findings.push({ severity: IMPACT_TO_SEV[v.impact] || "medium", category: "Accessibility", title: v.help, why: v.description, fix: `See ${v.helpUrl} — affects ${v.count} element(s).`, meta: v.id });
      }
    } catch (e) { skipped.push({ check: "a11y", reason: e.message }); }
  } else skipped.push({ check: "a11y", reason: "skipped by request" });

  findings.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  const counts = { high: findings.filter((f) => f.severity === "high").length, medium: findings.filter((f) => f.severity === "medium").length, low: findings.filter((f) => f.severity === "low").length };

  return {
    tool: "website-precheck", version: "0.1.0", url, startedAt, finishedAt: new Date().toISOString(),
    scores: lighthouse ? Object.fromEntries(Object.entries(lighthouse.categoryScores).map(([k, v]) => [k, v.score])) : null,
    headers, lighthouse, a11y, findings, counts, skipped,
  };
}

// ============================= Renderers =============================

export function toJSON(report) { return JSON.stringify(report, null, 2); }

export function toMarkdown(report) {
  const { url, counts, findings, scores, skipped } = report;
  const lines = [`# Website Precheck — ${url}`, "", `Run: ${report.startedAt}`, ""];
  if (scores) lines.push(`**Lighthouse:** ${Object.entries(scores).map(([k, v]) => `${k} ${v}`).join(" · ")}`, "");
  lines.push(`**Findings:** ${counts.high} high · ${counts.medium} medium · ${counts.low} low`, "");
  if (findings.length) {
    lines.push("## Fix this first", "");
    for (const f of findings.slice(0, 10)) lines.push(`- **[${SEV_LABEL[f.severity]}/${f.category}]** ${f.title} — ${f.fix}`);
    lines.push("");
  } else {
    lines.push("No findings. 🎉", "");
  }
  if (skipped.length) {
    lines.push("## Skipped checks", "");
    for (const s of skipped) lines.push(`- ${s.check}: ${s.reason}`);
    lines.push("");
  }
  lines.push("_Generated by [website-precheck](https://github.com/amandamalavedev/website-precheck)._");
  return lines.join("\n");
}

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function scoreBand(score) { return score >= 90 ? "good" : score >= 50 ? "mid" : "bad"; }

function gauge(label, score) {
  if (score == null) return "";
  const band = scoreBand(score);
  const deg = Math.round((score / 100) * 360);
  return `<div class="gauge">
    <div class="gauge-ring ${band}" style="--deg:${deg}deg"><span>${score}</span></div>
    <div class="gauge-label">${esc(label)}</div>
  </div>`;
}

function findingRow(f) {
  return `<details class="finding sev-${f.severity}">
    <summary><span class="badge sev-${f.severity}">${SEV_LABEL[f.severity]}</span><span class="cat">${esc(f.category)}</span><span class="title">${esc(f.title)}</span></summary>
    <div class="finding-body">
      <p>${esc(f.why)}</p>
      <p class="fix"><strong>Fix:</strong> ${esc(f.fix)}</p>
    </div>
  </details>`;
}

export function toHTML(report) {
  const { url, startedAt, scores, counts, findings, headers, a11y, lighthouse, skipped } = report;
  const date = new Date(startedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  const gauges = scores
    ? Object.entries(scores).map(([k, v]) => gauge(k.replace(/-/g, " "), v)).join("")
    : `<p class="muted">Lighthouse wasn't run for this report${skipped.find((s) => s.check === "lighthouse") ? " (" + esc(skipped.find((s) => s.check === "lighthouse").reason) + ")" : ""}.</p>`;

  const topFixes = findings.slice(0, 5).map((f) => `<li><span class="badge sev-${f.severity}">${SEV_LABEL[f.severity]}</span> ${esc(f.title)}</li>`).join("") || "<li>No findings — nice work.</li>";

  const byCategory = {};
  for (const f of findings) (byCategory[f.category] ??= []).push(f);
  const findingsHTML = Object.entries(byCategory).map(([cat, items]) => `
    <section class="cat-section">
      <h3>${esc(cat)} <span class="count">${items.length}</span></h3>
      ${items.map(findingRow).join("")}
    </section>`).join("") || `<p class="muted">No findings in any category.</p>`;

  const headersTable = headers ? `
    <table class="htable">
      <thead><tr><th>Header</th><th>Status</th></tr></thead>
      <tbody>
        ${headers.checks.map((c) => `<tr><td><code>${esc(c.name)}</code></td><td class="${c.present ? "pass" : "fail"}">${c.present ? "Present" : "Missing"}</td></tr>`).join("")}
      </tbody>
    </table>` : `<p class="muted">Not checked${skipped.find((s) => s.check === "headers") ? ": " + esc(skipped.find((s) => s.check === "headers").reason) : ""}.</p>`;

  const a11ySummary = a11y
    ? `<p>${a11y.total} violation(s) across ${a11y.violations.length} rule(s) · ${a11y.passes} passed checks · ${a11y.incomplete.length} need manual review.</p>`
    : `<p class="muted">Not checked${skipped.find((s) => s.check === "a11y") ? ": " + esc(skipped.find((s) => s.check === "a11y").reason) : ""}.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Website Precheck — ${esc(url)}</title>
<style>
  :root{
    --ink:#0f172a; --ink-dim:#475569; --ink-faint:#94a3b8; --bg:#f8fafc; --card:#ffffff; --line:#e2e8f0;
    --good:#1a7f37; --good-bg:#e9f7ee; --mid:#9a6700; --mid-bg:#fff6e5; --bad:#c92a2a; --bad-bg:#fdeeee;
    --accent:#2563eb;
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      --ink:#f1f5f9; --ink-dim:#cbd5e1; --ink-faint:#64748b; --bg:#0b1220; --card:#121a2b; --line:#1e293b;
      --good-bg:#0f2a1a; --mid-bg:#2a2108; --bad-bg:#2a1414;
    }
  }
  :root[data-theme="dark"]{
    --ink:#f1f5f9; --ink-dim:#cbd5e1; --ink-faint:#64748b; --bg:#0b1220; --card:#121a2b; --line:#1e293b;
    --good-bg:#0f2a1a; --mid-bg:#2a2108; --bad-bg:#2a1414;
  }
  *{box-sizing:border-box;}
  body{margin:0; padding:24px 16px; background:var(--bg); color:var(--ink); font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;}
  .wrap{max-width:860px; margin:0 auto;}
  header.top{display:flex; flex-wrap:wrap; justify-content:space-between; align-items:baseline; gap:8px; margin-bottom:24px;}
  header.top h1{font-size:20px; margin:0; word-break:break-all;}
  header.top .meta{color:var(--ink-faint); font-size:13px;}
  .card{background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px 22px; margin-bottom:20px;}
  .card h2{font-size:14px; text-transform:uppercase; letter-spacing:.04em; color:var(--ink-dim); margin:0 0 14px;}
  .gauges{display:flex; flex-wrap:wrap; gap:28px; justify-content:center; padding:8px 0;}
  .gauge{display:flex; flex-direction:column; align-items:center; gap:8px; width:96px;}
  .gauge-ring{position:relative; width:84px; height:84px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:24px; font-weight:700;}
  .gauge-ring::before{content:""; position:absolute; inset:0; border-radius:50%; background:conic-gradient(var(--ring-color,var(--good)) var(--deg,0deg), var(--line) 0);}
  .gauge-ring::after{content:""; position:absolute; inset:8px; border-radius:50%; background:var(--card);}
  .gauge-ring span{position:relative; z-index:1;}
  .gauge-ring.good{--ring-color:var(--good); color:var(--good);}
  .gauge-ring.mid{--ring-color:var(--mid); color:var(--mid);}
  .gauge-ring.bad{--ring-color:var(--bad); color:var(--bad);}
  .gauge-label{font-size:12px; color:var(--ink-dim); text-transform:capitalize; text-align:center;}
  .counts{display:flex; gap:10px; flex-wrap:wrap; margin-top:4px;}
  .pill{border-radius:999px; padding:6px 14px; font-size:13px; font-weight:700;}
  .pill.high{background:var(--bad-bg); color:var(--bad);}
  .pill.medium{background:var(--mid-bg); color:var(--mid);}
  .pill.low{background:var(--good-bg); color:var(--good);}
  ol.top-fixes{margin:0; padding-left:20px;}
  ol.top-fixes li{margin:6px 0;}
  .badge{display:inline-block; border-radius:6px; padding:2px 8px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; margin-right:8px;}
  .badge.sev-high{background:var(--bad-bg); color:var(--bad);}
  .badge.sev-medium{background:var(--mid-bg); color:var(--mid);}
  .badge.sev-low{background:var(--good-bg); color:var(--good);}
  .cat-section{margin-bottom:18px;}
  .cat-section h3{font-size:15px; margin:0 0 8px; color:var(--ink);}
  .cat-section .count{color:var(--ink-faint); font-weight:400;}
  details.finding{border:1px solid var(--line); border-radius:8px; padding:10px 14px; margin-bottom:8px; background:var(--bg);}
  details.finding summary{cursor:pointer; display:flex; align-items:center; gap:4px; list-style:none;}
  details.finding summary::-webkit-details-marker{display:none;}
  details.finding summary .title{color:var(--ink); font-weight:600;}
  details.finding summary .cat{display:none;}
  .finding-body{margin-top:10px; padding-top:10px; border-top:1px solid var(--line); color:var(--ink-dim); font-size:14px;}
  .finding-body .fix{color:var(--ink);}
  table.htable{width:100%; border-collapse:collapse; font-size:14px;}
  table.htable th{text-align:left; color:var(--ink-faint); font-weight:600; font-size:12px; text-transform:uppercase; padding:6px 0; border-bottom:1px solid var(--line);}
  table.htable td{padding:7px 0; border-bottom:1px solid var(--line);}
  table.htable td.pass{color:var(--good); font-weight:600;}
  table.htable td.fail{color:var(--bad); font-weight:600;}
  code{background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:1px 5px; font-size:13px;}
  .muted{color:var(--ink-faint);}
  footer{text-align:center; color:var(--ink-faint); font-size:12px; margin-top:24px;}
  footer a{color:var(--accent);}
  @media print{ body{background:#fff;} .card{break-inside:avoid; border-color:#ccc;} }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>Website Precheck</h1>
    <div class="meta">${esc(date)}</div>
  </header>
  <div class="card">
    <h2>Target</h2>
    <p style="word-break:break-all;"><strong>${esc(url)}</strong></p>
    <div class="counts">
      <span class="pill high">${counts.high} high</span>
      <span class="pill medium">${counts.medium} medium</span>
      <span class="pill low">${counts.low} low</span>
    </div>
  </div>

  <div class="card">
    <h2>Lighthouse</h2>
    <div class="gauges">${gauges}</div>
  </div>

  <div class="card">
    <h2>Fix this first</h2>
    <ol class="top-fixes">${topFixes}</ol>
  </div>

  <div class="card">
    <h2>All findings</h2>
    ${findingsHTML}
  </div>

  <div class="card">
    <h2>Security headers</h2>
    ${headersTable}
  </div>

  <div class="card">
    <h2>Accessibility (axe-core, WCAG 2.1 A/AA)</h2>
    ${a11ySummary}
  </div>

  <footer>Generated by <a href="https://github.com/amandamalavedev/website-precheck">website-precheck</a> — a free, open tool. Automated checks catch real issues but not everything; pair with a manual pass.</footer>
</div>
</body>
</html>`;
}

// Write all three outputs to outDir, confined (F4) — never trust an LLM-chosen path blindly.
export function writeReportFiles(report, outDir, baseDir = process.cwd()) {
  mkdirSync(resolve(outDir), { recursive: true });
  const files = {
    json: join(outDir, "precheck-report.json"),
    html: join(outDir, "precheck-report.html"),
    md: join(outDir, "precheck-report.md"),
  };
  writeFileContained(baseDir, files.json, toJSON(report));
  writeFileContained(baseDir, files.html, toHTML(report));
  writeFileContained(baseDir, files.md, toMarkdown(report));
  return files;
}

// ---- CLI wrapper ----
const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] || "").href; } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  const rawUrl = args.find((a) => /^https?:\/\//.test(a));
  if (!rawUrl) { console.error("Usage: node report.mjs <url> [--out dir] [--skip-lighthouse] [--skip-a11y] [--allow-private]"); process.exit(2); }
  const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
  const outDir = opt("out", "precheck-report");

  let report;
  try {
    report = await runReport(rawUrl, {
      allowPrivate: flag(args, "allow-private"),
      skipLighthouse: flag(args, "skip-lighthouse"),
      skipA11y: flag(args, "skip-a11y"),
      lighthouseRuns: Number(opt("runs", "3")) || 3,
      lighthouseForm: opt("form", "mobile"),
    });
  } catch (e) {
    console.error(/private|local|valid URL/i.test(e.message) ? "Refused: " + e.message : e.message);
    process.exit(/private|local|valid URL/i.test(e.message) ? 2 : 1);
  }

  let files;
  try { files = writeReportFiles(report, outDir); }
  catch (e) { console.error("Could not write report: " + e.message); process.exit(1); }

  console.log(toMarkdown(report));
  console.log(`\nWrote:\n  ${files.json}\n  ${files.html}\n  ${files.md}`);
  process.exitCode = Math.min(report.counts.high, 250);
}
