# Website Precheck

**Check your website before you launch — all in one toolkit.**

Test speed, accessibility, and security headers, generate essential SEO files, and get guidance on
what to fix. Works with your terminal or AI coding assistant. Free and open, from
[Pacific AI Labs](https://github.com/amandamalavedev).

| Use it as… | For whom |
|---|---|
| **A command** — `precheck <check> <url>` | Anyone. No AI, no account. |
| **Claude skills** — drop into `~/.claude/skills/` | Claude Code users |
| **An MCP server** — any agent calls the checks live | Any MCP-capable AI (incl. ChatGPT) |
| **A Custom GPT** or **Gemini Gem** | ChatGPT and Gemini users |

The same checks underneath (`lib/`); five ways to run them. You don't need to use Claude, or any AI
at all.

## Run the checks from the command line (works for everyone)

Run any check without installing (Node 18+):

```bash
npx @amandamalavedev/precheck headers https://example.com
```

…or install it once and use the short `precheck` command:

```bash
npm install -g @amandamalavedev/precheck
```

> **Always use the full name `@amandamalavedev/precheck`.** Plain `npx precheck` is a different,
> unrelated name on npm — if anyone ever publishes a package called `precheck`, that command would
> run their code, not this. (You can also install straight from this repo:
> `npm install -g github:amandamalavedev/website-precheck`.)

```bash
precheck report     https://example.com --out ./report   # all seven checks → one shareable HTML/JSON/MD report
precheck headers    https://example.com     # security headers: present vs missing
precheck cookies    https://example.com     # every cookie the site sets, flagged for missing Secure/SameSite
precheck privacy    https://example.com     # third-party trackers, and whether a privacy policy is linked
precheck lighthouse https://example.com     # performance (median of N runs) + LCP breakdown + what to fix
precheck a11y       https://example.com     # accessibility (WCAG 2.1 AA) via axe-core
precheck schema     https://example.com     # Schema: structured data (JSON-LD) found + how complete it is
precheck mobile     https://example.com     # Mobile ready: viewport, sideways scroll, tap size, text size
precheck media      https://example.com     # local <video> files over a size threshold
precheck sitemap --dir ./build --base https://example.com   # generate sitemap.xml + robots.txt + llms.txt
```

The seven checks in `report`, each with its own score, an explanation of how that score is calculated,
and the exact fix for every problem:

- **Security** — a 20-point checklist: HTTPS, security headers, a Content-Security-Policy built from what
  your page actually loads, clickjacking, insecure content, exposed `.git`/`.env`, public source maps,
  API keys/passwords/emails inside your site's scripts, downloadable server files, `security.txt`.
- **Governance** (cookies) · **Privacy** (third-party trackers) · **Speed** (Lighthouse, with every Core
  Web Vital rated against Google's thresholds) · **Accessibility** (axe-core, each failing element with
  its corrected markup or colour) · **Mobile** (phone-sized screen) · **Schema** (structured data, with a
  ready-to-paste block filled in from your page).

The report detects which host serves the site (Netlify, Vercel, Cloudflare, GitHub Pages, nginx, Apache,
Express…) and writes every header fix in that host's own format — e.g. one `_headers` file for Netlify.

- `headers`, `cookies`, `privacy`, `schema`, `media` and `sitemap` are pure Node — no browser, no external install.
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
method, not just a score. Install all five (or keep only the ones you want):

```bash
git clone https://github.com/amandamalavedev/website-precheck.git
cd website-precheck
for s in site-hardening-and-speed site-admin-panel seo-geo-schema analytics-and-search-console accessibility-launch-readiness; do
  cp -r "$s" ~/.claude/skills/
done
```

To update later: `git pull` in the clone and run the same loop again — it copies the new version of
every file over the old one.

| Skill | What it does |
|---|---|
| [`site-hardening-and-speed`](./site-hardening-and-speed) | Outsider-view security audit, Lighthouse performance, US/local privacy + cookie compliance. |
| [`site-admin-panel`](./site-admin-panel) | The gated back office: edit content, upload & replace pictures (WebP + EXIF-stripped), view analytics, manage users. |
| [`seo-geo-schema`](./seo-geo-schema) | Meta/Open Graph, JSON-LD schema, sitemap, robots, `llms.txt`. *(Public sites only.)* |
| [`analytics-and-search-console`](./analytics-and-search-console) | Cookieless analytics (no consent banner) + Google Search Console. *(Public sites only.)* |
| [`accessibility-launch-readiness`](./accessibility-launch-readiness) | WCAG 2.1 AA pass + the pre-launch QA checklist. |

Then just ask Claude to harden a site, run Lighthouse, add schema, or do a launch review — the
matching skill loads itself.

## Use them from any agent (MCP), ChatGPT or Gemini

- **MCP server** ([`mcp/`](./mcp)) — exposes the checks as tools any MCP-capable agent can call live.
  One command adds it to Claude Code; see [mcp/README.md](./mcp/README.md).
- **Custom GPT kit** ([`gpt/`](./gpt)) — the instructions to paste into ChatGPT's builder so a Custom
  GPT uses the same method.
- **Gemini Gem kit** ([`gemini/`](./gemini)) — the same, for Gemini's Gem manager.
- The GPT and the Gem give the *method* only; they don't run the real checks unless you connect them
  to the command or the MCP server (each kit explains how).

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
