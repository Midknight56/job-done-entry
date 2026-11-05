import { describe, it, expect } from 'vitest'
import { remapInvoices } from '../../src/agent/replay.js'

describe('replayed invoice ids', () => {
  it('a recorded invoice id becomes the same customer\'s open invoice in this demo', () => {
    const results = [
      { tool: 'find_customer', result: { matches: [{ id: 'c2' }] } },
      { tool: 'open_invoices', result: { invoices: [{ invoice_id: 'INV2-AAAA-BBBB-CCCC-DDDD', customer_id: 'c1' }, { invoice_id: 'INV2-NEW1-NEW2-NEW3-NEW4', customer_id: 'c2' }] } },
    ]
    const messages = [{ content: `Tool results: ${JSON.stringify(results)}\nNow reply` }]
    const out = remapInvoices('{"final":{"kind":"cash","invoice_id":"INV2-79BF-MDPZ-X4MN-DP6F","amount":"108.00"}}', messages)
    expect(out).toBe('{"final":{"kind":"cash","invoice_id":"INV2-NEW1-NEW2-NEW3-NEW4","amount":"108.00"}}')
  })

  it('a first step with no tool results is left alone', () => {
    expect(remapInvoices('{"calls":[]}', [{ content: 'The tradesperson said' }])).toBe('{"calls":[]}')
  })
})
