// The keyboard library has native code; its own test double stands in for it.
jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));

// The icon library loads its font file on first use, which a test has no asset registry for. A plain View
// carrying the icon's name stands in, so a test can still see which icon is drawn.
jest.mock('@expo/vector-icons/Feather', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Feather = ({ name }) => React.createElement(View, { testID: `icon-${name}` });
  return { __esModule: true, default: Feather };
});
