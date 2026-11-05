// Checks that no tracked file and no commit message names a coding helper. The names are stored reversed so this
// file does not name them either.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
const names = ['xedoc', 'inimeg', 'edualc', 'tolipoc', 'tpgtahc'].map((n) => [...n].reverse().join(''))
const pattern = new RegExp(`\\b(${names.join('|')})\\b`, 'i')
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

describe('no helper names anywhere', () => {
  it('no tracked text file names a coding helper', () => {
    const offenders = []
    for (const file of git(['ls-files']).split('\n').filter(Boolean)) {
      if (/\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|mp3|mp4|wav)$/i.test(file)) continue
      const lines = readFileSync(join(root, file), 'utf8').split('\n')
      lines.forEach((line, i) => { if (pattern.test(line)) offenders.push(`${file}:${i + 1}`) })
    }
    expect(offenders).toEqual([])
  })

  it('no commit message names a coding helper', () => {
    const offenders = git(['log', '--format=%h %B']).split('\n').filter((line) => pattern.test(line))
    expect(offenders).toEqual([])
  })
})
