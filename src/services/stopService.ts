/**
 * Client-side "Near me": nearest stop(s) by straight-line distance (both
 * sides of the street are separate stop_ids a few metres apart, so "nearest
 * N" naturally covers both directions - see vite/gtfsStopArrivals.ts for why
 * no explicit direction-pairing logic exists), and each stop's scheduled
 * next arrivals, collapsed to one row per route.
 *
 * Deliberately does not handle the GTFS after-midnight edge case (a service
 * whose calendar day is "yesterday" but whose trip times are still >= 24:00
 * and technically "tonight") - same scope cut as the build-time extraction.
 */
import { haversineMeters } from './shapeService';

interface CalendarEntry {
  days: [number, number, number, number, number, number, number];
  start: string;
  end: string;
}

interface StopArrivalsSnapshot {
  generatedAt: string;
  stops: Record<string, [number, number, string]>;
  arrivals: Record<string, Record<string, Record<string, number[]>>>;
  calendar: Record<string, CalendarEntry>;
  calendarDates: Record<string, [string, 1 | 2][]>;
}

export interface RouteArrival {
  routeId: string;
  /** Seconds since midnight, today, >= now, up to 2, ascending. */
  nextArrivalsSeconds: number[];
}

export interface NearestStop {
  stopId: string;
  name: string;
  lat: number;
  lon: number;
  distanceMeters: number;
  routes: RouteArrival[];
}

let snapshotPromise: Promise<StopArrivalsSnapshot | null> | null = null;

/** Fetch (once) and cache the stop-arrivals snapshot. Resolves null if unavailable. */
function loadSnapshot(): Promise<StopArrivalsSnapshot | null> {
  if (!snapshotPromise) {
    const url = `${import.meta.env.BASE_URL}stop-arrivals.json`;
    snapshotPromise = fetch(url)
      .then((res) => (res.ok ? (res.json() as Promise<StopArrivalsSnapshot>) : null))
      .catch(() => null);
  }
  return snapshotPromise;
}

/**
 * Preload the snapshot - call when Near Me is first activated, not at app
 * startup, since this asset is bigger than the route shapes one and most
 * sessions won't use this feature.
 */
export function preloadStopArrivals(): Promise<void> {
  return loadSnapshot().then(() => undefined);
}

function todayInfo(): { dateStr: string; dayIdx: number; secondsSinceMidnight: number } {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  // CalendarEntry.days is [mon, tue, wed, thu, fri, sat, sun]; Date#getDay()
  // is 0=Sun..6=Sat, so shift by one to realign.
  const dayIdx = (now.getDay() + 6) % 7;
  return {
    dateStr: `${y}${m}${d}`,
    dayIdx,
    secondsSinceMidnight: now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds(),
  };
}

function isServiceActiveToday(
  serviceId: string,
  snap: StopArrivalsSnapshot,
  dateStr: string,
  dayIdx: number,
): boolean {
  let active = false;
  const cal = snap.calendar[serviceId];
  if (cal && dateStr >= cal.start && dateStr <= cal.end && cal.days[dayIdx] === 1) active = true;
  // calendar_dates.txt exceptions override the regular weekly calendar for
  // this specific date, in either direction (added or removed).
  const exceptions = snap.calendarDates[serviceId];
  if (exceptions) {
    for (const [date, type] of exceptions) {
      if (date === dateStr) active = type === 1;
    }
  }
  return active;
}

/** Every stop's coordinates - used to show "underutilised" areas (a real stop nearby, low actual traffic) on the heat map, not just wherever a vehicle happened to ping. */
export async function getAllStopCoordinates(): Promise<{ lat: number; lon: number }[]> {
  const snap = await loadSnapshot();
  if (!snap) return [];
  return Object.values(snap.stops).map(([lat, lon]) => ({ lat, lon }));
}

/**
 * Nearest stop's name to an arbitrary (lat, lon) - a human-readable "where is
 * this" for a vehicle's current position or a route's origin, e.g. "Dickson
 * Interchange". Pure geometry, no service-day filtering (unlike
 * getNearestStops) since this isn't about what's scheduled, just what place
 * name is closest.
 */
export async function getNearestStopName(lat: number, lon: number): Promise<string | null> {
  const snap = await loadSnapshot();
  if (!snap) return null;
  let bestName: string | null = null;
  let bestDist = Infinity;
  for (const [, [stopLat, stopLon, name]] of Object.entries(snap.stops)) {
    const d = haversineMeters(lat, lon, stopLat, stopLon);
    if (d < bestDist) {
      bestDist = d;
      bestName = name;
    }
  }
  return bestName;
}

/** Nearest `count` stops to (lat, lon), each with today's remaining scheduled arrivals per route. */
export async function getNearestStops(lat: number, lon: number, count = 3): Promise<NearestStop[]> {
  const snap = await loadSnapshot();
  if (!snap) return [];

  const { dateStr, dayIdx, secondsSinceMidnight } = todayInfo();
  const activeCache = new Map<string, boolean>();
  const isActive = (serviceId: string): boolean => {
    let cached = activeCache.get(serviceId);
    if (cached === undefined) {
      cached = isServiceActiveToday(serviceId, snap, dateStr, dayIdx);
      activeCache.set(serviceId, cached);
    }
    return cached;
  };

  const nearest = Object.entries(snap.stops)
    .map(([stopId, [stopLat, stopLon, name]]) => ({
      stopId,
      name,
      lat: stopLat,
      lon: stopLon,
      distanceMeters: haversineMeters(lat, lon, stopLat, stopLon),
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, count);

  return nearest.map((stop) => {
    const byRoute = snap.arrivals[stop.stopId] ?? {};
    const routes: RouteArrival[] = Object.entries(byRoute)
      .map(([routeId, byService]) => {
        const times: number[] = [];
        for (const [serviceId, arrivalTimes] of Object.entries(byService)) {
          if (!isActive(serviceId)) continue;
          for (const t of arrivalTimes) if (t >= secondsSinceMidnight) times.push(t);
        }
        times.sort((a, b) => a - b);
        return { routeId, nextArrivalsSeconds: times.slice(0, 2) };
      })
      .filter((r) => r.nextArrivalsSeconds.length > 0)
      .sort((a, b) => a.nextArrivalsSeconds[0] - b.nextArrivalsSeconds[0]);
    return { ...stop, routes };
  });
}

/** Seconds-since-midnight (can exceed 86400 for after-midnight trips) -> "9:14 AM". */
export function formatArrivalClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600) % 24;
  const m = Math.floor((totalSeconds % 3600) / 60);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/** Whole minutes from now (seconds-since-midnight) until an arrival. */
export function minutesUntil(arrivalSeconds: number, nowSecondsSinceMidnight: number): number {
  return Math.round((arrivalSeconds - nowSecondsSinceMidnight) / 60);
}

export function secondsSinceMidnightNow(): number {
  const now = new Date();
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
}
