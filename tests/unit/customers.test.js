import { expect, it } from 'vitest'
import * as workspace from '../../src/state/workspace.js'

const fresh = () => workspace.seedWorkspace({ id: 'w1', now: Date.now(), tzOffsetMinutes: 0 })
const fields = { name: 'Tom Baker', address: '12 Main Street', email: 'tom@example.com' }

it('adds a customer with the next id and split name', () => {
  const ws = fresh()
  expect(workspace.addCustomer(ws, fields)).toEqual({ ...fields, id: 'c11', given: 'Tom', surname: 'Baker' })
  expect(ws.customers.at(-1)).toMatchObject(fields)
})

it.each([
  ['empty name', { name: ' ' }],
  ['long name', { name: 'a'.repeat(61) }],
  ['long address', { address: 'a'.repeat(81) }],
  ['bad email', { email: 'tom@gmail.com' }],
  ['missing email', { email: undefined }],
])('rejects customer %s without changing state', (_, changes) => {
  const ws = fresh()
  const before = structuredClone(ws)
  expect(() => workspace.addCustomer(ws, { ...fields, ...changes })).toThrowError(expect.objectContaining({ status: 422 }))
  expect(ws).toEqual(before)
})

it('rejects the 21st customer without changing state', () => {
  const ws = fresh()
  while (ws.customers.length < 20) ws.customers.push({ ...ws.customers[0], id: `c${100 + ws.customers.length}` })
  const before = structuredClone(ws)
  expect(() => workspace.addCustomer(ws, fields)).toThrowError(expect.objectContaining({ status: 422 }))
  expect(ws).toEqual(before)
})

