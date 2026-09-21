/**
 * Sound.
 *
 * Every sound is synthesised with the Web Audio API rather than loaded from
 * a file, so the game ships with a complete audio bed and no binary assets.
 * The important part is the seam: callers only ever name a `SoundEvent`, so
 * swapping in recorded samples later means replacing `playSynth` with a
 * buffer lookup and changing nothing else.
 */

export enum SoundEvent {
  CardPlayed = 'card-played',
  CardInvalid = 'card-invalid',
  UnitSpawn = 'unit-spawn',
  Attack = 'attack',
  Hit = 'hit',
  Death = 'death',
  Spell = 'spell',
  TowerDamage = 'tower-damage',
  TowerDestroyed = 'tower-destroyed',
  Victory = 'victory',
  Defeat = 'defeat',
  Countdown = 'countdown',
  Fight = 'fight',
  Overcharge = 'overcharge',
  UiClick = 'ui-click',
  UiBack = 'ui-back',
  MatchFound = 'match-found',
}

/**
 * Tone shape. Extends the oscillator types with 'noise', which is rendered
 * from a noise buffer rather than an oscillator.
 */
type Waveform = OscillatorType | 'noise';

/** A single synthesised voice. */
interface Voice {
  wave: Waveform;
  /** Start frequency in Hz. */
  freq: number;
  /** Frequency at the end of the sound; omit to hold steady. */
  endFreq?: number;
  duration: number;
  /** Peak gain, 0..1, before the master volume is applied. */
  gain: number;
  /** Attack time as a fraction of the duration. */
  attack?: number;
  /** Seconds to wait before this voice starts. */
  delay?: number;
  /** Adds a noise burst instead of a tone. */
  noise?: boolean;
  /** Low-pass cutoff for noise voices. */
  cutoff?: number;
}

/**
 * The sound bank. Each event maps to a small stack of voices.
 * Tuned so combat chatter sits low and quiet while events that need the
 * player's attention (a tower falling, a match ending) cut through.
 */
const BANK: Record<SoundEvent, Voice[]> = {
  [SoundEvent.CardPlayed]: [
    { wave: 'triangle', freq: 420, endFreq: 640, duration: 0.16, gain: 0.3 },
    { wave: 'sine', freq: 840, endFreq: 1180, duration: 0.12, gain: 0.16, delay: 0.03 },
  ],
  [SoundEvent.CardInvalid]: [
    { wave: 'square', freq: 180, endFreq: 110, duration: 0.18, gain: 0.16 },
  ],
  [SoundEvent.UnitSpawn]: [
    { wave: 'sine', freq: 300, endFreq: 520, duration: 0.2, gain: 0.2 },
    { wave: 'noise', freq: 0, duration: 0.14, gain: 0.1, noise: true, cutoff: 1800 },
  ],
  [SoundEvent.Attack]: [
    { wave: 'square', freq: 260, endFreq: 190, duration: 0.06, gain: 0.07 },
  ],
  [SoundEvent.Hit]: [
    { wave: 'noise', freq: 0, duration: 0.07, gain: 0.09, noise: true, cutoff: 2600 },
  ],
  [SoundEvent.Death]: [
    { wave: 'sawtooth', freq: 320, endFreq: 90, duration: 0.26, gain: 0.14 },
    { wave: 'noise', freq: 0, duration: 0.2, gain: 0.1, noise: true, cutoff: 1200 },
  ],
  [SoundEvent.Spell]: [
    { wave: 'sawtooth', freq: 180, endFreq: 760, duration: 0.3, gain: 0.2 },
    { wave: 'noise', freq: 0, duration: 0.35, gain: 0.14, noise: true, cutoff: 3200 },
  ],
  [SoundEvent.TowerDamage]: [
    { wave: 'triangle', freq: 150, endFreq: 96, duration: 0.2, gain: 0.18 },
    { wave: 'noise', freq: 0, duration: 0.16, gain: 0.12, noise: true, cutoff: 900 },
  ],
  [SoundEvent.TowerDestroyed]: [
    { wave: 'sawtooth', freq: 240, endFreq: 48, duration: 0.85, gain: 0.34 },
    { wave: 'noise', freq: 0, duration: 0.7, gain: 0.3, noise: true, cutoff: 800 },
    { wave: 'sine', freq: 96, endFreq: 40, duration: 0.9, gain: 0.22, delay: 0.06 },
  ],
  [SoundEvent.Victory]: [
    { wave: 'triangle', freq: 523, duration: 0.18, gain: 0.3 },
    { wave: 'triangle', freq: 659, duration: 0.18, gain: 0.3, delay: 0.16 },
    { wave: 'triangle', freq: 784, duration: 0.18, gain: 0.3, delay: 0.32 },
    { wave: 'triangle', freq: 1047, duration: 0.5, gain: 0.34, delay: 0.48 },
  ],
  [SoundEvent.Defeat]: [
    { wave: 'triangle', freq: 440, duration: 0.24, gain: 0.26 },
    { wave: 'triangle', freq: 349, duration: 0.24, gain: 0.26, delay: 0.22 },
    { wave: 'triangle', freq: 262, duration: 0.7, gain: 0.3, delay: 0.44 },
  ],
  [SoundEvent.Countdown]: [
    { wave: 'sine', freq: 660, duration: 0.14, gain: 0.26 },
  ],
  [SoundEvent.Fight]: [
    { wave: 'sawtooth', freq: 220, endFreq: 660, duration: 0.4, gain: 0.34 },
    { wave: 'noise', freq: 0, duration: 0.3, gain: 0.18, noise: true, cutoff: 4000 },
  ],
  [SoundEvent.Overcharge]: [
    { wave: 'sawtooth', freq: 300, endFreq: 900, duration: 0.5, gain: 0.26 },
    { wave: 'sine', freq: 900, endFreq: 1400, duration: 0.4, gain: 0.18, delay: 0.1 },
  ],
  [SoundEvent.UiClick]: [
    { wave: 'sine', freq: 680, endFreq: 880, duration: 0.07, gain: 0.16 },
  ],
  [SoundEvent.UiBack]: [
    { wave: 'sine', freq: 520, endFreq: 360, duration: 0.09, gain: 0.14 },
  ],
  [SoundEvent.MatchFound]: [
    { wave: 'triangle', freq: 523, duration: 0.14, gain: 0.3 },
    { wave: 'triangle', freq: 784, duration: 0.3, gain: 0.32, delay: 0.13 },
  ],
};

/** Events that may fire many times per second get throttled. */
const THROTTLE_MS: Partial<Record<SoundEvent, number>> = {
  [SoundEvent.Attack]: 70,
  [SoundEvent.Hit]: 55,
  [SoundEvent.Death]: 90,
  [SoundEvent.TowerDamage]: 140,
  [SoundEvent.UnitSpawn]: 80,
};

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicTimer: number | null = null;
  private lastPlayed = new Map<SoundEvent, number>();
  private noiseBuffer: AudioBuffer | null = null;

  sfxVolume = 0.7;
  musicVolume = 0.35;
  muted = false;

  /**
   * Browsers block audio until a user gesture, so the context is created
   * lazily on the first interaction rather than at import time.
   */
  private ensureContext(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    }
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = this.musicVolume;
      this.musicGain.connect(this.master);
      return this.ctx;
    } catch {
      // Audio is a nicety; a failure here must never break the game.
      return null;
    }
  }

  /** Called from a click handler to unlock audio. */
  unlock(): void {
    this.ensureContext();
  }

  private getNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer;
    const length = Math.floor(ctx.sampleRate * 0.5);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
    return buffer;
  }

  play(event: SoundEvent, volumeScale = 1): void {
    if (this.muted) return;
    const throttle = THROTTLE_MS[event];
    if (throttle !== undefined) {
      const last = this.lastPlayed.get(event) ?? 0;
      const now = performance.now();
      if (now - last < throttle) return;
      this.lastPlayed.set(event, now);
    }

    const ctx = this.ensureContext();
    if (!ctx || !this.master) return;

    for (const voice of BANK[event] ?? []) {
      this.playVoice(ctx, voice, volumeScale);
    }
  }

  private playVoice(ctx: AudioContext, voice: Voice, volumeScale: number): void {
    const start = ctx.currentTime + (voice.delay ?? 0);
    const gain = ctx.createGain();
    const peak = voice.gain * this.sfxVolume * volumeScale;
    const attack = Math.max(0.005, voice.duration * (voice.attack ?? 0.08));

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + voice.duration);
    gain.connect(this.master as GainNode);

    if (voice.noise) {
      const source = ctx.createBufferSource();
      source.buffer = this.getNoiseBuffer(ctx);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = voice.cutoff ?? 2000;
      source.connect(filter);
      filter.connect(gain);
      source.start(start);
      source.stop(start + voice.duration);
      return;
    }

    const osc = ctx.createOscillator();
    osc.type = voice.wave as OscillatorType;
    osc.frequency.setValueAtTime(voice.freq, start);
    if (voice.endFreq !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(1, voice.endFreq),
        start + voice.duration,
      );
    }
    osc.connect(gain);
    osc.start(start);
    osc.stop(start + voice.duration);
  }

  /**
   * A slow generative pad for the battle screen. Deliberately sparse so it
   * sits under the combat sounds instead of competing with them.
   */
  startMusic(): void {
    if (this.muted || this.musicTimer !== null) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.musicGain) return;

    // A minor pentatonic-ish set, which stays consonant in any order.
    const scale = [131, 147, 175, 196, 233, 262, 294, 349];
    let step = 0;

    const tick = (): void => {
      if (this.muted || !this.ctx || !this.musicGain) return;
      const now = this.ctx.currentTime;
      const root = scale[step % scale.length] as number;
      // Root plus a fifth, with a long swell.
      for (const [freq, level] of [
        [root, 0.12],
        [root * 1.5, 0.07],
        [root * 2, 0.045],
      ] as Array<[number, number]>) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(level, now + 1.2);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 3.6);
        osc.connect(gain);
        gain.connect(this.musicGain);
        osc.start(now);
        osc.stop(now + 3.7);
      }
      step += step % 3 === 2 ? 2 : 1;
    };

    tick();
    this.musicTimer = window.setInterval(tick, 3400);
  }

  stopMusic(): void {
    if (this.musicTimer !== null) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  setSfxVolume(value: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, value));
  }

  setMusicVolume(value: number): void {
    this.musicVolume = Math.max(0, Math.min(1, value));
    if (this.musicGain) this.musicGain.gain.value = this.musicVolume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stopMusic();
    if (this.master) this.master.gain.value = muted ? 0 : 1;
  }
}

export const audio = new AudioEngine();

/** Maps a card's `sound` key onto the event fired when it is played. */
export function cardSoundEvent(cardType: string): SoundEvent {
  return cardType === 'spell' ? SoundEvent.Spell : SoundEvent.CardPlayed;
}
