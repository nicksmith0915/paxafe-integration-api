import type { NextConfig } from 'next';

/**
 * Baseline response headers. This service is an API with one static index page,
 * so the policy is simply "nothing may embed, sniff or cache it":
 *
 * - `frame-ancestors 'none'` / `X-Frame-Options: DENY` -- never framed.
 * - `nosniff` -- a JSON error body is never reinterpreted as HTML.
 * - `no-referrer` -- no URL leaks to third parties.
 * - `no-store` on /api -- telemetry responses and health state are never cached
 *   by an intermediary.
 *
 * No script-src policy: the only page renders no client JavaScript of its own,
 * and a nonce-based policy would add moving parts for no protection gained.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

const nextConfig: NextConfig = {
  // Do not advertise the framework and version to every client.
  poweredByHeader: false,

  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/api/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
    ];
  },
};

export default nextConfig;
