// Copies the Bryntum Calendar trial build from node_modules into public/vendor/bryntum/ so the Worker can serve it.
// Bryntum's code is commercial: public/vendor/ is in .gitignore and never enters this MIT repo. Run by `npm run vendor`
// (and before every deploy). Without the package the app uses public/fallback-calendar.js instead.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'node_modules', '@bryntum', 'calendar')
const to = join(root, 'public', 'vendor', 'bryntum')

if (!existsSync(from) || !existsSync(join(from, 'calendar.module.js'))) {
  console.log('Bryntum Calendar is not installed; the fallback calendar will be used.')
  process.exit(0)
}
rmSync(to, { recursive: true, force: true })
mkdirSync(to, { recursive: true })
for (const file of ['calendar.module.js', 'calendar.css', 'svalbard-light.css']) cpSync(join(from, file), join(to, file))
cpSync(join(from, 'fontawesome'), join(to, 'fontawesome'), { recursive: true })
cpSync(join(from, 'fonts'), join(to, 'fonts'), { recursive: true })
writeFileSync(join(to, 'VERSION'), 'Bryntum Calendar 7.3.7 trial, copied from node_modules by scripts/vendor-bryntum.mjs\n')
console.log(`Copied Bryntum Calendar into ${to}`)
