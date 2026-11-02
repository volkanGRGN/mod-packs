import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'token-preview',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

/** A Turkish text Claude counts at 5,548 tokens. */
const LONG = 'Bu paragraf göndermeden önce ölçülecek uzunlukta bir Türkçe metindir. '.repeat(150)

/** In place of the engine: 76,000 of 200,000 used, someone at the screen, what is sent goes through. */
const engine = (on: On, reply: (question: string) => string | Error) => {
  const asked: string[] = []
  const sent: string[] = []
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, tokens: 76_000, percent: 38 }, rateLimits: [] },
  }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  // $.ui.ask is the engine's own AskUserQuestion dialog: a tool call.
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const { questions } = e as unknown as { questions: { question: string }[] }
    const text = questions[0]?.question ?? ''
    asked.push(text)
    const answer = reply(text)
    return answer instanceof Error ? { deny: answer.message } : { result: { questions, answers: { [text]: answer } } }
  })
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  return { asked, sent }
}

const send = ($: Parameters<TestBody>[0], text: string, kind: 'composer' | 'sdk' | 'peer' = 'composer') =>
  $.prompt.submit({ text, wait: false, origin: { kind } })

test('a short prompt goes without asking', async ($, on) => {
  const { asked, sent } = engine(on, () => 'Send')
  await send($, 'Hi, could you run the tests?')
  expect(asked).toHaveLength(0)
  expect(sent).toEqual(['Hi, could you run the tests?'])
})

test('a long prompt asks with its tokens and share of the context; Send lets it through', async ($, on) => {
  const { asked, sent } = engine(on, () => 'Send')
  // A prompt from the desktop app is a person's prompt too.
  await send($, LONG, 'sdk')
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatch(
    /^This prompt is ≈[\d,]+ tokens and takes \d\.\d% of the context window\. It's 38% full now, ≈\d+% after sending\. Send it\?$/,
  )
  const tokens = Number(/≈([\d,]+) tokens/.exec(asked[0] ?? '')?.[1]?.replace(/,/g, ''))
  // Claude's own count is 5,548; the estimate should be within 10%.
  expect(tokens).toBeGreaterThan(5000)
  expect(tokens).toBeLessThan(6100)
  expect(sent).toEqual([LONG])
})

test('Cancel keeps it from going and puts the text back in the prompt box', async ($, on) => {
  const { sent } = engine(on, () => 'Cancel')
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  expect(await send($, LONG)).toEqual({ drop: 'Not sent; the text is back in the prompt box.' })
  expect(filled).toEqual([LONG])
  expect(sent).toHaveLength(0)
})

test('a dismissed question with no prompt box puts the text on the clipboard', async ($, on) => {
  engine(on, () => new Error('dismissed'))
  on('prompt.fill', () => ({ isFilled: false, text: '', cursor: 0 }))
  on('ui.copy', () => ({ value: { isCopied: false, reason: 'no-clipboard' } }))
  const clipboard: string[] = []
  on('process.run', (_, e) => {
    if (e.argv[0] === 'pbcopy') clipboard.push(e.init?.stdin ?? '')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  expect(await send($, LONG)).toEqual({ drop: 'Not sent; the text is on your clipboard, paste it back with ⌘V.' })
  expect(clipboard).toEqual([LONG])
})

test("another session's long message is not asked about", async ($, on) => {
  const { asked, sent } = engine(on, () => 'Cancel')
  await send($, LONG, 'peer')
  expect(asked).toHaveLength(0)
  expect(sent).toEqual([LONG])
})

test('the threshold comes from the settings; with asking off only a note is added', { options: { threshold: 100, askFirst: false } }, async ($, on) => {
  const { asked, sent } = engine(on, () => 'Cancel')
  const notes: string[] = []
  on('ui.log', (_, e) => {
    notes.push(e.text)
    return { value: undefined }
  })
  await send($, 'short, but measured because the threshold is low '.repeat(20))
  expect(asked).toHaveLength(0)
  expect(sent).toHaveLength(1)
  expect(notes[0]).toMatch(/^This prompt is ≈\d+ tokens/)
})

test('/token says how full the context is; /token <text> measures the text', async ($, on) => {
  engine(on, () => 'Send')
  on('command.register', () => ({ value: { command: 'token' } }))
  const command = (args: string) =>
    $.command.run({ command: 'token', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(await command('')).toEqual({
    text: 'The context is 38% full: 76,000 / 200,000 tokens. Prompts over 2,000 tokens (1% of the context) ask before sending. To measure a text: /token <text>',
  })
  const measured = await command(LONG)
  expect('text' in measured ? measured.text : '').toMatch(/^This prompt is ≈[\d,]+ tokens and .* \(Not sent; only measured\.\)$/)
})

test("in a terminal, a long draft's estimate shows above the prompt box while typing", async ($, on) => {
  engine(on, () => 'Send')
  on('prompt.edit', (_, e) => ({
    text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end),
    cursor: e.start + e.inputText.length,
  }))
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  // The prompt box's events are on the test's $, not in its typings.
  const box = $.prompt as unknown as Record<'edit' | 'change', (e: unknown) => Promise<unknown>>

  const empty = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await empty.find({ type: 'Text', text: /tokens/ })).toBeUndefined()
  await empty.unmount()

  await box.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: LONG })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /tokens/ }))?.text).toMatch(
    /^≈[\d,]+ tokens · \d\.\d% of context · ≈\d+% after sending$/,
  )
  await ui.unmount()

  // Sent or cleared, the readout goes away.
  await box.change({ text: '', cursor: 0, origin: { kind: 'clear' } })
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /tokens/ })).toBeUndefined()
  await after.unmount()
})
