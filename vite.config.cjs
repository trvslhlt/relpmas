// .cjs, not .ts -- fixes a real, reproducible Docker bind-mount race
// ("ERR_MODULE_NOT_FOUND ... vite.config.*.timestamp-*.mjs"): Vite always
// bundles a config file through esbuild first, but only loads the .ts/.mjs
// result via a real temp-file write + dynamic import() (which can lose that
// race against this machine's virtualized bind mount); .cjs is instead
// loaded by patching Node's require cache in memory, no disk write, no
// race. Genuine require()/module.exports here (not transpiled import/
// export) so Biome -- which infers a file's module type from its extension
// -- can actually lint it. No `import { defineConfig } from "vite"` either:
// it's a no-op identity wrapper, but requiring anything from "vite" trips
// its own CJS-deprecation warning on every load, so the config is typed via
// the JSDoc annotation below instead. See the root CLAUDE.md's "Vite
// config: .cjs, and the CJS deprecation warning it causes" section before
// touching this file's extension or config-loading mechanism -- this exact
// fix is already documented there, don't reinvent it differently.
/** @type {import('vite').UserConfig} */
module.exports = {};
