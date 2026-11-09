import Svg, { Path } from 'react-native-svg';

/**
 * Remix Icon `reply-line` (Communication), the arrow of "reply to message". Bloom's icon set has
 * every neighbour of it but not this one; the path is Remix's own, drawn like a Bloom icon (a
 * component taking `width`, `height` and `fill`), so it can move into Bloom unchanged.
 */
export function RiReplyLine({
  width = 24,
  height = 24,
  fill = 'currentColor',
}: {
  width?: number;
  height?: number;
  fill?: string;
}) {
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12.0001 5.6416C15.8107 6.3358 18.3595 8.30993 19.922 11.082C21.5661 13.9991 22.0688 17.7084 22.0001 21.5176L20.0001 21.5C20.0001 18.8183 18.9552 17.1882 17.3995 16.1572C15.9999 15.2297 14.1119 14.7411 12.0001 14.5625V19.6348L0.437622 10L12.0001 0.365234V5.6416ZM3.56262 10L10.0001 15.3643V12.4619L11.0372 12.501C13.7135 12.6016 16.4305 13.1162 18.504 14.4902C18.8153 14.6965 19.1077 14.9232 19.3839 15.166C19.0964 14.032 18.7014 12.9899 18.1798 12.0645C16.8255 9.6616 14.5759 7.95467 10.8761 7.49219L10.0001 7.38281V4.63574L3.56262 10Z"
        fill={fill}
      />
    </Svg>
  );
}
