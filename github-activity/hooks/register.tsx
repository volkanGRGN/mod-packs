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
/** How long /activity summary waits for a fresh read before giving the last known state. */
const SUMMARY_WAIT_MS = 8000
/** The most PRs GitHub is asked to suggest reviewers for in one refresh. */
const SUGGEST_LIMIT = 30
/** How many lines of a PR's description its opened row shows. */
const ABOUT_LINES = 3
/** How many rows a To do group shows before "▾ N more". */
const GROUP_ROWS = 3

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const PUSHES = ['push', 'force_push', 'branch_creation', 'pr_merge', 'merge_queue_merge']
const QUIET_ENV = { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' }

const pane = atom(
  { plugin: 'github-activity', key: 'pane' } as const,
  { isOffline: false, isLoading: false } as Pane,
  { shape: 'pane-2' },
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
const expanded = atom({ plugin: 'github-activity', key: 'expanded' } as const, [] as string[], { shape: 'expanded-1' })

type Activity = { at: string; login: string; kind: string; ref: string; after: string }
type GhCheck = { name?: string; context?: string; status?: string; conclusion?: string; state?: string }
type GhPr = {
  number: number
  title: string
  author?: { login?: string }
  headRefName: string
  isDraft: boolean
  reviewDecision?: string
  reviewRequests?: { login?: string; name?: string; slug?: string }[]
  latestReviews?: { author?: { login?: string }; state: string }[]
  statusCheckRollup?: GhCheck[]
  updatedAt: string
  url: string
  body?: string
  baseRefName?: string
  additions?: number
  deletions?: number
  changedFiles?: number
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

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

/** One check's outcome, in GitHub's words: a check run's conclusion, a status's state. */
const outcome = (c: GhCheck) =>
  (c.conclusion || c.state || (c.status && c.status !== 'COMPLETED' ? 'PENDING' : 'SUCCESS')).toUpperCase()

const ciState = (checks: GhCheck[] | undefined): Ci => {
  if (!checks?.length) return 'none'
  const results = checks.map(outcome)
  if (results.some(s => FAILED.includes(s))) return 'failed'
  if (results.some(s => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING'].includes(s))) return 'running'

  return 'passed'
}

/** A line that opens a section: a markdown heading, a bold line, or a short line ending in a colon. */
const isHeading = (line: string) => /^\s*#{1,6}\s/.test(line) || /^\s*\*\*[^*]+\*\*:?\s*$/.test(line) || /^[^-*+\s].{0,40}:\s*$/.test(line)

/**
 * The tests still to do in a PR's description: unticked boxes under a heading
 * about testing ("Test plan", "Testing", "How to verify"), or that say test
 * themselves. Template boxes elsewhere ("A human wrote it") are left out.
 */
const testsToDo = (body: string) => {
  const items: string[] = []
  let isTestSection = false
  for (const line of body.split(/\r?\n/)) {
    if (isHeading(line)) {
      isTestSection = /test|verif|QA|doğrula/i.test(line)
      continue
    }
    const box = line.match(/^\s*[-*+]\s+\[ \]\s+(.+?)\s*$/)
    if (box?.[1] && (isTestSection || /\btest/i.test(box[1]))) items.push(box[1])
  }

  return items.slice(0, 8)
}

const review = (decision: string | undefined): Review => {
  if (decision === 'APPROVED') return 'approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes'
  if (decision === 'REVIEW_REQUIRED') return 'required'
  return ''
}

/** What a PR is about, from its description: the first lines of prose, without headings, boxes, comments or images. */
const aboutOf = (body: string) => {
  const lines: string[] = []
  let isCode = false
  for (const raw of body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    if (raw.trimStart().startsWith('```')) {
      isCode = !isCode
      continue
    }
    if (isCode || isHeading(raw) || /^\s*[-*+]\s+\[[ xX]\]/.test(raw)) continue
    const line = raw
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
      .replace(/[*`]/g, '')
      // Underscores stay in names (sehir_uret.py); only _emphasis_ loses them.
      .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2')
      .trim()
    if (line) lines.push(line.slice(0, 300))
    if (lines.length === ABOUT_LINES) break
  }

  return lines
}

const toPr = (pr: GhPr): Pr => ({
  number: pr.number,
  title: pr.title,
  author: pr.author?.login ?? '',
  branch: pr.headRefName,
  base: pr.baseRefName ?? '',
  additions: pr.additions ?? 0,
  deletions: pr.deletions ?? 0,
  changedFiles: pr.changedFiles ?? 0,
  about: aboutOf(pr.body ?? ''),
  isDraft: pr.isDraft,
  ci: ciState(pr.statusCheckRollup),
  failedChecks: [
    ...new Set((pr.statusCheckRollup ?? []).filter(c => FAILED.includes(outcome(c))).map(c => c.name || c.context || '')),
  ].filter(Boolean),
  testsToDo: testsToDo(pr.body ?? ''),
  reviewedBy: (pr.latestReviews ?? [])
    .map(r => ({ login: r.author?.login ?? '', state: r.state }))
    .filter(r => r.login && r.login !== pr.author?.login),
  suggested: [],
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

type Profile = { name: string; id: string }

/**
 * Whom GitHub suggests as reviewers for each PR, from who wrote the lines it
 * changes: one GraphQL query for all of them.
 */
const suggestedReviewers = async ($: EngineInterface, repo: string, numbers: number[]) => {
  const found: Record<number, string[]> = {}
  const [owner, name] = repo.split('/')
  if (!owner || !name || !numbers.length) return found
  const fields = numbers.map(n => `p${n}: pullRequest(number: ${n}) { suggestedReviewers { reviewer { login } } }`).join(' ')
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`
  type Answer = { data?: { repository?: Record<string, { suggestedReviewers?: { reviewer?: { login?: string } }[] } | null> } }
  const r = await ghJson<Answer>($, ['api', 'graphql', '-f', `query=${query}`]).catch(() => undefined)
  for (const n of numbers) {
    const logins = (r?.data?.repository?.[`p${n}`]?.suggestedReviewers ?? []).map(s => s.reviewer?.login ?? '').filter(Boolean)
    if (logins.length) found[n] = logins
  }

  return found
}

/** Names and ids on GitHub profiles; taken as fixed and kept across sessions. */
const profiles = async ($: EngineInterface, logins: string[]) => {
  const stored = await $.store.get('profiles').catch(() => undefined)
  const known: Record<string, Profile> = stored && typeof stored === 'object' ? { ...(stored as Record<string, Profile>) } : {}
  const missing = logins.filter(login => !known[login]?.id)
  if (missing.length) {
    await Promise.all(
      missing.map(async login => {
        const r = await run($, ['gh', 'api', `users/${login}`, '--jq', '{name: (.name // ""), id: .node_id}']).catch(() => undefined)
        if (r?.exitCode !== 0) return
        try {
          known[login] = JSON.parse(r.stdout) as Profile
        } catch {
          // An answer that isn't JSON leaves the login as its own name.
        }
      }),
    )
    await $.store.set('profiles', known).catch(() => undefined)
  }

  return known
}

type Week = { count: number; latest?: { at: number; message: string } }

/**
 * Each person's commits on the default branch since `since`, and their latest
 * one, in a single GraphQL query: GitHub counts, so a busy repo costs no more
 * than a quiet one.
 */
const weekOf = async ($: EngineInterface, repo: string, since: string, people: { login: string; id: string }[]) => {
  const weeks: Record<string, Week> = {}
  const [owner, name] = repo.split('/')
  const asked = people.filter(p => /^[\w=-]+$/.test(p.id))
  if (!owner || !name || !asked.length) return weeks
  const fields = asked
    .map((p, i) => `p${i}: history(first: 1, since: "${since}", author: {id: "${p.id}"}) { totalCount nodes { messageHeadline committedDate } }`)
    .join(' ')
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { defaultBranchRef { target { ... on Commit { ${fields} } } } } }`
  type Answer = { data?: { repository?: { defaultBranchRef?: { target?: Record<string, { totalCount: number; nodes: { messageHeadline: string; committedDate: string }[] }> } } } }
  const r = await ghJson<Answer>($, ['api', 'graphql', '-f', `query=${query}`]).catch(() => undefined)
  const target = r?.data?.repository?.defaultBranchRef?.target ?? {}
  asked.forEach((p, i) => {
    const h = target[`p${i}`]
    const node = h?.nodes[0]
    weeks[p.login] = { count: h?.totalCount ?? 0, latest: node && { at: seconds(node.committedDate), message: node.messageHeadline } }
  })

  return weeks
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

  const [me, contributors, collaborators, activity, openPrs, mergedPrs, issues, runs, utcOffset] =
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
        'number,title,author,headRefName,baseRefName,isDraft,reviewDecision,reviewRequests,latestReviews,statusCheckRollup,updatedAt,url,body,additions,deletions,changedFiles',
      ),
      json<{ number: number; title: string; author?: { login?: string }; headRefName: string; mergedAt: string }[]>(
        'pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '20', '--json', 'number,title,author,headRefName,mergedAt',
      ).catch(() => []),
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
      const commit = weeks[login]?.latest
      return commit && { at: commit.at, branch: info.defaultBranch, message: commit.message, isCommit: true }
    }
    const branch = last.ref.replace(/^refs\/heads\//, '')
    return { at: seconds(last.at), branch, message: (await commitMessage($, repo, last.after)) || branch }
  }

  const assigned = (login: string) => (issues ?? []).filter(i => i.assignees.some(a => a.login === login)).length
  const known = await profiles($, shown)
  const toReview = prs.filter(pr => !pr.isDraft && (shown.includes(pr.author) || pr.reviewers.includes(me))).map(pr => pr.number)
  const [weeks, suggestions] = await Promise.all([
    weekOf($, repo, weekAgo, shown.map(login => ({ login, id: known[login]?.id ?? '' }))),
    suggestedReviewers($, repo, toReview.slice(0, SUGGEST_LIMIT)),
  ])
  for (const pr of prs) pr.suggested = (suggestions[pr.number] ?? []).filter(login => login !== pr.author)

  const people: Person[] = await Promise.all(
    shown.map(async login => ({
      login,
      name: known[login]?.name || login,
      lastPush: await lastPushOf(login),
      prs: prs.filter(pr => pr.author === login),
      reviewing: prs.filter(pr => pr.reviewers.includes(login)),
      branches: branchesOf(login),
      weekCommits: weeks[login]?.count ?? 0,
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
    await $.store.set(`pane2:${repo}`, next).catch(() => undefined)
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
  const stored = await $.store.get(`pane2:${repo}`).catch(() => undefined)
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

/** A PR's state on one line: draft, CI and the review decision. */
const prState = (pr: Pr) => [pr.isDraft ? 'draft' : '', CI_TEXT[pr.ci], REVIEW_TEXT[pr.review]].filter(Boolean).join(' · ')

const REVIEWED: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'asked for changes',
  COMMENTED: 'commented',
  DISMISSED: 'was dismissed',
}

/**
 * Who reviews a PR, on one line: whom a review is requested from, who has
 * reviewed and how, and whom GitHub suggests among those who haven't.
 */
const reviewLine = (pr: Pr) => {
  const parts: string[] = []
  if (pr.reviewers.length) parts.push(`waiting on ${pr.reviewers.join(', ')}`)
  for (const r of pr.reviewedBy) parts.push(`${r.login} ${REVIEWED[r.state] ?? r.state.toLowerCase()}`)
  const asked = new Set([...pr.reviewers, ...pr.reviewedBy.map(r => r.login)])
  const suggested = pr.suggested.filter(login => !asked.has(login))
  if (!parts.length) parts.push('no reviewer yet')
  if (suggested.length) parts.push(`GitHub suggests ${suggested.join(', ')}`)

  return parts.join(' · ')
}

/** Where a PR goes and how big it is: branch → base, lines added and removed, files, last update. */
const prSize = (pr: Pr, now: number) =>
  `${pr.branch} → ${pr.base || '?'} · +${pr.additions} −${pr.deletions} in ${pr.changedFiles} ${pr.changedFiles === 1 ? 'file' : 'files'} · updated ${ago(now - pr.updatedAt)}`

/** Opens a To do group past its first rows, or folds it back. */
const toggleGroup = ($: EngineInterface, id: string) =>
  update($, expanded, list => (list.includes(id) ? list.filter(l => l !== id) : [...list, id]))

type TodoRow = { key: string; pr: Pr; text: string; detail?: string }
type TodoGroup = { id: string; title: string; rows: TodoRow[]; isUrgent?: boolean }

/** The PRs that need something, grouped by what: those of the people shown, and those waiting on you. */
const todoGroups = (s: Summary): TodoGroup[] => {
  const byNumber = new Map<number, Pr>()
  for (const pr of [...s.waitingOnMe, ...s.people.flatMap(p => p.prs)]) byNumber.set(pr.number, pr)
  const prs = [...byNumber.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  const mine = new Set(s.waitingOnMe.map(pr => pr.number))
  const row = (pr: Pr, detail?: string): TodoRow => ({ key: String(pr.number), pr, text: `${pr.title} — ${pr.author}`, detail })
  const groups: TodoGroup[] = [
    { id: 'mine', title: 'Waiting on your review', isUrgent: true, rows: s.waitingOnMe.map(pr => row(pr)) },
    {
      id: 'failing',
      title: 'Failing checks',
      isUrgent: true,
      rows: prs.filter(pr => pr.ci === 'failed').map(pr => row(pr, pr.failedChecks.join(', ') || undefined)),
    },
    {
      id: 'tests',
      title: 'Tests to do',
      rows: prs.flatMap(pr => pr.testsToDo.map((text, i) => ({ key: `${pr.number}:${i}`, pr, text }))),
    },
    { id: 'changes', title: 'Changes requested', rows: prs.filter(pr => pr.review === 'changes').map(pr => row(pr)) },
    {
      id: 'ready',
      title: 'Ready to merge',
      rows: prs.filter(pr => pr.review === 'approved' && !pr.isDraft && pr.ci !== 'failed' && pr.ci !== 'running').map(pr => row(pr)),
    },
    {
      id: 'review',
      title: 'Waiting for review',
      rows: prs
        .filter(pr => !pr.isDraft && !mine.has(pr.number) && pr.ci !== 'failed' && pr.review !== 'approved' && pr.review !== 'changes')
        .map(pr => row(pr, reviewLine(pr))),
    },
    { id: 'drafts', title: 'Drafts', rows: prs.filter(pr => pr.isDraft).map(pr => row(pr)) },
  ]

  return groups.filter(g => g.rows.length)
}

const pushLine = (person: Person, now: number, offset: number) => {
  const last = person.lastPush
  if (!last) return 'no push this week'
  return `${when(last.at, now, offset)} · ${last.isCommit ? `last commit on ${last.branch}` : last.branch} — ${last.message}`
}

const personFacts = (person: Person) =>
  [
    `${person.weekCommits} commits in 7 days`,
    person.prs.length ? `${person.prs.length} open ${person.prs.length === 1 ? 'PR' : 'PRs'}` : '',
    person.issues ? `${person.issues} open ${person.issues === 1 ? 'issue' : 'issues'}` : '',
    person.reviewing.length ? `reviewing ${person.reviewing.length} ${person.reviewing.length === 1 ? 'PR' : 'PRs'}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

/** What the To do doesn't say about the repo: open issues and CI on the default branch; empty when neither. */
const repoLine = (s: Summary) =>
  [
    s.repo.openIssues ? `${s.repo.openIssues} open ${s.repo.openIssues === 1 ? 'issue' : 'issues'}` : '',
    s.repo.ci !== 'none' ? `${s.repo.defaultBranch} ${CI_TEXT[s.repo.ci]}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

/** The pane as plain text, for /activity summary. */
const asText = (s: Summary, now: number) => {
  const lines = [s.repo.name]
  const groups = todoGroups(s)
  if (groups.length) lines.push('', 'To do')
  for (const g of groups) {
    lines.push(`${g.title} (${g.rows.length}):`)
    for (const r of g.rows) lines.push(`- #${r.pr.number} ${r.text}${r.detail ? ` · ${r.detail}` : ''}`)
  }
  lines.push('', 'People')
  for (const person of s.people) {
    lines.push(`${person.name} (@${person.login}${person.login === s.me ? ', you' : ''})`, pushLine(person, now, s.utcOffset))
    lines.push(personFacts(person))
    if (person.branches.length) lines.push(`Branches without a PR: ${person.branches.join(', ')}`)
    lines.push('')
  }
  if (repoLine(s)) lines.push(repoLine(s))

  return lines.join('\n').trimEnd()
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
      // A command answers within ten seconds: past SUMMARY_WAIT_MS, the last known state, the read going on.
      const inTime = await Promise.race([
        refresh($).then(() => true),
        $.clock.sleep(SUMMARY_WAIT_MS).then(() => false, () => new Promise<boolean>(() => undefined)),
      ])
      const p = await read($, pane)
      if (!p.summary) return { text: inTime ? (p.error ?? 'Nothing could be read.') : 'Still reading GitHub; try /activity summary again in a moment.' }
      const note = !inTime ? 'Still refreshing; this is the last known state.\n\n' : p.isOffline && p.error ? `${p.error} Showing the last known state.\n\n` : ''
      return { text: `${note}${asText(p.summary, Math.floor(Date.now() / 1000))}` }
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

    const unfolded = await read($, expanded)
    const groups = todoGroups(sum)
    // A row pressed open: what the PR is about, where it goes, how big it is, its checks and tests left.
    const prDetails = (pr: Pr) => (
      <Box flexDirection="column" marginLeft={3} marginBottom={1}>
        <Text bold wrap="truncate-end">{pr.title}</Text>
        <Text dimColor wrap="truncate-end">{prSize(pr, now)}</Text>
        {pr.about.length ? pr.about.map(line => <Text>{line}</Text>) : <Text dimColor>No description.</Text>}
        {prState(pr) && (
          <Text dimColor color={pr.ci === 'failed' || pr.review === 'changes' ? 'warning' : undefined}>
            {prState(pr)}
          </Text>
        )}
        <Text dimColor>Review: {reviewLine(pr)}</Text>
        {pr.failedChecks.length > 0 && <Text color="warning">Failed: {pr.failedChecks.join(', ')}</Text>}
        {pr.testsToDo.map(t => (
          <Text>☐ {t}</Text>
        ))}
      </Box>
    )
    // One row a PR or test item, its words cut to the width; a group shows its first rows, the rest on a press.
    const group = (g: TodoGroup) => {
      const isOpen = unfolded.includes(g.id)
      const rows = isOpen ? g.rows : g.rows.slice(0, GROUP_ROWS)
      return (
        <Box key={`group:${g.id}`} flexDirection="column">
          <Text bold color={g.isUrgent ? 'warning' : undefined}>
            {g.title} ({g.rows.length})
          </Text>
          {rows.map(r => {
            const id = `row:${g.id}:${r.key}`
            const isRowOpen = unfolded.includes(id)
            return (
              <Box key={id} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Link href={r.pr.url} label={`#${r.pr.number}`} />
                  <Button key={`open:${g.id}:${r.key}`} plain onPress={() => toggleGroup($, id)}>
                    <Text wrap="truncate-end">
                      {isRowOpen ? '▾ ' : '▸ '}
                      {r.text}
                    </Text>
                  </Button>
                </Box>
                {r.detail && (
                  <Text dimColor wrap="truncate-end">
                    {'   '}
                    {r.detail}
                  </Text>
                )}
                {isRowOpen && prDetails(r.pr)}
              </Box>
            )
          })}
          {g.rows.length > GROUP_ROWS && (
            <Button
              key={`more:${g.id}`}
              plain
              dimColor
              label={isOpen ? '▴ fewer' : `▾ ${g.rows.length - GROUP_ROWS} more`}
              onPress={() => toggleGroup($, g.id)}
            />
          )}
        </Box>
      )
    }

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

        {groups.length > 0 ? (
          <Box flexDirection="column" gap={1}>
            <Text bold underline>To do</Text>
            {groups.map(group)}
          </Box>
        ) : (
          <Text dimColor>Nothing to do: no open PRs among the people shown.</Text>
        )}

        <Box flexDirection="column" gap={1}>
          <Text bold underline>People</Text>
          {sum.people.map(person => (
            <Box key={`person:${person.login}`} flexDirection="column">
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                <Text bold>{person.name}</Text>
                <Text dimColor>
                  @{person.login}
                  {person.login === sum.me ? ' (you)' : ''}
                </Text>
              </Box>
              <Text wrap="truncate-end">{pushLine(person, now, offset)}</Text>
              <Text dimColor>{personFacts(person)}</Text>
              {person.branches.length > 0 && <Text dimColor wrap="truncate-end">Branches without a PR: {person.branches.join(', ')}</Text>}
            </Box>
          ))}
        </Box>

        <Box flexDirection="column">
          {repoLine(sum) && <Text>{repoLine(sum)}</Text>}
          {sum.merged.length > 0 && <Text dimColor>Recently merged:</Text>}
          {sum.merged.map(pr => (
            <Text key={`merged:${pr.number}`} dimColor wrap="truncate-end">
              #{pr.number} {pr.title} — {pr.author}, {when(pr.at, now, offset)}
            </Text>
          ))}
        </Box>
        {footer}
      </Box>
    )
  })
}
