/* What the tests of the players' records share: who the players are, and the limit the fake holds the Results tab to. */
import type { TestTable } from './helpers.ts';

export const ANN = 'ANN2345';
export const BOB = 'BOB2345';
export const CY = 'CY23456';
export const DEE = 'DEE2345';

/** The longest text the game itself ever writes to a cell of the Results tab, which the fake holds it to: every badge there is, each earned thousands of times. */
export const RESULTS_TEXT_LIMIT = 400;

/** Says who the players of a test table are, in the order of its list; null for one nobody knows. */
export function known(t: TestTable, identities: (string | null)[]): void {
  identities.forEach((identity, player) => {
    t.state.members.find((member) => member.id === t.ids[player])!.identity = identity;
  });
}
