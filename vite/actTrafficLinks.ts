/**
 * Build-time ACT traffic road-segment geometry extraction, for the
 * congestion overlay (2026-09-08, MercurySwitch's find: ACT's public Addinsight
 * Bluetooth-detector traffic API).
 *
 * Geometry (which roads exist, their shape, free-flow baseline) is static/
 * rarely-changing - baked in at build time, same pattern as GTFS shapes and
 * the ABS population data. Live stats (current speed/delay/congestion) are
 * NOT baked in here - those come from ACTTrafficLoader (a Fabric notebook)
 * into Kusto's TrafficLinkStats table, queried live by trafficService.ts.
 * Splitting it this way means a ~410KB one-time fetch instead of asking
 * every browser session to pull the same ~590KB combined prop+stats file
 * on every poll for numbers that go stale in under a minute anyway.
 *
 * Cached locally (see CACHE_RELATIVE_PATH) for the same reason as the ABS
 * population fetch: road segment definitions don't change often enough to
 * justify hitting a live government-adjacent API on every single build.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const LINKS_GEO_URL = 'http://data.addinsight.com/ACT/links_prop_geo.json';
const CACHE_RELATIVE_PATH = 'vite/cache/act-traffic-links-geo.json';

export interface TrafficLink {
  linkId: number;
  name: string;
  lengthM: number;
  /** Free-flow travel time, seconds - the baseline current TT is compared against to judge how much slower than normal a link is running. */
  minTT: number;
  isFreeway: boolean;
  /** [lat, lon] pairs, matching this codebase's convention elsewhere (ShapePoint, stop coordinates). */
  polyline: [number, number][];
}

interface AddinsightFeature {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  properties: {
    Id: number;
    Name: string;
    Length: number;
    MinTT: number;
    IsFreeway: boolean;
  };
}
interface AddinsightFeatureCollection {
  features: AddinsightFeature[];
}

async function fetchLinksGeo(cachePath: string): Promise<AddinsightFeatureCollection> {
  if (existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, 'utf-8')) as AddinsightFeatureCollection;
  }
  const res = await fetch(LINKS_GEO_URL);
  if (!res.ok) throw new Error(`Addinsight links_prop_geo.json request failed: ${res.status} ${res.statusText}`);
  const raw = await res.text();
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, raw);
  return JSON.parse(raw) as AddinsightFeatureCollection;
}

export async function buildTrafficLinksSnapshot(rootDir: string): Promise<TrafficLink[]> {
  const data = await fetchLinksGeo(resolve(rootDir, CACHE_RELATIVE_PATH));
  const links: TrafficLink[] = [];
  for (const feature of data.features) {
    if (!feature.geometry || feature.geometry.type !== 'LineString') continue;
    links.push({
      linkId: feature.properties.Id,
      name: feature.properties.Name,
      lengthM: feature.properties.Length,
      minTT: feature.properties.MinTT,
      isFreeway: feature.properties.IsFreeway,
      polyline: feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    });
  }
  return links;
}
