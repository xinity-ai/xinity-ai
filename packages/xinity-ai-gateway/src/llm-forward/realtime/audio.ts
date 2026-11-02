const BYTES_PER_SAMPLE = 2;
const HALF_TAPS = 16;
// Keeps the transition band below the target Nyquist frequency, so nothing above it folds back.
const CUTOFF_MARGIN = 0.9;

export type PcmInput = {
  /** Decodes base64 PCM16 at the input rate and returns the samples resampled to the output rate. */
  push: (base64: string) => Int16Array<ArrayBuffer>;
};

function sinc(x: number): number {
  return x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
}

function clampSample(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

function createResampler(fromRate: number, toRate: number): (samples: Int16Array<ArrayBuffer>) => Int16Array<ArrayBuffer> {
  const step = fromRate / toRate;
  const cutoff = (CUTOFF_MARGIN * Math.min(1, toRate / fromRate)) / 2;
  const kernels = new Map<number, Float64Array>();

  // Tap j weighs the input sample at (base - HALF_TAPS + 1 + j), where the output lies at base + frac.
  const kernelFor = (frac: number): Float64Array => {
    let kernel = kernels.get(frac);
    if (!kernel) {
      kernel = new Float64Array(2 * HALF_TAPS);
      let sum = 0;
      for (let j = 0; j < kernel.length; j++) {
        const distance = j - HALF_TAPS + 1 - frac;
        const window = 0.5 + 0.5 * Math.cos((Math.PI * distance) / HALF_TAPS);
        kernel[j] = 2 * cutoff * sinc(2 * cutoff * distance) * window;
        sum += kernel[j]!;
      }
      for (let j = 0; j < kernel.length; j++) {
        kernel[j]! /= sum;
      }
      kernels.set(frac, kernel);
    }
    return kernel;
  };

  let history = new Float64Array(HALF_TAPS - 1);
  let position = HALF_TAPS - 1;

  return (samples) => {
    const buffer = new Float64Array(history.length + samples.length);
    buffer.set(history);
    buffer.set(samples, history.length);

    const out: number[] = [];
    while (Math.floor(position) + HALF_TAPS < buffer.length) {
      const base = Math.floor(position);
      const kernel = kernelFor(position - base);
      const first = base - HALF_TAPS + 1;
      let acc = 0;
      for (let j = 0; j < kernel.length; j++) {
        acc += kernel[j]! * buffer[first + j]!;
      }
      out.push(clampSample(acc));
      position += step;
    }

    const keepFrom = Math.max(0, Math.floor(position) - HALF_TAPS + 1);
    history = buffer.slice(keepFrom);
    position -= keepFrom;
    return Int16Array.from(out);
  };
}

export function createPcmInput(fromRate: number, toRate: number): PcmInput {
  const resample = fromRate === toRate ? (samples: Int16Array<ArrayBuffer>) => samples : createResampler(fromRate, toRate);
  // A chunk may end halfway through a sample. That byte belongs to the next chunk.
  let carry = Buffer.alloc(0);

  return {
    push: (base64) => {
      const bytes = Buffer.concat([carry, Buffer.from(base64, "base64")]);
      const whole = bytes.length - (bytes.length % BYTES_PER_SAMPLE);
      carry = bytes.subarray(whole);
      const samples = new Int16Array(whole / BYTES_PER_SAMPLE);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = bytes.readInt16LE(i * BYTES_PER_SAMPLE);
      }
      return resample(samples);
    },
  };
}

export function encodePcm16(samples: Int16Array): string {
  const bytes = Buffer.alloc(samples.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i++) {
    bytes.writeInt16LE(samples[i]!, i * BYTES_PER_SAMPLE);
  }
  return bytes.toString("base64");
}
