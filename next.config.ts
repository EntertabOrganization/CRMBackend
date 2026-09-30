import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Development and live endpoint builds can run concurrently without corrupting each other's manifests/chunks.
  distDir: process.env.NEXT_DIST_DIR ?? (process.env.NODE_ENV === 'development' ? '.next-dev' : '.next'),
};

export default nextConfig;
