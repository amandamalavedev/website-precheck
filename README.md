# Web Guardrails

**Free, open skills for shipping websites that are secure, fast, accessible, and compliant — the
guardrails for AI-written code.**

From [Pacific AI Labs](https://pacificailabs.com). These are the reusable [Claude](https://claude.com/claude-code)
skills we use on every site we build. They're free. If you want the deep, automated SEO/GEO analysis
they point at, that's our paid tool — see the bottom of this page.

Each skill teaches Claude a repeatable method — test as a real outsider, measure with real tools
instead of trusting a pasted report, and never claim something is done until it's verified against the
live site.

## The skills

| Category | Skill | What it does |
|---|---|---|
| **Security** · **Speed** · **Privacy** | [`site-hardening-and-speed`](./site-hardening-and-speed) | Outsider-view security audit, Lighthouse performance (run by Claude itself), and US/local privacy + cookie compliance. Ships with a Lighthouse runner. |
| **Admin / CMS** | [`site-admin-panel`](./site-admin-panel) | The auth-gated back office every site needs: edit content, upload & replace pictures (WebP + EXIF-stripped), view analytics, manage users. |
| **SEO & GEO** | [`seo-geo-schema`](./seo-geo-schema) | Titles/meta/Open Graph, JSON-LD schema, `sitemap.xml`, `robots.txt`, and `llms.txt` so a site is found by search **and** cited by AI answer engines. Ships with a sitemap generator. *(Public sites only.)* |
| **Analytics** | [`analytics-and-search-console`](./analytics-and-search-console) | Cookieless, privacy-respecting visitor analytics (no consent banner needed) plus Google Search Console setup. *(Public sites only.)* |
| **Accessibility & Launch** | [`accessibility-launch-readiness`](./accessibility-launch-readiness) | WCAG 2.1 AA pass (ships with an axe-core checker) and the pre-launch QA checklist. The final gate. |

Two ideas run through all of them:

- **Two site profiles.** Every build starts by asking: is this **Public** (indexed, wants SEO and
  analytics) or **Private** (gated, `noindex`, no public analytics)? Half the skills only apply to
  public sites — and running them on a private one is actively wrong.
- **Verify, don't guess.** Pasted audit reports are often stale or hallucinated. These skills check
  the real code and the live site.

## Install

Skills live in your Claude Code skills directory. Copy the ones you want:

```bash
git clone https://github.com/PacificAILabs/web-guardrails.git
cp -r web-guardrails/site-hardening-and-speed  ~/.claude/skills/
cp -r web-guardrails/site-admin-panel          ~/.claude/skills/
# …and the rest you want
```

Then just ask Claude Code to harden a site, run Lighthouse, add schema, or do a launch review — the
matching skill loads automatically.

Some skills ship a script. They use `npx -y lighthouse@12` (no install) or need `puppeteer-core`
installed in the project you're testing (`npm install --no-save puppeteer-core`). Each skill's
`SKILL.md` says what it needs.

## The method, in one line

Test as a real outsider. Measure with real tools, not pasted reports. Batch your deploys. Never say
it's done until you've checked it live.

## Want the deep version?

These skills lay the *foundation* for SEO and GEO. The ongoing, automated analysis — tracking how your
site ranks, where it's cited by AI answer engines, and what to fix next — is our paid tool.
**[Pacific AI Labs](https://pacificailabs.com)** · guardrails for AI-written code.

## License

MIT — see [LICENSE](./LICENSE). Use them, fork them, build on them. A link back is appreciated, not
required.

---

*Not legal advice.* The privacy/cookie and accessibility skills are solid engineering guidance; for
anything with real legal exposure, a lawyer still reviews the privacy notice, and automated
accessibility checks catch only part of the issues — do the manual pass too.
