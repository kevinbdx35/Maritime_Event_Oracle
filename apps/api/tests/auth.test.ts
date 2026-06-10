import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

// Real auth module — but mock its DB dependency
vi.mock('../src/db.js', () => ({
  query: vi.fn(),
}))

import { query } from '../src/db.js'
const mockQuery = query as ReturnType<typeof vi.fn>

async function buildApp() {
  const app = Fastify({ logger: false })
  const { authHook } = await import('../src/auth.js')
  app.addHook('onRequest', authHook)
  // Minimal route under auth
  app.get('/events', async () => ({ data: [] }))
  // Public route
  app.get('/api/live', async () => ({ vessels: [] }))
  return app
}

describe('Auth middleware', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('allows public routes without X-Api-Key', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/live' })
    expect(res.statusCode).toBe(200)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects protected route when header is missing', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/events' })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toMatch(/Missing X-Api-Key/i)
  })

  it('rejects with invalid key', async () => {
    mockQuery.mockResolvedValue({ rows: [] }) // no matching key
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/events', headers: { 'x-api-key': 'meo_invalid' } })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toMatch(/Invalid or revoked/i)
  })

  it('allows request with valid key', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'key_test', rate_limit: 100, scopes: ['read'] }] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/events', headers: { 'x-api-key': 'meo_validkey' } })
    expect(res.statusCode).toBe(200)
  })

  it('passes SHA-256 hash of the key to the DB query', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'key_test', rate_limit: 100, scopes: ['read'] }] })
    const app = await buildApp()
    const rawKey = 'meo_abc123'
    await app.inject({ method: 'GET', url: '/events', headers: { 'x-api-key': rawKey } })

    const { createHash } = await import('crypto')
    const expectedHash = createHash('sha256').update(rawKey).digest('hex')
    const sql   = mockQuery.mock.calls[0]?.[0] as string
    const params = mockQuery.mock.calls[0]?.[1] as string[]
    expect(sql).toContain('key_hash')
    expect(params[0]).toBe(expectedHash)
  })

  it('enforces rate limit after N requests', async () => {
    // Always return a valid key with rate_limit=2
    mockQuery.mockResolvedValue({ rows: [{ id: 'key_rl', rate_limit: 2, scopes: ['read'] }] })
    const app = await buildApp()
    const headers = { 'x-api-key': 'meo_ratelimitkey' }

    const r1 = await app.inject({ method: 'GET', url: '/events', headers })
    const r2 = await app.inject({ method: 'GET', url: '/events', headers })
    const r3 = await app.inject({ method: 'GET', url: '/events', headers })

    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)
    expect(r3.statusCode).toBe(429)
    expect(r3.json().error).toMatch(/Rate limit/i)
  })
})
