# Ekip paneli

Sohbetin yanında, bir GitHub deposunda ekibin nerede olduğunu gösteren bir panel. Seçtiğin her kişi için:

- son gönderimi: ne zaman, hangi dala, hangi commit mesajıyla,
- açık PR'ları, her birinin CI durumu (✓ / ✗ / çalışıyor), inceleme kararı ve kimden inceleme beklediği,
- PR'ı olmayan, son iki haftada gönderdiği dallar,
- son yedi günde varsayılan dala giren commit sayısı, ona atanmış açık işler ve incelemesini beklediği PR'lar.

En üstte **senden inceleme bekleyen** PR'lar, en altta deponun özeti (açık PR, açık iş, ana dalın CI'ı) ve son birleşen PR'lar durur. Panel 3 dakikada bir kendiliğinden yenilenir; internet giderse son bilinen hâli gösterir.

## Kurulum

GitHub CLI gerekir: `brew install gh`, sonra `gh auth login`. Panel depoya hiçbir şey yazmaz, yalnız okur.

## Kullanım

- `/ekip`: paneli açar. Oturumun klasörü bir GitHub deposuysa o depoyu gösterir.
- `/ekip sahip/depo` (ya da GitHub adresi): o depoyu listene ekler ve gösterir.
- `/ekip ayar`: ayarları açar. `/ekip kapat`: kapatır.

Paneldeki **⚙ Kişiler ve depolar** ile:

- **Depolar**: izlediğin depoları ekler, çıkarır, aralarında geçersin. Birden çok depo varsa panelin üstünde sekme olarak durur.
- **Kimi görmek istiyorsun?**: depoya katkıda bulunanlar, ekip üyeleri, PR açanlar ve son gönderim yapanlar katkı sayısıyla listelenir; dokunduğun kişi panele eklenir ya da çıkar. Listede olmayan birini kullanıcı adıyla ekleyebilirsin. Hiç seçim yapmazsan en çok katkı verenler gösterilir.

Seçimler her depo için ayrı tutulur ve her oturumda hatırlanır. Listendeki bir depoda çalışan oturumda panel kendiliğinden açılır; bunu mod ayarlarındaki **Kendiliğinden aç** ile kapatabilirsin.
