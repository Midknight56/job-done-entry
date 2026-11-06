import { test, expect } from '@playwright/test'

// The film may name only PayPal and the sponsor tools PayPal lists, so video mode keeps model names out of frame.
const entries = [
  { kind: 'model', at: 0, method: 'AI', path: 'whisper-large-v3-turbo', status: 200, neurons: 6.82 },
  { kind: 'model', at: 0, method: 'AI', path: 'granite-4.0-h-micro', status: 200, neurons: 13.1 },
  { kind: 'paypal', at: 0, method: 'POST', path: '/v2/invoicing/invoices', status: 201 },
]

async function panelText(page, url) {
  await page.goto(url)
  return page.evaluate(async (items) => {
    const { renderPanel } = await import('/panel.js')
    const box = document.createElement('div')
    box.className = 'side-panel'
    document.body.append(box)
    renderPanel(box, items)
    return box.innerText
  }, entries)
}

test('video mode hides the model names and keeps the PayPal calls', async ({ page }) => {
  const text = await panelText(page, '/?video=1')
  expect(text).not.toMatch(/whisper|qwen|granite|cloudflare/i)
  expect(text).toContain('Speech to text')
  expect(text).toContain('AI step')
  expect(text).toContain('/v2/invoicing/invoices')
})

test('the normal page still shows the model names', async ({ page }) => {
  const text = await panelText(page, '/')
  expect(text).toContain('whisper-large-v3-turbo')
  expect(text).toContain('granite-4.0-h-micro')
})
