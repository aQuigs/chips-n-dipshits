import { build } from 'esbuild';
import type { Plugin } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STYLESHEETS } from '../src/client/styles/order.ts';
import { fontsUrl, THEMES } from '../src/client/themes.ts';
import { UNSTAMPED_BUILD } from '../src/server/build.ts';

const ROOT = new URL('..', import.meta.url);
const pathOf = (relative: string) => fileURLToPath(new URL(relative, ROOT));

const STYLES_DIR = 'src/client/styles/';

// Marks in the page template that the build, or the server at request time, fills in
const CSS_SLOT = '/*__CSS__*/';
const JS_SLOT = '/*__JS__*/';
const BOOT_SLOT = '"__BOOT__"';
const FONTS_SLOT = '__FONTS__';

// Enough of the hash that two builds never share an id, and little enough to ride on every request
const BUILD_ID_LENGTH = 12;

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
  plugins?: Plugin[];
}

/** One HTML file with its styles and script written into it. */
async function inlinedPage(parts: PageParts): Promise<string> {
  const [template, js, ...css] = await Promise.all([
    readFile(pathOf(parts.template), 'utf8'),
    bundle(parts.entry, { minify: true, target: 'es2020', plugins: parts.plugins }),
    ...parts.styles.map((path) => readFile(pathOf(path), 'utf8')),
  ]);

  // Inside a script element the closing tag ends the script wherever it appears, even in a string
  const inlineJs = withoutCommentOpeners(js).replace(/<\/script/gi, '<\\/script');

  return fill(fill(template, CSS_SLOT, css.join('\n')), JS_SLOT, inlineJs);
}

/**
 * The whole game page as one HTML file, since Apps Script serves a single file.
 * Pass the settings the page should start with, or null to leave that slot for the server to fill per request.
 * The page is unstamped: it says it is build `UNSTAMPED_BUILD` until `stamped` or whoever serves it says otherwise.
 */
export async function clientPage(boot: object | null, plugins: Plugin[] = []): Promise<string> {
  const page = await inlinedPage({
    template: 'src/client/index.html',
    styles: ['src/client/page.css', ...(await appStyles())],
    entry: 'src/client/main.ts',
    plugins,
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

/** The server side as one script for Apps Script, which has no modules. Unstamped, like the page. */
export function appsScriptCode(webAppUrl: string, plugins: Plugin[] = []): Promise<string> {
  return bundle('src/gas/main.ts', {
    globalName: 'CND',
    // Apps Script's engine is older than a browser's, so newer syntax is rewritten
    target: 'es2019',
    define: { WEB_APP_URL: JSON.stringify(webAppUrl), BUILD_ID: JSON.stringify(UNSTAMPED_BUILD) },
    footer: { js: APPS_SCRIPT_ENTRY_POINTS },
    plugins,
  });
}

/** A page or a script with the id of its build written in, wherever it says which build it is. */
function stamped(built: string, id: string): string {
  if (!built.includes(UNSTAMPED_BUILD)) {
    throw new Error('What was built has nowhere to say which build it is');
  }

  return built.replaceAll(UNSTAMPED_BUILD, () => id);
}

/** What a build writes to dist, by path there, and the id all of it carries. */
export interface Build {
  id: string;
  files: Record<string, string>;
}

/**
 * Builds dist/gas (what gets pushed to Apps Script) and dist/web: the same page for any static host,
 * pointed at the deployed script once there is one.
 *
 * The id is a hash of the page and the script as built, before it is written into them. So the same
 * sources give the same id, whenever and however often they are built, and a deploy that changes
 * nothing a page or the server runs leaves the pages that are open alone.
 * `plugins` are esbuild's, for a test to build from sources other than the ones in the tree.
 */
export async function buildFiles(webAppUrl: string, plugins: Plugin[] = []): Promise<Build> {
  const [gasPage, webPage, code, manifest] = await Promise.all([
    clientPage(null, plugins),
    clientPage(webAppUrl ? { api: webAppUrl } : {}, plugins),
    appsScriptCode(webAppUrl, plugins),
    readFile(pathOf('src/gas/appsscript.json'), 'utf8'),
  ]);

  const id = createHash('sha256').update(gasPage).update(code).digest('hex').slice(0, BUILD_ID_LENGTH);

  return {
    id,
    files: {
      'gas/index.html': stamped(gasPage, id),
      'gas/Code.js': stamped(code, id),
      'gas/appsscript.json': manifest,
      'web/index.html': stamped(webPage, id),
    },
  };
}

export async function buildAll(webAppUrl: string): Promise<void> {
  const { files } = await buildFiles(webAppUrl);

  for (const [path, content] of Object.entries(files)) {
    const file = pathOf(`dist/${path}`);

    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}
