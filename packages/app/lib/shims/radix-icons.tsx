/**
 * Web shim for `@radix-ui/react-icons`.
 *
 * The package ships a single 424,282 B ESM file with all ~300 icons and no
 * subpath exports, and Metro does not tree shake the web export — so the two
 * glyphs the dropdown menus use cost the whole set. These are the same two
 * components, transcribed verbatim from `dist/react-icons.esm.js` (v1.3.2):
 * identical 15x15 viewBox, identical path data, identical `color` prop
 * default, so nothing on screen moves.
 *
 * `metro.config.js` redirects the bare specifier here on web only; there is no
 * native consumer, because `@radix-ui/react-icons` renders DOM `<svg>`.
 * `__tests__/icon-shims.test.ts` fails if a third icon is ever imported.
 */
import * as React from 'react';

type RadixIconProps = React.SVGProps<SVGSVGElement> & { color?: string };

function radixIcon(path: string, displayName: string) {
  const Icon = React.forwardRef<SVGSVGElement, RadixIconProps>(
    ({ color = 'currentColor', ...props }, forwardedRef) => (
      <svg
        width="15"
        height="15"
        viewBox="0 0 15 15"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        {...props}
        ref={forwardedRef}
      >
        <path d={path} fill={color} fillRule="evenodd" clipRule="evenodd" />
      </svg>
    ),
  );
  Icon.displayName = displayName;
  return Icon;
}

export const CheckIcon = radixIcon(
  'M11.4669 3.72684C11.7558 3.91574 11.8369 4.30308 11.648 4.59198L7.39799 11.092C7.29783 11.2452 7.13556 11.3467 6.95402 11.3699C6.77247 11.3931 6.58989 11.3355 6.45446 11.2124L3.70446 8.71241C3.44905 8.48022 3.43023 8.08494 3.66242 7.82953C3.89461 7.57412 4.28989 7.55529 4.5453 7.78749L6.75292 9.79441L10.6018 3.90792C10.7907 3.61902 11.178 3.53795 11.4669 3.72684Z',
  'CheckIcon',
);

export const ChevronRightIcon = radixIcon(
  'M6.1584 3.13508C6.35985 2.94621 6.67627 2.95642 6.86514 3.15788L10.6151 7.15788C10.7954 7.3502 10.7954 7.64949 10.6151 7.84182L6.86514 11.8418C6.67627 12.0433 6.35985 12.0535 6.1584 11.8646C5.95694 11.6757 5.94673 11.3593 6.1356 11.1579L9.565 7.49985L6.1356 3.84182C5.94673 3.64036 5.95694 3.32394 6.1584 3.13508Z',
  'ChevronRightIcon',
);
