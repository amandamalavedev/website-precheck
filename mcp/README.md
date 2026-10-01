# Web Guardrails MCP server

Exposes the free Web Guardrails checks as tools any MCP-capable agent can call live:

- `check_security_headers` — which security headers a URL sends vs. what's missing.
- `run_lighthouse` — performance score, Core Web Vitals, LCP breakdown, failing audits.
- `check_accessibility` — WCAG 2.1 A/AA violations via axe-core.
- `generate_sitemap` — sitemap.xml + robots.txt + llms.txt for a built site.

Same engine as the CLI (`../lib`), wrapped over stdio with the MCP SDK.

**Scope & limits:** these tools are for sites you own or are authorized to test. The SSRF guard
refuses private/internal/metadata addresses by default (override per call with `allowPrivate`), but
it is defense in depth, not a guarantee — read [../SECURITY.md](../SECURITY.md) for the residual risks
(DNS rebinding, Lighthouse browser-driven redirects) before pointing these at agent-chosen URLs.

## Install

The MCP server ships inside the one `web-guardrails` package (it shares the `lib/` engine), so a
normal install of the package brings it and its dependencies:

```bash
npm install            # from the repo root — installs the SDK, zod, ipaddr.js
npm install puppeteer-core   # only if you want the accessibility tool
```

`run_lighthouse` needs Chrome (it uses `npx lighthouse@12`). `check_accessibility` needs Chrome +
`puppeteer-core`. `check_security_headers` and `generate_sitemap` need neither.

## Add it to Claude Code

```bash
claude mcp add web-guardrails -- node /absolute/path/to/web-guardrails/mcp/server.mjs
```

Or in any MCP client's config, register a **stdio** server with command `node` and arg
`.../web-guardrails/mcp/server.mjs`. Then ask the agent to "check the security headers on
example.com" and it calls the tool.

## Use it from ChatGPT (Custom GPT Action)

ChatGPT calls HTTP Actions, not stdio MCP directly. To wire these checks into a Custom GPT, put a thin
HTTP layer in front of this server (or call the `../lib` scripts from a small API) and give the GPT
that API's OpenAPI schema as an Action. See `../gpt/custom-gpt-kit.md`.
