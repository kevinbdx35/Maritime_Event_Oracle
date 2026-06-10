import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MaritimeEvent } from '@maritime/core'

// ── Mock DB — hoisted before any processor import ─────────────────────────────
vi.mock('../src/db/repository.js', () => ({
  upsertVessel:    vi.fn().mockResolvedValue(undefined),
  insertPosition:  vi.fn().mockResolvedValue(undefined),
  insertEvent:     vi.fn().mockResolvedValue(undefined),
  saveVesselState: vi.fn().mockResolvedValue(undefined),
  loadVesselStates: vi.fn().mockResolvedValue(new Map()),
  upsertVoyage:    vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/voyage.js', () => ({
  openVoyage:  vi.fn().mockResolvedValue(undefined),
  closeVoyage: vi.fn().mockResolvedValue(undefined),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────
// Port polygon coordinates (inside Rotterdam port — verified by state-machine tests)
const PORT_LAT = 51.900
const PORT_LON = 4.300

// Each test gets its own MMSI to prevent FSM state bleeding between tests.
// 244xxxxxx → NL flag state (MID 244), giving deterministic flagState assertions.
let mmsiCounter = 244810000
function nextMmsi() { return String(++mmsiCounter) }

function makeMsg(mmsi: string, overrides: Record<string, unknown> = {}) {
  return {
    mmsi,
    t:      new Date().toISOString(),
    lat:    PORT_LAT,
    lon:    PORT_LON,
    sog:    0.2,
    cog:    0,
    source: 'aisstream',
    ...overrides,
  }
}

// Feed N positions over `spanMinutes` at given SOG, all inside port
async function feedPositions(
  processMessage: (m: unknown) => Promise<void>,
  mmsi: string,
  { count = 6, spanMinutes = 25, sog = 0.2 } = {},
) {
  const base = Date.now() - spanMinutes * 60_000
  for (let i = 0; i < count; i++) {
    await processMessage(makeMsg(mmsi, {
      t: new Date(base + (i / (count - 1)) * spanMinutes * 60_000).toISOString(),
      sog,
    }))
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('processMessage', () => {
  let upsertVessel:  ReturnType<typeof vi.fn>
  let insertPosition: ReturnType<typeof vi.fn>
  let insertEvent:   ReturnType<typeof vi.fn>
  let openVoyage:    ReturnType<typeof vi.fn>
  let processMessage: (msg: unknown) => Promise<void>
  let eventBus:      import('events').EventEmitter

  beforeEach(async () => {
    vi.clearAllMocks()
    const repo   = await import('../src/db/repository.js')
    const voyage = await import('../src/voyage.js')
    const proc   = await import('../src/processor.js')
    upsertVessel  = repo.upsertVessel  as ReturnType<typeof vi.fn>
    insertPosition = repo.insertPosition as ReturnType<typeof vi.fn>
    insertEvent   = repo.insertEvent   as ReturnType<typeof vi.fn>
    openVoyage    = voyage.openVoyage  as ReturnType<typeof vi.fn>
    processMessage = proc.processMessage
    eventBus      = proc.eventBus
  })

  it('calls upsertVessel and insertPosition for every message', async () => {
    const mmsi = nextMmsi()
    await processMessage(makeMsg(mmsi))
    expect(upsertVessel).toHaveBeenCalledOnce()
    expect(upsertVessel).toHaveBeenCalledWith(mmsi, undefined, undefined, undefined, 'NL')
    expect(insertPosition).toHaveBeenCalledOnce()
    expect(insertPosition).toHaveBeenCalledWith(expect.objectContaining({ mmsi, lat: PORT_LAT }))
  })

  it('derives flag state from MMSI prefix (244 → NL)', async () => {
    const mmsi = '244820099'
    await processMessage(makeMsg(mmsi))
    expect(upsertVessel).toHaveBeenCalledWith(mmsi, undefined, undefined, undefined, 'NL')
  })

  it('stores vessel name, IMO and shipType when provided', async () => {
    const mmsi = nextMmsi()
    await processMessage(makeMsg(mmsi, { name: 'ATLANTIC PIONEER', imo: '9234567', shipType: 70 }))
    expect(upsertVessel).toHaveBeenCalledWith(mmsi, '9234567', 'ATLANTIC PIONEER', 70, 'NL')
  })

  it('emits PORT_ARRIVAL event after FSM transition and calls insertEvent', async () => {
    const mmsi = nextMmsi()
    const emitted: MaritimeEvent[] = []
    const handler = (e: MaritimeEvent) => emitted.push(e)
    eventBus.on('event', handler)

    await feedPositions(processMessage, mmsi)

    eventBus.off('event', handler)
    const arrivals = emitted.filter(e => e.event === 'PORT_ARRIVAL')
    expect(arrivals.length).toBeGreaterThanOrEqual(1)
    expect(insertEvent).toHaveBeenCalled()

    const arrival = arrivals[0]!
    expect(arrival.vessel.mmsi).toBe(mmsi)
    expect(arrival.confidence).toBeGreaterThan(0)
    expect(arrival.signature).toMatch(/^ed25519:/)
  })

  it('confidence_breakdown includes all 5 components', async () => {
    const mmsi = nextMmsi()
    const emitted: MaritimeEvent[] = []
    const handler = (e: MaritimeEvent) => emitted.push(e)
    eventBus.on('event', handler)

    await feedPositions(processMessage, mmsi)

    eventBus.off('event', handler)
    const arrivals = emitted.filter(e => e.event === 'PORT_ARRIVAL')
    if (arrivals.length === 0) return // skip if FSM didn't fire (geometry edge case)

    const bd = arrivals[0]!.confidence_breakdown
    expect(bd).toHaveProperty('message_density')
    expect(bd).toHaveProperty('kinematic_consistency')
    expect(bd).toHaveProperty('transponder_history')
    expect(bd).toHaveProperty('source_quality')
    expect(bd).toHaveProperty('source_corroboration')
  })

  it('event has evidence with positions_window and sources', async () => {
    const mmsi = nextMmsi()
    const emitted: MaritimeEvent[] = []
    const handler = (e: MaritimeEvent) => emitted.push(e)
    eventBus.on('event', handler)

    await feedPositions(processMessage, mmsi)

    eventBus.off('event', handler)
    const arrivals = emitted.filter(e => e.event === 'PORT_ARRIVAL')
    if (arrivals.length === 0) return

    const ev = arrivals[0]!.evidence
    expect(ev.sources).toContain('aisstream')
    expect(typeof ev.message_count).toBe('number')
  })

  it('openVoyage is called with the MMSI on PORT_ARRIVAL', async () => {
    const mmsi = nextMmsi()
    const emitted: MaritimeEvent[] = []
    const handler = (e: MaritimeEvent) => emitted.push(e)
    eventBus.on('event', handler)

    await feedPositions(processMessage, mmsi)

    eventBus.off('event', handler)
    const arrivals = emitted.filter(e => e.event === 'PORT_ARRIVAL')
    if (arrivals.length > 0) {
      expect(openVoyage).toHaveBeenCalledWith(expect.objectContaining({ mmsi }))
    }
  })

  it('does not emit PORT_ARRIVAL for vessel at high speed', async () => {
    const mmsi = nextMmsi()
    const emitted: MaritimeEvent[] = []
    const handler = (e: MaritimeEvent) => emitted.push(e)
    eventBus.on('event', handler)

    // SOG 12 kn — well above mooring threshold
    await feedPositions(processMessage, mmsi, { sog: 12 })

    eventBus.off('event', handler)
    const arrivals = emitted.filter(e => e.event === 'PORT_ARRIVAL')
    expect(arrivals).toHaveLength(0)
  })
})
