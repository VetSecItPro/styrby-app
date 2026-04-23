/**
 * Detox Configuration — styrby-mobile
 *
 * WHY this file: Phase 1.6.12b adds real device cold-start measurement via Detox.
 * The proxy test (src/__tests__/cold-start-proxy.test.ts) runs on every PR as a
 * cheap canary. This Detox config gates the *real* measurement — actual launch-time
 * instrumented on a running emulator — which requires an EAS build artifact.
 *
 * ACTIVATION:
 *   The EAS workflow (.github/workflows/eas-cold-start.yml) is triggered manually
 *   until a paid EAS tier is enabled. See docs/infrastructure/eas-cold-start.md
 *   for the full activation runbook.
 *
 * BUDGET RATIONALE:
 *   Android cold-start budget: 3 000 ms p95
 *     Source: Sentry Mobile Vitals "Good" threshold < 3 s
 *     (https://docs.sentry.io/product/insights/mobile/mobile-vitals/)
 *     Google Play flags cold-start > 5 s as "excessive"
 *     (https://developer.android.com/topic/performance/vitals/launch-time)
 *     We set 3 s as the engineering target — well below Play's danger threshold
 *     while matching what users perceive as "instant" (Human Factors research
 *     shows 3 s is the attention-loss boundary; Nielsen Norman Group, 1993,
 *     still corroborated by Google's web perf research).
 *
 *   iOS cold-start budget: 2 000 ms p95
 *     Source: Apple HIG recommends the first frame appear within 400 ms; total
 *     interactive-ready time under 2 s is consistent with Apple's App Store
 *     review guidance and Instruments "Launch" template defaults.
 *     (https://developer.apple.com/design/human-interface-guidelines/loading)
 *     iOS hardware is uniformly faster than Android mid-tier, so 2 s budget
 *     is appropriately tighter.
 *
 * DEVICE TARGETS:
 *   Android: API 31 (Android 12), x86_64 — approximates a Pixel 6 class device.
 *     Pixel 6 uses Tensor G1; emulator on x86_64 host is faster, but API 31
 *     DEX bytecode + ART AOT compile overhead is representative of mid-tier
 *     real-world cold start. Use `--no-snapshot-save` to guarantee cold boot.
 *
 *   iOS: iPhone 13 simulator (iOS 16+). iPhone 13 is the median-performing
 *     device in Styrby's projected user base based on App Store analytics.
 *
 * @see https://wix.github.io/Detox/docs/config/overview
 * @see docs/infrastructure/eas-cold-start.md
 */

/** @type {Detox.DetoxConfig} */
module.exports = {
  testRunner: {
    args: {
      // Use Jest as the Detox test runner.
      // WHY $0: Detox resolves this to the local jest binary automatically.
      $0: 'jest',
      config: 'e2e/jest.config.js',
    },
    jest: {
      setupTimeout: 180000, // 3 min — emulator boot + APK install
    },
  },

  apps: {
    /**
     * Android release APK built by EAS with the 'cold-start-test' profile.
     * The APK is downloaded from EAS artifacts before the Detox run in CI.
     * Locally, build with: `pnpm --filter styrby-mobile run e2e:build:cold-start`
     *
     * WHY release type: Debug builds include Metro bundler overhead (JS hot-reload
     * socket, Flipper bridge) that inflates cold-start by 200-400 ms. Release
     * builds match what end-users experience.
     */
    'android.release': {
      type: 'android.apk',
      // Path is relative to the package root. In CI, the EAS artifact download
      // step places the APK here before `detox test` runs.
      binaryPath: 'build/styrby-release.apk',
      build:
        'cd ../.. && pnpm --filter styrby-mobile run e2e:build:cold-start',
    },

    /**
     * iOS release .app built by the iOS simulator profile.
     * Simulator builds (.app) are used instead of device builds (.ipa) because
     * GitHub-hosted macOS runners do not have connected physical iOS devices.
     *
     * WHY release configuration: Same rationale as Android — debug artifacts
     * include Metro dev-server socket setup that skews cold-start measurements.
     */
    'ios.release': {
      type: 'ios.app',
      binaryPath: 'build/StyrbyRelease.app',
      build:
        'cd ../.. && pnpm --filter styrby-mobile run e2e:build:cold-start:ios',
    },
  },

  devices: {
    /**
     * Android emulator configuration.
     *
     * WHY API 31 / Pixel_6_API_31:
     *   - Android 12 (API 31) is the lowest API supported by Styrby and the
     *     most common Android version among mid-tier devices as of 2026.
     *   - Pixel_6_API_31 AVD name must match exactly what the
     *     reactivecircus/android-emulator-runner action creates in CI.
     *     See .github/workflows/eas-cold-start.yml for the matching avd-name.
     *
     * WHY x86_64 architecture:
     *   GitHub-hosted ubuntu-latest runners are x86_64. ARM emulators on x86
     *   hosts require nested virtualisation which GitHub Actions does not support.
     *   We use x86_64 system images (AOSP, no Google APIs) for maximum CI compat.
     */
    emulator: {
      type: 'android.emulator',
      device: {
        avdName: 'Pixel_6_API_31',
      },
    },

    /**
     * iOS simulator configuration.
     *
     * WHY iPhone 13 / iOS 16:
     *   - iPhone 13 (A15 Bionic) represents the median performance tier in
     *     Styrby's target market as of 2026.
     *   - iOS 16 is the oldest iOS version supported by Expo SDK 52+.
     */
    simulator: {
      type: 'ios.simulator',
      device: {
        type: 'iPhone 13',
        os: 'iOS 16.4',
      },
    },
  },

  configurations: {
    /**
     * Primary CI configuration — Android emulator, release APK.
     * Used by: `detox test --configuration android.emu.release`
     *
     * WHY this is the primary: Android mid-tier is the more constrained
     * environment and the budget (3 000 ms) is the harder-to-meet target.
     * Passing here is the gating signal for Phase 1.6.12b.
     */
    'android.emu.release': {
      device: 'emulator',
      app: 'android.release',
    },

    /**
     * iOS simulator configuration.
     * Used by: `detox test --configuration ios.sim.release`
     *
     * NOTE (2026-04-22): GitHub-hosted macOS runners are available but cost
     * significantly more. The EAS workflow currently only runs the Android job.
     * Add an iOS job once EAS paid tier is enabled and runner costs are confirmed.
     */
    'ios.sim.release': {
      device: 'simulator',
      app: 'ios.release',
    },
  },
};
