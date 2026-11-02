#!/bin/sh
# Agent panel'in sorusunu cevaplayan en basit ajan.
# Panel, soruyu ve oturumun özetini standart girdiye JSON olarak verir:
#   {"question": "...", "session": {"id", "cwd", "messages", "touched"}}
# Buraya yazılan her şey cevap olarak sohbette görünür.
# Durdur'a basılınca aynı komut {"cancel": true, ...} ile bir kez daha çağrılır.

cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:$PATH"

girdi=$(cat)
case "$girdi" in
  *'"cancel":true'*) exit 0 ;;
esac

exec claude -p --append-system-prompt "$(cat persona.md)" "Yan paneldeki sohbetten bir soru geldi. Aşağıdaki JSON'da 'question' soru, 'session' ise soranın o an çalıştığı oturumun özeti (klasör, son mesajlar, dokunulan dosyalar). Yalnız soruyu cevapla.

$girdi"
