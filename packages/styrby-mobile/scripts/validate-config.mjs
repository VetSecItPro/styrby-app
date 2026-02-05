#!/usr/bin/env node
// =============================================================================
// validate-config.mjs — Pre-build validation for Styrby Mobile
// =============================================================================
//
// Runs before `expo prebuild` and `eas build` to catch configuration issues
// that would otherwise cause cryptic build failures.
//
// Checks:
//   1. EAS project ID is not the default placeholder value
//   2. Required asset files exist (icon.png, splash.png, etc.)
//   3. Submit credentials are set for production builds
//
// Usage:
//   node scripts/validate-config.mjs
//
// This script is called automatically via the "prebuild" npm script.
//
// Setup:
//   To set the EAS project ID, run `eas init` in this directory.
//   EAS CLI will create/update the projectId in app.json automatically.
//   See: https://docs.expo.dev/build/setup/#configure-the-project
// =============================================================================

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MOBILE_ROOT = join(__dirname, "..");

/** ANSI color codes for terminal output. */
const COLORS = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

let warnings = 0;
let errors = 0;

/**
 * Logs a warning message in yellow.
 *
 * @param {string} message - The warning message to display
 */
function warn(message) {
  warnings++;
  console.warn(`${COLORS.yellow}  WARNING${COLORS.reset}  ${message}`);
}

/**
 * Logs an error message in red.
 *
 * @param {string} message - The error message to display
 */
function error(message) {
  errors++;
  console.error(`${COLORS.red}  ERROR${COLORS.reset}    ${message}`);
}

/**
 * Logs a success message in green.
 *
 * @param {string} message - The success message to display
 */
function ok(message) {
  console.log(`${COLORS.green}  OK${COLORS.reset}       ${message}`);
}

console.log(
  `\n${COLORS.bold}Styrby Mobile — Pre-build Configuration Check${COLORS.reset}\n`
);

// ---------------------------------------------------------------------------
// 1. Check EAS project ID in app.json
// ---------------------------------------------------------------------------
const appJsonPath = join(MOBILE_ROOT, "app.json");

if (existsSync(appJsonPath)) {
  const appJson = JSON.parse(readFileSync(appJsonPath, "utf-8"));
  const projectId = appJson?.expo?.extra?.eas?.projectId;

  if (!projectId) {
    error(
      "Missing extra.eas.projectId in app.json. Run `eas init` to set it."
    );
  } else if (projectId === "your-eas-project-id") {
    warn(
      "EAS project ID is still the placeholder value ('your-eas-project-id')."
    );
    warn("Run `eas init` in this directory to set the real project ID.");
    warn(
      "Push notifications and EAS Build will not work without a valid project ID."
    );
  } else {
    ok(`EAS project ID: ${projectId}`);
  }
} else {
  error("app.json not found. This is required for Expo builds.");
}

// ---------------------------------------------------------------------------
// 2. Check required asset files exist
// ---------------------------------------------------------------------------
const requiredAssets = [
  { file: "icon.png", purpose: "App icon (iOS/Android)" },
  { file: "splash.png", purpose: "Splash screen image" },
  { file: "adaptive-icon.png", purpose: "Android adaptive icon" },
  { file: "favicon.png", purpose: "Web favicon" },
];

for (const asset of requiredAssets) {
  const assetPath = join(MOBILE_ROOT, "assets", asset.file);
  if (existsSync(assetPath)) {
    ok(`${asset.file} exists (${asset.purpose})`);
  } else {
    error(
      `Missing assets/${asset.file} (${asset.purpose}). Run: node scripts/generate-placeholders.mjs`
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Check EAS submit credentials (warning only — not blocking)
// ---------------------------------------------------------------------------
const easJsonPath = join(MOBILE_ROOT, "eas.json");

if (existsSync(easJsonPath)) {
  const easJson = JSON.parse(readFileSync(easJsonPath, "utf-8"));
  const iosSubmit = easJson?.submit?.production?.ios;
  const androidSubmit = easJson?.submit?.production?.android;

  if (iosSubmit) {
    if (!iosSubmit.appleId || !iosSubmit.ascAppId || !iosSubmit.appleTeamId) {
      warn(
        "iOS submit credentials are empty in eas.json. Fill in appleId, ascAppId, and appleTeamId before submitting to App Store."
      );
    } else {
      ok("iOS submit credentials configured");
    }
  }

  if (androidSubmit) {
    if (!androidSubmit.serviceAccountKeyPath) {
      warn(
        "Android serviceAccountKeyPath is empty in eas.json. Set it before submitting to Google Play."
      );
    } else {
      ok("Android submit credentials configured");
    }
  }
} else {
  warn("eas.json not found. Create it with build profiles before running EAS builds.");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("");

if (errors > 0) {
  console.error(
    `${COLORS.red}${COLORS.bold}FAILED${COLORS.reset}  ${errors} error(s), ${warnings} warning(s)\n`
  );
  console.error(
    "Fix the errors above before building. Warnings are non-blocking.\n"
  );
  process.exit(1);
} else if (warnings > 0) {
  console.warn(
    `${COLORS.yellow}${COLORS.bold}PASSED WITH WARNINGS${COLORS.reset}  ${warnings} warning(s)\n`
  );
  console.warn(
    "The build can proceed, but address the warnings before production release.\n"
  );
} else {
  console.log(
    `${COLORS.green}${COLORS.bold}ALL CHECKS PASSED${COLORS.reset}\n`
  );
}
