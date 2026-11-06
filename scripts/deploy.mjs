// Deploys the Worker with this machine's resource ids, which stay out of the repo.
// It reads the KV namespace id from .deploy.local.json and the shared AI ledger's D1 id from the environment
// (HACKATHON_LEDGER_D1_ID), writes wrangler.deploy.jsonc (git ignores it), copies Bryntum into public/vendor, and runs
// `wrangler deploy -c wrangler.deploy.jsonc`. Anyone else deploys with their own ids in wrangler.jsonc.
// With --dev it writes wrangler.dev.jsonc instead and runs `wrangler dev` with the ledger bound REMOTELY, because dev
// model calls spend the account's real Workers AI neurons and must be counted in the shared ledger too.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkModels, MODEL_IDS } from './check-models.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dev = process.argv.includes('--dev')
if (process.env.SKIP_MODEL_CHECK === '1') {
  console.warn('Warning: skipping model retirement check')
} else {
  const problems = await checkModels()
  for (const id of MODEL_IDS) {
    const problem = problems.find(entry => entry.startsWith(`${id}:`))
    console.log(problem ? `problem ${problem}` : `ok ${id}`)
  }
  if (problems.length) {
    process.exitCode = 1
    process.exit()
  }
}
const local = JSON.parse(readFileSync(join(root, '.deploy.local.json'), 'utf8'))
const d1 = process.env.HACKATHON_LEDGER_D1_ID
if (!local.kvId || !d1) throw new Error('need kvId in .deploy.local.json and HACKATHON_LEDGER_D1_ID in the environment')

const base = readFileSync(join(root, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
const config = JSON.parse(base)
config.kv_namespaces = [{ binding: 'JOBDONE', id: local.kvId }]
config.d1_databases = [{ binding: 'LEDGER', database_name: 'hackathon-ledger', database_id: d1, ...(dev ? { remote: true } : {}) }]
const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
config.vars = {
  ...config.vars,
  BUILD_HASH: hash,
  ...(process.env.RECORD_SAMPLES === '1' ? { RECORD_SAMPLES: '1' } : {}),
  // A dated extra share of the AI day ("YYYY-MM-DD:N"), only when a decision in docs/DECISIONS.md grants it.
  ...(process.env.EXTRA_NEURONS ? { EXTRA_NEURONS: process.env.EXTRA_NEURONS } : {}),
}
if (dev) {
  writeFileSync(join(root, 'wrangler.dev.jsonc'), JSON.stringify(config, null, 2))
  execFileSync('npx', ['wrangler', 'dev', '-c', 'wrangler.dev.jsonc', '--ip', '127.0.0.1', '--port', '8797'], { cwd: root, stdio: 'inherit', shell: true })
  process.exit(0)
}
writeFileSync(join(root, 'wrangler.deploy.jsonc'), JSON.stringify(config, null, 2))

execFileSync('node', [join(root, 'scripts', 'vendor-bryntum.mjs')], { cwd: root, stdio: 'inherit' })
execFileSync('npx', ['wrangler', 'deploy', '-c', 'wrangler.deploy.jsonc'], { cwd: root, stdio: 'inherit', shell: true })
console.log(`deployed build ${hash}${process.env.RECORD_SAMPLES === '1' ? ' with RECORD_SAMPLES on' : ''}`)
