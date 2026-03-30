/**
 * Dynamic Twitter card image for Styrby.
 *
 * Rendered at /twitter-image.png by Next.js. Used as the og:image for
 * Twitter (X) summary_large_image cards. Shares the same design as the
 * Open Graph image to ensure consistent social sharing appearance.
 *
 * WHY separate file: Next.js resolves twitter-image.tsx independently
 * from opengraph-image.tsx, which allows platform-specific customization
 * if needed in the future without touching the OG image.
 */

import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'Styrby — AI Agent Dashboard';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * Generates the Twitter card image for Styrby.
 *
 * @returns An ImageResponse containing the rendered PNG
 */
export default function TwitterImage() {
  return new ImageResponse(
    (
      <div
        style={{
          background: '#09090b',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          padding: '72px 80px',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        {/* Top: logo + wordmark */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div
            style={{
              width: '52px',
              height: '52px',
              borderRadius: '12px',
              background: 'linear-gradient(135deg, #f59e0b, #d97706)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span
              style={{
                fontSize: '28px',
                fontWeight: 800,
                color: '#ffffff',
              }}
            >
              S
            </span>
          </div>
          <span
            style={{
              fontSize: '32px',
              fontWeight: 700,
              color: '#fafafa',
              letterSpacing: '-0.5px',
            }}
          >
            Styrby
          </span>
        </div>

        {/* Center: main headline + subtitle */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <h1
            style={{
              fontSize: '72px',
              fontWeight: 800,
              color: '#fafafa',
              lineHeight: 1.05,
              letterSpacing: '-2px',
              margin: 0,
              maxWidth: '900px',
            }}
          >
            Control 11 AI coding agents
            <br />
            from your phone.
          </h1>
          <p
            style={{
              fontSize: '28px',
              color: '#a1a1aa',
              margin: 0,
              fontWeight: 400,
            }}
          >
            Monitor costs, approve permissions, and stay in control — anywhere.
          </p>
        </div>

        {/* Bottom: three key differentiators */}
        <div style={{ display: 'flex', gap: '32px' }}>
          {['E2E Encrypted', 'Real-time Relay', 'Cost Tracking'].map((tag) => (
            <div
              key={tag}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                background: 'rgba(245, 158, 11, 0.1)',
                border: '1px solid rgba(245, 158, 11, 0.25)',
                borderRadius: '999px',
                padding: '8px 20px',
              }}
            >
              <span
                style={{
                  fontSize: '16px',
                  color: '#f59e0b',
                  fontWeight: 500,
                }}
              >
                {tag}
              </span>
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size }
  );
}
