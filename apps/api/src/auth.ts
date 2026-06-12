import type { FastifyRequest, FastifyReply } from 'fastify'
import { createHash } from 'crypto'
import { query } from './db.js'

// Routes accessible without an API key
const PUBLIC_PATHS = new Set(['/', '/stream/events', '/api/live', '/api/geo/rotterdam', '/api/geo/ports-fr', '/api/geo/ports-baltic', '/health', '/verify'])
// Exact-shape dashboard routes (vessel panel, track, event modal) — matched as
// full patterns so a future /api/vessels/* or /api/events/* route is not
// silently public by prefix
const PUBLIC_PATTERNS = [
  /^\/api\/vessels\/\d{9}$/,
  /^\/api\/vessels\/\d{9}\/track$/,
  /^\/api\/events\/[A-Za-z0-9_-]+$/,
]

// Per-IP budget for unauthenticated routes, requests per minute
const PUBLIC_RATE_LIMIT = parseInt(process.env['PUBLIC_RATE_LIMIT'] ?? '120')

// Scope required for each keyed resource; 'read' and '*' grant all of them
const SCOPE_RULES: Array<[prefix: string, scope: string]> = [
  ['/events',  'events:read'],
  ['/vessels', 'vessels:read'],
  ['/voyages', 'voyages:read'],
  ['/proofs',  'proofs:read'],
]

// In-memory sliding window: bucket (key id or "ip:<addr>") → { windowStart, count }
const rateLimitWindows = new Map<string, { windowStart: number; count: number }>()
const MAX_WINDOW_ENTRIES = 10_000

async function lookupKey(rawKey: string): Promise<{ id: string; rateLimit: number; scopes: string[] } | null> {
  const hash = createHash('sha256').update(rawKey).digest('hex')
  const result = await query<{ id: string; rate_limit: number; scopes: string[] }>(
    `UPDATE api_keys SET last_used_at = now()
     WHERE key_hash = $1 AND revoked_at IS NULL
     RETURNING id, rate_limit, scopes`,
    [hash],
  )
  const row = result.rows[0]
  if (!row) return null
  return { id: row.id, rateLimit: row.rate_limit, scopes: row.scopes }
}

function checkRateLimit(bucket: string, limitPerMin: number): boolean {
  const now = Date.now()
  const entry = rateLimitWindows.get(bucket)
  if (!entry || now - entry.windowStart > 60_000) {
    // Bound memory: sweep expired windows before tracking yet another bucket
    if (rateLimitWindows.size >= MAX_WINDOW_ENTRIES) {
      for (const [k, v] of rateLimitWindows) {
        if (now - v.windowStart > 60_000) rateLimitWindows.delete(k)
      }
    }
    rateLimitWindows.set(bucket, { windowStart: now, count: 1 })
    return true
  }
  if (entry.count >= limitPerMin) return false
  entry.count++
  return true
}

function hasScope(scopes: string[], required: string): boolean {
  return scopes.includes(required) || scopes.includes('read') || scopes.includes('*')
}

export async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = req.url.split('?')[0]!

  if (PUBLIC_PATHS.has(path) || PUBLIC_PATTERNS.some(rx => rx.test(path))) {
    if (!checkRateLimit(`ip:${req.ip}`, PUBLIC_RATE_LIMIT)) {
      return reply.code(429).send({ error: 'Rate limit exceeded', retryAfterSeconds: 60 })
    }
    return
  }

  // /admin/* authenticates with X-Admin-Secret in its own handlers — requiring
  // an API key here would be circular (creating the first key needs a key).
  // The per-IP window still applies, to slow brute-forcing of the secret.
  if (path === '/admin' || path.startsWith('/admin/')) {
    if (!checkRateLimit(`ip:${req.ip}`, PUBLIC_RATE_LIMIT)) {
      return reply.code(429).send({ error: 'Rate limit exceeded', retryAfterSeconds: 60 })
    }
    return
  }

  const raw = req.headers['x-api-key']
  if (!raw || typeof raw !== 'string') {
    return reply.code(401).send({ error: 'Missing X-Api-Key header' })
  }

  const key = await lookupKey(raw)
  if (!key) {
    return reply.code(401).send({ error: 'Invalid or revoked API key' })
  }

  const rule = SCOPE_RULES.find(([p]) => path === p || path.startsWith(`${p}/`))
  if (rule && !hasScope(key.scopes, rule[1])) {
    return reply.code(403).send({ error: `API key missing required scope: ${rule[1]}` })
  }

  if (!checkRateLimit(key.id, key.rateLimit)) {
    return reply.code(429).send({ error: 'Rate limit exceeded', retryAfterSeconds: 60 })
  }
}
