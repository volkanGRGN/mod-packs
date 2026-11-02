import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

// Session handoff: when the context fills up, stops and asks whether to move
// to a fresh session. On yes, the session's own Claude writes a handoff note
// (goal, what's done, current state, next steps), the note is saved, the
// conversation is cleared, and the fresh one starts from the note.
//
// It asks at two moments: right after Claude finishes a turn, and when you
// send a prompt (your prompt then goes along to the fresh session). It never
// cuts into a tool Claude is running. The question says how full the context
// is and how much of the 5-hour usage limit each message here takes. /handoff
// moves now.

/** Ask again only once the context has grown this many points since the last answer. */
const STEP = 10
/** How long a move waits for the dispatch that asked to settle: commands run on an idle session. */
const SETTLE_MS = 300
/** Prompts a person sends: the terminal, the phone/web bridge, the desktop app. */
const PEOPLE = ['composer', 'bridge', 'sdk']
const MOVE = 'Move to a fresh session'
const STAY = 'Keep going here'

const NOTE_PROMPT = [
  'Write a handoff note so this work can go on in a fresh session that sees none of this conversation.',
  'Markdown, under 400 words, with these headings: Goal; Done so far (with file paths); Current state; Next steps (numbered); Open questions; Useful paths and commands.',
  'Facts only: mark what is unverified. Write it in the language of this conversation. Write the note and nothing else.',
].join(' ')

// The module's own state: it starts over on a reload, as a fresh conversation would.
/** The fill at which the person last answered; nothing is asked again below it plus STEP. */
let askedAt = 0
/** A move is under way: nothing else asks or moves meanwhile. */
let isMoving = false
/** Turns finished in this session, to spread the usage limit's growth over. */
let turns = 0
/** The 5-hour limit's use when first seen, and at which turn: what each message costs is measured from it. */
let meter: { percent: number; turn: number } | undefined

/** How full the context is, 0 to 100. */
const fill = async ($: EngineInterface) => {
  const { context } = await $.session.usage()
  if (context.percent !== undefined) return context.percent
  return context.tokens && context.window ? Math.round((context.tokens / context.window) * 100) : 0
}

/** Whether to ask now: past the threshold, and grown enough since the last answer. */
const isTimeToAsk = (percent: number, threshold: number) => percent >= threshold && percent >= askedAt + STEP

/** Starts measuring at the first reading, and again when the window resets. */
const track = (limit: SessionRateLimit | undefined) => {
  if (limit && (!meter || limit.percentUsed < meter.percent)) meter = { percent: limit.percentUsed, turn: turns }
}

/**
 * The share of the 5-hour limit one message here takes: the limit's growth
 * since measuring began, over the turns since. Nothing until it has grown a
 * whole point; other sessions running at once count in too.
 */
const perMessage = (limit: SessionRateLimit) => {
  const since = meter ? turns - meter.turn : 0
  const grown = meter ? limit.percentUsed - meter.percent : 0
  return since > 0 && grown >= 1 ? grown / since : undefined
}

/** 720000 → "720k", 1234567 → "1.2M". */
const short = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : `${Math.round(n / 1000)}k`)

/** ", resets in 2 h 10 min" from the window's reset time; nothing without one. */
const resetsIn = (limit: SessionRateLimit) => {
  const ms = limit.resetsAt ? Date.parse(limit.resetsAt) - Date.now() : NaN
  if (!(ms > 0)) return ''
  const min = Math.ceil(ms / 60_000)
  const h = Math.floor(min / 60)
  return `, resets in ${h ? `${h} h ${min % 60 ? `${min % 60} min` : ''}`.trim() : `${min} min`}`
}

/** The question: how full the context is, what a message here costs of the usage limit, and the move. */
const question = async ($: EngineInterface, percent: number, what: string) => {
  const { context, rateLimits } = await $.session.usage()
  const parts = [`The context is ${percent}% full${context.tokens ? ` (≈${short(context.tokens)} tokens)` : ''}, and every message re-reads all of it.`]
  const fiveHour = rateLimits.find(r => r.kind === 'five_hour')
  if (fiveHour) {
    const each = perMessage(fiveHour)
    parts.push(
      each === undefined
        ? `You've used ${fiveHour.percentUsed}% of your 5-hour limit${resetsIn(fiveHour)}.`
        : `Each message here takes about ${each < 1 ? 'under 1' : Math.round(each)}% of your 5-hour limit; ${fiveHour.percentUsed}% is used${resetsIn(fiveHour)}.`,
    )
  }
  parts.push('Move to a fresh session with a handoff note?')
  if (what) parts.push(what)

  return parts.join(' ')
}

const ask = async ($: EngineInterface, percent: number, what: string) => {
  askedAt = percent
  return $.ui
    .ask(await question($, percent, what), { header: 'Context', options: [MOVE, STAY] })
    .catch(() => STAY)
}

/** The note from the session's own Claude, which has the whole conversation; nothing when it can't answer. */
const writeNote = async ($: EngineInterface) => {
  const r = await $.model.fork({ prompt: NOTE_PROMPT }).catch(() => undefined)
  return r?.isAnswered && r.text.trim() ? r.text.trim() : undefined
}

/** Keeps the note under ~/.claude/handoffs, named after the project and the time. */
const saveNote = async ($: EngineInterface, note: string) => {
  try {
    const home = (await $.env.get('HOME').catch(() => undefined)) || '/tmp'
    const project = ((await $.session.cwd()).split('/').filter(Boolean).at(-1) ?? 'session').replace(/[^\w.-]+/g, '-')
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-')
    const dir = `${home}/.claude/handoffs`
    const path = `${dir}/${project}_${stamp}.md`
    await $.process.run(['mkdir', '-p', dir], { timeoutMs: 5000 })
    await $.fs.write(path, `${note}\n`)
    return path
  } catch {
    return undefined
  }
}

/** The first prompt of the fresh session: the note, where it is kept, and what comes next. */
const firstPrompt = (note: string, path: string | undefined, next: string | undefined) =>
  [
    `Continuing earlier work in a fresh session. The handoff note from the previous session is below${path ? ` (saved at ${path})` : ''}.`,
    note,
    '---',
    next?.trim() || 'Pick up from the next steps.',
  ].join('\n\n')

/** When the conversation can't be cleared from here: the first prompt in the box, else on the clipboard. */
const handOver = async ($: EngineInterface, text: string, path: string | undefined) => {
  const box = await $.prompt.fill({ text, mode: 'replace' }).catch(() => undefined)
  if (box?.isFilled) {
    $.ui.log("Couldn't start a fresh session from here. The handoff is in the prompt box: run /clear, then send it.")
    return
  }
  const pb = await $.process.run(['pbcopy'], { stdin: text, timeoutMs: 5000 }).catch(() => undefined)
  const where = path ? ` It's saved at ${path}.` : ''
  $.ui.log(
    pb?.exitCode === 0
      ? `Couldn't start a fresh session from here. The handoff is on your clipboard: open a new session and paste it.${where}`
      : `Couldn't start a fresh session from here.${where}`,
  )
}

/**
 * The move, after the dispatch that started it has settled: the note, then
 * /clear, then the fresh conversation's first prompt. If the note can't be
 * written nothing is cleared, and a prompt that was held back goes back.
 */
const move = async ($: EngineInterface, next?: string) => {
  try {
    await $.clock.sleep(SETTLE_MS).catch(() => undefined)
    const note = await writeNote($)
    if (!note) {
      $.ui.log("Couldn't write the handoff note; staying in this session.")
      if (next) await $.prompt.fill({ text: next, mode: 'replace' }).catch(() => undefined)
      return
    }
    const path = await saveNote($, note)
    const text = firstPrompt(note, path, next)
    // /clear is Claude Code's own; a host without it lists none, or refuses the run.
    const canClear = (await $.command.list().catch(() => [])).some(c => c.name === 'clear')
    const isCleared =
      canClear &&
      (await $.command.run({ command: 'clear' }).then(
        () => true,
        () => false,
      ))
    if (!isCleared) {
      await handOver($, text, path)
      return
    }
    await $.prompt.submit({ text })
  } catch {
    // The session went away mid-move, or a call was refused: nothing more to do here.
  } finally {
    isMoving = false
  }
}

/** Starts a move unless one is under way; the caller's dispatch doesn't wait for it. */
const startMove = ($: EngineInterface, next?: string) => {
  if (isMoving) return false
  isMoving = true
  $.ui.toast('Writing the handoff note…')
  void move($, next)
  return true
}

export const register: Register = (on, options) => {
  const threshold = typeof options.threshold === 'number' && options.threshold > 0 ? options.threshold : 70

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'handoff',
      description: 'Writes a handoff note and moves this work to a fresh session',
    })

    return next(e)
  })

  // A cleared conversation starts over: the next fill past the threshold asks again.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') askedAt = 0

    return next(e)
  })

  // Before a prompt goes in: past the threshold, ask; on a move the prompt goes along to the fresh session.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || isMoving || !PEOPLE.includes(e.origin.kind)) return next(e)
    const percent = await fill($)
    if (!isTimeToAsk(percent, threshold)) return next(e)
    if ((await ask($, percent, 'Your message goes along to it.')) !== MOVE) return next(e)
    if (!startMove($, e.text)) return next(e)

    return { drop: 'Moving to a fresh session: writing the handoff note first. Your message goes along.' }
  }).catch(($, e, next) => next(e))

  // Right after Claude finishes a turn: measure the usage limit, and past the threshold ask.
  // A turn the person stopped is left alone.
  on('turn.complete', async ($, e, next) => {
    turns += 1
    track((await $.session.usage()).rateLimits.find(r => r.kind === 'five_hour'))
    if (e.isAborted || isMoving) return next(e)
    const percent = await fill($)
    if (isTimeToAsk(percent, threshold) && (await ask($, percent, '')) === MOVE) startMove($)

    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    if (!startMove($, e.args.trim() || undefined)) return { text: 'A move to a fresh session is already under way.' }

    return { text: 'Writing the handoff note, then moving to a fresh session…' }
  })
}
