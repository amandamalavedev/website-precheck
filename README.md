# Web Guardrails

**Free website checks — performance, accessibility, security headers, and SEO files — plus the
methods behind them. The guardrails for AI-written code.**

From [Pacific AI Labs](https://github.com/PacificAILabs). Free and open (MIT). Use them four ways:

| Use it as… | For whom | Status |
|---|---|---|
| **A CLI** — `npx web-guardrails <check> <url>` | Anyone. No AI model required. | ✅ ready |
| **Claude skills** — drop into `~/.claude/skills/` | Claude Code users | ✅ ready |
| **An MCP server** — any agent calls the checks live | Any MCP-capable LLM | ✅ ready ([mcp/](./mcp)) |
| **A Custom GPT** | ChatGPT users | ✅ kit ready ([gpt/](./gpt)) |

Same engine underneath (`lib/`); four wrappers on top. The CLI and MCP server run the checks; the
Claude skills and Custom GPT also teach the *method* behind them.

## The CLI (works for everyone)

```bash
npx web-guardrails lighthouse https://example.com     # performance + LCP breakdown + what to fix
npx web-guardrails a11y       https://example.com     # WCAG 2.1 AA via axe-core
npx web-guardrails headers    https://example.com     # security headers: present vs missing
npx web-guardrails sitemap --dir ./build --base https://example.com   # sitemap.xml + robots.txt + llms.txt
```

- `lighthouse` uses `npx lighthouse@12` under the hood — nothing to install, needs Chrome.
- `a11y` needs `puppeteer-core` in your project (`npm install --no-save puppeteer-core`) and Chrome;
  it bypasses the page's CSP for the scan so it works even on well-hardened sites.
- `headers` and `sitemap` are pure Node — no browser, no deps.

No model, no account, no telemetry. It just runs the check and prints what to fix.

## The Claude skills

The CLI tells you *what's* wrong; the skills teach Claude *how to fix it* — the full method, not just
a score. Copy the ones you want:

```bash
git clone https://github.com/PacificAILabs/web-guardrails.git
cp -r web-guardrails/site-hardening-and-speed  ~/.claude/skills/
# …and any others below
```

| Category | Skill | What it does |
|---|---|---|
| **Security · Speed · Privacy** | [`site-hardening-and-speed`](./site-hardening-and-speed) | Outsider-view security audit, Lighthouse performance, US/local privacy + cookie compliance. |
| **Admin / CMS** | [`site-admin-panel`](./site-admin-panel) | The gated back office: edit content, upload & replace pictures (WebP + EXIF-stripped), view analytics, manage users. |
| **SEO & GEO** | [`seo-geo-schema`](./seo-geo-schema) | Meta/Open Graph, JSON-LD schema, sitemap, robots, `llms.txt` — found by search *and* cited by AI answer engines. *(Public sites only.)* |
| **Analytics** | [`analytics-and-search-console`](./analytics-and-search-console) | Cookieless analytics (no consent banner) + Google Search Console. *(Public sites only.)* |
| **Accessibility & Launch** | [`accessibility-launch-readiness`](./accessibility-launch-readiness) | WCAG 2.1 AA pass + the pre-launch QA checklist. The final gate. |

Then just ask Claude Code to harden a site, run Lighthouse, add schema, or do a launch review — the
matching skill loads itself.

## Two ideas run through all of it

- **Two site profiles.** Every build starts by asking: **Public** (indexed, wants SEO and analytics)
  or **Private** (gated, `noindex`, no public analytics)? Half the skills only apply to public sites,
  and running them on a private one is actively wrong.
- **Verify, don't guess.** Pasted audit reports are often stale or hallucinated. These tools check the
  real code and the live site, and never call something done until it's verified against production.

## License

MIT — see [LICENSE](./LICENSE). Use them, fork them, build on them.

More free tools coming from **Pacific AI Labs** — guardrails for AI-written code.

---

*Not legal advice.* The privacy/cookie and accessibility guidance is solid engineering; for real legal
exposure a lawyer reviews the privacy notice, and automated accessibility checks catch only part of
the issues — do the manual pass too.
