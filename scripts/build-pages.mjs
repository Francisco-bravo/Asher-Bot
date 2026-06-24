// Genera el directorio estático para Cloudflare Pages a partir de panel.html.
// Produce dist-pages/index.html (copia del panel) y dist-pages/config.js, que
// define las URLs ABSOLUTAS de los backends del VPS (bot.mjs y web.mjs). Así el
// mismo panel.html sirve para dev (lo sirve bot.mjs, mismo origen) y para Pages.
//
// Uso:
//   BOT_BASE=https://bot-test.aronne.dev WEB_BASE=https://web-test.aronne.dev \
//   node scripts/build-pages.mjs
// Luego: npx wrangler pages deploy dist-pages --project-name=<proyecto>
import { mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BOT_BASE = (process.env.BOT_BASE || '').replace(/\/$/, '')
const WEB_BASE = (process.env.WEB_BASE || '').replace(/\/$/, '')

if (!BOT_BASE || !WEB_BASE) {
  console.error('Falta BOT_BASE y/o WEB_BASE. Ej:')
  console.error('  BOT_BASE=https://bot-test.aronne.dev WEB_BASE=https://web-test.aronne.dev node scripts/build-pages.mjs')
  process.exit(1)
}

const out = join(ROOT, 'dist-pages')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

copyFileSync(join(ROOT, 'panel.html'), join(out, 'index.html'))
writeFileSync(join(out, 'config.js'),
  `// Generado por scripts/build-pages.mjs — bases de API del VPS.\n` +
  `window.BOT_BASE = ${JSON.stringify(BOT_BASE)};\n` +
  `window.WEB_BASE = ${JSON.stringify(WEB_BASE)};\n`)

// Activos estáticos (logo + favicon) que el panel referencia por ruta relativa.
for (const asset of ['Asher_logo.jpg', 'Asher_icon.jpg']) {
  const src = join(ROOT, asset)
  if (existsSync(src)) copyFileSync(src, join(out, asset))
  else console.warn(`  (aviso) falta ${asset} en la raíz`)
}

console.log(`dist-pages/ listo:`)
console.log(`  index.html  (copia de panel.html)`)
console.log(`  Asher_logo.jpg / Asher_icon.jpg`)
console.log(`  config.js   BOT_BASE=${BOT_BASE}  WEB_BASE=${WEB_BASE}`)
console.log(`\nDesplegar:  npx wrangler pages deploy dist-pages --project-name=<proyecto>`)
