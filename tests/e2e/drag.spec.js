import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'
import { openingTime } from '../../public/week.js'

test.beforeEach(async ({ page }) => {
  const made = await newDemo(page, 0)
  expect(made.ok()).toBeTruthy()
  await page.goto('/?calendar=fallback')
  await page.getByRole('tab', { name: 'Calendar' }).click()
})

function localDate(start, tz) {
  const date = new Date(Date.parse(start) + tz * 60_000)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function mondayOf(date) {
  const monday = new Date(date)
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  return monday
}

async function showWeekFor(page, state, start) {
  const job = page.locator('[data-job-id="j4"]').first()
  const jobWeek = mondayOf(localDate(start, state.ws.tz))
  const shownWeek = mondayOf(localDate(new Date(openingTime(state.now, state.ws.tz)).toISOString(), state.ws.tz))
  if (jobWeek > shownWeek) await page.getByRole('button', { name: 'Next week' }).click()
  const day = (localDate(start, state.ws.tz).getUTCDay() + 6) % 7
  await page.getByRole('button', { name: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][day] }).click()
  await expect(job).toBeVisible()
  return job
}

async function dragTo(page, job, x, y) {
  const bounds = await job.boundingBox()
  if (!bounds) throw new Error('Job block is not visible')
  const fromX = bounds.x + bounds.width / 2
  const fromY = bounds.y + Math.min(14, bounds.height / 2)
  await page.mouse.move(fromX, fromY)
  await page.mouse.down()
  for (let step = 1; step <= 10; step += 1) {
    const progress = step / 10
    await page.mouse.move(fromX + (x - fromX) * progress, fromY + (y - fromY) * progress)
  }
  await page.mouse.up()
}

async function dropPoint(page, day, hour, firstHour) {
  const grid = await page.locator('.cal-grid').boundingBox()
  const column = await page.locator(`.cal-column[data-day="${day}"]`).boundingBox()
  if (!grid || !column) throw new Error('Calendar grid is not visible')
  return {
    x: column.x + column.width / 2,
    y: grid.y + 28 + (hour - firstHour) * 48 + 20
  }
}

async function moveToFreeHour(page) {
  const initial = await (await page.request.get('/api/state')).json()
  const j4 = initial.ws.jobs.find((job) => job.id === 'j4')
  const date = localDate(j4.start, initial.ws.tz)
  const day = (date.getUTCDay() + 6) % 7
  const job = await showWeekFor(page, initial, j4.start)
  const targetHour = initial.ws.settings.workHours[0]
  const target = await dropPoint(page, day, targetHour, initial.ws.settings.workHours[0])

  await dragTo(page, job, target.x, target.y)

  const after = await (await page.request.get('/api/state')).json()
  const moved = after.ws.jobs.find((item) => item.id === 'j4')
  expect(moved.start).toBe(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), targetHour) - initial.ws.tz * 60_000).toISOString())
  await expect(page.locator('.quiet')).toContainText(/^Moved Shower valve/)
}

test('dragging Dave’s job to a free hour moves it', async ({ page }) => {
  await moveToFreeHour(page)
})

test('a drag west of UTC keeps the selected calendar day', async ({ page }) => {
  await newDemo(page, -240)
  await page.reload()
  await page.getByRole('tab', { name: 'Calendar' }).click()
  const state = await (await page.request.get('/api/state')).json()
  expect(state.ws.tz).toBe(-240)
  await moveToFreeHour(page)
})

test('dragging Dave’s job onto Sam’s job keeps its start and shows the clash', async ({ page }) => {
  const before = await (await page.request.get('/api/state')).json()
  const j3 = before.ws.jobs.find((job) => job.id === 'j3')
  const j4 = before.ws.jobs.find((job) => job.id === 'j4')
  const samDate = localDate(j3.start, before.ws.tz)
  const samStart = new Date(Date.parse(j3.start) + before.ws.tz * 60_000)
  const outsideClash = new Date(Date.UTC(
    samDate.getUTCFullYear(), samDate.getUTCMonth(), samDate.getUTCDate(), 14
  ) - before.ws.tz * 60_000).toISOString()
  const positioned = await page.request.post('/api/schedule/move', {
    data: { jobId: 'j4', start: outsideClash }
  })
  expect(positioned.ok()).toBeTruthy()
  await page.reload()
  await page.getByRole('tab', { name: 'Calendar' }).click()
  const current = await (await page.request.get('/api/state')).json()
  const movedJ4 = current.ws.jobs.find((job) => job.id === 'j4')
  const job = await showWeekFor(page, current, movedJ4.start)
  const point = await dropPoint(page, (samDate.getUTCDay() + 6) % 7, samStart.getUTCHours(), current.ws.settings.workHours[0])

  await dragTo(page, job, point.x, point.y)

  const after = await (await page.request.get('/api/state')).json()
  expect(after.ws.jobs.find((item) => item.id === 'j4').start).toBe(movedJ4.start)
  await expect(page.locator('.quiet')).toContainText('clashes with')
})

test('the move API rejects a start it cannot read', async ({ page }) => {
  const answer = await page.request.post('/api/schedule/move', {
    data: { jobId: 'j4', start: 'not a date' }
  })
  expect(answer.status()).toBe(422)
})
