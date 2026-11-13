const TURN_NOTES_HZ = [660, 880];
const NOTE_SECONDS = 0.12;
const VOLUME = 0.08;

let audio: AudioContext | null = null;

/** Two short rising notes when the action reaches the player. Silent until the browser allows sound. */
export function playTurnChime(): void {
  try {
    audio ??= new AudioContext();

    TURN_NOTES_HZ.forEach((frequency, index) => {
      const start = audio!.currentTime + index * NOTE_SECONDS;
      const oscillator = audio!.createOscillator();
      const gain = audio!.createGain();

      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(VOLUME, start);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + NOTE_SECONDS);

      oscillator.connect(gain).connect(audio!.destination);
      oscillator.start(start);
      oscillator.stop(start + NOTE_SECONDS);
    });
  } catch {
    // A browser that won't play sound must not break the game
  }
}
