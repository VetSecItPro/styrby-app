/**
 * Apple target config for the Styrby home-screen widget (Cluster C1).
 *
 * Consumed by @bacons/apple-targets at prebuild to generate the WidgetKit
 * extension target. The App Group MUST match app.json's
 * ios.entitlements["com.apple.security.application-groups"] so the app and the
 * widget read/write the same shared UserDefaults suite.
 *
 * @type {import('@bacons/apple-targets/app.plugin').Config}
 */
module.exports = {
  type: 'widget',
  name: 'StyrbyWidget',
  // WidgetKit container backgrounds (.containerBackground) require iOS 17.
  deploymentTarget: '17.0',
  entitlements: {
    'com.apple.security.application-groups': ['group.com.steelmotion.styrby'],
  },
  colors: {
    $accent: '#f97316',
    $widgetBackground: '#0a0a0a',
  },
};
