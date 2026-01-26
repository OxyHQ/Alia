import postcssImport from 'postcss-import'
import tailwindcss from '@tailwindcss/postcss'
import autoprefixer from 'autoprefixer'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default {
  plugins: [
    postcssImport({
      path: [
        join(__dirname, 'renderer/node_modules'),
        join(__dirname, 'node_modules'),
        join(__dirname, 'renderer/src'),
      ],
    }),
    tailwindcss(),
    autoprefixer(),
  ],
}
