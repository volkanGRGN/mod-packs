import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Draft } from '../types'

// Token preview: before a long prompt is sent, says how many tokens it is and
// how much of the context window it will take, then asks. In a terminal it
// shows live above the prompt box while you type; the desktop app's prompt box
// is not open to mods, so there it asks on send. /token says how full the
// context is, /token <text> measures a pasted text without sending it.

const draft = atom({ plugin: 'token-preview', key: 'draft' } as const, 0 as Draft)

// Letters per token, tuned against Claude's own count: on Turkish prose,
// English prose and code the estimate lands within ±10%, mostly ±5%.
const ENGLISH_WORD = 4
/** The same plain ASCII word splits into more pieces inside a Turkish text. */
const TURKISH_WORD = 2.3
/** A word carrying letters such as ç, ğ, ı, ö, ş, ü. */
const ACCENTED_WORD = 1.9
/** When this share of the letters is Turkish-only, the text counts as fully Turkish; in between, in proportion. */
const TURKISH_SHARE = 0.03
/** Roughly what one image costs in tokens. */
const IMAGE = 1600
/** The live readout appears once the draft reaches this share of the threshold. */
const LIVE_SHARE = 0.25
/** Past this fill the conversation may be compacted on its own. */
const COMPACT_PERCENT = 85
/** Prompts a person sends: the terminal, the phone/web bridge, the desktop app. */
const PEOPLE = ['composer', 'bridge', 'sdk']

/** An estimate of how many tokens a text takes in Claude. */
const estimate = (text: string) => {
  const letters = (text.match(/\p{L}/gu) ?? []).length || 1
  const turkish = (text.match(/[çğıöşüÇĞİÖŞÜ]/g) ?? []).length
  const share = Math.min(1, turkish / letters / TURKISH_SHARE)
  const plainWord = ENGLISH_WORD + (TURKISH_WORD - ENGLISH_WORD) * share
  let t = 0
  for (const [p] of text.matchAll(/[\p{L}\p{M}]+|\p{N}+|[ \t]+|\n+|[^\s\p{L}\p{M}\p{N}]/gu)) {
    if (p[0] === '\n') t += 1
    else if (p[0] === ' ' || p[0] === '\t') t += p.length > 1 ? p.length / 4 : 0
    else if (/\p{N}/u.test(p)) t += Math.ceil(p.length / 3)
    else if (/\p{L}/u.test(p)) {
      if (/[　-鿿가-힯]/.test(p)) t += p.length
      else if (/^[a-zA-Z]+$/.test(p)) t += Math.ceil(p.length / plainWord)
      else t += Math.ceil(p.length / ACCENTED_WORD)
    } else t += 1
  }

  return Math.round(t)
}

/** 12400 → "12,400" */
const count = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** 6.24 → "6.2%", 44.3 → "44%"; tiny ones "under 0.1%". */
const percent = (n: number) => {
  if (n > 0 && n < 0.1) return 'under 0.1%'
  return n < 10 ? `${n.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(n)}%`
}

type Measure = { tokens: number; share: number; now?: number; after?: number; window: number; fiveHour?: SessionRateLimit }

// The module's own: they start over on a reload.
/** Turns finished in this session, to spread the usage limit's growth over. */
let turns = 0
/** The 5-hour limit's use when first seen, and at which turn: what a message costs is measured from it. */
let meter: { percent: number; turn: number } | undefined

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

/** ", resets in 2 h 10 min" from the window's reset time; nothing without one. */
const resetsIn = (limit: SessionRateLimit) => {
  const ms = limit.resetsAt ? Date.parse(limit.resetsAt) - Date.now() : NaN
  if (!(ms > 0)) return ''
  const min = Math.ceil(ms / 60_000)
  const h = Math.floor(min / 60)
  return `, resets in ${h ? `${h} h ${min % 60 ? `${min % 60} min` : ''}`.trim() : `${min} min`}`
}

/** Where the prompt stands in the context: its own share, the fill now and after sending, and the 5-hour limit. */
const measure = async ($: EngineInterface, tokens: number): Promise<Measure> => {
  const { context, rateLimits } = await $.session.usage()
  const window = context.window || 200_000
  const share = (tokens / window) * 100
  const fiveHour = rateLimits.find(r => r.kind === 'five_hour')
  if (context.tokens === undefined) return { tokens, share, window, fiveHour }

  return { tokens, share, window, fiveHour, now: (context.tokens / window) * 100, after: ((context.tokens + tokens) / window) * 100 }
}

/** What a message here takes of the 5-hour limit once measured, else how much of it is used; nothing without a limit. */
const usageLine = (limit: SessionRateLimit | undefined) => {
  if (!limit) return ''
  const each = perMessage(limit)
  return each === undefined
    ? ` You've used ${limit.percentUsed}% of your 5-hour limit${resetsIn(limit)}.`
    : ` Each message here takes about ${each < 1 ? 'under 1' : Math.round(each)}% of your 5-hour limit; ${limit.percentUsed}% is used${resetsIn(limit)}.`
}

/** The measure in a sentence or two. */
const describe = (m: Measure) => {
  if (m.tokens > m.window || (m.after ?? 0) >= 100) {
    return `This prompt is ≈${count(m.tokens)} tokens; it doesn't fit in the context window (${count(m.window)} tokens).`
  }
  let text = `This prompt is ≈${count(m.tokens)} tokens and takes ${percent(m.share)} of the context window.`
  if (m.now !== undefined && m.after !== undefined) {
    text += ` It's ${percent(m.now)} full now, ≈${percent(m.after)} after sending.`
    if (m.after >= COMPACT_PERCENT) text += ' The conversation may get compacted.'
  }

  return text + usageLine(m.fiveHour)
}

/** Never loses an unsent text: back in the prompt box, else on the clipboard. */
const putBack = async ($: EngineInterface, text: string) => {
  const box = await $.prompt.fill({ text, mode: 'replace' }).catch(() => undefined)
  if (box?.isFilled) return 'Not sent; the text is back in the prompt box.'
  const copy = await $.ui.copy({ text }).catch(() => undefined)
  let onClipboard = copy?.isCopied === true
  if (!onClipboard) {
    const pb = await $.process.run(['pbcopy'], { stdin: text, timeoutMs: 5000 }).catch(() => undefined)
    onClipboard = pb?.exitCode === 0
  }

  return onClipboard ? 'Not sent; the text is on your clipboard, paste it back with ⌘V.' : 'Not sent.'
}

/** In a terminal, re-estimates the draft as it changes; in steps of a hundred, so it doesn't redraw on every key. */
const measureDraft = async ($: EngineInterface, text: string, threshold: number) => {
  const tokens = text.trim() ? estimate(text) : 0
  const step = tokens < threshold * LIVE_SHARE ? 0 : Math.round(tokens / 100) * 100 || tokens
  if ((await read($, draft)) !== step) await update($, draft, () => step)
}

export const register: Register = (on, options) => {
  const threshold = typeof options.threshold === 'number' && options.threshold > 0 ? options.threshold : 2000
  const askFirst = options.askFirst !== false

  // After each turn, a reading of the 5-hour limit: what a message here costs is measured from these.
  on('turn.complete', async ($, e, next) => {
    turns += 1
    track((await $.session.usage()).rateLimits.find(r => r.kind === 'five_hour'))

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'token',
      description: 'Says how full the context is; /token <text> measures a text without sending it',
    })
    await update($, draft, () => 0)

    return next(e)
  })

  // Before a long prompt goes out: say how much room it takes, and ask.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !PEOPLE.includes(e.origin.kind)) return next(e)
    const tokens = estimate(e.text) + (e.attachments?.length ?? 0) * IMAGE
    await update($, draft, () => 0)
    if (tokens < threshold) return next(e)

    const m = await measure($, tokens)
    const nobody = (await $.session.surfaces()).length === 0
    if (!askFirst || nobody) {
      if (!nobody) $.ui.log(describe(m))
      return next(e)
    }

    // The question is a call on $, so the wait for an answer is not this hook's own time;
    // a clock wait beside it would be, and past ten seconds would let the prompt through.
    const answer = await $.ui
      .ask(`${describe(m)} Send it?`, { header: 'Long prompt', options: ['Send', 'Cancel'] })
      .catch(() => 'dismissed')
    if (answer === 'Send') return next(e)

    return { drop: await putBack($, e.text) }
  }).catch(($, e, next) => next(e))

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await measureDraft($, box.text, threshold)

    return box
  })

  on('prompt.change', async ($, e, next) => {
    await measureDraft($, e.text, threshold)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const tokens = await read($, draft)
    if (!tokens || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const m = await measure($, tokens)
    const isLong = tokens >= threshold
    const parts = [`≈${count(tokens)} tokens`, `${percent(m.share)} of context`]
    if (m.after !== undefined) parts.push(`≈${percent(m.after)} after sending`)

    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box justifyContent="flex-end">
          <Text dimColor={!isLong} color={isLong || (m.after ?? 0) >= COMPACT_PERCENT ? 'warning' : undefined}>
            {parts.join(' · ')}
          </Text>
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'token' }, async ($, e) => {
    const text = e.args.trim()
    const { context, rateLimits } = await $.session.usage()
    const window = context.window || 200_000
    if (text) return { text: `${describe(await measure($, estimate(text)))} (Not sent; only measured.)` }
    const fill =
      context.tokens === undefined
        ? "The context hasn't been measured yet; it shows after the first reply."
        : `The context is ${percent((context.tokens / window) * 100)} full: ${count(context.tokens)} / ${count(window)} tokens.`

    return {
      text: `${fill}${usageLine(rateLimits.find(r => r.kind === 'five_hour'))} Prompts over ${count(threshold)} tokens (${percent((threshold / window) * 100)} of the context) ${askFirst ? 'ask before sending' : 'get a note when sent'}. To measure a text: /token <text>`,
    }
  })
}
