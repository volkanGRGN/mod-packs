import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Aday, Ayarlar, Ci, Inceleme, Kisi, Ozet, Panel, Pr, Son } from '../types'

// Ekip paneli: bir GitHub deposunda seçtiğin kişilerin nerede olduğunu
// sohbetin yanında gösterir: son gönderim, açık PR'ları ve CI'ları, kimden
// inceleme beklediği, PR'sız dalları, haftalık commit ve atanmış işleri.
// Her şey `gh` ile okunur; depoya hiçbir şey yazılmaz. Depolar ve kimin
// görüneceği ⚙ ayarlarından seçilir ve her oturumda hatırlanır.
const PANE = 'ekip'
const BASLIK = 'Ekip'
const ARALIK_MS = 3 * 60 * 1000
/** Kişiler hiç seçilmemişken gösterilen, en çok katkı verenlerin sayısı. */
const VARSAYILAN_KISI = 6
/** Kişiler listesinde en fazla kaç aday. */
const ADAY_SINIRI = 40
/** PR'sız dal sayılması için son gönderimin en eski hali. */
const DAL_GUN = 14
/** "Son birleşenler" satırı. */
const BIRLESEN_SAYI = 3

const AYLAR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara']
const GONDERIM = ['push', 'force_push', 'branch_creation', 'pr_merge', 'merge_queue_merge']
const ORTAM = { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' }

const panel = atom(
  { plugin: 'ekip-paneli', key: 'panel' } as const,
  { cevrimdisi: false, yukleniyor: false } as Panel,
  { shape: 'panel-2' },
)
const ayarlar = atom(
  { plugin: 'ekip-paneli', key: 'ayarlar' } as const,
  { depolar: [], takip: {} } as Ayarlar,
  { shape: 'ayarlar-1' },
)
const secili = atom({ plugin: 'ekip-paneli', key: 'secili' } as const, '')
const oturumDeposu = atom({ plugin: 'ekip-paneli', key: 'oturumDeposu' } as const, '')
const ayarda = atom({ plugin: 'ekip-paneli', key: 'ayarda' } as const, false)
const not = atom({ plugin: 'ekip-paneli', key: 'not' } as const, '')

type Etkinlik = { at: string; login: string; tur: string; ref: string; sonra: string }
type GhKontrol = { status?: string; conclusion?: string; state?: string }
type GhPr = {
  number: number
  title: string
  author?: { login?: string }
  headRefName: string
  isDraft: boolean
  reviewDecision?: string
  reviewRequests?: { login?: string; name?: string; slug?: string }[]
  statusCheckRollup?: GhKontrol[]
  updatedAt: string
  url: string
}

const calistir = async ($: EngineInterface, argv: string[], timeoutMs = 20000) => {
  const [komut = '', ...argumanlar] = argv
  const adaylar = komut === 'gh' ? ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'] : [komut]
  let hata: unknown
  for (const aday of adaylar) {
    try {
      return await $.process.run([aday, ...argumanlar], { timeoutMs, env: ORTAM, cwd: '/' })
    } catch (err) {
      hata = err
    }
  }
  throw hata ?? new Error(`${komut} çalışmadı`)
}

/** `gh` çıktısını JSON olarak okur; hata olursa gh'nin kendi sözüyle düşer. */
const ghJson = async <T,>($: EngineInterface, args: string[]): Promise<T> => {
  const r = await calistir($, ['gh', ...args])
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `gh ${r.exitCode} koduyla bitti`)

  return JSON.parse(r.stdout || 'null') as T
}

const saniye = (iso: string | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : 0)

/** "sahip/ad"a çevirir: GitHub adresi, git@ adresi ya da düz "sahip/ad". */
const depoAdi = (metin: string) => {
  const temiz = metin.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  const adres = temiz.match(/github\.com[:/]([^/\s]+)\/([^/\s]+)/)
  if (adres) return `${adres[1]}/${adres[2]}`
  return /^[\w.-]+\/[\w.-]+$/.test(temiz) ? temiz : ''
}

const ciDurumu = (kontroller: GhKontrol[] | undefined): Ci => {
  if (!kontroller?.length) return 'yok'
  const sonuclar = kontroller.map(k =>
    (k.conclusion || k.state || (k.status && k.status !== 'COMPLETED' ? 'PENDING' : 'SUCCESS')).toUpperCase(),
  )
  const kalan = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
  if (sonuclar.some(s => kalan.includes(s))) return 'kaldi'
  if (sonuclar.some(s => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING'].includes(s))) return 'suruyor'

  return 'gecti'
}

const inceleme = (karar: string | undefined): Inceleme => {
  if (karar === 'APPROVED') return 'onaylandi'
  if (karar === 'CHANGES_REQUESTED') return 'degisiklik'
  if (karar === 'REVIEW_REQUIRED') return 'bekliyor'
  return ''
}

const prCevir = (pr: GhPr): Pr => ({
  no: pr.number,
  baslik: pr.title,
  yazar: pr.author?.login ?? '',
  dal: pr.headRefName,
  taslak: pr.isDraft,
  ci: ciDurumu(pr.statusCheckRollup),
  inceleme: inceleme(pr.reviewDecision),
  bekleyen: (pr.reviewRequests ?? []).map(r => r.login ?? r.name ?? r.slug ?? '').filter(Boolean),
  guncel: saniye(pr.updatedAt),
  url: pr.url,
})

const botMu = (login: string) => login.endsWith('[bot]') || login === 'dependabot' || login === 'github-actions'

let benimAdim: string | undefined
const benKim = async ($: EngineInterface) => {
  if (!benimAdim) {
    const r = await calistir($, ['gh', 'api', 'user', '--jq', '.login'])
    if (r.exitCode === 0) benimAdim = r.stdout.trim()
  }

  return benimAdim ?? ''
}

/** Commit mesajlarının ilk satırı, sha'ya göre; bir kez sorulur. */
const mesajlar = new Map<string, string>()
const commitMesaji = async ($: EngineInterface, repo: string, sha: string) => {
  if (!sha || /^0+$/.test(sha)) return ''
  if (!mesajlar.has(sha)) {
    const r = await calistir($, ['gh', 'api', `repos/${repo}/commits/${sha}`, '--jq', '.commit.message | split("\n")[0]'])
    if (r.exitCode !== 0) return ''
    mesajlar.set(sha, r.stdout.trim())
  }

  return mesajlar.get(sha) ?? ''
}

/** GitHub profilindeki adlar; değişmez sayılır ve oturumlar arası saklanır. */
const adlar = async ($: EngineInterface, loginler: string[]) => {
  const kayitli = await $.store.get('adlar').catch(() => undefined)
  const bilinen: Record<string, string> = kayitli && typeof kayitli === 'object' ? { ...(kayitli as Record<string, string>) } : {}
  const eksik = loginler.filter(login => !(login in bilinen))
  if (eksik.length) {
    await Promise.all(
      eksik.map(async login => {
        const r = await calistir($, ['gh', 'api', `users/${login}`, '--jq', '.name // ""']).catch(() => undefined)
        if (r?.exitCode === 0) bilinen[login] = r.stdout.trim()
      }),
    )
    await $.store.set('adlar', bilinen).catch(() => undefined)
  }

  return bilinen
}

const saatFarkiOku = async ($: EngineInterface) => {
  const tarih = await calistir($, ['date', '+%z']).catch(() => undefined)
  const dilim = tarih?.stdout.trim().match(/^([+-])(\d\d)(\d\d)$/)
  return dilim
    ? (dilim[1] === '-' ? -1 : 1) * (Number(dilim[2]) * 60 + Number(dilim[3]))
    : -new Date().getTimezoneOffset()
}

/** Okunamayınca kişiye söylenecek söz: gh yok, giriş yok, depo yok ya da internet yok. */
const hataSozu = (err: unknown) => {
  const metin = err instanceof Error ? err.message : String(err)
  if (/Not Found|Could not resolve to a Repository|HTTP 404/i.test(metin)) return 'Depo bulunamadı ya da erişimin yok.'
  if (/auth login|not logged|authentication|HTTP 401/i.test(metin)) return 'GitHub\'a giriş yapılmamış. Terminalde: gh auth login'
  if (/ENOENT|No such file|spawn|çalışmadı/i.test(metin)) return 'GitHub CLI (gh) bulunamadı. Kur: brew install gh, sonra gh auth login.'
  if (/connect|network|timed? ?out|dial tcp|resolve host|offline/i.test(metin)) return 'İnternete ulaşılamadı.'

  return metin.split('\n')[0] ?? metin
}

const topla = async (
  $: EngineInterface,
  repo: string,
  takip: string[] | undefined,
): Promise<Ozet> => {
  const json = <T,>(...args: string[]) => ghJson<T>($, args)
  // Önce deponun kendisi: giriş, erişim ve internet burada belli olur.
  const bilgi = await json<{ varsayilan: string; tam: string }>(
    'api',
    `repos/${repo}`,
    '--jq',
    '{varsayilan: .default_branch, tam: .full_name}',
  )
  const yediGunOnce = new Date(Date.now() - 7 * 86400 * 1000).toISOString()

  const [ben, katkicilar, ekip, etkinlikler, acikPr, birlesenPr, commitler, isler, calisma, saatFarki] =
    await Promise.all([
      benKim($),
      json<{ login: string; katki: number; tur: string }[]>(
        'api',
        `repos/${repo}/contributors?per_page=100`,
        '--jq',
        '[.[] | {login, katki: .contributions, tur: .type}]',
      ).catch(() => []),
      // Yazma yetkisi olmayan göremez; o zaman boş kalır.
      json<string[]>('api', `repos/${repo}/collaborators?per_page=100`, '--jq', '[.[].login]').catch(() => []),
      json<Etkinlik[]>(
        'api',
        `repos/${repo}/activity?per_page=100`,
        '--jq',
        '[.[] | {at: .timestamp, login: (.actor.login // ""), tur: .activity_type, ref, sonra: .after}]',
      ).catch(() => []),
      json<GhPr[]>(
        'pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json',
        'number,title,author,headRefName,isDraft,reviewDecision,reviewRequests,statusCheckRollup,updatedAt,url',
      ),
      json<{ number: number; title: string; author?: { login?: string }; headRefName: string; mergedAt: string }[]>(
        'pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '20', '--json', 'number,title,author,headRefName,mergedAt',
      ).catch(() => []),
      json<{ login: string }[]>(
        'api',
        `repos/${repo}/commits?per_page=100&since=${yediGunOnce}`,
        '--jq',
        '[.[] | {login: (.author.login // "")}]',
      ).catch(() => []),
      json<{ assignees: { login: string }[] }[]>(
        'issue', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'assignees',
      ).catch(() => undefined),
      json<{ status: string; conclusion: string }[]>(
        'run', 'list', '--repo', repo, '--limit', '20', '--json', 'status,conclusion,headBranch',
        '--jq', `[.[] | select(.headBranch == "${bilgi.varsayilan}")]`,
      ).catch(() => []),
      saatFarkiOku($),
    ])

  const prler = acikPr.map(prCevir)
  const prDallari = new Set([...prler.map(pr => pr.dal), ...birlesenPr.map(pr => pr.headRefName)])

  // Seçilebilecek herkes: katkıda bulunanlar, ekip üyeleri, PR açanlar, son gönderim yapanlar.
  const adaylar = new Map<string, Aday>()
  const ekle = (login: string, katki: number, kaynak: string) => {
    if (!login || botMu(login)) return
    const var_ = adaylar.get(login)
    if (var_) var_.katki = Math.max(var_.katki, katki)
    else adaylar.set(login, { login, katki, kaynak })
  }
  for (const k of katkicilar) if (k.tur !== 'Bot') ekle(k.login, k.katki, 'katkıda bulundu')
  for (const login of ekip) ekle(login, 0, 'ekip üyesi')
  for (const pr of [...acikPr, ...birlesenPr]) ekle(pr.author?.login ?? '', 0, 'PR açtı')
  for (const etk of etkinlikler) ekle(etk.login, 0, 'gönderim yaptı')
  const siralanmis = [...adaylar.values()]
    .sort((a, b) => b.katki - a.katki || a.login.localeCompare(b.login))
    .slice(0, ADAY_SINIRI)

  const varsayilanKisiler = !takip?.length
  const gosterilen = varsayilanKisiler ? siralanmis.slice(0, VARSAYILAN_KISI).map(a => a.login) : (takip ?? [])

  // Etkinlik en yeniden eskiye: silinen dal, ondan önceki gönderimleri geçersiz kılar.
  const dallarOf = (login: string) => {
    const silinen = new Set<string>()
    const dallar: string[] = []
    const sinir = Date.now() / 1000 - DAL_GUN * 86400
    for (const etk of etkinlikler) {
      if (etk.tur === 'branch_deletion') silinen.add(etk.ref)
      if (etk.login !== login || !['push', 'force_push', 'branch_creation'].includes(etk.tur)) continue
      const dal = etk.ref.replace(/^refs\/heads\//, '')
      if (!etk.ref.startsWith('refs/heads/') || dal === bilgi.varsayilan || silinen.has(etk.ref)) continue
      if (prDallari.has(dal) || dallar.includes(dal) || saniye(etk.at) < sinir) continue
      dallar.push(dal)
    }
    return dallar
  }

  const sonOf = async (login: string): Promise<Son | undefined> => {
    const son = etkinlikler.find(etk => etk.login === login && GONDERIM.includes(etk.tur))
    if (!son) return undefined
    const dal = son.ref.replace(/^refs\/heads\//, '')
    return { at: saniye(son.at), dal, mesaj: (await commitMesaji($, repo, son.sonra)) || dal }
  }

  const isAtanan = (login: string) => (isler ?? []).filter(is => is.assignees.some(a => a.login === login)).length
  const profilAdi = await adlar($, gosterilen)

  const kisiler: Kisi[] = await Promise.all(
    gosterilen.map(async login => ({
      login,
      ad: profilAdi[login] || login,
      son: await sonOf(login),
      prler: prler.filter(pr => pr.yazar === login),
      incelemede: prler.filter(pr => pr.bekleyen.includes(login)),
      dallar: dallarOf(login),
      hafta: commitler.filter(c => c.login === login).length,
      isler: isAtanan(login),
    })),
  )

  const sonCalisma = calisma[0]
  let ci: Ci = 'yok'
  if (sonCalisma) {
    if (sonCalisma.status !== 'completed') ci = 'suruyor'
    else ci = ['success', 'skipped', 'neutral'].includes(sonCalisma.conclusion) ? 'gecti' : 'kaldi'
  }

  return {
    depo: {
      ad: bilgi.tam || repo,
      varsayilan: bilgi.varsayilan,
      acikPr: prler.length,
      acikIs: isler?.length ?? 0,
      ci,
    },
    ben,
    kisiler,
    benden: ben ? prler.filter(pr => pr.bekleyen.includes(ben)) : [],
    adaylar: siralanmis,
    birlesen: [...birlesenPr]
      .sort((a, b) => saniye(b.mergedAt) - saniye(a.mergedAt))
      .slice(0, BIRLESEN_SAYI)
      .map(pr => ({ no: pr.number, baslik: pr.title, yazar: pr.author?.login ?? '', at: saniye(pr.mergedAt) })),
    varsayilanKisiler,
    saatFarki,
  }
}

// Modülün kendi değişkenleri: yeniden yüklemede sıfırlanır, durum kalır.
let tekrar = false
let zamanlayici: Timer | undefined
let kendiliginden = true

const ayarKaydet = async ($: EngineInterface, degistir: (a: Ayarlar) => Ayarlar) => {
  const yeni = await update($, ayarlar, degistir)
  await $.store.set('ayarlar', yeni).catch(() => undefined)

  return yeni
}

/** Gösterilecek depo: seçilen, yoksa oturumun deposu, yoksa listedeki ilk. */
const hangiDepo = async ($: EngineInterface) => {
  const a = await read($, ayarlar)
  const s = await read($, secili)
  if (s) return s
  const oturum = await read($, oturumDeposu)
  if (oturum) return oturum

  return a.depolar[0] ?? ''
}

/** Paneli tazeler; zaten tazeleniyorsa o bitince bir kez daha, ve ikisini bekler. */
let calisan: Promise<void> | undefined
const yenile = ($: EngineInterface): Promise<void> => {
  if (calisan) {
    tekrar = true
    return calisan
  }
  calisan = (async () => {
    try {
      do {
        tekrar = false
        const repo = await hangiDepo($)
        if (!repo) {
          await update($, panel, p => ({ ...p, yukleniyor: false, hata: undefined }))
          break
        }
        await update($, panel, p => ({ ...p, yukleniyor: true }))
        const simdi = Math.floor(Date.now() / 1000)
        try {
          const takip = (await read($, ayarlar)).takip[repo]
          const ozet = await topla($, repo, takip)
          // Bu arada başka depoya geçildiyse eski deponun sonucu gösterilmez.
          if ((await hangiDepo($)) !== repo) {
            tekrar = true
            continue
          }
          const yeni = await update($, panel, p => ({
            ...p,
            ozet,
            cevrimdisi: false,
            sonDeneme: simdi,
            sonBasari: simdi,
            yukleniyor: false,
            hata: undefined,
          }))
          await $.store.set(`panel:${repo}`, yeni).catch(() => undefined)
        } catch (err) {
          // Okunamadıysa son bilinen hal kalır; panel düşmez.
          await update($, panel, p => ({
            ...p,
            cevrimdisi: true,
            sonDeneme: simdi,
            yukleniyor: false,
            hata: hataSozu(err),
          }))
        }
      } while (tekrar)
    } catch {
      // Durum yazılamadıysa bir sonraki turda yeniden denenir.
    } finally {
      calisan = undefined
    }
  })()

  return calisan
}

const baslat = ($: EngineInterface) => {
  if (!zamanlayici) zamanlayici = $.clock.every(ARALIK_MS, () => void yenile($))
  void yenile($)
}

const durdur = () => {
  zamanlayici?.cancel()
  zamanlayici = undefined
}

const ac = async ($: EngineInterface) => {
  void $.ui.open({ id: PANE, title: BASLIK })
  baslat($)
}

/** Başka depoya geçer: önce o deponun son bilinen hali, sonra taze okuma. */
const depoSec = async ($: EngineInterface, repo: string) => {
  await update($, secili, () => repo)
  await $.store.set('sonSecili', repo).catch(() => undefined)
  const kayitli = await $.store.get(`panel:${repo}`).catch(() => undefined)
  await update($, panel, () =>
    kayitli && typeof kayitli === 'object'
      ? { ...(kayitli as Panel), yukleniyor: false }
      : { cevrimdisi: false, yukleniyor: false },
  )
  void yenile($)
}

const depoEkle = async ($: EngineInterface, yazilan: string) => {
  const ad = depoAdi(yazilan)
  if (!ad) {
    await update($, not, () => `"${yazilan.trim()}" bir depo adı gibi değil; sahip/ad yaz ya da GitHub adresini yapıştır.`)
    return
  }
  const r = await calistir($, ['gh', 'api', `repos/${ad}`, '--jq', '.full_name']).catch(() => undefined)
  if (!r || r.exitCode !== 0) {
    await update($, not, () => `${ad}: ${hataSozu(new Error(r?.stderr || 'gh çalışmadı'))}`)
    return
  }
  const tam = r.stdout.trim() || ad
  await ayarKaydet($, a => ({ ...a, depolar: [...new Set([...a.depolar, tam])] }))
  await update($, not, () => `${tam} eklendi.`)
  await depoSec($, tam)
}

const depoSil = async ($: EngineInterface, repo: string) => {
  const yeni = await ayarKaydet($, a => ({ ...a, depolar: a.depolar.filter(d => d !== repo) }))
  await update($, not, () => `${repo} listeden çıkarıldı.`)
  if ((await read($, secili)) === repo) await depoSec($, (await read($, oturumDeposu)) || yeni.depolar[0] || '')
}

/** Bir kişiyi gösterilenlere ekler ya da çıkarır; seçim yoksa şu an görünenlerden başlar. */
const kisiDegistir = async ($: EngineInterface, login: string) => {
  const repo = await hangiDepo($)
  if (!repo) return
  const ozet = (await read($, panel)).ozet
  const simdiki = (await read($, ayarlar)).takip[repo]
  const baslangic = simdiki?.length ? simdiki : ozet?.varsayilanKisiler ? ozet.kisiler.map(k => k.login) : []
  const yeni = baslangic.includes(login) ? baslangic.filter(l => l !== login) : [...baslangic, login]
  await ayarKaydet($, a => ({ ...a, takip: { ...a.takip, [repo]: yeni } }))
  void yenile($)
}

const kisiEkle = async ($: EngineInterface, yazilan: string) => {
  const login = yazilan.trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//, '').replace(/\/.*$/, '')
  if (!login) return
  const r = await calistir($, ['gh', 'api', `users/${login}`, '--jq', '.login']).catch(() => undefined)
  if (!r || r.exitCode !== 0) {
    await update($, not, () => `GitHub'da "${login}" diye biri bulunamadı.`)
    return
  }
  const tam = r.stdout.trim() || login
  const repo = await hangiDepo($)
  const ozet = (await read($, panel)).ozet
  const simdiki = (await read($, ayarlar)).takip[repo]
  if (simdiki?.includes(tam) || (!simdiki?.length && ozet?.kisiler.some(k => k.login === tam))) {
    await update($, not, () => `${tam} zaten listede.`)
    return
  }
  await kisiDegistir($, tam)
  await update($, not, () => `${tam} eklendi.`)
}

const secimiSifirla = async ($: EngineInterface) => {
  const repo = await hangiDepo($)
  await ayarKaydet($, a => {
    const takip = { ...a.takip }
    delete takip[repo]
    return { ...a, takip }
  })
  await update($, not, () => 'Seçim sıfırlandı: en çok katkı verenler gösterilecek.')
  void yenile($)
}

/** Oturumun klasörünün GitHub deposu, "sahip/ad"; yoksa boş. */
const oturumDeposunuBul = async ($: EngineInterface, cwd: string) => {
  const r = await calistir($, ['git', '-C', cwd, 'remote', 'get-url', 'origin'], 5000).catch(() => undefined)
  return r?.exitCode === 0 ? depoAdi(r.stdout) : ''
}

const saat = (at: number, fark: number) => {
  const d = new Date((at + fark * 60) * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

const gun = (at: number, fark: number) => Math.floor((at + fark * 60) / 86400)

const once = (saniye: number) => {
  const dk = Math.max(0, Math.floor(saniye / 60))
  if (dk < 1) return 'az önce'
  if (dk < 60) return `${dk} dk önce`
  const sa = Math.floor(dk / 60)
  if (sa < 24) return dk % 60 ? `${sa} sa ${dk % 60} dk önce` : `${sa} sa önce`
  const g = Math.floor(sa / 24)

  return g === 1 ? 'dün' : `${g} gün önce`
}

const tarih = (at: number, simdi: number, fark: number) => {
  if (gun(at, fark) === gun(simdi, fark)) return `${once(simdi - at)} (${saat(at, fark)})`
  const d = new Date((at + fark * 60) * 1000)
  return `${d.getUTCDate()} ${AYLAR[d.getUTCMonth()]} ${saat(at, fark)}`
}

const CI_SOZ: Record<Ci, string> = { gecti: 'CI ✓', kaldi: 'CI ✗ kaldı', suruyor: 'CI çalışıyor', yok: '' }
const INCELEME_SOZ: Record<Inceleme, string> = {
  onaylandi: 'onaylandı',
  degisiklik: 'değişiklik istendi',
  bekliyor: 'inceleme bekliyor',
  '': '',
}

/** PR'ın durumu tek satırda: taslak, CI, inceleme ve kimden beklendiği. */
const prDurumu = (pr: Pr) => {
  const parcalar = [pr.taslak ? 'taslak' : '', CI_SOZ[pr.ci], INCELEME_SOZ[pr.inceleme]]
  if (pr.bekleyen.length) parcalar.push(`bekleyen: ${pr.bekleyen.join(', ')}`)
  return parcalar.filter(Boolean).join(' · ')
}

export const register: Register = (on, options) => {
  kendiliginden = options.kendiliginden !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ekip',
      description: 'Ekip panelini açar (/ekip ayar: kişiler ve depolar, /ekip sahip/ad: depo ekler, /ekip kapat)',
    })
    const kayitliAyar = await $.store.get('ayarlar').catch(() => undefined)
    if (kayitliAyar && typeof kayitliAyar === 'object' && Array.isArray((kayitliAyar as Ayarlar).depolar)) {
      await update($, ayarlar, () => kayitliAyar as Ayarlar)
    }
    const oturum = await oturumDeposunuBul($, e.cwd)
    await update($, oturumDeposu, () => oturum)
    const a = await read($, ayarlar)
    if (!(await read($, secili))) {
      const son = await $.store.get('sonSecili').catch(() => undefined)
      const ilk = a.depolar.includes(oturum)
        ? oturum
        : typeof son === 'string' && a.depolar.includes(son)
          ? son
          : a.depolar[0] ?? oturum
      if (ilk) await depoSec($, ilk)
    }
    const acik = (await $.ui.panes()).some(pane => pane.id === PANE)
    // Listedeki bir depoda çalışılıyorsa panel kendiliğinden açılır.
    if (acik || (kendiliginden && oturum && a.depolar.includes(oturum))) await ac($)

    return next(e)
  })

  on('command.run', { command: 'ekip' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'kapat') {
      durdur()
      await $.ui.close({ id: PANE })
      return { text: 'Ekip paneli kapatıldı.' }
    }
    if (arg === 'ayar' || arg === 'ayarlar') await update($, ayarda, () => true)
    else if (arg) await depoEkle($, arg)
    await ac($)
    const repo = await hangiDepo($)

    return {
      text: repo
        ? `Ekip paneli açıldı (${repo}); 3 dakikada bir yenilenir.`
        : 'Ekip paneli açıldı. Bir depo seç: /ekip sahip/ad ya da paneldeki ⚙.',
    }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    durdur()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const el = $.ui.resolve(e)
    const Input = 'Input' in el ? el.Input : undefined
    const p = await read($, panel)
    const a = await read($, ayarlar)
    const repo = await hangiDepo($)
    const oturum = await read($, oturumDeposu)
    const o = p.ozet && p.ozet.depo.ad.toLowerCase() === repo.toLowerCase() ? p.ozet : undefined
    const simdi = Math.floor(Date.now() / 1000)
    const fark = o?.saatFarki ?? -new Date().getTimezoneOffset()

    // Birden çok depo varsa üstte aralarında geçiş.
    const depolar = [...new Set([...a.depolar, ...(repo && !a.depolar.includes(repo) ? [repo] : [])])]
    const ustSerit = depolar.length > 1 && (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {depolar.map(d => (
          <Button
            key={`sekme:${d}`}
            variant={d === repo ? 'primary' : 'secondary'}
            label={d.split('/')[1] ?? d}
            onPress={() => depoSec($, d)}
          />
        ))}
      </Box>
    )

    if (await read($, ayarda)) {
      const takip = a.takip[repo]
      const gorunen = takip?.length ? takip : o?.varsayilanKisiler ? o.kisiler.map(k => k.login) : []
      const yaziNotu = await read($, not)

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text bold>Depolar</Text>
            {a.depolar.length === 0 && <Text dimColor>Henüz depo eklenmedi.</Text>}
            {a.depolar.map(d => (
              <Box key={`depo:${d}`} flexDirection="row" gap={1}>
                <Button key={`sec:${d}`} plain dimColor={d !== repo} label={d === repo ? `● ${d}` : `○ ${d}`} onPress={() => depoSec($, d)} />
                <Button key={`sil:${d}`} plain dimColor label="✕ çıkar" onPress={() => depoSil($, d)} />
              </Box>
            ))}
            {oturum && !a.depolar.includes(oturum) && (
              <Button key="oturum-ekle" variant="secondary" label={`+ Bu oturumun deposu: ${oturum}`} onPress={() => depoEkle($, oturum)} />
            )}
            {Input && (
              <Input key="depo-ekle" placeholder="sahip/depo ya da GitHub adresi" submitLabel="Ekle" onSubmit={value => depoEkle($, value)} />
            )}
          </Box>
          {repo && (
            <Box flexDirection="column">
              <Text bold>Kimi görmek istiyorsun? · {repo}</Text>
              <Text dimColor>
                Seçtiklerin panelde görünür. Liste: katkıda bulunanlar, ekip üyeleri, PR açanlar ve son gönderim yapanlar.
              </Text>
              {!o && <Text dimColor>Liste yükleniyor…</Text>}
              {o?.adaylar.map(aday => {
                const secik = gorunen.includes(aday.login)
                return (
                  <Button key={`kisi:${aday.login}`} plain dimColor={!secik} onPress={() => kisiDegistir($, aday.login)}>
                    {secik ? '✓ ' : '+ '}
                    {aday.login}
                    <Text dimColor>{aday.katki ? ` · ${aday.katki} katkı` : ` · ${aday.kaynak}`}</Text>
                  </Button>
                )
              })}
              {gorunen
                .filter(login => !o?.adaylar.some(aday => aday.login === login))
                .map(login => (
                  <Button key={`kisi:${login}`} plain onPress={() => kisiDegistir($, login)}>
                    {'✓ '}
                    {login}
                    <Text dimColor> · elle eklendi</Text>
                  </Button>
                ))}
              {Input && (
                <Input key="kisi-ekle" placeholder="Listede yoksa GitHub kullanıcı adı" submitLabel="Ekle" onSubmit={value => kisiEkle($, value)} />
              )}
              {takip?.length ? (
                <Button key="sifirla" plain dimColor label="Seçimi sıfırla (en çok katkı verenler)" onPress={() => secimiSifirla($)} />
              ) : null}
            </Box>
          )}
          {yaziNotu && <Text dimColor>{yaziNotu}</Text>}
          <Button key="geri" variant="primary" label="← Panele dön" onPress={() => update($, ayarda, () => false)} />
        </Box>
      )
    }

    let durum = 'yükleniyor…'
    if (p.cevrimdisi) {
      durum = `okunamadı, son güncelleme ${p.sonBasari ? saat(p.sonBasari, fark) : 'yok'}`
    } else if (p.sonDeneme) {
      durum = `güncellendi ${saat(p.sonDeneme, fark)}`
    }
    if (p.yukleniyor && o) durum += ' · yenileniyor…'

    const altDugmeler = (
      <Box flexDirection="row" gap={1}>
        <Button key="yenile" label="Yenile" onPress={() => yenile($)} />
        <Button key="ayar" variant="secondary" label="⚙ Kişiler ve depolar" onPress={() => update($, ayarda, () => true)} />
      </Box>
    )

    if (!repo) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text>Henüz bir depo seçilmedi.</Text>
          <Text dimColor>⚙ ile bir GitHub deposu ekle ya da sohbete /ekip sahip/ad yaz.</Text>
          {altDugmeler}
        </Box>
      )
    }

    if (!o) {
      return (
        <Box flexDirection="column" gap={1}>
          {ustSerit}
          <Text bold>{repo}</Text>
          <Text dimColor>{durum}</Text>
          {p.hata && <Text color="warning">{p.hata}</Text>}
          {altDugmeler}
        </Box>
      )
    }

    const prSatiri = (pr: Pr, onEk = '') => (
      <Box key={`pr:${onEk}${pr.no}`} flexDirection="row" gap={1} flexWrap="wrap">
        <Link href={pr.url} label={`PR #${pr.no}`} />
        <Text>{pr.baslik}</Text>
        {prDurumu(pr) && <Text dimColor color={pr.ci === 'kaldi' || pr.inceleme === 'degisiklik' ? 'warning' : undefined}>· {prDurumu(pr)}</Text>}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {ustSerit}
        <Box flexDirection="column">
          <Text bold>{o.depo.ad}</Text>
          <Text dimColor color={p.cevrimdisi ? 'warning' : undefined}>
            {durum}
          </Text>
          {p.cevrimdisi && p.hata && <Text color="warning">{p.hata}</Text>}
        </Box>

        {o.benden.length > 0 && (
          <Box flexDirection="column">
            <Text bold color="warning">Senden inceleme bekleyen ({o.benden.length})</Text>
            {o.benden.map(pr => (
              <Box key={`benden:${pr.no}`} flexDirection="row" gap={1} flexWrap="wrap">
                <Link href={pr.url} label={`PR #${pr.no}`} />
                <Text>{pr.baslik}</Text>
                <Text dimColor>— {pr.yazar}</Text>
              </Box>
            ))}
          </Box>
        )}

        {o.kisiler.map(kisi => {
          const ozetSatiri = [
            `7 günde ${kisi.hafta} commit`,
            kisi.isler ? `${kisi.isler} açık iş` : '',
            kisi.incelemede.length ? `${kisi.incelemede.length} PR incelemesini bekliyor` : '',
          ]
            .filter(Boolean)
            .join(' · ')
          return (
            <Box key={`kisi:${kisi.login}`} flexDirection="column">
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                <Text bold>{kisi.ad}</Text>
                <Text dimColor>
                  @{kisi.login}
                  {kisi.login === o.ben ? ' (sen)' : ''}
                </Text>
              </Box>
              <Text>
                {kisi.son
                  ? `${tarih(kisi.son.at, simdi, fark)} · ${kisi.son.dal} — ${kisi.son.mesaj}`
                  : 'son 100 olayda gönderimi yok'}
              </Text>
              {kisi.prler.map(pr => prSatiri(pr, `${kisi.login}:`))}
              {kisi.dallar.length > 0 && <Text dimColor>PR'sız dal: {kisi.dallar.join(', ')}</Text>}
              <Text dimColor>{ozetSatiri}</Text>
            </Box>
          )
        })}

        {o.varsayilanKisiler && (
          <Text dimColor>En çok katkı verenler gösteriliyor; kimi göreceğini ⚙ Kişiler ve depolar'dan seç.</Text>
        )}

        <Box flexDirection="column">
          <Text>
            Açık PR {o.depo.acikPr} · açık iş {o.depo.acikIs}
            {o.depo.ci !== 'yok' ? ` · ${o.depo.varsayilan} ${CI_SOZ[o.depo.ci]}` : ''}
          </Text>
          {o.birlesen.length > 0 && <Text dimColor>Son birleşenler:</Text>}
          {o.birlesen.map(pr => (
            <Text key={`birlesen:${pr.no}`} dimColor>
              #{pr.no} {pr.baslik} — {pr.yazar}, {tarih(pr.at, simdi, fark)}
            </Text>
          ))}
        </Box>
        {altDugmeler}
      </Box>
    )
  })
}
