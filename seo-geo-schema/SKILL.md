---
name: seo-geo-schema
description: >-
  Make a PUBLIC website discoverable and citable — by classic search (SEO) and by AI answer engines
  (GEO: ChatGPT, Perplexity, Google AI Overviews). Covers titles/meta/canonical, Open Graph & social
  cards, JSON-LD structured data (Organization, LocalBusiness, Person, Product, Article, FAQ,
  Breadcrumb), sitemap.xml, robots.txt, and llms.txt. Use this whenever the user wants SEO, better
  Google ranking, rich results/schema/structured data, Open Graph or social-share previews, a
  sitemap, an llms.txt, or wants their site to show up / be cited in AI answers. ONLY for public,
  indexable sites — never run it on a gated or noindex site (an internal tool, a private HQ). A deeper
  keyword/competitor SEO audit can lean on the marketing seo-audit skill; this one owns the on-page
  technical foundation.
---

# Discoverability: SEO + GEO, built on schema

Getting found now has two audiences: **search crawlers** (classic SEO) and **AI answer engines**
that read a page and cite it in a generated answer (GEO — generative engine optimization). Both reward
the same thing: a page whose facts are explicit, structured, and machine-readable. This skill lays
that foundation.

## First: confirm the site should be indexed

**Stop if the site is private/gated.** A strategy HQ, an internal tool, or anything behind a login is
deliberately `noindex` + crawler-blocked — running SEO on it is actively wrong. This skill is for
sites meant to be found. If unsure, ask which profile the site is (see the Website Build Standard).

## The on-page foundation (every public page)

Read `references/seo-geo.md` for the specifics and copy-paste templates. The essentials:

- **One `<title>`** per page (~50-60 chars, specific), one `<meta name="description">` (~150 chars,
  honest, compelling), one `<link rel="canonical">` to the page's own URL.
- **One `<h1>`** that states the page's subject; a sane heading outline below it (don't skip levels).
- **Open Graph + Twitter cards** so links shared to WhatsApp/Facebook/X/Slack show a title, image and
  summary instead of a bare URL. A 1200×630 OG image.
- **JSON-LD structured data** in `<script type="application/ld+json">` — the single highest-leverage
  item for both rich results and AI citation. Pick the types that fit (Organization/LocalBusiness,
  Person, Product, Article/BlogPosting, FAQPage, BreadcrumbList) and fill them with the site's real
  facts. Templates in the reference.
- **sitemap.xml** listing every indexable URL; **robots.txt** allowing crawl and pointing to the
  sitemap; **llms.txt** (a Markdown map of the site for AI agents — see GEO below).

## GEO: being cited by AI answer engines

AI answers quote pages that make a fact easy to lift and trust. Beyond the schema above:

- **State facts plainly and atomically** near the top — who, what, where, price, hours, claims with
  dates. Answer engines extract sentences; bury the fact in marketing prose and it won't be quoted.
- **Match questions to answers.** A real FAQ (with `FAQPage` schema) is directly liftable. Use the
  phrasing people actually ask.
- **Be consistent and sourced.** The same name, address, numbers everywhere; cite the source for a
  claim (and date it) — AI engines weight verifiable, consistent facts.
- **`llms.txt`** at the site root: a concise Markdown index of the site's key pages and facts, written
  for an AI agent. The reference has a template. It's an emerging convention, cheap to add, honoured
  by a growing set of tools.
- Keep it crawlable: server-rendered or statically built HTML (not facts that appear only after JS),
  fast (the speed skill), and clean URLs.

## Scripts

- `scripts/gen-sitemap.mjs` — generate `sitemap.xml` from a built site directory (it finds the
  `.html` files) or from a list of URLs, plus a matching `robots.txt` and an `llms.txt` starter.
  `node scripts/gen-sitemap.mjs --dir ./public-site --base https://example.com`.

## Verify, don't assume

- Validate JSON-LD with Google's Rich Results Test / Schema.org validator before claiming it works.
- Fetch the live `sitemap.xml`, `robots.txt`, and a page's `<head>` and confirm the tags are actually
  served (a framework can strip or duplicate them).
- The honest bar: never add schema that misrepresents the page (fake reviews, fake ratings) — it's a
  manual-action risk and a trust violation. Structured data describes what's really on the page.
- Submitting to Google Search Console and watching coverage is the companion
  `analytics-and-search-console` skill's job — do them together for a public launch.
