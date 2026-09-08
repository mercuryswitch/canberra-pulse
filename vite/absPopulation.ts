/**
 * Build-time ABS Census population extraction, for the #4 equity overlay
 * (2026-09-08): "how is population spread across the city, and where does
 * that not match actual bus service."
 *
 * Unlike the GTFS static data, this needs no credentials and no shapefile
 * wrangling - ABS hosts the 2021 Census G01 (population) table already
 * joined to SA1 (Statistical Area 1, ~200-800 people each - the finest
 * standard Census geography, a reasonable match for the heat map's own
 * ~100m grid) boundaries in a live, public ArcGIS FeatureServer, filterable
 * server-side to just the ACT and exportable directly as GeoJSON. Confirmed
 * directly before writing this: 1227 real ACT SA1 polygons, population sum
 * 453,741 - matches Canberra's published 2021 Census population (452,670)
 * closely enough to trust the data. maxRecordCount on this service is 2000,
 * comfortably above the ACT's 1227 records, so this is a single request,
 * no pagination needed.
 */
const ABS_SA1_POPULATION_URL =
  'https://geo.abs.gov.au/arcgis/rest/services/Hosted/ABS_2021_Census_G01_SA1/FeatureServer/0/query';

export interface PopulationCell {
  sa1Code: string;
  /** SA2 name (e.g. "Gungahlin") - a real, recognisable locality name. SA1 itself has no name of its own in the ABS data, just a numeric code, so several SA1s legitimately share the same areaName (a suburb is usually split into several SA1s). */
  areaName: string;
  population: number;
  /** Approximate area, via a planar shoelace estimate scaled by degree-to-metre conversion at this polygon's own latitude - fine for a density visualization, not a survey-grade measurement. */
  areaSqKm: number;
  centroidLat: number;
  centroidLon: number;
  /** Outer ring only, [lat, lon] pairs - ABS SA1 polygons are simple enough in practice that inner rings (holes) aren't worth the extra complexity here. */
  polygon: [number, number][];
}

export interface PopulationSnapshot {
  generatedAt: string;
  totalPopulation: number;
  cells: PopulationCell[];
}

type GeoJsonPolygon = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] };
interface AbsFeature {
  type: 'Feature';
  properties: { sa1_code_2021: string; sa2_name_2021: string | null; tot_p_p: number | null };
  geometry: GeoJsonPolygon | null;
}
interface AbsFeatureCollection {
  features: AbsFeature[];
}

// Rounding to 6 decimal places is ~0.1m at this latitude - far finer than
// anything this visualization needs, but shrinks the very long raw
// coordinates the API returns (17 significant digits) substantially.
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Planar shoelace area of a single ring, scaled to km² using an equirectangular approximation - consistent with the same approach shapeService.ts already uses for distance, just applied to area instead. */
function ringAreaSqKm(ring: number[][]): number {
  if (ring.length < 3) return 0;
  const refLat = ring[0][1];
  const cosRef = Math.cos((refLat * Math.PI) / 180);
  const KM_PER_DEG_LAT = 111.32;
  const KM_PER_DEG_LON = 111.32 * cosRef;
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % ring.length];
    area += lon1 * KM_PER_DEG_LON * (lat2 * KM_PER_DEG_LAT) - lon2 * KM_PER_DEG_LON * (lat1 * KM_PER_DEG_LAT);
  }
  return Math.abs(area) / 2;
}

function ringCentroid(ring: number[][]): { lat: number; lon: number } {
  let sumLat = 0;
  let sumLon = 0;
  for (const [lon, lat] of ring) {
    sumLat += lat;
    sumLon += lon;
  }
  return { lat: sumLat / ring.length, lon: sumLon / ring.length };
}

/** The outer ring of a Polygon, or the largest outer ring of a MultiPolygon (a handful of SA1s are split, e.g. by a river or lake - the biggest part is what matters for a density visualization). */
function outerRing(geom: GeoJsonPolygon): number[][] {
  if (geom.type === 'Polygon') return geom.coordinates[0];
  let best = geom.coordinates[0][0];
  let bestArea = ringAreaSqKm(best);
  for (const poly of geom.coordinates) {
    const area = ringAreaSqKm(poly[0]);
    if (area > bestArea) {
      best = poly[0];
      bestArea = area;
    }
  }
  return best;
}

export async function buildPopulationSnapshot(): Promise<PopulationSnapshot> {
  const url = new URL(ABS_SA1_POPULATION_URL);
  url.searchParams.set('where', "state_name_2021='Australian Capital Territory'");
  url.searchParams.set('outFields', 'sa1_code_2021,sa2_name_2021,tot_p_p');
  url.searchParams.set('resultRecordCount', '2000');
  url.searchParams.set('f', 'geojson');

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`ABS FeatureServer request failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as AbsFeatureCollection;

  const cells: PopulationCell[] = [];
  let totalPopulation = 0;
  for (const feature of data.features) {
    if (!feature.geometry) continue; // a couple of ACT SA1 rows have no boundary at all - not real places
    const population = feature.properties.tot_p_p ?? 0;
    const ring = outerRing(feature.geometry);
    const areaSqKm = ringAreaSqKm(ring);
    if (areaSqKm <= 0) continue;
    const centroid = ringCentroid(ring);
    cells.push({
      sa1Code: feature.properties.sa1_code_2021,
      areaName: feature.properties.sa2_name_2021 ?? 'Unknown area',
      population,
      areaSqKm: round6(areaSqKm),
      centroidLat: round6(centroid.lat),
      centroidLon: round6(centroid.lon),
      // GeoJSON is [lon, lat] - flipped to [lat, lon] here to match this
      // codebase's own convention everywhere else (ShapePoint, stop
      // coordinates, etc.).
      polygon: ring.map(([lon, lat]) => [round6(lat), round6(lon)]),
    });
    totalPopulation += population;
  }

  return { generatedAt: new Date().toISOString(), totalPopulation, cells };
}
