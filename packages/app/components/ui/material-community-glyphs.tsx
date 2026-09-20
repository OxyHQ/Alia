/**
 * MaterialCommunityIcons, narrowed to the glyphs the app actually draws.
 *
 * `@expo/vector-icons/MaterialCommunityIcons` inlines the whole 7,448-entry
 * glyph map, which measured 186,311 B in the web bundle — for the two marks on
 * `/download`. This builds the same icon set from the same font file under the
 * same family name, with only those two codepoints, so the rendered glyphs are
 * identical; only the name -> codepoint table shrinks.
 *
 * Read a codepoint out of
 * `@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/MaterialCommunityIcons.json`
 * before adding a name here.
 */
import createIconSet from '@expo/vector-icons/createIconSet';
import font from '@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/MaterialCommunityIcons.ttf';

const GLYPHS = {
  android: 983090,
  apple: 983093,
} as const;

export type MaterialCommunityGlyph = keyof typeof GLYPHS;

export default createIconSet(GLYPHS, 'material-community', font);
