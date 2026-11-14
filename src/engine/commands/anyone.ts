/* What anyone at the table may do, seated or not. */
import { addFeed } from '../seats.ts';
import { LIMITS, text } from '../validate.ts';
import type { Handler } from './handler.ts';

export const chat: Handler<'chat'> = {
  by: 'member',
  run: ({ state, ctx, member, command }) => addFeed(state, ctx.now, 'chat', member.name, text(command.text, 'Your message', LIMITS.chatLength)),
};
