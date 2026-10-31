import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

// One root .env for the whole monorepo (existing environment variables win).
// /api/* is proxied to the NestJS API by src/app/api/[...path]/route.ts.
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  devIndicators: false,
  // The Docker image sets NEXT_STANDALONE=1 to get a self-contained server.js; the tracing root is the monorepo root.
  ...(process.env.NEXT_STANDALONE === '1' && {
    output: 'standalone',
    outputFileTracingRoot: resolve(process.cwd(), '../..'),
  }),
};

export default nextConfig;
