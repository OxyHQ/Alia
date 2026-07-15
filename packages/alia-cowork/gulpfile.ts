/// <reference path="./src/types/postcss-plugins.d.ts" />
import { task, series, parallel, watch as gulpWatch, src, dest } from 'gulp'
import * as esbuild from 'esbuild'
import { spawn, type ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import gulpPostcss from 'gulp-postcss'
import postcssImport from 'postcss-import'
import tailwindcss from '@tailwindcss/postcss'
import autoprefixer from 'autoprefixer'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const isDev = process.env.NODE_ENV !== 'production'

// Paths
const paths = {
  main: {
    entry: 'src/main/index.ts',
    outdir: 'dist/main',
  },
  preload: {
    entry: 'src/preload/index.ts',
    outdir: 'dist/preload',
  },
  renderer: {
    entry: 'renderer/src/main.tsx',
    css: 'renderer/src/index.css',
    outdir: 'dist/renderer',
    html: 'renderer/index.html',
    public: 'renderer/public',
  },
}

// esbuild contexts for watch mode
let mainContext: esbuild.BuildContext | null = null
let preloadContext: esbuild.BuildContext | null = null
let rendererContext: esbuild.BuildContext | null = null

// Build main process
task('build:main', async () => {
  const options: esbuild.BuildOptions = {
    entryPoints: [paths.main.entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outdir: paths.main.outdir,
    external: ['electron', 'electron-store', 'dotenv', 'openai', '@browserbasehq/stagehand', 'playwright'],
    sourcemap: isDev,
    minify: !isDev,
    format: 'cjs',
  }

  if (mainContext) {
    await mainContext.rebuild()
  } else {
    await esbuild.build(options)
  }
})

// Build preload script
task('build:preload', async () => {
  const options: esbuild.BuildOptions = {
    entryPoints: [paths.preload.entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outdir: paths.preload.outdir,
    external: ['electron'],
    sourcemap: isDev,
    minify: !isDev,
    format: 'cjs',
  }

  if (preloadContext) {
    await preloadContext.rebuild()
  } else {
    await esbuild.build(options)
  }
})

// Build CSS with PostCSS
task('build:css', () => {
  const plugins = [
    postcssImport({
      path: [
        path.join(__dirname, 'renderer/node_modules'),
        path.join(__dirname, 'node_modules'),
      ],
    }),
    tailwindcss(),
    autoprefixer(),
  ]

  return src(paths.renderer.css)
    .pipe(gulpPostcss(plugins))
    .on('error', (err: Error) => {
      console.error('PostCSS Error:', err)
      throw err
    })
    .pipe(dest(paths.renderer.outdir))
})

// Build renderer JS/TS
task('build:renderer:js', async () => {
  const options: esbuild.BuildOptions = {
    entryPoints: [paths.renderer.entry],
    bundle: true,
    platform: 'browser',
    target: ['chrome120'],
    outdir: paths.renderer.outdir,
    sourcemap: isDev,
    minify: !isDev,
    format: 'esm',
    splitting: true,
    jsx: 'automatic',
    loader: {
      '.woff': 'file',
      '.woff2': 'file',
      '.ttf': 'file',
      '.eot': 'file',
      '.svg': 'file',
      '.png': 'file',
      '.jpg': 'file',
      '.jpeg': 'file',
      '.gif': 'file',
    },
    assetNames: 'assets/[name]-[hash]',
    external: ['*.css'],
  }

  if (rendererContext) {
    await rendererContext.rebuild()
  } else {
    await esbuild.build(options)
  }
})

// Copy and process HTML
task('build:html', (done) => {
  const htmlContent = fs.readFileSync(paths.renderer.html, 'utf-8')
  let updatedHtml = htmlContent.replace(
    /<script[^>]*src="[^"]*main\.tsx"[^>]*><\/script>/,
    '<script type="module" src="./main.js"></script>'
  )
  updatedHtml = updatedHtml.replace(
    '</head>',
    '    <link rel="stylesheet" href="./index.css">\n  </head>'
  )
  fs.writeFileSync(path.join(paths.renderer.outdir, 'index.html'), updatedHtml)
  done()
})

// Copy public assets
task('copy:assets', (done) => {
  if (fs.existsSync(paths.renderer.public)) {
    copyDir(paths.renderer.public, paths.renderer.outdir)
  }
  done()
})

// Helper to copy directory
function copyDir(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

// Build renderer (JS + CSS + HTML + assets)
task('build:renderer', series('build:css', 'build:renderer:js', 'build:html', 'copy:assets'))

// Build all
task('build', parallel('build:main', 'build:preload', 'build:renderer'))

// Watch mode
task('watch', async () => {
  // Create esbuild contexts for watch mode
  mainContext = await esbuild.context({
    entryPoints: [paths.main.entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outdir: paths.main.outdir,
    external: ['electron', 'electron-store', 'dotenv', 'openai', '@browserbasehq/stagehand', 'playwright'],
    sourcemap: true,
    format: 'cjs',
  })

  preloadContext = await esbuild.context({
    entryPoints: [paths.preload.entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outdir: paths.preload.outdir,
    external: ['electron'],
    sourcemap: true,
    format: 'cjs',
  })

  rendererContext = await esbuild.context({
    entryPoints: [paths.renderer.entry],
    bundle: true,
    platform: 'browser',
    target: ['chrome120'],
    outdir: paths.renderer.outdir,
    sourcemap: true,
    format: 'esm',
    splitting: true,
    jsx: 'automatic',
    loader: {
      '.woff': 'file',
      '.woff2': 'file',
      '.ttf': 'file',
      '.eot': 'file',
      '.svg': 'file',
      '.png': 'file',
      '.jpg': 'file',
      '.jpeg': 'file',
      '.gif': 'file',
    },
    assetNames: 'assets/[name]-[hash]',
    external: ['*.css'],
  })

  // Start watching
  await Promise.all([
    mainContext.watch(),
    preloadContext.watch(),
    rendererContext.watch(),
  ])

  console.log('\n✓ Watching main process (src/main/**)')
  console.log('✓ Watching preload script (src/preload/**)')
  console.log('✓ Watching renderer process (renderer/src/**)')

  // Watch CSS files with logging
  gulpWatch([paths.renderer.css, 'renderer/src/**/*.css'], (done) => {
    const timestamp = new Date().toLocaleTimeString()
    console.log(`[${timestamp}] 🎨 CSS changed, rebuilding...`)
    return series('build:css')(done)
  })

  // Watch HTML and public files with logging
  gulpWatch([paths.renderer.html], (done) => {
    const timestamp = new Date().toLocaleTimeString()
    console.log(`[${timestamp}] 📄 HTML changed, rebuilding...`)
    return series('build:html')(done)
  })

  gulpWatch([paths.renderer.public + '/**/*'], (done) => {
    const timestamp = new Date().toLocaleTimeString()
    console.log(`[${timestamp}] 📁 Assets changed, copying...`)
    return series('copy:assets')(done)
  })

  console.log('✓ Watching CSS files (renderer/src/**/*.css)')
  console.log('✓ Watching HTML files (renderer/index.html)')
  console.log('✓ Watching public assets (renderer/public/**)')
  console.log('\n👀 Ready! Watching for file changes...\n')
})

let electronProcess: ChildProcess | null = null

// Kill any existing Electron processes
task('kill-electron', (done) => {
  try {
    const { execSync } = require('child_process')
    // Kill any existing electron processes for this project
    try {
      if (process.platform === 'win32') {
        execSync('taskkill /F /IM electron.exe 2>nul', { stdio: 'ignore' })
      } else {
        execSync('pkill -f "electron.*alia-cowork" || true', { stdio: 'ignore' })
      }
    } catch (e) {
      // Ignore errors if no processes to kill
    }
    console.log('✓ Cleaned up existing Electron processes')
  } catch (e) {
    // Ignore
  }
  done()
})

// Clear caches
task('clear-cache', (done) => {
  const cacheDirs = [
    '.vite',
    'renderer/node_modules/.vite',
    'renderer/.vite',
  ]

  cacheDirs.forEach(dir => {
    const fullPath = path.join(__dirname, dir)
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true })
    }
  })
  console.log('✓ Cleared Vite caches')
  done()
})

// Start Electron in development mode with auto-restart
task('electron:start', (done) => {
  let restartCount = 0

  function startElectron() {
    const timestamp = new Date().toLocaleTimeString()
    console.log(`\n[${timestamp}] Starting Electron... ${restartCount > 0 ? `(restart #${restartCount})` : ''}`)

    electronProcess = spawn(
      require('electron').toString(),
      ['.'],
      {
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'development' },
      }
    )

    electronProcess.on('close', (code: number) => {
      const timestamp = new Date().toLocaleTimeString()

      if (code === 0) {
        // Normal exit
        console.log(`[${timestamp}] Electron exited normally`)
        done()
      } else {
        // Abnormal exit - auto restart
        console.log(`\n[${timestamp}] ⚠️  Electron crashed (code ${code}). Restarting in 2 seconds...`)
        restartCount++
        setTimeout(() => {
          if (!done) return
          startElectron()
        }, 2000)
      }
    })

    electronProcess.on('error', (err: Error) => {
      console.error(`[Electron Error] ${err.message}`)
    })
  }

  startElectron()
})

// Development mode with improvements
task('dev', series(
  'kill-electron',
  'clear-cache',
  'build',
  parallel('watch', 'electron:start')
))

// Clean build directory
task('clean', async () => {
  console.log('Cleaning build directory...')
  if (fs.existsSync('dist')) {
    fs.rmSync('dist', { recursive: true })
  }
  console.log('✓ Build directory cleaned')
})

// Full clean (build + cache)
task('clean:all', series('clean', 'clear-cache'))
