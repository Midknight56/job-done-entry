// Drag and clash on the Bryntum Calendar, the same moves the film records. The fallback grid has its own drag spec.
import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'
import { dragJobUp, dragJobOnto } from './calendar-drag.js'

async function prepareCalendar(page, video = false) {
  await page.goto(video ? '/?calendar=bryntum&video=1' : '/?calendar=bryntum')
  const made = await newDemo(page, -new Date().getTimezoneOffset())
  expect(made.ok()).toBeTruthy()
  const state = await (await page.request.get('/api/state')).json()
  const sam = state.ws.jobs.find((job) => job.id === 'j3')
  const positioned = await page.request.post('/api/schedule/move', {
    data: { jobId: 'j4', start: new Date(Date.parse(sam.start) + 4 * 60 * 60_000).toISOString() },
  })
  expect(positioned.ok()).toBeTruthy()
  expect((await positioned.json()).ok).toBe(true)
  await page.reload()
  await page.getByRole('tab', { name: 'Calendar' }).click()
  if (!video) {
    await page.getByRole('button', { name: 'Week', exact: true }).click()
  }
  // Sam can be in the following week. Open that week before looking for either job.
  const samDay = new Date(sam.start)
  const monday = new Date(state.now)
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7)
  const nextMonday = new Date(monday)
  nextMonday.setDate(nextMonday.getDate() + 7)
  if (samDay >= nextMonday) await page.getByRole('button', { name: 'Next week', exact: true }).click()
  await expect(page.locator('[data-job-id="j3"]').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-job-id="j4"]').first()).toBeVisible({ timeout: 20_000 })
  await page.locator('.b-cal-event-wrap:has([data-job-id="j4"])').first().scrollIntoViewIfNeeded()
  // Let the mode or week transition settle before taking drag coordinates.
  await page.waitForTimeout(500)
}

const startOf = async (page, id) => (await (await page.request.get('/api/state')).json()).ws.jobs.find((job) => job.id === id).start

test('bryntum: dragging Dave’s job to a free hour moves it', async ({ page }) => {
  await prepareCalendar(page)
  const before = await startOf(page, 'j4')
  await dragJobUp(page, 'j4')
  await expect(page.locator('.quiet')).toContainText(/^Moved Shower valve/, { timeout: 15_000 })
  expect(await startOf(page, 'j4')).not.toBe(before)
})

test('bryntum: dragging Dave’s job onto Sam’s job keeps its start and shows the clash', async ({ page }) => {
  await prepareCalendar(page)
  const before = await startOf(page, 'j4')
  await dragJobOnto(page, 'j4', 'j3')
  await expect(page.locator('.quiet')).toContainText('clashes with', { timeout: 15_000 })
  expect(await startOf(page, 'j4')).toBe(before)
})

test.describe('in the film frame', () => {
  test.use({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 })
  test('bryntum: the drag and the clash work in video mode', async ({ page }) => {
    await prepareCalendar(page, true)
    const before = await startOf(page, 'j4')
    await dragJobUp(page, 'j4')
    await expect(page.locator('.quiet')).toContainText(/^Moved Shower valve/, { timeout: 15_000 })
    const moved = await startOf(page, 'j4')
    expect(moved).not.toBe(before)
    await dragJobOnto(page, 'j4', 'j3')
    await expect(page.locator('.quiet')).toContainText('clashes with', { timeout: 15_000 })
    expect(await startOf(page, 'j4')).toBe(moved)
  })
})
