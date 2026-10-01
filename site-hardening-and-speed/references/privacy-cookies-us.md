# Privacy, data collection & cookies (US)

**This is engineering guidance, not legal advice.** It helps a small site follow the practices US
privacy law generally expects, and write honest notices. For anything real — a campaign, a business
collecting personal data, anyone subject to a specific state law — a lawyer reviews the final notice
and practices. US privacy law is a patchwork (no single federal statute; the FTC polices "unfair or
deceptive" practices; state laws like the CCPA/CPRA in California, plus Virginia, Colorado, and others
apply by residency and thresholds). If the site also serves another jurisdiction, name that law too
(e.g. Nigeria's NDPA 2023, the EU/UK GDPR) — the honest, minimise-and-disclose approach below travels
well across all of them.

## The governing principle: minimise, then disclose what's left

The strongest privacy posture is to **collect as little as possible**, so there's little to disclose,
little to leak, and little to argue about. Before adding any field or tracker, ask "do we actually
use this?" Drop what you don't.

Then — and this is the FTC line that actually bites — **do what your notice says and say what you
do.** A deceptive privacy claim is the violation. So the notice must match reality:

- Don't claim "we never store your IP" if the host's logs capture it. Say what you control.
- Don't claim certification or compliance you don't have. "We handle data in line with [law]" is
  honest; "certified compliant" (without certification) is not.
- Remove promises you can't fully control ("stored only on this server", "we never share") if a
  hosting provider, analytics, or legal duty could break them. Disclose the hosting provider as a
  processor acting on your behalf, and the "where the law requires" exception.
- Strip claims about things you can't verify or that aren't true for this build (e.g. a boilerplate
  "no geolocation" line when you do a coarse country lookup — either stop doing it or describe it
  plainly).

## What to inventory first

List, from the actual code, everything the site **collects** and everything it **sets in the
browser**:

- Form fields saved (name, phone, email, location, free-text notes).
- Server-side logs that capture personal data (IP addresses, user agents) — including the host's own
  logs you don't control.
- Any analytics: what's recorded per visit (page, timestamp, referrer, country, IP?). Prefer
  aggregate, IP-less counting; if you look up country, do it at request time and keep only the
  country, never the IP.
- Cookies and browser storage: name, purpose, lifetime, and category (below).

The notice is written from this inventory, not from a template.

## Cookies: categories and the US consent reality

Categorise every cookie/storage item:

- **Strictly necessary** — session auth cookie, CSRF cookie, a load-balancer cookie. Required for the
  site to work. No consent needed anywhere; still disclose them.
- **Functional** — remembering a language/theme/UI choice.
- **Analytics/performance** — usage measurement.
- **Advertising/targeting** — cross-site tracking, ad pixels.

US reality (differs from the EU's prior-consent regime):
- There is **no general US law requiring a cookie-consent banner** for first-party, non-tracking
  cookies. A site that sets only strictly-necessary cookies and no third-party trackers generally
  needs a clear privacy notice, not a consent wall.
- Where US law engages is **"sale"/"sharing" of personal information and targeted advertising** under
  state laws (CCPA/CPRA et al.): those require a visible **"Do Not Sell or Share My Personal
  Information"** choice and honouring the **Global Privacy Control** browser signal — *if* you do that
  kind of sharing. The cleanest compliance is **not to do cross-site tracking at all**: then there's
  nothing to opt out of.
- So the best pattern for a small first-party site: **set no advertising/third-party cookies**, use
  no third-party analytics that track across sites, and you avoid the banner-and-opt-out machinery
  entirely. Say exactly that in the notice ("this site uses no advertising or tracking cookies").

**If you must load trackers or set advertising cookies**, then you need a real consent mechanism:
non-essential cookies load **only after** opt-in, a banner with clear Accept/Reject (reject as easy as
accept — no dark patterns), a stored, revisitable choice, a "Do Not Sell/Share" link, and GPC
honoured. Build it so non-essential scripts are gated behind the stored consent, defaulting to off.
Don't ship a banner that sets the cookies before the user chooses — that's the deceptive pattern
regulators target.

## A compliant privacy notice (structure)

Write it in plain language, matched to the inventory:

1. **What we collect** — the actual fields and logs, nothing aspirational.
2. **Why** — the specific purpose for each (minimisation shows here).
3. **Who it's shared with** — "only [org]", plus processors you rely on (the hosting provider stores
   it on our behalf), plus "where the law requires". Name third parties honestly or state there are
   none.
4. **Cookies/storage** — the categories you actually use; state plainly if there's no advertising or
   cross-site tracking.
5. **Your rights** — how to see, correct, and delete their data; give a working route (a form or an
   email). Verify identity before acting on a deletion so one person can't erase another's data by
   guessing an identifier.
6. **Retention** — how long you keep it and what triggers deletion (e.g. delete the list after the
   campaign/event).
7. **The law you follow** — name it ("handled as required by [CCPA / NDPA 2023 / …]") without
   claiming certification, and the regulator to contact.
8. **Contact** — a real address for privacy questions.

Put a short honest version in the footer and the full version on a dedicated section/page; keep the
two consistent.

## Data-subject requests (access / correction / deletion)

Even without a banner, give people a real way to exercise rights:

- A visible deletion/correction request path (form or email).
- **Identity verification before deletion** — a human confirms the match, nothing auto-deletes on an
  unverified request, so a stranger can't erase someone by typing their number.
- A stated turnaround.
- Server-side: deletion should actually remove the record (and ideally the backups on their next
  rotation), not just hide it.

## Quick audit checklist

- [ ] Collect only fields you use; drop the rest.
- [ ] Notice matches reality — no unverifiable or contradicted claims; hosting provider disclosed.
- [ ] No advertising/third-party tracking cookies (or a proper consent gate if there are).
- [ ] Session/CSRF cookies disclosed as strictly necessary.
- [ ] Analytics are aggregate/IP-less, or the IP handling is described honestly.
- [ ] Working access/correction/deletion path, with identity verification before deletion.
- [ ] Retention stated; deletion actually deletes.
- [ ] The law(s) you follow named without overclaiming; regulator named.
- [ ] Footer short-form and full notice are consistent.
- [ ] A lawyer reviews before launch for anything real.
