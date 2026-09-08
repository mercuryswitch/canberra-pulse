import type { Plugin } from 'vite';

import { buildPopulationSnapshot } from './absPopulation';

/** Asset path (relative to the build output root) of the population snapshot. */
export const POPULATION_FILE = 'population.json';

/**
 * Emits a static ABS 2021 Census population-by-SA1 snapshot into the
 * production bundle - the #4 equity overlay's data source. Same
 * bake-at-build-time pattern as route-shapes.json/stop-arrivals.json:
 * population doesn't change between Census years, so there's no reason to
 * ever fetch this live from the browser. No credentials needed - the ABS
 * FeatureServer is public.
 *
 * If the ABS service is unreachable at build time, the build still
 * succeeds; the equity overlay simply has nothing to show (see
 * populationService.ts's fallback).
 */
export function populationSnapshotPlugin(): Plugin {
  return {
    name: 'act-population-snapshot',
    apply: 'build',
    async generateBundle() {
      try {
        const snapshot = await buildPopulationSnapshot();
        this.emitFile({
          type: 'asset',
          fileName: POPULATION_FILE,
          source: JSON.stringify(snapshot),
        });
        this.info(
          `population snapshot: ${snapshot.cells.length} SA1 areas, ${snapshot.totalPopulation} total population`,
        );
      } catch (err) {
        this.warn(`population snapshot skipped - equity overlay will have no data. ${(err as Error).message}`);
      }
    },
  };
}
