# Pre-launch QA checklist

The final sweep in a real browser, desktop and phone, against the **live** (or production-built) site
— not just the dev server. Check the box only when you've actually seen it work.

## Serving & security basics

- [ ] **HTTPS** works, and HTTP redirects to HTTPS (no mixed-content warnings).
- [ ] A real, styled **404 page** for unknown URLs (not a raw server error).
- [ ] A **favicon** shows in the tab.
- [ ] Correct `Content-Type` on everything; no asset 404s in the network tab on load.
- [ ] Security headers present (CSP, HSTS, nosniff, frame, referrer, permissions) and `x-powered-by`
      off — the hardening skill owns these; confirm they're live.

## Metadata & sharing

- [ ] `<title>` and `<meta name="description">` on every page, specific and honest.
- [ ] **Open Graph** tags present — actually share a link into WhatsApp/Slack and confirm the preview
      shows a title, image and summary (not a bare URL).
- [ ] `<link rel="canonical">` correct. (Depth → seo-geo-schema skill.)

## Function

- [ ] Every **form** submits, validates, shows success and error states, and the data arrives where
      it should.
- [ ] Every nav link and button does something — no dead ends, no `href="#"` that goes nowhere.
- [ ] The **admin page** works and is gated (outsider gets the login, not the app).
- [ ] Search, filters, any interactive widget work with real content.

## Performance & polish

- [ ] **Lighthouse mobile ≥ 90** (the speed skill) — run it on production.
- [ ] Images sized with width/height so there's no layout shift (CLS ~0).
- [ ] No console errors on load.

## Responsive

- [ ] Real check at **~390px phone width**: no horizontal scroll, tap targets ≥ 44px, text legible,
      menus work, images fit.
- [ ] Check one mid (tablet) and one wide width too.

## Content integrity

- [ ] No lorem ipsum, no placeholder images, no "TODO", no dead "coming soon" links left in.
- [ ] Real contact details; they work (the email/number is correct).
- [ ] Every factual claim and number is true and, where it matters, sourced.

## Profile correctness (cross-check the Website Build Standard)

- [ ] **Public site:** indexable (`index,follow`), `sitemap.xml` and `robots.txt` served, Search
      Console verified, analytics recording.
- [ ] **Private site:** `noindex,nofollow`, robots `Disallow: /`, crawlers denied, no public
      analytics, no Search Console. The admin/gated area returns the login to outsiders.

## Resilience (hardening skill — confirm green)

- [ ] Data writes are atomic; graceful shutdown handled (no "crashed" on deploy).
- [ ] Daily encrypted backups running, with an off-site copy.
- [ ] Privacy notice matches what the site actually collects.

## Go / no-go

Give the owner a short verdict: what's green, any accepted risks (with the reason), and the few things
only they can still do (DNS, 2FA, add an env secret, legal sign-off). Don't call it launched on
anything you verified only locally.
