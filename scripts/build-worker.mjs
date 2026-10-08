// Bundles the worker entry point into one ESM file for App Service.
// - tsconfig "paths" (@/*) are resolved by esbuild automatically
// - "react-server" condition makes `server-only` an empty module (see docs/07 §2)
import { build } from 'esbuild';

await build({
  entryPoints: ['worker/main.ts'],
  outfile: 'dist/worker.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  conditions: ['react-server'],
  external: ['pg-native'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
