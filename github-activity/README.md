# GitHub activity

A pane beside the Claude Code chat that shows where your teammates are in a GitHub repo. For each person you pick:

- their last push: when, to which branch, with which commit message (or their latest commit on the default branch when the repo's recent activity has no push of theirs),
- their open PRs, each with its CI state (✓ / ✗ / running), review decision and who a review is waiting on,
- branches they pushed in the last two weeks that have no PR,
- commits on the default branch in the last seven days, open issues assigned to them, and PRs waiting on their review.

At the top: **PRs waiting on your review**. At the bottom: the repo at a glance (open PRs, open issues, CI on the default branch) and the latest merged PRs. The pane refreshes every 3 minutes and keeps the last known state when GitHub can't be reached.

## Setup

Needs the GitHub CLI: `brew install gh`, then `gh auth login`. The mod only reads; it never writes to the repo.

## Use

- `/activity` opens the pane. If the session's folder is a GitHub repo, that repo is shown.
- `/activity owner/repo` (or a GitHub URL) adds that repo to your list and shows it.
- `/activity summary` writes the same picture into the chat as text.
- `/activity settings` opens the settings; `/activity close` closes the pane.

**⚙ People and repos** in the pane:

- **Repos**: add, remove and switch between the repos you watch. With more than one, they show as tabs at the top.
- **Who do you want to see?**: the repo's contributors, collaborators, PR authors and recent pushers, with their contribution counts. Tap someone to show or hide them; add someone who isn't listed by username. With no picks, the top contributors are shown.

Picks are kept per repo and remembered across sessions. In a session working in one of your repos the pane opens by itself; turn that off with the mod's **Open by itself** setting.
