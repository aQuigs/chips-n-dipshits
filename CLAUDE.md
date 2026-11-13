# Chips n' Dipshits

Multiplayer no-limit hold'em whose backend is a Google Sheet with an Apps Script web app. `README.md` has the setup, the house rules and the layout of the code; read it first.

## Commands

- `npm test`: unit tests, a few seconds. Run after every change.
- `npm run build`: type-checks all three TypeScript projects (Node, client, Apps Script) and builds `dist/`.
- `npm run test:e2e`: plays a full game in headless browsers, about a minute. Run after any change to `src/client`, then look at the pictures it leaves in `screenshots/`.
- `npm run dev`: the game on localhost with tables in memory.
- `npm run deploy`: pushes the build to Apps Script. Outward-facing: only when asked.

## How the code is written

- TypeScript is run directly by Node, so imports carry the `.ts` extension, type imports use `import type`, and there are no enums or constructor parameter properties.
- `src/engine` stays pure: no `Date`, no `Math.random`, no I/O. Time and randomness arrive in `Ctx`. The table state must survive `JSON.stringify`.
- Every rule change comes with a test in `tests/hand.test.ts` or `tests/table.test.ts`, and `tests/simulation.test.ts` must keep passing: it plays random games and checks that no chip is ever created or lost.
- A view sent to a player never contains another player's face-down cards, the deck, or anyone's token. `viewFor` is the only place views are built.
- The client redraws a part of the screen only when what it shows has changed (`Slot`), so a tap or a half-typed bet survives updates from the server.
- Colors, fonts and radii in component CSS come from the tokens at the top of `src/client/styles.css`, never a literal.
- Changing the shape of `TableState` means bumping `STATE_SCHEMA` and deciding what happens to saved tables.

## Google side

- `src/gas/sheetStore.ts` talks to the Sheet through small interfaces, with fakes in `tests/fakes.ts`. Every write and every cache refill happens under the script lock, which is what keeps the cache from ever being older than the Sheet.
- The fakes enforce the limits that bite (50,000 characters a cell, 100 KB a cache value, 250 characters a cache key); give them any new limit the store comes to depend on.
- Ledger entries and hand records are saved in the table's row with the state, then copied to their tabs. Only the write of that row may fail a request.
- `.clasp.json` and `.deployment.json` are per machine and ignored by git.
