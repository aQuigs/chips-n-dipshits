import type { SoundName } from './sound.ts';

interface VoiceBase {
  /** Seconds after the sound starts. */
  at: number;
  /** Seconds, fading out all the way. */
  length: number;
  /** Loudness at full volume, from 0 to 1. */
  level: number;
  /** Where the note, or the middle of the noise's band, has slid to by the end. */
  slideTo?: number;
}

/** One part of a sound: a note, or a burst of noise through a band, as of chips or cards. */
export type Voice = (VoiceBase & { tone: number; wave?: 'sine' | 'triangle' }) | (VoiceBase & { noise: number; width?: number });

const clicks = (times: number[], hz: number, level: number): Voice[] => times.map((at) => ({ noise: hz, width: 3, at, length: 0.03, level }));

/**
 * What each sound is made of, all short and soft, since the page may be open for a whole evening.
 * Every sound has its own set of notes and bursts, which is how a browser check tells them apart.
 */
export const RECIPES: Record<SoundName, Voice[]> = {
  // Cards skimming the felt, one per flick, over before a flop dealt with them, as in a bomb pot, can start
  deal: [0, 0.04, 0.08].map((at) => ({ noise: 5000, width: 0.8, at, length: 0.035, level: 0.7 })),
  // Two chips clicking down
  chips: [...clicks([0, 0.05], 4000, 1), { tone: 3200, at: 0, length: 0.05, level: 0.15 }, { tone: 4100, at: 0.05, length: 0.05, level: 0.12 }],
  // Two raps of the knuckles on the table, pitched high enough for a phone's speaker
  knock: [0, 0.12].flatMap((at): Voice[] => [
    { tone: 380, slideTo: 240, at, length: 0.07, level: 0.45 },
    { noise: 1200, width: 2, at, length: 0.015, level: 0.5 },
  ]),
  // Cards pushed away
  fold: [{ noise: 1800, slideTo: 500, width: 0.7, at: 0, length: 0.2, level: 0.4 }],
  // A card slapped face up
  street: [
    { noise: 2500, width: 1, at: 0, length: 0.06, level: 0.6 },
    { tone: 300, wave: 'triangle', slideTo: 200, at: 0, length: 0.06, level: 0.4 },
  ],
  // A low note and a dark chord over it
  allIn: [
    { tone: 220, wave: 'triangle', at: 0, length: 0.14, level: 0.35 },
    { tone: 440, wave: 'triangle', at: 0.16, length: 0.5, level: 0.25 },
    { tone: 523, wave: 'triangle', at: 0.16, length: 0.5, level: 0.2 },
  ],
  // Chips raked in and two bright notes
  win: [...clicks([0, 0.05, 0.1], 4000, 0.5), { tone: 523, at: 0.12, length: 0.3, level: 0.15 }, { tone: 784, at: 0.2, length: 0.4, level: 0.15 }],
  // More chips and a whole chord rising, for the viewer's own pot
  myWin: [
    ...clicks([0, 0.04, 0.08, 0.12], 4000, 0.55),
    ...[523, 659, 784].map((tone, index) => ({ tone, at: 0.14 + index * 0.08, length: 0.25, level: 0.18 })),
    { tone: 1047, at: 0.38, length: 0.6, level: 0.18 },
  ],
  // Two short rising notes when the action reaches the viewer
  turn: [
    { tone: 660, at: 0, length: 0.12, level: 0.32 },
    { tone: 880, at: 0.12, length: 0.12, level: 0.32 },
  ],
};
