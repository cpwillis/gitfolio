const CACHE_V = 10        // only for image payloads: bump if their format changes
const REPOS_TTL = 3600
const LIVE_TTL = 3600     // a dead site demotes within the hour; every check is an outbound call
const SHOT_TTL = 86400
const PENDING_TTL = 300   // back-off before retrying a capture that failed
const FAIL_TTL = 120      // how long a failed GitHub read is remembered
const FEED_TTL = 120      // the assembled /api/repos answer, so a repeat view is one cache read

const withScheme = u => (!u ? null : /^https?:\/\//.test(u) ? u : `https://${u}`)

// Cloudflare partitions the newer Workers Cache by version, but NOT caches.default, so a deploy
// has to invalidate the data cache itself. Written once per isolate; a version cannot change
// under one, so this is constant in practice rather than mutable state. The binding is present
// in local dev too, which is why a new `wrangler dev` starts from a cold data cache.
let VERSION = ''
const setVersion = env => { VERSION = VERSION || env.CF_VERSION_METADATA.id }

// Data follows the deploy. Images deliberately do not: they cost Browser Rendering minutes and
// their content has nothing to do with the code version, so a deploy must not re-capture them.
const key = k => new Request(`https://x/${VERSION}/${k}`)
const imgKey = k => new Request(`https://x/img${CACHE_V}/${k}`)

// Two repos are never worth showing and both are derivable, so neither needs configuring:
// the profile README (always named after the account) and the portfolio itself (its homepage
// is the host you are reading this on).
// GitHub usernames: alphanumeric and single hyphens, 39 max. Anything else is not a user.
const RESERVED = new Set(['api', 'shot'])
const USER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const validUser = u => typeof u === 'string' && USER_RE.test(u)

// A repo homepage is attacker-controllable once any username can be requested, so refuse
// anything that is not a public http(s) host before it reaches fetch or the browser.
const PRIVATE = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[|.*\.internal$|.*\.local$)/i
const safeSite = u => {
  try {
    const { protocol, hostname } = new URL(u)
    return (protocol === 'https:' || protocol === 'http:') && hostname.includes('.') && !PRIVATE.test(hostname)
  } catch { return false }
}

const bareHost = h => String(h || '').replace(/^www\./, '').toLowerCase()
const isSelf = (r, user, host, extra) => {
  const n = r.name.toLowerCase()
  if (n === user.toLowerCase()) return true
  if (extra.includes(n)) return true
  try { return !!r.site && bareHost(new URL(r.site).host) === bareHost(host) } catch { return false }
}
// HIDE_REPOS is the escape hatch for when the host rule cannot fire, eg a *.workers.dev
// preview domain where the portfolio repo's homepage does not match the host you are on.
const csv = v => String(v || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
const hideList = env => csv(env.HIDE_REPOS)

// Serving other people's profiles is opt-in per hostname. A fork inherits this config pointing at
// somebody else's domains, so it never matches and the deployment only ever serves its own
// account: nobody can drive a stranger's Worker by asking it for arbitrary usernames.
const multiUser = (env, host) => csv(env.MULTI_USER_HOSTS).includes(bareHost(host))
const visible = (list, user, host, extra = []) => list.filter(r => !isSelf(r, user, host, extra))

// Both /api/repos and /shot must agree on which repos exist. /shot's only repo-level refusal is
// this list not containing the name, so the two must never drift apart.
const listFor = async (env, user, host) => {
  const all = await repos(user, env.GITHUB_TOKEN)
  if (all.error) return all
  return { data: visible(all.data, user, host, isOwner(env, user) ? hideList(env) : []) }
}

async function cached(k, build, mk = key) {
  const cache = caches.default
  const hit = await cache.match(mk(k))
  if (hit) return hit
  const res = await build()
  if (res) await cache.put(mk(k), res.clone())
  return res
}

// One shape for every GitHub read: fetch, cache the mapped result, fall back to null.
// ponytail: a rate limit on a cold cache yields an empty feed. Move to KV if it ever bites.
// Returns { data } or { error: <upstream status> }. The status is carried so a user who does not
// exist (404) can be told so, rather than being blamed on the feed being down.
async function ghCached(cacheKey, path, map, token) {
  const res = await cached(cacheKey, async () => {
    let status = 502
    try {
      const r = await fetch(`https://api.github.com${path}`, {
        headers: {
          'user-agent': 'gitfolio',
          accept: 'application/vnd.github+json',
          // Unauthenticated reads are capped at 60/hr per IP, and a Worker shares its egress IP
          // with everyone else in the colo, so that budget runs out. A token raises it to 5000/hr.
          // Optional: without it everything still works, just fragile under any real traffic.
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      })
      status = r.status
      if (!r.ok) throw new Error(status)
      return Response.json({ data: map(await r.json()) }, { headers: { 'cache-control': `max-age=${REPOS_TTL}` } })
    } catch {
      // Remember the failure briefly. Without this, a nonexistent user or a rate-limited window
      // costs a fresh upstream call on every single request, which keeps the limit tripped.
      return Response.json({ error: status }, { headers: { 'cache-control': `max-age=${FAIL_TTL}` } })
    }
  })
  return res ? res.json() : { error: 502 }
}

// Every public, non-fork repo on the profile. The unauthenticated endpoint returns public only.
const repos = async (user, token) =>
  (await ghCached(`${user}/repos`, `/users/${user}/repos?per_page=100&sort=updated`, list =>
    list.filter(x => !x.fork && !x.private).map(x => ({
      name: x.name,
      desc: x.description || '',
      lang: x.language,
      stars: x.stargazers_count,
      repoUrl: x.html_url,
      site: (site => (safeSite(site) ? site : null))(withScheme(x.homepage)),
    })), token))

// Only login, name and location. Deliberately not exposing bio/company/email.
// Public, non-identifying fields only. Still deliberately not exposing bio, company or email.
// `type` is "User" or "Organization": the header must not call an organisation a software engineer.
const profile = (user, token) =>
  ghCached(`${user}/profile`, `/users/${user}`, u => ({
    login: u.login,
    name: u.name || u.login,
    location: u.location || '',
    type: u.type || 'User',
    publicRepos: u.public_repos || 0,
    followers: u.followers || 0,
    since: String(u.created_at || '').slice(0, 4),
  }), token)

async function live(url) {
  if (!url) return false
  const res = await cached(`live/${encodeURIComponent(url)}`, async () => {
    let ok = false
    // no timeout here means one hung homepage stalls the entire feed response
    try { ok = (await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(2000) })).ok } catch { ok = false }
    return new Response(ok ? '1' : '', { headers: { 'cache-control': `max-age=${LIVE_TTL}` } })
  })
  return (await res.text()) === '1'
}

const shotKey = (user, name) => `${user}/shot/${name}`

// Capture and cache. Called in the background so a cold snapshot never blocks the page.
async function capture(user, name, url, env) {
  return cached(shotKey(user, name), async () => {
    try {
      // 1200 wide so the captured site renders its desktop layout, but lossy: the card paints it
      // about 325px wide and a lossless PNG of a screenshot is far larger than it needs to be.
      // quality is rejected alongside the default png type, so both must be set together.
      const r = await env.BROWSER.quickAction('screenshot', {
        url,
        viewport: { width: 1200, height: 750 },
        screenshotOptions: { type: 'webp', quality: 80 },
      })
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
      return new Response(r.body, {
        headers: {
          'content-type': r.headers.get('content-type') || 'image/webp',
          'cache-control': `max-age=${SHOT_TTL}`,
        },
      })
    } catch (e) {
      console.error(`screenshot failed for ${name} (${url}):`, e.message)
      return null
    }
  }, imgKey)
}


// The avatar is square; clip it to a circle and inline it so the SVG has no external reference.
async function roundAvatar(user) {
  return cached(`${user}/favicon`, async () => {
    try {
      const r = await fetch(`https://github.com/${user}.png?size=180`, { redirect: 'follow' })
      if (!r.ok) throw new Error(r.status)
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
        `<clipPath id="c"><circle cx="50" cy="50" r="50"/></clipPath>` +
        `<image href="data:image/png;base64,${new Uint8Array(await r.arrayBuffer()).toBase64()}" ` +
        `width="100" height="100" clip-path="url(#c)"/></svg>`
      return new Response(svg, {
        headers: { 'content-type': 'image/svg+xml', 'cache-control': `max-age=${SHOT_TTL}` },
      })
    } catch {
      return null
    }
  }, imgKey)
}

// Split into big (live site + snapshot already cached) and small. Snapshot misses are captured
// in the background, so a repo promotes itself on a later view.
const isOwner = (env, user) => user === String(env.GITHUB_USER || '').toLowerCase()

// Derived from what has already been fetched, so this costs no extra API call.
//
// The repository count comes from the profile, not from the list: the repo endpoint returns one
// page of 100, so an account with more than that would otherwise be told it has 98 repositories
// when it has 576. Stars and languages are necessarily counted over the page we hold, so for an
// account past 100 repos they describe the 100 most recently updated rather than everything.
//
// Commit totals are deliberately absent: no endpoint used here carries one, and the only source
// is an authenticated GraphQL call that covers just the last twelve months.
const tally = (list, who) => ({
  repos: who?.publicRepos || list.length,
  stars: list.reduce((n, r) => n + (r.stars || 0), 0),
  languages: new Set(list.map(r => r.lang).filter(Boolean)).size,
  followers: who?.followers || 0,
  since: who?.since || '',
})

// The assembled answer is cached per user and host for a short window. Everything it is built
// from is cached individually too, but that still meant a profile read, a repo read and one
// liveness read per repo on every single view.
async function feed(env, ctx, user, host) {
  const hit = await caches.default.match(key(`feed/${user}/${bareHost(host)}`))
  if (hit) return hit.json()
  const data = await buildFeed(env, ctx, user, host)
  // never cache an error: it must be retryable as soon as the underlying read recovers
  if (!data.error) {
    await caches.default.put(key(`feed/${user}/${bareHost(host)}`),
      Response.json(data, { headers: { 'cache-control': `max-age=${FEED_TTL}` } }))
  }
  return data
}

async function buildFeed(env, ctx, user, host) {
  const [who, listed] = await Promise.all([profile(user, env.GITHUB_TOKEN), listFor(env, user, host)])
  const err = who.error || listed.error
  // 404 is no such account. 403/429 is GitHub throttling us, which is worth saying out loud
  // rather than blaming the feed. Anything else is our problem.
  if (err) return { error: err === 404 ? 404 : (err === 403 || err === 429 ? 429 : 503) }
  const list = listed.data
  // Screenshots are only taken for this deployment's own account. Anyone else's portfolio is
  // small cards, so a visitor cannot spend the account's browser quota or aim it at a URL they
  // control by creating a repo with an arbitrary homepage.
  if (!isOwner(env, user)) {
    return { profile: who.data, stats: tally(list, who.data), owner: false, big: [], small: list }
  }
  const cache = caches.default
  const state = await Promise.all(list.map(async r => {
    if (!(await live(r.site))) return false
    if (await cache.match(imgKey(shotKey(user, r.name)))) return true
    // capture() returns null on failure and nulls are never cached, so without this marker a repo
    // that always fails would queue a fresh ~2s browser job on every request, forever.
    const pending = `${user}/pending/${r.name}`
    if (!(await cache.match(key(pending)))) {
      // claim the slot before returning, so concurrent cold requests do not each queue a capture
      await cache.put(key(pending), new Response('1', { headers: { 'cache-control': `max-age=${PENDING_TTL}` } }))
      ctx.waitUntil(capture(user, r.name, r.site, env))
    }
    return false
  }))
  return {
    profile: who.data,
    stats: tally(list, who.data),
    owner: true,
    big: list.filter((_, i) => state[i]),
    small: list.filter((_, i) => !state[i]),
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)
    setVersion(env)

    // ?user= names whose portfolio to serve; falls back to the deployment's own account.
    // GitHub usernames are case-insensitive, so normalise before anything caches on them.
    // Otherwise /CpWiLlIs is a distinct cache key and re-captures every screenshot.
    // Which host the visitor actually typed. Behind the cpwillis.dev mirror that is not url.hostname,
    // and without it a site cannot recognise a card pointing back at itself.
    // Display filtering only: never used for gating, so spoofing it just hides a card from yourself.
    const seenHost = req.headers.get('x-forwarded-host') || url.hostname
    // multiUser deliberately reads the REAL hostname: a header must never unlock other accounts.
    const asked = multiUser(env, url.hostname) ? url.searchParams.get('user') : null
    const user = String(asked || env.GITHUB_USER || '').toLowerCase()
    if (!user) return new Response('set GITHUB_USER in wrangler.jsonc', { status: 500 })
    if (!validUser(user)) return new Response('bad username', { status: 400 })

    // Stage 2: the page asks for this after it has already painted.
    if (url.pathname === '/api/repos') {
      const data = await feed(env, ctx, user, seenHost)
      if (data.error) return new Response(null, { status: data.error, headers: { 'cache-control': 'no-store' } })
      return Response.json(data, { headers: { 'cache-control': `max-age=${LIVE_TTL}` } })
    }

    // Icons come from the profile picture, so they follow the avatar with nothing to commit.
    // SVG favicons render in a restricted mode that blocks external refs, so the avatar has to be
    // inlined. iOS rounds apple-touch-icon itself, so that one stays a plain redirect.
    if (url.pathname === '/favicon.svg') {
      const svg = await roundAvatar(user)
      if (svg) return svg
    }
    const icon = { '/favicon.ico': 64, '/apple-touch-icon.png': 180 }[url.pathname]
    if (icon) return Response.redirect(`https://github.com/${user}.png?size=${icon}`, 302)

    const m = url.pathname.match(/^\/shot\/(.+)\.png$/)
    if (m) {
      if (!isOwner(env, user)) return new Response(null, { status: 404 })
      const name = m[1]   // repo names are [A-Za-z0-9._-], so there is nothing to decode
      // The common case is a warm image. Serve it before deriving the repo list or touching the
      // network: isOwner above is a string compare, so nothing expensive has happened yet.
      const warm = await caches.default.match(imgKey(shotKey(user, name)))
      if (warm) return warm
      const r = ((await listFor(env, user, seenHost)).data || []).find(x => x.name === name)
      if (!r || !safeSite(r.site) || !(await live(r.site))) return new Response(null, { status: 404 })
      return (await capture(user, name, r.site, env)) || new Response(null, { status: 404 })
    }

    // Routing is explicit from here. Relying on the asset router's single-page-application
    // fallback meant every typo, every reserved prefix and every extra path segment answered 200
    // with the profile page, so a URL that does not exist looked like one that does.
    const page = () => env.ASSETS.fetch(new Request(new URL('/', url), req))
    const segs = url.pathname.split('/').filter(Boolean)

    // the landing page is reached at "/", not by its file name
    if (segs.length === 1 && (segs[0] === 'landing' || segs[0] === 'landing.html')) {
      return Response.redirect(new URL('/', url).toString(), 302)
    }
    // These are route prefixes, not people. "api" and "shot" are valid username shapes, so without
    // this /api would render a portfolio for a user named api.
    if (segs.length === 1 && RESERVED.has(segs[0].toLowerCase())) {
      return new Response(null, { status: 404 })
    }

    if (segs.length === 0) {
      // On a multi-user host, "/" is nobody's portfolio: it explains what this is and how to use
      // it. A single-user deployment keeps "/" as its own profile, the whole point of a fork.
      if (!multiUser(env, url.hostname)) return page()
      const typed = String(url.searchParams.get('u') || '').toLowerCase()   // no-JS form fallback
      if (validUser(typed)) return Response.redirect(new URL(`/${typed}`, url).toString(), 302)
      return env.ASSETS.fetch(new Request(new URL('/landing', url), req))
    }

    // A username is exactly one segment and must look like a username. Everything the Worker
    // genuinely serves has already returned above, so anything left is not a URL here.
    if (segs.length > 1 || !validUser(segs[0].toLowerCase())) {
      return new Response(null, { status: 404 })
    }
    return page()
  },
}
