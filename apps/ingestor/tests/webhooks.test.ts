import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sign, dispatch } from '../src/webhooks.js'
import { eventBus } from '../src/processor.js'
import type { MaritimeEvent } from '@maritime/core'

// ── Mock fetch globally ───────────────────────────────────────────────────────
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ── Helpers ───────────────────────────────────────────────────────────────────
const TEST_SECRET = 'test-hmac-secret'
const TEST_URL    = 'http://localhost:19999/webhook'

function makeEvent(overrides: Partial<MaritimeEvent> = {}): MaritimeEvent {
  return {
    id:     'evt_test_001',
    schema: 'maritime-event/v1',
    vessel: { mmsi: '244820000', name: 'TEST VESSEL' },
    event:  'PORT_ARRIVAL',
    port:   'NLRTM',
    timestamp: new Date().toISOString(),
    confidence: 87,
    confidence_breakdown: { message_density: 100, kinematic_consistency: 90, transponder_history: 60, source_quality: 85, source_corroboration: 80, weighted_score: 87 },
    evidence: { positions_window: [], sources: ['aisstream'], corroboration_sources: [], window_start: '', window_end: '', message_count: 0 },
    signature: 'ed25519:test',
    anchor:  null,
    ...overrides,
  }
}

// ── sign() ────────────────────────────────────────────────────────────────────
describe('sign()', () => {
  it('returns sha256= prefix', () => {
    const result = sign('hello', TEST_SECRET)
    expect(result).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  it('is deterministic for same input', () => {
    expect(sign('payload', TEST_SECRET)).toBe(sign('payload', TEST_SECRET))
  })

  it('differs when secret changes', () => {
    expect(sign('payload', 'secret-a')).not.toBe(sign('payload', 'secret-b'))
  })

  it('differs when payload changes', () => {
    expect(sign('payload-a', TEST_SECRET)).not.toBe(sign('payload-b', TEST_SECRET))
  })
})

// ── dispatch() ────────────────────────────────────────────────────────────────
describe('dispatch()', () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 })
    vi.stubEnv('WEBHOOK_SECRET', TEST_SECRET)
  })
  afterEach(() => { mockFetch.mockClear(); vi.unstubAllEnvs() })

  it('does nothing when WEBHOOK_URLS is empty', async () => {
    vi.stubEnv('WEBHOOK_URLS', '')
    await dispatch(makeEvent())
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('POSTs to each configured URL', async () => {
    vi.stubEnv('WEBHOOK_URLS', `${TEST_URL},http://localhost:19998/hook`)
    await dispatch(makeEvent())
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[0]![0]).toBe(TEST_URL)
    expect(mockFetch.mock.calls[1]![0]).toBe('http://localhost:19998/hook')
  })

  it('sends POST with application/json content-type', async () => {
    vi.stubEnv('WEBHOOK_URLS', TEST_URL)
    await dispatch(makeEvent())
    const opts = mockFetch.mock.calls[0]![1] as RequestInit
    expect(opts.method).toBe('POST')
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('sets X-Maritime-Event header to the event type', async () => {
    vi.stubEnv('WEBHOOK_URLS', TEST_URL)
    await dispatch(makeEvent({ event: 'PORT_DEPARTURE' }))
    const opts = mockFetch.mock.calls[0]![1] as RequestInit
    expect((opts.headers as Record<string, string>)['X-Maritime-Event']).toBe('PORT_DEPARTURE')
  })

  it('body is valid JSON serialisation of the event', async () => {
    vi.stubEnv('WEBHOOK_URLS', TEST_URL)
    const evt = makeEvent({ id: 'evt_json_check', confidence: 92 })
    await dispatch(evt)
    const opts = mockFetch.mock.calls[0]![1] as RequestInit
    const parsed = JSON.parse(opts.body as string)
    expect(parsed.id).toBe('evt_json_check')
    expect(parsed.confidence).toBe(92)
  })

  it('HMAC signature matches expected sha256 of body', async () => {
    vi.stubEnv('WEBHOOK_URLS', TEST_URL)
    const evt = makeEvent()
    await dispatch(evt)
    const opts = mockFetch.mock.calls[0]![1] as RequestInit
    const body = opts.body as string
    const expected = sign(body, TEST_SECRET)
    expect((opts.headers as Record<string, string>)['X-Maritime-Signature']).toBe(expected)
  })

  it('survives a failed fetch without throwing', async () => {
    vi.stubEnv('WEBHOOK_URLS', TEST_URL)
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(dispatch(makeEvent())).resolves.toBeUndefined()
  })
})

// ── setupWebhooks() / eventBus integration ───────────────────────────────────
describe('setupWebhooks() integration', () => {
  afterEach(() => {
    mockFetch.mockClear()
    vi.unstubAllEnvs()
    // Remove all listeners added during test
    eventBus.removeAllListeners('event')
  })

  it('dispatches when event is emitted on eventBus', async () => {
    vi.stubEnv('WEBHOOK_URLS', TEST_URL)
    vi.stubEnv('WEBHOOK_SECRET', TEST_SECRET)
    mockFetch.mockResolvedValue({ ok: true })

    const { setupWebhooks } = await import('../src/webhooks.js')
    setupWebhooks()

    const evt = makeEvent({ id: 'evt_bus_test' })
    eventBus.emit('event', evt)

    // dispatch is async — give it a tick
    await new Promise(r => setImmediate(r))
    expect(mockFetch).toHaveBeenCalledOnce()
    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.id).toBe('evt_bus_test')
  })
})
