import { textSizeFor } from './deviceWishes.ts';
import type { DeviceWishes } from './deviceWishes.ts';
import { HIGH_CONTRAST_THEME } from './themes.ts';

/** What this page's device asks for: the high-contrast theme where it is set to more contrast, larger text where its browser's is. */
export function pageWishes(): DeviceWishes {
  const moreContrast = matchMedia('(prefers-contrast: more)');
  const textSize = textSizeFor(parseFloat(getComputedStyle(document.documentElement).fontSize));

  return {
    wished: (key) => (key === 'theme' ? (moreContrast.matches ? HIGH_CONTRAST_THEME : null) : key === 'textSize' ? textSize : null),
    onChange: (listener) => moreContrast.addEventListener('change', listener),
  };
}
