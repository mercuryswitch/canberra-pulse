/**
 * #4 equity overlay (2026-09-08): "how population is spread across the
 * city, and where that doesn't match actual bus service." Data is 2021
 * Census population by SA1, baked at build time from ABS's public
 * FeatureServer - see vite/absPopulation.ts for how, and why no runtime
 * fetch/credentials are needed.
 */

export interface PopulationCell {
  sa1Code: string;
  population: number;
  areaSqKm: number;
  centroidLat: number;
  centroidLon: number;
  polygon: [number, number][];
}

interface PopulationSnapshot {
  generatedAt: string;
  totalPopulation: number;
  cells: PopulationCell[];
}

let snapshotPromise: Promise<PopulationSnapshot | null> | null = null;

function loadSnapshot(): Promise<PopulationSnapshot | null> {
  if (!snapshotPromise) {
    const url = `${import.meta.env.BASE_URL}population.json`;
    snapshotPromise = fetch(url)
      .then((res) => (res.ok ? (res.json() as Promise<PopulationSnapshot>) : null))
      .catch(() => null);
  }
  return snapshotPromise;
}

/** Preload the snapshot - call when the equity overlay is first toggled on, not at app startup (same reasoning as preloadStopArrivals: a few MB most sessions won't need). */
export function preloadPopulation(): Promise<void> {
  return loadSnapshot().then(() => undefined);
}

/** Every ACT SA1's population, area, and boundary - empty if the snapshot is unavailable (e.g. the ABS service was unreachable at build time). */
export async function getPopulationCells(): Promise<PopulationCell[]> {
  const snap = await loadSnapshot();
  return snap?.cells ?? [];
}
