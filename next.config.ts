import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Frame-Options', value: 'DENY' },
];

const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Native/optional dependencies stay external to the server bundle.
  serverExternalPackages: ['pg', '@azure/identity', '@azure/keyvault-secrets', '@azure/monitor-opentelemetry'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
