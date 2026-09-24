
// Metro resolves a font file to an asset reference; a TypeScript import of one
// needs this declaration.
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
