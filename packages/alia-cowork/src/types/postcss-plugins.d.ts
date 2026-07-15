/**
 * `gulp-postcss` and `postcss-import` ship no bundled type declarations and
 * there is no `@types/*` package installed for them in this workspace.
 * These ambient module declarations type only the surface area actually
 * used by `gulpfile.ts` (both are CommonJS `module.exports = fn`, matched
 * here with `export =` so `esModuleInterop` default-imports them cleanly).
 */

declare module 'gulp-postcss' {
  import type { AcceptedPlugin } from 'postcss'

  /** Applies a list of PostCSS plugins to each file in a Vinyl/gulp stream. */
  function gulpPostcss(plugins?: readonly AcceptedPlugin[]): NodeJS.ReadWriteStream

  export = gulpPostcss
}

declare module 'postcss-import' {
  import type { AcceptedPlugin, Plugin } from 'postcss'

  interface AtImportOptions {
    /** Directory to resolve `@import` paths from. Defaults to `process.cwd()`. */
    root?: string
    /** Additional directories to search for imported files. */
    path?: string | string[]
    /** PostCSS plugins to run on each imported file. */
    plugins?: AcceptedPlugin[]
    /** Only transform imports for which this returns `true`. */
    filter?: (path: string) => boolean
    /** Skip re-importing files with identical content. Defaults to `true`. */
    skipDuplicates?: boolean
    /** Extra directories appended to the default module resolver. */
    addModulesDirectories?: string[]
  }

  function postcssImport(options?: AtImportOptions): Plugin

  export = postcssImport
}
