/** CI's latest state: all passed, one failed, still running, none. */
export type Ci = 'passed' | 'failed' | 'running' | 'none'

/** The review decision: approved, changes requested, review required, none. */
export type Review = 'approved' | 'changes' | 'required' | ''

export type Pr = {
  number: number
  title: string
  author: string
  branch: string
  /** The branch it merges into. */
  base: string
  additions: number
  deletions: number
  changedFiles: number
  /** The first lines of its description, headings, boxes and markup left out. */
  about: string[]
  isDraft: boolean
  ci: Ci
  /** The names of the checks that failed. */
  failedChecks: string[]
  /** Unticked test items in the description ("- [ ] Test on Safari" under a test plan). */
  testsToDo: string[]
  review: Review
  /** People and teams a review is requested from. */
  reviewers: string[]
  /** The latest review of each person who reviewed: approved, asked for changes, commented. */
  reviewedBy: { login: string; state: string }[]
  /** Who GitHub suggests as reviewers, from who wrote the lines it changes; never its author. */
  suggested: string[]
  /** Last update, in seconds. */
  updatedAt: number
  url: string
}

/**
 * A person's latest push: which branch, when, with which message. When the
 * repo's recent activity holds none, their latest commit on the default branch
 * stands in (`isCommit`), dated by the commit itself.
 */
export type Push = { at: number; branch: string; message: string; isCommit?: boolean }

export type Person = {
  login: string
  /** The name on their GitHub profile, else the login. */
  name: string
  lastPush?: Push
  prs: Pr[]
  /** Other people's PRs that request this person's review. */
  reviewing: Pr[]
  /** Branches they pushed in the last two weeks that have no PR. */
  branches: string[]
  /** Commits on the default branch in the last seven days. */
  weekCommits: number
  /** Open issues assigned to them. */
  issues: number
}

/** Someone who can be picked in the people list, and where we found them. */
export type Candidate = { login: string; contributions: number; source: string }

export type Repo = {
  name: string
  defaultBranch: string
  openPrs: number
  openIssues: number
  ci: Ci
}

export type Summary = {
  repo: Repo
  /** The GitHub login of whoever has the pane open. */
  me: string
  people: Person[]
  /** Open PRs that request your review. */
  waitingOnMe: Pr[]
  candidates: Candidate[]
  /** Latest merged PRs, newest first. */
  merged: { number: number; title: string; author: string; at: number }[]
  /** Nobody picked yet: the top contributors are shown. */
  isDefaultPeople: boolean
  /** Time zone offset in minutes: "today" and clock times follow it. */
  utcOffset: number
}

export type Pane = {
  summary?: Summary
  lastSuccess?: number
  lastAttempt?: number
  isOffline: boolean
  isLoading: boolean
  error?: string
}

/** Kept across sessions: the repos watched, and who is shown in each. */
export type ActivitySettings = {
  repos: string[]
  people: Record<string, string[]>
}

declare module 'claude-code' {
  interface PluginState {
    'github-activity': {
      pane: Shaped<Pane>
      settings: Shaped<ActivitySettings>
      /** The repo shown in this session, "owner/name". */
      selected: string
      /** The GitHub repo of this session's folder; empty when there is none. */
      sessionRepo: string
      /** The settings are shown instead of the activity. */
      isSettings: boolean
      /** A short note on the last thing done in the settings. */
      notice: string
      /** People whose PRs are unfolded, by login. */
      expanded: Shaped<string[]>
    }
  }
}
