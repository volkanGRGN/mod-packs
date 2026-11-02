import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

// The kit's environment has a real timer; its typings have no DOM.
declare const setTimeout: (fn: () => void, ms: number) => unknown

type Engine = Parameters<TestBody>[0]

const NOTE = '## Goal\nShip the login screen.\n\n## Next steps\n1. Add tests'

/**
 * In place of the engine: a context `fill`% full, someone answering `reply`,
 * a fork that writes NOTE, files, commands and prompts recorded.
 */
const engine = (on: On, state: { fill: number; reply: string; canClear?: boolean; fiveHour?: number }) => {
  const asked: string[] = []
  const sent: string[] = []
  const commands: string[] = []
  const files: Record<string, string> = {}
  const logs: string[] = []
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, tokens: state.fill * 2000, percent: state.fill },
      // The 5-hour window resets in 2 h 10 min.
      rateLimits:
        state.fiveHour === undefined
          ? []
          : [{ kind: 'five_hour', percentUsed: state.fiveHour, resetsAt: new Date(Date.now() + 130 * 60_000 - 1000).toISOString() }],
    },
  }))
  on('session.cwd', () => ({ value: '/home/me/app' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const { questions } = e as unknown as { questions: { question: string }[] }
    const text = questions[0]?.question ?? ''
    asked.push(text)
    return { result: { questions, answers: { [text]: state.reply } } }
  })
  on('model.fork', () => ({
    value: { isAnswered: true, text: NOTE, usage: { input_tokens: 1, output_tokens: 1 } } as never,
  }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.write', (_, e) => {
    files[String(e.path)] = String(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'handoff' } }))
  on('command.list', () => ({
    value: state.canClear === false ? [] : [{ name: 'clear', description: 'Clear the conversation', source: 'builtin' as const }],
  }))
  on('command.run', (_, e) => {
    commands.push(e.command)
    return { text: '' }
  })
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', () => ({ isFilled: false, text: '', cursor: 0 }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('ui.log', (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })

  return { asked, sent, commands, files, logs }
}

const type = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'sdk' } })

/** Waits for a move the hook left running: it ends with a prompt sent or a line logged. */
const settled = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await new Promise<void>(resolve => setTimeout(resolve, 10))
}

test('below the threshold nothing is asked', async ($, on) => {
  const r = engine(on, { fill: 55, reply: 'Move to a fresh session' })
  await type($, 'Next, the signup form.')
  expect(r.asked).toHaveLength(0)
  expect(r.sent).toEqual(['Next, the signup form.'])
})

test('past the threshold it asks; kept going, it asks again only ten points later', async ($, on) => {
  const state = { fill: 72, reply: 'Keep going here' }
  const r = engine(on, state)
  await type($, 'one')
  expect(r.asked).toEqual([
    'The context is 72% full (≈144k tokens), and every message re-reads all of it. Move to a fresh session with a handoff note? Your message goes along to it.',
  ])
  state.fill = 78
  await type($, 'two')
  expect(r.asked).toHaveLength(1)
  state.fill = 82
  await type($, 'three')
  expect(r.asked).toHaveLength(2)
  expect(r.sent).toEqual(['one', 'two', 'three'])
})

test('a move writes the note, clears, and starts the fresh session from it with the prompt', async ($, on) => {
  const r = engine(on, { fill: 74, reply: 'Move to a fresh session' })
  expect(await type($, 'Now add the signup form.')).toEqual({
    drop: 'Moving to a fresh session: writing the handoff note first. Your message goes along.',
  })
  await settled(() => r.sent.length > 0)

  expect(r.commands).toEqual(['clear'])
  const saved = Object.keys(r.files)
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatch(/^\/home\/me\/\.claude\/handoffs\/app_\d{4}-\d\d-\d\d_\d\d-\d\d\.md$/)
  expect(r.files[saved[0] ?? '']).toBe(`${NOTE}\n`)
  expect(r.sent).toEqual([
    `Continuing earlier work in a fresh session. The handoff note from the previous session is below (saved at ${saved[0]}).\n\n${NOTE}\n\n---\n\nNow add the signup form.`,
  ])
})

const turnEnds = ($: Engine, isAborted = false) =>
  $.turn.complete({ turnId: 't', answer: 'Done.', durationMs: 1, isAborted, reason: isAborted ? 'aborted' : 'answer' } as never)

test('right after a turn past the threshold it asks, with the usage limit; a move starts from the note', async ($, on) => {
  const r = engine(on, { fill: 71, reply: 'Move to a fresh session', fiveHour: 34 })
  await turnEnds($)
  expect(r.asked).toEqual([
    "The context is 71% full (≈142k tokens), and every message re-reads all of it. You've used 34% of your 5-hour limit, resets in 2 h 10 min. Move to a fresh session with a handoff note?",
  ])
  await settled(() => r.sent.length > 0)
  expect(r.commands).toEqual(['clear'])
  expect(r.sent[0]).toMatch(/\n\n---\n\nPick up from the next steps\.$/)
})

test('once the limit has grown, the question says what one message here takes of it', async ($, on) => {
  const state = { fill: 40, reply: 'Keep going here', fiveHour: 30 }
  const r = engine(on, state)
  await turnEnds($)
  state.fiveHour = 33
  await turnEnds($)
  state.fiveHour = 36
  state.fill = 73
  await turnEnds($)
  // 6 points over two turns: about 3% a message.
  expect(r.asked).toEqual([
    'The context is 73% full (≈146k tokens), and every message re-reads all of it. Each message here takes about 3% of your 5-hour limit; 36% is used, resets in 2 h 10 min. Move to a fresh session with a handoff note?',
  ])
  expect(r.sent).toHaveLength(0)
})

test('a turn the person stopped, or one below the threshold, asks nothing', async ($, on) => {
  const state = { fill: 50, reply: 'Move to a fresh session' }
  const r = engine(on, state)
  await turnEnds($)
  state.fill = 80
  await turnEnds($, true)
  expect(r.asked).toHaveLength(0)
})

test('/handoff moves now', async ($, on) => {
  const r = engine(on, { fill: 30, reply: 'Keep going here' })
  const said = await $.command.run({
    command: 'handoff',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(said).toEqual({ text: 'Writing the handoff note, then moving to a fresh session…' })
  await settled(() => r.sent.length > 0)
  expect(r.commands).toEqual(['clear'])
  expect(r.sent[0]).toContain(NOTE)
})

test("where /clear can't run, the handoff is kept and handed over, nothing lost", async ($, on) => {
  const r = engine(on, { fill: 75, reply: 'Move to a fresh session', canClear: false })
  await type($, 'Now add the signup form.')
  await settled(() => r.logs.length > 0)
  expect(r.sent).toHaveLength(0)
  expect(r.commands).toHaveLength(0)
  expect(Object.keys(r.files)).toHaveLength(1)
  expect(r.logs[0]).toMatch(/^Couldn't start a fresh session from here\. The handoff is on your clipboard: open a new session and paste it\. It's saved at .*\.md\.$/)
})
