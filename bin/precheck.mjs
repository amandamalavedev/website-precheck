#!/usr/bin/env node
// precheck CLI — free website checks any project can run, no AI model required.
//   precheck lighthouse <url> [--runs 3] [--form mobile|desktop]
//   precheck a11y       <url> [--wait 2000] [--full]
//   precheck headers    <url>
//   precheck sitemap    --dir ./build --base https://example.com [--out ./build]
// Each command just runs the matching check in lib/ and forwards your flags.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const lib = (f) => join(here, "..", "lib", f);

const COMMANDS = {
  lighthouse: { file: "lighthouse.mjs", blurb: "Lighthouse performance (median of N runs) + LCP breakdown + failing audits" },
  a11y:       { file: "a11y.mjs",       blurb: "WCAG 2.1 AA check via axe-core (needs puppeteer-core + Chrome)" },
  headers:    { file: "headers.mjs",    blurb: "HTTP security headers: what's present, what's missing" },
  sitemap:    { file: "sitemap.mjs",    blurb: "Generate sitemap.xml + robots.txt + llms.txt for a built site" },
};

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
  console.log(`\nprecheck — free website checks\n`);
  for (const [name, { blurb }] of Object.entries(COMMANDS)) console.log(`  precheck ${name.padEnd(11)} ${blurb}`);
  console.log(`\nExamples:
  npx precheck lighthouse https://example.com --runs 3
  npx precheck a11y https://example.com
  npx precheck headers https://example.com
  npx precheck sitemap --dir ./public --base https://example.com\n
Full method and the Claude skills: https://github.com/amandamalavedev/website-precheck\n`);
  process.exit(cmd ? 0 : 1);
}

const entry = COMMANDS[cmd];
if (!entry) { console.error(`Unknown command "${cmd}". Run "precheck help".`); process.exit(2); }

const child = spawn(process.execPath, [lib(entry.file), ...rest], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (e) => { console.error(e.message); process.exit(1); });
