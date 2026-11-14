/*
 * How many times the rest of an all-in hand is run. Each player still in picks a number, up to what the
 * table allows, and the fewest picked is how many. This is the one place that number is worked out;
 * from there on everything goes by the number of boards the hand is played on.
 */

/** The most times a table may have the rest run. */
export const MOST_RUNS = 3;

/** A player still in, and what they picked: null until they do. */
export interface Picker {
  name: string;
  ritVote: number | null;
}

/** How the picking ended for players who never picked: one of them left, or the clock ran out. */
export type Unpicked = { why: 'left'; name: string } | { why: 'time' };

/**
 * How many times the rest is run, from each player's pick (null for one who has yet to pick) and the
 * table's `cap`, or null while that is still open: until everyone has picked, unless someone picked
 * once, which nobody can go under. A player who never picks has picked once.
 */
export function timesToRun(picks: readonly (number | null)[], cap: number): number | null {
  const picked = picks.filter((pick): pick is number => pick !== null);
  const fewest = Math.min(cap, ...picked);

  return fewest === 1 || picked.length === picks.length ? fewest : null;
}

const TIMES = ['once', 'twice', 'three times'];

/** "once", "twice", "three times". */
export function timesText(count: number): string {
  return TIMES[count - 1] ?? `${count} times`;
}

function inSentence(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
}

/**
 * The play-by-play's line for how the picking came out: what each player still in picked, in seat
 * order, who never did, and how many times the rest is run. "Dana picked three times, Sam once: running it once".
 */
export function voteStory(players: readonly Picker[], runs: number, unpicked?: Unpicked): string {
  const picked = players.filter((player) => player.ritVote !== null);
  const parts =
    picked.length === players.length && picked.every((player) => player.ritVote === picked[0]!.ritVote)
      ? ['Everyone agreed']
      : picked.map((player, nth) => `${player.name}${nth === 0 ? ' picked' : ''} ${timesText(player.ritVote!)}`);

  if (unpicked?.why === 'left') {
    parts.push(`${unpicked.name} left without picking`);
  } else if (unpicked?.why === 'time') {
    parts.push(`${inSentence(players.filter((player) => player.ritVote === null).map((player) => player.name))} didn't pick in time`);
  }

  return `${parts.join(', ')}: running it ${timesText(runs)}`;
}
