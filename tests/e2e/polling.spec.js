import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'

test('polls keep reminder text, focus, selection and a pending button', async ({ page }) => {
  await page.goto('/?calendar=fallback')
  await newDemo(page, 0)
  const state = await (await page.request.get('/api/state')).json()
  let polls = 0
  await page.route('**/api/state**', (route) => {
    polls++
    return route.fulfill({ json: state })
  })
  await page.reload()
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('Remind Dave about his invoice.')
  await page.getByRole('button', { name: 'Send text' }).click()
  const text = page.getByRole('textbox', { name: 'Your own message, to copy into a text or email' })
  await expect(text).toBeVisible()
  await page.waitForTimeout(3500)
  await text.fill('Please pay when you can. Thank you.')
  await text.evaluate((element) => element.setSelectionRange(11, 15, 'backward'))
  const original = await text.elementHandle()
  await page.waitForTimeout(7000)
  expect(polls).toBeGreaterThanOrEqual(3)
  await expect(text).toBeFocused()
  expect(await text.evaluate((element, original) => element === original, original)).toBe(true)
  const key = await text.getAttribute('data-keep')
  expect(key).toBeTruthy()
  state.ws.notices.push({ text: 'Another job was updated.', at: state.now + 1 })
  await expect(page.getByText('Another job was updated.')).toBeVisible()
  await expect(text).toBeFocused()
  await expect(text).toHaveAttribute('data-keep', key)
  expect(await text.evaluate((element) => [element.selectionStart, element.selectionEnd, element.selectionDirection])).toEqual([11, 15, 'backward'])
  await expect(text).toHaveValue('Please pay when you can. Thank you.')
  let finish
  await page.route('**/api/invoices/*/remind', async (route) => {
    await new Promise((resolve) => { finish = resolve })
    await route.fulfill({ status: 502, json: { message: 'Please try again.' } })
  })
  const send = page.getByRole('button', { name: 'Send PayPal reminder', exact: true })
  await send.click()
  state.ws.notices.push({ text: 'A second change.', at: state.now + 2 })
  await expect(page.getByText('A second change.')).toBeVisible()
  await expect(send).toBeDisabled()
  finish()
  await expect(send).toBeEnabled()
  const invoice = Object.values(state.ws.invoices).find((invoice) => Number(invoice.due) > 0)
  invoice.shared = false
  invoice.hasQr = false
  state.reminders = { since: '2020-01-01', everyDays: 3, times: 3 }
  state.ws.notices.push({ text: 'Invoice details changed.', at: state.now + 3 })
  await expect(page.getByText('Invoice details changed.')).toBeVisible()
  await page.getByRole('tab', { name: 'Owed' }).click()
  await page.locator(`.owed-row[data-keep="invoice-${invoice.id}"]`).click()
  const sheet = page.locator('#sheet')
  const close = sheet.getByRole('button', { name: 'Close', exact: true })
  await close.focus()
  const sheetButton = await close.elementHandle()
  await page.waitForTimeout(7000)
  await expect(close).toBeFocused()
  expect(await close.evaluate((element, original) => element === original, sheetButton)).toBe(true)
  state.ws.notices.push({ text: 'Invoice changed again.', at: state.now + 4 })
  await expect.poll(() => sheetButton.evaluate((element) => element.isConnected)).toBe(false)
  await expect(close).toBeFocused()
  let finishStop
  await page.route('**/api/invoices/*/stop-reminders', async (route) => {
    await new Promise((resolve) => { finishStop = resolve })
    await route.fulfill({ status: 502, json: { message: 'Please try again.' } })
  })
  const stop = sheet.getByRole('button', { name: 'Stop PayPal reminders' })
  const stopButton = await stop.elementHandle()
  await stop.click()
  state.ws.notices.push({ text: 'Pending sheet action.', at: state.now + 5 })
  await expect.poll(() => stopButton.evaluate((element) => element.isConnected)).toBe(false)
  await expect(stop).toBeDisabled()
  finishStop()
  await expect(stop).toBeEnabled()
})

