# Google Search Console setup

Search Console (search.google.com/search-console) is Google's free view of a site's search presence:
indexing status, the queries that surface it, clicks, impressions, average position, and problems. It
needs the owner's Google account — **prepare everything, hand the owner exact steps, never ask for
their password or a code.**

## 1. Verify ownership

Pick one method and give the owner the exact value to place:

- **DNS TXT record (recommended — verifies the whole domain, all subdomains and protocols):** Google
  gives a string like `google-site-verification=abc123…`. The owner adds a TXT record at the DNS
  registrar with that value. This is best for a site on a custom domain and pairs with the DNS/CDN
  setup. Tell them: host/name `@` (or the domain), type `TXT`, value `<the string>`.
- **HTML meta tag:** `<meta name="google-site-verification" content="abc123…">` in the home page
  `<head>`. You can add this to the build directly. Good when you control the HTML but not DNS yet.
- **HTML file:** upload `google<hash>.html` to the site root, served at `/google<hash>.html`.

After the record/tag is live, the owner clicks **Verify** in Search Console.

## 2. Submit the sitemap

In Search Console → Sitemaps, submit `sitemap.xml` (from the seo-geo-schema skill). This tells Google
every page to consider. Confirm it's fetched without errors.

## 3. Read coverage (Indexing → Pages)

- **Indexed** — pages Google will show. Good.
- **Not indexed** — with a reason: "Crawled, currently not indexed", "Discovered, not indexed",
  "Excluded by noindex", "Duplicate", "Redirect". Fix the fixable ones; a brand-new site just needs
  time (indexing takes days to weeks).
- Use **URL Inspection** on a key page to see its live status and "Request indexing".

## 4. Read Performance (the payoff)

- **Queries** — the actual search terms that showed the site. This is gold for the SEO/GEO work: write
  to the questions people really ask.
- **Clicks / Impressions / CTR / Average position** — per query and per page. Rising impressions on
  the right queries means the SEO foundation is working; low CTR at a good position means the
  title/description need to be more compelling.
- Data lags ~2-3 days and needs a few weeks of history to be meaningful — set expectations.

## What you do vs what the owner does

- **You:** prepare the verification value (and can embed the meta tag or HTML file in the build),
  generate and host the sitemap, and interpret coverage/performance once connected.
- **The owner:** adds the DNS record or clicks Verify, submits the sitemap in their account, and
  grants you a look at the data (a screenshot or a shared/read-only access) if they want help reading
  it.

## Bing / others

Bing Webmaster Tools can import directly from Search Console — a two-minute add once GSC is set, worth
it since some AI answer engines draw on Bing's index. Same sitemap.
