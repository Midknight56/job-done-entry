// Checks that model text never becomes page markup.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)

describe('model text never becomes page markup', () => {
  it('every innerHTML in the pages escapes what it inserts, and the calendar grid uses none', () => {
    const offenders = []
    for (const file of tracked.filter((f) => /^public\/[^/]+\.js$/.test(f) && !f.startsWith('public/vendor/'))) {
      const lines = readFileSync(join(root, file), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/innerHTML\s*=/.test(line)) return
        // A template that inserts something must pass it through esc() or money().
        const block = lines.slice(i, i + 12).join('\n').split('`')[1] || ''
        // `rows` in cards.js is markup built line by line from esc() and money() parts.
        for (const m of block.matchAll(/\$\{([^}]+)\}/g)) if (!/^\s*(esc|money)\(|^\s*rows\s*$/.test(m[1])) offenders.push(`${file}:${i + 1} ${m[1].trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('install and storage documentation', () => {
  it('vendors Bryntum after npm install', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts.postinstall).toBe('node scripts/vendor-bryntum.mjs')
  })

  it('documents the vendor command and Durable Object storage', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    expect(readme).toContain('npm run vendor')
    expect(readme).toContain('Durable Object')
    expect(readme).not.toContain('one KV document')
  })
})
