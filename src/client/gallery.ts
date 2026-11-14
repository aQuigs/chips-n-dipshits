/*
 * A page that shows off the themes: the real app in a laptop-sized and a phone-sized frame, playing
 * against the bots of the demo table, with the theme picker above them.
 */
import { createDemoTable } from '../demo/demoTable.ts';
import type { DemoTable } from '../demo/demoTable.ts';
import { App } from './app.ts';
import type { Links, Memory, Platform } from './platform.ts';
import { createThemePicker } from './render/themePicker.ts';
import { DEFAULT_THEME } from './themes.ts';
import { h } from './ui.ts';

interface Size {
  width: number;
  height: number;
}

const LAPTOP: Size = { width: 1180, height: 740 };
const PHONE: Size = { width: 390, height: 780 };

// What the invite dialog shows; the demo table has no address of its own
const SAMPLE_ADDRESS = 'https://script.google.com/macros/s/your-deployment/exec';

function sessionMemory(): Memory {
  const values = new Map<string, string>();

  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key),
  };
}

function demoPlatform(demo: DemoTable): Platform {
  const links: Links = {
    tableLink: (tableId) => `${SAMPLE_ADDRESS}?table=${tableId}`,
    memberLink: (tableId, auth) => `${SAMPLE_ADDRESS}?table=${tableId}&me=${auth.id}.${auth.token}`,
    showTable: () => undefined,
  };

  return { transport: demo, links, memory: sessionMemory(), boot: {} };
}

/** A box of a fixed device size that shrinks, as a picture would, to the room it is given. */
function device(kind: string, caption: string, size: Size): { figure: HTMLElement; screen: HTMLElement } {
  const screen = h('div.device-screen', { style: { width: `${size.width}px`, height: `${size.height}px` } });
  const frame = h('div.device', { class: kind, style: { 'aspect-ratio': `${size.width} / ${size.height}`, 'max-width': `${size.width}px` } }, screen);

  new ResizeObserver(() => screen.style.setProperty('--scale', String(Math.min(1, frame.clientWidth / size.width)))).observe(frame);

  return { figure: h('figure.device-figure', { class: kind }, h('figcaption', null, caption), frame), screen };
}

function start(root: HTMLElement): void {
  const demo = createDemoTable();
  const laptop = device('laptop', 'On a laptop', LAPTOP);
  const phone = device('phone', 'On a phone', PHONE);
  const preview = h('section.preview', { 'aria-label': 'Live preview' }, laptop.figure, phone.figure);

  // Both screens are the same player, as when someone carries on from their phone
  const apps = [laptop.screen, phone.screen].map((screen) => new App(screen, demoPlatform(demo), preview));
  apps[1]!.prefs.set('sound', false);
  // Both hear every key, and one move is enough
  apps[1]!.prefs.set('hotkeys', false);

  // And so they hold the same cards: a deck or a back chosen on one screen is on the other too
  for (const key of ['deck', 'cardBack'] as const) {
    for (const [from, to] of [apps, [...apps].reverse()] as [App, App][]) {
      from.prefs.watch(key, (value) => {
        if (to.prefs.get(key) !== value) {
          to.prefs.set(key, value);
        }
      });
    }
  }

  const picker = createThemePicker(DEFAULT_THEME, (id) => choose(id));
  let chosen = '';

  function choose(id: string): void {
    // Setting the theme below is itself seen by the observer, which must not start another round
    if (id === chosen) {
      return;
    }

    chosen = id;
    picker.show(id);

    for (const app of apps) {
      app.setTheme(id);
    }
  }

  // The theme can also be changed from the menu inside either screen; whichever way, both screens and the picker follow
  new MutationObserver(() => choose(preview.dataset.theme ?? DEFAULT_THEME)).observe(preview, { attributes: true, attributeFilter: ['data-theme'] });

  root.append(picker.element, preview);

  for (const app of apps) {
    app.startAt(demo.tableId, demo.you);
  }

  choose(DEFAULT_THEME);
  demo.start();
}

start(document.getElementById('gallery')!);
