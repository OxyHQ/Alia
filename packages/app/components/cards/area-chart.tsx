import { useId, type ReactNode } from "react";
import Svg, { Path, Defs, LinearGradient, Stop } from "react-native-svg";

/**
 * The line chart both tool cards draw.
 *
 * Hand-drawn as one `Path` rather than pulled from a charting library: the app
 * is universal and the web chart libraries the reference designs use do not
 * render on native at all. `react-native-svg` is already a dependency.
 *
 * The geometry is a separate, pure function because a card that labels its Y
 * axis has to place the labels on the same scale the curve was drawn with. Two
 * calls to `Math.min` in two files is exactly how an axis ends up disagreeing
 * with the line above it.
 */

/**
 * A five-year daily history is thousands of points inside a box a few hundred
 * units wide: detail nobody can see, in a path string a native renderer has to
 * walk on every frame. Keep the points the box has room for.
 */
const MAX_POINTS = 180;

function sampled(values: number[]): number[] {
  if (values.length <= MAX_POINTS) return values;
  const stride = (values.length - 1) / (MAX_POINTS - 1);
  return Array.from({ length: MAX_POINTS }, (_, i) => values[Math.round(i * stride)]);
}

export interface AreaGeometry {
  /** The stroked line through every point. */
  line: string;
  /** The same line, closed to the baseline, for the gradient fill. */
  area: string;
  /** The extremes of what was drawn, which is what an axis may label. */
  min: number;
  max: number;
  /** Where a value in series units lands on the chart's Y axis. */
  yFor: (value: number) => number;
}

/**
 * `null` when there is nothing to draw: one point is a dot, not a line.
 *
 * `width` is the PLOT, which is narrower than the viewBox on a card that keeps
 * a gutter for axis labels.
 */
export function areaGeometry(
  values: number[],
  plot: { width: number; height: number; padding: number },
): AreaGeometry | null {
  if (values.length < 2) return null;

  const points = sampled(values);
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min;
  const usable = plot.height - plot.padding * 2;

  // A flat series has no span to divide by. Dividing anyway is a NaN in the
  // path, and dividing by a fabricated 1 pins the whole curve to the bottom
  // edge, which on a price chart reads as a crash rather than as no change.
  const yFor = (value: number) =>
    span === 0
      ? plot.height / 2
      : plot.height - plot.padding - ((value - min) / span) * usable;

  const step = plot.width / (points.length - 1);
  const line = points
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${yFor(v).toFixed(1)}`)
    .join(" ");

  return {
    line,
    area: `${line} L${plot.width},${plot.height} L0,${plot.height} Z`,
    min,
    max,
    yFor,
  };
}

/**
 * `children` are drawn under the curve, which is where a grid belongs.
 *
 * `width` and `height` are the viewBox; the chart itself scales to whatever
 * width the card gives it.
 */
export function AreaChart({
  geometry,
  tint,
  width,
  height,
  children,
}: {
  geometry: AreaGeometry;
  tint: string;
  width: number;
  height: number;
  children?: ReactNode;
}) {
  // SVG ids are document-global on web, so two cards in one thread would each
  // define a gradient under the same name and the second would lose. `useId` is
  // per instance; the punctuation React wraps it in is stripped because the id
  // has to survive being written into a `url(#…)` reference.
  const fillId = `areaFill${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
      <Defs>
        <LinearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={tint} stopOpacity="0.35" />
          <Stop offset="1" stopColor={tint} stopOpacity="0" />
        </LinearGradient>
      </Defs>
      {children}
      <Path d={geometry.area} fill={`url(#${fillId})`} />
      <Path d={geometry.line} stroke={tint} strokeWidth={2} fill="none" />
    </Svg>
  );
}
