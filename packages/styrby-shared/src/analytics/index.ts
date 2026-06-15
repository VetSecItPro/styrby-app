/**
 * Analytics barrel.
 *
 * Product-analytics event catalog + helpers shared by styrby-web and
 * styrby-mobile. Pure data and pure functions only - no SDK, no platform
 * code - so it is safe to re-export from the package root without pulling
 * any weight into consumer bundles.
 *
 * @module analytics
 */

export * from './events.js';
