import { describe, it, expect } from 'vitest'
import { seedWorkspace } from '../../src/state/workspace.js'

describe('late invoice setting', () => {
  it('seeds the workspace with a seven day late threshold', () => {
    const ws = seedWorkspace({ id: 'w1', now: Date.parse('2026-10-28T14:00:00Z'), tzOffsetMinutes: 0 })
    expect(ws.settings.lateDays).toBe(7)
  })
})
