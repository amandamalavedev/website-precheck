---
name: accessibility-launch-readiness
description: >-
  The final gate before a site goes live: a WCAG 2.1 AA accessibility pass (contrast, keyboard, focus,
  labels, alt text, headings, landmarks — real US ADA exposure) plus the pre-launch QA checklist
  (forms submit, 404 page, favicon, meta/Open Graph present, HTTPS redirect, no console errors, works
  on a phone). Use this whenever the user is about to launch a site, asks "is this ready to go live",
  wants an accessibility / a11y / WCAG / ADA check, asks about screen-reader or keyboard support or
  colour contrast, or wants a pre-launch QA / final review of a website. Runs real automated checks
  with a browser, not just a reasoned opinion. Applies to every site, public or private.
---

# Accessibility + launch readiness

The last gate. An inaccessible site excludes real users and carries genuine US legal exposure (ADA
Title III web claims are common); a site that launches with a broken form or a missing 404 looks
unfinished. This skill runs the real checks and walks the final list. Applies to **every** site.

## Accessibility: WCAG 2.1 AA

Run automated checks first (they catch ~30-50% of issues cheaply), then the manual checks that tools
can't (automation never confirms a site is *fully* accessible — it confirms specific failures).

- **Automated:** `scripts/a11y-check.mjs <url>` drives headless Chrome, injects axe-core, and reports
  violations by severity with the offending elements and how to fix each. Run it against every key
  page/state. (Lighthouse's accessibility category via the hardening skill's `lighthouse.mjs
  --categories accessibility` is a lighter second opinion.)
- **Manual — the checks automation misses** (`references/wcag-checklist.md` has the full list):
  - **Keyboard only:** tab through the whole page — every control reachable, in a sensible order, with
    a **visible focus ring**; no trap; menus/modals operable and dismissible with the keyboard.
  - **Contrast:** text ≥ 4.5:1 (≥ 3:1 for large text and UI components). Check your theme tokens in
    both light and dark.
  - **Images:** every meaningful image has real `alt`; decorative images have empty `alt=""`.
  - **Structure:** one `<h1>`, headings don't skip levels, landmarks (`<header> <nav> <main>
    <footer>`), labels tied to inputs, language set (`<html lang>`).
  - **Motion/zoom:** honour `prefers-reduced-motion`; page works at 200% zoom and reflows at narrow
    widths without horizontal scroll.
  - **Forms:** errors announced and described in text, not colour alone; required fields marked.

Fix, then re-run the automated check to confirm the violation count dropped. Report honestly: "axe
found 0 violations and I verified keyboard, contrast and headings manually" — never "it's fully
accessible" on the basis of a tool alone.

## Launch readiness QA

The pre-launch sweep — `references/launch-checklist.md` for the full list. The essentials:

- **Serving:** HTTPS with HTTP→HTTPS redirect; a real **404 page**; a `favicon`; correct
  `Content-Type`s; no mixed content.
- **Metadata:** `<title>` and `<meta description>` on every page; Open Graph tags (share a link into a
  chat and confirm the preview); canonical URL. (Depth: the seo-geo-schema skill.)
- **Function:** every form submits and validates; every nav link works; no dead buttons; the admin
  page works and is gated.
- **Clean:** no console errors or 404s in the network tab on load; images sized (no layout shift).
- **Responsive:** real check at phone width — no horizontal scroll, tap targets ≥ 44px, text legible.
- **Profile-correct:** public site is indexable with a sitemap; private site is `noindex` + crawler-
  blocked. Cross-check against the Website Build Standard's two profiles.
- **Resilience & privacy** are the hardening skill's gates — confirm they're green too (backups,
  graceful shutdown, security headers, privacy notice) before calling it launched.

## Workflow

1. Run `scripts/a11y-check.mjs` on every key page; triage violations by severity.
2. Do the manual keyboard/contrast/structure pass.
3. Walk the launch checklist in a real browser, desktop and phone.
4. Fix, re-run the automated checks, and give the owner a short go/no-go with what's green and any
   accepted risks.

Nothing is "launched" until it's been checked against the live site, not just locally.
