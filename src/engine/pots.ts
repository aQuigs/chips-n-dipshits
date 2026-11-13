export interface Contribution {
  seat: number;
  /** Every chip this player has put into the hand. */
  committed: number;
  folded: boolean;
}

export interface Pot {
  amount: number;
  /** Seats that can win this pot, in ascending seat order. */
  eligible: number[];
}

/**
 * Splits the chips in the middle into a main pot and side pots.
 * A player can only win, from each opponent, as much as they put in themselves, so every distinct amount
 * committed by a player still in the hand caps one pot. Folded players' chips fill the pots they reach.
 */
export function buildPots(contributions: readonly Contribution[]): Pot[] {
  const live = contributions.filter((c) => !c.folded);
  const caps = [...new Set(live.map((c) => c.committed))].filter((cap) => cap > 0).sort((a, b) => a - b);
  const pots: Pot[] = [];

  let previousCap = 0;
  for (const cap of caps) {
    let amount = 0;
    for (const c of contributions) {
      amount += Math.min(c.committed, cap) - Math.min(c.committed, previousCap);
    }

    const eligible = live.filter((c) => c.committed >= cap).map((c) => c.seat).sort((a, b) => a - b);
    pots.push({ amount, eligible });
    previousCap = cap;
  }

  // Chips a folded player put in above every remaining player's stake still belong to the last pot
  const total = contributions.reduce((sum, c) => sum + c.committed, 0);
  const leftover = total - pots.reduce((sum, pot) => sum + pot.amount, 0);
  const last = pots[pots.length - 1];
  if (leftover > 0 && last) {
    last.amount += leftover;
  }

  return pots;
}

/**
 * Splits an amount evenly between winners. Chips that don't divide go one each to the winners
 * earliest in the given order, which callers pass as clockwise from the button.
 */
export function splitAmount(amount: number, winnersInOrder: readonly number[]): Map<number, number> {
  const shares = new Map<number, number>();
  const share = Math.floor(amount / winnersInOrder.length);
  const oddChips = amount - share * winnersInOrder.length;

  winnersInOrder.forEach((seat, index) => {
    shares.set(seat, share + (index < oddChips ? 1 : 0));
  });

  return shares;
}
