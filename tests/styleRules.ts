import { readFileSync } from 'node:fs';

/** A stylesheet's rules by selector, each the properties it sets. */
export type Rules = Map<string, Map<string, string>>;

/** The rules of one of the app's stylesheets. Enough for the flat files in src/client/styles. */
export function rules(file: string): Rules {
  const css = readFileSync(new URL(`../src/client/styles/${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const found: Rules = new Map();

  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const properties = new Map<string, string>();

    for (const declaration of body!.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon > 0) {
        properties.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim().replace(/\s+/g, ' '));
      }
    }

    found.set(selector!.trim().replace(/\s+/g, ' '), properties);
  }

  return found;
}

const TOKENS = rules('tokens.css');

/** A theme's tokens: the first block's, which every theme starts from, then its own. */
export function themeTokens(id: string): Map<string, string> {
  return new Map([...TOKENS.get(':root, [data-theme]')!, ...(TOKENS.get(`[data-theme='${id}']`) ?? [])]);
}
