// Metro resolves a font file to an asset reference; a TypeScript import of one
// needs this declaration.
declare module '*.ttf' {
  const content: number;
  export default content;
}
