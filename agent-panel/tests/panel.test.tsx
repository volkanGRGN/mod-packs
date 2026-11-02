import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'agent-panel',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 29 }, view: {} },
} as const

const PANE = {
  plugin: 'agent-panel',
  component: 'Pane',
  requestId: 'agent',
  props: { title: 'Assistant', isFocused: true, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const HOME = '/h'
const PROJECTS = '/h/Desktop/PROJELER'
const CWD = `${PROJECTS}/volki`
const CONNECTED = `${HOME}/.config/agent-panel/agent.json`

type On = Parameters<Parameters<typeof test>[1]>[1]
type Ran = { exitCode: number; stdout: string; stderr: string }
type Run = (argv: readonly string[], stdin?: string) => Ran | Promise<Ran>

/**
 * The engine beneath the plugin: files by path, a project folder with
 * neighbours, a repository whose remote names the project, a shell that finds
 * node, and a sidebar that records what opens and closes.
 */
function engine(on: On, files: Record<string, string> = {}, run?: Run, picked?: string) {
  const panes: string[] = []
  const written: Record<string, string> = {}
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'ajan' } }))
  // The band's own drawing beneath the plugin: nothing.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.open', (_, e) => {
    panes.push(`open ${e.id} "${e.title}" ${e.columns}`)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    panes.push(`close ${e.id}`)
    return { value: undefined }
  })
  on('env.get', () => ({ value: HOME }))
  on('fs.read', (_, e) => {
    const path = String(e.path)
    if (path in written) return { value: written[path] }
    if (path in files) return { value: files[path] }
    throw new Error('ENOENT')
  })
  on('fs.write', (_, e) => {
    written[String(e.path)] = String(e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: String(e.path) in files || String(e.path) === `${CWD}/scripts/ask.ts` }))
  on('fs.list', (_, e) => ({
    value: String(e.path) === PROJECTS
      ? [
          { name: 'dershane', kind: 'dir', size: 0 },
          { name: 'volki', kind: 'dir', size: 0 },
          { name: '.git', kind: 'dir', size: 0 },
          { name: 'notes.txt', kind: 'file', size: 3 },
        ]
      : [{ name: 'src', kind: 'dir', size: 0 }],
  }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: CWD }))
  on('process.run', async (_, e) => {
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: 'https://github.com/someone/personal-agent.git\n', stderr: '' } }
    if (e.argv[0] === '/bin/zsh') return { value: { exitCode: 0, stdout: '/usr/local/bin/node\n', stderr: '' } }
    if (e.argv[0] === 'mkdir') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    // The Mac's folder picker: the folder chosen, or closed with none (-128).
    if (e.argv[0] === 'osascript') return { value: picked ? { exitCode: 0, stdout: `${picked}\n`, stderr: '' } : { exitCode: 1, stdout: '', stderr: 'User canceled. (-128)' } }
    return { value: run ? await run(e.argv, e.init?.stdin) : { exitCode: 0, stdout: 'Şu an **testler** yeşil.\n', stderr: '' } }
  })

  return { panes, written }
}

/** A button's words without the padding that stretches it across the strip. */
const words = (b?: { text?: string }) => (b?.text ?? '').replace(/\u00a0/g, ' ').trim()

/** The field's key: it changes after every message sent, which gives a new, empty field. */
const fieldKey = async (ui: { find: (q: { type: string }) => Promise<{ key?: string } | undefined> }) =>
  (await ui.find({ type: 'Input' }))?.key ?? 'ask-0'

const CONNECTED_VOLKI = { [CONNECTED]: JSON.stringify({ name: 'volki', command: ['node', '/agent/ask.ts'] }) }

test('the bare button above the prompt opens Assistant in the sidebar, and closes it', async ($, on) => {
  const { panes } = engine(on, CONNECTED_VOLKI)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(words(await band.find({ type: 'Button', key: 'fab' }))).toBe('✳ Assistant')
  await band.press({ key: 'fab' })
  expect(panes).toEqual(['open agent "Assistant · personal-agent" 36'])
  expect(words(await band.find({ type: 'Button', key: 'fab' }))).toBe('✕ Assistant')
  await band.press({ key: 'fab' })
  expect(panes.at(-1)).toBe('close agent')
  expect(words(await band.find({ type: 'Button', key: 'fab' }))).toBe('✳ Assistant')
  await band.unmount()
})

test('the chat opens with the name and the project at the top, the settings at the right, nothing else', async ($, on) => {
  engine(on, CONNECTED_VOLKI)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Assistant' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'personal-agent' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '~/Desktop/PROJELER/volki' })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['settings'])
  expect((await ui.find({ type: 'Input' }))?.props.submitLabel).toBe('↑')
  expect((await ui.find({ type: 'Input' }))?.props.placeholder).toBeUndefined()
  await ui.unmount()
})

test("the settings open the Mac's folder picker where the project sits, and connect the folder chosen", async ($, on) => {
  const { written } = engine(
    on,
    { [`${PROJECTS}/volki/agent-panel.json`]: JSON.stringify({ name: 'volki', command: ['node', 'scripts/ask.ts'] }) },
    undefined,
    `${PROJECTS}/volki/`,
  )
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings' })
  expect(await ui.find({ type: 'Text', text: "Bu oturumun Claude'u" })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['settings', 'yes', 'no', 'pick'])
  await ui.press({ key: 'pick' })

  expect(JSON.parse(written[CONNECTED] ?? '{}')).toEqual({
    name: 'volki',
    command: ['/usr/local/bin/node', `${PROJECTS}/volki/scripts/ask.ts`],
    folder: `${PROJECTS}/volki`,
  })
  expect((await ui.find({ type: 'Input' }))?.props.submitLabel).toBe('↑')
  await ui.unmount()
})

test('a folder with no agent says so; closing the picker changes nothing', async ($, on) => {
  const { written } = engine(on, {}, undefined, `${PROJECTS}/dershane/`)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings' })
  await ui.press({ key: 'pick' })
  expect(await ui.find({ type: 'Text', text: /dershane klasöründe agent-panel\.json yok/ })).toBeDefined()
  expect(written[CONNECTED]).toBeUndefined()
  await ui.unmount()
})

const VOLKI_FILES = {
  [`${PROJECTS}/volki/agent-panel.json`]: JSON.stringify({ name: 'volki', command: ['node', 'scripts/ask.ts'] }),
  [`${PROJECTS}/volki/persona.md`]: '# volki',
}

test('the settings ask whether the agent found nearby is yours, and yes connects it', async ($, on) => {
  const { written } = engine(on, VOLKI_FILES)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Bu senin ajanın mı?' })).toBeUndefined()
  await ui.press({ key: 'settings' })
  expect(await ui.find({ type: 'Text', text: 'Bu senin ajanın mı?' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'PROJELER/volki' })).toBeDefined()
  await ui.press({ key: 'yes' })

  expect(JSON.parse(written[CONNECTED] ?? '{}').folder).toBe(`${PROJECTS}/volki`)
  expect(await ui.find({ type: 'Text', text: 'Bu senin ajanın mı?' })).toBeUndefined()
  await ui.unmount()
})

test('a no is remembered; a folder with a persona but no way in is named with what it lacks', async ($, on) => {
  const { written } = engine(on, { ...VOLKI_FILES, [`${PROJECTS}/dershane/persona.md`]: '# dershane' })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings' })
  expect(await ui.find({ type: 'Text', text: 'PROJELER/volki' })).toBeDefined()
  await ui.press({ key: 'no' })
  expect(await ui.find({ type: 'Text', text: 'PROJELER/dershane' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /agent-panel\.json eklenmeli/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'yes' })).toBeUndefined()
  await ui.press({ key: 'no' })
  expect(await ui.find({ type: 'Text', text: 'Bu senin ajanın mı?' })).toBeUndefined()
  expect(written[CONNECTED]).toBeUndefined()
  await ui.unmount()
})

test('disconnecting gives the chat back to Claude', async ($, on) => {
  const { written } = engine(on, CONNECTED_VOLKI)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings' })
  expect(await ui.find({ type: 'Text', text: 'volki' })).toBeDefined()
  await ui.press({ key: 'disconnect' })
  expect(written[CONNECTED]).toBe('{}\n')
  expect(await ui.find({ type: 'Text', text: "Bu oturumun Claude'u" })).toBeDefined()
  await ui.unmount()
})

test('the connected agent answers, with the session it is asked from', async ($, on) => {
  const runs: Array<{ argv: readonly string[]; stdin?: string }> = []
  engine(on, CONNECTED_VOLKI, (argv, stdin) => {
    runs.push({ argv, stdin })
    return { exitCode: 0, stdout: 'Şu an **testler** yeşil.\n', stderr: '' }
  })
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'testleri düzelt', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 't1', tool: 'Read', input: { file_path: `${CWD}/src/a.ts` } },
          { tool_use_id: 't2', tool: 'Edit', input: { file_path: `${CWD}/src/a.ts` } },
          { tool_use_id: 't3', tool: 'Edit', input: { file_path: '/etc/hosts' }, isError: true },
        ],
      },
      { role: 'assistant', text: 'düzelttim', toolUses: [] },
    ],
  }))
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.input({ key: await fieldKey(ui), text: 'ne durumdayız?' })

    expect(runs.at(-1)?.argv).toEqual(['node', '/agent/ask.ts'])
    expect(JSON.parse(runs.at(-1)?.stdin ?? '{}')).toEqual({
      question: 'ne durumdayız?',
      session: {
        id: 'sess-1',
        cwd: CWD,
        messages: [
          { role: 'user', text: 'testleri düzelt' },
          { role: 'assistant', text: 'düzelttim' },
        ],
        touched: ['Edit src/a.ts', 'Edit /etc/hosts (hata)'],
      },
    })
    expect((await ui.findAll({ type: 'Markdown' })).at(-1)?.text).toBe('Şu an **testler** yeşil.')
    expect(await ui.find({ type: 'Text', text: 'ne durumdayız?' })).toBeDefined()
    await ui.unmount()
  }
})

test("with nothing connected, the session's Claude answers: nothing to set up", async ($, on) => {
  engine(on)
  const forks: string[] = []
  on('model.fork', (_, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: 'Testler yeşil, sırada dokümantasyon var.', usage: USAGE } }
  })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: await fieldKey(ui), text: 'Sıradaki adım ne?' })

  expect(forks.at(-1)).toContain('Soru: Sıradaki adım ne?')
  expect((await ui.findAll({ type: 'Markdown' })).at(-1)?.text).toBe('Testler yeşil, sırada dokümantasyon var.')
  await ui.unmount()
})

test('while waiting, the box holds a stop button: pressing it ends the question and asks the agent to stop', async ($, on) => {
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  // Should the kit run one act at a time, the answer comes anyway and the stop finds nothing.
  setTimeout(() => release(), 2000)
  const requests: Array<{ question?: string; cancel?: boolean; session?: { id?: string } }> = []
  engine(on, CONNECTED_VOLKI, async (_argv, stdin) => {
    const req = JSON.parse(stdin ?? '{}')
    requests.push(req)
    if (req.cancel) return { exitCode: 0, stdout: 'durduruldu', stderr: '' }
    await gate
    return { exitCode: 0, stdout: 'geç kalan cevap', stderr: '' }
  })
  on('session.messages', () => ({ value: [] }))
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const field = await fieldKey(ui)
  const sent = ui.input({ key: field, text: 'uzun iş' })
  for (let i = 0; i < 200 && requests.length === 0; i++) await new Promise(r => setTimeout(r, 5))
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  await ui.press({ key: 'stop' })
  release()
  await sent

  expect(requests[0]?.question).toBe('uzun iş')
  expect(requests[1]).toEqual({ cancel: true, session: { id: 'sess-1' } })
  expect(await ui.find({ type: 'Text', text: 'Durduruldu.' })).toBeDefined()
  expect(await ui.findAll({ type: 'Markdown' })).toEqual([])
  expect((await ui.find({ type: 'Input' }))?.props.submitLabel).toBe('↑')
  await ui.unmount()
})

test('the field keeps its own text, and a new empty field comes after each message', async ($, on) => {
  engine(on, CONNECTED_VOLKI)
  on('session.messages', () => ({ value: [] }))
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const before = await fieldKey(ui)
  expect((await ui.find({ type: 'Input' }))?.props.value).toBeUndefined()
  await ui.input({ key: before, text: 'bir' })
  expect(await fieldKey(ui)).not.toBe(before)
  await ui.unmount()
})

test('a command that fails says why, in the chat', async ($, on) => {
  engine(on, CONNECTED_VOLKI, () => ({ exitCode: 1, stdout: '', stderr: "volki'ye ulaşılamadı (çalışıyor mu?)" }))
  on('session.messages', () => ({ value: [] }))
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: await fieldKey(ui), text: 'selam' })

  expect(await ui.find({ type: 'Text', text: /ulaşılamadı/ })).toBeDefined()
  await ui.unmount()
})

test('an answer taller than the sidebar is drawn whole, for the sidebar to scroll', async ($, on) => {
  const long = Array.from({ length: 80 }, (_, i) => `satır ${i}`).join('\n')
  engine(on, CONNECTED_VOLKI, () => ({ exitCode: 0, stdout: long, stderr: '' }))
  on('session.messages', () => ({ value: [] }))
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: await fieldKey(ui), text: 'uzun anlat' })

  expect((await ui.findAll({ type: 'Markdown' })).at(-1)?.text).toBe(long)
  await ui.unmount()
})
