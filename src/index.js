const CACHE_V = 10        // image payloads and capture-cost bookkeeping: survives a deploy
const REPOS_TTL = 3600
const LIVE_TTL = 3600     // a dead site demotes within the hour; every check is an outbound call
const SHOT_TTL = 604800   // a week: every expiry is a fresh browser job against 10 min/day
const BUSY_BACKOFF = 60   // a 429 is the account's browser concurrency, so retry soon
const FAIL_BACKOFF = 3600 // a site that will not render: stop asking for an hour
const FAIL_TTL = 120      // how long a failed GitHub read is remembered
const FEED_TTL = 120      // the assembled /api/repos answer, so a repeat view is one cache read
const CAPTURE_BUDGET = 200   // screenshots per day, a backstop under the browser-minute quota
const DAY = 86400

const today = () => new Date().toISOString().slice(0, 10)
// Text from the API is rendered as-is, so collapse the whitespace nobody meant to type. A name
// with a trailing space renders "Name 's GitFolio", and the possessive test misses a final s
// because it sees the space instead of the letter.
const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim()

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

// Where the project itself lives. "/" is only the right attribution target on a multi-user host,
// where it is the landing page; anywhere else "/" is the portfolio the footer sits on.
const UPSTREAM = 'https://github.com/cpwillis/gitfolio'
const RESERVED = new Set(['api', 'sc'])
const STATIC = new Set(['/robots.txt'])

// Rate limiters are keyed on the client IP. Absent bindings mean "allow": a fork that has not
// created them still works, it just has no ceiling.
const under = async (limiter, ip) => {
  if (!limiter) return true
  try { return (await limiter.limit({ key: ip })).success } catch { return true }
}
const tooMany = () => new Response(null, { status: 429, headers: { 'retry-after': '60' } })
// Pages a person can reach by mistyping get a body. /api and /sc keep the bare status:
// their callers are fetch() and <img>, neither of which reads one.
// A shot that is not there yet is a 404 the caller must be able to retry. Without no-store a
// browser caches it heuristically, and then never asks again once the capture lands: the card keeps
// an empty preview for as long as that cached 404 lives. Same rule the feed already follows.
const noShot = () => new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
const notFound = () => new Response(
  '<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found. <a href="/">Home</a>',
  { status: 404, headers: { 'content-type': 'text/html;charset=utf-8' } })

// Captures are the only thing here that spends a metered resource, so they get a hard daily
// ceiling on top of the per-repo back-off. Cache API is not atomic, so this is approximate by
// design: it exists to stop a crawler flattening the day's quota, not to count precisely.
async function captureBudgetLeft(day) {
  // imgKey, not key: a deploy must not hand the account a fresh day's capture quota
  const k = imgKey(`budget/${day}`)
  const hit = await caches.default.match(k)
  const used = hit ? Number(await hit.text()) || 0 : 0
  if (used >= CAPTURE_BUDGET) return false
  await caches.default.put(k, new Response(String(used + 1), {
    headers: { 'cache-control': `max-age=${DAY}` },
  }))
  return true
}
// GitHub usernames: alphanumeric and single hyphens, 39 max. Anything else is not a user.
const USER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const validUser = u => typeof u === 'string' && USER_RE.test(u)

// A repo homepage is attacker-controllable once any username can be requested, so refuse
// anything that is not a public http(s) host before it reaches fetch or the browser.
const PRIVATE = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[|.*\.internal$|.*\.local$)/i
// Returns the usable URL or null. GitHub records homepages bare ("example.com") as often as not,
// so normalising and validating are one step: a homepage is either safe to use or it is not.
const siteOrNull = u => {
  const s = !u ? '' : /^https?:\/\//.test(u) ? u : `https://${u}`
  try {
    const { protocol, hostname } = new URL(s)
    return (protocol === 'https:' || protocol === 'http:') && hostname.includes('.') && !PRIVATE.test(hostname)
      ? s     // the original string, not url.href: href adds a trailing slash and re-keys every live/ entry
      : null
  } catch { return null }
}

const bareHost = h => String(h || '').replace(/^www\./, '').toLowerCase()
// Two repos are never worth showing and both are derivable, so neither needs configuring:
// the profile README (always named after the account) and the portfolio itself (its homepage
// is the host you are reading this on).
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
// "true" or "*" serves anyone on any host, "false" or empty serves only GITHUB_USER. A comma
// separated host list is still honoured, for a deployment that wants it on one hostname only.
const multiUser = (env, host) => {
  const v = String(env.MULTI_USER_HOSTS || '').trim().toLowerCase()
  if (!v || v === 'false') return false
  if (v === 'true' || v === '*') return true
  return csv(v).includes(bareHost(host))
}
const visible = (list, user, host, extra = []) => list.filter(r => !isSelf(r, user, host, extra))

// Both /api/repos and /sc must agree on which repos exist. /sc's only repo-level refusal is
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
      desc: clean(x.description),
      lang: x.language,
      stars: x.stargazers_count,
      repoUrl: x.html_url,
      site: siteOrNull(x.homepage),
    })), token))

// Public profile fields only. bio, company and email are never forwarded.
// `type` is "User" or "Organization": the header must not call an organisation a software engineer.
const profile = (user, token) =>
  ghCached(`${user}/profile`, `/users/${user}`, u => ({
    login: u.login,
    name: clean(u.name) || u.login,
    location: clean(u.location),
    type: u.type || 'User',
    publicRepos: u.public_repos || 0,
    followers: u.followers || 0,
    since: String(u.created_at || '').slice(0, 4),
  }), token)

// A repo whose homepage is this deployment is live by definition: we are the thing serving it.
// Fetching it loops back through the edge into this same Worker, re-entering its own per-IP page
// limit, and a self-request slower than the 2s budget gets cached as dead for an hour.
const isOwnHost = (url, selfHost) => {
  try { return bareHost(new URL(url).hostname) === bareHost(selfHost) } catch { return false }
}

// Every homepage verdict in one cache entry, not one each. A feed build used to cost one cache read
// per repo with a site, and three subrequests each when cold, which on an account with many live
// sites approached the 50-subrequest ceiling. This is one read warm, and one read plus one write
// however many are checked. Unknown URLs only: a verdict stands until the whole entry expires.
async function liveness(user, list, selfHost) {
  const k = key(`live/${user}`)
  const hit = await caches.default.match(k)
  const map = hit ? await hit.json() : {}
  const todo = []
  for (const r of list) {
    if (!r.site) continue
    if (isOwnHost(r.site, selfHost)) map[r.site] = true
    else if (!(r.site in map)) todo.push(r.site)
  }
  if (todo.length) {
    // no timeout here means one hung homepage stalls the entire feed response
    const got = await Promise.all(todo.map(async u => {
      try { return (await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(2000) })).ok }
      catch { return false }
    }))
    todo.forEach((u, i) => { map[u] = got[i] })
    await caches.default.put(k, Response.json(map, { headers: { 'cache-control': `max-age=${LIVE_TTL}` } }))
  }
  return map
}

const shotKey = (user, name) => `${user}/shot/${name}`
const shotObj = (user, name) => `${user}/${name}.webp`

// Screenshots live in R2 when a bucket is bound. caches.default is per colo and evicts whenever it
// likes, so a card that had a preview would drop back to a small one and the re-capture would land
// on the account's browser concurrency limit. R2 keeps an image until it is replaced, and one
// object is shared by every colo. Without the binding the old cache path still works, so a fork
// with no bucket loses nothing but the stability.
const shotHeaders = { 'content-type': 'image/webp', 'cache-control': `public, max-age=${SHOT_TTL}` }

async function shotGet(env, user, name) {
  if (env.SHOTS) {
    const o = await env.SHOTS.get(shotObj(user, name))
    return o ? new Response(o.body, { headers: shotHeaders }) : null
  }
  return (await caches.default.match(imgKey(shotKey(user, name)))) || null
}

// One call answers "which of these already have an image", instead of one lookup per repo.
async function shotsPresent(env, user, names) {
  if (!env.SHOTS) {
    const hits = await Promise.all(names.map(n => caches.default.match(imgKey(shotKey(user, n)))))
    return new Set(names.filter((_, i) => hits[i]))
  }
  const { objects } = await env.SHOTS.list({ prefix: `${user}/` })
  // R2 objects have no expiry, so without this a screenshot taken once would be kept for good and
  // a redesigned site would never update. Treat an old one as absent and it gets retaken.
  const fresh = Date.now() - SHOT_TTL * 1000
  const have = new Set(objects.filter(o => o.uploaded.getTime() > fresh).map(o => o.key))
  return new Set(names.filter(n => have.has(shotObj(user, n))))
}
const pendingKey = (user, name) => imgKey(`${user}/pending/${name}`)

// Capture and cache. Called in the background so a cold snapshot never blocks the page.
async function capture(user, name, url, env) {
  // capture() returns null on failure and nulls are never cached, so without this marker a repo
  // that always fails would queue a fresh ~2s browser job on every request, forever. The guard is
  // here rather than at the call sites because /sc and the feed both reach the browser through
  // this one function, and the second call site had been added without it.
  const pending = pendingKey(user, name)
  if (await caches.default.match(pending)) return null
  const backOff = ttl => caches.default.put(pending,
    new Response('1', { headers: { 'cache-control': `max-age=${ttl}` } }))
  // claim the slot before the first await, so concurrent cold requests do not each queue a capture
  await backOff(BUSY_BACKOFF)
  if (!(await captureBudgetLeft(today()))) return null
  if (env.SHOTS) {
    const shot = await screenshot(env, name, url, backOff)
    if (!shot) return null
    await env.SHOTS.put(shotObj(user, name), shot, { httpMetadata: { contentType: 'image/webp' } })
    return new Response(shot, { headers: shotHeaders })
  }
  const shot = await screenshot(env, name, url, backOff)
  if (!shot) return null
  const res = new Response(shot, { headers: shotHeaders })
  await caches.default.put(imgKey(shotKey(user, name)), res.clone())
  return res
}

// The browser call itself. Returns the image bytes, or null after recording the right back-off.
async function screenshot(env, name, url, backOff) {
  try {
    // 1200 wide so the captured site renders its desktop layout, but lossy: the card paints it
    // about 325px wide and a lossless PNG of a screenshot is far larger than it needs to be.
    // quality is rejected alongside the default png type, so both must be set together.
    const r = await env.BROWSER.quickAction('screenshot', {
      url,
      viewport: { width: 1200, height: 750 },
      screenshotOptions: { type: 'webp', quality: 80 },
      // Browser Run defaults to domcontentloaded, which fires before a page's JavaScript has
      // rendered anything: a site that loads its content on boot was captured half empty.
      // networkidle2, not networkidle0, because a page with an analytics beacon never fully idles.
      gotoOptions: { waitUntil: 'networkidle2' },
    })
    if (r.ok) return await r.arrayBuffer()
    // 429 means the account ran out of concurrent browsers, which says nothing about this site, so
    // the short claim stands and the next view retries. Anything else is the site's problem.
    if (r.status !== 429) await backOff(FAIL_BACKOFF)
    console.error(`screenshot failed for ${name} (${url}): ${r.status} ${await r.text()}`)
    return null
  } catch (e) {
    await backOff(FAIL_BACKOFF)
    console.error(`screenshot failed for ${name} (${url}):`, e.message)
    return null
  }
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
async function feed(env, ctx, user, host, selfHost) {
  const k = key(`feed/${user}/${bareHost(host)}`)
  const hit = await caches.default.match(k)
  if (hit) return hit.json()
  const data = await buildFeed(env, ctx, user, host, selfHost)
  // never cache an error: it must be retryable as soon as the underlying read recovers
  if (!data.error) {
    await caches.default.put(k, Response.json(data, { headers: { 'cache-control': `max-age=${FEED_TTL}` } }))
  }
  return data
}

// Split into big (live site + snapshot already cached) and small.
async function buildFeed(env, ctx, user, host, selfHost) {
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
  // One capture per request. Free allows 3 concurrent browsers per account and every colo builds
  // its own feed, so anything higher races itself across colos and earns a 429. Successive views
  // pick up the next repo, because a captured one short-circuits above.
  // ponytail: fixed cap, not a scheduler. Raise it if the account's concurrency ever does.
  let queued = 0
  const alive = await liveness(user, list, selfHost)
  const haveShot = await shotsPresent(env, user, list.map(r => r.name))
  const state = await Promise.all(list.map(async r => {
    if (!r.site || !alive[r.site]) return false
    if (haveShot.has(r.name)) return true
    // A repo already backing off must not consume the slot: it cannot capture anyway, and while
    // it holds the slot every repo after it in the list is never captured at all.
    if (await cache.match(pendingKey(user, r.name))) return false
    if (queued++ < 1) ctx.waitUntil(capture(user, r.name, r.site, env))
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

    const ip = req.headers.get('cf-connecting-ip') || '0.0.0.0'

    // Stage 2: the page asks for this after it has already painted.
    if (url.pathname === '/api/repos') {
      if (!(await under(env.RL_FEED, ip))) return tooMany()
      const data = await feed(env, ctx, user, seenHost, url.hostname)
      if (data.error) return new Response(null, { status: data.error, headers: { 'cache-control': 'no-store' } })
      // FEED_TTL, not LIVE_TTL: a browser holding this for an hour cannot see the previews
      // its own first visit just queued.
      return Response.json(data, { headers: { 'cache-control': `max-age=${FEED_TTL}` } })
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

    // /sc/<user>/<repo>. The account is a path segment, not a query default: the old
    // /shot/<repo>.png?user= fell back to GITHUB_USER when the argument was left off, so one URL
    // could mean different images on different deployments. No extension either, the bytes are webp.
    const m = url.pathname.match(/^\/sc\/([^/]+)\/([^/]+)$/)
    if (m) {
      const shotUser = decodeURIComponent(m[1]).toLowerCase()
      if (!validUser(shotUser) || !isOwner(env, shotUser)) return noShot()
      const name = decodeURIComponent(m[2])   // repo names are [A-Za-z0-9._-]
      // The common case is a warm image. Serve it before deriving the repo list or touching the
      // network: isOwner above is a string compare, so nothing expensive has happened yet.
      const warm = await shotGet(env, shotUser, name)
      if (warm) return warm
      const r = ((await listFor(env, shotUser, seenHost)).data || []).find(x => x.name === name)
      if (!r || !siteOrNull(r.site)) return noShot()
      if (!(await liveness(shotUser, [r], url.hostname))[r.site]) return noShot()
      return (await capture(shotUser, name, r.site, env)) || noShot()
    }

    if (!(await under(env.RL_PAGE, ip))) return tooMany()

    // Routing is explicit from here. Relying on the asset router's single-page-application
    // fallback meant every typo, every reserved prefix and every extra path segment answered 200
    // with the profile page, so a URL that does not exist looked like one that does.
    // The shell ships max-age=0, must-revalidate with no validator, so every repeat view is a
    // round trip that can only ever return the same bytes. Five minutes of browser cache makes a
    // second view free; the feed and the previews carry their own, shorter, freshness.
    const page = async (path = '/', who = '') => {
      const r = await env.ASSETS.fetch(new Request(new URL(path, url), req))
      const h = new Headers(r.headers)
      h.set('cache-control', 'public, max-age=300')
      const res = new Response(r.body, { status: r.status, headers: h })
      // Every page gets one, so ?theme= and any other query string consolidate onto the bare URL.
      // The request host, never x-forwarded-host: a proxy must not be able to pick our canonical.
      const canon = `https://${url.host}${who && multiUser(env, url.hostname) ? '/' + who : '/'}`
      let rw = new HTMLRewriter()
        .on('head', { element: e => e.append(`<link rel="canonical" href="${canon}">`, { html: true }) })
      // On a single-user deployment "/" is this very page, so the attribution would link to itself.
      if (!multiUser(env, url.hostname)) {
        rw = rw.on('#gen', { element: e => e.setAttribute('href', UPSTREAM) })
      }
      if (!who) return rw.transform(res)
      // Crawlers and link unfurlers do not run the page's JavaScript, so without this every shared
      // link is titled for whoever the deployment ships pointing at. who is already through
      // validUser, so it is [A-Za-z0-9-]{1,39} and safe to interpolate into an attribute.
      const t = `${who}${/s$/i.test(who) ? "'" : "'s"} GitFolio`
      return rw
        .on('title', { element: e => e.setInnerContent(t) })
        .on('head', { element: e => e.append(
          `<meta property="og:type" content="profile">` +
          `<meta property="og:title" content="${t}">` +
          `<meta property="og:description" content="Public GitHub projects by ${who}.">` +
          `<meta property="og:url" content="${canon}">` +
          `<meta property="og:image" content="https://github.com/${who}.png?size=460">` +
          `<meta property="og:image:alt" content="GitHub avatar for ${who}">` +
          `<meta name="twitter:card" content="summary">`, { html: true }) })
        .transform(res)
    }
    const segs = url.pathname.split('/').filter(Boolean)

    // Real files that are not pages. Explicit, because the username rule below rejects anything
    // with a dot in it and would otherwise 404 them.
    if (STATIC.has(url.pathname)) return env.ASSETS.fetch(req)

    // the landing page is reached at "/", not by its file name
    if (segs.length === 1 && (segs[0] === 'landing' || segs[0] === 'landing.html')) {
      return Response.redirect(new URL('/', url).toString(), 302)
    }
    // These are route prefixes, not people. "api" and "sc" are valid username shapes, so without
    // this /api would render a portfolio for a user named api.
    if (segs.length === 1 && RESERVED.has(segs[0].toLowerCase())) return notFound()

    if (segs.length === 0) {
      // On a multi-user host, "/" is nobody's portfolio: it explains what this is and how to use
      // it. A single-user deployment keeps "/" as its own profile, the whole point of a fork.
      if (!multiUser(env, url.hostname)) return page('/', user)
      const typed = String(url.searchParams.get('u') || '').toLowerCase()   // no-JS form fallback
      if (validUser(typed)) return Response.redirect(new URL(`/${typed}`, url).toString(), 302)
      return page('/landing')
    }

    // A username is exactly one segment and must look like a username. Everything the Worker
    // genuinely serves has already returned above, so anything left is not a URL here.
    if (segs.length > 1 || !validUser(segs[0].toLowerCase())) return notFound()
    // A single-user deployment has exactly one profile and it lives at "/". Serving it again under
    // every username shape gave a fork unlimited duplicate URLs, and put strangers' names in its
    // paths. The owner's own name redirects rather than 404s, since people do type it.
    if (!multiUser(env, url.hostname)) {
      return segs[0].toLowerCase() === user
        ? Response.redirect(new URL('/', url).toString(), 301)
        : notFound()
    }
    return page('/', segs[0].toLowerCase())
  },
}
