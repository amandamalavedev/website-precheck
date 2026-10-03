// The published standards and laws each report section checks against — shown in every report with links,
// so a reader can see exactly what "passing" meant on the day it ran. Standards change: the monthly
// standards-watch workflow (.github/workflows/standards-watch.yml) re-checks every link here and opens an
// issue when one changes or breaks, so this list — and the checks behind it — get reviewed, not forgotten.
// Every link was opened and confirmed on STANDARDS_CHECKED_ON.

export const STANDARDS_CHECKED_ON = "2026-10-02";

export const STANDARDS = {
  Security: [
    { name: "OWASP Secure Headers Project", url: "https://owasp.org/projects/secure-headers-project", covers: "which security headers to send and their recommended values" },
    { name: "OWASP HTTP Headers Cheat Sheet", url: "https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html", covers: "CSP, HSTS, X-Frame-Options, nosniff, Referrer- and Permissions-Policy" },
    { name: "MDN — Content Security Policy", url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP", covers: "how the policy built for your site works" },
    { name: "MDN — Strict-Transport-Security", url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Strict-Transport-Security", covers: "HSTS and the max-age we expect" },
    { name: "OWASP Secrets Management Cheat Sheet", url: "https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html", covers: "keeping API keys and passwords out of code visitors download" },
    { name: "OWASP Top 10", url: "https://top10.owasp.org/", covers: "the most common web application risks (misconfiguration, exposed data)" },
    { name: "RFC 9116 — security.txt", url: "https://www.rfc-editor.org/info/rfc9116/", covers: "the security contact file" },
  ],
  Governance: [
    { name: "MDN — Set-Cookie", url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie", covers: "the Secure, SameSite and HttpOnly attributes" },
    { name: "OWASP Session Management Cheat Sheet", url: "https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html", covers: "how sign-in and session cookies should be set" },
    { name: "UK ICO — Cookies and similar technologies", url: "https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/cookies-and-similar-technologies/", covers: "consent before non-essential cookies (UK/EU-style rules)" },
  ],
  Privacy: [
    { name: "EU General Data Protection Regulation (GDPR)", url: "https://eur-lex.europa.eu/eli/reg/2016/679/oj", covers: "disclosing who receives visitor data, and consent" },
    { name: "California Consumer Privacy Act (CCPA) — CA Attorney General", url: "https://oag.ca.gov/privacy/ccpa", covers: "notice and the right to opt out of sale/sharing" },
    { name: "IAPP — US State Privacy Legislation Tracker", url: "https://iapp.org/resources/article/us-state-privacy-legislation-tracker/", covers: "which other US states have similar laws" },
    { name: "FTC — Privacy and Security guidance for business", url: "https://www.ftc.gov/business-guidance/privacy-security", covers: "US expectations that privacy statements match what a site does" },
    { name: "Global Privacy Control", url: "https://globalprivacycontrol.org/", covers: "the browser opt-out signal some laws require sites to honour" },
  ],
  Speed: [
    { name: "web.dev — Web Vitals", url: "https://web.dev/articles/vitals", covers: "the Good / Needs improvement / Poor thresholds" },
    { name: "Lighthouse performance scoring", url: "https://developer.chrome.com/docs/lighthouse/performance/performance-scoring", covers: "how the Speed score is weighted" },
  ],
  Accessibility: [
    { name: "WCAG 2.2 (W3C)", url: "https://www.w3.org/TR/WCAG22/", covers: "the A/AA success criteria tested" },
    { name: "axe-core rule descriptions (Deque)", url: "https://dequeuniversity.com/rules/axe/", covers: "each automated rule and how to fix it" },
    { name: "US DOJ — ADA guidance on web accessibility", url: "https://www.ada.gov/resources/web-guidance/", covers: "why US sites are expected to be accessible" },
  ],
  Basics: [
    { name: "MDN — 404 Not Found", url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/404", covers: "what a missing page should return" },
    { name: "Google Search Central — soft 404 errors", url: "https://developers.google.com/search/docs/crawling-indexing/http-network-errors", covers: "why a \"not found\" page must not return 200" },
    { name: "The Open Graph protocol", url: "https://ogp.me/", covers: "the preview card shown when a link is shared" },
    { name: "MDN — <link> (icons)", url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/link", covers: "declaring a favicon" },
    { name: "W3C — Developing an Accessibility Statement", url: "https://www.w3.org/WAI/planning/statements/", covers: "what an accessibility statement should say" },
    { name: "US Copyright Office — Copyright Notice (Circular 3)", url: "https://www.copyright.gov/circs/circ03.pdf", covers: "the form of a copyright notice" },
    { name: "FTC — Protecting Personal Information", url: "https://www.ftc.gov/business-guidance/resources/protecting-personal-information-guide-business", covers: "handling what visitors submit in forms" },
    { name: "Let's Encrypt FAQ", url: "https://letsencrypt.org/docs/faq/", covers: "certificate lifetimes and renewal" },
  ],
  Mobile: [
    { name: "WCAG 2.2 — Target Size (Minimum) 2.5.8", url: "https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html", covers: "the 24×24px tap-target rule" },
    { name: "MDN — Viewport meta tag", url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport", covers: "the mobile viewport tag and pinch-zoom" },
  ],
  Schema: [
    { name: "Google Search — Intro to structured data", url: "https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data", covers: "how Google reads JSON-LD" },
    { name: "schema.org", url: "https://schema.org/", covers: "the types and properties scored" },
  ],
};

// What good looks like — shown in the Governance and Privacy sections, so a site with problems there gets a
// direction to work toward, not only a list of what's wrong. Guidance, not legal advice.
export const BEST_PRACTICE = {
  Governance: [
    "Set only the cookies you need, and know why each one exists.",
    "Mark every cookie Secure and SameSite (Lax by default, Strict for sign-in), and HttpOnly unless your own script must read it.",
    "List each cookie — its name, purpose and how long it lasts — in your privacy or cookie policy.",
    "For visitors in the EU or UK, don't set non-essential cookies (analytics, advertising) until they agree; essential ones (sign-in, security) don't need consent.",
    "Review the list whenever you add a tool, plugin or embed — most new cookies arrive that way.",
  ],
  Privacy: [
    "Name every outside company that receives visitor data — analytics, advertising, chat widgets, video and map embeds, font services — in your privacy policy: what it collects, why, and how to opt out.",
    "Load advertising and tracking tools only after consent where the law requires it (EU, UK), and give an opt-out where it requires that instead (California and a growing list of US states).",
    "Honour the Global Privacy Control browser signal as an opt-out.",
    "Prefer options that need no consent at all: fonts hosted on your own site, privacy-friendly analytics that don't track individuals.",
    "Link the privacy policy from every page (the footer is standard) and keep it matching what the site actually does — US regulators act on statements that don't.",
  ],
};
