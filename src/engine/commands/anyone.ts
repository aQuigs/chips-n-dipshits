/* What anyone at the table may do, seated or not. */
import { mentionsIn, withNudgeLimit } from '../mentions.ts';
import { addFeed } from '../seats.ts';
import { LIMITS, text } from '../validate.ts';
import type { Handler } from './handler.ts';

export const chat: Handler<'chat'> = {
  by: 'member',
  run: ({ state, ctx, member, command }) => {
    const said = text(command.text, 'Your message', LIMITS.chatLength);
    const mentions = withNudgeLimit(mentionsIn(said, state.members, member.id), state.feed, member.id, ctx.now);

    addFeed(state, ctx.now, 'chat', member.name, said, mentions.length > 0 ? { by: member.id, mentions } : { by: member.id });
  },
};
