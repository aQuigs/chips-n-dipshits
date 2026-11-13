# Chips n' Dipshits

No-limit hold'em for a group of friends, played in the browser. There is no server to run: the game lives in a Google Sheet, and the Apps Script attached to that Sheet serves the page and runs the rules. The host shares a link, everyone picks a name and sits down.

## What it does

- Cash game for up to 10 players: blinds, side pots, all-ins, showdown with show or muck, an action clock, sitting out, rebuys.
- Straddles, run it twice and a seven-deuce bounty, each switched on or off per table.
- The host approves seats and rebuys, pauses the game, changes blinds and settings, adjusts stacks, removes players and can hand the table to someone else.
- A ledger with who pays whom to settle up, hand history, table chat with the dealer's play-by-play.
- Four themes with a picker on the front page and in the menu; each player chooses their own. Works on a phone, upright or sideways, and on a desktop.
- A personal link to carry on from another device.

## House rules

The choices the code makes where poker rooms differ:

- Chips are whole numbers. There are no antes.
- The button moves to the next seat with a player in the hand. Heads-up, the button posts the small blind and acts first before the flop.
- A big blind who is short still sets the full big blind as the price to call.
- The smallest raise is the size of the last full raise. An all-in for less does not reopen the betting for players who have already acted.
- The odd chip of a split pot goes to the first winner clockwise from the button.
- At showdown the last player to bet or raise on the river shows first, otherwise the first player left of the button. A player who cannot win any pot they are in for mucks without showing; anyone may show afterwards.
- When the betting is over with players all in and cards to come, hands are turned face up. Run it twice needs every player still in to agree within 12 seconds.
- A straddle is twice the big blind from the player left of the big blind, who then acts last before the flop. There is none heads-up.
- The seven-deuce bounty is paid by every other player dealt into the hand, up to their stack, when someone holding 7-2 wins the whole main pot or wins without a showdown. The hand is shown either way.
- A player who runs out of time checks if they can and folds if not, and sits out until they come back. A change to the clock applies to whoever is being waited for, counted from the change.
- A player who stands up or is removed during a hand checks while checking is free and folds to any bet, the same as one who has timed out. Their seat is cashed out when the hand ends.
- Chips added during a hand arrive when it ends, and only as far as the table maximum then allows, so winning the hand can make a rebuy smaller or cancel it.

## Set it up

You need Node 24 or newer and a Google account.

1. `npm install`
2. `npx clasp login`, and sign in with the Google account that should own the Sheet.
3. Switch on the Apps Script API at <https://script.google.com/home/usersettings>.
4. `npm run deploy`. The first run creates a Sheet named "Chips n' Dipshits" with its script and prints the game's address.
5. Open that address once while signed in as the owner and approve the permission prompt (Google warns that it hasn't verified the app, which is normal for a script of your own: Advanced, then go on). From then on anyone with the address can play, without a Google account. Until then visitors get "Access Denied".
6. `npm run check:live` plays a short two-player game at the address and times each step.

With several Google accounts signed in to one browser, Google tends to send these steps to the wrong one. A private window with only the owner's account avoids that.

`npm run deploy` is also how an update goes live; the address stays the same.

The Sheet is the database. It holds every table (including the cards in play), the ledger and the hand history, so only people you trust not to peek should have access to it. Players never need access to the Sheet itself.

## Work on it

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the game at <http://127.0.0.1:8787> with tables kept in memory, reachable from this machine only. Open it in several windows to play against yourself. |
| `npm test` | The rules, the request handling and the Sheet storage, against fakes. |
| `npm run test:e2e` | Six players in real browsers through two hands, then the page served the way Apps Script serves it, with requests made to fail. Needs `npx playwright install chromium` once. |
| `npm run screenshots` | The same browser run, saving a picture of every screen, and of the table in every theme, to `screenshots/`. |
| `npm run build` | Type-checks and writes `dist/gas` (what is pushed to Apps Script) and `dist/web` (the page for any static host). |
| `npm run gallery` | Writes `dist/gallery.html`, a showcase of the themes with the app playing against bots in the page. |
| `npm run check:live` | Plays a short game at the deployed address in real browsers and checks the page Google serves is the one that was built. Leaves one small table in the Sheet. |

## How it is put together

| Folder | Job | Depends on |
| --- | --- | --- |
| `src/engine` | The rules of the game as pure functions over a table that is plain JSON. No clock, no randomness, no storage of its own. | nothing |
| `src/server` | Turns requests into engine calls. `TableStore` is the interface a database implements. | engine |
| `src/gas` | The Apps Script side: `SheetStore` keeps tables in the Sheet with a cache in front, and `main.ts` is the web app. | server |
| `src/client` | The page. `Transport`, `Links` and `Memory` are the interfaces between it and wherever it is hosted. | engine (types and hand names), server (request types) |
| `src/dev` | The local server, with tables in memory. | server |
| `src/demo` | A table with bots that runs inside a page, for the theme showcase. | server |

Things worth knowing before changing it:

- Nothing runs in the background. Time-based events (the action clock, the pause after a hand) happen when the next request arrives and finds a deadline has passed, so a table nobody is looking at simply waits.
- A player's page keeps one request open with the server, which answers the moment something changes. Apps Script allows 30 requests at once per deploying account, which is plenty for one full table and tight for three.
- A table's ledger entries and finished hands are written into its row in the same write as the table itself, then copied to the Ledger and Hands tabs. If the copy fails they wait in the row and are tried again within a minute or at the table's next save, so the game never stops over it and no record is lost. Each carries an id, which is how a retry knows not to write one twice.
- Served by Apps Script, the page sits in a frame whose storage the browser may throw away, so a player's seat is kept in the address (`?table=…&me=…`). The page only takes it out when the server has said the seat is gone, never because a request failed. The address names one seat, so creating or joining another table from the lobby replaces it; the first table's personal link (under Invite players in its menu) is the way back.
- A request can be answered, refused, or get no answer while having been carried out. A move that gets no answer is looked up, not sent again, and every move names the decision it answers, so the server refuses one that arrives late. A poll's answer older than what the page held when it asked means the table itself went back, as after restoring the Sheet, and is followed; one merely older than what is showing was overtaken and is dropped.
- A saved table carries a schema number (`STATE_SCHEMA`). Change the shape of the saved state and tables from before the change stop loading unless the code migrates them.
- A theme is a set of values for the design tokens at the top of `src/client/styles.css`, plus an entry in `src/client/themes.ts`.
- Another game is a new engine module behind the same commands and views; another database is a new `TableStore`; another host for the page is a new `Transport` and `Links`.
