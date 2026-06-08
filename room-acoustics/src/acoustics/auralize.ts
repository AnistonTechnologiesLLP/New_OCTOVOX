/**
 * Web Audio auralization preview. This is the **only** module permitted to
 * touch Web Audio APIs — the rest of the engine is pure and DOM-free.
 */

/** −60 dB expressed as a natural log: `ln(10^-3) = −6.907755…`. */
const MINUS_60_DB_LN = -6.907755278982137;

/** Options for {@link auralize}. */
export interface AuralizeOptions {
  /** Excitation noise-burst length, in milliseconds (default 40). */
  readonly burstMs?: number;
  /** Output gain, 0..1 (default 0.6). */
  readonly gain?: number;
  /** Impulse-response length as a multiple of RT60 (default 1.5). */
  readonly tailFactor?: number;
}

/**
 * Render and play a short auralization of a room with the given RT60.
 *
 * A stereo impulse response is synthesized from per-channel (decorrelated)
 * white noise multiplied by an exponential decay that reaches −60 dB exactly at
 * `rt60` seconds:
 *
 * `decay = exp(−6.908 / (rt60 · sampleRate))` (per-sample multiplier).
 *
 * A brief noise burst is convolved with that IR and routed
 * `source → ConvolverNode → GainNode → destination`.
 *
 * @param context - An `AudioContext` (resumed automatically if suspended).
 * @param rt60 - Target reverberation time, in seconds (must be > 0).
 * @param options - Burst length, gain, and IR tail length.
 * @returns A promise that resolves when playback completes.
 */
export async function auralize(
  context: AudioContext,
  rt60: number,
  options: AuralizeOptions = {},
): Promise<void> {
  if (!Number.isFinite(rt60) || rt60 <= 0) {
    throw new RangeError(`rt60 must be a positive, finite number (got ${rt60}).`);
  }

  const burstMs = options.burstMs ?? 40;
  const gain = options.gain ?? 0.6;
  const tailFactor = options.tailFactor ?? 1.5;

  // A suspended context (autoplay policy) produces no sound until resumed.
  if (context.state === 'suspended') {
    await context.resume();
  }

  const sampleRate = context.sampleRate;
  const decay = Math.exp(MINUS_60_DB_LN / (rt60 * sampleRate));

  // Stereo impulse response: decorrelated noise × exponential decay envelope.
  const irLength = Math.max(1, Math.ceil(rt60 * tailFactor * sampleRate));
  const impulse = context.createBuffer(2, irLength, sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const samples = impulse.getChannelData(channel);
    let envelope = 1;
    for (let i = 0; i < irLength; i++) {
      samples[i] = (Math.random() * 2 - 1) * envelope;
      envelope *= decay;
    }
  }

  // Short noise-burst excitation.
  const burstLength = Math.max(1, Math.ceil((burstMs / 1000) * sampleRate));
  const burst = context.createBuffer(1, burstLength, sampleRate);
  const burstData = burst.getChannelData(0);
  for (let i = 0; i < burstLength; i++) {
    burstData[i] = Math.random() * 2 - 1;
  }

  const source = context.createBufferSource();
  source.buffer = burst;
  const convolver = context.createConvolver();
  convolver.normalize = true;
  convolver.buffer = impulse;
  const output = context.createGain();
  output.gain.value = gain;

  source.connect(convolver);
  convolver.connect(output);
  output.connect(context.destination);

  return new Promise<void>((resolve) => {
    source.onended = () => {
      source.disconnect();
      convolver.disconnect();
      output.disconnect();
      resolve();
    };
    source.start();
  });
}
