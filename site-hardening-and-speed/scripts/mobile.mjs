// Mobile readiness: load the page as a phone does and measure what a phone user actually hits.
// Usage:  node mobile.mjs <url> [--allow-private]
//
//   viewport   a <meta name="viewport" content="width=device-width…"> tag (without it phones zoom out)
//   overflow   nothing wider than the screen (sideways scrolling), with the elements that stick out
//   tap        buttons/links at least 24×24 CSS px (WCAG 2.2 target size), with the ones that aren't
//   text       body text at least 12px, with the elements that are smaller
//
// Same safety as a11y.mjs: Chrome sandbox on, and every request (redirects and subresources too) is
// checked against private/internal addresses before the browser may make it (F2).
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { assertSafeUrl, sandboxOptIn, flag, hostIsPublic } from "./safe.mjs";

const requireHere = createRequire(import.meta.url);
const requireCwd = createRequire(pathToFileURL(join(process.cwd(), "resolve-from-here.js")));
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 website-precheck/1.0";

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const fs = requireHere("node:fs");
  return ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium",
  ].find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

export async function checkMobile(rawUrl, { allowPrivate = false, wait = 1500 } = {}) {
  const url = await assertSafeUrl(rawUrl, { allowPrivate });
  let puppeteer;
  for (const r of [requireHere, requireCwd]) { try { puppeteer = r("puppeteer-core"); break; } catch { /* next */ } }
  if (!puppeteer) throw new Error("puppeteer-core not found. Run: npm install puppeteer-core");
  const exe = findChrome();
  if (!exe) throw new Error("Chrome not found. Set CHROME_PATH to the Chrome executable.");

  const launchArgs = ["--disable-gpu", ...(sandboxOptIn(allowPrivate ? ["--no-sandbox"] : []) ? ["--no-sandbox"] : [])];
  const browser = await puppeteer.launch({ executablePath: exe, headless: "new", args: launchArgs });
  try {
    const page = await browser.newPage();
    await page.setViewport(PHONE);
    await page.setUserAgent(PHONE_UA);
    if (!allowPrivate) {
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        (async () => {
          const u = req.url();
          if (!/^https?:/i.test(u)) { try { req.continue(); } catch { /* handled */ } return; }
          let allow = false;
          try { allow = await hostIsPublic(new URL(u).hostname); } catch { allow = false; }
          try { allow ? req.continue() : req.abort("addressunreachable"); } catch { /* handled */ }
        })().catch(() => {});
      });
    }
    try { await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 }); }
    catch (e) { throw new Error("Could not load " + url + ": " + e.message); }
    await new Promise((r) => setTimeout(r, wait));

    const m = await page.evaluate(() => {
      const W = window.innerWidth;
      // A selector that points at THIS element only — never a bare "a" or "span", which pasted into a
      // stylesheet would restyle every link or span on the site.
      const sel = (el) => {
        const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
        const own = (e) => {
          if (e.id) return `#${esc(e.id)}`;
          const tag = e.tagName.toLowerCase();
          const cls = [...e.classList].slice(0, 2).map((c) => "." + esc(c)).join("");
          const href = tag === "a" && e.getAttribute("href") ? `[href="${e.getAttribute("href").replace(/"/g, '\\"')}"]` : "";
          return tag + cls + href;
        };
        let s = own(el);
        if (s.startsWith("#")) return s;
        // add ancestors until the selector matches just this element (max 3 levels)
        let p = el.parentElement, depth = 0;
        while (p && p !== document.body && depth < 3 && document.querySelectorAll(s).length > 1) {
          s = `${own(p)} > ${s}`;
          if (s.startsWith("#")) break;
          p = p.parentElement; depth++;
        }
        return s;
      };
      const snip = (el) => el.outerHTML.replace(/\s+/g, " ").slice(0, 120);
      const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"; };

      const vp = document.querySelector('meta[name="viewport"]');
      const vpContent = vp ? vp.getAttribute("content") || "" : null;

      const scrollW = document.documentElement.scrollWidth;
      const wide = [];
      if (scrollW > W + 1) {
        for (const el of document.body.querySelectorAll("*")) {
          if (!visible(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.right > W + 1 && getComputedStyle(el).position !== "fixed") {
            // report the outermost offender, not every child inside it
            if (!wide.some((w) => w.el.contains(el))) wide.push({ el, width: Math.round(r.width), right: Math.round(r.right) });
          }
          if (wide.length >= 6) break;
        }
      }

      const small = [];
      let tapTotal = 0;
      for (const el of document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [onclick]')) {
        if (!visible(el)) continue;
        tapTotal++;
        const r = el.getBoundingClientRect();
        // inline links inside a sentence are exempt from the size rule (WCAG 2.5.8 "inline" exception)
        const inline = el.tagName === "A" && getComputedStyle(el).display === "inline" && el.parentElement && /\S/.test(el.parentElement.textContent.replace(el.textContent, ""));
        if (!inline && (r.width < 24 || r.height < 24) && small.length < 8) small.push({ el, w: Math.round(r.width), h: Math.round(r.height) });
      }

      const tiny = [];
      let textNodes = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const seen = new Set();
      while (walker.nextNode()) {
        const t = walker.currentNode;
        if (!t.textContent.trim() || t.textContent.trim().length < 3) continue;
        const el = t.parentElement;
        if (!el || seen.has(el) || !visible(el)) continue;
        seen.add(el); textNodes++;
        const px = parseFloat(getComputedStyle(el).fontSize);
        if (px < 12 && tiny.length < 8) tiny.push({ el, px: Math.round(px * 10) / 10, text: t.textContent.trim().slice(0, 50) });
      }

      return {
        screen: `${W}×${window.innerHeight}`,
        viewport: vpContent,
        overflow: { scrollWidth: scrollW, screenWidth: W, elements: wide.map((w) => ({ selector: sel(w.el), html: snip(w.el), width: w.width, right: w.right })) },
        tap: { checked: tapTotal, small: small.map((s) => ({ selector: sel(s.el), html: snip(s.el), w: s.w, h: s.h })) },
        text: { checked: textNodes, tiny: tiny.map((s) => ({ selector: sel(s.el), px: s.px, text: s.text })) },
      };
    });

    const viewportOk = !!m.viewport && /width\s*=\s*device-width/i.test(m.viewport) && !/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test(m.viewport);
    const checks = {
      viewport: { ok: viewportOk, value: m.viewport, zoomBlocked: !!m.viewport && /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test(m.viewport) },
      overflow: { ok: m.overflow.scrollWidth <= m.overflow.screenWidth + 1, ...m.overflow },
      tap: { ok: m.tap.small.length === 0, ...m.tap },
      text: { ok: m.text.tiny.length === 0, ...m.text },
    };
    const passed = Object.values(checks).filter((c) => c.ok).length;
    return { url, screen: m.screen, device: "Phone, 390×844 (iPhone-size), touch", checks, score: Math.round((passed / 4) * 100) };
  } finally {
    await browser.close();
  }
}

// ---- CLI wrapper ----
const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] || "").href; } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  const rawUrl = args.find((a) => /^[a-z][a-z0-9+.-]+:\/\//i.test(a));
  if (!rawUrl) { console.error("Usage: node mobile.mjs <url> [--allow-private]"); process.exit(2); }
  if (!/^https?:\/\//i.test(rawUrl)) { console.error(`Refused: only http:// and https:// URLs can be checked (got "${rawUrl.split(":")[0]}:").`); process.exit(2); }
  let r;
  try { r = await checkMobile(rawUrl, { allowPrivate: flag(args, "allow-private") }); }
  catch (e) { console.error(/private|local/i.test(e.message) ? "Refused: " + e.message : e.message); process.exit(/private|local/i.test(e.message) ? 2 : 1); }
  const c = r.checks;
  console.log(`\n=== Mobile readiness · ${r.url} · ${r.device} — ${r.score}/100 ===\n`);
  console.log(`${c.viewport.ok ? "PASS" : "FAIL"}  Viewport tag: ${c.viewport.value ?? "missing"}${c.viewport.zoomBlocked ? "  (blocks pinch-zoom)" : ""}`);
  console.log(`${c.overflow.ok ? "PASS" : "FAIL"}  No sideways scrolling: page is ${c.overflow.scrollWidth}px wide on a ${c.overflow.screenWidth}px screen`);
  for (const e of c.overflow.elements) console.log(`        ${e.selector} sticks out to ${e.right}px — ${e.html}`);
  console.log(`${c.tap.ok ? "PASS" : "FAIL"}  Tap targets ≥ 24×24px: ${c.tap.small.length} too small (of ${c.tap.checked})`);
  for (const e of c.tap.small) console.log(`        ${e.selector} is ${e.w}×${e.h}px — ${e.html}`);
  console.log(`${c.text.ok ? "PASS" : "FAIL"}  Text ≥ 12px: ${c.text.tiny.length} too small`);
  for (const e of c.text.tiny) console.log(`        ${e.selector} is ${e.px}px — "${e.text}"`);
}
