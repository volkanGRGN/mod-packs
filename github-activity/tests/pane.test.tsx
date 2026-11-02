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

/** A machine that plays one repo and answers every gh question about it. */
const fakeGitHub = (on: On) => {
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
    if (a[0] === 'pr' && a.includes('open')) {
      return json([
        {
          number: 7,
          title: 'Login screen',
          author: { login: 'mert' },
          headRefName: 'feature/login',
          isDraft: false,
          reviewDecision: 'REVIEW_REQUIRED',
          reviewRequests: [{ login: 'ayse' }],
          statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
          updatedAt: iso(300),
          url: 'https://github.com/acme/app/pull/7',
        },
      ])
    }
    if (a[0] === 'pr' && a.includes('merged')) {
      return json([{ number: 5, title: 'README', author: { login: 'ayse' }, headRefName: 'readme', mergedAt: iso(86400 * 2) }])
    }
    if (path.startsWith('repos/acme/app/commits?')) {
      // Pages come as tab-separated lines: login, date, first line of the message.
      return ran(
        [`mert\t${iso(700)}\tAdd the login form`, `mert\t${iso(4000)}\tSpike`, `ayse\t${iso(5000)}\tFix the README`, `zeynep\t${iso(90000)}\tFirst commit`].join('\n') + '\n',
      )
    }
    if (a[1] === 'repos/acme/app/commits/abc') return ran('Add the login form\n')
    if (a[0] === 'issue') return json([{ assignees: [{ login: 'mert' }] }])
    if (a[0] === 'run') return json([{ status: 'completed', conclusion: 'failure' }])
    if (a[1] === 'users/mert') return ran('Mert Kaya\n')
    if (a[1]?.startsWith('users/')) return ran('\n')

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

test("shows the picked repo's people, their PRs and what waits on you", async ($, on) => {
  fakeGitHub(on)
  await startSession($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })

    expect((await ui.find({ type: 'Text', text: /^acme\/app$/ }))?.text).toBe('acme/app')
    expect((await ui.find({ type: 'Text', text: /Waiting on your/ }))?.text).toBe('Waiting on your review (1)')
    expect((await ui.find({ type: 'Text', text: /^Mert Kaya$/ }))?.text).toBe('Mert Kaya')
    expect((await ui.find({ type: 'Text', text: /feature\/login —/ }))?.text).toMatch(
      /^10 min ago \(\d\d:\d\d\) · feature\/login — Add the login form$/,
    )
    expect((await ui.find({ type: 'Text', text: /CI ✓/ }))?.text).toBe('· CI ✓ · review required · waiting on ayse')
    // The deleted "old" branch and the branch with a PR don't count.
    expect((await ui.find({ type: 'Text', text: /without a PR/ }))?.text).toBe('Branches without a PR: spike')
    expect((await ui.find({ type: 'Text', text: /^2 commits/ }))?.text).toBe('2 commits in 7 days · 1 open issue')
    expect((await ui.find({ type: 'Text', text: /reviewing/ }))?.text).toBe('1 commits in 7 days · reviewing 1 PR')
    expect((await ui.find({ type: 'Text', text: /^Open PRs/ }))?.text).toBe('Open PRs 1 · open issues 1 · main CI ✗ failed')
    expect(await ui.find({ type: 'Text', text: /top contributors/ })).toBeDefined()
    // Bots stay out; zeynep, a collaborator with no commits, is in.
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
  expect(text).toMatch(/^acme\/app\n\nWaiting on your review \(1\):\n- #7 Login screen — mert\n/)
  expect(text).toContain('Mert Kaya (@mert)\n10 min ago')
  expect(text).toContain('- PR #7 Login screen · CI ✓ · review required · waiting on ayse')
  expect(text).toContain('ayse (@ayse, you)')
  expect(text).toMatch(/Open PRs 1 · open issues 1 · main CI ✗ failed$/)
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
