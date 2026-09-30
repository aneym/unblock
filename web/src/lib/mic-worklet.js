class MicCapture extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.ratio = sampleRate / options.processorOptions.targetRate
    this.next = this.ratio
    this.sum = 0
    this.count = 0
    this.samples = []
  }
  process(inputs) {
    const input = inputs[0]?.[0]
    if (!input) return true
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i]
      this.count++
      this.next--
      if (this.next <= 0) {
        const average = Math.max(-1, Math.min(1, this.sum / this.count))
        this.samples.push(Math.round(average * (average < 0 ? 32768 : 32767)))
        this.sum = 0
        this.count = 0
        this.next += this.ratio
      }
      if (this.samples.length >= 640) {
        const pcm = new Int16Array(this.samples.splice(0, 640))
        this.port.postMessage(pcm.buffer, [pcm.buffer])
      }
    }
    return true
  }
}
registerProcessor('unblock-mic', MicCapture)
