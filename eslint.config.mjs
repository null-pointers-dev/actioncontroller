import nextVitals from 'eslint-config-next/core-web-vitals';

// Folder boundaries replace package boundaries (see docs/07-code-design.md §2).
export default [
  ...nextVitals,
  {
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            { target: './server', from: ['./app', './features', './components', './lib'], message: 'server/ must not import UI code' },
            { target: './shared', from: ['./server', './app', './features', './components', './lib', './worker'], message: 'shared/ may only import zod' },
            { target: './worker', from: ['./app', './features', './components', './lib'], message: 'worker/ imports server/ and shared/ only' },
            { target: ['./app', './features', './components', './lib'], from: './worker' },
            { target: './server/core', from: ['./server/trpc', './server/realtime', './server/auth'], message: 'core is framework-free' },
          ],
        },
      ],
    },
  },
  { ignores: ['.next/**', 'dist/**', 'node_modules/**'] },
];
