# gitfolio

A portfolio that builds itself from a GitHub profile. Fork it, set your username, deploy. No build
step, no dependencies, no content files.

Repos with a working website get a large card showing a live screenshot of the running site.
Everything else gets a small card linking to source. Name, location, descriptions, languages, stars
and the profile totals all come from the GitHub API at request time.

`/<orgname>` renders an organisation the same way, minus the "Software engineer" line in the header.

The repository count comes from the profile. Stars and languages are counted over one page of 100
repos, most recently updated, so past 100 they describe the newest 100 rather than everything.

## Deploy

Ships pointing at `cpwillis`, so it runs before you change anything. Fork, then edit
`wrangler.jsonc`:

- `routes` points at `gitfolio.cpwillis.dev`, which is not your zone. Point it at a host on your own
  Cloudflare account, or delete the array. Deploying with someone else's zone in it fails.
- `vars.GITHUB_USER`: your account. Everything else follows from it.
- `vars.MULTI_USER_HOSTS`: ships listing the author's host, so it never matches a fork. Left empty,
  the deployment only ever serves `GITHUB_USER`, whatever path is requested. Add your own hostname
  only if you want `/<username>` to render strangers against your GitHub rate limit.
- `vars.HIDE_REPOS`: extra repo names to leave out, comma separated. Normally empty.
- `name`: the Worker's name. Optional.

```bash
npx wrangler@4 deploy
```

Two things in `public/index.html` a fork should own: the `#nm` text and `#nml` href at `:110` ship
as `cpwillis` (JavaScript overwrites both from the profile, so this is first paint and the no-JS
view only), and the Terms and Privacy links in the footer at `:142` point at the author's site.

Push to deploy: connect the repo under **Workers & Pages > Builds** with `npx wrangler@4 deploy` as
the deploy command, or run `cloudflare/wrangler-action@v4` with `CLOUDFLARE_API_TOKEN` as a secret.

Drop the `browser` binding if you do not want screenshots. Every repo then renders as a small card.

## Develop

```bash
npx wrangler@4 dev
```

Not `--local`. The `browser` binding is `"remote": true`, so the Worker runs locally while
screenshots go to the real service; `--local` forces every binding local and screenshots fail
silently. `npx wrangler@4 deploy --dry-run` should list `env.BROWSER`.

Nothing to install, and no test suite: verify by loading the page and watching the three stages
resolve.

Because `wrangler.jsonc` declares a `custom_domain` route, `wrangler dev` presents that hostname to
the Worker rather than `localhost`, so `MULTI_USER_HOSTS` matches locally exactly as it does in
production and `/<username>` works with no override. Remove the route, or deploy to a
`*.workers.dev` subdomain, and the hostname stops matching: every path then serves `GITHUB_USER`.
Add the hostname you are actually on to `MULTI_USER_HOSTS`, or override it for local runs only in a
gitignored `.dev.vars`.

## URLs

- `/`: the landing page on a host in `MULTI_USER_HOSTS`, otherwise `GITHUB_USER`'s own portfolio.
- `/<username>`: that user, on a `MULTI_USER_HOSTS` host only. Elsewhere `/GITHUB_USER` 301s to `/`
  and anything else 404s.
- `?theme=<name>`: `space`, `cyberpunk`, `rainbow`, `mono`, `forest`, `sunset`, `nord`, `slate`,
  `paper`. Omit it and the accent is derived from the profile picture.

Combine them: `/torvalds?theme=space`. A theme is eight custom properties in `public/index.html`;
copy a block and change the values to add one. The avatar-derived accent moves only three of them,
so no avatar can make the page unreadable.

## How it works

Three stages, each independent, so nothing external delays first paint:

1. `public/index.html` is served as a static asset. Never waits on GitHub.
2. The page fetches `/api/repos`.
3. Each large card pulls its screenshot from `/shot/<repo>.png`.

A repo earns a large card once its site answers **and** its screenshot is cached. Misses are
captured in the background, so a repo promotes itself on a later view and demotes itself if the
site goes down.

Two repos are hidden with nothing configured: the profile README, which GitHub names after the
account, and whichever repo is the site you are currently looking at, matched by its `homepage`
against the host in the address bar. So a site never shows a card pointing at itself while still
showing your other deployments. That host rule cannot fire on `*.workers.dev`, which is what
`HIDE_REPOS` is for.

Behind a proxy or a second domain, forward the visitor's hostname as `x-forwarded-host` so the
self-check sees the address they actually typed.

`/favicon.ico`, `/favicon.svg` and `/apple-touch-icon.png` all come from the GitHub profile picture,
so there is nothing to commit and they follow the avatar.

## Limits

Unauthenticated GitHub reads are capped at 60 an hour **per IP**, and a Worker shares its egress IP
with every other Worker in the same colo, so that budget is not really yours. Under any real traffic
you will see `429`s as profiles fall out of cache and cannot be refetched. A token raises the cap to
5000/hr:

```bash
npx wrangler@4 secret put GITHUB_TOKEN
```

A classic token with **no scopes** is enough: everything here reads public data. Use
`wrangler secret`, never a `var`, and never commit it. Without a token everything still works, it is
just fragile.

Outbound ceilings, all in code so a fork inherits them:

- `RL_FEED` and `RL_PAGE`, the Workers rate-limiting bindings: 30 requests a minute per IP to
  `/api/repos`, 120 a minute to the pages. A missing binding means "allow", so a fork that has not
  created them still works, it just has no ceiling.
- `CAPTURE_BUDGET` in `src/index.js`, 200 screenshots a day. Captures are the only metered thing
  here. The count uses the Cache API, which is not atomic, so it is deliberately approximate.
- `public/robots.txt` allows `/` and disallows everything else, including `/api/` and `/shot/`.

Anything stricter belongs in front of the Worker: Cloudflare WAF rules, or Bot Management
(`request.cf.botManagement` is not on the Free plan, so there is no bot-score check here).

## Caching

Repo and profile data is keyed by the deployed Worker version, so **every deploy starts from a cold
data cache** with nothing to bump by hand. Screenshots are deliberately keyed separately, by
`CACHE_V` in `src/index.js`: they cost browser minutes and their content does not depend on your
code, so a deploy must not throw them away. Cloudflare partitions its newer Workers Cache by version
automatically, but not `caches.default`, which is what this uses.

## Cost

Screenshots use [Browser Run](https://developers.cloudflare.com/browser-run/). Workers Free includes
10 browser-minutes a day; a capture takes ~2s and caches for 24h, so a handful of live sites costs
well under a minute a day. Everything else is static assets and cached API calls.
