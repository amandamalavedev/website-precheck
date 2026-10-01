# Website Precheck MCP server

Exposes the free Website Precheck checks as tools any MCP-capable agent can call live:

- `precheck_report` — run the full multi-pillar audit and return one structured report.
- `check_security_headers` — which security headers a URL sends vs. what's missing.
- `run_lighthouse` — performance score, Core Web Vitals, LCP breakdown, failing audits.
- `check_accessibility` — WCAG 2.1 A/AA violations via axe-core.
- `check_cookies` — cookies set on the first response and their flags (HttpOnly, Secure, SameSite).
- `check_privacy` — third-party trackers the page loads.
- `check_video_weight` — oversized video assets worth compressing.
- `check_schema` — structured data (JSON-LD) found on the page and how complete it is.
- `generate_sitemap` — sitemap.xml + robots.txt + llms.txt for a built site.

Same engine as the CLI (`../lib`), wrapped over stdio with the MCP SDK.

**Scope & limits:** these tools are for sites you own or are authorized to test. The SSRF guard
refuses private/internal/metadata addresses by default (override per call with `allowPrivate`), but
it is defense in depth, not a guarantee — read [../SECURITY.md](../SECURITY.md) for the residual risks
(DNS rebinding, Lighthouse browser-driven redirects) before pointing these at agent-chosen URLs.

## Install

The MCP server ships inside the one `precheck` package (it shares the `lib/` engine), so a
normal install of the package brings it and its dependencies:

```bash
npm install            # from the repo root — installs the SDK, zod, ipaddr.js
npm install puppeteer-core   # only if you want the accessibility tool
```

`run_lighthouse` needs Chrome (it uses `npx lighthouse@12`). `check_accessibility` needs Chrome +
`puppeteer-core`. `check_security_headers` and `generate_sitemap` need neither.

## Add it to Claude Code

```bash
claude mcp add precheck -- node /absolute/path/to/website-precheck/mcp/server.mjs
```

Or in any MCP client's config, register a **stdio** server with command `node` and arg
`.../website-precheck/mcp/server.mjs`. Then ask the agent to "check the security headers on
example.com" and it calls the tool.

## Use it from ChatGPT (Custom GPT Action)

ChatGPT calls HTTP Actions, not stdio MCP directly. To wire these checks into a Custom GPT, put a thin
HTTP layer in front of this server (or call the `../lib` scripts from a small API) and give the GPT
that API's OpenAPI schema as an Action. See `../gpt/custom-gpt-kit.md`.
