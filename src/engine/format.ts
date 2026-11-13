/** A chip count as it is written everywhere, in the play-by-play and on the page: 12,500. */
export function formatChips(amount: number): string {
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
