# Chips n' Dipshits

Multiplayer no-limit hold'em whose backend is a Google Sheet with an Apps Script web app. `README.md` has the setup, the house rules and the layout of the code; read it first.

## Commands

- `npm test`: unit tests, a few seconds. Run after every change.
- `npm run build`: type-checks all three TypeScript projects (Node, client, Apps Script) and builds `dist/`.
- `npm run test:e2e`: plays a full game in headless browsers, about a minute and a half. Run after any change to `src/client`, then look at the pictures it leaves in `screenshots/`.
- `npm run dev`: the game on localhost with tables in memory.
- `npm run deploy`: pushes the build to Apps Script. Outward-facing: only when asked.
- `npm run check:live`: plays a short game at the deployed address. Run after every deploy; it adds a table to the real Sheet.

## How the code is written

- TypeScript is run directly by Node, so imports carry the `.ts` extension, type imports use `import type`, and there are no enums or constructor parameter properties.
- `src/engine` stays pure: no `Date`, no `Math.random`, no I/O. Time and randomness arrive in `Ctx`. The table state must survive `JSON.stringify`.
- Every rule change comes with a test in `tests/hand.test.ts` or `tests/table.test.ts`, and `tests/simulation.test.ts` must keep passing: it plays random games and checks that no chip is ever created or lost.
- A view sent to a player never contains another player's face-down cards, the deck, or anyone's token. `viewFor` is the only place views are built.
- The client redraws a part of the screen only when what it shows has changed (`Slot`), so a tap or a half-typed bet survives updates from the server.
- A request that got no answer is not a refusal. Only `unauthorized` or `not_found` may take a player's seat out of the address or the browser's memory; anything else is retried. A move (`MOVES` in `app.ts`) that got no answer is looked up with a fresh poll, never resent.
- `npm run test:e2e` also runs `scripts/hostedRun.ts`, which puts a stand-in for Apps Script's `google.script` in the page. Changes to how the page starts, remembers a seat or sends requests need a case there.
- Colors, fonts and radii in component CSS come from the tokens at the top of `src/client/styles.css`, never a literal.
- Changing the shape of `TableState` means bumping `STATE_SCHEMA` and adding the step to `upgradeState` (`src/engine/upgrade.ts`) that brings a table saved before the change forward, with a test that one still loads.
- `scripts/rig.ts` sets up a table for a browser check with the cards fixed and a clock the check moves, and `scripts/screenChecks.ts` (run by `npm run test:e2e`) has one check per screen that has broken before. A new screen state, or a layout bug that gets fixed, gets a check there: `node scripts/screenChecks.ts "part of its name"` runs one.

## Google side

- `src/gas/sheetStore.ts` talks to the Sheet through small interfaces, with fakes in `tests/fakes.ts`. Every write and every cache refill happens under the script lock, which is what keeps the cache from ever being older than the Sheet.
- The fakes enforce the limits that bite (50,000 characters a cell, 100 KB a cache value, 250 characters a cache key); give them any new limit the store comes to depend on.
- Ledger entries and hand records are saved in the table's row with the state, then copied to their tabs. Only the write of that row may fail a request.
- Apps Script strips what it reads as comments from the page's inline scripts, and reads a `//` inside a template literal as one. `scripts/bundle.ts` ships the script with no `//` or `/*` in it and fails the build when it can't; the stand-in in `tests/appsScriptBundle.test.ts` strips the same way.
- `.clasp.json` and `.deployment.json` are per machine and ignored by git.
