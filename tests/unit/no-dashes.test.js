import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)

/** The words a person reads on a page: tags, scripts and styles removed. */
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
}

/** A dash between words, an en dash or an em dash. A minus sign before a number (-25) is fine. */
const DASH = /[–—]|[A-Za-z]-[A-Za-z]/

describe('no dashes in public words', () => {
  const pages = tracked.filter((f) => /^public\/[^/]+\.html$/.test(f) && f !== 'public/dev.html')
  it.each(pages)('%s', (file) => {
    const lines = visibleText(readFileSync(join(root, file), 'utf8')).split(/\s{2,}|\n/).filter((l) => DASH.test(l))
    expect(lines).toEqual([])
  })

  it('README.md prose (code spans and fenced blocks are not prose)', () => {
    const prose = readFileSync(join(root, 'README.md'), 'utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, '')
    expect(prose.split('\n').filter((l) => DASH.test(l) && !/^\s*\|?\s*-{3}/.test(l))).toEqual([])
  })
})

