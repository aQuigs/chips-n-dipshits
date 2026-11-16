/**
 * What a refusal calls each thing a form sends by itself, where the form has to find the field a refusal is
 * about: "Your buy-in must be a whole number from 400 to 4,000" begins with the name of its field. Said here
 * once, so the words the table checks with and the words a form looks for cannot drift apart. A table's
 * settings have theirs in their specs (`settingsRefused`).
 */
export const SUBJECTS = {
  buyIn: 'Your buy-in',
  chipsAdded: 'The chips you add',
  stack: 'The stack',
  transferred: 'The amount',
  name: 'Your name',
  presetName: 'The preset name',
} as const;

/** Whether a refusal begins with the name of this thing, and so is about it. */
export function refusalNames(refusal: string, subject: string): boolean {
  return refusal.startsWith(`${subject} `);
}
