import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Taslak } from '../types'

// Token önizleme: uzun bir mesajı göndermeden önce kaç token tuttuğunu ve
// bağlamda yüzde kaç yer kaplayacağını söyler, onay ister. Terminalde
// yazarken mesaj kutusunun üstünde canlı gösterir; masaüstünün mesaj kutusu
// modlara açık değil, orada gönderirken sorar. /token bağlamın doluluğunu,
// /token <metin> yapıştırılan bir metnin tahminini göndermeden verir.

const taslak = atom({ plugin: 'token-onizleme', key: 'taslak' } as const, 0 as Taslak)

// Harf/token oranları, Claude'un gerçek sayımıyla ayarlandı: Türkçe düzyazı,
// İngilizce düzyazı ve kodda tahmin ±%5 içinde.
const INGILIZCE_KELIME = 4
/** Aynı düz ASCII kelime, Türkçe bir metnin içindeyken daha çok parçaya bölünür. */
const TURKCE_KELIME = 2.3
/** ç, ğ, ı, ö, ş, ü gibi harf taşıyan kelime. */
const AKSANLI_KELIME = 1.9
/** Harflerin bu kadarı Türkçeye özgüyse metin tam Türkçe sayılır; arası orantılı. */
const TURKCE_ORAN = 0.03
/** Bir görselin kabaca token karşılığı. */
const GORSEL = 1600
/** Taslak eşiğin bu kadarına varınca terminalde canlı gösterge açılır. */
const BANT_ORANI = 0.25
/** Bağlam bu kadar dolunca konuşma kendiliğinden özetlenebilir. */
const OZET_YUZDE = 85
/** Soru bu kadar cevapsız kalırsa mesaj gönderilmez, geri konur. */
const SORU_MS = 10 * 60_000
/** İnsanın gönderdiği mesajlar: terminal, telefon/web köprüsü, masaüstü uygulaması. */
const INSAN = ['composer', 'bridge', 'sdk']

/** Bir metnin Claude'da kaç token tutacağının tahmini. */
const tahmin = (metin: string) => {
  const harf = (metin.match(/\p{L}/gu) ?? []).length || 1
  const turkce = (metin.match(/[çğıöşüÇĞİÖŞÜ]/g) ?? []).length
  const oran = Math.min(1, turkce / harf / TURKCE_ORAN)
  const duzKelime = INGILIZCE_KELIME + (TURKCE_KELIME - INGILIZCE_KELIME) * oran
  let t = 0
  for (const [p] of metin.matchAll(/[\p{L}\p{M}]+|\p{N}+|[ \t]+|\n+|[^\s\p{L}\p{M}\p{N}]/gu)) {
    if (p[0] === '\n') t += 1
    else if (p[0] === ' ' || p[0] === '\t') t += p.length > 1 ? p.length / 4 : 0
    else if (/\p{N}/u.test(p)) t += Math.ceil(p.length / 3)
    else if (/\p{L}/u.test(p)) {
      if (/[　-鿿가-힯]/.test(p)) t += p.length
      else if (/^[a-zA-Z]+$/.test(p)) t += Math.ceil(p.length / duzKelime)
      else t += Math.ceil(p.length / AKSANLI_KELIME)
    } else t += 1
  }

  return Math.round(t)
}

/** 12400 → "12.400" */
const sayi = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

/** 6.24 → "%6,2", 44.3 → "%44"; çok küçükse "%0,1'den az". */
const yuzde = (n: number) => {
  if (n > 0 && n < 0.1) return "%0,1'den az"
  return n < 10 ? `%${n.toFixed(1).replace('.', ',').replace(/,0$/, '')}` : `%${Math.round(n)}`
}

type Olcum = { token: number; pay: number; simdi?: number; sonra?: number; pencere: number }

/** Mesajın bağlamdaki yeri: kendi payı, şimdiki doluluk ve gönderince olacağı. */
const olc = async ($: EngineInterface, token: number): Promise<Olcum> => {
  const { context } = await $.session.usage()
  const pencere = context.window || 200_000
  const pay = (token / pencere) * 100
  if (context.tokens === undefined) return { token, pay, pencere }

  return { token, pay, pencere, simdi: (context.tokens / pencere) * 100, sonra: ((context.tokens + token) / pencere) * 100 }
}

/** Ölçümü bir iki cümleyle söyler. */
const anlat = (o: Olcum) => {
  if (o.token > o.pencere || (o.sonra ?? 0) >= 100) {
    return `Bu mesaj ≈${sayi(o.token)} token tutuyor; bağlama (${sayi(o.pencere)} token) sığmıyor.`
  }
  let metin = `Bu mesaj ≈${sayi(o.token)} token tutuyor; bağlamda ${yuzde(o.pay)} yer kaplar.`
  if (o.simdi !== undefined && o.sonra !== undefined) {
    metin += ` Şu an ${yuzde(o.simdi)} dolu, gönderince ≈${yuzde(o.sonra)} olur.`
    if (o.sonra >= OZET_YUZDE) metin += ' Konuşma kendiliğinden özetlenebilir.'
  }

  return metin
}

/** Gönderilmeyen metni kaybettirmez: mesaj kutusuna, olmazsa panoya. */
const geriKoy = async ($: EngineInterface, metin: string) => {
  const kutu = await $.prompt.fill({ text: metin, mode: 'replace' }).catch(() => undefined)
  if (kutu?.isFilled) return 'Gönderilmedi; metin mesaj kutusuna geri kondu.'
  const kopya = await $.ui.copy({ text: metin }).catch(() => undefined)
  let panoda = kopya?.isCopied === true
  if (!panoda) {
    const pb = await $.process.run(['pbcopy'], { stdin: metin, timeoutMs: 5000 }).catch(() => undefined)
    panoda = pb?.exitCode === 0
  }

  return panoda ? 'Gönderilmedi; metin panoya kopyalandı, ⌘V ile geri yapıştırabilirsin.' : 'Gönderilmedi.'
}

/** Terminalde taslak değiştikçe tahmini tazeler; yüzlük adımlarla, her tuşta çizmesin. */
const taslagiOlc = async ($: EngineInterface, metin: string, esik: number) => {
  const token = metin.trim() ? tahmin(metin) : 0
  const adim = token < esik * BANT_ORANI ? 0 : Math.round(token / 100) * 100 || token
  if ((await read($, taslak)) !== adim) await update($, taslak, () => adim)
}

export const register: Register = (on, options) => {
  const esik = typeof options.esik === 'number' && options.esik > 0 ? options.esik : 2000
  const sor = options.sor !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'token',
      description: 'Bağlamın doluluğunu söyler; /token <metin> o metnin göndermeden tahminini verir',
    })
    await update($, taslak, () => 0)

    return next(e)
  })

  // Uzun mesaj gönderilmeden önce: ne kadar yer kaplayacağını söyle, onay iste.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !INSAN.includes(e.origin.kind)) return next(e)
    const token = tahmin(e.text) + (e.attachments?.length ?? 0) * GORSEL
    await update($, taslak, () => 0)
    if (token < esik) return next(e)

    const olcum = await olc($, token)
    const kimseYok = (await $.session.surfaces()).length === 0
    if (!sor || kimseYok) {
      if (!kimseYok) $.ui.log(anlat(olcum))
      return next(e)
    }

    const soru = $.ui
      .ask(`${anlat(olcum)} Gönderilsin mi?`, { header: 'Uzun mesaj', options: ['Gönder', 'Vazgeç'] })
      .catch(() => 'kapatıldı')
    // Saat kurulamazsa bu kol hiç bitmez; karar sorunun olur.
    const bekleme = $.clock.sleep(SORU_MS).then(
      () => 'zaman aşımı',
      () => new Promise<string>(() => undefined),
    )
    const cevap = await Promise.race([soru, bekleme])
    if (cevap === 'Gönder') return next(e)

    return { drop: await geriKoy($, e.text) }
  }).catch(($, e, next) => next(e))

  on('prompt.edit', async ($, e, next) => {
    const kutu = await next(e)
    await taslagiOlc($, kutu.text, esik)

    return kutu
  })

  on('prompt.change', async ($, e, next) => {
    await taslagiOlc($, e.text, esik)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const token = await read($, taslak)
    if (!token || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const o = await olc($, token)
    const uzun = token >= esik
    const parcalar = [`≈${sayi(token)} token`, `bağlamda ${yuzde(o.pay)}`]
    if (o.sonra !== undefined) parcalar.push(`gönderince ≈${yuzde(o.sonra)}`)

    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box justifyContent="flex-end">
          <Text dimColor={!uzun} color={uzun || (o.sonra ?? 0) >= OZET_YUZDE ? 'warning' : undefined}>
            {parcalar.join(' · ')}
          </Text>
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'token' }, async ($, e) => {
    const metin = e.args.trim()
    const { context } = await $.session.usage()
    const pencere = context.window || 200_000
    if (metin) return { text: `${anlat(await olc($, tahmin(metin)))} (Gönderilmedi; yalnız ölçüldü.)` }
    const doluluk =
      context.tokens === undefined
        ? 'Bağlam henüz ölçülmedi; ilk cevaptan sonra belli olur.'
        : `Bağlam ${yuzde((context.tokens / pencere) * 100)} dolu: ${sayi(context.tokens)} / ${sayi(pencere)} token.`

    return {
      text: `${doluluk} ${sayi(esik)} token'dan (bağlamın ${yuzde((esik / pencere) * 100)}) uzun mesajlarda göndermeden önce ${sor ? 'sorarım' : 'not düşerim'}. Bir metnin tahmini için: /token <metin>`,
    }
  })
}
