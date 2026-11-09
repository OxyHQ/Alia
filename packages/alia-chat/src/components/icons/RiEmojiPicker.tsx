import Svg, { Path } from 'react-native-svg';

/**
 * The "react to message" glyph of the agent chat this thread is modelled on: a smiley with a ring.
 * Drawn like a Bloom icon (a component taking `width`, `height` and `fill`), so it can move into
 * Bloom unchanged, as `RiReplyLine` can.
 */
export function RiEmojiPicker({
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
        d="M10.2178 14.0449C10.7169 14.7542 11.3705 15.1023 11.9941 15.0996C12.6176 15.1036 13.2696 14.7581 13.7666 14.0479C13.8226 13.9676 13.8738 13.8894 13.9258 13.8018C14.3034 13.9338 14.681 14.0662 15.0586 14.1982C15.0329 14.3318 15.0042 14.4569 14.9639 14.5898C14.6572 15.7516 13.4632 16.9244 11.9922 16.9004C10.5217 16.9202 9.33299 15.7505 9.02246 14.5908C8.98181 14.4582 8.95282 14.3336 8.92676 14.2002C9.30379 14.067 9.68059 13.933 10.0576 13.7998C10.1098 13.8872 10.1616 13.965 10.2178 14.0449Z"
        fill={fill}
      />
      <Path
        d="M8.49219 9C9.32047 9 9.99195 9.63612 9.99219 10.5195C9.99219 11.4032 9.32061 12 8.49219 12C7.66376 12 6.99219 11.4032 6.99219 10.5195C6.99242 9.63612 7.66391 9 8.49219 9Z"
        fill={fill}
      />
      <Path
        d="M15.4922 9C16.3205 9 16.992 9.63612 16.9922 10.5195C16.9922 11.4032 16.3206 12 15.4922 12C14.6638 12 13.9922 11.4032 13.9922 10.5195C13.9924 9.63612 14.6639 9 15.4922 9Z"
        fill={fill}
      />
      <Path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2ZM12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4Z"
        fill={fill}
      />
    </Svg>
  );
}
