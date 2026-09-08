import type { Plugin } from 'vite';

import { buildTrafficLinksSnapshot } from './actTrafficLinks';

/** Asset path (relative to the build output root) of the traffic-links snapshot. */
export const TRAFFIC_LINKS_FILE = 'traffic-links.json';

/**
 * Emits a static ACT traffic road-segment geometry snapshot into the
 * production bundle - the congestion overlay's geometry source. Same
 * bake-at-build-time pattern as route-shapes.json/population.json. No
 * credentials needed - the Addinsight API is public.
 *
 * If the API is unreachable at build time, the build still succeeds; the
 * congestion overlay simply has nothing to show (see trafficService.ts's
 * fallback).
 */
export function trafficLinksSnapshotPlugin(): Plugin {
  let root = process.cwd();
  return {
    name: 'act-traffic-links-snapshot',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    async generateBundle() {
      try {
        const links = await buildTrafficLinksSnapshot(root);
        this.emitFile({
          type: 'asset',
          fileName: TRAFFIC_LINKS_FILE,
          source: JSON.stringify(links),
        });
        this.info(`traffic links snapshot: ${links.length} road segments`);
      } catch (err) {
        this.warn(`traffic links snapshot skipped - congestion overlay will have no data. ${(err as Error).message}`);
      }
    },
  };
}
