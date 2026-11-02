# Session handoff

When the context fills up, Claude gets slower, forgets early details and eventually compacts. This mod stops before that and asks:

> The context is 72% full (≈720k tokens), and every message re-reads all of it. Each message here takes about 3% of your 5-hour limit; 36% is used, resets in 2 h 10 min. Move to a fresh session with a handoff note?

The usage part is measured in the session: how much the 5-hour limit has grown over the turns since it was first read. Until it has grown a whole point, the question says only how much of the limit is used. Other sessions running at the same time count in too, so take it as an estimate.

**Move to a fresh session**: the session's own Claude writes a handoff note (goal, what's done with file paths, current state, numbered next steps, open questions, useful paths and commands), the note is saved under `~/.claude/handoffs/`, the conversation is cleared with `/clear`, and the fresh one starts from the note. **Keep going here**: it asks again once the context has grown another 10 points.

It asks at two moments, and never in the middle of a tool Claude is running:

- **Right after Claude finishes a turn** past the threshold. A turn you stopped is left alone.
- **When you send a prompt** past the threshold. On a move, your prompt goes along: the fresh session starts with the note and then your message.

`/handoff` moves now, whatever the fill. `/handoff <message>` moves and sends that message after the note.

The threshold is 70% by default and can be changed in the mod's settings.

If the note can't be written, nothing is cleared and your prompt goes back into the prompt box. Where `/clear` can't run, the note is still saved and handed over: in the prompt box, or on your clipboard to paste into a new session.
