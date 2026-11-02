# Token önizleme

Uzun bir mesajı göndermeden önce kaç token tuttuğunu ve bağlamda (Claude'un bir konuşmada aklında tutabildiği alan) yüzde kaç yer kaplayacağını söyler, sonra sorar:

> Bu mesaj ≈12.400 token tutuyor; bağlamda %6,2 yer kaplar. Şu an %38 dolu, gönderince ≈%44 olur. Gönderilsin mi?

**Gönder** dersen mesaj gider. **Vazgeç** dersen ya da soruyu kapatırsan gitmez; metin mesaj kutusuna geri konur, konamazsa panoya kopyalanır (⌘V ile geri yapıştırırsın). Bağlam %85'i geçecekse konuşmanın kendiliğinden özetlenebileceğini de söyler.

Kısa mesajlarda hiçbir şey sormaz. Eşik varsayılan olarak 2.000 token; mod ayarlarından değiştirilebilir. **Göndermeden önce sor** kapatılırsa sormaz, yalnız sohbete not düşer.

## Komutlar

- `/token`: bağlamın şu an ne kadar dolu olduğunu söyler.
- `/token <metin>`: yapıştırdığın metnin kaç token tutacağını, göndermeden ölçer.

## Terminalde

Claude Code'u terminalde kullanıyorsan, uzun bir mesaj yazarken ya da yapıştırırken mesaj kutusunun üstünde canlı gösterge çıkar: `≈3.200 token · bağlamda %1,6 · gönderince ≈%40`. Masaüstü uygulamasının mesaj kutusu modlara açık değil; orada tahmin gönderirken gelir.

## Tahmin ne kadar doğru

Sayım yerel bir tahmindir, internete bir şey gönderilmez. Claude'un gerçek sayımıyla ayarlandı: Türkçe, İngilizce ve kodda sapma %10'un altında, çoğu metinde %5 civarı. Görsel ekleri her biri yaklaşık 1.600 token sayılır.
