#!/usr/bin/env node
// Website Precheck MCP server — exposes the free website checks as tools any MCP-capable agent can call.
// Calls the lib/ functions directly, in-process, and returns structured JSON — not captured
// terminal text — so a calling agent gets real data to reason over, not a text blob to re-parse.
// `generate_sitemap` is the one exception: sitemap.mjs runs its logic at import time and calls
// process.exit() itself, so it isn't safe to import into a long-lived server process; it still
// shells out, same as before.
//
// Run:   node mcp/server.mjs
// Add to an MCP client (e.g. Claude Code) as a stdio server pointing at this file.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkHeaders } from "../lib/headers.mjs";
import { checkMobile } from "../lib/mobile.mjs";
import { detectPlatform, readPageProfile, securityChecklist } from "../lib/specifics.mjs";
import { checkA11y } from "../lib/a11y.mjs";
import { runLighthouse } from "../lib/lighthouse.mjs";
import { checkCookies } from "../lib/cookies.mjs";
import { checkPrivacy } from "../lib/privacy.mjs";
import { checkVideoAssets } from "../lib/media.mjs";
import { checkSchema } from "../lib/schema.mjs";
import { runReport } from "../lib/report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const lib = (f) => join(here, "..", "lib", f);

// Only generate_sitemap still shells out — see header note.
function runScript(file, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [lib(file), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve(`Failed to run ${file}: ${e.message}`));
    child.on("close", () => resolve(out.trim() || `(${file} produced no output)`));
  });
}
const text = (s) => ({ content: [{ type: "text", text: s }] });
const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
// A refusal (SSRF guard, bad URL, no Chrome) becomes a clear tool error, not an unhandled crash
// that takes the whole server down with it.
function guarded(fn) {
  return async (args) => {
    try { return json(await fn(args)); }
    catch (e) { return { content: [{ type: "text", text: `Refused or failed: ${e.message}` }], isError: true }; }
  };
}

const server = new McpServer({ name: "precheck", version: "0.1.0" });

// SCOPE (applies to every tool below, and is repeated in each description because the agent reads
// those): these are for sites the user OWNS OR IS AUTHORIZED TO TEST, not arbitrary agent-chosen
// URLs. allowPrivate defaults to false, so loopback/private/metadata addresses are refused by
// default (defense in depth against an injected agent probing the internal network) — but this is
// NOT a full guarantee. Residual network risks (DNS rebinding; Lighthouse follows redirects
// without per-request filtering) are documented in SECURITY.md.
const SCOPE = " Only for sites you own or are authorized to test (not arbitrary URLs); refuses private/internal/metadata addresses by default (set allowPrivate for a trusted local site). Residual risks in SECURITY.md.";

server.registerTool("precheck_report",
  { title: "Full precheck report", description: "Run the checks in one go — Security (with the full security checklist), Governance, Privacy, Speed, Accessibility, Mobile (structured data only if skipSchema is false). Set maxPages (e.g. 20) to check the WHOLE site: it follows the site's own links and sitemap.xml, checks every page, and merges the results (one finding per problem, naming the pages it's on, plus each page's scores); allow roughly a minute per page. Default 1 = only the given page. Returns the combined structured result: findings with a plain-English why/fix and, where one can be generated, the actual code to fix it on this site (not generic advice)." + SCOPE,
    inputSchema: { url: z.string().url(), allowPrivate: z.boolean().optional(), skipLighthouse: z.boolean().optional(), skipA11y: z.boolean().optional(), skipCookies: z.boolean().optional(), skipVideo: z.boolean().optional(), skipPrivacy: z.boolean().optional(), skipSchema: z.boolean().optional(), maxPages: z.number().int().min(1).max(100).optional() } },
  guarded(({ url, allowPrivate, skipLighthouse, skipA11y, skipCookies, skipVideo, skipPrivacy, skipSchema, maxPages }) =>
    runReport(url, { allowPrivate, skipLighthouse, skipA11y, skipCookies, skipVideo, skipPrivacy, skipSchema, maxPages: maxPages ?? 1 })));

server.registerTool("check_security_headers",
  { title: "Check security headers", description: "Fetch a URL and report which recommended HTTP security headers are present or missing (CSP, HSTS, nosniff, frame, referrer, permissions) and whether it leaks its server software. Non-destructive GET." + SCOPE,
    inputSchema: { url: z.string().url(), allowPrivate: z.boolean().optional() } },
  guarded(({ url, allowPrivate }) => checkHeaders(url, { allowPrivate })));

server.registerTool("run_lighthouse",
  { title: "Run Lighthouse", description: "Run Lighthouse against a URL (median of N runs) and return the performance score, Core Web Vitals, the exact device/network conditions tested (never just \"mobile\"/\"4G\"), the LCP element and its phase breakdown, and the failing audits. Needs Chrome. NOTE: Lighthouse drives its own browser, so only the initial URL is address-checked — a page that redirects to an internal address is NOT blocked, so run it only against sites you trust." + SCOPE,
    inputSchema: { url: z.string().url(), runs: z.number().int().min(1).max(5).optional(), form: z.enum(["mobile", "desktop"]).optional(), allowPrivate: z.boolean().optional() } },
  guarded(({ url, runs, form, allowPrivate }) => runLighthouse(url, { runs, form, allowPrivate })));

server.registerTool("check_accessibility",
  { title: "Check accessibility (WCAG 2.1 AA)", description: "Run axe-core against a URL in headless Chrome and report WCAG 2.1 A/AA violations by severity with the offending elements and fix links. Catches ~a third of issues — a human still does the keyboard/contrast pass. Needs Chrome + puppeteer-core. Every browser request (redirects and subresources) is address-filtered, though DNS rebinding remains a residual risk (SECURITY.md)." + SCOPE,
    inputSchema: { url: z.string().url(), full: z.boolean().optional(), allowPrivate: z.boolean().optional() } },
  guarded(({ url, full, allowPrivate }) => checkA11y(url, { full, allowPrivate })));

server.registerTool("check_cookies",
  { title: "Check cookie governance", description: "List every cookie a site's first response sets and flag any missing Secure/SameSite. Does not judge a missing HttpOnly — a cookie a script needs to read (a CSRF token) is sometimes correctly non-HttpOnly, so that's a human call, not an automated finding." + SCOPE,
    inputSchema: { url: z.string().url(), allowPrivate: z.boolean().optional() } },
  guarded(({ url, allowPrivate }) => checkCookies(url, { allowPrivate })));

server.registerTool("check_privacy",
  { title: "Check third-party privacy disclosure", description: "Find third-party script/iframe origins a page loads, label the recognizable analytics/ad/tracking services among them, and check for a privacy policy link. An unrecognized origin (a CDN, a webfont host) is listed for transparency, never flagged on its own." + SCOPE,
    inputSchema: { url: z.string().url(), allowPrivate: z.boolean().optional() } },
  guarded(({ url, allowPrivate }) => checkPrivacy(url, { allowPrivate })));

server.registerTool("check_video_weight",
  { title: "Check video asset weight", description: "Find local <video>/<source> files a page references and report their real size, flagging ones over a size threshold (default 2000 KiB) — heavy hero/background video is often the single biggest thing on a page and isn't a stock Lighthouse audit." + SCOPE,
    inputSchema: { url: z.string().url(), allowPrivate: z.boolean().optional(), thresholdKiB: z.number().optional() } },
  guarded(({ url, allowPrivate, thresholdKiB }) => checkVideoAssets(url, { allowPrivate, thresholdKiB })));

server.registerTool("check_schema",
  { title: "Check structured data (Schema)", description: "Find every JSON-LD (<script type=\"application/ld+json\">) block on a page, identify each object's @type, and score it against a baseline set of recommended properties for that type. Flags malformed JSON-LD (invalid JSON is silently ignored by search engines, so a broken block looks present but contributes nothing)." + SCOPE,
    inputSchema: { url: z.string().url(), allowPrivate: z.boolean().optional() } },
  guarded(({ url, allowPrivate }) => checkSchema(url, { allowPrivate })));

server.registerTool("check_mobile",
  { title: "Check mobile readiness", description: "Load the page on a 390×844 phone screen and check the mobile viewport tag, sideways scrolling (with the elements that stick out), tap targets under 24×24px and text under 12px — each with the exact element. Needs Chrome + puppeteer-core.",
    inputSchema: { url: z.string().url(), allowPrivate: z.boolean().optional() } },
  guarded(({ url, allowPrivate }) => checkMobile(url, { allowPrivate })));

server.registerTool("check_security",
  { title: "Security checklist", description: "The full outside-in security checklist: HTTPS + redirect, HSTS, Content-Security-Policy (with a policy built from what the page loads), clickjacking, nosniff, Referrer/Permissions-Policy, software disclosure, cookies, mixed content, SRI, exposed .git/.env, public source maps, API keys/passwords/emails inside the site's scripts, downloadable server files, security.txt, trackers and privacy link. Every fail/warn includes where the fix goes on this site's host and what to paste.",
    inputSchema: { url: z.string().url(), allowPrivate: z.boolean().optional() } },
  guarded(async ({ url, allowPrivate }) => {
    const headers = await checkHeaders(url, { allowPrivate });
    const [cookies, privacy, profile] = await Promise.all([
      checkCookies(url, { allowPrivate }).catch(() => null),
      checkPrivacy(url, { allowPrivate }).catch(() => null),
      readPageProfile(url, { allowPrivate }).catch(() => null),
    ]);
    return securityChecklist({ url, headers, cookies, privacy, profile, platform: detectPlatform(headers.responseHeaders), allowPrivate });
  }));

server.registerTool("generate_sitemap",
  { title: "Generate sitemap.xml", description: "Generate sitemap.xml (+ robots.txt and an llms.txt starter) for a built static site directory, under the given base URL. Writes only inside that directory; won't overwrite existing files unless overwrite is true.",
    inputSchema: { dir: z.string(), base: z.string().url(), out: z.string().optional(), overwrite: z.boolean().optional() } },
  async ({ dir, base, out, overwrite }) => text(await runScript("sitemap.mjs", ["--dir", dir, "--base", base, ...(out ? ["--out", out] : []), ...(overwrite ? ["--overwrite"] : [])])));

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr is fine for a status line; stdout is the MCP channel, keep it clean.
console.error("precheck MCP server ready (stdio) — tools: precheck_report, check_security_headers, run_lighthouse, check_accessibility, check_cookies, check_privacy, check_video_weight, check_schema, generate_sitemap");
