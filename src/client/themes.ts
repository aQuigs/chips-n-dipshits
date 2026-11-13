/** A look for the whole app. Its colors, type and shapes live in styles.css under [data-theme="<id>"]. */
export interface Theme {
  id: string;
  name: string;
  blurb: string;
  /** The Google Fonts families the look needs, in the form the fonts API takes. */
  fonts: string[];
}

export const THEMES: Theme[] = [
  {
    id: 'cardroom',
    name: 'Card Room',
    blurb: 'Green felt, walnut rail, brass numbers.',
    fonts: ['Fraunces:opsz,wght@9..144,600;9..144,800', 'Inter:wght@400;500;600;700'],
  },
  {
    id: 'divebar',
    name: 'Dive Bar',
    blurb: 'Red felt, bar-sign lettering, amber light.',
    fonts: ['Bungee', 'DM+Sans:wght@400;500;700'],
  },
  {
    id: 'afterhours',
    name: 'After Hours',
    blurb: 'Dark indigo, neon rail, four-color deck.',
    fonts: ['Unbounded:wght@500;800', 'Sora:wght@400;500;600;700'],
  },
  {
    id: 'daylight',
    name: 'Daylight',
    blurb: 'Light and flat, easy to read outdoors.',
    fonts: ['Space+Grotesk:wght@500;700', 'Inter:wght@400;500;600;700'],
  },
];

export const DEFAULT_THEME = 'cardroom';

export function themeById(id: string | null): Theme {
  return THEMES.find((theme) => theme.id === id) ?? THEMES.find((theme) => theme.id === DEFAULT_THEME)!;
}

export function fontsUrl(themes: readonly Theme[]): string {
  const families = [...new Set(themes.flatMap((theme) => theme.fonts))];

  return `https://fonts.googleapis.com/css2?${families.map((family) => `family=${family}`).join('&')}&display=swap`;
}
