#!/usr/bin/env node
// Web Guardrails MCP server — exposes the free website checks as tools any MCP-capable agent can call.
// Same engine as the CLI (../lib), wrapped as MCP tools over stdio.
//
// Run:   node mcp/server.mjs
// Add to an MCP client (e.g. Claude Code) as a stdio server pointing at this file.
// Tools: run_lighthouse, check_accessibility, check_security_headers, generate_sitemap.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const lib = (f) => join(here, "..", "lib", f);

// Run a lib check and capture its output as text (the same scripts the CLI runs).
function runCheck(file, args) {
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

const server = new McpServer({ name: "web-guardrails", version: "0.1.0" });

server.registerTool("check_security_headers",
  { title: "Check security headers", description: "Fetch a URL and report which recommended HTTP security headers are present or missing (CSP, HSTS, nosniff, frame, referrer, permissions) and whether it leaks its server software. Non-destructive GET.",
    inputSchema: { url: z.string().url() } },
  async ({ url }) => text(await runCheck("headers.mjs", [url])));

server.registerTool("run_lighthouse",
  { title: "Run Lighthouse", description: "Run Lighthouse against a URL (median of N runs) and return performance score, Core Web Vitals, the LCP element and its phase breakdown, and the failing audits ranked by saving. Needs Chrome; uses npx lighthouse.",
    inputSchema: { url: z.string().url(), runs: z.number().int().min(1).max(5).optional(), form: z.enum(["mobile", "desktop"]).optional() } },
  async ({ url, runs, form }) => text(await runCheck("lighthouse.mjs", [url, ...(runs ? ["--runs", String(runs)] : []), ...(form ? ["--form", form] : [])])));

server.registerTool("check_accessibility",
  { title: "Check accessibility (WCAG 2.1 AA)", description: "Run axe-core against a URL in headless Chrome and report WCAG 2.1 A/AA violations by severity with the offending elements and fix links. Catches ~a third of issues — a human still does the keyboard/contrast pass. Needs Chrome + puppeteer-core.",
    inputSchema: { url: z.string().url(), full: z.boolean().optional() } },
  async ({ url, full }) => text(await runCheck("a11y.mjs", [url, ...(full ? ["--full"] : [])])));

server.registerTool("generate_sitemap",
  { title: "Generate sitemap.xml", description: "Generate sitemap.xml (+ robots.txt and an llms.txt starter) for a built static site directory, under the given base URL. Writes files to --out (or the dir).",
    inputSchema: { dir: z.string(), base: z.string().url(), out: z.string().optional() } },
  async ({ dir, base, out }) => text(await runCheck("sitemap.mjs", ["--dir", dir, "--base", base, ...(out ? ["--out", out] : [])])));

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr is fine for a status line; stdout is the MCP channel, keep it clean.
console.error("web-guardrails MCP server ready (stdio) — tools: check_security_headers, run_lighthouse, check_accessibility, generate_sitemap");
