/**
 * Build-time GTFS static route-shape extraction for Transport Canberra.
 *
 * Fetches the static GTFS bundle (~15MB zip), pulls out just the two files
 * needed to map a live vehicle onto its actual route geometry - `trips.txt`
 * (trip_id -> shape_id) and `shapes.txt` (shape_id -> ordered lat/lon points)
 * - and produces a compact snapshot baked into the app at build time.
 *
 * Runs inside the Vite/Node build process only; TC_GTFS_CLIENT_ID/SECRET are
 * never sent to the browser. Verified against real live data before this was
 * written: both bus (`12_83243326-2026-COMBNXT-ST0-4`) and light rail
 * (`147`, `291`, ...) real-time trip_id values match trips.txt's trip_id
 * column directly - no format translation needed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { unzipSync } from 'fflate';

const GTFS_URL = 'https://transport.api.act.gov.au/gtfs/data/gtfs/v2/gtfs.zip';

export interface ShapesSnapshot {
  generatedAt: string;
  /** trip_id -> shape_id */
  tripToShape: Record<string, string>;
  /** shape_id -> ordered [lat, lon] points */
  shapes: Record<string, [number, number][]>;
  /** trip_id -> trip_headsign (destination, e.g. "City West") - for route direction labels. */
  tripHeadsign: Record<string, string>;
}

/** Resolve TC_GTFS_CLIENT_ID/SECRET from env or the app-local .env / .env.local files. */
function resolveCredentials(rootDir: string): { id: string; secret: string } {
  const fromEnv = { id: process.env.TC_GTFS_CLIENT_ID, secret: process.env.TC_GTFS_CLIENT_SECRET };
  if (fromEnv.id && fromEnv.secret) return { id: fromEnv.id, secret: fromEnv.secret };

  const found: Record<string, string> = {};
  for (const file of ['.env.local', '.env']) {
    const envPath = resolve(rootDir, file);
    if (!existsSync(envPath)) continue;
    for (const raw of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const [key, ...rest] = line.split('=');
      const k = key.trim();
      if (k === 'TC_GTFS_CLIENT_ID' || k === 'TC_GTFS_CLIENT_SECRET') {
        found[k] = rest.join('=').trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  if (found.TC_GTFS_CLIENT_ID && found.TC_GTFS_CLIENT_SECRET) {
    return { id: found.TC_GTFS_CLIENT_ID, secret: found.TC_GTFS_CLIENT_SECRET };
  }
  throw new Error('No TC_GTFS_CLIENT_ID/TC_GTFS_CLIENT_SECRET found (env or .env/.env.local).');
}

/** Minimal streaming-style CSV line parser - handles quoted fields, no full-file object allocation. */
function* csvRows(text: string): Generator<string[]> {
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      if (record.length > 1 || record[0] !== '') yield record;
      record = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || record.length) {
    record.push(field);
    yield record;
  }
}

function columnIndex(header: string[], name: string): number {
  const idx = header.findIndex((h) => h.replace(/^\uFEFF/, '').trim() === name);
  if (idx === -1) throw new Error(`Column "${name}" not found in header: ${header.join(',')}`);
  return idx;
}

export async function buildShapesSnapshot(rootDir: string): Promise<ShapesSnapshot> {
  const { id, secret } = resolveCredentials(rootDir);
  const token = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch(GTFS_URL, { headers: { Authorization: `Basic ${token}` } });
  if (!res.ok) throw new Error(`GTFS static fetch failed: ${res.status} ${res.statusText}`);
  const zipBuf = new Uint8Array(await res.arrayBuffer());
  const unzipped = unzipSync(zipBuf, { filter: (f) => f.name === 'trips.txt' || f.name === 'shapes.txt' });
  const decoder = new TextDecoder();

  const tripToShape: Record<string, string> = {};
  const tripHeadsign: Record<string, string> = {};
  {
    const rows = csvRows(decoder.decode(unzipped['trips.txt']));
    const header = rows.next().value as string[];
    const iTrip = columnIndex(header, 'trip_id');
    const iShape = columnIndex(header, 'shape_id');
    // trip_headsign is optional per the GTFS spec - not every feed has it.
    let iHeadsign = -1;
    try {
      iHeadsign = columnIndex(header, 'trip_headsign');
    } catch {
      // no headsign column - tripHeadsign stays empty, callers fall back gracefully.
    }
    for (const r of rows) {
      if (r[iTrip] && r[iShape]) tripToShape[r[iTrip]] = r[iShape];
      if (r[iTrip] && iHeadsign >= 0 && r[iHeadsign]) tripHeadsign[r[iTrip]] = r[iHeadsign];
    }
  }

  const shapePoints: Record<string, { seq: number; lat: number; lon: number }[]> = {};
  {
    const rows = csvRows(decoder.decode(unzipped['shapes.txt']));
    const header = rows.next().value as string[];
    const iShape = columnIndex(header, 'shape_id');
    const iLat = columnIndex(header, 'shape_pt_lat');
    const iLon = columnIndex(header, 'shape_pt_lon');
    const iSeq = columnIndex(header, 'shape_pt_sequence');
    for (const r of rows) {
      const shapeId = r[iShape];
      if (!shapeId) continue;
      (shapePoints[shapeId] ??= []).push({
        seq: Number(r[iSeq]),
        lat: Number(r[iLat]),
        lon: Number(r[iLon]),
      });
    }
  }

  const shapes: Record<string, [number, number][]> = {};
  for (const [shapeId, points] of Object.entries(shapePoints)) {
    points.sort((a, b) => a.seq - b.seq);
    shapes[shapeId] = points.map((p) => [p.lat, p.lon]);
  }

  return { generatedAt: new Date().toISOString(), tripToShape, shapes, tripHeadsign };
}
