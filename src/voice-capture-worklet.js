class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = true;
    this.ratio = sampleRate / 16000;
    this.frame = new Int16Array(512);
    this.count = 0; this.sum = 0; this.weight = 0;
    this.port.onmessage = ({data}) => {
      if (data.type === 'flush') {
        if (this.count) this.port.postMessage(this.frame.slice(0, this.count).buffer);
        this.count = 0;
        this.port.postMessage({type: 'flushed'});
      } else {
        this.enabled = data.enabled;
        this.count = 0; this.sum = 0; this.weight = 0;
      }
    };
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || !this.enabled) return true;
    // Stateful area resampling; carries fractional sample weight across blocks.
    for (const sample of channel) {
      let left = 1;
      while (left > 1e-8) {
        const take = Math.min(left, this.ratio - this.weight);
        this.sum += sample * take; this.weight += take; left -= take;
        if (this.weight >= this.ratio - 1e-8) {
          this.frame[this.count++] = Math.round(Math.max(-1, Math.min(1, this.sum / this.ratio)) * 32767);
          this.sum = 0; this.weight = 0;
          if (this.count === 512) {
            this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
            this.frame = new Int16Array(512); this.count = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', CaptureProcessor);
