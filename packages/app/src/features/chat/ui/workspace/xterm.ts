// Native (and type) facade: native never mounts the web terminal, because its
// terminal runs xterm inside a WebView (TERMINAL_HTML in agent-terminal.tsx).
// Metro resolves `./xterm` to xterm.web.ts on web, so the library stays out of
// the native bundle; these declarations only give TypeScript its types.
export declare const Terminal: typeof import('@xterm/xterm').Terminal;
export declare const FitAddon: typeof import('@xterm/addon-fit').FitAddon;
