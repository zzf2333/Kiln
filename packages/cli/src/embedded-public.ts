import type { EmbeddedStaticAssets } from "@kiln/kernel";

let activeEmbeddedPublicAssets: EmbeddedStaticAssets | null = null;

/**
 * Registers compiled-in static Web UI assets (populated by `scripts/build-binary.mjs`
 * during standalone single-binary builds; remains `null` in Node/dev builds).
 */
export function setEmbeddedPublicAssets(assets: EmbeddedStaticAssets | null): void {
  activeEmbeddedPublicAssets = assets;
}

/**
 * Returns compiled-in static Web UI assets if registered for the current binary.
 */
export function getEmbeddedPublicAssets(): EmbeddedStaticAssets | null {
  return activeEmbeddedPublicAssets;
}
