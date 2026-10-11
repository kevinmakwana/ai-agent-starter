import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

// One root .env for the whole monorepo (existing environment variables win).
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const apiUrl = process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}`;

const nextConfig: NextConfig = {
  // The browser only talks to /api/*; Next proxies it to the NestJS API (no CORS needed).
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
};

export default nextConfig;
