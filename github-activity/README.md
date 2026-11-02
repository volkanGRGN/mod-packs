# GitHub activity

A pane beside the Claude Code chat that shows what needs doing in a GitHub repo and where your teammates are.

**To do** sits at the top: the open PRs of the people you pick, grouped by what they need:

- **Waiting on your review**
- **Failing checks**, with the names of the checks that failed
- **Tests to do**: unticked boxes under a test plan in a PR's description ("- [ ] Test on Safari"); template boxes elsewhere are left out
- **Changes requested**
- **Ready to merge**: approved, with no failing or running checks
- **Waiting for review**, with who a review is waiting on
- **Drafts**

Each group shows its first three rows; the rest open with a press. Press a row to see what the PR is about: the first lines of its description, which branch it merges into, how many lines and files it changes, its checks and review, and the tests left. Every PR number is a link to GitHub.

**People** comes next. For each person you pick: their last push (when, which branch, which commit message; or their latest commit on the default branch when the repo's recent activity has no push of theirs), commits on the default branch in the last seven days, open PRs, issues assigned to them, PRs waiting on their review, and branches they pushed in the last two weeks that have no PR.

At the bottom: the repo at a glance (open PRs, open issues, CI on the default branch) and the latest merged PRs. The pane refreshes every 3 minutes and keeps the last known state when GitHub can't be reached.

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
