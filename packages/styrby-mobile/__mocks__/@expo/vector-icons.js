/**
 * Manual mock for @expo/vector-icons.
 *
 * WHY: @expo/vector-icons ships ESM (.js files using `import`) which
 * babel-jest cannot parse in CJS mode when loaded via pnpm's virtual store
 * path (.pnpm/<pkg>/node_modules/@expo/vector-icons/...). Rather than
 * fighting symlink resolution in transformIgnorePatterns, we stub the entire
 * library — icon rendering is purely cosmetic and never the logic-under-test
 * in unit or integration tests.
 *
 * Each named export returns a simple React component that renders a <Text>
 * with the icon name, which is stable and inspectable in test snapshots.
 */

const React = require('react');

/**
 * Creates a stub icon set component.
 *
 * @param {string} family - The icon family name (e.g. 'Ionicons')
 * @returns A Jest mock component
 */
function makeIconSet(family) {
  const IconComponent = jest.fn(({ name, size, color, ...rest }) =>
    React.createElement('Text', { ...rest, testID: `icon-${family}-${name}` }, name),
  );
  IconComponent.displayName = family;
  IconComponent.Button = jest.fn(({ name, ...rest }) =>
    React.createElement('Text', { ...rest, testID: `icon-btn-${family}-${name}` }, name),
  );
  return IconComponent;
}

module.exports = {
  Ionicons: makeIconSet('Ionicons'),
  MaterialIcons: makeIconSet('MaterialIcons'),
  MaterialCommunityIcons: makeIconSet('MaterialCommunityIcons'),
  FontAwesome: makeIconSet('FontAwesome'),
  FontAwesome5: makeIconSet('FontAwesome5'),
  AntDesign: makeIconSet('AntDesign'),
  Entypo: makeIconSet('Entypo'),
  EvilIcons: makeIconSet('EvilIcons'),
  Feather: makeIconSet('Feather'),
  Foundation: makeIconSet('Foundation'),
  Octicons: makeIconSet('Octicons'),
  SimpleLineIcons: makeIconSet('SimpleLineIcons'),
  Zocial: makeIconSet('Zocial'),
  createIconSet: jest.fn(() => makeIconSet('custom')),
  createIconSetFromIcoMoon: jest.fn(() => makeIconSet('icomoon')),
  createIconSetFromFontAwesome5: jest.fn(() => makeIconSet('fa5-custom')),
};
