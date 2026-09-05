import type { Plugin } from 'vite';

import { buildStopArrivalsSnapshot } from './gtfsStopArrivals';

/** Asset path (relative to the build output root) of the stop-arrivals snapshot. */
export const STOP_ARRIVALS_FILE = 'stop-arrivals.json';

/**
 * Emits a static Transport Canberra stop + schedule snapshot into the
 * production bundle - powers "Near me": nearest stop(s) and their scheduled
 * next arrivals, collapsed to one row per route. Same lazy-asset pattern as
 * routeShapesSnapshot.ts, but fetched by the client only when Near Me is
 * first used (see stopService.ts), not on initial page load - this file is
 * bigger than the route shapes one and most sessions won't need it.
 *
 * If credentials are missing the build still succeeds; Near Me simply has no
 * schedule data to show (falls back gracefully, same pattern as route shapes).
 */
export function stopArrivalsSnapshotPlugin(): Plugin {
  let root = process.cwd();
  return {
    name: 'act-stop-arrivals-snapshot',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    async generateBundle() {
      try {
        const snapshot = await buildStopArrivalsSnapshot(root);
        const stopCount = Object.keys(snapshot.stops).length;
        const arrivalStopCount = Object.keys(snapshot.arrivals).length;
        this.emitFile({
          type: 'asset',
          fileName: STOP_ARRIVALS_FILE,
          source: JSON.stringify(snapshot),
        });
        this.info(`stop arrivals snapshot: ${stopCount} stops, ${arrivalStopCount} with scheduled arrivals`);
      } catch (err) {
        this.warn(
          `stop arrivals snapshot skipped — "Near me" will have no schedule data. ${(err as Error).message}`,
        );
      }
    },
  };
}
