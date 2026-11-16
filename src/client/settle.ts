import { formatAmount } from '../engine/amounts.ts';
import type { TableView } from '../engine/view.ts';

export interface Balance {
  name: string;
  /** Chips won (positive) or lost (negative). */
  net: number;
}

export interface Payment {
  from: string;
  to: string;
  amount: number;
}

/**
 * Who pays whom so that everyone ends up square. The biggest loser pays the biggest winner first,
 * which keeps the number of payments small: never more than one fewer than the number of people.
 */
export function settleUp(balances: readonly Balance[]): Payment[] {
  const owing = balances.filter((b) => b.net < 0).map((b) => ({ name: b.name, left: -b.net }));
  const owed = balances.filter((b) => b.net > 0).map((b) => ({ name: b.name, left: b.net }));
  const payments: Payment[] = [];

  owing.sort((a, b) => b.left - a.left);
  owed.sort((a, b) => b.left - a.left);

  let payer = 0;
  let receiver = 0;

  while (payer < owing.length && receiver < owed.length) {
    const amount = Math.min(owing[payer]!.left, owed[receiver]!.left);

    payments.push({ from: owing[payer]!.name, to: owed[receiver]!.name, amount });
    owing[payer]!.left -= amount;
    owed[receiver]!.left -= amount;

    if (owing[payer]!.left === 0) {
      payer += 1;
    }

    if (owed[receiver]!.left === 0) {
      receiver += 1;
    }
  }

  return payments;
}

/**
 * Who pays whom to square the table's ledger as it stands. The one list: the Ledger shows it, its
 * text is copied from it and the recap of a night quotes the viewer's part of it, so no two places
 * can say different sums of real money.
 */
export function settlement(view: TableView): Payment[] {
  return settleUp([...view.ledger].sort((a, b) => b.net - a.net));
}

/** The list as text for the group chat: the table's name, then a payment a line in the words of the Ledger's list. */
export function settleUpText(view: TableView): string {
  return [`${view.config.name}: to settle up`, ...settlement(view).map((payment) => `${payment.from} pays ${payment.to} ${formatAmount(payment.amount, view.config)}`)].join('\n');
}

/** The payments the viewer is part of, said to them; none for someone who is square or never bought in. */
export function ownPayments(view: TableView): string[] {
  const me = view.ledger.find((row) => row.playerId === view.you.id)?.name;

  return settlement(view)
    .filter((payment) => payment.from === me || payment.to === me)
    .map((payment) => {
      const amount = formatAmount(payment.amount, view.config);

      return payment.from === me ? `You pay ${payment.to} ${amount}` : `${payment.from} pays you ${amount}`;
    });
}
