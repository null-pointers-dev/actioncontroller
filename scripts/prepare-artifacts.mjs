// After `pnpm build`: lay out the two App Service deployables under artifacts/ (CI zips them).
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

await rm('artifacts', { recursive: true, force: true });

// web: standalone server + static assets + public files
await mkdir('artifacts/web', { recursive: true });
await cp('.next/standalone', 'artifacts/web', { recursive: true });
await cp('.next/static', 'artifacts/web/.next/static', { recursive: true });
if (existsSync('public')) await cp('public', 'artifacts/web/public', { recursive: true });

// worker: one bundled file + SQL migrations
await mkdir('artifacts/worker', { recursive: true });
await cp('dist/worker.mjs', 'artifacts/worker/worker.mjs');
if (existsSync('dist/worker.mjs.map')) await cp('dist/worker.mjs.map', 'artifacts/worker/worker.mjs.map');
await cp('drizzle', 'artifacts/worker/drizzle', { recursive: true });

console.log('artifacts/web   -> startup: node server.js');
console.log('artifacts/worker -> startup: node worker.mjs');
