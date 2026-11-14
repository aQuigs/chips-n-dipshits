import { silentSounds } from './sound.ts';
import type { SoundMaker, SoundName } from './sound.ts';
import { RECIPES } from './soundRecipes.ts';
import type { Voice } from './soundRecipes.ts';

const SILENCE = 0.0001;
const NOISE_SECONDS = 1;

/**
 * Makes each sound from its recipe in the page itself, so there is nothing to fetch. Browsers keep a
 * page silent until the visitor has touched it, and complain about sound set up before then, so the
 * audio is only set up by a touch: until the first one, and whenever the browser has suspended it, as
 * on a phone that slept, sounds are dropped rather than kept to play all at once later.
 */
class WebAudioSounds implements SoundMaker {
  private audio: AudioContext | null = null;
  private noise: AudioBuffer | null = null;

  constructor(page: Document) {
    // A touch only counts as the visitor's own gesture once the finger lifts, which is the click. Each is
    // heard on its way down, before what it lands on can spend the gesture the browser allows sound for
    for (const gesture of ['pointerdown', 'click', 'keydown']) {
      page.addEventListener(gesture, () => this.wake(), { capture: true });
    }
  }

  play(sound: SoundName, volume: number, delay: number): void {
    const audio = this.audio;
    if (audio?.state !== 'running') {
      return;
    }

    try {
      const start = audio.currentTime + delay;
      const out = audio.createGain();

      // Heard loudness grows much more slowly than the signal, so the slider's middle is half as loud, not a whisper
      out.gain.value = volume * volume;
      out.connect(audio.destination);

      const parts = RECIPES[sound].map((voice) => this.voice(audio, voice, start, out));

      parts.reduce((last, node) => (node.end > last.end ? node : last)).source.onended = () => out.disconnect();
    } catch {
      // A browser that won't play a sound must not break the game
    }
  }

  private voice(audio: AudioContext, voice: Voice, start: number, out: AudioNode): { source: AudioScheduledSourceNode; end: number } {
    const begin = start + voice.at;
    const end = begin + voice.length;
    const envelope = audio.createGain();

    envelope.gain.setValueAtTime(voice.level, begin);
    envelope.gain.exponentialRampToValueAtTime(SILENCE, end);
    envelope.connect(out);

    let source: AudioScheduledSourceNode;
    let pitch: AudioParam;

    if ('tone' in voice) {
      const oscillator = audio.createOscillator();

      oscillator.type = voice.wave ?? 'sine';
      oscillator.frequency.value = voice.tone;
      oscillator.connect(envelope);
      oscillator.start(begin);
      source = oscillator;
      pitch = oscillator.frequency;
    } else {
      const noise = audio.createBufferSource();
      const band = audio.createBiquadFilter();

      noise.buffer = this.noiseIn(audio);
      band.type = 'bandpass';
      band.frequency.value = voice.noise;
      band.Q.value = voice.width ?? 1;
      noise.connect(band).connect(envelope);
      // From a random place in the noise, so no two clicks of chips are the same
      noise.start(begin, Math.random() * (NOISE_SECONDS - voice.length));
      source = noise;
      pitch = band.frequency;
    }

    if (voice.slideTo) {
      pitch.setValueAtTime(pitch.value, begin);
      pitch.exponentialRampToValueAtTime(voice.slideTo, end);
    }

    source.stop(end);

    return { source, end };
  }

  private noiseIn(audio: AudioContext): AudioBuffer {
    if (!this.noise) {
      this.noise = audio.createBuffer(1, audio.sampleRate * NOISE_SECONDS, audio.sampleRate);
      const samples = this.noise.getChannelData(0);

      for (let index = 0; index < samples.length; index++) {
        samples[index] = Math.random() * 2 - 1;
      }
    }

    return this.noise;
  }

  /** Sets the audio up, or wakes it, from inside a visitor's gesture, the only place a browser allows it. */
  private wake(): void {
    // A finger going down is not yet a gesture the browser accepts, and setting up audio then draws a warning
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      return;
    }

    try {
      this.audio ??= new AudioContext();

      if (this.audio.state !== 'running') {
        void this.audio.resume().catch(() => undefined);
      }
    } catch {
      // No sound on this browser
    }
  }
}

let shared: SoundMaker | null = null;

/** The page's one maker of sounds, shared by every app on it: a browser allows a page only so many audio contexts. */
export function pageSounds(): SoundMaker {
  shared ??= typeof AudioContext === 'function' ? new WebAudioSounds(document) : silentSounds;

  return shared;
}
