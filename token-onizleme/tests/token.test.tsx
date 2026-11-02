import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'token-onizleme',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

/** Claude'un saydığı 5.548 token'lık Türkçe bir metin. */
const UZUN = 'Bu paragraf göndermeden önce ölçülecek uzunlukta bir Türkçe metindir. '.repeat(150)

/** Motorun yerine: bağlam 200.000'de 76.000 dolu, ekranda biri var, gönderilen geçer. */
const motor = (on: On, soru: (metin: string) => string | Error) => {
  const sorulan: string[] = []
  const gecen: string[] = []
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, tokens: 76_000, percent: 38 }, rateLimits: [] },
  }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  // $.ui.ask, motorun kendi AskUserQuestion penceresidir: bir araç çağrısı.
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const { questions } = e as unknown as { questions: { question: string }[] }
    const metin = questions[0]?.question ?? ''
    sorulan.push(metin)
    const cevap = soru(metin)
    return cevap instanceof Error ? { deny: cevap.message } : { result: { questions, answers: { [metin]: cevap } } }
  })
  on('prompt.submit', (_, e) => {
    gecen.push(e.text)
    return { text: e.text }
  })

  return { sorulan, gecen }
}

const gonder = (
  $: Parameters<TestBody>[0],
  text: string,
  kind: 'composer' | 'sdk' | 'peer' = 'composer',
) => $.prompt.submit({ text, wait: false, origin: { kind } })

test('kısa mesaj sorulmadan gider', async ($, on) => {
  const { sorulan, gecen } = motor(on, () => 'Gönder')
  await gonder($, 'Merhaba, testleri çalıştırır mısın?')
  expect(sorulan).toHaveLength(0)
  expect(gecen).toEqual(['Merhaba, testleri çalıştırır mısın?'])
})

test('uzun mesajda kaç token ve bağlamın ne kadarı olduğunu sorar; Gönder geçirir', async ($, on) => {
  const { sorulan, gecen } = motor(on, () => 'Gönder')
  // Masaüstünden gelen mesaj da insanın mesajıdır.
  await gonder($, UZUN, 'sdk')
  expect(sorulan).toHaveLength(1)
  expect(sorulan[0]).toMatch(
    /^Bu mesaj ≈[\d.]+ token tutuyor; bağlamda %\d,\d yer kaplar\. Şu an %38 dolu, gönderince ≈%\d+ olur\. Gönderilsin mi\?$/,
  )
  const token = Number(/≈([\d.]+) token/.exec(sorulan[0] ?? '')?.[1]?.replace(/\./g, ''))
  // Gerçek sayım 5.548; tahmin %10 içinde olmalı.
  expect(token).toBeGreaterThan(5000)
  expect(token).toBeLessThan(6100)
  expect(gecen).toEqual([UZUN])
})

test('Vazgeç deyince gitmez, metin mesaj kutusuna geri konur', async ($, on) => {
  const { gecen } = motor(on, () => 'Vazgeç')
  const kutuya: string[] = []
  on('prompt.fill', (_, e) => {
    kutuya.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  const sonuc = await gonder($, UZUN)
  expect(sonuc).toEqual({ drop: 'Gönderilmedi; metin mesaj kutusuna geri kondu.' })
  expect(kutuya).toEqual([UZUN])
  expect(gecen).toHaveLength(0)
})

test('soru kapatılır ve kutu yoksa metin panoya kopyalanır', async ($, on) => {
  motor(on, () => new Error('dismissed'))
  on('prompt.fill', (_, e) => ({ isFilled: false, text: '', cursor: 0 }))
  on('ui.copy', () => ({ value: { isCopied: false, reason: 'no-clipboard' } }))
  const pano: string[] = []
  on('process.run', (_, e) => {
    if (e.argv[0] === 'pbcopy') pano.push(e.init?.stdin ?? '')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const sonuc = await gonder($, UZUN)
  expect(sonuc).toEqual({ drop: 'Gönderilmedi; metin panoya kopyalandı, ⌘V ile geri yapıştırabilirsin.' })
  expect(pano).toEqual([UZUN])
})

test('başka bir oturumdan gelen uzun mesaj sorulmaz', async ($, on) => {
  const { sorulan, gecen } = motor(on, () => 'Vazgeç')
  await gonder($, UZUN, 'peer')
  expect(sorulan).toHaveLength(0)
  expect(gecen).toEqual([UZUN])
})

test('eşik ayardan gelir; sor kapalıysa yalnız not düşer', { options: { esik: 100, sor: false } }, async ($, on) => {
  const { sorulan, gecen } = motor(on, () => 'Vazgeç')
  const notlar: string[] = []
  on('ui.log', (_, e) => {
    notlar.push(e.text)
    return { value: undefined }
  })
  await gonder($, 'kısa ama eşik düşük olduğu için ölçülecek bir mesaj '.repeat(20))
  expect(sorulan).toHaveLength(0)
  expect(gecen).toHaveLength(1)
  expect(notlar[0]).toMatch(/^Bu mesaj ≈\d+ token tutuyor/)
})

test('/token bağlamın doluluğunu, /token <metin> metnin tahminini söyler', async ($, on) => {
  motor(on, () => 'Gönder')
  on('command.register', () => ({ value: { command: 'token' } }))
  const komut = (args: string) =>
    $.command.run({ command: 'token', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const bos = await komut('')
  expect(bos).toEqual({
    text: "Bağlam %38 dolu: 76.000 / 200.000 token. 2.000 token'dan (bağlamın %1) uzun mesajlarda göndermeden önce sorarım. Bir metnin tahmini için: /token <metin>",
  })
  const olcum = await komut(UZUN)
  expect('text' in olcum ? olcum.text : '').toMatch(/^Bu mesaj ≈[\d.]+ token tutuyor; .* \(Gönderilmedi; yalnız ölçüldü\.\)$/)
})

test('terminalde yazarken uzun taslağın tahmini mesaj kutusunun üstünde görünür', async ($, on) => {
  motor(on, () => 'Gönder')
  on('prompt.edit', (_, e) => ({
    text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end),
    cursor: e.start + e.inputText.length,
  }))
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  const bos = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await bos.find({ type: 'Text', text: /token/ })).toBeUndefined()
  await bos.unmount()

  // Mesaj kutusunun olayları testin $'ında var, tiplerinde yok.
  const kutu = $.prompt as unknown as Record<'edit' | 'change', (e: unknown) => Promise<unknown>>
  await kutu.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: UZUN })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /token/ }))?.text).toMatch(
    /^≈[\d.]+ token · bağlamda %\d,\d · gönderince ≈%\d+$/,
  )
  await ui.unmount()

  // Gönderilince ya da silinince gösterge kaybolur.
  await kutu.change({ text: '', cursor: 0, origin: { kind: 'clear' } })
  const sonra = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await sonra.find({ type: 'Text', text: /token/ })).toBeUndefined()
  await sonra.unmount()
})
