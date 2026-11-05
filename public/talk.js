// Handles typed job descriptions and hold to talk audio recording.
import { startRecording } from './recorder.js'

/** Connects text submission and microphone recording controls. */
export function setupTalk({ request, submitText, showError }) {
  const button = document.querySelector('#talk')
  const textBox = document.querySelector('#say')
  const timerLabel = document.querySelector('#recordTime')
  let recorder
  let ticker
  let stopping = false
  let held = false
  let starting = false

  /** Stops capture and submits the recorded WAV. */
  async function stopTalk() {
    held = false
    if (!recorder || stopping) return
    stopping = true
    clearInterval(ticker)
    button.classList.remove('recording')
    const current = recorder
    recorder = null
    try {
      const audio = await current.stop()
      if (!audio.size || current.seconds() === 0) return
      const answer = await request('/api/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: audio
      })
      textBox.value = answer.text
      await submitText(answer.text)
    } catch (error) {
      showError(error)
    } finally {
      timerLabel.textContent = ''
      stopping = false
    }
  }

  async function beginTalk() {
    if (recorder || starting || stopping) return
    held = true
    starting = true
    try {
      const started = await startRecording()
      if (!held) { started.cancel(); return }
      recorder = started
      button.classList.add('recording')
      ticker = setInterval(() => {
        timerLabel.textContent = `${recorder?.seconds() || 0}s`
        if (recorder?.seconds() >= 30) stopTalk()
      }, 200)
    } catch {
      textBox.placeholder = 'No microphone. Type it instead.'
      textBox.focus()
    } finally {
      starting = false
    }
  }
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    button.setPointerCapture(event.pointerId)
    return beginTalk()
  })
  button.addEventListener('keydown', (event) => {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    if (!event.repeat) return beginTalk()
  })
  button.addEventListener('keyup', (event) => {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    return stopTalk()
  })
  button.addEventListener('blur', () => { if (held) return stopTalk() })
  button.addEventListener('pointerup', stopTalk)
  button.addEventListener('lostpointercapture', () => { if (held) stopTalk() })
  button.addEventListener('pointercancel', () => {
    held = false
    recorder?.cancel()
    recorder = null
    clearInterval(ticker)
    button.classList.remove('recording')
    timerLabel.textContent = ''
  })
}
