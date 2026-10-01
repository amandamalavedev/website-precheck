# WCAG 2.1 AA — the manual checklist

Automated tools (the `a11y-check.mjs` script) catch roughly a third of issues. These are the ones a
human has to verify. Work through them on every key page and state (menus open, modals, form errors).

## Keyboard (no mouse)

- [ ] Tab reaches **every** interactive control, in an order that matches the visual layout.
- [ ] Every focused element has a **clearly visible focus indicator** (don't `outline: none` without a
      replacement).
- [ ] No keyboard trap — you can tab out of every widget, menu and modal.
- [ ] Menus, dropdowns, modals open, operate and **close with the keyboard** (Esc closes a modal).
- [ ] Skip-to-content link for pages with lots of nav (nice to have).

## Colour & contrast (check light AND dark themes)

- [ ] Body text ≥ **4.5:1** against its background.
- [ ] Large text (≥ 24px, or ≥ 19px bold) ≥ **3:1**.
- [ ] UI components and meaningful graphics (icons, form borders, focus ring) ≥ **3:1**.
- [ ] Information is never carried by colour alone (an error isn't only red — it has text/an icon).

## Structure & semantics

- [ ] Exactly one `<h1>`; headings descend without skipping (h1→h2→h3).
- [ ] Landmarks present: `<header> <nav> <main> <footer>` (or ARIA roles).
- [ ] `<html lang="en">` (or the real language) set.
- [ ] Every input has a programmatically associated `<label>` (not just a placeholder).
- [ ] Buttons are `<button>`, links are `<a href>` — not divs with click handlers.
- [ ] Tables use `<th>` with scope; lists use list markup.

## Images & media

- [ ] Meaningful images have descriptive `alt`; decorative images have `alt=""`.
- [ ] Video has captions; audio has a transcript (if you have any).
- [ ] No auto-playing sound.

## Motion, zoom, reflow

- [ ] `prefers-reduced-motion` honoured — animations off/reduced when the OS asks.
- [ ] Usable at **200% browser zoom** and down to **320px** width with no horizontal scroll and
      nothing clipped.
- [ ] Nothing flashes more than 3×/second.

## Forms

- [ ] Errors are described in **text** next to the field, not colour alone, and announced.
- [ ] Required fields are marked in text/aria, not only visually.
- [ ] Labels and instructions are available before the field, not only as a disappearing placeholder.

## Screen reader (a quick pass goes a long way)

- [ ] Turn on VoiceOver (Mac) / NVDA (Windows) and tab through the main flow: names make sense,
      buttons announce their purpose, images read their alt, form errors are announced.

Report honestly: list what you verified. "0 automated violations; keyboard, contrast and headings
verified manually" is a real claim. "Fully accessible" on a tool's say-so is not.
