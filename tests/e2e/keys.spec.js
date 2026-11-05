import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'
import { openingTime } from '../../public/week.js'

test.beforeEach(async ({ page }) => {
  await page.goto('/?calendar=fallback')
  const made = await newDemo(page, 0)
  expect(made.ok()).toBeTruthy()
  await page.reload()
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

test('keyboard moves a job preview and Escape cancels it', async ({ page }) => {
  const initial = await (await page.request.get('/api/state')).json()
  const j4 = initial.ws.jobs.find((job) => job.id === 'j4')
  const job = await showWeekFor(page, initial, j4.start)

  await job.focus()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')

  const afterMove = await (await page.request.get('/api/state')).json()
  const moved = afterMove.ws.jobs.find((item) => item.id === 'j4')
  expect(moved.start).toBe(new Date(Date.parse(j4.start) - 60 * 60_000).toISOString())
  await expect(page.locator('.quiet')).toContainText(/^Moved Shower valve/)

  const movedJob = page.locator('[data-job-id="j4"]').first()
  await movedJob.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')

  const afterCancel = await (await page.request.get('/api/state')).json()
  expect(afterCancel.ws.jobs.find((item) => item.id === 'j4').start).toBe(moved.start)
})

for (const key of ['Space', 'Enter']) {
  test(`microphone records while ${key} is held and stops on release`, async ({ page }) => {
    await page.route('**/recorder.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      export async function startRecording() {
        window.recordingStarts = (window.recordingStarts || 0) + 1
        return { seconds: () => 1, cancel() {}, stop: async () => new Blob(['audio']) }
      }
    ` }))
    let submissions = 0
    await page.route('**/api/voice', route => { submissions++; return route.fulfill({ json: { text: 'Work' } }) })
    await page.route('**/api/agent', route => route.fulfill({ json: { proposal: { kind: 'answer', text: 'Ready.', invoiceIds: [] }, message: null } }))
    await page.reload()
    const button = page.locator('#talk')
    await button.focus()
    await page.keyboard.down(key)
    await expect(button).toHaveClass(/recording/)
    await page.keyboard.down(key)
    expect(await page.evaluate(() => window.recordingStarts)).toBe(1)
    await page.keyboard.up(key)
    await expect(button).not.toHaveClass(/recording/)
    await expect.poll(() => submissions).toBe(1)
  })
}
