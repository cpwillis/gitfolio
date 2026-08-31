# gitfolio

A portfolio that builds itself from your GitHub profile. No build step, no content files.

Repos with a working website get a large card showing a live screenshot of the running site.
Everything else gets a small card linking to source. Name, location, descriptions, languages, stars
and the profile totals all come from the GitHub API at request time.

Organisations work the same way: `/<orgname>` renders an organisation's public repositories, and the
header drops the "Software engineer" line, which is not a claim to make about an organisation.

The repository total comes from the profile. Stars and languages are counted over one page of 100
repos, most recently updated. Commit totals are not shown: see the comment in `src/index.js`.

## Deploy

Ships pointing at `cpwillis` so it works before you change anything. Fork, then set your username
in `wrangler.jsonc`:

```jsonc
"vars": {
  "GITHUB_USER": "your-username",
  "HIDE_REPOS": "",
  // leave empty: your deployment then only ever serves GITHUB_USER
  "MULTI_USER_HOSTS": ""
}
```

Point `routes` at a host on your own Cloudflare account, or delete the array: deploying with
someone else's zone in it fails.

```bash
npx wrangler@4 deploy
```

Change `"name"` too if you want the Worker called something else. The `<title>` at
`public/index.html:5` and the `#nm` text and `#nml` href at `:110` ship as placeholders that
JavaScript overwrites from the profile; edit them to match yours if you want the headline correct on
first paint. A GitHub account with no display name set keeps the placeholders, so they are worth
editing. Connect the repo in the Cloudflare dashboard under **Workers & Pages > Builds** to deploy
on every push.

### Other options

- **Workers Builds**: push to deploy. Set the deploy command to `npx wrangler@4 deploy`.
- **GitHub Actions**: `cloudflare/wrangler-action@v3` with `CLOUDFLARE_API_TOKEN` as a secret.
- **No screenshots**: drop the `browser` binding. Every repo renders as a small card.

## Develop

```bash
npx wrangler@4 dev
```

Not `--local`. The browser binding is `"remote": true`, so the Worker runs locally while
screenshots go to the real service. `--local` forces every binding local and screenshots fail
silently. Check `npx wrangler@4 deploy --dry-run` lists `env.BROWSER` if previews never appear.

Because `wrangler.jsonc` declares a `custom_domain` route, `wrangler dev` presents that hostname to
the Worker rather than `localhost`. So `MULTI_USER_HOSTS` matches locally exactly as it does in
production, and `/<username>` works without any override.

If you remove the route, or deploy to a `*.workers.dev` subdomain, the hostname will not match and
every path will serve `GITHUB_USER` instead. Add the hostname you are actually on to
`MULTI_USER_HOSTS`, or override it for local runs only in a gitignored `.dev.vars`.

## URLs

| URL | Shows |
| --- | --- |
| `/` | on a host in `MULTI_USER_HOSTS`, a landing page explaining the project. Otherwise the account in `GITHUB_USER` |
| `/<username>` | that GitHub user, but only on a host listed in `MULTI_USER_HOSTS`. Otherwise every path serves `GITHUB_USER` |
| `?theme=<name>` | a palette: `space`, `cyberpunk`, `rainbow`, `mono`, `forest`, `sunset`, `nord`, `slate`, `paper`. Omit it and the accent is derived from the profile picture |

Combine them: `/torvalds?theme=space`. Themes are five CSS custom properties in
`public/index.html`; copy a block and change the values to add one. Only the accent and the two
glow colours move, so no avatar can make the page unreadable.

## How it works

Three stages, each independent, so nothing external delays first paint:

1. `public/index.html` is served as a static asset. Never waits on GitHub.
2. The page fetches `/api/repos`.
3. Each large card pulls its screenshot from `/shot/<repo>.png`.

A repo earns a large card once its site answers **and** its screenshot is cached. Misses are
captured in the background, so a repo promotes itself on a later view and demotes itself if the
site goes down.

Two things are hidden without configuring anything: your profile README, which GitHub names after
your account, and whichever repo is the site you are currently looking at, matched by its homepage
against the host in the address bar. A site therefore never shows a card pointing at itself, while
still showing your other deployments. That host rule cannot fire on `*.workers.dev`, which is what
`HIDE_REPOS` is for.

If you put this behind a proxy or a second domain, forward the visitor's hostname as
`x-forwarded-host` so the self-check sees the address the visitor actually typed.

## Rate limits

Unauthenticated GitHub reads are capped at 60 per hour **per IP**, and a Worker shares its egress IP
with every other Worker in the same colo, so that budget is not really yours. Under any real traffic
you will see `429`s as profiles fall out of cache and cannot be refetched.

Set a token and the cap becomes 5000/hr:

```bash
npx wrangler@4 secret put GITHUB_TOKEN
```

A classic token with **no scopes** is enough: everything here reads public data only. Use
`wrangler secret`, never a `var`, and never commit it. Without a token everything still works, it is
just fragile.

## Abuse

Three ceilings, all in code so a fork inherits them:

- **Per-IP rate limits** via the Workers rate-limiting bindings: 30 requests a minute to
  `/api/repos`, 120 a minute to the pages. A missing binding means "allow", so a fork that has not
  created them still works, it just has no ceiling.
- **A daily screenshot budget** (`CAPTURE_BUDGET`, 200/day). Captures are the only metered thing
  here, and this sits under the browser-minute quota so a crawler cannot flatten a day of it. The
  count uses the Cache API, which is not atomic, so it is deliberately approximate.
- **`robots.txt`** keeps crawlers out of `/api/` and `/shot/`, which exist for this site's own pages.

Anything beyond this belongs in front of the Worker: Cloudflare WAF rules, or Bot Management
(`request.cf.botManagement` is not on the Free plan, so there is no bot-score check here).

## Caching

Repo and profile data is keyed by the deployed Worker version, so **every deploy starts from a cold
data cache** with nothing to bump by hand. Screenshots are deliberately keyed separately: they cost
Browser Rendering minutes and their content does not depend on your code, so a deploy must not
throw them away. `CACHE_V` in `src/index.js` only exists for those, and only needs bumping if the
image format itself changes.

Cloudflare partitions its newer Workers Cache by version automatically, but not `caches.default`,
which is what this uses.

## Cost

Screenshots use [Browser Rendering](https://developers.cloudflare.com/browser-run/). Workers Free
includes 10 browser-minutes a day; captures take ~2s and cache for 24h. A handful of live sites
costs well under a minute a day. Everything else is static assets and cached API calls.

## Layout

- `public/index.html`: the whole page, one `<style>` block, no dependencies
- `src/index.js`: the Worker. `/api/repos`, `/shot/*`, caching, liveness

Icons are your GitHub profile picture: `/favicon.ico` and `/apple-touch-icon.png` redirect to it,
so there is nothing to commit and they follow your avatar when you change it.

## Licence

MIT. See [LICENSE](LICENSE).
