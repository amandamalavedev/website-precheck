#!/usr/bin/env node
// Monthly standards watch (run by .github/workflows/standards-watch.yml, or by hand: node scripts/standards-watch.mjs).
// The report tells readers which published standards and laws it checks against (lib/standards.mjs). This
// keeps that honest over time: it re-opens every one of those links, notices when a page changed or broke
// since last month, checks whether the engines the checks run on (Lighthouse, axe-core) have new releases,
// and writes a review list. The workflow turns that list into a GitHub issue — the monthly to-do for
// updating the checks — and saves the new snapshot so next month compares against this one.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STANDARDS, STANDARDS_CHECKED_ON } from "../lib/standards.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = join(ROOT, ".github", "standards-snapshot.json");
const OUT = process.argv[2] || join(ROOT, "standards-review.md");
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "accept-language": "en-US,en;q=0.9" };

// The readable text of a page, so a changed ad or script tag doesn't count as a change to the standard.
const textOf = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

// Bot filters differ by site (ftc.gov refused one browser-like header set, w3.org the other), so a 401/403
// is retried with the other; if both are refused the page is listed "open by hand", not "broken".
const HEADER_SETS = [UA, { "user-agent": "Mozilla/5.0 Chrome/120" }];
async function check(url) {
  let last = { status: 0, error: "not fetched" };
  for (const headers of HEADER_SETS) {
    try {
      const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(30_000) });
      const body = await res.text();
      if (res.status === 401 || res.status === 403) { last = { status: res.status, blocked: true }; continue; }
      const text = textOf(body);
      // one short fingerprint per sentence, so a rotating banner or date doesn't count as the standard changing
      const sentences = [...new Set(text.split(/(?<=[.!?])\s+/).filter((x) => x.length > 40).map((x) => createHash("sha256").update(x).digest("hex").slice(0, 10)))];
      return { status: res.status, finalUrl: res.url, words: text.split(" ").length, sentences };
    } catch (e) { last = { status: 0, error: e.message }; }
  }
  return last;
}

async function latest(pkg) {
  try { return (await (await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(20_000) })).json()).version; } catch { return null; }
}

const before = existsSync(SNAP) ? JSON.parse(readFileSync(SNAP, "utf8")) : { pages: {} };
const now = { checkedAt: new Date().toISOString(), pages: {} };
const changed = [], broken = [], moved = [], blocked = [], unstable = [];
for (const [section, list] of Object.entries(STANDARDS)) {
  for (const s of list) {
    const r = await check(s.url);
    now.pages[s.url] = { ...r, name: s.name, section };
    const prev = before.pages[s.url];
    if (r.blocked) blocked.push({ ...s, section });
    else if (!r.status || r.status >= 400) broken.push({ ...s, section, r });
    else {
      if (prev?.sentences?.length && r.sentences?.length) {
        const shareBetween = (x, y) => {
          const a = new Set(x), b = new Set(y);
          return ([...a].filter((v) => !b.has(v)).length + [...b].filter((v) => !a.has(v)).length) / (new Set([...a, ...b]).size || 1);
        };
        const share = shareBetween(prev.sentences, r.sentences);
        if (share > 0.03) {
          // Some pages differ between two visits minutes apart (seen on owasp.org) — only a change that a
          // second fetch confirms counts; a page that won't hold still is listed for a look, not as changed.
          const again = await check(s.url);
          if (again.sentences && shareBetween(r.sentences, again.sentences) <= 0.03) changed.push({ ...s, section, words: [prev.words, r.words], share: Math.round(share * 100) });
          else unstable.push({ ...s, section });
        }
      }
      const bare = (u) => u.split(/[?#]/)[0].replace(/\/$/, "");
      if (r.finalUrl && bare(r.finalUrl) !== bare(s.url) && r.finalUrl !== prev?.finalUrl) moved.push({ ...s, section, to: r.finalUrl });
    }
  }
}

// The engines the checks run on — a new major version can change scores or add rules.
const a11ySrc = readFileSync(join(ROOT, "lib", "a11y.mjs"), "utf8");
const lhSrc = readFileSync(join(ROOT, "lib", "lighthouse.mjs"), "utf8");
const pinned = { "axe-core": /axe-core\/([\d.]+)\//.exec(a11ySrc)?.[1], lighthouse: /lighthouse@(\d+)/.exec(lhSrc)?.[1] };
const engines = [];
for (const [pkg, have] of Object.entries(pinned)) {
  const got = await latest(pkg);
  if (got && have && got.split(".")[0] !== have.split(".")[0]) engines.push(`**${pkg}**: we use ${have}, latest is ${got} — a new major version; check what changed in its scoring/rules.`);
  else if (got && have && got !== have && pkg === "axe-core") engines.push(`**${pkg}**: we use ${have}, latest is ${got} — update the pinned version in lib/a11y.mjs once cdnjs carries it (https://cdnjs.com/libraries/axe-core) — new rules usually arrive in minor versions.`);
}

const firstRun = !Object.keys(before.pages).length;
const month = new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
const lines = [
  `Standards and dependencies review for **${month}**. Standards list last confirmed: ${STANDARDS_CHECKED_ON} (lib/standards.mjs).`, "",
  firstRun ? "_First run: this records the baseline. From next month, pages that changed are listed here._" : "",
  "## Links that are broken", "", ...(broken.length ? broken.map((b) => `- [ ] ${b.section}: [${b.name}](${b.url}) — ${b.r.status ? `HTTP ${b.r.status}` : b.r.error}. Find the new address and update lib/standards.mjs.`) : ["None."]), "",
  "## Standards pages that changed since last month", "",
  ...(changed.length ? changed.map((c) => `- [ ] ${c.section}: [${c.name}](${c.url}) (about ${c.share}% of its sentences changed; ${c.words[0]} → ${c.words[1]} words). Read what changed; if it affects a check (${c.covers}), update the check and its wording.`) : [firstRun ? "Baseline recorded." : "None."]), "",
  ...(unstable.length ? ["## Pages whose text varies between visits — skim by hand", "", ...unstable.map((u) => `- [ ] ${u.section}: [${u.name}](${u.url})`), ""] : []),
  ...(blocked.length ? ["## Sites that refused the automated check — open these by hand", "", ...blocked.map((b) => `- [ ] ${b.section}: [${b.name}](${b.url}) — the site blocks automated requests; open it in a browser and skim for changes.`), ""] : []),
  ...(moved.length ? ["## Links that now redirect", "", ...moved.map((m) => `- [ ] ${m.section}: [${m.name}](${m.url}) now goes to ${m.to} — update the link.`), ""] : []),
  "## Check engines", "", ...(engines.length ? engines.map((e) => `- [ ] ${e}`) : ["Lighthouse and axe-core are current."]), "",
  "## Every month, also check", "",
  "- [ ] New US state privacy laws in force this month (IAPP tracker in lib/standards.mjs) — does the Privacy best practice still hold?",
  "- [ ] New WCAG version or W3C recommendation (WCAG 2.2 is current as of the standards date)",
  "- [ ] New security headers or changed recommendations in the OWASP Secure Headers Project",
  "- [ ] Major browser changes to cookies (third-party cookie rules, SameSite defaults)",
  "- [ ] New kinds of leaked keys worth detecting (new AI/API providers' key formats) — add them to SECRET in lib/specifics.mjs",
  "- [ ] When anything above changes: update the check, update STANDARDS_CHECKED_ON, run the tests, and note it in the commit.",
].filter((l) => l !== "");
writeFileSync(OUT, lines.join("\n") + "\n");
mkdirSync(dirname(SNAP), { recursive: true });
writeFileSync(SNAP, JSON.stringify(now, null, 2) + "\n");
console.log(lines.join("\n"));
console.log(`\nblocked=${blocked.length} broken=${broken.length} changed=${changed.length} moved=${moved.length} engines=${engines.length}`);
