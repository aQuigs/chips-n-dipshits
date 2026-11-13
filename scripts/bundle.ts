import { build } from 'esbuild';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { STYLESHEETS } from '../src/client/styles/order.ts';
import { fontsUrl, THEMES } from '../src/client/themes.ts';

const ROOT = new URL('..', import.meta.url);
const pathOf = (relative: string) => fileURLToPath(new URL(relative, ROOT));

const STYLES_DIR = 'src/client/styles/';

// Marks in the page template that the build, or the server at request time, fills in
const CSS_SLOT = '/*__CSS__*/';
const JS_SLOT = '/*__JS__*/';
const BOOT_SLOT = '"__BOOT__"';
const FONTS_SLOT = '__FONTS__';

// The functions Apps Script calls by name have to exist at the top level of the script
const APPS_SCRIPT_ENTRY_POINTS = `
function doGet(event) { return CND.doGet(event); }
function doPost(event) { return CND.doPost(event); }
function api(body) { return CND.api(body); }
`;

async function bundle(entry: string, options: Parameters<typeof build>[0] = {}): Promise<string> {
  const result = await build({
    entryPoints: [pathOf(entry)],
    bundle: true,
    write: false,
    format: 'iife',
    legalComments: 'none',
    logLevel: 'warning',
    ...options,
  });

  return result.outputFiles![0]!.text;
}

/** Fills a slot literally; a plain string replacement would treat $ sequences in the bundle as patterns. */
function fill(template: string, slot: string, content: string): string {
  if (!template.includes(slot)) {
    throw new Error(`The page template has no ${slot} slot`);
  }

  return template.replace(slot, () => content);
}

/**
 * Apps Script takes what it reads as comments out of a page's scripts before serving it, and it reads
 * them like a browser from before template literals: the // of an address in backticks was a comment
 * to it, and in a minified script the rest of the line is the rest of the program. So the script is
 * shipped with nothing in it that looks like the start of a comment. A backslash before the second
 * character changes nothing in a string, a template or a character class, the only places minified
 * code has these pairs, as long as the first slash isn't itself escaped.
 */
function withoutCommentOpeners(js: string): string {
  const safe = js.replace(/(?<!\\)\/(?=[/*])/g, '/\\');
  const left = /\/[/*]/.exec(safe);

  if (left) {
    // What is left is an escaped slash followed by / or *, which only a regular expression literal produces
    throw new Error(
      `The page's script has "${safe.slice(Math.max(0, left.index - 30), left.index + 10)}", which Apps Script would cut off as a comment. ` +
        'Write that regular expression with [/] in place of \\/.',
    );
  }

  return safe;
}

/**
 * The app's stylesheets in the order they are listed. A stylesheet left off the list would be missing
 * from the page without anything saying so, which is how a feature ships unstyled, and one listed twice
 * would override whatever stands between its two places. Either stops the build.
 */
async function appStyles(): Promise<string[]> {
  const unlisted = (await readdir(pathOf(STYLES_DIR))).filter((name) => name.endsWith('.css') && !STYLESHEETS.includes(name));
  const twice = STYLESHEETS.filter((name, index) => STYLESHEETS.indexOf(name) !== index);

  if (unlisted.length > 0) {
    throw new Error(`${unlisted.join(', ')} in ${STYLES_DIR} is not in the page: add it to STYLESHEETS in ${STYLES_DIR}order.ts`);
  }

  if (twice.length > 0) {
    throw new Error(`${twice.join(', ')} is in STYLESHEETS (${STYLES_DIR}order.ts) twice`);
  }

  return STYLESHEETS.map((name) => `${STYLES_DIR}${name}`);
}

interface PageParts {
  template: string;
  styles: string[];
  entry: string;
}

/** One HTML file with its styles and script written into it. */
async function inlinedPage(parts: PageParts): Promise<string> {
  const [template, js, ...css] = await Promise.all([
    readFile(pathOf(parts.template), 'utf8'),
    bundle(parts.entry, { minify: true, target: 'es2020' }),
    ...parts.styles.map((path) => readFile(pathOf(path), 'utf8')),
  ]);

  // Inside a script element the closing tag ends the script wherever it appears, even in a string
  const inlineJs = withoutCommentOpeners(js).replace(/<\/script/gi, '<\\/script');

  return fill(fill(template, CSS_SLOT, css.join('\n')), JS_SLOT, inlineJs);
}

/**
 * The whole game page as one HTML file, since Apps Script serves a single file.
 * Pass the settings the page should start with, or null to leave that slot for the server to fill per request.
 */
export async function clientPage(boot: object | null): Promise<string> {
  const page = await inlinedPage({
    template: 'src/client/index.html',
    styles: ['src/client/page.css', ...(await appStyles())],
    entry: 'src/client/main.ts',
  });

  return boot === null ? page : fill(page, BOOT_SLOT, JSON.stringify(boot).replace(/</g, '\\u003c'));
}

/** The page that shows off the themes: body content only, the form an Artifact is published from. */
export async function galleryPage(): Promise<string> {
  const page = await inlinedPage({
    template: 'src/client/gallery.html',
    styles: [...(await appStyles()), 'src/client/gallery.css'],
    entry: 'src/client/gallery.ts',
  });

  return fill(page, FONTS_SLOT, fontsUrl(THEMES).replace(/&/g, '&amp;'));
}

/** The server side as one script for Apps Script, which has no modules. */
export function appsScriptCode(webAppUrl: string): Promise<string> {
  return bundle('src/gas/main.ts', {
    globalName: 'CND',
    // Apps Script's engine is older than a browser's, so newer syntax is rewritten
    target: 'es2019',
    define: { WEB_APP_URL: JSON.stringify(webAppUrl) },
    footer: { js: APPS_SCRIPT_ENTRY_POINTS },
  });
}

/**
 * Writes dist/gas (what gets pushed to Apps Script) and dist/web: the same page for any static host,
 * pointed at the deployed script once there is one.
 */
export async function buildAll(webAppUrl: string): Promise<void> {
  await Promise.all([mkdir(pathOf('dist/gas'), { recursive: true }), mkdir(pathOf('dist/web'), { recursive: true })]);

  const [gasPage, webPage, code, manifest] = await Promise.all([
    clientPage(null),
    clientPage(webAppUrl ? { api: webAppUrl } : {}),
    appsScriptCode(webAppUrl),
    readFile(pathOf('src/gas/appsscript.json'), 'utf8'),
  ]);

  await Promise.all([
    writeFile(pathOf('dist/gas/index.html'), gasPage),
    writeFile(pathOf('dist/gas/Code.js'), code),
    writeFile(pathOf('dist/gas/appsscript.json'), manifest),
    writeFile(pathOf('dist/web/index.html'), webPage),
  ]);
}
