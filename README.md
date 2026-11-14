# Chips n' Dipshits

No-limit hold'em for a group of friends, played in the browser. There is no server to run: the game lives in a Google Sheet, and the Apps Script attached to that Sheet serves the page and runs the rules. The host shares a link, everyone picks a name and sits down.

## What it does

- Cash game for up to 10 players: blinds, side pots, all-ins, showdown with show or muck, an action clock, sitting out, rebuys.
- Straddles, run it twice and a seven-deuce bounty, each switched on or off per table.
- An ante if the table wants one, paid by everyone or by the big blind for the whole table.
- Bomb pots, called by the host for the next hand or played every so many hands: everyone puts in the same amount, there are no blinds, and the hand starts on the flop.
- Stakes in whole chips or in dollars and cents, such as 0.25/0.50, chosen per table.
- The host approves seats and rebuys, pauses the game, changes blinds and settings, adjusts stacks, removes players and can hand the table to someone else.
- The host transfers chips from one player to another, to settle a side bet or stake a friend (Transfer chips in the Players dialog). Everyone sees it in the chat, and the ledger shows each player's chips transferred beside what they bought and cashed out.
- The host moves a player to an open seat (Move in the Players dialog, then tap the seat; on a desktop, dragging the seat works too) or shuffles everyone into random seats.
- The host can add a link to the group's Meet, Discord or Zoom call, and everyone at the table gets a button that opens it, saying which site it leads to.
- The host saves a table's settings as a preset with a name, such as "Friday 25/50", at the bottom of the table settings, and the form for a new table offers the group's presets: picking one fills the form, marks what it changed and can still be edited. A preset keeps every setting except the voice chat link, which stays with its table since anyone with the game's address can see the presets. The group can keep 20.
- The host can name co-hosts, who can do all of that too except name co-hosts, hand the table over or remove the host. The host has a ★ by their name and co-hosts a ☆.
- A ledger with who pays whom to settle up, hand history, table chat with the dealer's play-by-play.
- Four themes with a picker on the front page and in the menu; each player chooses their own, along with a four-color deck and a card back. Works on a phone, upright or sideways, and on a desktop.
- Under your own cards, what you hold: your two cards before the flop ("Ace-king suited"), then your best hand on every street, one per board when run twice, with the cards that make it lifted and the rest faded. It also points out seven-deuce when the bounty is on. Preferences turns it off.
- Short, quiet sounds for what happens at the table: cards dealt, chips for a bet or a call, a knock for a check, a fold, a sting for an all-in, each street, a pot won (a bigger one when it is yours), and a chime when it is your turn. Preferences has the switch and a volume. Only what happens while you watch makes a sound, never what you missed, and in another tab only the chime plays.
- Keyboard shortcuts on a computer: F to fold, C to check or call, R to type a bet, 1 to 5 for the bet sizes, O or T to run it once or twice. Each button shows its key, and Preferences lists them and turns them off.
- A personal link to carry on from another device.

## House rules

The choices the code makes where poker rooms differ:

- A table plays whole chips or dollars and cents, chosen when it is created and fixed from then on. Nothing is smaller than a chip or a cent.
- An ante is any amount the host sets, with no tie to the blinds. It goes into the pot before any betting and is no part of a bet, so calling the big blind costs the same with or without one. A player with less than their ante puts in what they have and is all in.
- When everyone antes, a player's ante counts as chips they put in when side pots are worked out: one whose whole stack went on the ante can win that much from each opponent and no more.
- A big-blind ante is one ante the big blind posts for the whole table, heads-up too. It is dead money in the main pot, which every player in the hand can win whatever they put in themselves. A big blind who cannot cover both posts the blind first and puts what is left toward the ante.
- In a bomb pot everyone dealt in puts in the same amount, set by the host with no tie to the blinds, and the flop is dealt at once: no blinds, no straddle, no betting before the flop, and the table's ante is not posted on top. The amount counts as chips a player put in, so a player who cannot cover it is all in and can win that much from each opponent. The button moves as on any hand, the first player left of it who can still act opens the flop, and the least bet is the big blind.
- A bomb pot that leaves at most one player with chips still gets its flop, and the rest is run out as after any all-in.
- A bomb pot the host calls is the next hand dealt, however long a pause or a short table puts that off, and can be called off until then. Played every so many hands, the count is of hands dealt since the last bomb pot, called or not. Sitting out is the only way to skip one.
- The button moves to the next seat with a player in the hand. Heads-up, the button posts the small blind and acts first before the flop.
- A player moved to another seat leaves the button where it was, on the seat. A shuffle gives everyone a random one of the seats already taken, and the next hand draws the button afresh, as a table's first hand does. A player dealt into the hand in play moves when it ends, and a shuffle waits for it too; a move whose seat is taken by then is dropped.
- A big blind who is short still sets the full big blind as the price to call.
- The smallest raise is the size of the last full raise. An all-in for less does not reopen the betting for players who have already acted.
- The odd chip, or the odd cent, of a split pot goes to the first winner clockwise from the button.
- At showdown the last player to bet or raise on the river shows first, otherwise the first player left of the button. A player who cannot win any pot they are in for mucks without showing; anyone may show afterwards.
- When the betting is over with players all in and cards to come, hands are turned face up. Run it twice needs every player still in to agree within 12 seconds; one who leaves without answering has said no.
- A straddle is twice the big blind from the player left of the big blind, who then acts last before the flop. It counts as a raise, so the smallest raise over it is to twice the straddle. There is none heads-up.
- The seven-deuce bounty is paid by every other player dealt into the hand, up to their stack, when someone holding 7-2 wins the whole main pot or wins without a showdown. The hand is shown whenever a bounty is paid.
- New blinds, a new ante, a new bounty and new bomb pot settings apply from the next hand; the hand in play finishes on the terms it was dealt under.
- A player who runs out of time checks if they can and folds if not, and sits out until they come back. A change to the clock applies to whoever is being waited for, counted from the change.
- A player who stands up or is removed during a hand checks while checking is free and folds to any bet, the same as one who has timed out. Their seat is cashed out when the hand ends.
- Chips added during a hand arrive when it ends, and only as far as the table maximum then allows, so winning the hand can make a rebuy smaller or cancel it.
- A request for a seat that can no longer be granted, because the seat went to someone else or the buy-in limits changed, is dropped and the player is told to ask again.
- A transfer is between two seated players, neither of them in the hand being played, so at a running game the host pauses first. It is never a buy-in: the receiver may end up above the table maximum, and the settle-up comes out as if the receiver had bought the chips with the giver's money. A giver left with nothing sits out like anyone who lost their stack, until they add chips.
- The host can take someone who never bought in off the table altogether, which is also how room is made at a full table.
- With a co-host named, the game carries on when the host's phone dies: the co-host approves players, pauses and adjusts stacks in their place. A co-host needn't be seated and stays one after standing up. Handing the table over makes the old host a co-host.
- A name that reads like one already at the table is refused: another alphabet's look-alike letters, a capital I for a small l, a zero for an o.

## Set it up

You need Node 24 or newer and a Google account.

1. `npm install`
2. `npx clasp login`, and sign in with the Google account that should own the Sheet.
3. Switch on the Apps Script API at <https://script.google.com/home/usersettings>.
4. `npm run deploy`. The first run creates a Sheet named "Chips n' Dipshits" with its script and prints the game's address.
5. Open that address once while signed in as the owner and approve the permission prompt (Google warns that it hasn't verified the app, which is normal for a script of your own: Advanced, then go on). From then on anyone with the address can play, without a Google account. Until then visitors get "Access Denied".
6. `npm run check:live` plays a short two-player game at the address and times each step.

With several Google accounts signed in to one browser, Google tends to send these steps to the wrong one. A private window with only the owner's account avoids that.

`npm run deploy` is also how an update goes live; the address stays the same. A page that was open through the update says "The game was updated" the next time it hears from the server, with a Reload button, and until it is reloaded nothing it sends changes a table. The reload comes back to the same table and seat.

The Sheet is the database, a tab for each kind of thing: Tables (every table, including the cards in play), Ledger, Hands, and Presets (the group's saved settings, made the first time one is saved). Only people you trust not to peek should have access to it. Players never need access to the Sheet itself.

## Work on it

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the game at <http://127.0.0.1:8787> with tables kept in memory, reachable from this machine only. Open it in several windows to play against yourself. |
| `npm test` | The rules, the request handling and the Sheet storage, against fakes. |
| `npm run test:e2e` | Six players in real browsers through two hands, then the page served the way Apps Script serves it, with requests made to fail, then the screens where they are tightest: small phones, long chat, the largest stacks. Needs `npx playwright install chromium` once. |
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
- Every build has an id: a hash of the page and the script as built, written into both in `dist/`. Each request carries the page's id and each answer the server's. A page that reads another id on an answer stops there and asks to be reloaded (`ServerLine` in `src/client/connection.ts`), and the server does nothing to a table for a page of another build (`BuildGate` in `src/server/build.ts`), which it says as `stale`, never as the seat or the table being gone. `npm run dev` and the tests run unstamped, page and server alike. A copy of `dist/web` hosted somewhere else is a page of one build like any other, so it has to be uploaded again after every deploy.
- A saved table carries a schema number (`STATE_SCHEMA`), and `upgradeState` brings one saved by older code forward a step at a time when it is read, then fills in any field added since from `SAVED_DEFAULTS`. A field that is only added needs just its default there; change the shape any other way without adding a step and tables from before the change stop loading.
- A table setting is one entry in the registry in `src/engine/config.ts`: its default, its limits and its field in the settings form all come from that entry. One marked `atCreate: 'only'` is chosen when the table is created and shown closed afterwards.
- Every amount is a whole number of the table's smallest unit, a chip or a cent, so 1.50 is kept as 150 and the rules never see a fraction. `src/engine/amounts.ts` is the one place an amount is written out (`formatAmount`) and the one place a typed amount is read (`parseAmount`); both take the table it belongs to. The Ledger tab gets the amount as a number in dollars for a table that plays cents.
- The ledger has two kinds of line. Buy-ins, cash-outs and the host's stack adjustments are chips paid for, which is what a player's net counts against. A transfer is two lines of kind `transfer` made together, chips off the giver's stack and onto the receiver's, each naming the other player. It moves no money with the bank, so anything that adds up buy-ins, rebuys or what a player paid leaves those lines out: the chips moved are already in the stacks and so in what is cashed out. The Ledger tab writes a transfer's chips in its own Transferred column, beside the other player, and leaves Amount empty, so a player's amounts there still add up to what they paid less what they took away.
- A preset is a name and the settings it was saved with, kept for the whole group rather than a table. Settings are added and dropped over time, so a preset is always read through `fromPreset` (`src/engine/presets.ts`): a setting added since takes the value a new table starts with, one removed is ignored, and a value no longer allowed goes back to the usual with a note saying so. Saving and deleting one are requests of their own (`savePreset`, `deletePreset`), not table commands, since they change no table; the service lets only a host or co-host of the table they are sent from make them.
- Each tab of the Sheet is kept by a store of its own behind an interface named for what it keeps (`TableStore`, `PresetStore`), with the Sheet's implementation in `src/gas` and one in memory for the local server and the tests. `src/gas/sheets.ts` has what they share: the stand-in interfaces for Apps Script, `openTab`, which makes a tab with its headers the first time something is written to it, and `underLock`.
- A command is a handler in `src/engine/commands/`, in the module for who may send it, which is where its permission check is declared: `by: 'host or cohost'` for running the game, `by: 'host alone'` for deciding who runs it.
- What a hand makes players put in before the cards (the blinds, an ante, a straddle) is one list, worked out by `forcedBets` (`src/engine/forcedBets.ts`) before any chips move and posted in order by one piece of code. Each entry says who posts, how much, and whether the chips are a live bet, the player's own stake or dead money in the main pot; the betting starts from the biggest live one.
- What kind of hand is dealt is settled once, by `claimBombPot` (`src/engine/bombPots.ts`), and kept on the hand as `hand.bombPot`; a new kind of hand adds a field there.
- A hand keeps a list of events beside its narration (`src/engine/events.ts`): what was posted, bet, dealt, shown and won, in order, never a face-down card. `replayHand` plays a hand back from them alone.
- A theme is a set of values for the design tokens in `src/client/styles/tokens.css`, plus an entry in `src/client/themes.ts`.
- The page's styles are one file per part of the screen in `src/client/styles/`, joined in the order `order.ts` lists them; a new part adds its file and a line there.
- Each dialog is a file in `src/client/render/dialogs/`, with its line in the menu declared beside it, and `index.ts` lists them in the order the menu shows them.
- What a player sets for themselves, such as sound or the deck, is an entry in `src/client/prefs.ts`. The Preferences dialog is drawn from those entries, with sample cards beside a choice that changes how cards look, and each choice is kept in the player's browser.
- What happens on the page when the table changes, such as the chime when it is your turn, is an effect in `src/client/effects/`, listed in `effects.ts`. Each is handed the table as it was and as it is, with the hand's events and the lines that are new picked out, so none has to keep track of what it has already done.
- Sounds are made in the page with Web Audio from the recipes in `src/client/soundRecipes.ts`, with no audio files. Anything that makes a sound calls `sounds.play('chips')` on the `Sounds` it is handed (`context.sounds` in an effect), which keeps it to the player's switch and volume and spaces out sounds that come at once. Which hand event makes which sound is the table in `src/client/handSounds.ts`.
- Another game is a new engine module behind the same commands and views; another database is a new `TableStore`; another host for the page is a new `Transport` and `Links`.
