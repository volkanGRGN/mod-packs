import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'github-activity',
  component: 'Pane',
  requestId: 'github-activity',
  props: {
    title: 'GitHub activity',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: exitCode ? 'failed' : '', isStdoutTruncated: false, isStderrTruncated: false },
})
const json = (x: unknown) => ran(JSON.stringify(x))
const iso = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString()

/** A machine that plays one repo and answers every gh question about it; `openPrs` stands in for its open PRs. */
const fakeGitHub = (on: On, openPrs?: unknown[]) => {
  on('process.run', (_, e) => {
    const [program, ...a] = e.argv
    const s = a.join(' ')
    const path = a.find(x => x.startsWith('repos/') || x.startsWith('users/')) ?? ''
    if (program === 'git') return ran('git@github.com:acme/app.git\n')
    if (program === 'date') return ran('+0300\n')
    if (program !== 'gh') return ran('', 127)
    if (s === 'api user --jq .login') return ran('ayse\n')
    if (a[1] === 'repos/acme/app') return json({ defaultBranch: 'main', fullName: 'acme/app' })
    if (a[1]?.startsWith('repos/acme/app/contributors')) {
      return json([
        { login: 'ayse', contributions: 50, type: 'User' },
        { login: 'mert', contributions: 30, type: 'User' },
        { login: 'dependabot[bot]', contributions: 5, type: 'Bot' },
      ])
    }
    if (a[1]?.startsWith('repos/acme/app/collaborators')) return json(['ayse', 'mert', 'zeynep'])
    if (a[1]?.startsWith('repos/acme/app/activity')) {
      return json([
        { at: iso(600), login: 'mert', kind: 'push', ref: 'refs/heads/feature/login', after: 'abc' },
        { at: iso(3600), login: 'mert', kind: 'push', ref: 'refs/heads/spike', after: 'def' },
        { at: iso(7200), login: 'ayse', kind: 'branch_deletion', ref: 'refs/heads/old', after: '0000' },
        { at: iso(9000), login: 'mert', kind: 'push', ref: 'refs/heads/old', after: 'fed' },
      ])
    }
    if (a[0] === 'pr' && a.includes('open') && openPrs) return json(openPrs)
    if (a[0] === 'pr' && a.includes('open')) {
      return json([
        {
          number: 7,
          title: 'Login screen',
          author: { login: 'mert' },
          headRefName: 'feature/login',
          baseRefName: 'main',
          additions: 10,
          deletions: 2,
          changedFiles: 3,
          isDraft: false,
          reviewDecision: 'REVIEW_REQUIRED',
          reviewRequests: [{ login: 'ayse' }],
          statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
          updatedAt: iso(300),
          url: 'https://github.com/acme/app/pull/7',
          body: '<!-- template note -->\n## Summary\nAdds the **login** screen.\n- Uses the [design](https://x.y/z) in `auth_form.tsx`, _carefully_\n',
        },
        {
          number: 8,
          title: 'Signup flow',
          author: { login: 'ayse' },
          headRefName: 'feature/signup',
          isDraft: false,
          reviewDecision: '',
          reviewRequests: [],
          latestReviews: [{ author: { login: 'mert' }, state: 'COMMENTED' }],
          statusCheckRollup: [
            { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'unit-tests', status: 'COMPLETED', conclusion: 'FAILURE' },
          ],
          updatedAt: iso(200),
          url: 'https://github.com/acme/app/pull/8',
          // Only unticked boxes about testing count; a template box elsewhere doesn't.
          body: '## Who wrote it\n- [ ] A human wrote it\n\n## Test plan\n- [x] lint\n- [ ] Test on Safari\n',
        },
      ])
    }
    if (a[0] === 'pr' && a.includes('merged')) {
      return json([{ number: 5, title: 'README', author: { login: 'ayse' }, headRefName: 'readme', mergedAt: iso(86400 * 2) }])
    }
    if (a[0] === 'api' && a[1] === 'graphql' && (a[3] ?? '').includes('pullRequest(')) {
      // Whom GitHub suggests: zeynep for #7; for #8 its own author (left out) and mert, who has reviewed it.
      return json({
        data: {
          repository: {
            p7: { suggestedReviewers: [{ reviewer: { login: 'zeynep' } }] },
            p8: { suggestedReviewers: [{ reviewer: { login: 'ayse' } }, { reviewer: { login: 'mert' } }] },
          },
        },
      })
    }
    if (a[0] === 'api' && a[1] === 'graphql') {
      // One query: each person's commits this week and their latest, by profile id.
      const week: Record<string, [number, number, string]> = {
        mert: [2, 700, 'Add the login form'],
        ayse: [1, 5000, 'Fix the README'],
        zeynep: [1, 90000, 'First commit'],
      }
      const target: Record<string, unknown> = {}
      for (const m of (a[3] ?? '').matchAll(/p(\d+): history\(first: 1, since: "[^"]+", author: \{id: "ID_(\w+)"\}\)/g)) {
        const [count, ago, message] = week[m[2] ?? ''] ?? [0, 0, '']
        target[`p${m[1]}`] = { totalCount: count, nodes: count ? [{ messageHeadline: message, committedDate: iso(ago) }] : [] }
      }
      return json({ data: { repository: { defaultBranchRef: { target } } } })
    }
    if (a[1] === 'repos/acme/app/commits/abc') return ran('Add the login form\n')
    if (a[0] === 'issue') return json([{ assignees: [{ login: 'mert' }] }])
    if (a[0] === 'run') return json([{ status: 'completed', conclusion: 'failure' }])
    if (path.startsWith('users/') && s.endsWith('--jq .login')) return ran(`${path.slice(6)}\n`)
    if (path.startsWith('users/')) {
      const login = path.slice(6)
      return json({ name: login === 'mert' ? 'Mert Kaya' : '', id: `ID_${login}` })
    }

    return ran('', 1)
  })
}

const startSession = async ($: Parameters<TestBody>[0], on: On) => {
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  mock.store(on)
  mock.env(on, { HOME: '/home' })
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
}

test("shows the To do for the picked repo's people, then the people", async ($, on) => {
  fakeGitHub(on)
  await startSession($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })

    expect((await ui.find({ type: 'Text', text: /^acme\/app$/ }))?.text).toBe('acme/app')
    expect((await ui.find({ type: 'Text', text: /^To do$/ }))?.text).toBe('To do')
    expect((await ui.find({ type: 'Text', text: /^Waiting on your/ }))?.text).toBe('Waiting on your review (1)')
    expect((await ui.find({ type: 'Text', text: /^▸ Login screen/ }))?.text).toBe('▸ Login screen — mert')
    // The failing PR names the checks that failed.
    expect((await ui.find({ type: 'Text', text: /^Failing checks/ }))?.text).toBe('Failing checks (1)')
    expect((await ui.find({ type: 'Text', text: /unit-tests/ }))?.text).toBe('   unit-tests')
    expect((await ui.find({ type: 'Text', text: /^Tests to do/ }))?.text).toBe('Tests to do (1)')
    expect((await ui.find({ type: 'Text', text: /^▸ Test on Safari$/ }))?.text).toBe('▸ Test on Safari')
    expect(await ui.find({ type: 'Text', text: /A human wrote it/ })).toBeUndefined()
    // A row pressed open says what the PR is about.
    expect(await ui.find({ type: 'Text', text: /Adds the login screen/ })).toBeUndefined()
    await ui.press({ key: 'open:mine:7' })
    expect((await ui.find({ type: 'Text', text: /^feature\/login → main/ }))?.text).toBe(
      'feature/login → main · +10 −2 in 3 files · updated 5 min ago',
    )
    expect((await ui.find({ type: 'Text', text: /Adds the/ }))?.text).toBe('Adds the login screen.')
    expect((await ui.find({ type: 'Text', text: /Uses the/ }))?.text).toBe('Uses the design in auth_form.tsx, carefully')
    expect((await ui.find({ type: 'Text', text: /review required/ }))?.text).toBe('CI ✓ · review required')
    expect((await ui.find({ type: 'Text', text: /^Review:/ }))?.text).toBe('Review: waiting on ayse · GitHub suggests zeynep')
    expect(await ui.find({ type: 'Text', text: /template note/ })).toBeUndefined()
    await ui.press({ key: 'open:mine:7' })
    expect(await ui.find({ type: 'Text', text: /Adds the login screen/ })).toBeUndefined()
    // A test item opened shows its PR, with the tests left.
    await ui.press({ key: 'open:tests:8:0' })
    expect((await ui.find({ type: 'Text', text: /^☐/ }))?.text).toBe('☐ Test on Safari')
    expect((await ui.find({ type: 'Text', text: /^Failed:/ }))?.text).toBe('Failed: unit-tests')
    expect((await ui.find({ type: 'Text', text: /^Review:/ }))?.text).toBe('Review: mert commented')
    await ui.press({ key: 'open:tests:8:0' })
    // #7 waits on me and #8 is failing: neither is in "Waiting for review".
    expect(await ui.find({ type: 'Text', text: /^Waiting for review/ })).toBeUndefined()

    expect((await ui.find({ type: 'Text', text: /^People$/ }))?.text).toBe('People')
    expect((await ui.find({ type: 'Text', text: /^Mert Kaya$/ }))?.text).toBe('Mert Kaya')
    expect((await ui.find({ type: 'Text', text: /feature\/login —/ }))?.text).toMatch(
      /^10 min ago \(\d\d:\d\d\) · feature\/login — Add the login form$/,
    )
    // The deleted "old" branch and the branch with a PR don't count.
    expect((await ui.find({ type: 'Text', text: /without a PR/ }))?.text).toBe('Branches without a PR: spike')
    expect((await ui.find({ type: 'Text', text: /^2 commits/ }))?.text).toBe('2 commits in 7 days · 1 open PR · 1 open issue')
    expect((await ui.find({ type: 'Text', text: /reviewing/ }))?.text).toBe('1 commits in 7 days · 1 open PR · reviewing 1 PR')
    // The open PRs are counted in the To do; the last line says only what it doesn't.
    expect(await ui.find({ type: 'Text', text: /Open PRs/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^1 open issue/ }))?.text).toBe('1 open issue · main CI ✗ failed')
    expect(await ui.find({ type: 'Text', text: /top contributors/ })).toBeDefined()
    // Bots stay out; zeynep, a collaborator, is in.
    expect(await ui.find({ type: 'Text', text: /dependabot/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^@zeynep/ }))?.text).toBe('@zeynep')
    // Neither ayse nor zeynep pushed in the recent activity: their latest commits stand in.
    expect((await ui.find({ type: 'Text', text: /Fix the README/ }))?.text).toMatch(
      /^1 h 23 min ago \(\d\d:\d\d\) · last commit on main — Fix the README$/,
    )
    expect((await ui.find({ type: 'Text', text: /First commit/ }))?.text).toMatch(
      /^(yesterday|[A-Z][a-z]{2} \d+ \d\d:\d\d) · last commit on main — First commit$/,
    )
    await ui.unmount()
  }
})

test('a long group shows its first rows and the rest on a press', async ($, on) => {
  // Five drafts by mert in place of the fake repo's PRs.
  fakeGitHub(
    on,
    [1, 2, 3, 4, 5].map(n => ({
      number: 100 + n,
      title: `Draft ${n}`,
      author: { login: 'mert' },
      headRefName: `draft-${n}`,
      isDraft: true,
      reviewDecision: '',
      reviewRequests: [],
      statusCheckRollup: [],
      updatedAt: iso(n * 60),
      url: `https://github.com/acme/app/pull/${100 + n}`,
      body: '',
    })),
  )
  await startSession($, on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /^Drafts/ }))?.text).toBe('Drafts (5)')
  expect(await ui.findAll({ type: 'Text', text: /^▸ Draft \d — mert$/ })).toHaveLength(3)
  await ui.press({ key: 'more:drafts' })
  expect(await ui.findAll({ type: 'Text', text: /^▸ Draft \d — mert$/ })).toHaveLength(5)
  await ui.unmount()
})

test('someone removed in the settings no longer shows', async ($, on) => {
  fakeGitHub(on)
  await startSession($, on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'settings' })
  expect((await ui.find({ type: 'Text', text: /Who do you/ }))?.text).toBe('Who do you want to see? · acme/app')
  await ui.press({ key: 'person:zeynep' })
  await ui.press({ key: 'back' })

  expect(await ui.find({ type: 'Text', text: /^@zeynep/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^@mert/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /top contributors/ })).toBeUndefined()
  await ui.unmount()
})

test('/activity summary gives the same picture as text', async ($, on) => {
  fakeGitHub(on)
  await startSession($, on)

  const r = await $.command.run({
    command: 'activity',
    args: 'summary',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  const text = 'text' in r ? r.text : ''
  expect(text).toMatch(
    /^acme\/app\n\nTo do\nWaiting on your review \(1\):\n- #7 Login screen — mert\nFailing checks \(1\):\n- #8 Signup flow — ayse · unit-tests\nTests to do \(1\):\n- #8 Test on Safari\n\nPeople\n/,
  )
  expect(text).toContain('Mert Kaya (@mert)\n10 min ago')
  expect(text).toContain('ayse (@ayse, you)')
  expect(text).toMatch(/\n1 open issue · main CI ✗ failed$/)
})

test("without gh the pane stays up and says what to do", async ($, on) => {
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') return ran('https://github.com/acme/app.git\n')
    if (e.argv[0] === 'date') return ran('+0300\n')
    // A program that can't be found refuses the call.
    return { deny: 'spawn gh ENOENT' }
  })
  await startSession($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect((await ui.find({ type: 'Text', text: /gh/ }))?.text).toBe(
      'GitHub CLI (gh) not found. Install it: brew install gh, then gh auth login.',
    )
    await ui.unmount()
  }
})

test('with no repo it says how to add one', async ($, on) => {
  on('process.run', () => ran('', 128))
  await startSession($, on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No repo/ }))?.text).toBe('No repo picked yet.')
  await ui.unmount()
})
