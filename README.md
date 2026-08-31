# gitfolio

A portfolio that builds itself from your GitHub profile. No build step, no content files.

Repos with a working website get a large card showing a live screenshot of the running site.
Everything else gets a small card linking to source. Name, location, descriptions, languages and
stars all come from the GitHub API at request time.

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

```bash
npx wrangler@4 deploy
```

Change `"name"` too if you want the Worker called something else. The name and location in
`public/index.html` are placeholders that JavaScript overwrites from your profile; edit them to
match yours if you want the headline correct on first paint rather than a moment later. Connect the repo in the
Cloudflare dashboard under **Workers & Pages > Builds** to deploy on every push.

### Other options

- **Workers Builds** — push to deploy. Set the deploy command to `npx wrangler@4 deploy`.
- **GitHub Actions** — `cloudflare/wrangler-action@v3` with `CLOUDFLARE_API_TOKEN` as a secret.
- **No screenshots** — drop the `browser` binding. Every repo renders as a small card.

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
| `?theme=<name>` | a palette: `space`, `cyberpunk`, `rainbow`, `paper`. Anything else is the default |

Combine them: `/torvalds?theme=space`. Themes are five CSS custom properties in
`public/index.html`; copy a block and change the values to add one.

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

- `public/index.html` — the whole page, one `<style>` block, no dependencies
- `src/index.js` — Worker: `/api/repos`, `/shot/*`, caching, liveness

Icons are your GitHub profile picture: `/favicon.ico` and `/apple-touch-icon.png` redirect to it,
so there is nothing to commit and they follow your avatar when you change it.

## Licence

MIT. See [LICENSE](LICENSE).
