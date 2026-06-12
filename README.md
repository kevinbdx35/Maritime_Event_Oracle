# Maritime Event Oracle

**Version 0.2.0** — multi-source consensus, multi-port coverage (Rotterdam · France · Gulf of Finland)

A business API that **certifies maritime events** — port arrivals, departures, anchorages, and AIS gaps — with explainable confidence scores and hourly Merkle anchoring on Base Sepolia testnet.

**Target clients:** sanctions compliance (banks, P&I clubs), parametric insurance, trade finance, decarbonisation verifiers (Katalist / Book & Claim).

![Live dashboard — Rotterdam zone with vessel detail panel and real-time event feed](docs/assets/dashboard.png)

---

## What It Does

1. **Ingests** real-time AIS data from multiple sources via a plug-and-play connector registry (AISStream.io WebSocket, AISHub HTTP polling, Digitraffic Marine open data).
2. **Corroborates** every vessel across sources — a consensus gate requires ≥ 2 independent sources within a 5-minute window before events are generated (60 s single-source fallback).
3. **Detects** port calls via a per-vessel finite state machine with hysteresis filtering.
4. **Scores** each event with a 5-component explainable confidence score.
5. **Signs** every event with an Ed25519 key — unforgeable without the private key.
6. **Anchors** hourly batches on-chain via a Merkle root — immutable once confirmed.
7. **Tracks** full voyages: geodesic distance, speed profile, time breakdown (underway / anchored / moored).
8. **Serves** a REST API (with API-key auth) and a live Leaflet dashboard: multi-zone navigation, course-oriented markers with corroboration badges, vessel tracks + speed sparklines, and per-event confidence/Merkle-proof inspection.

---

## Architecture

```
AISStream.io  ──┐
AISHub  ────────┼──► Connector registry (plug-and-play AISConnector modules)
Digitraffic ────┘         │
                          │ AISMessage (Zod-validated)
                          ▼
                    ConsensusGate                 ← ≥ 2 sources in 5-min window
                          │                         (60 s single-source fallback)
                          ▼
                    CorroborationTracker          ← 10-min sliding window per MMSI
                          │
                          ▼
                    VesselStateMachine            ← per-MMSI FSM with hysteresis
                    UNKNOWN → APPROACHING
                    → PORT_ARRIVAL  → MOORED
                    ⇄ ANCHORED
                    → PORT_DEPARTURE → DEPARTED
                          │ transition
                          ▼
                    ConfidenceScorer              ← 5 weighted components
                          │
                          ▼
                    Ed25519 sign ──► TimescaleDB  ← positions hypertable
                                         │          events / voyages tables
                                         ▼
                                    Fastify REST API
                                    /events  /vessels
                                    /proofs  /voyages
                                    GET /  (Leaflet dashboard)
                                         │
                    anchor-worker ───────┘
                    (cron: every 1 h)
                    Merkle tree → MerkleAnchor.sol
                                  anchorRoot(batchId, root, from, to, count)
                                         │
                                    Base Sepolia
```

### Monorepo layout

```
apps/
  ingestor/       AIS connectors + registry, consensus gate, FSM, voyage tracking
  api/            Fastify REST API + live dashboard
  anchor-worker/  Hourly Merkle anchoring to EVM chain
packages/
  core/           Shared types, FSM, scoring, crypto, geo (Rotterdam + French ports polygons)
contracts/
  src/MerkleAnchor.sol   Stores Merkle roots on-chain
  src/OracleConsumer.sol Example consumer contract
scripts/
  deploy-anchor.ts  Deploy MerkleAnchor (no Forge needed, uses compiled artifact)
  create-key.ts     Generate API keys
  seed-db.ts        Replay fixture scenario into DB (demo without live AIS key)
fixtures/
  rotterdam-scenario.ndjson  600 AIS messages, 8 vessels, 4 port calls
```

---

## Coverage

| Region | Port zones | Anchorages | Sources |
|---|---|---|---|
| **Rotterdam** | NLRTM | Maas anchorages | AISStream |
| **France — Channel** | Le Havre, Rouen, Dunkerque, Calais, Saint-Malo | Rade de Cherbourg | AISStream |
| **France — Atlantic** | Nantes, Saint-Nazaire, La Rochelle, Bordeaux, Lorient, Quiberon | Rade de Brest, Golfe du Morbihan | AISStream |
| **France — Mediterranean** | Marseille, Fos-sur-Mer | — | AISStream |
| **Gulf of Finland** | Helsinki (FIHEL), Tallinn (EETLL) | — | AISStream + Digitraffic — **dual-source corroborated events** |

Event `port` codes are resolved from the position window via `portFor()` (UN/LOCODE per zone polygon). Zone polygons live in `packages/core/src/geo/*.geojson` — adding a port is one GeoJSON feature.

---

## Quickstart

### Prerequisites

- Node.js 20+ and [pnpm](https://pnpm.io/)
- Docker / Podman (for TimescaleDB + Anvil)

### 1. Clone and install

```bash
git clone https://github.com/your-org/maritime-event-oracle.git
cd maritime-event-oracle
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum set EVT_SIGNING_KEY and EVT_PUBLIC_KEY:
node -e "
  const { generateKeypair } = await import('@maritime/core');
  const k = generateKeypair();
  console.log('EVT_SIGNING_KEY=' + k.privateKey);
  console.log('EVT_PUBLIC_KEY='  + k.publicKey);
"
```

### 3. Start infrastructure

```bash
docker compose up -d          # TimescaleDB on :5432, Anvil on :8545
pnpm db:migrate               # apply schema (TimescaleDB hypertable + all tables)
```

### 4. Deploy the anchor contract

```bash
pnpm deploy-anchor            # deploys MerkleAnchor to Anvil, writes MERKLE_ANCHOR_ADDRESS to .env
```

### 5. Start services

```bash
# In three separate terminals (or use a process manager):
pnpm --filter @maritime/ingestor start   # AIS ingestor
pnpm --filter @maritime/api start        # REST API + dashboard on :3000
pnpm --filter @maritime/anchor-worker start  # hourly Merkle anchoring
```

Open **http://localhost:3000** for the live Leaflet dashboard.

### Demo mode (no AIS key needed)

Replay the bundled Rotterdam scenario directly into the database:

```bash
pnpm seed-db
pnpm --filter @maritime/api start
# open http://localhost:3000
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `EVT_SIGNING_KEY` | **yes** | Ed25519 private key (64 hex chars) |
| `EVT_PUBLIC_KEY` | **yes** | Matching public key (64 hex chars) |
| `AISSTREAM_API_KEY` | live mode | AISStream.io WebSocket key (free tier, [register](https://aisstream.io)) |
| `AISHUB_API_KEY` | optional | AISHub polling key (free, adds corroboration score) |
| `DIGITRAFFIC_USER` | optional | Digitraffic Marine (Finland, open data) — set any app name to enable, no key needed |
| `CONSENSUS_MIN_SOURCES` | optional | Distinct sources required before FSM events (default: `2`) |
| `DB_HOST/PORT/NAME/USER/PASSWORD` | **yes** | PostgreSQL/TimescaleDB connection |
| `ANCHOR_RPC_URL` | anchor | RPC URL — Anvil (`http://localhost:8545`) or Base Sepolia |
| `ANCHOR_PRIVATE_KEY` | anchor | Ethereum private key for tx submission |
| `MERKLE_ANCHOR_ADDRESS` | anchor | Contract address (set by `pnpm deploy-anchor`) |
| `PORT` | optional | API port (default: `3000`) |
| `ADMIN_SECRET` | optional | Protects `/admin/keys` endpoint (`openssl rand -hex 32`) |
| `WEBHOOK_URLS` | optional | Comma-separated endpoints for push delivery |
| `WEBHOOK_SECRET` | optional | HMAC-SHA256 secret for webhook signatures |

See `.env.example` for a fully annotated template.

---

## API Reference

All endpoints except the dashboard, SSE feed, and live vessel map require an `X-Api-Key` header.

### Generate an API key

```bash
pnpm create-key "my-client" read 200
# → prints the raw key once; store it securely
```

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | public | Live Leaflet dashboard |
| `GET` | `/stream/events` | public | SSE feed — one event per push |
| `GET` | `/api/live` | public | Current vessel positions, active sources per vessel + stats |
| `GET` | `/api/geo/rotterdam` | public | Rotterdam port/anchorage GeoJSON |
| `GET` | `/api/geo/ports-fr` | public | French ports GeoJSON |
| `GET` | `/api/geo/ports-baltic` | public | Baltic ports GeoJSON (dual-source consensus zone) |
| `GET` | `/api/vessels/:mmsi` | public | Vessel detail: state, recent events, active sources (5-min window) |
| `GET` | `/api/vessels/:mmsi/track` | public | 6-hour track, 2-min buckets (dashboard trail + speed sparkline) |
| `GET` | `/api/events/:id` | public | Event detail: confidence breakdown, evidence, Merkle proof (dashboard modal) |
| `GET` | `/events` | key | Paginated event list (`type`, `mmsi`, `from`, `to`, `limit`, `cursor`) |
| `GET` | `/events/:id` | key | Single event with full Merkle proof |
| `GET` | `/vessels/:mmsi/events` | key | Events for a specific vessel |
| `GET` | `/proofs/:batchId` | key | Batch root + all event proofs |
| `GET` | `/voyages/:id/summary` | key | Signed voyage summary |
| `POST` | `/admin/keys` | admin | Create API key |
| `GET` | `/admin/keys` | admin | List API keys |
| `DELETE` | `/admin/keys/:id` | admin | Revoke API key |

Admin endpoints require `X-Admin-Secret` header matching the `ADMIN_SECRET` env var.

---

## Event Format

```json
{
  "id": "evt_00180f12300001ab3c",
  "schema": "maritime-event/v1",
  "vessel": {
    "mmsi": "244820000",
    "imo": "9234567",
    "name": "ATLANTIC PIONEER"
  },
  "event": "PORT_ARRIVAL",
  "port": "NLRTM",
  "timestamp": "2026-06-10T07:35:00.000Z",
  "confidence": 87.3,
  "confidence_breakdown": {
    "message_density": 100,
    "kinematic_consistency": 95.2,
    "transponder_history": 58.3,
    "source_quality": 85,
    "source_corroboration": 80,
    "weighted_score": 87.3
  },
  "evidence": {
    "positions_window": [...],
    "sources": ["aisstream"],
    "corroboration_sources": ["aisstream", "aishub"],
    "window_start": "2026-06-10T07:30:00.000Z",
    "window_end": "2026-06-10T07:35:00.000Z",
    "message_count": 6
  },
  "signature": "ed25519:a3f9...",
  "anchor": {
    "batchId": "batch_20260610T0700",
    "merkleRoot": "6eb63cb7...",
    "txHash": "0x675d693b...",
    "blockNumber": 8914,
    "proof": ["0xabc...", "0xdef..."]
  }
}
```

### Event types

| Type | Meaning |
|---|---|
| `PORT_ARRIVAL` | Vessel entered port zone (SOG < 0.5 kn sustained) |
| `PORT_DEPARTURE` | Vessel left port zone with speed-up |
| `ANCHORAGE_ENTRY` | Vessel anchored in designated anchorage area |
| `ANCHORAGE_EXIT` | Vessel departed anchorage |
| `AIS_GAP` | Transponder silence > 30 min while in area |

---

## Confidence Score

Five components, weights sum to 1.00:

| Component | Weight | Description |
|---|---|---|
| `message_density` | 30% | AIS messages in ±10 min window (saturates at 12 msgs) |
| `kinematic_consistency` | 25% | Speed/course changes physically plausible |
| `transponder_history` | 18% | Minutes tracking this MMSI (saturates at 120 min) |
| `source_quality` | 12% | Static score per source (AISStream 85, Digitraffic 82, AISHub 80, satellite 70) |
| `source_corroboration` | 15% | Independent sources that saw this MMSI in last 10 min (2 sources → 80/100) |

Weights live in `packages/core/src/scoring/weights.ts`.

---

## Voyage Summary

When a vessel completes a port call (ARRIVAL → DEPARTURE), the oracle automatically produces a signed summary:

```json
{
  "id": "voy_...",
  "schema": "voyage-summary/v1",
  "vessel": { "mmsi": "...", "name": "ATLANTIC PIONEER" },
  "port": "NLRTM",
  "period": { "from": "...", "to": "..." },
  "distance_nm": 12.4,
  "speed_profile": { "p50_knots": 4.2, "p95_knots": 8.1, "samples": 310 },
  "time_breakdown": {
    "total_hours": 18.5,
    "underway_hours": 3.2,
    "anchored_hours": 6.1,
    "moored_hours": 9.2
  },
  "signature": "ed25519:...",
  "anchor": null
}
```

---

## Flag State

MMSI prefixes (Maritime Identification Digits) are resolved to ISO 3166-1 alpha-2 flag states via `packages/core/src/geo/mid.ts` (~150 MID codes, ~95% Rotterdam traffic coverage). Flag state is stored on the `vessels` table and returned in vessel API responses.

---

## Threat Model

### What the proof guarantees

- The event was **observed** by the oracle at the stated timestamp.
- The event was **signed** by the oracle's Ed25519 key — unforgeable without the private key.
- The event is **immutably committed** on-chain via the Merkle root.
- The on-chain transaction provides an **independent time witness** (block timestamp + block hash).

### What the proof does NOT guarantee

- **Garbage in, garbage out** — if the AIS transponder is spoofed or the feed is compromised, the oracle certifies false data. Kinematic consistency checks detect many spoofs but not all.
- **MMSI identity** — an MMSI can be reused or faked. IMO cross-referencing reduces (not eliminates) this risk.
- **Coverage gaps** — terrestrial AIS has blind spots. `AIS_GAP` events flag these explicitly.
- **The oracle operator** — the signing key holder can submit events. Key rotation, multi-sig anchoring (post-MVP), and external audit logs mitigate this.
- **Fuel consumption** — the voyage summary provides activity data, not direct fuel measurement.

---

## Development

```bash
pnpm test:core           # unit tests (FSM, scoring, Merkle)
pnpm build               # TypeScript compilation (all packages)
```

### Adding a new AIS source

Create `apps/ingestor/src/connectors/<name>.ts` — extend `AISConnector` and export a `descriptor` + `create()`:

```typescript
import type { ConnectorDescriptor } from './base.js'
import { AISConnector } from './base.js'

export class MySourceConnector extends AISConnector {
  readonly name = 'mysource'

  async start(): Promise<void> {
    // connect and call this.emitMessage(msg) for each AIS position
  }

  stop(): void { /* disconnect */ }
}

export const descriptor: ConnectorDescriptor = {
  name:        'mysource',
  envKey:      'MYSOURCE_API_KEY',  // connector activates only when this env var is set
  description: 'What this source provides',
  transport:   'websocket',         // or 'http-poll' | 'mqtt' | 'file'
}

export function create(apiKey: string): MySourceConnector {
  return new MySourceConnector(apiKey)
}
```

Then add one import + one entry to `REGISTRY` in `apps/ingestor/src/connectors/registry.ts` — that's it. The consensus gate and `CorroborationTracker` automatically pick up the new source name. Optionally add a quality score for it in `packages/core/src/scoring/weights.ts` (unknown sources default to 50).

---

## Post-MVP Roadmap

| Feature | Description |
|---|---|
| Satellite AIS | Integrate Spire/exactEarth; lower `source_quality` score (higher latency) |
| STS transfer detection | Ship-to-ship transfers via proximity + simultaneous low speed |
| AIS spoofing detection | Cross-check trajectory against Kalman-filter prediction |
| Chainlink adapter | Live parametric insurance pay-outs on arrival delay |
| More ports | Mediterranean & Iberian coverage; per-port FSM tuning |
| Base Mainnet | Migrate from Sepolia; add multi-sig anchor submission |
| MMSI/IMO verification | Cross-reference Lloyd's Register / IHS Markit |

---

## License

MIT — see [LICENSE](LICENSE).
