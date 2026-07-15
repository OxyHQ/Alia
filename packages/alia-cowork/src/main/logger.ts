/**
 * Minimal leveled logger for the Electron MAIN process.
 *
 * There is no `electron-log` (or any other logging library) in this
 * package's dependencies, so this is a small, dependency-free replacement
 * for the raw `console.*` calls that used to be scattered across the main
 * process. Every main-process module gets a scoped logger via
 * `createLogger('ModuleName')` instead of calling `console` directly.
 *
 * `debug` is verbose step-by-step tracing and is suppressed unless
 * `NODE_ENV=development`; `info`/`warn`/`error` always log.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const isDev = process.env.NODE_ENV === 'development'

function stringifyArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || arg.message
  if (typeof arg === 'string') return arg
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

function write(level: LogLevel, scope: string, message: string, args: unknown[]): void {
  if (level === 'debug' && !isDev) return

  const timestamp = new Date().toISOString()
  const suffix = args.length ? ` ${args.map(stringifyArg).join(' ')}` : ''
  const line = `${timestamp} [${level.toUpperCase()}] [${scope}] ${message}${suffix}\n`
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout

  stream.write(line)
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** Creates a logger scoped to a single main-process module (e.g. `createLogger('ChatProvider')`). */
export function createLogger(scope: string): Logger {
  return {
    debug: (message, ...args) => write('debug', scope, message, args),
    info: (message, ...args) => write('info', scope, message, args),
    warn: (message, ...args) => write('warn', scope, message, args),
    error: (message, ...args) => write('error', scope, message, args)
  }
}
