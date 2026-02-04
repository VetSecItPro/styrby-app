import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Disable X-Powered-By header for security
  poweredByHeader: false,

  // Strict mode for React
  reactStrictMode: true,

  // Optimize package imports for smaller bundles
  experimental: {
    optimizePackageImports: ['recharts', '@supabase/supabase-js'],
  },

  // Image optimization
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
    ],
  },

  // Headers for security
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
