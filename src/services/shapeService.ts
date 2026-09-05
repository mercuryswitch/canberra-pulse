/**
 * Client-side map-matching against the build-time route-shapes snapshot
 * (see vite/routeShapesSnapshot.ts). Snaps a raw GPS fix onto the nearest
 * point on its trip's actual route polyline, so vehicles sit on the road/
 * track rather than drifting off it from GPS noise.
 */

interface ShapesSnapshot {
  generatedAt: string;
  tripToShape: Record<string, string>;
  shapes: Record<string, [number, number][]>;
  tripHeadsign: Record<string, string>;
}

export interface ShapePoint {
  lat: number;
  lon: number;
  /** Cumulative real-world distance (metres) from the start of the shape. */
  dist: number;
}

export interface SnapResult {
  lat: number;
  lon: number;
  distanceAlong: number;
}

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

let snapshotPromise: Promise<ShapesSnapshot | null> | null = null;
const shapeCache = new Map<string, ShapePoint[]>();

/** Fetch (once) and cache the route-shapes snapshot. Resolves to null if unavailable - callers fall back to raw GPS. */
function loadSnapshot(): Promise<ShapesSnapshot | null> {
  if (!snapshotPromise) {
    const url = `${import.meta.env.BASE_URL}route-shapes.json`;
    snapshotPromise = fetch(url)
      .then((res) => (res.ok ? (res.json() as Promise<ShapesSnapshot>) : null))
      .catch(() => null);
  }
  return snapshotPromise;
}

/** Preload the snapshot - call once at app startup so later lookups are synchronous-feeling. */
export function preloadShapes(): Promise<void> {
  return loadSnapshot().then(() => undefined);
}

/** A trip's destination/direction text (e.g. "City West"), or null if unmatched/unavailable. */
export async function getHeadsignForTrip(tripId: string): Promise<string | null> {
  const snap = await loadSnapshot();
  return snap?.tripHeadsign[tripId] ?? null;
}

/** First point of a trip's route shape - a reasonable proxy for "where this route starts". */
export function shapeOrigin(shape: ShapePoint[]): { lat: number; lon: number } | null {
  return shape.length > 0 ? { lat: shape[0].lat, lon: shape[0].lon } : null;
}

/** Resolve a trip's route shape (with cumulative distances precomputed), or null if unmatched/unavailable. */
export async function getShapeForTrip(tripId: string): Promise<ShapePoint[] | null> {
  const snap = await loadSnapshot();
  if (!snap) return null;
  const shapeId = snap.tripToShape[tripId];
  if (!shapeId) return null;

  const cached = shapeCache.get(shapeId);
  if (cached) return cached;

  const raw = snap.shapes[shapeId];
  if (!raw || raw.length < 2) return null;

  const points: ShapePoint[] = [];
  let cumulative = 0;
  for (let i = 0; i < raw.length; i++) {
    const [lat, lon] = raw[i];
    if (i > 0) {
      const [prevLat, prevLon] = raw[i - 1];
      cumulative += haversineMeters(prevLat, prevLon, lat, lon);
    }
    points.push({ lat, lon, dist: cumulative });
  }
  shapeCache.set(shapeId, points);
  return points;
}

/**
 * Project (lat, lon) onto the nearest point on the shape's polyline.
 * Uses a simple equirectangular approximation (longitude scaled by cos(lat))
 * for the nearest-segment search - accurate enough at city scale, and only
 * used to pick the closest segment, not to measure real distances (those
 * come from the precomputed haversine `dist` values on each ShapePoint).
 */
export function snapToShape(shape: ShapePoint[], lat: number, lon: number): SnapResult {
  const cosRef = Math.cos((shape[0].lat * Math.PI) / 180);
  const px = lon * cosRef;
  const py = lat;

  let best: SnapResult & { d2: number } = {
    lat: shape[0].lat,
    lon: shape[0].lon,
    distanceAlong: 0,
    d2: Infinity,
  };

  for (let i = 0; i < shape.length - 1; i++) {
    const a = shape[i];
    const b = shape[i + 1];
    const ax = a.lon * cosRef;
    const ay = a.lat;
    const bx = b.lon * cosRef;
    const by = b.lat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const sx = ax + t * dx;
    const sy = ay + t * dy;
    const d2 = (px - sx) ** 2 + (py - sy) ** 2;
    if (d2 < best.d2) {
      best = {
        d2,
        lat: a.lat + t * (b.lat - a.lat),
        lon: a.lon + t * (b.lon - a.lon),
        distanceAlong: a.dist + t * (b.dist - a.dist),
      };
    }
  }
  return { lat: best.lat, lon: best.lon, distanceAlong: best.distanceAlong };
}
