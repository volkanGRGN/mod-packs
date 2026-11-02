# Mod packs

Three mods for Claude Code. Each one installs on its own; pick the ones you want. Their interface is in Turkish, and each folder has its own README with the details.

- **ekip-paneli**: a pane beside the chat for a GitHub repo. For each person you pick from the repo's contributors: their last push, open PRs with CI and review status, who a review is waiting on, and branches without a PR. PRs waiting on your review sit at the top. Open it with `/ekip`. Needs the GitHub CLI (`brew install gh`, then `gh auth login`).
- **agent-panel**: a chat with your own agent beside every session, opened from the **✳ Assistant** button above the prompt or with `/ajan`. The agent gets the question with the session's folder, recent messages and touched files. With no agent connected, the session's own Claude answers. `agent-panel/ornek-ajan` is a ready-made agent to copy and edit.
- **token-onizleme**: before you send a long prompt, says how many tokens it is and how much of the context window it will take, then asks whether to send it. `/token` shows how full the context is; `/token <text>` measures a text without sending it.

## Install

From a terminal:

```
claude plugin install ekip-paneli --marketplace volkanGRGN/mod-packs
claude plugin install agent-panel --marketplace volkanGRGN/mod-packs
claude plugin install token-onizleme --marketplace volkanGRGN/mod-packs
```

Inside a Claude Code terminal session, the same line starts with `/plugin install`. Answer `y` to add the marketplace and press Enter for the scope.

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `volkanGRGN/mod-packs`, then **Add plugin**.

Start a new Claude Code session after installing.

## Update

```
claude plugin marketplace update mod-packs
claude plugin update ekip-paneli@mod-packs
```
