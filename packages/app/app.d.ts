
// Metro resolves a font file to an asset reference. `@expo/vector-icons` ships
// plain JS and needs no declaration; `components/ui/material-community-glyphs.tsx`
// is TypeScript and does.
declare module '*.ttf' {
  const content: number;
  export default content;
}

declare module '*.svg' {
  import * as React from 'react';
  import { SvgProps } from 'react-native-svg';
  const content: React.FC<SvgProps>;
  export default content;
}
