#!/usr/bin/env node
// =============================================================================
// generate-placeholders.mjs — Create minimal valid PNG files for Expo builds
// =============================================================================
//
// Expo / EAS Build will crash if the PNG files referenced in app.json are
// missing. This script creates minimal valid 1x1 pixel PNG files so that
// builds succeed even before real branding assets are delivered by the design
// team.
//
// These are NOT production-quality assets. Replace them with properly sized
// icons before submitting to the App Store or Google Play.
//
// For high-quality placeholders with the correct dimensions and branding,
// run generate-assets.sh instead (requires ImageMagick).
//
// Usage:
//   node scripts/generate-placeholders.mjs
//
// Generated files (referenced by app.json):
//   assets/icon.png           — App icon
//   assets/splash.png         — Splash screen image
//   assets/adaptive-icon.png  — Android adaptive icon foreground
//   assets/favicon.png        — Web favicon
// =============================================================================

import { writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ASSETS_DIR = join(__dirname, "..", "assets");

/**
 * Creates a minimal valid PNG file (1x1 pixel, solid orange #f97316).
 *
 * PNG structure:
 *   - 8-byte signature
 *   - IHDR chunk (image header: 1x1 px, 8-bit RGB)
 *   - IDAT chunk (compressed pixel data)
 *   - IEND chunk (image end marker)
 *
 * @param {string} filePath - Absolute path for the output PNG file
 */
function createMinimalPng(filePath) {
  /**
   * Computes the CRC32 checksum for a PNG chunk.
   * PNG uses CRC32 on the chunk type + chunk data bytes.
   *
   * @param {Buffer} buf - Buffer containing chunk type and data
   * @returns {number} The CRC32 checksum as an unsigned 32-bit integer
   */
  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * Builds a single PNG chunk with the correct length and CRC.
   *
   * @param {string} type - 4-character chunk type (e.g., "IHDR", "IDAT", "IEND")
   * @param {Buffer} data - The chunk data bytes
   * @returns {Buffer} The complete chunk (length + type + data + CRC)
   */
  function buildChunk(type, data) {
    const typeBuffer = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);

    const typeAndData = Buffer.concat([typeBuffer, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));

    return Buffer.concat([length, typeAndData, crc]);
  }

  // PNG signature (magic bytes identifying the file as PNG)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: 1x1 pixel, 8-bit RGB (color type 2), no interlace
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); // width
  ihdrData.writeUInt32BE(1, 4); // height
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type (RGB)
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method
  const ihdr = buildChunk("IHDR", ihdrData);

  // IDAT: single row — filter byte (0 = none) + RGB pixel (#f97316 orange)
  const rawPixel = Buffer.from([0, 0xf9, 0x73, 0x16]);
  const compressed = deflateSync(rawPixel);
  const idat = buildChunk("IDAT", compressed);

  // IEND: marks the end of the PNG
  const iend = buildChunk("IEND", Buffer.alloc(0));

  writeFileSync(filePath, Buffer.concat([signature, ihdr, idat, iend]));
}

// Files referenced in app.json that must exist for builds to succeed
const requiredAssets = [
  "icon.png",
  "splash.png",
  "adaptive-icon.png",
  "favicon.png",
];

console.log("Generating minimal placeholder PNGs in assets/ ...\n");

for (const filename of requiredAssets) {
  const filePath = join(ASSETS_DIR, filename);
  const alreadyExists = existsSync(filePath);

  if (alreadyExists) {
    console.log(`  SKIP  ${filename} (already exists)`);
  } else {
    createMinimalPng(filePath);
    console.log(`  CREATE  ${filename} (1x1 px placeholder)`);
  }
}

console.log(
  "\nDone. These are minimal 1x1 pixel PNGs so the build does not crash."
);
console.log(
  "Replace with real branding assets before publishing to app stores."
);
console.log(
  "For sized placeholders with branding, run: ./scripts/generate-assets.sh"
);
