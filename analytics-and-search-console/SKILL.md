---
name: analytics-and-search-console
description: >-
  Set up visitor analytics and Google Search Console for a PUBLIC website — so the owner can see how
  many people visit, which pages they read, where they came from, and how the site performs in Google
  search. Use this whenever the user wants website analytics, visitor stats, traffic numbers, to know
  who's visiting or where visitors come from, to set up Google Analytics or a privacy-friendly
  alternative, to verify a site with Google Search Console, submit a sitemap to Google, or track
  search rankings/clicks/impressions. Defaults to a cookieless, privacy-respecting approach so the
  site avoids a consent-banner obligation. ONLY for public sites — a gated/noindex site keeps its
  analytics private and skips Search Console.
---

# Analytics + Search Console, the privacy-respecting way

Two questions the owner wants answered: **who's visiting my site** (analytics) and **how do I show up
in Google** (Search Console). Set both up so they work without dragging in tracking cookies that would
force a consent banner.

## Default to cookieless analytics (it avoids the banner)

The cleanest option for a small site is **first-party, cookieless, IP-less counting** — you own the
data, there's nothing to consent to, and the privacy notice can honestly say "no advertising or
tracking cookies". This is the pattern proven on the campaign build; see
`references/analytics-setup.md` for the server + beacon code.

What it captures per visit: the page, a timestamp, the referrer host, and (optionally) the visitor's
**country looked up at request time from the IP, with the IP then discarded**. No cookie, no
cross-site identifier, no stored IP. Aggregated in the admin analytics panel: visits over time, top
pages, countries, referrers/share-channels, a "last refreshed" time. Exclude the team's own logged-in
traffic so the numbers are the public.

**If the owner specifically wants a hosted tool:** prefer a privacy-respecting, cookieless one
(Plausible, Fathom, Cloudflare Web Analytics, or GA4 configured without ads features and with IP
handling disclosed). Any third-party analytics must be disclosed in the privacy notice, and anything
that sets a tracking cookie or enables ad features needs a real consent gate (see the hardening
skill's privacy reference) — which is exactly what cookieless avoids. Don't add Google Analytics by
reflex; ask what the owner actually needs to know and pick the lightest tool that answers it.

## Google Search Console (public sites only)

Search Console is Google's free view of how the site performs in search — the queries that show it,
clicks, impressions, indexing coverage, and problems. Setup (`references/search-console.md`):

1. **Verify ownership** — DNS TXT record (best, covers the whole domain) or an HTML file / meta tag.
2. **Submit the sitemap** (`sitemap.xml` from the seo-geo-schema skill).
3. **Check coverage** — which pages are indexed, which are excluded and why.
4. **Watch Performance** — the real search queries, clicks, impressions, average position.

Search Console requires the owner's Google account, so the owner does the clicking; your job is to
prepare the verification record/tag, tell them exactly what to paste where, and interpret the results
once it's connected. Never ask for their Google password or codes.

## Workflow

1. Confirm the site is public. (Private/gated → keep analytics in the private admin panel, skip
   Search Console entirely.)
2. Choose the analytics approach — default to cookieless first-party; pick a hosted tool only if the
   owner needs something it provides.
3. Build/wire analytics (server beacon + admin panel view, or install the chosen tool) and confirm a
   real visit shows up.
4. Prepare Search Console verification; hand the owner the exact record/tag and steps; submit the
   sitemap once verified.
5. Confirm the privacy notice matches what analytics actually collects (hand off to the hardening
   skill's privacy reference).

Deliver: where the owner sees their numbers, what each number means, and — if a consent obligation
exists because a tracking tool was chosen — that it's handled.
