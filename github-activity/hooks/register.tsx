import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ActivitySettings, Candidate, Ci, Pane, Person, Pr, Push, Review, Summary } from '../types'

// GitHub activity: a pane beside the chat showing where the people you pick
// are in a GitHub repo: their last push, open PRs with CI and review status,
// who a review is waiting on, branches without a PR, weekly commits and
// assigned issues. Everything is read with `gh`; nothing is written to the
// repo. Repos and people are picked in the pane's settings and remembered
// across sessions.
const PANE = 'github-activity'
const TITLE = 'GitHub activity'
const REFRESH_MS = 3 * 60 * 1000
/** How many top contributors are shown while nobody is picked. */
const DEFAULT_PEOPLE = 6
/** The most people the picker lists. */
const CANDIDATE_LIMIT = 40
/** How recent a push must be for its branch to count as one without a PR. */
const BRANCH_DAYS = 14
/** How many merged PRs the pane lists. */
const MERGED_SHOWN = 3

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const PUSHES = ['push', 'force_push', 'branch_creation', 'pr_merge', 'merge_queue_merge']
const QUIET_ENV = { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' }

const pane = atom(
  { plugin: 'github-activity', key: 'pane' } as const,
  { isOffline: false, isLoading: false } as Pane,
  { shape: 'pane-1' },
)
const settings = atom(
  { plugin: 'github-activity', key: 'settings' } as const,
  { repos: [], people: {} } as ActivitySettings,
  { shape: 'settings-1' },
)
const selected = atom({ plugin: 'github-activity', key: 'selected' } as const, '')
const sessionRepo = atom({ plugin: 'github-activity', key: 'sessionRepo' } as const, '')
const isSettings = atom({ plugin: 'github-activity', key: 'isSettings' } as const, false)
const notice = atom({ plugin: 'github-activity', key: 'notice' } as const, '')

type Activity = { at: string; login: string; kind: string; ref: string; after: string }
type GhCheck = { status?: string; conclusion?: string; state?: string }
type GhPr = {
  number: number
  title: string
  author?: { login?: string }
  headRefName: string
  isDraft: boolean
  reviewDecision?: string
  reviewRequests?: { login?: string; name?: string; slug?: string }[]
  statusCheckRollup?: GhCheck[]
  updatedAt: string
  url: string
}

const run = async ($: EngineInterface, argv: string[], timeoutMs = 20000) => {
  const [program = '', ...args] = argv
  const candidates = program === 'gh' ? ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'] : [program]
  let failure: unknown
  for (const candidate of candidates) {
    try {
      return await $.process.run([candidate, ...args], { timeoutMs, env: QUIET_ENV, cwd: '/' })
    } catch (err) {
      failure = err
    }
  }
  throw failure ?? new Error(`${program} did not run`)
}

/** Reads `gh` output as JSON; on failure, throws with gh's own words. */
const ghJson = async <T,>($: EngineInterface, args: string[]): Promise<T> => {
  const r = await run($, ['gh', ...args])
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `gh exited with ${r.exitCode}`)

  return JSON.parse(r.stdout || 'null') as T
}

const seconds = (iso: string | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : 0)

/** "owner/name" from a GitHub URL, a git@ address or a plain "owner/name". */
const repoName = (text: string) => {
  const clean = text.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  const url = clean.match(/github\.com[:/]([^/\s]+)\/([^/\s]+)/)
  if (url) return `${url[1]}/${url[2]}`
  return /^[\w.-]+\/[\w.-]+$/.test(clean) ? clean : ''
}

const ciState = (checks: GhCheck[] | undefined): Ci => {
  if (!checks?.length) return 'none'
  const results = checks.map(c =>
    (c.conclusion || c.state || (c.status && c.status !== 'COMPLETED' ? 'PENDING' : 'SUCCESS')).toUpperCase(),
  )
  const failed = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
  if (results.some(s => failed.includes(s))) return 'failed'
  if (results.some(s => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING'].includes(s))) return 'running'

  return 'passed'
}

const review = (decision: string | undefined): Review => {
  if (decision === 'APPROVED') return 'approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes'
  if (decision === 'REVIEW_REQUIRED') return 'required'
  return ''
}

const toPr = (pr: GhPr): Pr => ({
  number: pr.number,
  title: pr.title,
  author: pr.author?.login ?? '',
  branch: pr.headRefName,
  isDraft: pr.isDraft,
  ci: ciState(pr.statusCheckRollup),
  review: review(pr.reviewDecision),
  reviewers: (pr.reviewRequests ?? []).map(r => r.login ?? r.name ?? r.slug ?? '').filter(Boolean),
  updatedAt: seconds(pr.updatedAt),
  url: pr.url,
})

const isBot = (login: string) => login.endsWith('[bot]') || login === 'dependabot' || login === 'github-actions'

let myLogin: string | undefined
const whoAmI = async ($: EngineInterface) => {
  if (!myLogin) {
    const r = await run($, ['gh', 'api', 'user', '--jq', '.login'])
    if (r.exitCode === 0) myLogin = r.stdout.trim()
  }

  return myLogin ?? ''
}

/** First lines of commit messages by sha; each is asked for once. */
const messages = new Map<string, string>()
const commitMessage = async ($: EngineInterface, repo: string, sha: string) => {
  if (!sha || /^0+$/.test(sha)) return ''
  if (!messages.has(sha)) {
    const r = await run($, ['gh', 'api', `repos/${repo}/commits/${sha}`, '--jq', '.commit.message | split("\n")[0]'])
    if (r.exitCode !== 0) return ''
    messages.set(sha, r.stdout.trim())
  }

  return messages.get(sha) ?? ''
}

/** Every commit on the default branch since `since`, newest first: all pages, not just the first hundred. */
const weekOfCommits = async ($: EngineInterface, repo: string, since: string) => {
  const r = await run(
    $,
    [
      'gh', 'api', '--paginate', `repos/${repo}/commits?per_page=100&since=${since}`,
      '--jq', '.[] | [(.author.login // ""), .commit.author.date, (.commit.message | split("\n")[0])] | @tsv',
    ],
    30000,
  ).catch(() => undefined)
  if (!r || r.exitCode !== 0) return []

  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [login = '', date = '', message = ''] = line.split('\t')
      return { login, at: seconds(date), message }
    })
}

/** Names on GitHub profiles; taken as fixed and kept across sessions. */
const profileNames = async ($: EngineInterface, logins: string[]) => {
  const stored = await $.store.get('names').catch(() => undefined)
  const known: Record<string, string> = stored && typeof stored === 'object' ? { ...(stored as Record<string, string>) } : {}
  const missing = logins.filter(login => !(login in known))
  if (missing.length) {
    await Promise.all(
      missing.map(async login => {
        const r = await run($, ['gh', 'api', `users/${login}`, '--jq', '.name // ""']).catch(() => undefined)
        if (r?.exitCode === 0) known[login] = r.stdout.trim()
      }),
    )
    await $.store.set('names', known).catch(() => undefined)
  }

  return known
}

const readUtcOffset = async ($: EngineInterface) => {
  const date = await run($, ['date', '+%z']).catch(() => undefined)
  const zone = date?.stdout.trim().match(/^([+-])(\d\d)(\d\d)$/)
  return zone
    ? (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3]))
    : -new Date().getTimezoneOffset()
}

/** What to tell the person when nothing could be read: no gh, no login, no repo, no internet. */
const explain = (err: unknown) => {
  const text = err instanceof Error ? err.message : String(err)
  if (/Not Found|Could not resolve to a Repository|HTTP 404/i.test(text)) return "Repo not found, or you don't have access to it."
  if (/auth login|not logged|authentication|HTTP 401/i.test(text)) return 'Not signed in to GitHub. In a terminal: gh auth login'
  if (/ENOENT|No such file|spawn|did not run/i.test(text)) return 'GitHub CLI (gh) not found. Install it: brew install gh, then gh auth login.'
  if (/connect|network|timed? ?out|dial tcp|resolve host|offline/i.test(text)) return "Can't reach GitHub."

  return text.split('\n')[0] ?? text
}

const collect = async ($: EngineInterface, repo: string, picked: string[] | undefined): Promise<Summary> => {
  const json = <T,>(...args: string[]) => ghJson<T>($, args)
  // The repo itself first: sign-in, access and the network show here.
  const info = await json<{ defaultBranch: string; fullName: string }>(
    'api',
    `repos/${repo}`,
    '--jq',
    '{defaultBranch: .default_branch, fullName: .full_name}',
  )
  const weekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString()

  const [me, contributors, collaborators, activity, openPrs, mergedPrs, commits, issues, runs, utcOffset] =
    await Promise.all([
      whoAmI($),
      json<{ login: string; contributions: number; type: string }[]>(
        'api',
        `repos/${repo}/contributors?per_page=100`,
        '--jq',
        '[.[] | {login, contributions, type}]',
      ).catch(() => []),
      // Only people with write access can list collaborators; for the rest it stays empty.
      json<string[]>('api', `repos/${repo}/collaborators?per_page=100`, '--jq', '[.[].login]').catch(() => []),
      json<Activity[]>(
        'api',
        `repos/${repo}/activity?per_page=100`,
        '--jq',
        '[.[] | {at: .timestamp, login: (.actor.login // ""), kind: .activity_type, ref, after}]',
      ).catch(() => []),
      json<GhPr[]>(
        'pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json',
        'number,title,author,headRefName,isDraft,reviewDecision,reviewRequests,statusCheckRollup,updatedAt,url',
      ),
      json<{ number: number; title: string; author?: { login?: string }; headRefName: string; mergedAt: string }[]>(
        'pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '20', '--json', 'number,title,author,headRefName,mergedAt',
      ).catch(() => []),
      weekOfCommits($, repo, weekAgo),
      json<{ assignees: { login: string }[] }[]>(
        'issue', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'assignees',
      ).catch(() => undefined),
      json<{ status: string; conclusion: string }[]>(
        'run', 'list', '--repo', repo, '--limit', '20', '--json', 'status,conclusion,headBranch',
        '--jq', `[.[] | select(.headBranch == "${info.defaultBranch}")]`,
      ).catch(() => []),
      readUtcOffset($),
    ])

  const prs = openPrs.map(toPr)
  const prBranches = new Set([...prs.map(pr => pr.branch), ...mergedPrs.map(pr => pr.headRefName)])

  // Everyone who can be picked: contributors, collaborators, PR authors, recent pushers.
  const found = new Map<string, Candidate>()
  const add = (login: string, contributions: number, source: string) => {
    if (!login || isBot(login)) return
    const known = found.get(login)
    if (known) known.contributions = Math.max(known.contributions, contributions)
    else found.set(login, { login, contributions, source })
  }
  for (const c of contributors) if (c.type !== 'Bot') add(c.login, c.contributions, 'contributor')
  for (const login of collaborators) add(login, 0, 'collaborator')
  for (const pr of [...openPrs, ...mergedPrs]) add(pr.author?.login ?? '', 0, 'opened a PR')
  for (const a of activity) add(a.login, 0, 'pushed')
  const candidates = [...found.values()]
    .sort((a, b) => b.contributions - a.contributions || a.login.localeCompare(b.login))
    .slice(0, CANDIDATE_LIMIT)

  const isDefaultPeople = !picked?.length
  const shown = isDefaultPeople ? candidates.slice(0, DEFAULT_PEOPLE).map(c => c.login) : (picked ?? [])

  // Activity runs newest first: a deleted branch cancels the pushes before it.
  const branchesOf = (login: string) => {
    const deleted = new Set<string>()
    const branches: string[] = []
    const oldest = Date.now() / 1000 - BRANCH_DAYS * 86400
    for (const a of activity) {
      if (a.kind === 'branch_deletion') deleted.add(a.ref)
      if (a.login !== login || !['push', 'force_push', 'branch_creation'].includes(a.kind)) continue
      const branch = a.ref.replace(/^refs\/heads\//, '')
      if (!a.ref.startsWith('refs/heads/') || branch === info.defaultBranch || deleted.has(a.ref)) continue
      if (prBranches.has(branch) || branches.includes(branch) || seconds(a.at) < oldest) continue
      branches.push(branch)
    }
    return branches
  }

  const lastPushOf = async (login: string): Promise<Push | undefined> => {
    const last = activity.find(a => a.login === login && PUSHES.includes(a.kind))
    if (!last) {
      // Not in the repo's recent activity: their latest commit on the default branch this week, if any.
      const commit = commits.find(c => c.login === login)
      return commit && { at: commit.at, branch: info.defaultBranch, message: commit.message, isCommit: true }
    }
    const branch = last.ref.replace(/^refs\/heads\//, '')
    return { at: seconds(last.at), branch, message: (await commitMessage($, repo, last.after)) || branch }
  }

  const assigned = (login: string) => (issues ?? []).filter(i => i.assignees.some(a => a.login === login)).length
  const names = await profileNames($, shown)

  const people: Person[] = await Promise.all(
    shown.map(async login => ({
      login,
      name: names[login] || login,
      lastPush: await lastPushOf(login),
      prs: prs.filter(pr => pr.author === login),
      reviewing: prs.filter(pr => pr.reviewers.includes(login)),
      branches: branchesOf(login),
      weekCommits: commits.filter(c => c.login === login).length,
      issues: assigned(login),
    })),
  )

  const latestRun = runs[0]
  let ci: Ci = 'none'
  if (latestRun) {
    if (latestRun.status !== 'completed') ci = 'running'
    else ci = ['success', 'skipped', 'neutral'].includes(latestRun.conclusion) ? 'passed' : 'failed'
  }

  return {
    repo: {
      name: info.fullName || repo,
      defaultBranch: info.defaultBranch,
      openPrs: prs.length,
      openIssues: issues?.length ?? 0,
      ci,
    },
    me,
    people,
    waitingOnMe: me ? prs.filter(pr => pr.reviewers.includes(me)) : [],
    candidates,
    merged: [...mergedPrs]
      .sort((a, b) => seconds(b.mergedAt) - seconds(a.mergedAt))
      .slice(0, MERGED_SHOWN)
      .map(pr => ({ number: pr.number, title: pr.title, author: pr.author?.login ?? '', at: seconds(pr.mergedAt) })),
    isDefaultPeople,
    utcOffset,
  }
}

// The module's own variables: they start over on a reload, the state stays.
let timer: Timer | undefined
let autoOpen = true

const saveSettings = async ($: EngineInterface, change: (s: ActivitySettings) => ActivitySettings) => {
  const next = await update($, settings, change)
  await $.store.set('settings', next).catch(() => undefined)

  return next
}

/** The repo to show: the one picked, else this session's, else the first in the list. */
const currentRepo = async ($: EngineInterface) => {
  const picked = await read($, selected)
  if (picked) return picked
  const own = await read($, sessionRepo)
  if (own) return own

  return (await read($, settings)).repos[0] ?? ''
}

/** One read of the current repo into the pane. */
const refreshOnce = async ($: EngineInterface) => {
  const repo = await currentRepo($)
  if (!repo) {
    await update($, pane, p => ({ ...p, isLoading: false, error: undefined }))
    return
  }
  await update($, pane, p => ({ ...p, isLoading: true }))
  const now = Math.floor(Date.now() / 1000)
  try {
    const summary = await collect($, repo, (await read($, settings)).people[repo])
    // Switched to another repo meanwhile: the read queued by the switch shows that one.
    if ((await currentRepo($)) !== repo) return
    const next = await update($, pane, p => ({
      ...p,
      summary,
      isOffline: false,
      lastAttempt: now,
      lastSuccess: now,
      isLoading: false,
      error: undefined,
    }))
    await $.store.set(`pane:${repo}`, next).catch(() => undefined)
  } catch (err) {
    // Nothing could be read: the last known state stays.
    await update($, pane, p => ({ ...p, isOffline: true, lastAttempt: now, isLoading: false, error: explain(err) }))
  }
}

/**
 * Refreshes the pane. While a read runs, one more is queued after it with the
 * caller's own `$`, and every caller waits for the read that covers its call.
 */
let running: Promise<void> | undefined
let queued: Promise<void> | undefined
const refresh = ($: EngineInterface): Promise<void> => {
  if (!running) {
    running = refreshOnce($)
      .catch(() => undefined)
      .finally(() => {
        running = undefined
      })
    return running
  }
  if (!queued) {
    queued = running.then(() => {
      queued = undefined
      return refresh($)
    })
  }

  return queued
}

const start = ($: EngineInterface) => {
  if (!timer) timer = $.clock.every(REFRESH_MS, () => void refresh($))
  void refresh($)
}

const stop = () => {
  timer?.cancel()
  timer = undefined
}

const open = async ($: EngineInterface) => {
  void $.ui.open({ id: PANE, title: TITLE })
  start($)
}

/** Switches repo: that repo's last known state first, then a fresh read. */
const selectRepo = async ($: EngineInterface, repo: string) => {
  await update($, selected, () => repo)
  await $.store.set('lastSelected', repo).catch(() => undefined)
  const stored = await $.store.get(`pane:${repo}`).catch(() => undefined)
  await update($, pane, () =>
    stored && typeof stored === 'object' ? { ...(stored as Pane), isLoading: false } : { isOffline: false, isLoading: false },
  )
  void refresh($)
}

const addRepo = async ($: EngineInterface, typed: string) => {
  const name = repoName(typed)
  if (!name) {
    await update($, notice, () => `"${typed.trim()}" doesn't look like a repo; type owner/name or paste its GitHub URL.`)
    return false
  }
  const r = await run($, ['gh', 'api', `repos/${name}`, '--jq', '.full_name']).catch(() => undefined)
  if (!r || r.exitCode !== 0) {
    await update($, notice, () => `${name}: ${explain(new Error(r?.stderr || 'gh did not run'))}`)
    return false
  }
  const full = r.stdout.trim() || name
  await saveSettings($, s => ({ ...s, repos: [...new Set([...s.repos, full])] }))
  await update($, notice, () => `Added ${full}.`)
  await selectRepo($, full)
  return true
}

const removeRepo = async ($: EngineInterface, repo: string) => {
  const next = await saveSettings($, s => ({ ...s, repos: s.repos.filter(r => r !== repo) }))
  await update($, notice, () => `Removed ${repo}.`)
  if ((await read($, selected)) === repo) await selectRepo($, (await read($, sessionRepo)) || next.repos[0] || '')
}

/** Shows or hides one person; with nobody picked yet, starts from the people shown now. */
const togglePerson = async ($: EngineInterface, login: string) => {
  const repo = await currentRepo($)
  if (!repo) return
  const summary = (await read($, pane)).summary
  const picked = (await read($, settings)).people[repo]
  const base = picked?.length ? picked : summary?.isDefaultPeople ? summary.people.map(p => p.login) : []
  const next = base.includes(login) ? base.filter(l => l !== login) : [...base, login]
  await saveSettings($, s => ({ ...s, people: { ...s.people, [repo]: next } }))
  void refresh($)
}

const addPerson = async ($: EngineInterface, typed: string) => {
  const login = typed.trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//, '').replace(/\/.*$/, '')
  if (!login) return
  const r = await run($, ['gh', 'api', `users/${login}`, '--jq', '.login']).catch(() => undefined)
  if (!r || r.exitCode !== 0) {
    await update($, notice, () => `No GitHub user named "${login}".`)
    return
  }
  const full = r.stdout.trim() || login
  const repo = await currentRepo($)
  const summary = (await read($, pane)).summary
  const picked = (await read($, settings)).people[repo]
  if (picked?.includes(full) || (!picked?.length && summary?.people.some(p => p.login === full))) {
    await update($, notice, () => `${full} is already in the list.`)
    return
  }
  await togglePerson($, full)
  await update($, notice, () => `Added ${full}.`)
}

const resetPeople = async ($: EngineInterface) => {
  const repo = await currentRepo($)
  await saveSettings($, s => {
    const people = { ...s.people }
    delete people[repo]
    return { ...s, people }
  })
  await update($, notice, () => 'Picks cleared: the top contributors are shown.')
  void refresh($)
}

/** The GitHub repo of the session's folder, "owner/name"; empty when there is none. */
const findSessionRepo = async ($: EngineInterface, cwd: string) => {
  const r = await run($, ['git', '-C', cwd, 'remote', 'get-url', 'origin'], 5000).catch(() => undefined)
  return r?.exitCode === 0 ? repoName(r.stdout) : ''
}

const clock = (at: number, offset: number) => {
  const d = new Date((at + offset * 60) * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

const day = (at: number, offset: number) => Math.floor((at + offset * 60) / 86400)

const ago = (secs: number) => {
  const min = Math.max(0, Math.floor(secs / 60))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min ago` : `${h} h ago`
  const d = Math.floor(h / 24)

  return d === 1 ? 'yesterday' : `${d} days ago`
}

const when = (at: number, now: number, offset: number) => {
  if (day(at, offset) === day(now, offset)) return `${ago(now - at)} (${clock(at, offset)})`
  const d = new Date((at + offset * 60) * 1000)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${clock(at, offset)}`
}

const CI_TEXT: Record<Ci, string> = { passed: 'CI ✓', failed: 'CI ✗ failed', running: 'CI running', none: '' }
const REVIEW_TEXT: Record<Review, string> = {
  approved: 'approved',
  changes: 'changes requested',
  required: 'review required',
  '': '',
}

/** A PR's state on one line: draft, CI, review, and who a review waits on. */
const prState = (pr: Pr) => {
  const parts = [pr.isDraft ? 'draft' : '', CI_TEXT[pr.ci], REVIEW_TEXT[pr.review]]
  if (pr.reviewers.length) parts.push(`waiting on ${pr.reviewers.join(', ')}`)
  return parts.filter(Boolean).join(' · ')
}

const pushLine = (person: Person, now: number, offset: number) => {
  const last = person.lastPush
  if (!last) return 'no push this week'
  return `${when(last.at, now, offset)} · ${last.isCommit ? `last commit on ${last.branch}` : last.branch} — ${last.message}`
}

const personFacts = (person: Person) =>
  [
    `${person.weekCommits} commits in 7 days`,
    person.issues ? `${person.issues} open ${person.issues === 1 ? 'issue' : 'issues'}` : '',
    person.reviewing.length ? `reviewing ${person.reviewing.length} ${person.reviewing.length === 1 ? 'PR' : 'PRs'}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

const repoLine = (s: Summary) =>
  `Open PRs ${s.repo.openPrs} · open issues ${s.repo.openIssues}${s.repo.ci !== 'none' ? ` · ${s.repo.defaultBranch} ${CI_TEXT[s.repo.ci]}` : ''}`

/** The pane as plain text, for /activity summary. */
const asText = (s: Summary, now: number) => {
  const lines = [s.repo.name]
  if (s.waitingOnMe.length) {
    lines.push('', `Waiting on your review (${s.waitingOnMe.length}):`)
    for (const pr of s.waitingOnMe) lines.push(`- #${pr.number} ${pr.title} — ${pr.author}`)
  }
  for (const person of s.people) {
    lines.push('', `${person.name} (@${person.login}${person.login === s.me ? ', you' : ''})`, pushLine(person, now, s.utcOffset))
    for (const pr of person.prs) lines.push(`- PR #${pr.number} ${pr.title}${prState(pr) ? ` · ${prState(pr)}` : ''}`)
    if (person.branches.length) lines.push(`- branches without a PR: ${person.branches.join(', ')}`)
    lines.push(personFacts(person))
  }
  lines.push('', repoLine(s))

  return lines.join('\n')
}

export const register: Register = (on, options) => {
  autoOpen = options.autoOpen !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'activity',
      description: 'Opens the GitHub activity pane (/activity settings, /activity owner/repo to add one, /activity summary, /activity close)',
    })
    const stored = await $.store.get('settings').catch(() => undefined)
    if (stored && typeof stored === 'object' && Array.isArray((stored as ActivitySettings).repos)) {
      await update($, settings, () => stored as ActivitySettings)
    }
    const own = await findSessionRepo($, e.cwd)
    await update($, sessionRepo, () => own)
    const s = await read($, settings)
    if (!(await read($, selected))) {
      const last = await $.store.get('lastSelected').catch(() => undefined)
      const first = s.repos.includes(own)
        ? own
        : typeof last === 'string' && s.repos.includes(last)
          ? last
          : s.repos[0] ?? own
      if (first) await selectRepo($, first)
    }
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    // A session working in one of the listed repos opens the pane by itself.
    if (isOpen || (autoOpen && own && s.repos.includes(own))) await open($)

    return next(e)
  })

  on('command.run', { command: 'activity' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      stop()
      await $.ui.close({ id: PANE })
      return { text: 'GitHub activity closed.' }
    }
    if (arg === 'summary') {
      if (!(await currentRepo($))) return { text: 'No repo picked yet: /activity owner/repo' }
      await refresh($)
      const p = await read($, pane)
      if (!p.summary) return { text: p.error ?? 'Nothing could be read.' }
      return { text: `${p.isOffline && p.error ? `${p.error} Showing the last known state.\n\n` : ''}${asText(p.summary, Math.floor(Date.now() / 1000))}` }
    }
    if (arg === 'settings') await update($, isSettings, () => true)
    else if (arg && !(await addRepo($, arg))) return { text: await read($, notice) }
    await open($)
    const repo = await currentRepo($)

    return {
      text: repo
        ? `GitHub activity is open (${repo}); it refreshes every 3 minutes.`
        : 'GitHub activity is open. Pick a repo: /activity owner/repo, or ⚙ in the pane.',
    }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    stop()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const el = $.ui.resolve(e)
    const Input = 'Input' in el ? el.Input : undefined
    const p = await read($, pane)
    const s = await read($, settings)
    const repo = await currentRepo($)
    const own = await read($, sessionRepo)
    const sum = p.summary && p.summary.repo.name.toLowerCase() === repo.toLowerCase() ? p.summary : undefined
    const now = Math.floor(Date.now() / 1000)
    const offset = sum?.utcOffset ?? -new Date().getTimezoneOffset()

    // With several repos, tabs at the top switch between them.
    const repos = [...new Set([...s.repos, ...(repo && !s.repos.includes(repo) ? [repo] : [])])]
    const tabs = repos.length > 1 && (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {repos.map(r => (
          <Button key={`tab:${r}`} variant={r === repo ? 'primary' : 'secondary'} label={r.split('/')[1] ?? r} onPress={() => selectRepo($, r)} />
        ))}
      </Box>
    )

    if (await read($, isSettings)) {
      const picked = s.people[repo]
      const visible = picked?.length ? picked : sum?.isDefaultPeople ? sum.people.map(person => person.login) : []
      const said = await read($, notice)

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text bold>Repos</Text>
            {s.repos.length === 0 && <Text dimColor>No repos added yet.</Text>}
            {s.repos.map(r => (
              <Box key={`repo:${r}`} flexDirection="row" gap={1}>
                <Button key={`select:${r}`} plain dimColor={r !== repo} label={r === repo ? `● ${r}` : `○ ${r}`} onPress={() => selectRepo($, r)} />
                <Button key={`remove:${r}`} plain dimColor label="✕ remove" onPress={() => removeRepo($, r)} />
              </Box>
            ))}
            {own && !s.repos.includes(own) && (
              <Button key="add-session-repo" variant="secondary" label={`+ This session's repo: ${own}`} onPress={() => addRepo($, own)} />
            )}
            {Input && <Input key="add-repo" placeholder="owner/repo or a GitHub URL" submitLabel="Add" onSubmit={value => addRepo($, value)} />}
          </Box>
          {repo && (
            <Box flexDirection="column">
              <Text bold>Who do you want to see? · {repo}</Text>
              <Text dimColor>The people you pick show in the pane. The list: contributors, collaborators, PR authors and recent pushers.</Text>
              {!sum && <Text dimColor>Loading the list…</Text>}
              {sum?.candidates.map(c => {
                const isPicked = visible.includes(c.login)
                return (
                  <Button key={`person:${c.login}`} plain dimColor={!isPicked} onPress={() => togglePerson($, c.login)}>
                    {isPicked ? '✓ ' : '+ '}
                    {c.login}
                    <Text dimColor>{c.contributions ? ` · ${c.contributions} contributions` : ` · ${c.source}`}</Text>
                  </Button>
                )
              })}
              {visible
                .filter(login => !sum?.candidates.some(c => c.login === login))
                .map(login => (
                  <Button key={`person:${login}`} plain onPress={() => togglePerson($, login)}>
                    {'✓ '}
                    {login}
                    <Text dimColor> · added by hand</Text>
                  </Button>
                ))}
              {Input && <Input key="add-person" placeholder="Not listed? A GitHub username" submitLabel="Add" onSubmit={value => addPerson($, value)} />}
              {picked?.length ? <Button key="reset" plain dimColor label="Clear picks (show top contributors)" onPress={() => resetPeople($)} /> : null}
            </Box>
          )}
          {said && <Text dimColor>{said}</Text>}
          <Button key="back" variant="primary" label="← Back to activity" onPress={() => update($, isSettings, () => false)} />
        </Box>
      )
    }

    let status = 'loading…'
    if (p.isOffline) status = `couldn't read, last update ${p.lastSuccess ? clock(p.lastSuccess, offset) : 'never'}`
    else if (p.lastAttempt) status = `updated ${clock(p.lastAttempt, offset)}`
    if (p.isLoading && sum) status += ' · refreshing…'

    const footer = (
      <Box flexDirection="row" gap={1}>
        <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
        <Button key="settings" variant="secondary" label="⚙ People and repos" onPress={() => update($, isSettings, () => true)} />
      </Box>
    )

    if (!repo) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text>No repo picked yet.</Text>
          <Text dimColor>Add a GitHub repo with ⚙, or type /activity owner/repo in the chat.</Text>
          {footer}
        </Box>
      )
    }

    if (!sum) {
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text bold>{repo}</Text>
          <Text dimColor>{status}</Text>
          {p.error && <Text color="warning">{p.error}</Text>}
          {footer}
        </Box>
      )
    }

    const prRow = (pr: Pr, prefix = '') => (
      <Box key={`pr:${prefix}${pr.number}`} flexDirection="row" gap={1} flexWrap="wrap">
        <Link href={pr.url} label={`PR #${pr.number}`} />
        <Text>{pr.title}</Text>
        {prState(pr) && <Text dimColor color={pr.ci === 'failed' || pr.review === 'changes' ? 'warning' : undefined}>· {prState(pr)}</Text>}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Box flexDirection="column">
          <Text bold>{sum.repo.name}</Text>
          <Text dimColor color={p.isOffline ? 'warning' : undefined}>
            {status}
          </Text>
          {p.isOffline && p.error && <Text color="warning">{p.error}</Text>}
        </Box>

        {sum.waitingOnMe.length > 0 && (
          <Box flexDirection="column">
            <Text bold color="warning">Waiting on your review ({sum.waitingOnMe.length})</Text>
            {sum.waitingOnMe.map(pr => (
              <Box key={`mine:${pr.number}`} flexDirection="row" gap={1} flexWrap="wrap">
                <Link href={pr.url} label={`PR #${pr.number}`} />
                <Text>{pr.title}</Text>
                <Text dimColor>— {pr.author}</Text>
              </Box>
            ))}
          </Box>
        )}

        {sum.people.map(person => (
          <Box key={`person:${person.login}`} flexDirection="column">
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Text bold>{person.name}</Text>
              <Text dimColor>
                @{person.login}
                {person.login === sum.me ? ' (you)' : ''}
              </Text>
            </Box>
            <Text>{pushLine(person, now, offset)}</Text>
            {person.prs.map(pr => prRow(pr, `${person.login}:`))}
            {person.branches.length > 0 && <Text dimColor>Branches without a PR: {person.branches.join(', ')}</Text>}
            <Text dimColor>{personFacts(person)}</Text>
          </Box>
        ))}

        {sum.isDefaultPeople && <Text dimColor>Showing the top contributors; pick who you see under ⚙ People and repos.</Text>}

        <Box flexDirection="column">
          <Text>{repoLine(sum)}</Text>
          {sum.merged.length > 0 && <Text dimColor>Recently merged:</Text>}
          {sum.merged.map(pr => (
            <Text key={`merged:${pr.number}`} dimColor>
              #{pr.number} {pr.title} — {pr.author}, {when(pr.at, now, offset)}
            </Text>
          ))}
        </Box>
        {footer}
      </Box>
    )
  })
}
