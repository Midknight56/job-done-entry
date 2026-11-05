// Captures microphone audio and encodes it as 16 kHz mono PCM WAV.

/** Starts a recording with a hard 30 second limit. */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const context = new AudioContext()
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(4096, 1, 1)
  const silence = context.createGain()
  const chunks = []
  const startedAt = Date.now()
  let stopped = false
  let finishRecording
  const finished = new Promise((resolve) => { finishRecording = resolve })
  processor.onaudioprocess = (event) => {
    if (!stopped) chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
  }
  silence.gain.value = 0
  source.connect(processor)
  processor.connect(silence)
  silence.connect(context.destination)
  const timer = setTimeout(finish, 30000)

  /** Releases the audio devices and converts captured samples to WAV. */
  function finish() {
    if (stopped) return finished
    stopped = true
    clearTimeout(timer)
    processor.disconnect()
    silence.disconnect()
    source.disconnect()
    stream.getTracks().forEach((track) => track.stop())
    context.close()
    const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0)
    const input = new Float32Array(sampleCount)
    let offset = 0
    chunks.forEach((chunk) => {
      input.set(chunk, offset)
      offset += chunk.length
    })
    const outputCount = Math.floor(sampleCount * 16000 / context.sampleRate)
    const samples = new Int16Array(outputCount)
    for (let index = 0; index < outputCount; index += 1) {
      const value = input[Math.min(sampleCount - 1, Math.floor(index * context.sampleRate / 16000))] || 0
      samples[index] = value < 0 ? value * 32768 : value * 32767
    }
    const buffer = new ArrayBuffer(44 + samples.length * 2)
    const view = new DataView(buffer)
    const writeText = (position, text) => {
      for (let index = 0; index < text.length; index += 1) {
        view.setUint8(position + index, text.charCodeAt(index))
      }
    }
    writeText(0, 'RIFF')
    view.setUint32(4, 36 + samples.length * 2, true)
    writeText(8, 'WAVE')
    writeText(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, 16000, true)
    view.setUint32(28, 32000, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeText(36, 'data')
    view.setUint32(40, samples.length * 2, true)
    new Int16Array(buffer, 44).set(samples)
    finishRecording(new Blob([buffer], { type: 'audio/wav' }))
    return finished
  }
  return {
    stop: finish,
    seconds: () => Math.min(30, Math.floor((Date.now() - startedAt) / 1000)),
    cancel: () => {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      processor.disconnect()
      silence.disconnect()
      source.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      context.close()
      finishRecording(new Blob())
    }
  }
}
