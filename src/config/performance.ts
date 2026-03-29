/**
 * Performance optimization configuration for Foseer
 */

export const PERFORMANCE_CONFIG = {
  // Image optimization
  imageOptimization: {
    formats: ['webp', 'avif', 'jpg'],
    quality: 80,
    sizes: {
      small: 400,
      medium: 800,
      large: 1200,
      xlarge: 1600
    }
  },

  // Caching strategies
  caching: {
    // Cache durations in milliseconds
    staticAssets: 31536000000, // 1 year
    images: 31536000000,       // 1 year
    fonts: 31536000000,        // 1 year
    css: 31536000000,          // 1 year
    js: 31536000000,           // 1 year
    html: 2592000000,          // 1 month
    api: 300000,               // 5 minutes
    rss: 3600000               // 1 hour
  },

  // Compression settings
  compression: {
    gzip: {
      enabled: true,
      minSize: 1000,
      compressionLevel: 6
    },
    brotli: {
      enabled: true,
      minSize: 1000,
      compressionLevel: 6
    }
  },

  // CDN configuration
  cdn: {
    enabled: true,
    providers: {
      cloudflare: {
        purgeEndpoint: 'https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache',
        headers: {
          'X-Auth-Email': process.env.CLOUDFLARE_EMAIL,
          'X-Auth-Key': process.env.CLOUDFLARE_API_KEY
        }
      }
    }
  },

  // Performance monitoring
  monitoring: {
    lighthouse: {
      thresholds: {
        performance: 90,
        accessibility: 95,
        bestPractices: 95,
        seo: 100
      }
    },
    webVitals: {
      enabled: true,
      metrics: ['CLS', 'FID', 'FCP', 'LCP', 'TTFB']
    }
  },

  // Lazy loading
  lazyLoading: {
    images: {
      enabled: true,
      threshold: 0.1,
      rootMargin: '50px'
    },
    components: {
      enabled: true,
      threshold: 0.2
    }
  },

  // Resource hints
  resourceHints: {
    preconnect: [
      'https://fonts.googleapis.com',
      'https://fonts.gstatic.com',
      'https://www.googletagmanager.com',
      'https://www.google-analytics.com'
    ],
    preload: [
      '/_astro/favicon.Czy1EQHj.svg',
      '/_astro/apple-touch-icon.DHIlG7dp.png'
    ],
    prefetch: [
      '/latest',
      '/sections/news',
      '/sections/tech'
    ]
  }
};

/**
 * Generate performance headers for different deployment platforms
 */
export function getPerformanceHeaders(platform: string = 'nginx') {
  const baseHeaders = {
    // Caching headers
    'Cache-Control': 'public, max-age=31536000, immutable',
    'ETag': '""',
    
    // Compression
    'Accept-Encoding': 'gzip, deflate, br',
    
    // Security
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    
    // Performance
    'X-UA-Compatible': 'IE=edge',
    'X-DNS-Prefetch-Control': 'on'
  };

  switch (platform) {
    case 'netlify':
      return {
        ...baseHeaders,
        'X-Frame-Options': 'SAMEORIGIN',
        'X-Robots-Tag': 'noindex'
      };
    
    case 'vercel':
      return {
        ...baseHeaders,
        'X-Edge-Cache-Tag': 'foseer-site'
      };
    
    case 'cloudflare':
      return {
        ...baseHeaders,
        'CF-Cache-Status': 'DYNAMIC',
        'CF-RAY': 'production'
      };
    
    default:
      return baseHeaders;
  }
}

/**
 * Generate sitemap configuration
 */
export function getSitemapConfig() {
  return {
    hostname: process.env.SITE || 'https://foseer.com',
    transform: (data: any) => {
      return {
        url: data.permalink,
        lastmod: data.updateDate || data.publishDate,
        changefreq: 'weekly',
        priority: data.priority || 0.5
      };
    }
  };
}

/**
 * Generate robots.txt content
 */
export function getRobotsTxt() {
  return `User-agent: *
Allow: /

# Allow all major search engines to crawl the site
User-agent: Googlebot
Allow: /

User-agent: Bingbot
Allow: /

User-agent: Slurp
Allow: /

User-agent: DuckDuckBot
Allow: /

User-agent: Baiduspider
Allow: /

User-agent: YandexBot
Allow: /

# Disallow crawling of admin and system paths
User-agent: *
Disallow: /admin/
Disallow: /_admin/
Disallow: /_next/
Disallow: /node_modules/
Disallow: /dist/
Disallow: /src/
Disallow: /vendor/

# Disallow crawling of development and staging paths
User-agent: *
Disallow: /staging/
Disallow: /dev/
Disallow: /test/

# Allow RSS feed and sitemap
Sitemap: ${process.env.SITE || 'https://foseer.com'}/sitemap-index.xml
`;
}