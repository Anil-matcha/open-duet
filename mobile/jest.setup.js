// The keyboard library has native code; its own test double stands in for it.
jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));
