import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)

/**
 * The secret values to look for. The judges' sandbox buyer login (buyer 3) is published in the README by the owner's
 * decision (docs/DECISIONS.md), so its values are allowed, under whatever key name they also appear.
 */
function publishedAllowed(lines) {
  const pairs = lines.map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
  const published = new Set(pairs.filter(([k]) => /^PAYPAL_SANDBOX_BUYER3_(EMAIL|PASSWORD)$/.test(k)).map(([, v]) => v))
  return pairs.map(([, v]) => v).filter((v) => v.length >= 6 && !published.has(v))
}

describe('no secrets in the repo', () => {
  const patterns = [/access_token\$[A-Za-z0-9$_-]{20,}/, /A21AA[A-Za-z0-9_-]{40,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-[A-Za-z0-9]{20,}/]
  // Values from the local secrets file when it exists on this machine (never printed: only a count is compared).
  const local = join(homedir(), '.cloudflare', 'paypal-sandbox.local.txt')
  const values = existsSync(local)
    ? publishedAllowed(readFileSync(local, 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')))
    : []

  it('no tracked file holds a key pattern or a value from the local secrets file', () => {
    const hits = []
    for (const file of tracked) {
      if (/\.(png|woff2?|ico)$/.test(file)) continue
      const text = readFileSync(join(root, file), 'utf8')
      if (patterns.some((p) => p.test(text))) hits.push(file)
      if (values.some((v) => text.toLowerCase().includes(v.toLowerCase()))) hits.push(file)
    }
    expect(hits).toEqual([])
  })

  it('.dev.vars and public/vendor/ are ignored and not tracked', () => {
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8')
    expect(ignore).toMatch(/^\.dev\.vars$/m)
    expect(ignore).toMatch(/^public\/vendor\/$/m)
    expect(tracked.filter((f) => f === '.dev.vars' || f.startsWith('public/vendor/'))).toEqual([])
    expect(tracked.filter((f) => /bryntum/i.test(f) && f !== 'scripts/vendor-bryntum.mjs')).toEqual([])
  })
})

