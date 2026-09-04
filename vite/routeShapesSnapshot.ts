import type { Plugin } from 'vite';

import { buildShapesSnapshot } from './gtfsShapes';

/** Asset path (relative to the build output root) of the route-shapes snapshot. */
export const ROUTE_SHAPES_FILE = 'route-shapes.json';

/**
 * Emits a static Transport Canberra route-shape snapshot into the production
 * bundle, so vehicles can be map-matched onto their actual road/track
 * geometry instead of straight-lining between GPS fixes. Route shapes change
 * rarely (only on a timetable/network change), so baking them in at build
 * time - same pattern as the ferries app's timetable snapshot - avoids any
 * need to fetch or parse the 15MB static GTFS bundle in the browser.
 *
 * If credentials are missing the build still succeeds; route-following
 * simply falls back to straight-line movement (see `shapeService.ts`).
 */
export function routeShapesSnapshotPlugin(): Plugin {
  let root = process.cwd();
  return {
    name: 'act-route-shapes-snapshot',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    async generateBundle() {
      try {
        const snapshot = await buildShapesSnapshot(root);
        const shapeCount = Object.keys(snapshot.shapes).length;
        const tripCount = Object.keys(snapshot.tripToShape).length;
        this.emitFile({
          type: 'asset',
          fileName: ROUTE_SHAPES_FILE,
          source: JSON.stringify(snapshot),
        });
        this.info(`route shapes snapshot: ${shapeCount} shapes, ${tripCount} trip mappings`);
      } catch (err) {
        this.warn(
          `route shapes snapshot skipped — vehicles will move in straight lines between fixes instead of following route geometry. ${(err as Error).message}`,
        );
      }
    },
  };
}
