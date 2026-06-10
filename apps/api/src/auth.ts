import type { FastifyRequest, FastifyReply } from 'fastify'
import { createHash } from 'crypto'
import { query } from './db.js'

// Routes accessible without an API key
const PUBLIC_PATHS = new Set(['/', '/stream/events', '/api/live', '/api/geo/rotterdam'])
// Prefix-matched public routes (vessel detail panel uses these from the browser)
const PUBLIC_PREFIXES = ['/api/vessels/']

// In-memory sliding window: keyId → { windowStart, count }
const rateLimitWindows = new Map<string, { windowStart: number; count: number }>()

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

function checkRateLimit(keyId: string, limitPerMin: number): boolean {
  const now = Date.now()
  const entry = rateLimitWindows.get(keyId)
  if (!entry || now - entry.windowStart > 60_000) {
    rateLimitWindows.set(keyId, { windowStart: now, count: 1 })
    return true
  }
  if (entry.count >= limitPerMin) return false
  entry.count++
  return true
}

export async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = req.url.split('?')[0]!
  if (PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some(p => path.startsWith(p))) return

  const raw = req.headers['x-api-key']
  if (!raw || typeof raw !== 'string') {
    return reply.code(401).send({ error: 'Missing X-Api-Key header' })
  }

  const key = await lookupKey(raw)
  if (!key) {
    return reply.code(401).send({ error: 'Invalid or revoked API key' })
  }

  if (!checkRateLimit(key.id, key.rateLimit)) {
    return reply.code(429).send({ error: 'Rate limit exceeded', retryAfterSeconds: 60 })
  }
}
