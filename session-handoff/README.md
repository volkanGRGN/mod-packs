# Session handoff

When the context fills up, Claude gets slower, forgets early details and eventually compacts. This mod stops before that and asks:

> The context is 72% full. Move to a fresh session with a handoff note?

**Move to a fresh session**: the session's own Claude writes a handoff note (goal, what's done with file paths, current state, numbered next steps, open questions, useful paths and commands), the note is saved under `~/.claude/handoffs/`, the conversation is cleared with `/clear`, and the fresh one starts from the note. **Keep going here**: it asks again once the context has grown another 10 points.

It asks at two moments:

- **When you send a prompt** past the threshold. On a move, your prompt goes along: the fresh session starts with the note and then your message.
- **Mid-turn**, before Claude's next tool call. On a move, Claude stops there and ends its turn; the move happens right after.

`/handoff` moves now, whatever the fill. `/handoff <message>` moves and sends that message after the note.

The threshold is 70% by default and can be changed in the mod's settings. Subagents are left alone.

If the note can't be written, nothing is cleared and your prompt goes back into the prompt box. Where `/clear` can't run, the note is still saved and handed over: in the prompt box, or on your clipboard to paste into a new session.
