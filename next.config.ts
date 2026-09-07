import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Channel logos and posters come from arbitrary provider hosts, so next/image
  // optimisation is not usable here — plain <img> is used with the proxy instead.
  images: { unoptimized: true },
  // Standalone output bundles the server into a single portable directory,
  // which is what the Dockerfile copies into the minimal runner stage.
  output: 'standalone',
}

export default nextConfig
