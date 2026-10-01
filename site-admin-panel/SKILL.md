---
name: site-admin-panel
description: >-
  Build or extend the auth-gated ADMIN PAGE that every site needs — the private back office where the
  owner edits site content, uploads and replaces pictures/media, views visitor analytics, and manages
  officer/user accounts. Use this whenever the user wants a way to update their website without
  redeploying, an admin/dashboard/back-office/CMS page, the ability to change text or swap photos on a
  live site, an image/media upload flow, a place to see their site's analytics, or user/login
  management for a site. Pairs with site-hardening-and-speed (which supplies the session/CSRF auth the
  admin page sits behind) — reach for this for the "let me run my site" half of a build.
---

# The reusable admin page

Every site the owner runs needs one private page to change content, swap images, read analytics, and
manage who can sign in — without a developer and without a redeploy. This is that pattern, proven on
a live Express + static-site + React build. Adapt the framework; keep the shape.

## Non-negotiable: it sits behind the hardening skill's auth

The admin page is the highest-value target on the site. **Before building any of it, put it behind
the session/CSRF gate from `site-hardening-and-speed`** (`references/security-audit.md` §3): HttpOnly
session cookie, CSRF on every write, idle + absolute timeouts, and — critically — serve the admin
*app code itself* only to a signed-in user, so an outsider gets a tiny login page and a 401 for
everything else. An admin page that leaks its own bundle leaks how to attack it.

Guards: `requireAdminSession` for destructive/owner actions (user management, deletes, config),
`requireAnySession` for routine editing an ordinary officer may do (upload a photo, edit copy).

## The four jobs

Read `references/admin-patterns.md` for the concrete server + client patterns for each. Build only the
jobs the site needs — a brochure site may want content + media + analytics and no user management.

1. **Edit content.** Named editable regions on the live page map to a content store (one JSON file);
   saving writes the store and re-renders the static page. Numbers/data stay out of hand-editing —
   they come from their source of truth.
2. **Upload & replace pictures/media.** Fixed named "slots" on the page; upload re-encodes to WebP,
   strips EXIF/GPS, caps dimensions, replaces the old file. The owner never touches a filename.
3. **See analytics.** A read-only view of the site's own visit data (see the companion
   `analytics-and-search-console` skill for the privacy-respecting collection side).
4. **Manage users.** Add/deactivate officers, reset passcodes, revoke sessions, a panic "sign
   everyone out". All `requireAdminSession`.

## Principles that keep it safe and usable

- **Save writes to the live site immediately, but safely.** Use the atomic write (temp-file +
  rename) and daily snapshots from the hardening skill — a half-saved content store must never blank
  the site.
- **Separate "editor" from "owner".** Media/picture upload can be any-officer; rewriting copy, user
  management and config are admin-only. Pass the real `isAdmin` to the component and gate the
  owner-only panels on it — a common bug is mounting the editor without the admin flag so the owner's
  own tools silently vanish.
- **Validate uploads server-side.** Allow-list the MIME types, cap the size and dimensions, re-encode
  (never trust the client's claimed type), and store under a server-generated name. Strip metadata.
- **Show the owner plain language.** "Upload a picture", "Change the wording", "See who visited" —
  not "content store", "slot id", "pipeline version". The labels are UI copy, not internals.
- **Every edit is logged and reversible.** The daily snapshot is the undo; a change log of who
  edited what and when is cheap and worth it.

## Workflow

1. Confirm the stack and that the hardening auth is in place (or build it first).
2. Decide which of the four jobs this site needs.
3. Build server endpoints (guarded) + the admin UI panels from `references/admin-patterns.md`.
4. Test as an outsider (every admin route 401 with no cookie), then signed-in (each job works,
   owner-only panels appear only for admins), in a real browser.
5. Confirm a save survives a restart (atomic write) and that a bad upload is rejected.

Deliver: what the owner can now do themselves, and the one-line "here's your admin page, here's how
you sign in" — never the session passcode in writing.
