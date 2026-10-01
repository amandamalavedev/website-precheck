# SEO + GEO: templates and specifics

Fill every template with the site's **real** facts. Honesty is both the ethical and the effective
choice — fabricated schema is a manual-action risk and AI engines down-weight inconsistent claims.

## Head tags (every page)

```html
<title>Specific page title — Brand</title>
<meta name="description" content="One honest, compelling sentence, ~150 chars, that would make someone click.">
<link rel="canonical" href="https://example.com/this-page">
<meta name="robots" content="index,follow">   <!-- or noindex on a page you don't want found -->

<!-- Open Graph (Facebook, WhatsApp, LinkedIn, Slack) -->
<meta property="og:type" content="website">
<meta property="og:title" content="Specific page title">
<meta property="og:description" content="Same honest summary.">
<meta property="og:url" content="https://example.com/this-page">
<meta property="og:image" content="https://example.com/og-image.jpg">  <!-- 1200×630, <1MB -->
<meta property="og:site_name" content="Brand">

<!-- Twitter / X -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Specific page title">
<meta name="twitter:description" content="Same honest summary.">
<meta name="twitter:image" content="https://example.com/og-image.jpg">
```

One `<h1>` per page stating the subject. Headings nest without skipping (h1 → h2 → h3). Descriptive,
lowercase, hyphenated URLs. Every image a real `alt`.

## JSON-LD structured data

Put in `<script type="application/ld+json">` in `<head>`. Use the types that fit; combine with an
`@graph` array when several apply.

**Organization / LocalBusiness** (home page):
```json
{"@context":"https://schema.org","@type":"Organization",
 "name":"Brand","url":"https://example.com","logo":"https://example.com/logo.png",
 "sameAs":["https://facebook.com/brand","https://x.com/brand"],
 "contactPoint":{"@type":"ContactPoint","contactType":"customer service","email":"hello@example.com"}}
```
For a physical place use `LocalBusiness` with `address` (PostalAddress), `telephone`, `openingHours`,
`geo`.

**Person** (bio/portfolio):
```json
{"@context":"https://schema.org","@type":"Person","name":"Full Name","jobTitle":"Role",
 "url":"https://example.com","sameAs":["https://linkedin.com/in/…"],"worksFor":{"@type":"Organization","name":"Brand"}}
```

**Product**: `name`, `description`, `image`, `brand`, `offers` (price, priceCurrency, availability).
Only add `aggregateRating`/`review` if the reviews are real and on the page.

**Article / BlogPosting**: `headline`, `author` (Person), `datePublished`, `dateModified`, `image`,
`publisher`.

**FAQPage** (excellent for GEO — directly liftable):
```json
{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[
 {"@type":"Question","name":"Real question people ask?","acceptedAnswer":{"@type":"Answer","text":"Direct, factual answer."}}]}
```

**BreadcrumbList** for nested pages so search shows the path.

Validate every block with Google's Rich Results Test and the Schema.org validator before shipping.

## sitemap.xml / robots.txt

`sitemap.xml` lists every indexable URL with `<lastmod>`. Generate it with
`scripts/gen-sitemap.mjs`. `robots.txt`:
```
User-agent: *
Allow: /
Sitemap: https://example.com/sitemap.xml
```
(A private site inverts this: `Disallow: /` and `noindex` — handled by the hardening/launch skills,
not here.)

## llms.txt (GEO)

A Markdown file at `/llms.txt` that maps the site for AI agents — a growing convention. Keep it
concise and factual:
```
# Brand

> One-sentence description of what this is and who it's for.

## Key facts
- What it does, where, for whom. Price/hours/contact if relevant.

## Pages
- [Home](https://example.com/): what's here
- [About](https://example.com/about): the story, the people
- [Products](https://example.com/products): what's sold

## Contact
hello@example.com
```

## GEO content principles (how to get quoted)

1. **Lead with the fact.** Put who/what/where/price/claim in a plain sentence near the top, not buried
   in prose. Answer engines extract sentences.
2. **One idea per paragraph**, descriptive subheadings that read as questions or claims.
3. **Consistency everywhere** — identical name, address, numbers across pages and schema.
4. **Source and date claims.** "As of <date>, per <source>" beats an undated assertion.
5. **Real FAQs** in the user's own phrasing, backed by FAQPage schema.
6. **Stay crawlable and fast** — facts in the HTML, not injected after load; the speed skill keeps
   it quick; clean, stable URLs.

A deeper keyword/competitor/content-gap audit is the `marketing:seo-audit` skill's job — this skill
owns the technical on-page foundation that audit then builds on.
