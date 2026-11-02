# Token preview

Before you send a long prompt, says how many tokens it is and how much of the context window (what Claude can keep in mind in one conversation) it will take, then asks:

> This prompt is ≈12,400 tokens and takes 6.2% of the context window. It's 38% full now, ≈44% after sending. Each message here takes about 2% of your 5-hour limit; 34% is used, resets in 45 min. Send it?

The usage part is measured in the session: how much the 5-hour limit has grown over the turns since it was first read. Until it has grown a whole point, it says only how much of the limit is used.

**Send** sends it. **Cancel**, or closing the question, keeps it from going: the text goes back into the prompt box, or onto your clipboard when it can't (paste it back with ⌘V). If the context would pass 85%, it also says the conversation may get compacted.

Short prompts are never asked about. The threshold is 2,000 tokens by default and can be changed in the mod's settings. With **Ask before sending** off, it doesn't ask and only adds a note to the chat.

## Commands

- `/token` says how full the context is right now, and how much of the 5-hour limit is used.
- `/token <text>` measures a pasted text without sending it.

## In a terminal

When you use Claude Code in a terminal, a live readout shows above the prompt box while you type or paste a long prompt: `≈3,200 tokens · 1.6% of context · ≈40% after sending`. The desktop app's prompt box isn't open to mods, so there the estimate comes when you send.

## How accurate it is

The count is a local estimate; nothing is sent anywhere. It was tuned against Claude's own count: on Turkish, English and code it stays within 10%, mostly around 5%. Each attached image counts as about 1,600 tokens.
