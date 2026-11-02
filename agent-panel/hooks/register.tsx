import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { Agent, Candidate, ChatLine, Project } from '../types'

// Assistant: a chat with one's own agent beside every session. A button at the
// right, just above the prompt, opens it in the sidebar; closing it gives the
// sidebar back to whatever was there. It reads as Claude's own chat does: the
// name and the project at the top, the person's words in a gray bubble on the
// right, the answer as plain text, the newest at the bottom above a prompt box.
// The ⚙ at the top right connects an agent by its folder.
//
// Who answers: the command in the mod's settings, else the agent connected in
// ~/.config/agent-panel/agent.json ({ "name", "command": [argv] }), else the
// session's own Claude. An agent's folder introduces it with agent-panel.json
// in the same shape, its paths relative to the folder. An agent gets the
// question with this session's folder, last words and touched files as JSON on
// standard input, and prints its answer.

const NAME = 'Assistant'
/**
 * Claude's own dark gray behind the person's messages, and the light text on it.
 * Written out: the app does not hand its theme's name for it to a mod.
 */
const USER_BUBBLE = 'rgb(55,55,55)'
const USER_TEXT = 'rgb(240,240,240)'
const PANE = 'agent'
// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const chat = atom({ plugin: 'agent-panel', key: 'chat' } as const, [], { shape: 'chat-1' })
const busy = atom({ plugin: 'agent-panel', key: 'busy' } as const, false)
const asking = atom({ plugin: 'agent-panel', key: 'asking' } as const, '')
const isOpen = atom({ plugin: 'agent-panel', key: 'isOpen' } as const, false)
const hasUnread = atom({ plugin: 'agent-panel', key: 'hasUnread' } as const, false)
const agent = atom({ plugin: 'agent-panel', key: 'agent' } as const, { name: 'Claude', argv: [] }, { shape: 'agent-1' })
const project = atom({ plugin: 'agent-panel', key: 'project' } as const, { name: '', path: '' }, { shape: 'project-1' })
const isSettings = atom({ plugin: 'agent-panel', key: 'isSettings' } as const, false)
const notice = atom({ plugin: 'agent-panel', key: 'notice' } as const, '')
const candidates = atom({ plugin: 'agent-panel', key: 'candidates' } as const, [], { shape: 'candidates-1' })
const dismissed = atom({ plugin: 'agent-panel', key: 'dismissed' } as const, [], { shape: 'dismissed-1' })

/** How much of the session rides along with a question. */
const MESSAGES = 12
const CHARS_PER_MESSAGE = 2000
const TOUCHED = 15
/** An agent may work a while; ten minutes is the most a command may run. */
const ANSWER_MS = 10 * 60_000
/** Lines kept. */
const KEPT = 100
/** Rows between one message and the next. */
const GAP = 2
/** Rows the header and the prompt box take, around the conversation. */
const HEADER_ROWS = 4
const COMPOSER_ROWS = 4
/** How wide the sidebar is asked to open: about half its usual width. The app may keep its own. */
const PANE_COLUMNS = 36
/** The file a folder introduces its agent with, and where the connected one is kept. */
const MANIFEST = 'agent-panel.json'
const CONNECTED = '.config/agent-panel/agent.json'
/** Files that mark a folder as an agent's: a persona of its own. CLAUDE.md and AGENTS.md are in every project and mark nothing. */
const PERSONA_FILES = ['persona.md', 'SOUL.md']
/** How long the folder picker may stay open. */
const PICK_MS = 5 * 60_000

type Parts = Pick<Elements['desktop'] & Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Input' | 'Select' | 'Markdown'>

/** Reads an agent file: a name and a command of strings, or nothing. */
function parseAgent(text: string): { name: string; command: string[] } | undefined {
  try {
    const own = JSON.parse(text)
    const ok = Array.isArray(own?.command) && own.command.length > 0 && own.command.every((a: unknown) => typeof a === 'string')
    if (!ok) return undefined
    return { name: typeof own.name === 'string' && own.name.trim() ? own.name.trim() : 'Ajan', command: own.command }
  } catch {
    return undefined
  }
}

/** Who answers here: the settings' command, else the connected agent, else the session's Claude. */
async function findAgent($: EngineInterface, name: string, command: string): Promise<Agent> {
  const argv = command.trim().split(/\s+/).filter(Boolean)
  if (argv.length) return { name: name.trim() || 'Ajan', argv }
  const home = await $.env.get('HOME')
  if (home) {
    try {
      const own = parseAgent(String(await $.fs.read(`${home}/${CONNECTED}`)))
      if (own) return { name: own.name, argv: own.command }
    } catch {
      // Nothing connected: the session's Claude answers.
    }
  }

  return { name: 'Claude', argv: [] }
}

/** The project as the app names it: the repository's name from its remote, else the folder's own name. */
async function findProject($: EngineInterface, cwd: string): Promise<Project> {
  const folder = cwd.split('/').filter(Boolean).at(-1) ?? cwd
  const home = (await $.env.get('HOME')) ?? ''
  const path = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
  try {
    const remote = await $.process.run(['git', '-C', cwd, 'remote', 'get-url', 'origin'], { timeoutMs: 3000 })
    const name = remote.exitCode === 0 ? remote.stdout.trim().replace(/\.git$/, '').split(/[/:]/).at(-1) : undefined
    return { name: name || folder, path }
  } catch {
    return { name: folder, path }
  }
}

/**
 * Looks through the project's folder and the folders beside it for ones that
 * look like an agent: a persona of its own, or the file that says how to reach
 * it. Those with the file can be connected at once; the rest are named, with
 * what they lack.
 */
async function detectAgents($: EngineInterface): Promise<Candidate[]> {
  const cwd = await $.session.cwd()
  const parent = cwd.split('/').slice(0, -1).join('/') || '/'
  const found: Candidate[] = []
  try {
    const dirs = (await $.fs.list(parent)).filter(entry => entry.kind === 'dir' && !entry.name.startsWith('.')).slice(0, 80)
    for (const dir of dirs) {
      const folder = `${parent}/${dir.name}`
      let own
      if (await $.fs.exists(`${folder}/${MANIFEST}`)) {
        try {
          own = parseAgent(String(await $.fs.read(`${folder}/${MANIFEST}`)))
        } catch {
          own = undefined
        }
      }
      let persona = false
      for (const file of PERSONA_FILES) if (!persona && (await $.fs.exists(`${folder}/${file}`))) persona = true
      if (own) found.push({ name: own.name, folder, ready: true })
      else if (persona) found.push({ name: dir.name, folder, ready: false })
    }
  } catch {
    // the folder cannot be listed: nothing to suggest
  }

  return found.sort((a, b) => Number(b.ready) - Number(a.ready))
}

async function refreshCandidates($: EngineInterface) {
  const found = await detectAgents($)
  await update($, candidates, () => found)
}

async function dismiss($: EngineInterface, folder: string) {
  await update($, dismissed, list => [...new Set([...list, folder])])
}

/**
 * The Mac's own folder picker, opened where the project sits; the folder
 * chosen is connected. Closed without a choice, nothing happens.
 */
async function pickFolder($: EngineInterface) {
  const cwd = await $.session.cwd()
  const start = cwd.split('/').slice(0, -1).join('/') || '/'
  await update($, notice, () => '')
  const picked = await $.process
    .run(
      [
        'osascript',
        '-e', 'on run argv',
        '-e', 'POSIX path of (choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv)))',
        '-e', 'end run',
        'Ajanının klasörünü seç', start,
      ],
      { timeoutMs: PICK_MS },
    )
    .catch(() => undefined)
  if (!picked || picked.exitCode !== 0 || !picked.stdout.trim()) return
  await connect($, picked.stdout.trim())
}

/**
 * Connects the agent a folder introduces: its paths made whole, a bare program
 * name found the way the person's own shell finds it, and the result kept for
 * every session.
 */
async function connect($: EngineInterface, typed: string) {
  const home = (await $.env.get('HOME')) ?? ''
  const folder = typed.trim().replace(/^~(?=\/|$)/, home).replace(/\/+$/, '')
  if (!folder) return
  let own
  try {
    own = parseAgent(String(await $.fs.read(`${folder}/${MANIFEST}`)))
  } catch {
    own = undefined
  }
  if (!own) {
    await update($, notice, () => `${folder.split('/').at(-1) ?? folder} klasöründe ${MANIFEST} yok; bu klasör bir ajan tanıtmıyor.`)
    return
  }
  const [program, ...rest] = own.command
  let first = program ?? ''
  if (first.startsWith('./') || (first.includes('/') && !first.startsWith('/'))) first = `${folder}/${first.replace(/^\.\//, '')}`
  else if (!first.includes('/')) {
    const where = await $.process.run(['/bin/zsh', '-lc', 'command -v -- "$1"', 'zsh', first], { timeoutMs: 5000 })
    if (where.exitCode === 0 && where.stdout.trim().startsWith('/')) first = where.stdout.trim().split('\n')[0] ?? first
  }
  const args = []
  for (const arg of rest) {
    const inside = !arg.startsWith('/') && !arg.startsWith('-') && (await $.fs.exists(`${folder}/${arg}`))
    args.push(inside ? `${folder}/${arg.replace(/^\.\//, '')}` : arg)
  }
  const command = [first, ...args]
  await $.process.run(['mkdir', '-p', `${home}/.config/agent-panel`], { timeoutMs: 5000 })
  await $.fs.write(`${home}/${CONNECTED}`, `${JSON.stringify({ name: own.name, command, folder }, null, 2)}\n`)
  await update($, agent, () => ({ name: own.name, argv: command }))
  await update($, notice, () => `${own.name} bağlandı.`)
  await update($, isSettings, () => false)
}

/** Lets the session's own Claude answer again. */
async function disconnect($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  await $.fs.write(`${home}/${CONNECTED}`, '{}\n')
  await update($, agent, () => ({ name: 'Claude', argv: [] }))
  await update($, notice, () => 'Bağlantı kesildi; bu oturumun Claude\'u cevap veriyor.')
}

async function openSettings($: EngineInterface, open: boolean) {
  await update($, notice, () => '')
  await update($, isSettings, () => open)
  if (open) await refreshCandidates($)
}

async function add($: EngineInterface, who: ChatLine['who'], text: string) {
  const at = Date.now()
  await update($, chat, lines => [...lines, { id: `${who}-${at}-${lines.length}`, who, text, at }].slice(-KEPT))
}

/** The files the session worked on last, a tool and a path each: where it is, never what is in them. */
function touchedFiles(uses: Array<{ tool: string; input: Record<string, unknown>; isError?: true }>, cwd: string): string[] {
  const seen = new Map<string, string>()
  for (const use of uses) {
    const path = use.input.file_path ?? use.input.path ?? use.input.notebook_path
    if (typeof path !== 'string' || !path) continue
    const shown = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
    seen.delete(shown)
    seen.set(shown, `${use.tool} ${shown}${use.isError ? ' (hata)' : ''}`)
  }

  return [...seen.values()].slice(-TOUCHED)
}

/** Asks whoever answers here, and adds what comes back. */
async function ask($: EngineInterface, typed: string) {
  const question = typed.trim()
  if (!question || (await read($, busy))) return
  const who = await read($, agent)
  const asked = `q-${Date.now()}`
  await add($, 'me', question)
  await update($, asking, () => asked)
  await update($, busy, () => true)
  let answer: { who: ChatLine['who']; text: string }
  try {
    if (!who.argv.length) {
      // The session's own Claude, over its own transcript, with no tools.
      const r = await $.model.fork({
        prompt: `Bu soru, bu oturumun yanındaki sohbet kutusundan geliyor; ana işe dokunma, yalnız buraya cevap ver. Kısa yaz, gerekiyorsa adım adım öner.\n\nSoru: ${question}`,
      })
      answer = r.isAnswered
        ? { who: 'agent', text: r.text.trim() || '(boş cevap)' }
        : { who: 'error', text: r.reason === 'nothing-to-fork' ? 'Bu oturumda henüz konuşma yok; önce bir mesaj yaz.' : `Cevap alınamadı (${r.reason}).` }
    } else {
      const [id, cwd, all] = await Promise.all([$.session.id(), $.session.cwd(), $.session.messages()])
      const messages = all
        .filter(m => m.text.trim())
        .slice(-MESSAGES)
        .map(m => ({ role: m.role, text: m.text.slice(0, CHARS_PER_MESSAGE) }))
      const touched = touchedFiles(all.slice(-40).flatMap(m => m.toolUses), cwd)
      const ran = await $.process.run(who.argv, {
        cwd,
        stdin: JSON.stringify({ question, session: { id, cwd, messages, touched } }),
        timeoutMs: ANSWER_MS,
      })
      answer = ran.exitCode === 0
        ? { who: 'agent', text: ran.stdout.trim() || '(boş cevap)' }
        : { who: 'error', text: ran.stderr.trim() || `Komut ${ran.exitCode} koduyla bitti.` }
    }
  } catch (err) {
    // The command did not start, or ran past the ten minutes.
    answer = { who: 'error', text: `Cevap alınamadı: ${err instanceof Error ? err.message : String(err)}` }
  }
  // Stopped meanwhile: what came back belongs to nobody, and the stop has said so.
  if ((await read($, asking)) !== asked) return
  await add($, answer.who, answer.text)
  await update($, asking, () => '')
  await update($, busy, () => false)
  if (!(await read($, isOpen))) await update($, hasUnread, () => true)
}

/**
 * The stop button, as Claude's: the question no longer waits, and the agent is
 * asked to stop the work too, with the same command and a stop request on
 * standard input. An agent that does not know the request just fails it.
 */
async function stop($: EngineInterface) {
  if (!(await read($, asking))) return
  const who = await read($, agent)
  await update($, asking, () => '')
  await update($, busy, () => false)
  await add($, 'note', 'Durduruldu.')
  if (!who.argv.length) return
  const id = await $.session.id()
  await $.process.run(who.argv, { stdin: JSON.stringify({ cancel: true, session: { id } }), timeoutMs: 10_000 }).catch(() => undefined)
}

/** Opens the chat in the sidebar, or closes it and gives the sidebar back. */
async function setOpen($: EngineInterface, title: string, open: boolean) {
  if (open) {
    await $.ui.open({ id: PANE, title, focus: true, columns: PANE_COLUMNS })
    await update($, hasUnread, () => false)
  } else {
    await $.ui.close({ id: PANE })
  }
  await update($, isOpen, () => open)
}

/** The tab's title: the name, and the project it is asked about. */
function titleOf(where: Project): string {
  return where.name ? `${NAME} · ${where.name}` : NAME
}

/** Rows a text takes in a given width, roughly: each line, wrapped. */
function rowsOf(text: string, width: number): number {
  return text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / Math.max(10, width))), 0)
}

/**
 * The newest lines that fit the rows the conversation has, so it fills from
 * the bottom up as Claude's does. Null when the newest alone does not fit: then
 * the whole of it is drawn and the pane scrolls.
 */
function fitting(lines: ChatLine[], width: number, rows: number): ChatLine[] | null {
  const shown: ChatLine[] = []
  let left = rows
  for (const line of [...lines].reverse()) {
    const need = rowsOf(line.text, line.who === 'me' ? width - 8 : width - 2) + (line.who === 'me' ? 2 : 0) + GAP
    if (need > left) return shown.length ? shown : null
    left -= need
    shown.unshift(line)
  }

  return shown
}

/** The top: Claude's mark and the name, the project and its folder under it, the ⚙ at the right. */
function header($: EngineInterface, el: Parts, where: Project, settings: boolean) {
  const { Box, Text, Button } = el

  // The words give way and wrap as the sidebar narrows; the button keeps its size.
  return (
    <Box justifyContent="space-between" alignItems="flex-start" gap={1} marginBottom={1}>
      <Box flexDirection="column" flexShrink={1}>
        <Box gap={1}>
          <Text color="claude" bold>✳</Text>
          <Text bold>{NAME}</Text>
        </Box>
        {where.name && <Text dimColor>{where.name}</Text>}
        {where.path && <Text dimColor>{where.path}</Text>}
      </Box>
      <Box flexShrink={0}>
        <Button key="settings" variant="secondary" label={settings ? '← Sohbet' : '⚙ Ayarlar'} onPress={() => openSettings($, !settings)} />
      </Box>
    </Box>
  )
}

/** The first folder nearby that looks like an agent and has not been answered for, unless it is the one connected. */
function nextCandidate(list: Candidate[], skip: string[], who: Agent): Candidate | undefined {
  return list.find(c => !skip.includes(c.folder) && !who.argv.some(arg => arg.startsWith(`${c.folder}/`)))
}

/**
 * "Is this your agent?": a folder nearby that looks like one, with a yes that
 * connects it and a no that is remembered. One that has a persona but no way
 * to reach it is named with what it lacks.
 */
function suggestion($: EngineInterface, el: Parts, next: Candidate) {
  const { Box, Text, Button } = el
  const where = next.folder.split('/').slice(-2).join('/')

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1} marginBottom={1}>
      <Text bold>Bu senin ajanın mı?</Text>
      <Box gap={1}>
        <Text color="claude">✳</Text>
        <Text>{next.name}</Text>
        <Text dimColor>{where}</Text>
      </Box>
      {next.ready ? (
        <Box gap={1} marginTop={1}>
          <Button key="yes" variant="primary" label="Evet, bağla" onPress={() => connect($, next.folder)} />
          <Button key="no" variant="secondary" label="Hayır" onPress={() => dismiss($, next.folder)} />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Kişilik dosyası var ama ona nasıl ulaşılacağı yazmıyor; bağlamak için klasörüne agent-panel.json eklenmeli.</Text>
          <Box marginTop={1}>
            <Button key="no" variant="secondary" label="Tamam" onPress={() => dismiss($, next.folder)} />
          </Box>
        </Box>
      )}
    </Box>
  )
}

/** The settings: who answers now, a button that opens the Mac's folder picker to connect another, and the way back to Claude. */
function settingsView($: EngineInterface, el: Parts, who: Agent, said: string, next?: Candidate) {
  const { Box, Text, Button } = el

  return (
    <Box flexDirection="column" gap={1}>
      {next && suggestion($, el, next)}
      <Box flexDirection="column">
        <Text bold>Bağlı ajan</Text>
        <Text>{who.argv.length ? who.name : "Bu oturumun Claude'u"}</Text>
        <Text dimColor>{who.argv.length ? who.argv.join(' ') : 'Kurulum gerekmez; ajan bağlarsan o cevap verir.'}</Text>
        {who.argv.length > 0 && (
          <Box marginTop={1}>
            <Button key="disconnect" variant="secondary" label="Bağlantıyı kes" onPress={() => disconnect($)} />
          </Box>
        )}
      </Box>
      <Box flexDirection="column">
        <Text bold>Ajan bağla</Text>
        <Text dimColor>Ajanının klasörünü seç; klasörde agent-panel.json olmalı.</Text>
        <Box marginTop={1}>
          <Button key="pick" variant="primary" label="📁 Klasör seç…" onPress={() => pickFolder($)} />
        </Box>
      </Box>
      {said && <Text dimColor>{said}</Text>}
    </Box>
  )
}

/** The chat as Claude draws its own: gray bubbles on the right for the person, plain text for the answer. */
function conversation(el: Parts, who: Agent, lines: ChatLine[], waiting: boolean) {
  const { Box, Text, Markdown } = el

  return (
    <Box flexDirection="column">
      {lines.map(line =>
        line.who === 'me' ? (
          <Box justifyContent="flex-end" marginBottom={GAP}>
            <Box borderStyle="round" borderColor={USER_BUBBLE} backgroundColor={USER_BUBBLE} paddingX={1} marginLeft={4}>
              <Text color={USER_TEXT}>{line.text}</Text>
            </Box>
          </Box>
        ) : line.who === 'agent' ? (
          <Box flexDirection="column" marginBottom={GAP}>
            <Markdown key={line.id} text={line.text} />
          </Box>
        ) : (
          <Box marginBottom={GAP}>
            <Text color={line.who === 'error' ? 'error' : undefined} dimColor={line.who === 'note'}>{line.text}</Text>
          </Box>
        ),
      )}
      {waiting && (
        <Box gap={1} marginBottom={GAP}>
          <Text color="claude">✳</Text>
          <Text dimColor>{who.name} yazıyor…</Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * The prompt box at the bottom, as Claude's: no words in it, and the button
 * beside the field sends. That button is the field's own: the app draws it
 * beside every field and it cannot be taken away, so it is the send button
 * rather than left blank beside another. While an answer is awaited the box
 * holds a stop button instead, an element of its own, so a press on it is not
 * held behind the send still running.
 *
 * The field holds what is typed by itself: drawing it again on every key
 * would put back an older text over the newest keys. A new field, by a new
 * key, comes after each message sent, empty.
 */
function composer($: EngineInterface, el: Parts, waiting: boolean, sent: number) {
  const { Box, Text, Button, Input } = el

  if (waiting) {
    return (
      <Box justifyContent="flex-end" alignItems="center" gap={1} marginTop={1} marginBottom={1}>
        <Text dimColor>Cevap bekleniyor…</Text>
        <Button key="stop" variant="secondary" label="■" onPress={() => stop($)} />
      </Box>
    )
  }

  // The field's length is the app's: a field takes no width of any kind, and no
  // box around it stretches it. It sits at the left, where text starts, with a
  // row between it and the last message, and room below for the app's field,
  // which is drawn taller than a row.
  return (
    <Box marginTop={1} marginBottom={1}>
      <Input
        key={`ask-${sent}`}
        submitLabel="↑"
        autoFocus
        onSubmit={value => ask($, value)}
      />
    </Box>
  )
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const who = await findAgent($, String(options.name ?? ''), String(options.command ?? ''))
    const where = await findProject($, await $.session.cwd())
    await update($, agent, () => who)
    await update($, project, () => where)
    // An earlier version kept its own window open in this value; start from the button.
    await update($, isOpen, () => false)
    await update($, isSettings, () => false)
    await $.command.register({ name: 'ajan', description: `${NAME} sohbetini sağda açar` })

    return next(e)
  })

  on('command.run', { command: 'ajan' }, async $ => {
    await setOpen($, titleOf(await read($, project)), true)

    return { text: `${NAME} sağda açık.` }
  })

  // The person closed the chat's tab: the button goes back to opening it.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, isOpen, () => false)

    return next(e)
  })

  // The button at the right, just above the prompt: its words alone, with no
  // frame or color of its own. The strip around it is the app's to draw, and
  // what other mods draw there stays above it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (e.surface !== 'desktop' && e.surface !== 'terminal')) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    const where = await read($, project)
    const open = await read($, isOpen)
    const waiting = await read($, busy)
    const unread = await read($, hasUnread)
    const label = open ? `✕ ${NAME}` : waiting ? `✳ ${NAME} · yazıyor` : unread ? `✳ ${NAME} ●` : `✳ ${NAME}`

    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box justifyContent="flex-end">
          <Button key="fab" plain label={label} onPress={() => setOpen($, titleOf(where), !open)} />
        </Box>
      </Box>
    )
  })

  // The chat itself, in the sidebar, filling from the bottom up; or its settings.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const lines = await read($, chat)
    const who = await read($, agent)
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          {lines.map(line => (
            <Text dimColor={line.who === 'me'}>{line.who === 'me' ? 'Sen: ' : `${who.name}: `}{line.text}</Text>
          ))}
        </Box>
      )
    }
    const { Box, Text, Button, Input, Select, Markdown } = $.ui.resolve(e)
    const el = { Box, Text, Button, Input, Select, Markdown }
    const where = await read($, project)

    if (await read($, isSettings)) {
      const next = nextCandidate(await read($, candidates), await read($, dismissed), who)
      return (
        <Box flexDirection="column" paddingX={1}>
          {header($, el, where, true)}
          {settingsView($, el, who, await read($, notice), next)}
        </Box>
      )
    }

    const waiting = await read($, busy)
    const width = e.props.bodyColumns
    const rows = e.props.scroll.bodyRows
    const room = rows - HEADER_ROWS - COMPOSER_ROWS - (waiting ? 2 : 0)
    const shown = fitting(lines, width, Math.max(1, room))

    // The newest answer alone is taller than the pane: draw it whole and let the pane scroll.
    if (shown === null) {
      return (
        <Box flexDirection="column" paddingX={1}>
          {header($, el, where, false)}
          {conversation(el, who, lines.slice(-1), waiting)}
          {composer($, el, waiting, lines.length)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" height={rows} paddingX={1}>
        {header($, el, where, false)}
        <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" overflow="hidden">
          {conversation(el, who, shown, waiting)}
        </Box>
        {composer($, el, waiting, lines.length)}
      </Box>
    )
  })
}
