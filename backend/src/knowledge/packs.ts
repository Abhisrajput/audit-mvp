import { PackRegistry } from '../engine/packs';
import { DEFAULT_PACKS_DIR, loadBundles } from './okf/bundle';
import { bundleToContentPack } from './okf/to-pack';

// Where the engine's PackRegistry comes from. Tests use the bundles on disk; the API and
// the eval CLI read the compiled knowledge graph (registryFromGraph, plan 1E Task 4).

export function registryFromBundles(dir = DEFAULT_PACKS_DIR): PackRegistry {
  return new PackRegistry(loadBundles(dir).map(bundleToContentPack));
}
