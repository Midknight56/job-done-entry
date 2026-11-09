import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')

describe('film labels', () => {
  it('the default business name and the scan label carry no demo or sandbox tag', () => {
    const files = [
      'src/state/workspace.js',
      'public/sheet.js',
      'public/customer.html',
      'public/dev.html',
    ]
    for (const file of files) {
      const content = readFileSync(join(root, file), 'utf8')
      expect(content).not.toContain('Plumbing (demo)')
      expect(content).not.toContain('PayPal (sandbox)')
    }
  })
})
