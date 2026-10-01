# Website Precheck

**Check your website before you launch — all in one toolkit.**

Test speed, accessibility, and security headers, generate essential SEO files, and get guidance on
what to fix. Works with your terminal or AI coding assistant. Free and open, from
[Pacific AI Labs](https://github.com/amandamalavedev).

| Use it as… | For whom |
|---|---|
| **A command** — `npx precheck <check> <url>` | Anyone. No AI, no account. |
| **Claude skills** — drop into `~/.claude/skills/` | Claude Code users |
| **An MCP server** — any agent calls the checks live | Any MCP-capable AI (incl. ChatGPT) |
| **A Custom GPT** | ChatGPT users |

The same checks underneath (`lib/`); four ways to run them. You don't need to use Claude, or any AI
at all.

## Run a skill from the command line (works for everyone)

```bash
npx precheck headers    https://example.com     # security headers: present vs missing
npx precheck lighthouse https://example.com     # performance + LCP breakdown + what to fix
npx precheck a11y       https://example.com     # accessibility (WCAG 2.1 AA) via axe-core
npx precheck sitemap --dir ./build --base https://example.com   # sitemap.xml + robots.txt + llms.txt
```

- `headers` and `sitemap` are pure Node — no browser, no external install.
- `lighthouse` uses `npx lighthouse@12` under the hood (needs Chrome).
- The IP/SSRF classifier is a vendored copy of [`ipaddr.js`](https://github.com/whitequark/ipaddr.js)
  (MIT) bundled with the scripts — nothing extra to install.

**These are tools for sites you own or are authorized to test.** They harden against an agent being
tricked into a local-command or internal-network attack (no shell; private/metadata addresses
refused in every canonical IPv4/IPv6 form; writes confined to the target directory), but that is
defense in depth, not a guarantee — see [SECURITY.md](./SECURITY.md) for the threat model and the
residual risks (DNS rebinding, Lighthouse browser-driven redirects) that it does **not** fully
mitigate.
- `a11y` needs Chrome + `puppeteer-core` (`npm install --no-save puppeteer-core`); it bypasses the
  page's CSP for the scan so it works even on well-hardened sites.

No model, no account, no telemetry — it just runs the check and prints what to fix.

## Use them as Claude skills

The command tells you *what's* wrong; the Claude skill teaches Claude *how to fix it* — the full
method, not just a score. Copy the ones you want:

```bash
git clone https://github.com/amandamalavedev/website-precheck.git
cp -r website-precheck/site-hardening-and-speed  ~/.claude/skills/
# …and any others
```

| Skill | What it does |
|---|---|
| [`site-hardening-and-speed`](./site-hardening-and-speed) | Outsider-view security audit, Lighthouse performance, US/local privacy + cookie compliance. |
| [`site-admin-panel`](./site-admin-panel) | The gated back office: edit content, upload & replace pictures (WebP + EXIF-stripped), view analytics, manage users. |
| [`seo-geo-schema`](./seo-geo-schema) | Meta/Open Graph, JSON-LD schema, sitemap, robots, `llms.txt`. *(Public sites only.)* |
| [`analytics-and-search-console`](./analytics-and-search-console) | Cookieless analytics (no consent banner) + Google Search Console. *(Public sites only.)* |
| [`accessibility-launch-readiness`](./accessibility-launch-readiness) | WCAG 2.1 AA pass + the pre-launch QA checklist. |

Then just ask Claude to harden a site, run Lighthouse, add schema, or do a launch review — the
matching skill loads itself.

## Use them from any agent (MCP) or from ChatGPT

- **MCP server** ([`mcp/`](./mcp)) — exposes the checks as tools any MCP-capable agent can call live.
  One command adds it to Claude Code; see [mcp/README.md](./mcp/README.md).
- **Custom GPT kit** ([`gpt/`](./gpt)) — the instructions to paste into ChatGPT's builder so a Custom
  GPT uses the same method.

## Two ideas run through all of it

- **Two site profiles.** Every build starts by asking: **Public** (indexed, wants SEO and analytics)
  or **Private** (gated, `noindex`, no public analytics)? Some skills only apply to public sites —
  running them on a private one is actively wrong.
- **Verify, don't guess.** Pasted audit reports are often stale or hallucinated. These skills check
  the real code and the live site, and never call something done until it's verified against
  production.

## License

MIT — see [LICENSE](./LICENSE). Use them, fork them, build on them.

More free skills coming from **Pacific AI Labs** — guardrails for AI-written code.

---

*Not legal advice.* The privacy/cookie and accessibility guidance is solid engineering; for real legal
exposure a lawyer reviews the privacy notice, and automated accessibility checks catch only part of
the issues — do the manual pass too.
