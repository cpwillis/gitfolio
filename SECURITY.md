# Security

## Reporting

Report vulnerabilities privately through GitHub: **Security > Advisories > Report a vulnerability**
on this repository. Please do not open a public issue for anything exploitable.

Expect an initial response within a week.

## Threat model

gitfolio holds no secrets and has no users, sessions, database, or write path. It reads public
GitHub data and serves a static page, so the realistic risks are narrow:

- **Untrusted content.** Repo names and descriptions are third-party strings rendered on the page.
  They are inserted with `textContent`, never `innerHTML`, so they cannot inject markup. Any change
  reintroducing string-built HTML is a security bug.
- **Multi-tenancy is opt-in.** `/<username>` only serves other people on a hostname listed in
  `MULTI_USER_HOSTS`. A fork inherits this pointing at somebody else's domains, so it never matches
  and that deployment answers only for its own `GITHUB_USER`. Adding your host is a deliberate
  decision to accept strangers' traffic against your GitHub rate limit.
- **Screenshots.** Where multi-user is enabled, any GitHub user can be requested, but screenshots are taken
  **only** for the account in `GITHUB_USER`. Everyone else renders as small cards. This matters
  because a repo `homepage` is attacker-controlled — anyone can create a public repo pointing
  anywhere — so capturing for arbitrary users would turn the Worker into a screenshot proxy and
  let a visitor spend the account's Browser Rendering quota. Widening this is a security change,
  not a feature.
- **Outbound URLs.** Homepages are checked by `safeSite()` before any fetch: http(s) only, and no
  `localhost`, RFC1918, link-local, `.internal`, `.local`, or hostnames without a dot.
- **Usernames.** Validated against GitHub's own rule and lowercased before use, so they cannot
  traverse paths or multiply cache entries.
- **Profile fields.** Only `login`, `name` and `location` are forwarded. `email`, `company` and
  `bio` are deliberately not exposed, so widening that is a privacy regression.

## Deploying your own

`GITHUB_USER` and `HIDE_REPOS` are plain vars, not secrets, and are safe to commit. If you add a
GitHub token to raise API rate limits, use `wrangler secret put` — never a var, and never commit it.
