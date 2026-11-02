import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'ekip-paneli',
  component: 'Pane',
  requestId: 'ekip',
  props: {
    title: 'Ekip',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const sonuc = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: exitCode ? 'hata' : '', isStdoutTruncated: false, isStderrTruncated: false },
})
const json = (x: unknown) => sonuc(JSON.stringify(x))
const iso = (saniyeOnce: number) => new Date(Date.now() - saniyeOnce * 1000).toISOString()

/** Bir depoyu ve gh'nin her sorusunu oynayan sahte makine. */
const sahteGitHub = (on: On) => {
  on('process.run', (_, e) => {
    const [komut, ...g] = e.argv
    const s = g.join(' ')
    if (komut === 'git') return sonuc('git@github.com:acme/app.git\n')
    if (komut === 'date') return sonuc('+0300\n')
    if (komut !== 'gh') return sonuc('', 127)
    if (s === 'api user --jq .login') return sonuc('ayse\n')
    if (g[1] === 'repos/acme/app') return json({ varsayilan: 'main', tam: 'acme/app' })
    if (g[1]?.startsWith('repos/acme/app/contributors')) {
      return json([
        { login: 'ayse', katki: 50, tur: 'User' },
        { login: 'mert', katki: 30, tur: 'User' },
        { login: 'dependabot[bot]', katki: 5, tur: 'Bot' },
      ])
    }
    if (g[1]?.startsWith('repos/acme/app/collaborators')) return json(['ayse', 'mert', 'zeynep'])
    if (g[1]?.startsWith('repos/acme/app/activity')) {
      return json([
        { at: iso(600), login: 'mert', tur: 'push', ref: 'refs/heads/ozellik/giris', sonra: 'abc' },
        { at: iso(3600), login: 'mert', tur: 'push', ref: 'refs/heads/deneme', sonra: 'def' },
        { at: iso(7200), login: 'ayse', tur: 'branch_deletion', ref: 'refs/heads/eski', sonra: '0000' },
        { at: iso(9000), login: 'mert', tur: 'push', ref: 'refs/heads/eski', sonra: 'fed' },
      ])
    }
    if (g[0] === 'pr' && g.includes('open')) {
      return json([
        {
          number: 7,
          title: 'Giriş ekranı',
          author: { login: 'mert' },
          headRefName: 'ozellik/giris',
          isDraft: false,
          reviewDecision: 'REVIEW_REQUIRED',
          reviewRequests: [{ login: 'ayse' }],
          statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
          updatedAt: iso(300),
          url: 'https://github.com/acme/app/pull/7',
        },
      ])
    }
    if (g[0] === 'pr' && g.includes('merged')) {
      return json([{ number: 5, title: 'README', author: { login: 'ayse' }, headRefName: 'readme', mergedAt: iso(86400 * 2) }])
    }
    if (g[1]?.startsWith('repos/acme/app/commits?')) return json([{ login: 'mert' }, { login: 'mert' }, { login: 'ayse' }])
    if (g[1] === 'repos/acme/app/commits/abc') return sonuc('Giriş formu eklendi\n')
    if (g[0] === 'issue') return json([{ assignees: [{ login: 'mert' }] }])
    if (g[0] === 'run') return json([{ status: 'completed', conclusion: 'failure' }])
    if (g[1] === 'users/mert') return sonuc('Mert Kaya\n')
    if (g[1]?.startsWith('users/')) return sonuc('\n')

    return sonuc('', 1)
  })
}

const oturumuBaslat = async ($: Parameters<TestBody>[0], on: On) => {
  on('command.register', () => ({ value: { command: 'ekip' } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  mock.store(on)
  mock.env(on, { HOME: '/ev' })
  await $.session.start({ cwd: '/proje', surface: 'desktop', isInteractive: true })
}

test('seçilen depodaki kişileri, PR\'larını ve senden bekleneni gösterir', async ($, on) => {
  sahteGitHub(on)
  await oturumuBaslat($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'yenile' })

    expect((await ui.find({ type: 'Text', text: /^acme\/app$/ }))?.text).toBe('acme/app')
    expect((await ui.find({ type: 'Text', text: /Senden inceleme/ }))?.text).toBe('Senden inceleme bekleyen (1)')
    expect((await ui.find({ type: 'Text', text: /^Mert Kaya$/ }))?.text).toBe('Mert Kaya')
    expect((await ui.find({ type: 'Text', text: /ozellik\/giris —/ }))?.text).toMatch(
      /^10 dk önce \(\d\d:\d\d\) · ozellik\/giris — Giriş formu eklendi$/,
    )
    expect((await ui.find({ type: 'Text', text: /CI ✓/ }))?.text).toBe('· CI ✓ · inceleme bekliyor · bekleyen: ayse')
    // Silinmiş "eski" dal ve PR'ı olan dal sayılmaz.
    expect((await ui.find({ type: 'Text', text: /PR'sız dal/ }))?.text).toBe("PR'sız dal: deneme")
    expect((await ui.find({ type: 'Text', text: /^7 günde 2 commit/ }))?.text).toBe('7 günde 2 commit · 1 açık iş')
    expect((await ui.find({ type: 'Text', text: /^7 günde 1 commit/ }))?.text).toBe(
      '7 günde 1 commit · 1 PR incelemesini bekliyor',
    )
    expect((await ui.find({ type: 'Text', text: /^Açık PR/ }))?.text).toBe('Açık PR 1 · açık iş 1 · main CI ✗ kaldı')
    expect(await ui.find({ type: 'Text', text: /En çok katkı verenler/ })).toBeDefined()
    // Bot listeye girmez; ekip üyesi olup hiç commit atmamış zeynep girer.
    expect(await ui.find({ type: 'Text', text: /dependabot/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^@zeynep/ }))?.text).toBe('@zeynep')
    await ui.unmount()
  }
})

test('ayarlarda birini çıkarınca panelde artık görünmez', async ($, on) => {
  sahteGitHub(on)
  await oturumuBaslat($, on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'yenile' })
  await ui.press({ key: 'ayar' })
  expect((await ui.find({ type: 'Text', text: /Kimi görmek/ }))?.text).toBe('Kimi görmek istiyorsun? · acme/app')
  await ui.press({ key: 'kisi:zeynep' })
  await ui.press({ key: 'geri' })

  expect(await ui.find({ type: 'Text', text: /^@zeynep/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^@mert/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /En çok katkı verenler/ })).toBeUndefined()
  await ui.unmount()
})

test('gh yoksa panel düşmez, ne yapılacağını söyler', async ($, on) => {
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') return sonuc('https://github.com/acme/app.git\n')
    if (e.argv[0] === 'date') return sonuc('+0300\n')
    // Program bulunamayınca çağrı reddedilir.
    return { deny: 'spawn gh ENOENT' }
  })
  await oturumuBaslat($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'yenile' })
    expect((await ui.find({ type: 'Text', text: /gh/ }))?.text).toBe(
      'GitHub CLI (gh) bulunamadı. Kur: brew install gh, sonra gh auth login.',
    )
    await ui.unmount()
  }
})

test('depo yoksa nasıl ekleneceğini söyler', async ($, on) => {
  on('process.run', () => sonuc('', 128))
  await oturumuBaslat($, on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /depo seçilmedi/ }))?.text).toBe('Henüz bir depo seçilmedi.')
  await ui.unmount()
})
