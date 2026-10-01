# Web Guardrails

**Free website skills anyone can use — to make a site secure, fast, accessible, and found.**

A skill here is one capability you hand to your tools. Five of them, from
[Pacific AI Labs](https://github.com/amandamalavedev):

| Skill | Makes your site… |
|---|---|
| **Security · Speed · Privacy** | safe, fast, and honest about data |
| **Admin / CMS** | editable — change text, swap pictures, see analytics, manage users |
| **SEO & GEO** | found by Google *and* cited by AI answer engines |
| **Analytics** | measurable, without tracking cookies |
| **Accessibility & Launch** | usable by everyone, and truly ready to ship |

The point: **use the same skills in whatever you work with.** You don't need to use Claude, or any AI
at all.

| Use them as… | For whom |
|---|---|
| **A command** — `npx web-guardrails <check> <url>` | Anyone. No AI, no account. |
| **Claude skills** — drop into `~/.claude/skills/` | Claude Code users |
| **An MCP server** — any agent calls them live | Any MCP-capable AI (incl. ChatGPT) |
| **A Custom GPT** | ChatGPT users |

Same skills underneath (`lib/`); four ways to run them.

## Run a skill from the command line (works for everyone)

```bash
npx web-guardrails headers    https://example.com     # security headers: present vs missing
npx web-guardrails lighthouse https://example.com     # performance + LCP breakdown + what to fix
npx web-guardrails a11y       https://example.com     # accessibility (WCAG 2.1 AA) via axe-core
npx web-guardrails sitemap --dir ./build --base https://example.com   # sitemap.xml + robots.txt + llms.txt
```

- `headers` and `sitemap` are pure Node — no browser, no deps.
- `lighthouse` uses `npx lighthouse@12` under the hood (needs Chrome).
- The security/SSRF guard needs `ipaddr.js` (`npm install ipaddr.js`); the npm package includes it automatically.
- `a11y` needs Chrome + `puppeteer-core` (`npm install --no-save puppeteer-core`); it bypasses the
  page's CSP for the scan so it works even on well-hardened sites.

No model, no account, no telemetry — it just runs the check and prints what to fix.

## Use them as Claude skills

The command tells you *what's* wrong; the Claude skill teaches Claude *how to fix it* — the full
method, not just a score. Copy the ones you want:

```bash
git clone https://github.com/amandamalavedev/web-guardrails.git
cp -r web-guardrails/site-hardening-and-speed  ~/.claude/skills/
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
