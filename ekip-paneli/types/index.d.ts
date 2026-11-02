/** CI'nın son hali: hepsi geçti, biri kaldı, hâlâ çalışıyor, hiç yok. */
export type Ci = 'gecti' | 'kaldi' | 'suruyor' | 'yok'

/** İnceleme kararı: onaylandı, değişiklik istendi, inceleme bekliyor, hiçbiri. */
export type Inceleme = 'onaylandi' | 'degisiklik' | 'bekliyor' | ''

export type Pr = {
  no: number
  baslik: string
  yazar: string
  dal: string
  taslak: boolean
  ci: Ci
  inceleme: Inceleme
  /** İncelemesi istenen kişiler ve takımlar. */
  bekleyen: string[]
  /** Son güncelleme, saniye. */
  guncel: number
  url: string
}

/** Kişinin GitHub'a son gönderimi: hangi dala, ne zaman, hangi mesajla. */
export type Son = { at: number; dal: string; mesaj: string }

export type Kisi = {
  login: string
  /** GitHub profilindeki adı; yoksa kullanıcı adı. */
  ad: string
  son?: Son
  prler: Pr[]
  /** Bu kişiden incelemesi istenen başkalarının PR'ları. */
  incelemede: Pr[]
  /** PR'ı olmayan, son iki haftada gönderdiği dallar. */
  dallar: string[]
  /** Varsayılan dala son yedi günde giren commit sayısı. */
  hafta: number
  /** Ona atanmış açık iş (issue) sayısı. */
  isler: number
}

/** Kişiler listesinde seçilebilecek biri ve onu nereden bulduğumuz. */
export type Aday = { login: string; katki: number; kaynak: string }

export type Depo = {
  ad: string
  varsayilan: string
  acikPr: number
  acikIs: number
  ci: Ci
}

export type Ozet = {
  depo: Depo
  /** Paneli açanın GitHub kullanıcı adı. */
  ben: string
  kisiler: Kisi[]
  /** Senden incelemesi istenen açık PR'lar. */
  benden: Pr[]
  adaylar: Aday[]
  /** Son birleşen PR'lar, en yenisi önce. */
  birlesen: { no: number; baslik: string; yazar: string; at: number }[]
  /** Kişiler hiç seçilmemiş: en çok katkı verenler gösteriliyor. */
  varsayilanKisiler: boolean
  /** Saat dilimi farkı, dakika: "bugün" ve saatler buna göre. */
  saatFarki: number
}

export type Panel = {
  ozet?: Ozet
  sonBasari?: number
  sonDeneme?: number
  cevrimdisi: boolean
  yukleniyor: boolean
  hata?: string
}

/** Kalıcı ayarlar: izlenen depolar ve her depoda kimin görüneceği. */
export type Ayarlar = {
  depolar: string[]
  takip: Record<string, string[]>
}

declare module 'claude-code' {
  interface PluginState {
    'ekip-paneli': {
      panel: Shaped<Panel>
      ayarlar: Shaped<Ayarlar>
      /** Bu oturumda gösterilen depo, "sahip/ad". */
      secili: string
      /** Bu oturumun klasörünün GitHub deposu; yoksa boş. */
      oturumDeposu: string
      /** Panel yerine ayarlar gösteriliyor. */
      ayarda: boolean
      /** Ayarlarda son yapılanın kısa notu. */
      not: string
    }
  }
}
