import { App } from './app.ts';
import { detectPlatform } from './platform.ts';
import type { Boot } from './platform.ts';

declare global {
  interface Window {
    /** Filled in by whoever serves the page; left as a placeholder string when nobody did. */
    CND_BOOT?: Boot | string;
    /** Which build of the game the page is, written in by the build or by whoever serves the page. */
    CND_BUILD?: string;
  }
}

const boot = typeof window.CND_BOOT === 'object' && window.CND_BOOT !== null ? window.CND_BOOT : {};

new App(document.getElementById('app')!, detectPlatform(boot, window.CND_BUILD ?? '')).start();
