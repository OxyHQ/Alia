import Entypo from '@expo/vector-icons/Entypo';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';

/**
 * The glyph of Alia's voice button: Entypo's `sound`. Remix has no equivalent, so it is
 * handed Bloom's icon contract (`width` / `fill`) for a Bloom `Button` to size and colour.
 */
export const VoiceModeIcon: BloomIconComponent = ({ width = 18, fill }) => (
  <Entypo name="sound" size={width} color={fill} />
);
