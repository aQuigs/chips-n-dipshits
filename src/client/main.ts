import { App } from './app.ts';
import { detectPlatform } from './platform.ts';
import type { Boot } from './platform.ts';

declare global {
  interface Window {
    /** Filled in by whoever serves the page; left as a placeholder string when nobody did. */
    CND_BOOT?: Boot | string;
  }
}

const boot = typeof window.CND_BOOT === 'object' && window.CND_BOOT !== null ? window.CND_BOOT : {};

new App(document.getElementById('app')!, detectPlatform(boot)).start();
