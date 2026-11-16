# Effort Optimizer

A Claude Code mod. Before Claude starts on a prompt, a quick Sonnet 5.5 check reads the prompt and picks the effort level it needs: Low, Medium, High, Extra high or Max. It asks Ben's four questions in this order and stops at the first yes:

1. **Back and forth, or a simple task?** Low. Brainstorming, quick rewrites, short summaries, simple questions.
2. **Would a hidden mistake cost money, a client, trust or a wrong decision?** High. Checking numbers, contract review, open-ended analysis, fact-checking.
3. **A long, hard and critical job you hand off and walk away from?** Extra high. A full research report, a 50 page agreement, a one-shot pitch deck. Max only when the prompt asks for the deepest work and says it is critical.
4. **Everything else** is Medium. Everyday writing, meeting summaries, standard reports, quick research before a call.

Approvals like "yes" or "go on" keep the level as it is.

## What you see

- **Suggest mode (the default).** When the pick is different from your current level, Claude waits and a question pops up: "Switch to Low", "Switch, and auto-adjust from now", or "Keep High". When the pick is the same as your level, nothing pops up.
- **Auto mode.** The mod sets the level for every prompt by itself, the first one too. No pop-up.
- After a switch, a line above the prompt says "Effort set to Low (was High)". Click **ⓘ Learn more** for the details.
- While the mod holds a level, an orange **Effort Low** label shows at the bottom of the chat.

## Important: the effort menu does not move

The mod sets the level on each message before it leaves your computer. Claude really works at that level.

The effort menu next to the model name keeps showing your own setting. The Claude app does not let a chat change its own menu. So read the orange label, or type `/effort-optimizer` to see the real level. If you move the menu yourself, the mod follows the menu again.

## Commands

- `/effort-optimizer` shows the mode and the level the chat really runs at.
- `/effort-optimizer auto` turns on auto mode.
- `/effort-optimizer suggest` goes back to the pop-up.
- `/effort-optimizer off` and `/effort-optimizer on` turn the mod off and on.

## Install

```
claude plugin install effort-optimizer --marketplace volkanGRGN/mod-packs
```

Start a new Claude Code session after installing. Needs Claude Code 2.1.287 or newer in the terminal, or 2.1.286 or newer in the desktop Code tab.

## Cost

Each check is one short Sonnet 5.5 call at low effort. Slash commands are never checked.

Made by Ben AI (https://www.benai.co).
