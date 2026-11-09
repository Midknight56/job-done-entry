// "What am I owed?": every figure in the answer equals a live due amount and links to its invoice; a made up figure
// is removed.
import { describe, it, expect } from 'vitest'
import { runTurn } from '../../src/agent/loop.js'
import { seedWorkspace } from '../../src/state/workspace.js'

const NOW = Date.parse('2026-11-08T15:00:00Z')
const DAY = 86_400_000

function workspace() {
  const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
  ws.invoices['INV2-SAM'] = { id: 'INV2-SAM', customerId: 'c3', kind: 'invoice', total: '340.00', due: '340.00', status: 'SENT', sentAt: NOW - 15 * DAY, reminders: 2 }
  ws.invoices['INV2-PRIYA'] = { id: 'INV2-PRIYA', customerId: 'c4', kind: 'deposit', total: '50.00', due: '50.00', status: 'SENT', sentAt: NOW - 3_600_000, reminders: 0 }
  ws.invoices['INV2-DAVE'] = { id: 'INV2-DAVE', customerId: 'c2', kind: 'invoice', total: '108.00', due: '0.00', status: 'MARKED_AS_PAID', sentAt: NOW - 2 * DAY, reminders: 0 }
  return ws
}

const model = (final) => {
  const replies = [{ calls: [{ tool: 'open_invoices', args: {} }] }, { final }]
  return async () => ({ text: JSON.stringify(replies.shift()), neurons: 0 })
}

/** Live due amounts as PayPal reports them, through a stand in API. */
const api = {
  request: async ({ path }) => {
    const id = path.split('/').pop()
    const due = { 'INV2-SAM': '340.00', 'INV2-PRIYA': '50.00' }[id]
    return { ok: true, status: 200, json: { id, status: 'SENT', amount: { value: due }, due_amount: { value: due } } }
  },
}

describe('what am I owed', () => {
  it('every figure is a live due amount and every cited invoice is open', async () => {
    const ws = workspace()
    const out = await runTurn(ws, 'What am I owed?', {
      callModel: model({ kind: 'answer', text: '340.00 from Sam, 15 days late. 50.00 deposit from Priya. 390.00 in all.', invoice_ids: ['INV2-SAM', 'INV2-PRIYA'] }),
      now: NOW,
      api,
    })
    expect(out.proposal.text).toBe('Sam Okafor owes you 340.00, 15 days late. Priya Nair owes you a 50.00 deposit. 390.00 in all.')
    expect(out.proposal.invoiceIds).toEqual(['INV2-SAM', 'INV2-PRIYA'])
  })

  it('a made up figure is removed, and a paid invoice cannot be cited', async () => {
    const ws = workspace()
    const out = await runTurn(ws, 'What am I owed?', {
      callModel: model({ kind: 'answer', text: '340.00 from Sam. Dave still owes 108.00. You will get 1,200 this month.', invoice_ids: ['INV2-SAM', 'INV2-DAVE'] }),
      now: NOW,
      api,
    })
    expect(out.proposal.text).toBe('Sam Okafor owes you 340.00, 15 days late.')
    expect(out.proposal.invoiceIds).toEqual(['INV2-SAM'])
  })
})
