import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

// ── Mock DB ───────────────────────────────────────────────────────────────────
vi.mock('../src/db.js', () => ({
  query: vi.fn(),
}))

// Mock auth to bypass key checks for route-specific tests
vi.mock('../src/auth.js', () => ({
  authHook: vi.fn().mockResolvedValue(undefined),
}))

import { query } from '../src/db.js'
const mockQuery = query as ReturnType<typeof vi.fn>

async function buildApp() {
  const app = Fastify({ logger: false })
  const { authHook }        = await import('../src/auth.js')
  const { dashboardRoutes } = await import('../src/routes/dashboard.js')
  const { eventsRoutes }    = await import('../src/routes/events.js')
  const { vesselsRoutes }   = await import('../src/routes/vessels.js')
  app.addHook('onRequest', authHook)
  await app.register(dashboardRoutes)
  await app.register(eventsRoutes)
  await app.register(vesselsRoutes)
  return app
}

// ── /api/vessels/:mmsi ────────────────────────────────────────────────────────
describe('GET /api/vessels/:mmsi', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns vessel data for known MMSI', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ mmsi: '244820000', imo: '9234567', name: 'ATLANTIC PIONEER', ship_type: 70, flag_state: 'NL', first_seen: '2026-06-01T00:00:00Z', last_seen: '2026-06-10T00:00:00Z' }] })
      .mockResolvedValueOnce({ rows: [{ state: 'MOORED' }] })
      .mockResolvedValueOnce({ rows: [{ event_type: 'PORT_ARRIVAL', timestamp: '2026-06-10T07:35:00Z', confidence: 87 }] })
      .mockResolvedValueOnce({ rows: [{ n: '3' }] })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/vessels/244820000' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.mmsi).toBe('244820000')
    expect(body.name).toBe('ATLANTIC PIONEER')
    expect(body.flagState).toBe('NL')
    expect(body.state).toBe('MOORED')
    expect(body.shipType).toBe(70)
    expect(body.voyageCount).toBe(3)
    expect(body.recentEvents).toHaveLength(1)
  })

  it('returns 404 for unknown MMSI', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/vessels/000000000' })
    expect(res.statusCode).toBe(404)
  })
})

// ── GET /events ───────────────────────────────────────────────────────────────
describe('GET /events', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns paginated list', async () => {
    const fakeRow = { id: 'evt_1', mmsi: '244820000', vessel_name: 'TEST', event_type: 'PORT_ARRIVAL', port: 'NLRTM', timestamp: '2026-06-10T00:00:00Z', confidence: 80, confidence_breakdown: {}, evidence: {}, signature: 'ed25519:x', merkle_root: null, tx_hash: null, block_number: null, anchor_batch_id: null, hash_algo: null }
    mockQuery.mockResolvedValue({ rows: [fakeRow] })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/events?limit=10' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe('evt_1')
    expect(body.pagination.limit).toBe(10)
  })

  it('filters by event type', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()
    await app.inject({ method: 'GET', url: '/events?type=PORT_ARRIVAL' })

    const sql = mockQuery.mock.calls[0]?.[0] as string
    expect(sql).toContain('event_type')
    const params = mockQuery.mock.calls[0]?.[1] as unknown[]
    expect(params).toContain('PORT_ARRIVAL')
  })

  it('filters by MMSI', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()
    await app.inject({ method: 'GET', url: '/events?mmsi=244820000' })

    const params = mockQuery.mock.calls[0]?.[1] as unknown[]
    expect(params).toContain('244820000')
  })

  it('caps limit at 200', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()
    await app.inject({ method: 'GET', url: '/events?limit=9999' })

    const params = mockQuery.mock.calls[0]?.[1] as unknown[]
    expect(params[params.length - 1]).toBe(201) // 200+1 for hasMore check
  })
})

// ── GET /events/:id ───────────────────────────────────────────────────────────
describe('GET /events/:id', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns 404 for unknown event id', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/events/evt_nonexistent' })
    expect(res.statusCode).toBe(404)
  })

  it('returns event with anchor info when anchored', async () => {
    const row = {
      id: 'evt_anchored', mmsi: '244820000', vessel_name: 'SHIP', event_type: 'PORT_DEPARTURE',
      port: 'NLRTM', timestamp: '2026-06-10T12:00:00Z', confidence: 75,
      confidence_breakdown: {}, evidence: {}, signature: 'ed25519:x',
      anchor_batch_id: 'batch_001', merkle_root: 'abc123', tx_hash: '0xdef456',
      block_number: 8914, hash_algo: 'sha256',
    }
    mockQuery.mockResolvedValue({ rows: [row] })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/events/evt_anchored' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.anchor.merkleRoot).toBe('abc123')
    expect(body.anchor.txHash).toBe('0xdef456')
    expect(body.anchor.blockNumber).toBe(8914)
  })
})

// ── GET /vessels/:mmsi/events ─────────────────────────────────────────────────
describe('GET /vessels/:mmsi/events', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns 400 for invalid MMSI', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/vessels/bad/events' })
    expect(res.statusCode).toBe(400)
  })

  it('returns vessel events list', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'evt_v1', event_type: 'PORT_ARRIVAL' }] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/vessels/244820000/events' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.mmsi).toBe('244820000')
    expect(body.events).toHaveLength(1)
  })
})
