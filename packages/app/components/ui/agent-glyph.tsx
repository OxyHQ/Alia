import Svg, { Circle, G, Path } from "react-native-svg";
import { parseRgb, withAlpha } from "@oxyhq/bloom/theme";
import { useColorScheme } from "@/lib/useColorScheme";

export interface AgentGlyphProps {
  /** Width and height in px. Default 28 — the size the header renders. */
  size?: number;
  /**
   * The agent's own color, `User.color` on its Oxy bot account.
   *
   * Nullable on purpose: the API resolves an agent's identity through a batched
   * Oxy lookup that FAILS OPEN, so an account it cannot resolve arrives with no
   * name, no handle and no color. The fallback below is the ordinary path, not
   * an error case.
   */
  color?: string | null;
  /** Accessible name. An agent's face is not decoration when it stands for who is speaking. */
  label?: string;
}

/**
 * The face of an agent — an Alia-derived flower, tinted the agent's own color,
 * set in a disc of the same color.
 *
 * ## Why this is not `AliaMark`
 *
 * `AliaMark` is Alia's BRAND mark: it is what the welcome screen and the flying
 * mark above a streaming answer draw, it defaults to the brand purple, and it
 * carries the press flourish and the thinking spin. Rendering it as an agent's
 * face would say the agent is Alia. So the artwork is derived and the component
 * is separate, which is what lets the two diverge: an agent's mark has to be
 * legible at 20px beside a name, and it has to carry a color nobody at Alia
 * chose.
 *
 * ## Agents have no avatar
 *
 * There is no image to fall back FROM. An agent's Oxy account carries no avatar
 * at all, so this is the whole of an agent's likeness in the app, and every
 * surface that used to draw an `<Avatar>` for one draws this instead.
 */
export function AgentGlyph({ size = 28, color, label }: AgentGlyphProps) {
  const { colors } = useColorScheme();

  /**
   * `withAlpha` returns its input UNTOUCHED when it cannot parse a color, and an
   * SVG `fill` it cannot parse renders as black — so an unparseable value would
   * paint a black disc rather than fall back, and it would do it silently. The
   * color arrives from a `User.color` column with no format Alia controls, so it
   * is parsed before it is trusted: anything `parseRgb` refuses takes the same
   * path as no color at all.
   */
  const tint = color !== null && color !== undefined && parseRgb(color) !== null
    ? color
    : colors.mutedForeground;

  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      accessibilityRole="image"
      {...(label === undefined ? {} : { accessibilityLabel: label })}
    >
      <Circle cx={50} cy={50} r={50} fill={withAlpha(tint, DISC_ALPHA)} />
      <G transform={GLYPH_TRANSFORM}>
        <Path d={GLYPH_PATH} fill={tint} />
      </G>
    </Svg>
  );
}

/**
 * The disc behind the flower. Low enough that a saturated color stays a
 * background and a name beside it stays legible, high enough to read as a
 * filled shape rather than a smudge on both themes.
 */
const DISC_ALPHA = 0.16;

/**
 * The flower, mapped from its own square bounds (`74.8 74.4 1350.6 1350.6`,
 * sampled from the curves) onto the 62×62 square centred in a 100×100 box —
 * inside the disc with room to spare, since the flower's DIAGONAL is what has
 * to clear the circle, not its width.
 */
const GLYPH_TRANSFORM = "matrix(0.045906, 0, 0, 0.045906, 15.566, 15.585)";

/** The six-lobed flower. Same curves as the brand mark; see the note above on why they are copied rather than imported. */
const GLYPH_PATH =
  'M 728 76.199219 C 659.800781 84 596.601562 133.199219 558.800781 207.199219 C 539.800781 244.601562 527.199219 292.398438 524.601562 336.398438 L 523.398438 357.800781 L 506.199219 349 C 457.398438 324.199219 413.601562 313.398438 361 313.199219 C 314.601562 313 281.800781 320 247.199219 337.199219 C 194.398438 363.601562 161 404.601562 145.800781 461.199219 C 140.199219 482.199219 139.601562 527.398438 144.601562 550.199219 C 156.199219 601.800781 182 649.199219 220.601562 689.398438 C 239.800781 709.199219 271 734.601562 287.800781 744 C 292.199219 746.601562 296 749.199219 296 749.800781 C 296 750.398438 292.398438 753 288 755.601562 C 270.800781 765.398438 240 790.601562 221 810.398438 C 137.199219 897.398438 116.601562 1013 170.199219 1095.199219 C 200.199219 1141.199219 247.601562 1171.199219 309 1183.199219 C 333.601562 1188 383.800781 1188 410.800781 1183.199219 C 444 1177.199219 474.398438 1167 505.800781 1151.199219 L 524 1142 L 524 1153.601562 C 524 1180.398438 530.800781 1218.601562 541.199219 1250 C 582.800781 1376 690 1446.800781 796.800781 1419 C 846.398438 1406 893.800781 1369.800781 926 1320 C 953.601562 1277.199219 972.199219 1218.398438 975.398438 1163.601562 L 976.601562 1142.398438 L 994.398438 1151.398438 C 1044.800781 1176.601562 1087.800781 1187 1142 1186.800781 C 1192.601562 1186.601562 1229.601562 1177.199219 1269 1154.199219 C 1289.601562 1142.199219 1319.800781 1112.398438 1331.800781 1092.398438 C 1351.398438 1059.800781 1358.398438 1033.800781 1358.601562 994 C 1358.800781 953.199219 1353.199219 929.398438 1334 888.601562 C 1310.800781 839.601562 1265.398438 789 1217.601562 759.398438 C 1210.199219 754.800781 1204 750.601562 1204 750 C 1204 749.398438 1210.199219 745.199219 1217.601562 740.601562 C 1251.398438 719.601562 1291 681.199219 1313 648 C 1348.601562 594.601562 1364.601562 537 1358.199219 484.800781 C 1347.398438 397.800781 1285.398438 335.398438 1191 316.800781 C 1164.398438 311.398438 1114.199219 311.800781 1085 317.601562 C 1054.601562 323.601562 1029.398438 332 1000.601562 346 L 976 357.800781 L 976 346.398438 C 976 290 952.800781 217.800781 919.800781 171 C 881 116.398438 829 83.601562 769.199219 76 C 751.398438 73.800781 749.398438 73.800781 728 76.199219 Z';
