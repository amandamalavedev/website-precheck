# Admin page patterns (server + client)

Concrete, proven patterns. Stack here is Express + a static public site + a React admin SPA, data in
JSON files, host redeploys on git push. Translate the shape to other stacks.

## Editing content

**The model:** the live page has named editable regions; a content store holds the overrides; a build
step renders the store into the served page. Hand-editing never touches numbers — those come from
their own source.

- Mark each editable region in the page with a stable id and an edit-path, e.g.
  `<p id="ed-tagline" data-edit-path="3" data-pg="pidgin fallback">English copy</p>`. The id is the
  anchor; keep it stable across redeploys so saved edits still map.
- **Content store** = one JSON file: `{ edits: { "3": "new copy" }, media: [...], photos: {...} }`.
  Read it, apply overrides at render, write it back on save.
- **Endpoints:**
  `GET /api/site/content` (`requireAnySession`) returns the store;
  `POST /api/site/content` (`requireAdminSession`, copy is the owner's voice) writes an edit and
  re-renders the static page. Re-render in-process so there's no redeploy — the save is live at `/`.
- **Writer-side edit mode** (optional, nice): on the public site itself, gate an "✎ Edit this page"
  toggle behind the same auth so the owner edits in place and sees the result immediately.
- Always write the store atomically (temp-file + rename). A half-written content store read back as
  empty would blank every photo and edit.

## Uploading & replacing pictures/media

**The model:** the page has fixed photo "slots" (hero, portrait, a gallery). Upload targets a slot,
re-encodes, strips metadata, replaces the old file, updates the store.

- `POST /api/site/photo?slot=<id>` (`requireAnySession`): validate the slot against an allow-list,
  validate the MIME against an image allow-list (`image/jpeg|png|webp`), stream to disk with a size
  cap (~12 MB), then re-encode:
  ```js
  await sharp(srcPath)
    .rotate()                                   // bake EXIF orientation, THEN drop metadata
    .resize({ width: MAX, height: MAX, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 })
    .toFile(destPath);                           // sharp drops EXIF/GPS by default — verify
  ```
  Store `{ file, alt, mime:"image/webp", bytes, pipelineVersion }` under the slot; delete the
  previous file so the disk doesn't fill.
- `POST /api/site/media` for video/audio: allow-list types, cap size, keep as-is (videos usually
  aren't re-encoded — warn the owner to record with phone location OFF, since you can't strip it here).
- **Alt text** is content, not an afterthought: let the owner set it; fall back to a sensible default,
  not to internal guidance text. Good alt text is required for accessibility and SEO.
- **Pipeline version**: stamp each processed photo with a version number; on boot, re-encode any photo
  below the current version, so a quality/size change reaches photos already live, not just new ones.
- A generated filename (hash/id + `.webp`), never the uploaded name. Serve media with a long
  immutable cache (the filename changes when the picture does).

## Viewing analytics

Read-only panel over the site's own store. Keep collection privacy-respecting (see the
`analytics-and-search-console` skill): count visits without tracking cookies; if you show country,
look it up at request time and keep only the country, never the visitor IP. Admin endpoint
`GET /api/site/analytics` (`requireAdminSession`) returns aggregates (by day, by page, by country, by
referrer/share-channel) plus a "last refreshed" time. Exclude the team's own logged-in traffic from
the counts so the numbers are the public, not you.

## Managing users

All `requireAdminSession`:
- `POST/PUT/DELETE /api/auth/users` — add, edit, deactivate; deactivating revokes live sessions at
  once. Passcodes hashed (scrypt), strength-checked, never returned to the client (show only
  "has passcode").
- `POST /api/auth/revoke` and `/api/auth/revoke-all` — sign one or everyone out (the panic button).
- A sign-in history (who/when/IP/device), persisted to disk so it survives redeploys — invaluable
  after an incident. Note the IP can be forged until a CDN is correctly in front (hardening skill §4).

## Client (admin UI)

- One gated SPA (or page) served only to a signed-in user. On load, call `GET /api/auth/verify`
  (cookie only) and route to the login page if invalid.
- Pass the real, server-computed `isAdmin` into the admin component and gate owner-only panels on it.
  Don't trust a value cached in the browser at first login — recompute it server-side each verify.
- Every write sends the CSRF header read from the JS-readable CSRF cookie.
- Plain-language labels and a visible "saved ✓" / error state on every action. Render any
  user-submitted text as text, never innerHTML.
