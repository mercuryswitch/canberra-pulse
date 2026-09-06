/**
 * Build-time GTFS static stop/schedule extraction for Transport Canberra.
 *
 * Powers "Near me": nearest stop(s) - both sides of the street are separate
 * stop_ids a few metres apart, so "nearest 3" naturally covers both
 * directions without needing to explicitly pair them - and each stop's
 * scheduled next arrivals, collapsed to one row per route (not one row per
 * trip).
 *
 * `stop_times.txt` is the biggest file in the bundle (1.3M+ rows) - shipping
 * it raw would be a multi-ten-MB asset. Instead this pre-joins it against
 * trips.txt at build time and groups by (stop_id, route_id), so the browser
 * only ever needs a sorted list of arrival-times-in-seconds per stop+route,
 * never a trip_id or a raw per-trip row. `calendar.txt`/`calendar_dates.txt`
 * are tiny (tens/hundreds of rows) and shipped as-is so "is this service
 * running today" is a cheap client-side computation, not something baked in
 * at build time (which would go stale the next day).
 *
 * Deliberately does NOT handle the GTFS after-midnight edge case (a service
 * whose calendar day is "yesterday" but whose trips carry times past 24:00
 * that are still technically "tonight"). Good enough for a daytime demo tool;
 * flagging here so a future session doesn't assume this is exhaustive.
 *
 * Separate fetch of the same GTFS zip from gtfsShapes.ts (a second ~15-20MB
 * build-time download) rather than threading a second concern through that
 * already-verified-working module - build time cost only, no runtime cost.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { unzipSync } from 'fflate';

const GTFS_URL = 'https://transport.api.act.gov.au/gtfs/data/gtfs/v2/gtfs.zip';

export interface CalendarEntry {
  /** [mon, tue, wed, thu, fri, sat, sun] as 0|1 */
  days: [number, number, number, number, number, number, number];
  /** YYYYMMDD */
  start: string;
  /** YYYYMMDD */
  end: string;
}

export interface StopArrivalsSnapshot {
  generatedAt: string;
  /** stop_id -> [lat, lon, name] */
  stops: Record<string, [number, number, string]>;
  /**
   * stop_id -> route_id -> service_id -> sorted arrival times, in seconds
   * since midnight (can exceed 86400). Kept per service_id (not merged) so
   * the client can filter to "services actually running today" - only ~18
   * distinct service_ids in this feed, so this extra nesting level is cheap.
   */
  arrivals: Record<string, Record<string, Record<string, number[]>>>;
  /** service_id -> weekly calendar */
  calendar: Record<string, CalendarEntry>;
  /** service_id -> [date (YYYYMMDD), exception_type (1=added, 2=removed)][] */
  calendarDates: Record<string, [string, 1 | 2][]>;
  /**
   * trip_id -> stop_id -> scheduled arrival, seconds since midnight. Powers
   * #2 on-time performance: when a live vehicle's current_status is
   * STOPPED_AT a specific stop_id, this is what its *actual* arrival time
   * (from the live feed's own timestamp) gets compared against. Keyed by
   * the exact trip_id (unlike `arrivals` above, which deliberately merges
   * across trips per route+service for the Near Me use case) - on-time
   * performance is inherently a per-trip question, not a per-route one.
   */
  tripStopArrival: Record<string, Record<string, number>>;
}

/** Same resolution logic as gtfsShapes.ts - kept local to avoid a cross-file coupling for one helper. */
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

/** "HH:MM:SS" (hours can exceed 24) -> seconds since midnight. */
function parseGtfsTime(hhmmss: string): number | null {
  const m = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(hhmmss.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export async function buildStopArrivalsSnapshot(rootDir: string): Promise<StopArrivalsSnapshot> {
  const { id, secret } = resolveCredentials(rootDir);
  const token = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch(GTFS_URL, { headers: { Authorization: `Basic ${token}` } });
  if (!res.ok) throw new Error(`GTFS static fetch failed: ${res.status} ${res.statusText}`);
  const zipBuf = new Uint8Array(await res.arrayBuffer());
  const wanted = new Set([
    'stops.txt',
    'trips.txt',
    'stop_times.txt',
    'calendar.txt',
    'calendar_dates.txt',
  ]);
  const unzipped = unzipSync(zipBuf, { filter: (f) => wanted.has(f.name) });
  const decoder = new TextDecoder();

  const stops: Record<string, [number, number, string]> = {};
  {
    const rows = csvRows(decoder.decode(unzipped['stops.txt']));
    const header = rows.next().value as string[];
    const iId = columnIndex(header, 'stop_id');
    const iName = columnIndex(header, 'stop_name');
    const iLat = columnIndex(header, 'stop_lat');
    const iLon = columnIndex(header, 'stop_lon');
    for (const r of rows) {
      const id2 = r[iId];
      const lat = Number(r[iLat]);
      const lon = Number(r[iLon]);
      if (id2 && Number.isFinite(lat) && Number.isFinite(lon)) {
        stops[id2] = [lat, lon, r[iName] ?? id2];
      }
    }
  }

  // trip_id -> [route_id, service_id], needed to collapse stop_times' per-trip
  // rows down to per-route-per-service arrivals - both live only on trips.txt,
  // not on stop_times.txt itself, hence this intermediate map.
  const tripInfo: Record<string, [string, string]> = {};
  {
    const rows = csvRows(decoder.decode(unzipped['trips.txt']));
    const header = rows.next().value as string[];
    const iTrip = columnIndex(header, 'trip_id');
    const iRoute = columnIndex(header, 'route_id');
    const iService = columnIndex(header, 'service_id');
    for (const r of rows) {
      if (r[iTrip] && r[iRoute] && r[iService]) tripInfo[r[iTrip]] = [r[iRoute], r[iService]];
    }
  }

  const arrivals: Record<string, Record<string, Record<string, number[]>>> = {};
  const tripStopArrival: Record<string, Record<string, number>> = {};
  {
    const rows = csvRows(decoder.decode(unzipped['stop_times.txt']));
    const header = rows.next().value as string[];
    const iTrip = columnIndex(header, 'trip_id');
    const iStop = columnIndex(header, 'stop_id');
    const iArr = columnIndex(header, 'arrival_time');
    for (const r of rows) {
      const stopId = r[iStop];
      const tripId = r[iTrip];
      const info = tripInfo[tripId];
      if (!stopId || !info) continue;
      const [routeId, serviceId] = info;
      const secs = parseGtfsTime(r[iArr] ?? '');
      if (secs == null) continue;
      const byRoute = (arrivals[stopId] ??= {});
      const byService = (byRoute[routeId] ??= {});
      (byService[serviceId] ??= []).push(secs);
      (tripStopArrival[tripId] ??= {})[stopId] = secs;
    }
    for (const byRoute of Object.values(arrivals)) {
      for (const byService of Object.values(byRoute)) {
        for (const times of Object.values(byService)) times.sort((a, b) => a - b);
      }
    }
  }

  const calendar: Record<string, CalendarEntry> = {};
  {
    const rows = csvRows(decoder.decode(unzipped['calendar.txt']));
    const header = rows.next().value as string[];
    const iService = columnIndex(header, 'service_id');
    const dayIdx = [
      columnIndex(header, 'monday'),
      columnIndex(header, 'tuesday'),
      columnIndex(header, 'wednesday'),
      columnIndex(header, 'thursday'),
      columnIndex(header, 'friday'),
      columnIndex(header, 'saturday'),
      columnIndex(header, 'sunday'),
    ];
    const iStart = columnIndex(header, 'start_date');
    const iEnd = columnIndex(header, 'end_date');
    for (const r of rows) {
      const serviceId = r[iService];
      if (!serviceId) continue;
      calendar[serviceId] = {
        days: dayIdx.map((i) => (r[i] === '1' ? 1 : 0)) as CalendarEntry['days'],
        start: r[iStart] ?? '',
        end: r[iEnd] ?? '',
      };
    }
  }

  // calendar_dates.txt is optional per the GTFS spec - some feeds (this one,
  // confirmed 2026-09-05) carry only calendar.txt with no exceptions at all.
  const calendarDates: Record<string, [string, 1 | 2][]> = {};
  if (unzipped['calendar_dates.txt']) {
    const rows = csvRows(decoder.decode(unzipped['calendar_dates.txt']));
    const header = rows.next().value as string[];
    const iService = columnIndex(header, 'service_id');
    const iDate = columnIndex(header, 'date');
    const iException = columnIndex(header, 'exception_type');
    for (const r of rows) {
      const serviceId = r[iService];
      if (!serviceId) continue;
      const exceptionType = r[iException] === '1' ? 1 : r[iException] === '2' ? 2 : null;
      if (!r[iDate] || exceptionType === null) continue;
      (calendarDates[serviceId] ??= []).push([r[iDate], exceptionType]);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    stops,
    arrivals,
    calendar,
    calendarDates,
    tripStopArrival,
  };
}
