import type { Command, HandRecord, TableConfig } from '../../engine/types.ts';
import type { TableView } from '../../engine/view.ts';
import { settleUp } from '../settle.ts';
import { themeById } from '../themes.ts';
import { chips, h, signedChips } from '../ui.ts';
import { createThemePicker } from './themePicker.ts';

export type Dialog =
  | { kind: 'menu' }
  | { kind: 'sit'; seat: number }
  | { kind: 'rebuy' }
  | { kind: 'ledger' }
  | { kind: 'history' }
  | { kind: 'players' }
  | { kind: 'settings' }
  | { kind: 'invite' }
  | { kind: 'theme' }
  | { kind: 'setStack'; playerId: string }
  | { kind: 'confirm'; title: string; body: string; action: string; command: Command };

/** Dialogs that show live table data, and so are redrawn when it changes. The rest hold a form someone may be filling in. */
const LIVE_DIALOGS = new Set<Dialog['kind']>(['menu', 'ledger', 'players']);

export function isLive(dialog: Dialog): boolean {
  return LIVE_DIALOGS.has(dialog.kind);
}

export interface DialogHandlers {
  send(command: Command): void;
  open(dialog: Dialog): void;
  close(): void;
  copy(text: string): Promise<boolean>;
  loadHistory(): Promise<HandRecord[]>;
  tableLink(): string;
  memberLink(): string;
  theme(): string;
  setTheme(id: string): void;
  soundOn(): boolean;
  setSound(on: boolean): void;
  toLobby(): void;
}

function frame(title: string, handlers: DialogHandlers, ...body: (HTMLElement | null)[]): HTMLElement {
  return h(
    'div.dialog',
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', null, h('h2', null, title), h('button.icon', { type: 'button', 'aria-label': 'Close', 'data-action': 'close', onclick: handlers.close }, '✕')),
    h('div.dialog-body', null, body),
  );
}

function numberField(id: string, label: string, value: number, min: number, max?: number, hint?: string): HTMLElement {
  return h(
    'label.field',
    { for: id },
    h('span', null, label),
    h('input', { type: 'number', id, name: id, value, min, max, step: 1, inputmode: 'numeric', required: true }),
    hint ? h('small', null, hint) : null,
  );
}

function checkField(id: string, label: string, checked: boolean): HTMLElement {
  return h('label.check', { for: id }, h('input', { type: 'checkbox', id, name: id, checked }), h('span', null, label));
}

function valueOf(form: HTMLFormElement, name: string): number {
  return Number((form.elements.namedItem(name) as HTMLInputElement).value);
}

function menu(view: TableView, handlers: DialogHandlers): HTMLElement {
  const item = (label: string, action: string, onclick: () => void, note?: string) =>
    h('button.menu-item', { type: 'button', 'data-action': action, onclick }, label, note ? h('small', null, note) : null);

  const requests = view.requests.length;
  const seated = view.you.seat !== null;

  return frame(
    view.config.name,
    handlers,
    h(
      'div.menu',
      null,
      item('Invite players', 'invite', () => handlers.open({ kind: 'invite' })),
      item('Ledger', 'ledger', () => handlers.open({ kind: 'ledger' }), 'Who is up and who owes whom'),
      item('Hand history', 'history', () => handlers.open({ kind: 'history' })),
      view.you.isHost ? item('Players', 'players', () => handlers.open({ kind: 'players' }), requests > 0 ? `${requests} waiting for you` : 'Approve, adjust stacks, remove') : null,
      view.you.isHost ? item('Table settings', 'settings', () => handlers.open({ kind: 'settings' }), `Blinds ${chips(view.config.smallBlind)}/${chips(view.config.bigBlind)}`) : null,
      view.you.isHost && view.running
        ? item('Pause the game', 'pause', () => {
            handlers.send({ type: 'pause' });
            handlers.close();
          }, 'No new hands until you resume')
        : null,
      view.you.isHost && !view.running
        ? item('Start the game', 'start', () => {
            handlers.send({ type: 'start' });
            handlers.close();
          })
        : null,
      item('Theme', 'theme', () => handlers.open({ kind: 'theme' }), themeById(handlers.theme()).name),
      item(handlers.soundOn() ? 'Turn sound off' : 'Turn sound on', 'sound', () => {
        handlers.setSound(!handlers.soundOn());
        handlers.open({ kind: 'menu' });
      }),
      seated
        ? item('Stand up', 'stand', () =>
            handlers.open({
              kind: 'confirm',
              title: 'Stand up?',
              body: 'You leave your seat and your chips are cashed out in the ledger. If you are in a hand, it is folded.',
              action: 'Stand up',
              command: { type: 'standUp' },
            }),
          )
        : null,
      item('Back to the lobby', 'lobby', handlers.toLobby, 'Your seat stays yours'),
    ),
  );
}

function sit(view: TableView, seat: number, handlers: DialogHandlers): HTMLElement {
  const { minBuyIn, maxBuyIn, bigBlind } = view.config;
  const suggested = Math.min(maxBuyIn, Math.max(minBuyIn, bigBlind * 100));

  return frame(
    `Take seat ${seat + 1}`,
    handlers,
    h(
      'form',
      {
        onsubmit: (event: Event) => {
          event.preventDefault();
          handlers.send({ type: 'requestSeat', seat, buyIn: valueOf(event.target as HTMLFormElement, 'buy-in') });
          handlers.close();
        },
      },
      numberField('buy-in', 'Buy-in', suggested, minBuyIn, maxBuyIn, `From ${chips(minBuyIn)} to ${chips(maxBuyIn)} chips`),
      view.you.isHost ? null : h('p.note', null, 'The host approves seats, so you sit down once they say yes.'),
      h('button.btn.primary', { type: 'submit', 'data-action': 'confirm-sit' }, 'Sit down'),
    ),
  );
}

function rebuy(view: TableView, handlers: DialogHandlers): HTMLElement {
  const seat = view.seats[view.you.seat ?? -1];
  const room = seat ? view.config.maxBuyIn - seat.stack - seat.pendingAdd : 0;

  return frame(
    'Add chips',
    handlers,
    h(
      'form',
      {
        onsubmit: (event: Event) => {
          event.preventDefault();
          handlers.send({ type: 'requestRebuy', amount: valueOf(event.target as HTMLFormElement, 'rebuy-amount') });
          handlers.close();
        },
      },
      numberField('rebuy-amount', 'Chips to add', room, 1, room, `Up to ${chips(room)}, which brings you to the table maximum`),
      h('p.note', null, view.you.isHost ? 'Chips arrive when the current hand is over.' : 'The host approves it, and the chips arrive when the current hand is over.'),
      h('button.btn.primary', { type: 'submit', 'data-action': 'confirm-rebuy' }, 'Add chips'),
    ),
  );
}

function ledger(view: TableView, handlers: DialogHandlers): HTMLElement {
  const rows = [...view.ledger].sort((a, b) => b.net - a.net);
  const payments = settleUp(rows);

  const table = h(
    'table.ledger',
    null,
    h('thead', null, h('tr', null, h('th', null, 'Player'), h('th', null, 'Bought'), h('th', null, 'Cashed out'), h('th', null, 'On table'), h('th', null, 'Net'))),
    h(
      'tbody',
      null,
      rows.map((row) =>
        h(
          'tr',
          null,
          h('td', null, row.name),
          h('td', null, chips(row.buyIn)),
          h('td', null, chips(row.cashOut)),
          h('td', null, chips(row.stack)),
          h('td', { class: row.net > 0 ? 'up' : row.net < 0 ? 'down' : '' }, signedChips(row.net)),
        ),
      ),
    ),
  );

  return frame(
    'Ledger',
    handlers,
    rows.length === 0 ? h('p.note', null, 'Nobody has bought in yet.') : h('div.scroll-x', null, table),
    payments.length > 0
      ? h(
          'div.settle',
          null,
          h('h3', null, 'To settle up right now'),
          h('ul', null, payments.map((p) => h('li', null, h('b', null, p.from), ' pays ', h('b', null, p.to), ` ${chips(p.amount)}`))),
          h('p.note', null, 'Counts chips still on the table as if everyone cashed out now.'),
        )
      : null,
  );
}

function history(handlers: DialogHandlers): HTMLElement {
  const body = h('div.history', null, h('p.note', null, 'Loading…'));

  handlers.loadHistory().then(
    (hands) => {
      body.replaceChildren(
        ...(hands.length === 0
          ? [h('p.note', null, 'No finished hands yet.')]
          : [...hands].reverse().map((hand) => {
              const winners = hand.result.winnings.map((win) => `${hand.players.find((p) => p.seat === win.seat)?.name ?? '?'} +${chips(win.amount)}`);

              return h('details', null, h('summary', null, `Hand #${hand.number}`, h('small', null, winners.join(', '))), h('pre', null, hand.summary));
            })),
      );
    },
    () => body.replaceChildren(h('p.note', null, 'Could not load the hand history. Close this and try again.')),
  );

  return frame('Hand history', handlers, body);
}

function players(view: TableView, handlers: DialogHandlers): HTMLElement {
  const requests = view.requests.map((request) =>
    h(
      'li',
      null,
      h('span', null, h('b', null, request.name), request.kind === 'seat' ? ` wants seat ${request.seat + 1} with ${chips(request.amount)}` : ` wants to add ${chips(request.amount)}`),
      h(
        'span.row-actions',
        null,
        h('button.btn.small.primary', { type: 'button', 'data-action': 'approve', onclick: () => handlers.send({ type: 'approve', playerId: request.playerId }) }, 'Approve'),
        h('button.btn.small', { type: 'button', 'data-action': 'deny', onclick: () => handlers.send({ type: 'deny', playerId: request.playerId }) }, 'Deny'),
      ),
    ),
  );

  const seatedIds = new Set(view.seats.flatMap((seat) => (seat ? [seat.playerId] : [])));
  const makeHost = (playerId: string, name: string) =>
    h(
      'button.btn.small',
      {
        type: 'button',
        onclick: () =>
          handlers.open({
            kind: 'confirm',
            title: `Make ${name} the host?`,
            body: 'They take over approving players and changing settings, and you become a regular player.',
            action: 'Hand over',
            command: { type: 'transferHost', playerId },
          }),
      },
      'Make host',
    );

  const seated = view.seats.flatMap((seat) =>
    seat
      ? [
          h(
            'li',
            null,
            h('span', null, h('b', null, seat.name), ` · seat ${seat.seat + 1} · ${chips(seat.stack)}`),
            h(
              'span.row-actions',
              null,
              h('button.btn.small', { type: 'button', onclick: () => handlers.open({ kind: 'setStack', playerId: seat.playerId }) }, 'Set stack'),
              seat.playerId === view.you.id ? null : makeHost(seat.playerId, seat.name),
              h(
                'button.btn.small',
                {
                  type: 'button',
                  onclick: () =>
                    handlers.open({
                      kind: 'confirm',
                      title: `Remove ${seat.name}?`,
                      body: 'They lose their seat and their chips are cashed out in the ledger. They can ask for a seat again.',
                      action: 'Remove',
                      command: { type: 'kick', playerId: seat.playerId },
                    }),
                },
                'Remove',
              ),
            ),
          ),
        ]
      : [],
  );

  const watching = view.members.filter((member) => !seatedIds.has(member.id) && member.id !== view.you.id);

  return frame(
    'Players',
    handlers,
    requests.length > 0 ? h('section', null, h('h3', null, 'Waiting for you'), h('ul.rows', null, requests)) : null,
    h('section', null, h('h3', null, 'Seated'), seated.length > 0 ? h('ul.rows', null, seated) : h('p.note', null, 'Nobody is seated yet.')),
    watching.length > 0
      ? h('section', null, h('h3', null, 'Watching'), h('ul.rows', null, watching.map((member) => h('li', null, h('span', null, h('b', null, member.name)), h('span.row-actions', null, makeHost(member.id, member.name))))))
      : null,
  );
}

function settings(view: TableView, handlers: DialogHandlers): HTMLElement {
  const config = view.config;

  return frame(
    'Table settings',
    handlers,
    h(
      'form',
      {
        onsubmit: (event: Event) => {
          event.preventDefault();
          const form = event.target as HTMLFormElement;
          const checked = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).checked;

          const next: TableConfig = {
            name: (form.elements.namedItem('table-name') as HTMLInputElement).value,
            smallBlind: valueOf(form, 'small-blind'),
            bigBlind: valueOf(form, 'big-blind'),
            minBuyIn: valueOf(form, 'min-buy-in'),
            maxBuyIn: valueOf(form, 'max-buy-in'),
            actionSeconds: valueOf(form, 'action-seconds'),
            allowStraddle: checked('allow-straddle'),
            allowRunItTwice: checked('allow-rit'),
            sevenDeuceBounty: valueOf(form, 'bounty'),
          };

          handlers.send({ type: 'updateConfig', config: next });
          handlers.close();
        },
      },
      h('label.field', { for: 'table-name' }, h('span', null, 'Table name'), h('input', { type: 'text', id: 'table-name', name: 'table-name', value: config.name, maxlength: 40, required: true })),
      h('div.pair', null, numberField('small-blind', 'Small blind', config.smallBlind, 1), numberField('big-blind', 'Big blind', config.bigBlind, 1)),
      h('div.pair', null, numberField('min-buy-in', 'Minimum buy-in', config.minBuyIn, 1), numberField('max-buy-in', 'Maximum buy-in', config.maxBuyIn, 1)),
      numberField('action-seconds', 'Seconds to act', config.actionSeconds, 0, 300, '0 turns the clock off'),
      numberField('bounty', 'Seven-deuce bounty', config.sevenDeuceBounty, 0, undefined, 'Paid by everyone dealt in to whoever wins with 7-2. 0 turns it off'),
      checkField('allow-straddle', 'Allow straddles', config.allowStraddle),
      checkField('allow-rit', 'Offer run it twice when everyone is all in', config.allowRunItTwice),
      h('p.note', null, 'New blinds apply from the next hand.'),
      h('button.btn.primary', { type: 'submit', 'data-action': 'save-settings' }, 'Save'),
    ),
  );
}

function copyRow(id: string, label: string, value: string, handlers: DialogHandlers, warning?: string): HTMLElement {
  const input = h('input', { type: 'text', id, readonly: true, value, onfocus: (event: Event) => (event.target as HTMLInputElement).select() });
  const button = h('button.btn.small.primary', { type: 'button' }, 'Copy');

  button.addEventListener('click', async () => {
    const copied = await handlers.copy(value);

    if (!copied) {
      input.focus();
      input.select();
    }

    button.textContent = copied ? 'Copied' : 'Press Ctrl+C';
  });

  return h('div.field', null, h('label', { for: id }, label), h('div.copy', null, input, button), warning ? h('small', null, warning) : null);
}

function invite(view: TableView, handlers: DialogHandlers): HTMLElement {
  return frame(
    'Invite players',
    handlers,
    copyRow('table-link', 'Send this link to your friends', handlers.tableLink(), handlers),
    h('p.note', null, `Or tell them the table code: `, h('b.code', null, view.id)),
    copyRow('member-link', 'Your own link, to carry on from another phone or computer', handlers.memberLink(), handlers, 'Keep this one to yourself: whoever opens it plays as you.'),
  );
}

function theme(handlers: DialogHandlers): HTMLElement {
  return frame(
    'Theme',
    handlers,
    createThemePicker(handlers.theme(), handlers.setTheme).element,
    h('p.note', null, 'Changes how the table looks for you, on this device. Everyone picks their own.'),
  );
}

function setStack(view: TableView, playerId: string, handlers: DialogHandlers): HTMLElement {
  const seat = view.seats.find((s) => s?.playerId === playerId);

  return frame(
    `Set ${seat?.name ?? 'player'}'s stack`,
    handlers,
    h(
      'form',
      {
        onsubmit: (event: Event) => {
          event.preventDefault();
          handlers.send({ type: 'setStack', playerId, stack: valueOf(event.target as HTMLFormElement, 'new-stack') });
          handlers.open({ kind: 'players' });
        },
      },
      numberField('new-stack', 'Chips', seat?.stack ?? 0, 0, undefined, 'The ledger records the difference as an adjustment. Only works between hands.'),
      h('button.btn.primary', { type: 'submit' }, 'Set stack'),
    ),
  );
}

function confirm(dialog: Extract<Dialog, { kind: 'confirm' }>, handlers: DialogHandlers): HTMLElement {
  return frame(
    dialog.title,
    handlers,
    h('p', null, dialog.body),
    h(
      'div.buttons',
      null,
      h('button.btn', { type: 'button', onclick: handlers.close }, 'Cancel'),
      h(
        'button.btn.primary',
        {
          type: 'button',
          'data-action': 'confirm',
          onclick: () => {
            handlers.send(dialog.command);
            handlers.close();
          },
        },
        dialog.action,
      ),
    ),
  );
}

export function dialogEl(dialog: Dialog, view: TableView, handlers: DialogHandlers): HTMLElement {
  switch (dialog.kind) {
    case 'menu':
      return menu(view, handlers);
    case 'sit':
      return sit(view, dialog.seat, handlers);
    case 'rebuy':
      return rebuy(view, handlers);
    case 'ledger':
      return ledger(view, handlers);
    case 'history':
      return history(handlers);
    case 'players':
      return players(view, handlers);
    case 'settings':
      return settings(view, handlers);
    case 'invite':
      return invite(view, handlers);
    case 'theme':
      return theme(handlers);
    case 'setStack':
      return setStack(view, dialog.playerId, handlers);
    case 'confirm':
      return confirm(dialog, handlers);
  }
}
