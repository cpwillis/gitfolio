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
- **Screenshots.** The Worker will only screenshot a URL taken from your own repos' `homepage`
  field, never one supplied in a request. Treat any path that lets a caller choose the target as a
  vulnerability, since it would make the Worker a request proxy.
- **Profile fields.** Only `login`, `name` and `location` are forwarded. `email`, `company` and
  `bio` are deliberately not exposed, so widening that is a privacy regression.

## Deploying your own

`GITHUB_USER` and `HIDE_REPOS` are plain vars, not secrets, and are safe to commit. If you add a
GitHub token to raise API rate limits, use `wrangler secret put` — never a var, and never commit it.
