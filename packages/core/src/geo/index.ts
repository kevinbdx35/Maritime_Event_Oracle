import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
// @ts-ignore — @turf/* v6 types not exported via package.json "exports" for NodeNext; works at runtime
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
// @ts-ignore
import { point } from '@turf/helpers'
// @ts-ignore
import type { Feature, FeatureCollection, Polygon } from 'geojson'

const __dirname = dirname(fileURLToPath(import.meta.url))

function mergeGeoJSON(...files: string[]): FeatureCollection {
  const features = files.flatMap(f =>
    (JSON.parse(readFileSync(join(__dirname, f), 'utf8')) as FeatureCollection).features
  )
  return { type: 'FeatureCollection', features }
}

const zones = mergeGeoJSON('./rotterdam.geojson', './ports-fr.geojson', './ports-baltic.geojson')

type ZoneType = 'port' | 'anchorage'

interface Zone {
  feature: Feature<Polygon>
  zone: ZoneType
  name: string
  id?: string
}

function loadZones(): Zone[] {
  return (zones.features as Feature<Polygon>[]).map(f => {
    const z: Zone = {
      feature: f,
      zone:    f.properties?.['zone'] as ZoneType,
      name:    f.properties?.['name'] as string,
    }
    const id = (f.properties?.['id'] ?? f.properties?.['locode']) as string | undefined
    if (id !== undefined) z.id = id
    return z
  })
}

const ALL_ZONES = loadZones()
const PORT_ZONES      = ALL_ZONES.filter(z => z.zone === 'port')
const ANCHORAGE_ZONES = ALL_ZONES.filter(z => z.zone === 'anchorage')

export function isInPort(lat: number, lon: number): boolean {
  const pt = point([lon, lat])
  return PORT_ZONES.some(z => booleanPointInPolygon(pt, z.feature))
}

export function isInAnchorage(lat: number, lon: number): { inside: boolean; zoneId?: string } {
  const pt = point([lon, lat])
  const match = ANCHORAGE_ZONES.find(z => booleanPointInPolygon(pt, z.feature))
  const result: { inside: boolean; zoneId?: string } = { inside: !!match }
  if (match?.id !== undefined) result.zoneId = match.id
  return result
}

export function isInArea(lat: number, lon: number): boolean {
  return isInPort(lat, lon) || isInAnchorage(lat, lon).inside
}

const EARTH_RADIUS_M = 6_371_000

// Great-circle distance in metres (haversine — sub-metre accurate at these scales).
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a))
}

// UN/LOCODE of the port zone containing this position, or null if outside all zones.
export function portFor(lat: number, lon: number): string | null {
  const pt = point([lon, lat])
  const match = PORT_ZONES.find(z => booleanPointInPolygon(pt, z.feature))
  return match?.id ?? null
}
