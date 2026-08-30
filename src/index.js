const CACHE_V = 8          // bump whenever a cached payload's shape or filtering changes
const REPOS_TTL = 3600
const LIVE_TTL = 900
const SHOT_TTL = 86400
const PENDING_TTL = 300   // back-off before retrying a capture that failed

const NEW_TAB = 'target="_blank" rel="noopener"'
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const withScheme = u => (!u ? null : /^https?:\/\//.test(u) ? u : `https://${u}`)

const key = k => new Request(`https://x/v${CACHE_V}/${k}`)

// Two repos are never worth showing and both are derivable, so neither needs configuring:
// the profile README (always named after the account) and the portfolio itself (its homepage
// is the host you are reading this on).
// GitHub usernames: alphanumeric and single hyphens, 39 max. Anything else is not a user.
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
const hideList = env => String(env.HIDE_REPOS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
const visible = (list, user, host, extra = []) => list.filter(r => !isSelf(r, user, host, extra))

async function cached(k, build) {
  const cache = caches.default
  const hit = await cache.match(key(k))
  if (hit) return hit
  const res = await build()
  if (res) await cache.put(key(k), res.clone())
  return res
}

// One shape for every GitHub read: fetch, cache the mapped result, fall back to null.
// ponytail: a rate limit on a cold cache yields an empty feed. Move to KV if it ever bites.
async function ghCached(cacheKey, path, map) {
  const res = await cached(cacheKey, async () => {
    try {
      const r = await fetch(`https://api.github.com${path}`, {
        headers: { 'user-agent': 'gitfolio', accept: 'application/vnd.github+json' },
      })
      if (!r.ok) throw new Error(r.status)
      return Response.json(map(await r.json()), { headers: { 'cache-control': `max-age=${REPOS_TTL}` } })
    } catch {
      return null
    }
  })
  return res ? res.json() : null
}

// Every public, non-fork repo on the profile. The unauthenticated endpoint returns public only.
const repos = async user =>
  (await ghCached(`${user}/repos`, `/users/${user}/repos?per_page=100&sort=updated`, list =>
    list.filter(x => !x.fork && !x.private).map(x => ({
      name: x.name,
      desc: x.description || '',
      lang: x.language,
      stars: x.stargazers_count,
      repoUrl: x.html_url,
      site: (site => (safeSite(site) ? site : null))(withScheme(x.homepage)),
    })))) || []

// Only login, name and location. Deliberately not exposing bio/company/email.
const profile = user =>
  ghCached(`${user}/profile`, `/users/${user}`, u => ({
    login: u.login,
    name: u.name || u.login,
    location: u.location || '',
  }))

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
  })
}

const b64 = buf => {
  const bytes = new Uint8Array(buf)
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))  // chunked: spreading it all blows the stack
  }
  return btoa(out)
}

// The avatar is square; clip it to a circle and inline it so the SVG has no external reference.
async function roundAvatar(user) {
  return cached(`${user}/favicon`, async () => {
    try {
      const r = await fetch(`https://github.com/${user}.png?size=180`, { redirect: 'follow' })
      if (!r.ok) throw new Error(r.status)
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
        `<clipPath id="c"><circle cx="50" cy="50" r="50"/></clipPath>` +
        `<image href="data:image/png;base64,${b64(await r.arrayBuffer())}" ` +
        `width="100" height="100" clip-path="url(#c)"/></svg>`
      return new Response(svg, {
        headers: { 'content-type': 'image/svg+xml', 'cache-control': `max-age=${SHOT_TTL}` },
      })
    } catch {
      return null
    }
  })
}

// Split into big (live site + snapshot already cached) and small. Snapshot misses are captured
// in the background, so a repo promotes itself on a later view.
const isOwner = (env, user) => user === String(env.GITHUB_USER || '').toLowerCase()

async function feed(env, ctx, user, host) {
  const hide = hideList(env)
  const [who, all] = await Promise.all([profile(user), repos(user)])
  const list = visible(all, user, host, hide)
  // Screenshots are only taken for this deployment's own account. Anyone else's portfolio is
  // small cards, so a visitor cannot spend the account's browser quota or aim it at a URL they
  // control by creating a repo with an arbitrary homepage.
  if (!isOwner(env, user)) return { profile: who, big: [], small: list }
  const cache = caches.default
  const state = await Promise.all(list.map(async r => {
    if (!(await live(r.site))) return false
    if (await cache.match(key(shotKey(user, r.name)))) return true
    // capture() returns null on failure and nulls are never cached, so without this marker a repo
    // that always fails would queue a fresh ~2s browser job on every request, forever.
    const pending = `${user}/pending/${r.name}`
    if (!(await cache.match(key(pending)))) {
      ctx.waitUntil(cache.put(key(pending), new Response('1', { headers: { 'cache-control': `max-age=${PENDING_TTL}` } })))
      ctx.waitUntil(capture(user, r.name, r.site, env))
    }
    return false
  }))
  return {
    profile: who,
    big: list.filter((_, i) => state[i]),
    small: list.filter((_, i) => !state[i]),
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)

    // ?user= names whose portfolio to serve; falls back to the deployment's own account.
    // GitHub usernames are case-insensitive, so normalise before anything caches on them.
    // Otherwise /CpWiLlIs is a distinct cache key and re-captures every screenshot.
    const asked = url.searchParams.get('user')
    const user = String(asked || env.GITHUB_USER || '').toLowerCase()
    if (!user) return new Response('set GITHUB_USER in wrangler.jsonc', { status: 500 })
    if (!validUser(user)) return new Response('bad username', { status: 400 })

    // Stage 2: the page asks for this after it has already painted.
    if (url.pathname === '/api/repos') {
      return Response.json(await feed(env, ctx, user, url.host), {
        headers: { 'cache-control': `max-age=${LIVE_TTL}` },
      })
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
      const name = decodeURIComponent(m[1])
      const r = visible(await repos(user), user, url.host, hideList(env)).find(x => x.name === name)
      if (!r || !safeSite(r.site) || !(await live(r.site))) return new Response(null, { status: 404 })
      return (await capture(user, name, r.site, env)) || new Response(null, { status: 404 })
    }

    return env.ASSETS.fetch(req)
  },
}
