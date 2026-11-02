# Agent panel

Her Claude Code oturumunun yanında kendi ajanınla konuşabileceğin bir sohbet. Mesaj kutusunun hemen üstünde, sağda **✳ Assistant** düğmesi çıkar; basınca sohbet sağ tarafta açılır. Sorduğun soru, o an çalıştığın oturumun klasörü, son mesajları ve dokunduğu dosyalarla birlikte ajana gider; ajan da bunları bilerek cevap verir. Ana işe dokunmaz.

Hiçbir şey kurmazsan oturumun kendi Claude'u cevaplar. Kendi ajanını bağlarsan o cevaplar.

## Kendi ajanını bağlamak

1. Bu klasördeki `ornek-ajan` klasörünü istediğin yere kopyala (örneğin `~/ajanim`).
2. İçindeki `persona.md` dosyasını kendine göre yaz: adı, üslubu, neyi bilip neyi bilmediği.
3. Sohbeti aç, sağ üstteki **⚙ Ayarlar**'a bas, **📁 Klasör seç…** ile kopyaladığın klasörü seç.

Bağlantı her oturumda hatırlanır (`~/.config/agent-panel/agent.json`). **Bağlantıyı kes** ile tekrar oturumun Claude'una dönersin. Proje klasörünün yanında `persona.md` ya da `agent-panel.json` olan bir klasör varsa panel "Bu senin ajanın mı?" diye kendisi sorar.

## Ajan nasıl çalışır

Bir ajan klasörü, kendini `agent-panel.json` ile tanıtır:

```json
{ "name": "Benim ajanım", "command": ["./ask.sh"] }
```

Panel her soruda bu komutu çalıştırır ve standart girdiye şu JSON'u verir:

```json
{
  "question": "kullanıcının sorusu",
  "session": { "id": "...", "cwd": "/oturumun/klasoru", "messages": [{ "role": "user", "text": "..." }], "touched": ["Edit src/app.ts"] }
}
```

Komutun standart çıktıya yazdığı her şey cevap olarak sohbette görünür (Markdown olur). Sıfır dışı bir kodla biterse hata olarak gösterilir. Durdur'a basılınca aynı komut `{"cancel": true, "session": {"id": "..."}}` ile bir kez daha çağrılır; bilmeyen ajan bunu yok sayabilir. Bir soru en fazla 10 dakika sürebilir.

`ornek-ajan/ask.sh` bunu en basit hâliyle yapar: soruyu `claude -p`'ye, `persona.md`'yi de ek sistem talimatı olarak verir. Kendi programını (Node, Python, başka bir model) aynı sözleşmeyle yazabilirsin.

## Komutlar

- `/ajan`: sohbeti sağda açar.

Klasör seçici macOS'un kendi penceresini kullanır.
