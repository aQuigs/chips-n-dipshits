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
