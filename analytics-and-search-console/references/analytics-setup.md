# Cookieless first-party analytics (server + beacon)

The proven pattern: count visits on your own server, no cookie, no stored IP. Translate to your stack.

## Server-side hit counting

Middleware on the public site records each real page request. Keep it cheap: **count in memory, flush
to disk once a minute** (rewriting a growing file on every page view is a self-inflicted slowdown).

```js
// SiteHit: { path, ts, ref, country?, via? }   // no cookie, no stored IP
function trackSiteVisit(req, res, next) {
  const isAsset = /\.(js|css|png|jpe?g|svg|webp|ico|woff2?|mp4|mp3|json|map|txt|xml)$/i.test(req.path);
  if (req.method === "GET" && !isAsset && !isTeamBrowser(req)) {   // don't count your own logged-in traffic
    const store = readAnalytics();               // in-memory cache
    store.hits.push({
      path: req.path,
      ts: new Date().toISOString(),
      ref: refHost(req.headers.referer),         // referrer hostname only
      country: visitorCountry(req),              // see below — IP used then discarded
      via: allowListed(req.query.via),           // optional: share-channel tag on shared links
    });
    store.totalAllTime++;
    markDirty();                                  // flushed on a 60s timer + on shutdown
  }
  next();
}
```

**Country without keeping the IP:** look it up at request time from a local DB and keep only the
2-letter country. Never store the IP.
```js
import geoip from "geoip-country";
import net from "node:net";
function visitorCountry(req) {
  const ip = clientIp(req);                       // see the hardening skill §4 — don't trust forgeable CDN headers
  if (!net.isIP(ip) || ip.length > 45) return ""; // only real IPs reach the lookup
  return geoip.lookup(ip)?.country || "";
}
```
Pin `ip-address` to a safe version (`overrides`) — the geoip package's transitive dep had a DoS CVE.

**Named-page beacon (SPAs):** a hash-routed SPA only ever hits `/` server-side, so send a tiny beacon
on in-app navigation to count which page was read:
```js
navigator.sendBeacon('/api/site/track-page', JSON.stringify({ page }));   // server validates page against an allow-list
```

**Share-channel tags:** when the site's own Share button builds a link, append `?via=whatsapp` (etc.)
so WhatsApp/Facebook shares — which send no referrer — show up as a channel instead of "direct".

## Admin view

`GET /api/site/analytics` (admin-guarded) aggregates the hits: by day, by page, by country, by
referrer, by share-channel, totals, oldest/newest, and a `generatedAt` so the panel can show "last
refreshed". Render it read-only in the admin panel (see the site-admin-panel skill), with a Refresh
button and plain-language labels.

## What NOT to do

- No tracking cookie, no `localStorage` visitor id, no cross-site pixel — that's what triggers the
  consent-banner obligation this approach is designed to avoid.
- Don't store raw IPs "just in case" — a list of who visited is a liability if the server is breached.
  Country-only is almost always enough.
- Don't count your own team (exclude logged-in sessions) or you'll read your own testing as traffic.

## Privacy notice

Whatever you collect, the notice must match it exactly (see the hardening skill's
`privacy-cookies-us.md`): name the fields, say there are no tracking cookies, disclose the host as a
processor, and don't claim "we never log your IP" if the host's own logs do — say what you control.
