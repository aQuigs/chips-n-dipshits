/** How the whole app looks. Its colors, type and shapes live in styles/tokens.css under [data-theme="<id>"]. */
export interface Theme {
  id: string;
  name: string;
  blurb: string;
  /** The Google Fonts families the theme needs, in the form the fonts API takes. */
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
  {
    id: 'contrast',
    name: 'High Contrast',
    blurb: 'White on black with heavy lines, the easiest to make out.',
    fonts: ['Inter:wght@400;500;600;700;800'],
  },
];

export const DEFAULT_THEME = 'cardroom';
/** What a device that asks for more contrast gets until its player picks a theme. */
export const HIGH_CONTRAST_THEME = 'contrast';

export function themeById(id: string | null): Theme {
  return THEMES.find((theme) => theme.id === id) ?? THEMES.find((theme) => theme.id === DEFAULT_THEME)!;
}

export function fontsUrl(themes: readonly Theme[]): string {
  const families = [...new Set(themes.flatMap((theme) => theme.fonts))];

  return `https://fonts.googleapis.com/css2?${families.map((family) => `family=${family}`).join('&')}&display=swap`;
}
