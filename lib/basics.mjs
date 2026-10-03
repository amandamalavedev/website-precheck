// Site basics — the things every site should have, which nobody notices until they're missing: links and
// images that work, a certificate that isn't about to expire, a real "not found" page, a favicon, a current
// copyright line, a way to reach you, terms when you collect data, a preview card when the link is shared.
// Each item is pass / warn / fail with a plain explanation and, for anything not passing, what to do.
// Read-only GETs of the site's own public pages (and HEAD-style GETs of the files they link to).
import tls from "node:tls";
import { safeFetch, readTextCapped } from "./safe.mjs";

const UA = { "User-Agent": "website-precheck/1.0 (+basics)" };

async function get(url, { allowPrivate, cache, maxBytes = 0 }) {
  const key = `basics|${url}|${maxBytes}`;
  if (cache?.has(key)) return cache.get(key);
  const run = (async () => {
    try {
      const { res, finalUrl } = await safeFetch(url, { allowPrivate, init: { headers: UA } });
      const text = maxBytes && res.status === 200 ? await readTextCapped(res, maxBytes) : "";
      if (!text) { try { await res.body?.cancel(); } catch { /* fine */ } }
      return { status: res.status, finalUrl, type: res.headers.get("content-type") || "", text };
    } catch (e) { return { status: 0, error: e.message }; }
  })();
  cache?.set(key, run);
  return run;
}

/** Days until the site's TLS certificate expires (null if it couldn't be read). */
function certDaysLeft(host) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      const c = sock.getPeerCertificate();
      sock.end();
      resolve(c?.valid_to ? Math.floor((new Date(c.valid_to) - Date.now()) / 86400000) : null);
    });
    sock.on("error", () => resolve(null));
    sock.on("timeout", () => { sock.destroy(); resolve(null); });
  });
}

const text = (html) => String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&copy;/gi, "©").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
const attrOf = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v != null) ?? null;

export async function checkBasics(pageUrl, { allowPrivate = false, cache = null, siteWide = true } = {}) {
  const items = [];
  const item = (id, label, status, detail, where = null, code = null) => items.push({ id, label, status, detail, ...(where ? { where } : {}), ...(code ? { code } : {}) });
  const page = await get(pageUrl, { allowPrivate, cache, maxBytes: 3_000_000 });
  if (!page.text) return { items, title: null };
  const html = page.text;
  const base = page.finalUrl || pageUrl;
  const origin = new URL(base).origin;
  const plain = text(html);
  // a tag can hold ">" inside a quoted attribute (an inline SVG icon does), so quoted values are skipped whole
  const tags = (name) => [...html.matchAll(new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi"))].map((m) => m[0]);
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: attrOf(m[1], "href") || "", label: text(m[2]).trim().toLowerCase() }));
  const abs = (u) => { try { return new URL(u, base); } catch { return null; } };

  // ---- links and images that don't work (this site's own links; images from anywhere)
  const linkTargets = [...new Set(anchors.map((a) => abs(a.href)).filter((u) => u && /^https?:$/.test(u.protocol) && u.origin === origin).map((u) => { u.hash = ""; return u.href; }))].slice(0, 60);
  const imgTargets = [...new Set(tags("img").map((t) => attrOf(t, "src")).filter((s) => s && !/^data:/i.test(s)).map((s) => abs(s)?.href).filter(Boolean))].slice(0, 40);
  // links to OTHER sites too (a private or renamed GitHub repo is a dead end for visitors) — counted only on a
  // clear "not found" (404/410): many sites block automated requests (LinkedIn answers 999, others 403/429)
  const outTargets = [...new Set(anchors.map((a) => abs(a.href)).filter((u) => u && /^https?:$/.test(u.protocol) && u.origin !== origin).map((u) => { u.hash = ""; return u.href; }))].slice(0, 30);
  const broken = [];
  for (const u of linkTargets) { const r = await get(u, { allowPrivate, cache }); if (r.status === 404 || r.status === 410 || r.status >= 500) broken.push({ u, s: r.status, kind: "link" }); }
  for (const u of outTargets) { const r = await get(u, { allowPrivate, cache }); if (r.status === 404 || r.status === 410) broken.push({ u, s: r.status, kind: "outside link" }); }
  for (const u of imgTargets) { const r = await get(u, { allowPrivate, cache }); if (r.status === 404 || r.status === 410 || r.status >= 500 || (r.status === 200 && /text\/html/i.test(r.type))) broken.push({ u, s: r.status, kind: "image" }); }
  const rel = (u) => { try { const x = new URL(u); return x.origin === origin ? x.pathname + x.search : u; } catch { return u; } };
  item("broken-links", "Links and images on the page work", broken.length ? "fail" : "pass",
    broken.length ? `${broken.length} don't work: ${broken.slice(0, 8).map((b) => `${b.kind} ${rel(b.u)} (${b.s === 200 ? "returns a web page, not an image" : "HTTP " + b.s})`).join("; ")}${broken.length > 8 ? " …" : ""}` : `Checked ${linkTargets.length} link${linkTargets.length === 1 ? "" : "s"} to this site, ${outTargets.length} to other sites and ${imgTargets.length} image${imgTargets.length === 1 ? "" : "s"}: all work.`,
    broken.length ? "Fix or remove each one — point the link at the page's current address, or restore the missing file. Moved a page? Redirect the old address so old links and bookmarks still work." : null,
    broken.length && broken.some((b) => b.kind === "link") ? `# _redirects (Netlify) — send each old address to where the page lives now:\n${broken.filter((b) => b.kind === "link").slice(0, 8).map((b) => `${rel(b.u)}  /new-address  301`).join("\n")}` : null);

  // ---- a copyright line, with a sensible year
  const years = [...plain.matchAll(/(?:©|copyright)\s*(?:\(c\)\s*)?((?:19|20)\d{2})(?:\s*[–-]\s*((?:19|20)\d{2}))?/gi)].map((m) => Number(m[2] || m[1]));
  const hasCopyright = /©|copyright/i.test(plain);
  const now = new Date().getFullYear();
  if (!hasCopyright) item("copyright", "A copyright line", "warn", "No copyright line found on the page.", "Add one to the footer, e.g. © " + now + " Your name or organisation. (\"All rights reserved\" is optional.)");
  else if (years.some((y) => y > now)) item("copyright", "A copyright line", "warn", `The copyright year is in the future (${Math.max(...years)}) — it should be the year the content was published.`, `Change it to © ${now} (or a range like © 2024–${now} for older content).`);
  else if (years.length && Math.max(...years) < now - 2) item("copyright", "A copyright line", "warn", `The copyright year (${Math.max(...years)}) makes the site look unmaintained.`, `Update it to © ${Math.max(...years)}–${now}.`);
  else item("copyright", "A copyright line", "pass", years.length ? `© ${Math.max(...years)} found.` : "A copyright line is present.");

  // ---- a way to reach you
  const contact = anchors.find((a) => /^(mailto:|tel:|https?:\/\/(wa\.me|api\.whatsapp\.com)\/)/i.test(a.href) || /contact/i.test(a.href) || /\bcontact\b/.test(a.label));
  item("contact", "A way to contact you", contact ? "pass" : "warn",
    contact ? `Found: ${contact.href.replace(/^mailto:/i, "email ").replace(/\?.*$/, "").slice(0, 80)}` : "No email, phone, WhatsApp or contact-page link on this page.",
    contact ? null : "Link a contact method from the footer of every page — visitors (and anyone reporting a problem) need a way to reach you.");

  // ---- forms: terms of use, and where the data goes
  const forms = tags("form").filter((t) => !/role\s*=\s*["']?search|search/i.test(t));
  const hasInputs = /<(input|textarea|select)\b(?![^>]*type\s*=\s*["']?(search|hidden|submit|button))/i.test(html);
  if (forms.length && hasInputs) {
    const terms = anchors.find((a) => /terms|conditions|\btos\b|terms-of-use|legal/i.test(a.href + " " + a.label));
    item("terms", "Terms of use where visitors submit information", terms ? "pass" : "warn",
      terms ? `Found: ${terms.href.slice(0, 80)}` : "This page has a form but links no terms of use.",
      terms ? null : "Publish short terms of use (what the form is for, what you'll do with the information, how to ask for it to be deleted) and link them next to the form's submit button and in the footer.");
    const external = forms.map((t) => abs(attrOf(t, "action") || "")).filter((u) => u && /^https?:$/.test(u.protocol) && u.origin !== origin).map((u) => u.host);
    if (external.length) item("form-destination", "Forms send data to you, not elsewhere", "warn", `A form on this page sends what visitors type to ${[...new Set(external)].join(", ")}.`, "Name that service in your privacy policy (what it receives and why), or send the form to your own server.");
    const insecure = forms.map((t) => attrOf(t, "action") || "").filter((a) => /^http:\/\//i.test(a));
    if (insecure.length) item("form-https", "Forms submit over HTTPS", "fail", `A form submits over unencrypted http:// (${insecure[0].slice(0, 60)}) — what visitors type can be read in transit.`, "Change the form's action to https://.");
  }

  // ---- accessibility statement
  // a link TO an accessibility statement — not any link whose text happens to mention accessibility
  const a11y = anchors.find((a) => /accessib/i.test(a.href) || /^accessibility( statement| policy)?$|accessibility statement/.test(a.label));
  item("accessibility-statement", "An accessibility statement", a11y ? "pass" : "warn",
    a11y ? `Found: ${a11y.href.slice(0, 80)}` : "No accessibility statement linked.",
    a11y ? null : "Add a short page saying what standard you aim for (WCAG 2.1/2.2 AA), any known gaps, and how to report a barrier — W3C has a free generator — and link it in the footer.");

  // ---- title, description, and the preview card when the link is shared
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").replace(/\s+/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  const metaContent = (prop) => { const t = tags("meta").find((m) => new RegExp(`(?:name|property)\\s*=\\s*["']?${prop}["']?`, "i").test(m)); return t ? (attrOf(t, "content") || "").trim() : ""; };
  const desc = metaContent("description");
  item("title-description", "A page title and description", title && desc ? "pass" : "warn",
    title && desc ? `Title: "${title.slice(0, 70)}"` : !title ? "The page has no <title> — browser tabs and search results show the bare address." : "No meta description — search results and some link previews show random text from the page.",
    title && desc ? null : "Give every page a unique <title> and a one-sentence <meta name=\"description\">.",
    title && desc ? null : `<title>${title || "What this page is · Your site"}</title>\n<meta name="description" content="One sentence saying what this page offers.">`);
  const ogTitle = metaContent("og:title"), ogImage = metaContent("og:image"), ogDesc = metaContent("og:description");
  let ogImageOk = null;
  if (ogImage) { const u = abs(ogImage); const r = u ? await get(u.href, { allowPrivate, cache }) : null; ogImageOk = !!(r && r.status === 200 && !/text\/html/i.test(r.type)); }
  const ogOk = ogTitle && ogImage && ogImageOk;
  item("share-preview", "A preview card when the link is shared (WhatsApp, LinkedIn, X)", ogOk ? "pass" : "warn",
    ogOk ? `Shares show "${ogTitle.slice(0, 60)}" with a picture.` : !ogImage ? "No og:image — a link shared on WhatsApp, LinkedIn or X shows no picture, and gets far fewer clicks." : ogImageOk === false ? `The share picture (${ogImage.slice(0, 70)}) doesn't load.` : "No og:title — shared links show a generic title.",
    ogOk ? null : "Add Open Graph tags in <head>. The image should be an absolute https:// address, about 1200×630px.",
    ogOk ? null : `<meta property="og:title" content="${(ogTitle || title || "Page title").replace(/"/g, "&quot;")}">\n<meta property="og:description" content="${(ogDesc || desc || "One sentence about this page").replace(/"/g, "&quot;")}">\n<meta property="og:image" content="${ogImage && ogImageOk !== false ? ogImage : origin + "/share-image.jpg"}">\n<meta property="og:url" content="${base}">\n<meta name="twitter:card" content="summary_large_image">`);

  // ---- favicon
  const iconTag = tags("link").find((t) => /rel\s*=\s*["']?[^"'>]*\bicon\b/i.test(t));
  const iconHref = iconTag ? attrOf(iconTag, "href") || "" : "";
  const inlineIcon = /^data:image\//i.test(iconHref); // an icon built into the page (e.g. an emoji SVG)
  const iconUrl = inlineIcon ? null : iconTag ? abs(iconHref)?.href : origin + "/favicon.ico";
  const iconRes = iconUrl ? await get(iconUrl, { allowPrivate, cache }) : null;
  const iconOk = inlineIcon || !!(iconRes && iconRes.status === 200 && !/text\/html/i.test(iconRes.type));
  item("favicon", "A favicon (the icon in the browser tab)", iconOk ? "pass" : "warn",
    iconOk ? (inlineIcon ? "An icon is built into the page." : `${rel(iconUrl)} loads.`) : iconTag ? `The icon the page names (${rel(iconUrl)}) doesn't load.` : "No icon declared, and /favicon.ico doesn't exist — tabs and bookmarks show a blank page icon, and browsers log a 404 on every visit.",
    iconOk ? null : "Add favicon.ico (16/32/48px) at the site root and link it from every page.",
    iconOk ? null : `<link rel="icon" href="/favicon.ico" sizes="any">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">`);

  // ---- site-wide (once per site): real "not found" responses, certificate expiry
  if (siteWide) {
    const probe = `${origin}/precheck-missing-${Math.random().toString(36).slice(2, 10)}`;
    const nf = await get(probe, { allowPrivate, cache: null, maxBytes: 20000 });
    if (nf.status) item("not-found", "Missing pages return a real 404", nf.status === 404 || nf.status === 410 ? "pass" : nf.status === 200 ? "warn" : "pass",
      nf.status === 200 ? "An address that doesn't exist returns a normal page (status 200, a \"soft 404\") — search engines index it, and broken links never show up as broken." : `A missing page returns HTTP ${nf.status}.`,
      nf.status === 200 ? "Return status 404 for unknown addresses, with a friendly page that links home. On Netlify: a 404.html in the publish folder; for a single-page app, return 404 from the server for routes it doesn't know." : null);
    if (/^https:/.test(origin)) {
      const days = await certDaysLeft(new URL(origin).hostname);
      if (days != null) item("tls-expiry", "The HTTPS certificate isn't about to expire", days < 7 ? "fail" : days < 21 ? "warn" : "pass",
        days < 0 ? `The certificate EXPIRED ${-days} days ago — browsers show visitors a full-page security warning.` : `The certificate expires in ${days} day${days === 1 ? "" : "s"}.`,
        days < 21 ? "Renew it now. Most hosts (Netlify, Vercel, Cloudflare, Railway) renew automatically — if it's this close, automatic renewal has failed: check the domain's DNS still points at the host." : null);
    }
  }
  return { items, title, description: desc };
}
