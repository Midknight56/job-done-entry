import { describe, it, expect } from 'vitest'
import { MAX_AUDIO_SECONDS, MAX_AUDIO_BYTES } from '../../src/caps.js'
import { readWav, transcribe } from '../../src/ai/whisper.js'
import { createBudget, memoryLedger, memoryCounter } from '../../src/ai/budget.js'

/** A 16 kHz mono 16 bit PCM WAV of the given length in seconds (silence). */
export function wav(seconds, { rate = 16000, channels = 1, bits = 16 } = {}) {
  const dataBytes = Math.round(seconds * rate * channels * (bits / 8))
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const put = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  put(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); put(8, 'WAVE')
  put(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * channels * (bits / 8), true); v.setUint16(32, channels * (bits / 8), true); v.setUint16(34, bits, true)
  put(36, 'data'); v.setUint32(40, dataBytes, true)
  return new Uint8Array(buf)
}

const budget = () => createBudget({ ledger: memoryLedger(), perIp: memoryCounter(), app: 'job-done' })
const ai = { run: async () => ({ text: 'Kitchen tap for Maria' }) }

describe('the audio cap', () => {
  it('reads the length of a 16 kHz mono WAV from its header', () => {
    expect(readWav(wav(12)).seconds).toBeCloseTo(12)
  })

  it('a 30 s clip is transcribed', async () => {
    const out = await transcribe({ ai, budget: budget(), ipKey: 'ipA', day: '2026-10-26', bytes: wav(MAX_AUDIO_SECONDS) })
    expect(out.text).toBe('Kitchen tap for Maria')
    expect(out.neurons).toBeCloseTo(23.32, 1)
  })

  it('a 31 s clip gets 413', async () => {
    await expect(transcribe({ ai, budget: budget(), ipKey: 'ipA', day: '2026-10-26', bytes: wav(31) })).rejects.toMatchObject({ status: 413 })
  })

  it('a 1.1 MB body gets 413 before any parsing', async () => {
    const big = new Uint8Array(Math.round(1.1 * 1024 * 1024))
    expect(big.length).toBeGreaterThan(MAX_AUDIO_BYTES)
    await expect(transcribe({ ai, budget: budget(), ipKey: 'ipA', day: '2026-10-26', bytes: big })).rejects.toMatchObject({ status: 413 })
  })

  it('anything that is not a 16 kHz mono 16 bit WAV gets 415', async () => {
    await expect(transcribe({ ai, budget: budget(), ipKey: 'ipA', day: '2026-10-26', bytes: wav(2, { rate: 44100 }) })).rejects.toMatchObject({ status: 415 })
    await expect(transcribe({ ai, budget: budget(), ipKey: 'ipA', day: '2026-10-26', bytes: new Uint8Array(100) })).rejects.toMatchObject({ status: 415 })
  })
})

describe('a header that lies', () => {
  it('charges by the real sound bytes, not by the length the header claims', async () => {
    const real = wav(40)
    new DataView(real.buffer).setUint32(40, 32000, true) // the header claims 1 s
    await expect(transcribe({ ai, budget: budget(), ipKey: 'ipA', day: '2026-10-26', bytes: real.slice(0, 1_000_000) })).rejects.toMatchObject({ status: 413 })
  })
})

describe('the audio sent to Whisper', () => {
  it('is the whole clip as one valid base64 string', async () => {
    const { toBase64 } = await import('../../src/ai/whisper.js')
    const bytes = new Uint8Array(100_003).map((_, i) => (i * 31) % 256)
    const b64 = toBase64(bytes)
    expect(b64).toBe(Buffer.from(bytes).toString('base64'))
    expect(b64.slice(0, -2)).not.toContain('=')
  })
})
