import { task, series, parallel, watch as gulpWatch, src, dest } from 'gulp'
import * as esbuild from 'esbuild'
import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
// @ts-ignore
import gulpPostcss from 'gulp-postcss'
// @ts-ignore
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
    external: ['electron', 'ai', '@ai-sdk/google', '@ai-sdk/openai', '@ai-sdk/anthropic', 'zod'],
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
    external: ['electron', 'ai', '@ai-sdk/google', '@ai-sdk/openai', '@ai-sdk/anthropic', 'zod'],
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

  console.log('Watching for changes...')

  // Watch CSS files
  gulpWatch([paths.renderer.css, 'renderer/src/**/*.css'], series('build:css'))

  // Watch HTML and public files
  gulpWatch([paths.renderer.html], series('build:html'))
  gulpWatch([paths.renderer.public + '/**/*'], series('copy:assets'))
})

// Start Electron in development mode
task('electron:start', (done) => {
  const electronProcess = spawn(
    require('electron').toString(),
    ['.'],
    {
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'development' },
    }
  )

  electronProcess.on('close', () => {
    done()
  })
})

// Development mode
task('dev', series('build', parallel('watch', 'electron:start')))

// Clean build directory
task('clean', async () => {
  if (fs.existsSync('dist')) {
    fs.rmSync('dist', { recursive: true })
  }
})
