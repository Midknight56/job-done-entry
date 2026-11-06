import { describe, expect, it, vi } from 'vitest'
import { MODEL } from '../../src/ai/model.js'
import { WHISPER } from '../../src/ai/whisper.js'
import { checkModels, MODEL_IDS, modelPageUrl, retirementLine } from '../../scripts/check-models.mjs'

const response = (status, html = '') => ({ status, text: async () => html })

describe('model retirement check', () => {
  it('fails when a model page has a planned deprecation', async () => {
    const fetchImpl = vi.fn(async () => response(200, '<h2>Model Info</h2><p>Planned Deprecation 11/20/2026</p><h2>Context Window</h2>'))
    expect(retirementLine('<h2>Model Info</h2><p>Planned Deprecation 11/20/2026</p><h2>Context Window</h2>')).toBe('Planned Deprecation 11/20/2026')
    expect(await checkModels(fetchImpl)).toEqual([
      `${MODEL}: Planned Deprecation 11/20/2026`,
      `${WHISPER}: Planned Deprecation 11/20/2026`,
    ])
    expect(fetchImpl).toHaveBeenCalledWith(modelPageUrl(MODEL))
  })

  it('passes a model page with no retirement notice', async () => {
    const fetchImpl = vi.fn(async () => response(200, '<p>Model Info Context Window 131,000 tokens Function calling Yes</p>'))
    expect(retirementLine('<p>Model Info Context Window 131,000 tokens Function calling Yes</p>')).toBeNull()
    expect(await checkModels(fetchImpl)).toEqual([])
  })

  it('fails when a model page returns 404', async () => {
    expect(await checkModels(async () => response(404))).toEqual([
      `${MODEL}: could not read the model page`,
      `${WHISPER}: could not read the model page`,
    ])
  })

  it('fails when fetching a model page throws', async () => {
    expect(await checkModels(async () => { throw new Error('offline') })).toEqual([
      `${MODEL}: could not read the model page`,
      `${WHISPER}: could not read the model page`,
    ])
  })

  it('checks exactly the configured model and Whisper ids', () => {
    expect(MODEL_IDS).toEqual([MODEL, WHISPER])
    expect(MODEL_IDS.join(' ')).not.toContain('qwen')
  })
})
