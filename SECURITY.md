# Security model

Web Guardrails runs website checks that may be driven by an AI agent acting on **untrusted input**
(a URL from a web page, a README, a chat). The checks are built so that a tricked agent can't turn
them into something dangerous on the user's machine or network. This file states what is protected
and — just as important — what is not.

## What is protected

- **No shell.** No input is ever passed through a shell. Subprocesses (Lighthouse) are launched with
  `shell: false`, so a URL containing shell metacharacters is an inert argument, never a command.
- **SSRF — address filtering.** Before any fetch or browser load, the target is validated and its
  address classified with [`ipaddr.js`](https://github.com/whitequark/ipaddr.js). Anything that isn't
  a public global-unicast address is refused by default — loopback, link-local (including the
  `169.254.169.254` cloud-metadata address), unique-local, private, CGNAT, reserved — in every
  canonical IPv4 and IPv6 form, including IPv4-mapped IPv6. Override per-call with `--allow-private`
  only for a site you trust on your own network.
- **SSRF — browser requests.** The accessibility check filters **every** request the browser makes
  (redirects and subresources), not only the first URL, against the same rule.
- **Chrome sandbox stays on.** Disabled only by an explicit `--no-sandbox` flag or `WG_NO_SANDBOX=1`.
- **Confined writes.** The sitemap generator writes only inside its target directory, resolving
  symlinks/junctions first so a link that points outward can't escape it, and won't overwrite files
  without `--overwrite`.

## Known residual risks (not fully mitigated)

- **DNS rebinding (TOCTOU).** The address is validated at lookup time; the actual connection does a
  separate resolution. A hostile DNS server could answer "public" during the check and "private" at
  connect. Full protection requires pinning the connection to the validated IP, which these tools do
  not yet do. Mitigation: run against hosts you trust; prefer `--allow-private` off.
- **Lighthouse redirects/subresources.** Lighthouse drives its own Chrome, so only its initial URL is
  validated — it is not filtered per-request the way the accessibility check is. A page that redirects
  to an internal address is a residual risk. Run Lighthouse against sites you trust; for an untrusted
  target, the `headers` and `a11y` checks are the guarded ones.
- **Automated accessibility coverage.** axe-core catches roughly a third of issues; it is not a proof
  of accessibility. Do the manual keyboard/contrast/screen-reader pass too.

## Intended use

These are tools for testing sites you own or are authorized to test. They are not a penetration-testing
suite and make no attempt to defeat a determined attacker who controls the network.

## Reporting

Found something? Open an issue, or for anything sensitive, contact the maintainer rather than filing
a public report first.
