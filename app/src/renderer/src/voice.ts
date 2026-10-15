// voice.ts — the robot's voice and ears.
//
// Speaker: speaks text with the local Kokoro voice (synthesised by the
//   backend), one sentence at a time so it starts talking quickly, fetching
//   the next sentence while the current one plays. One voice at a time: a
//   new say() or stop() cuts off whatever was playing, immediately. Falls
//   back to Windows' built-in voice if the local voice is unavailable.
// Recorder: opens the microphone only while listening, detects when you
//   stop talking, and hands back a 16 kHz mono WAV for speech recognition.

export interface SpeakHooks {
  onStart?: () => void;
  onEnd?: () => void;
}

/**
 * Split into speakable chunks: sentences, long ones broken at commas. The first
 * sentence is also broken at an early comma ("Sure, | I'll remind you…"): the
 * voice is made a chunk at a time, so a short first chunk starts it talking
 * ~0.5 s sooner, and the rest is ready before that first bit has finished.
 */
export function splitSentences(text: string): string[] {
  const parts = text
    .replace(/\s+/g, " ")
    .trim()
    .match(/[^.!?…]+[.!?…]*["')\]]*\s*/g) ?? [text];
  const first = parts[0]?.trim() ?? "";
  const comma = first.indexOf(", ");
  if (first.length > 40 && comma >= 2 && comma <= 50 && first.slice(comma + 2).split(" ").length >= 3) {
    parts.splice(0, 1, first.slice(0, comma + 1), first.slice(comma + 2));
  }
  const out: string[] = [];
  for (const raw of parts) {
    let p = raw.trim();
    while (p.length > 220) {
      const cut = Math.max(p.lastIndexOf(", ", 220), p.lastIndexOf(" ", 220));
      out.push(p.slice(0, cut > 40 ? cut + 1 : 220).trim());
      p = p.slice(cut > 40 ? cut + 1 : 220).trim();
    }
    if (p) out.push(p);
  }
  return out;
}

export class Speaker {
  enabled: boolean;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private current: AudioBufferSourceNode | null = null;
  private generation = 0;
  private _speaking = false;
  private readonly fallback = new FallbackVoice();
  private readonly levelBuf = new Float32Array(1024);

  constructor(
    enabled: boolean,
    private readonly synth: (text: string) => Promise<ArrayBuffer | null>,
  ) {
    this.enabled = enabled;
  }

  get speaking(): boolean {
    return this._speaking || this.fallback.speaking;
  }

  /** Speak text, interrupting anything already playing. Resolves when done or cut off. */
  async say(text: string, hooks: SpeakHooks = {}): Promise<void> {
    const gen = ++this.generation;
    this.stopAudio();
    if (!this.enabled || !text.trim()) return;
    const parts = splitSentences(text);
    let started = false;
    const start = () => {
      if (!started) {
        started = true;
        this._speaking = true;
        hooks.onStart?.();
      }
    };
    try {
      let next: Promise<AudioBuffer | null> | null = this.fetch(parts[0]);
      for (let i = 0; i < parts.length; i++) {
        const buffer = await next;
        if (gen !== this.generation) return;
        next = i + 1 < parts.length ? this.fetch(parts[i + 1]) : null;
        if (!buffer) {
          // Local voice unavailable: say the rest with the Windows voice.
          start();
          await this.fallback.speak(parts.slice(i).join(" "));
          break;
        }
        start();
        await this.play(buffer, gen);
        if (gen !== this.generation) return;
      }
    } finally {
      if (gen === this.generation) {
        this._speaking = false;
        if (started) hooks.onEnd?.();
      }
    }
  }

  /** Stop talking right now. */
  stop(): void {
    this.generation++;
    this.stopAudio();
    this._speaking = false;
  }

  /** 0..1 loudness of what's playing, for the speaking eyes. */
  level(): number {
    if (!this.analyser || !this._speaking) return this.fallback.speaking ? this.fallback.level() : 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (const v of this.levelBuf) sum += v * v;
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 5);
  }

  private audio(): { ctx: AudioContext; analyser: AnalyserNode } {
    if (!this.ctx || !this.analyser) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.connect(this.ctx.destination);
    }
    return { ctx: this.ctx, analyser: this.analyser };
  }

  private async fetch(text: string): Promise<AudioBuffer | null> {
    try {
      const wav = await this.synth(text);
      if (!wav) return null;
      return await this.audio().ctx.decodeAudioData(wav.slice(0));
    } catch {
      return null;
    }
  }

  private play(buffer: AudioBuffer, gen: number): Promise<void> {
    const { ctx, analyser } = this.audio();
    if (ctx.state === "suspended") void ctx.resume();
    return new Promise((resolve) => {
      if (gen !== this.generation) return resolve();
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(analyser);
      src.onended = () => {
        if (this.current === src) this.current = null;
        resolve();
      };
      this.current = src;
      src.start();
    });
  }

  private stopAudio(): void {
    const src = this.current;
    this.current = null;
    try {
      src?.stop();
    } catch {
      // already stopped
    }
    this.fallback.stop();
  }
}

/** Windows' built-in voice via speechSynthesis — only used if the local voice fails. */
class FallbackVoice {
  private voice: SpeechSynthesisVoice | null = null;
  private kick = 0;

  constructor() {
    const pick = () => {
      const voices = speechSynthesis.getVoices();
      this.voice = voices.find((v) => /zira|hazel|heera|female/i.test(v.name)) ?? voices.find((v) => v.lang.startsWith("en")) ?? null;
    };
    pick();
    speechSynthesis.addEventListener("voiceschanged", pick);
  }

  get speaking(): boolean {
    return speechSynthesis.speaking;
  }

  speak(text: string): Promise<void> {
    return new Promise((resolve) => {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.rate = 1.03;
      u.pitch = 1.15;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      u.onboundary = () => {
        this.kick = 1;
      };
      speechSynthesis.speak(u);
    });
  }

  stop(): void {
    speechSynthesis.cancel();
  }

  level(): number {
    this.kick = Math.max(0, this.kick - 0.06);
    return 0.35 + 0.65 * this.kick;
  }
}

// ------------------------------------------------------------------ microphone

export interface Recording {
  wav: ArrayBuffer;
  hadSpeech: boolean;
  seconds: number;
}

const RATE = 16000;
const FRAME = 2048; // 128 ms at 16 kHz
const MAX_SECONDS = 15;
const NO_SPEECH_GIVE_UP_S = 7;
const END_SILENCE_FRAMES = 9; // ~1.15 s of quiet after speech = done

export class Recorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private proc: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private finish: ((r: Recording) => void) | null = null;
  private speechFrames = 0;
  private silentFrames = 0;
  private heardSpeech = false;
  private noiseFloor = 0.01;
  private ignoreFrames = 0;
  level = 0;

  get active(): boolean {
    return this.stream !== null;
  }

  /**
   * Start listening; resolves when you stop talking (or stop() is called).
   * ignoreMs: the first moment doesn't count as you speaking (the robot's own
   * chime plays then). It's still recorded, so an early word isn't lost.
   */
  async start(ignoreMs = 0): Promise<Recording> {
    if (this.active) this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext({ sampleRate: RATE });
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(FRAME, 1, 1);
    this.chunks = [];
    this.speechFrames = this.silentFrames = 0;
    this.heardSpeech = false;
    this.noiseFloor = 0.01;
    this.ignoreFrames = Math.ceil((ignoreMs / 1000) * (RATE / FRAME));
    this.proc.onaudioprocess = (e) => this.onFrame(e.inputBuffer.getChannelData(0));
    src.connect(this.proc);
    this.proc.connect(this.ctx.destination); // output is silent; needed for processing to run
    return new Promise((resolve) => (this.finish = resolve));
  }

  /** Stop now (mic button pressed again). */
  stop(): void {
    if (!this.active) return;
    this.proc?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop()); // releases the microphone
    void this.ctx?.close();
    const samples = concat(this.chunks);
    this.stream = null;
    this.proc = null;
    this.ctx = null;
    this.level = 0;
    const done = this.finish;
    this.finish = null;
    done?.({ wav: encodeWav(samples, RATE), hadSpeech: this.heardSpeech, seconds: samples.length / RATE });
  }

  private onFrame(input: Float32Array): void {
    this.chunks.push(new Float32Array(input));
    let sum = 0;
    for (const v of input) sum += v * v;
    const rms = Math.sqrt(sum / input.length);
    this.level = Math.min(1, rms * 8);
    if (this.ignoreFrames > 0) {
      this.ignoreFrames--;
      return;
    }

    // Simple energy voice detection with an adaptive noise floor. The fixed
    // minimum is low: laptop mic arrays with noise suppression are near-silent
    // between words, and a high bar cut off anyone not leaning in.
    const threshold = Math.max(0.004, this.noiseFloor * 3);
    if (rms > threshold) {
      this.speechFrames++;
      this.silentFrames = 0;
      if (this.speechFrames >= 2) this.heardSpeech = true;
    } else {
      this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      this.speechFrames = 0;
      if (this.heardSpeech) this.silentFrames++;
    }

    const seconds = (this.chunks.length * FRAME) / RATE;
    if ((this.heardSpeech && this.silentFrames >= END_SILENCE_FRAMES) || seconds >= MAX_SECONDS || (!this.heardSpeech && seconds >= NO_SPEECH_GIVE_UP_S)) {
      this.stop();
    }
  }
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** 16-bit PCM mono WAV. */
let chimeCtx: AudioContext | null = null;
/** Settings → Sounds: chimes and chirps (not the voice). */
let soundsOn = true;
export function setSounds(on: boolean): void {
  soundsOn = on;
}

export type Chirp = "boop" | "happy" | "eep" | "ok" | "sleepy";
/** The last chirp (for the self-test's report). */
export let lastChirp: { kind: Chirp; at: number } | null = null;
let lastChirpAt = 0;
// Each chirp: a few quick notes [start s, frequency Hz, to Hz (slide), length s].
const CHIRPS: Record<Chirp, [number, number, number, number][]> = {
  boop: [[0, 520, 760, 0.09]],
  happy: [[0, 880, 1180, 0.07], [0.08, 1180, 1560, 0.08], [0.17, 1320, 1760, 0.1]],
  eep: [[0, 1400, 2100, 0.07]],
  ok: [[0, 700, 700, 0.06], [0.08, 1050, 1050, 0.09]],
  sleepy: [[0, 700, 420, 0.22], [0.24, 520, 300, 0.3]],
};

/**
 * Tiny robot beeps for small reactions, R2-D2 style. Quiet, at most one every
 * 1.5 s, and never while it's talking or listening (the caller checks that).
 */
export function chirp(kind: Chirp): void {
  const now = performance.now();
  if (!soundsOn || now - lastChirpAt < 1500) return;
  lastChirpAt = now;
  lastChirp = { kind, at: now };
  try {
    chimeCtx ??= new AudioContext();
    const ctx = chimeCtx;
    void ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    for (const [at, f1, f2, len] of CHIRPS[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(f1, t0 + at);
      osc.frequency.exponentialRampToValueAtTime(f2, t0 + at + len);
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(0.07, t0 + at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + len + 0.02);
    }
  } catch {
    /* no audio device: just skip */
  }
}
/** The last chime played (for the self-test's report). */
export let lastChime: { kind: string; at: number } | null = null;

/**
 * Tiny sounds so you know where you stand without looking: "listen" (two
 * rising notes: I'm listening, go ahead) and "done" (two falling notes: I've
 * stopped listening). Made with oscillators, no sound files. Resolves when
 * it has finished playing.
 */
export function chime(kind: "listen" | "done"): Promise<void> {
  lastChime = { kind, at: performance.now() };
  if (!soundsOn) return Promise.resolve();
  try {
    chimeCtx ??= new AudioContext();
    const ctx = chimeCtx;
    void ctx.resume();
    const notes: [number, number][] = kind === "listen" ? [[880, 0], [1318.5, 0.085]] : [[987.8, 0], [659.3, 0.09]];
    const peak = kind === "listen" ? 0.18 : 0.1;
    const t0 = ctx.currentTime + 0.01;
    for (const [freq, at] of notes) {
      for (const [mult, share] of [[1, 1], [2, 0.18]] as const) {
        // A soft sine plus a faint octave: a little bell rather than a beep.
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq * mult;
        gain.gain.setValueAtTime(0, t0 + at);
        gain.gain.linearRampToValueAtTime(peak * share, t0 + at + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.17);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + at);
        osc.stop(t0 + at + 0.2);
      }
    }
    return new Promise((resolve) => setTimeout(resolve, 290));
  } catch {
    return Promise.resolve();
  }
}

export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  }
  return buf;
}
