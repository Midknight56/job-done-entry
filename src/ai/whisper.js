// @ts-check

import { audioWorstCase, MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS } from '../caps.js'
import { BudgetError } from './model.js'

export const WHISPER = '@cf/openai/whisper-large-v3-turbo'

export class AudioError extends Error {
  /** @param {number} status */
  constructor(status) { super(status === 413 ? 'Audio is too large' : 'Unsupported audio format'); this.name = 'AudioError'; this.status = status }
}

/** @param {Uint8Array} bytes */
export function readWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const str = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length))
  if (bytes.length < 12 || str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new AudioError(415)
  let fmt = null
  let dataBytes = null
  let declaredDataBytes = null
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = str(offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    // The sound is everything after the data chunk's header, whatever length the header claims: that is what
    // Whisper hears, so that is what is charged.
    if (id === 'data') { declaredDataBytes = size; dataBytes = bytes.length - body; break }
    if (body + size > bytes.length) break
    if (id === 'fmt ' && size >= 16) fmt = { channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) }
    offset = body + size + (size % 2)
  }
  if (!fmt || dataBytes === null) throw new AudioError(415)
  return { rate: fmt.rate, channels: fmt.channels, bits: fmt.bits, dataBytes, declaredDataBytes, seconds: dataBytes / (fmt.rate * fmt.channels * (fmt.bits / 8)) }
}

/**
 * Base64 in pieces whose size is a multiple of 3, so no piece but the last ends in padding. (A 32,768 byte piece put
 * padding in the middle, and Whisper heard only the first second of every clip: seen live on 23 Oct 2026.)
 * @param {Uint8Array} bytes
 */
export function toBase64(bytes) {
  let result = ''
  const size = 3 * 8192
  for (let offset = 0; offset < bytes.length; offset += size) result += btoa(String.fromCharCode(...bytes.subarray(offset, offset + size)))
  return result
}

/** @param {{ai: {run: (model: string, input: any) => Promise<any>}, budget: {charge: (input: {ipKey: string, day: string, neurons: number}) => Promise<{ok: true}|{ok: false, reason: 'account'|'day'|'ip'}>}, ipKey: string, day: string, bytes: Uint8Array}} options */
export async function transcribe({ ai, budget, ipKey, day, bytes }) {
  if (bytes.length > MAX_AUDIO_BYTES) throw new AudioError(413)
  const wav = readWav(bytes)
  if (wav.rate !== 16000 || wav.channels !== 1 || wav.bits !== 16) throw new AudioError(415)
  if (wav.seconds > MAX_AUDIO_SECONDS + 0.05) throw new AudioError(413)
  if (wav.declaredDataBytes !== wav.dataBytes) throw new AudioError(415)
  const neurons = audioWorstCase(wav.seconds)
  const charged = await budget.charge({ ipKey, day, neurons })
  if (charged.ok === false) throw new BudgetError(charged.reason)
  const out = await ai.run(WHISPER, { audio: toBase64(bytes), language: 'en' })
  return { text: (out.text || '').trim(), seconds: wav.seconds, neurons }
}
