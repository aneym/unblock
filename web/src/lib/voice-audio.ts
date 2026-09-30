const OUTPUT_RATE = 24_000

/** Create and resume during the tap, before awaiting a token or a microphone permission. */
export function prepareAudio(): AudioContext {
  if (typeof AudioContext === 'undefined') throw new Error('No microphone is available in this browser.')
  try {
    const context = new AudioContext()
    void context.resume()
    return context
  } catch (error) {
    throw new Error(voiceAudioError(error))
  }
}

export function voiceAudioError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError') return 'Microphone access is blocked. Allow it for this site, then Retry.'
    if (error.name === 'NotFoundError' || error.name === 'NotSupportedError' || error.message === 'Not supported') {
      return 'No microphone is available in this browser.'
    }
    return error.message
  }
  return 'Voice call failed. Please try again.'
}

function encodePcm(bytes: ArrayBuffer): string {
  const data = new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < data.length; i += 0x8000) {
    binary += String.fromCharCode(...data.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export async function startMic(context: AudioContext, targetRate: 16000 | 24000, onChunk: (data: string) => void, cancelled: () => boolean): Promise<{ stop(): void }> {
  // Get permission first; if it fails, no worklet or graph is left behind.
  if (!navigator.mediaDevices?.getUserMedia || !context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
    throw new Error('No microphone is available in this browser.')
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  if (cancelled()) {
    stream.getTracks().forEach((track) => track.stop())
    return { stop() {} }
  }
  let source: MediaStreamAudioSourceNode | undefined
  let worklet: AudioWorkletNode | undefined
  let sink: GainNode | undefined
  try {
    await context.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url))
    if (cancelled()) {
      stream.getTracks().forEach((track) => track.stop())
      return { stop() {} }
    }
    source = context.createMediaStreamSource(stream)
    worklet = new AudioWorkletNode(context, 'unblock-mic', { processorOptions: { targetRate } })
    // Keep the processor running on Safari without feeding the mic into the speakers.
    sink = context.createGain()
    sink.gain.value = 0
    worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => onChunk(encodePcm(event.data))
    source.connect(worklet).connect(sink).connect(context.destination)
  } catch (error) {
    source?.disconnect()
    worklet?.disconnect()
    sink?.disconnect()
    stream.getTracks().forEach((track) => track.stop())
    throw error
  }
  return {
    stop() {
      worklet.port.onmessage = null
      source.disconnect()
      worklet.disconnect()
      sink.disconnect()
      stream.getTracks().forEach((track) => track.stop())
    },
  }
}

export function createPlayer(context: AudioContext) {
  const scheduled = new Set<AudioBufferSourceNode>()
  let nextTime = context.currentTime
  let onDrained: (() => void) | null = null
  return {
    enqueue(base64: string) {
      const binary = atob(base64)
      const count = Math.floor(binary.length / 2)
      if (!count) return
      const audio = context.createBuffer(1, count, OUTPUT_RATE)
      const samples = audio.getChannelData(0)
      for (let i = 0; i < count; i++) {
        let value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8)
        if (value >= 0x8000) value -= 0x10000
        samples[i] = value / 32768
      }
      const node = context.createBufferSource()
      node.buffer = audio
      node.connect(context.destination)
      node.onended = () => {
        scheduled.delete(node)
        node.disconnect()
        if (!scheduled.size && onDrained) {
          const callback = onDrained
          onDrained = null
          callback()
        }
      }
      scheduled.add(node)
      const start = Math.max(context.currentTime, nextTime)
      node.start(start)
      nextTime = start + audio.duration
    },
    whenDrained(callback: () => void) {
      if (!scheduled.size) callback()
      else onDrained = callback
    },
    flush() {
      onDrained = null
      for (const node of scheduled) { try { node.stop() } catch { /* already ended */ } }
      scheduled.clear()
      nextTime = context.currentTime
    },
  }
}
