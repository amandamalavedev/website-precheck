#!/usr/bin/env node
// Structured data (schema.org / JSON-LD) check: finds every <script type="application/ld+json">
// block on the page, parses it, identifies each object's @type, and scores it against a baseline
// set of recommended properties for that type — not just "is schema present" but "is it actually
// filled in." Malformed JSON-LD is a common real-world bug (a typo'd comma means search engines
// silently ignore the whole block) and is flagged as its own finding, since "present but broken" is
// worse than visibly absent — nobody notices to fix it.
import { pathToFileURL } from "node:url";
import { assertSafeUrl, safeFetch, readTextCapped, flag } from "./safe.mjs";

// The page being scanned is untrusted content — same reasoning as privacy.mjs/media.mjs: cap what
// we scan before running any regex over it.
const MAX_SCAN_CHARS = 2_000_000;

// Baseline recommended properties per common @type — not the full schema.org spec (most properties
// are optional there), but the fields that actually make a block useful for rich results/citation.
// Deliberately conservative: scoring against "recommended," not "required," so a valid-but-minimal
// block still gets Some credit rather than being treated as broken.
const SCHEMA_RULES = {
  Organization: ["name", "url", "logo", "sameAs"],
  LocalBusiness: ["name", "address", "telephone", "url"],
  Person: ["name", "url", "sameAs"],
  Product: ["name", "image", "description", "offers"],
  Article: ["headline", "author", "datePublished", "image"],
  NewsArticle: ["headline", "author", "datePublished", "image"],
  BlogPosting: ["headline", "author", "datePublished", "image"],
  FAQPage: ["mainEntity"],
  BreadcrumbList: ["itemListElement"],
  WebSite: ["name", "url"],
  WebPage: ["name", "description"],
};

function scoreBlock(obj) {
  const type = Array.isArray(obj["@type"]) ? obj["@type"][0] : obj["@type"];
  const rules = type && SCHEMA_RULES[type];
  if (!rules) return { type: type || "(no @type)", recognized: false, score: null, present: [], missing: [] };
  const present = rules.filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== "");
  const missing = rules.filter((k) => !present.includes(k));
  return { type, recognized: true, score: Math.round((present.length / rules.length) * 100), present, missing };
}

// JSON-LD can be one object, an array of objects, or an object with "@graph": [...]. Flatten to a
// list of plain objects with an @type to score individually. Valid JSON that isn't one of those
// shapes — a bare null/number/string, or an "@graph" that isn't an array (object, string) — must not
// throw: a single weird-but-parseable block otherwise aborts the entire SEO check for the page.
function flattenJsonLd(parsed) {
  if (!parsed || typeof parsed !== "object") return [];
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed["@graph"]) ? parsed["@graph"]
    : [parsed];
  return items.filter((it) => it && typeof it === "object" && !Array.isArray(it));
}

export async function checkSchema(rawUrl, { allowPrivate = false } = {}) {
  const url = await assertSafeUrl(rawUrl, { allowPrivate });
  const { res, finalUrl } = await safeFetch(url, { allowPrivate, init: { headers: { "User-Agent": "website-precheck/1.0 (+schema-check)" } } });
  const html = await readTextCapped(res, MAX_SCAN_CHARS);

  const blocks = [];
  let malformed = 0;
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed;
    try { parsed = JSON.parse(m[1]); } catch { malformed++; continue; }
    for (const item of flattenJsonLd(parsed)) blocks.push(scoreBlock(item));
  }

  const overallScore = blocks.length
    ? Math.round(blocks.filter((b) => b.score != null).reduce((s, b) => s + b.score, 0) / (blocks.filter((b) => b.score != null).length || 1))
    : null;

  return { url: finalUrl, hasSchema: blocks.length > 0, blocks, malformed, overallScore };
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] || "").href; } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  const rawUrl = args.find((a) => /^https?:\/\//.test(a));
  if (!rawUrl) { console.error("Usage: node schema.mjs <url> [--allow-private]"); process.exit(2); }
  let r;
  try { r = await checkSchema(rawUrl, { allowPrivate: flag(args, "allow-private") }); }
  catch (e) { console.error(/private|local|valid URL/i.test(e.message) ? "Refused: " + e.message : e.message); process.exit(/private|local|valid URL/i.test(e.message) ? 2 : 1); }
  if (!r.hasSchema) console.log("No structured data (JSON-LD) found on the page.");
  for (const b of r.blocks) {
    if (!b.recognized) { console.log(`${b.type}: not in the scored list`); continue; }
    console.log(`${b.type}: ${b.score}% — present: ${b.present.join(", ") || "(none)"} · missing: ${b.missing.join(", ") || "(none)"}`);
  }
  if (r.malformed) console.log(`${r.malformed} malformed JSON-LD block(s) — invalid JSON, likely ignored by search engines.`);
}
