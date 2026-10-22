# Kalibrasyon kampanyası protokolü (Kasım–Aralık budama sezonu)

Amaç: çok-sensör budama kararının (optik + radar "basamak" modeli) eşiklerini **sahada görülen
gerçekle** sabitlemek ve Bakanlık/ÇAYKUR önünde "yakalama %X, yanlış alarm %Y" diyebilmek.
Kampanya tamamlanana kadar site ve raporlar "kalibre edilmedi · idari ön değerlendirme" etiketini taşır.

## 1. Örneklem (saha planı)

Site → Çay Envanteri → Budama Takibi → **Kalibrasyon (saha)** sekmesi planı üretir
(`GET areas/:id/calibration/plan`). Plan deterministiktir (bahçe kodundan türeyen sıralama) ve
uydu kararına göre katmanlıdır:

| Uydu kararı | Hedef pay | Neden |
|---|---|---|
| Budandı (kesin) | tümü | az sayıda; her biri kritik |
| Olası budama | %30 | politika bunları kabul ediyor, doğrulanmalı |
| Budama yok | %25 | yanlış alarm ve kaçırma oranı için negatifler |
| Belirsiz | kalan (%45) | eşiğin tam kenarı; en bilgilendirici grup |

Çataldere için 240 bahçe (344'ün %70'i) yeterli; mevkii bazlı dağılım planda görünür.
Parsel dışı serbest yamalar bu turda plana girmez (sahibi yok).

## 2. Saha formu (mobil)

Her bahçede saha personeli:

1. **Durum** seçer: *Budandı* (derin budama, bahçenin çoğu) · *Kısmen* (payı % olarak girer) ·
   *Budanmadı* · *Emin değilim* (ulaşılamadı; puanlamaya girmez).
2. **Gözlem tarihi** (varsayılan bugün). Budama Kasım–Şubat'ta yapıldığından ziyaret Şubat–Nisan'da
   da olabilir; kesilmiş gövde ve sürgün izi aylarca görünür.
3. **Konumumu al**: bahçenin kenarında, GPS doğruluğu ≤ 15 m olunca.
4. **Fotoğraf**: bahçeyi ve kesim izini gösteren tek kare (cihazda 1280 px'e küçülür).
5. Not (isteğe bağlı): "üst teras budanmış", "sahibi Ocak'ta budadım dedi" gibi.

Etiket bahçe koduyla saklanır; kayıt anındaki uydu kararı ve z değeri de yanına yazılır
(`systemClassAtLabel`, `systemZAtLabel`), böylece model yeniden koşsa bile ne zaman ne dendiği bellidir.

Kurallar:
- Aynı bahçe için ikinci kayıt öncekinin yerine geçer (düzeltme).
- "Kısmen" için pay tahmini zorunlu değildir; verilirse 1/7 hesabının doğrulanmasında kullanılır.
- Müstahsil beyanı tek başına etiket değildir; yöntem alanı `producer_statement` olarak işaretlenir
  ve puanlamada saha ziyareti gibi sayılmaz (ileride ayrı ağırlık).

## 3. Puanlama

`GET areas/:id/calibration/metrics` (sitede aynı sekme):

- **Pozitif** = Budandı veya Kısmen; **negatif** = Budanmadı. Emin değilim dışarıda.
- **Yakalama (politika)**: pozitiflerin uyduda *budandı veya olası* çıkma payı.
- **Yanlış alarm**: negatiflerin uyduda *budandı veya olası* çıkma payı.
- Aynı oranların "yalnız kesin" sürümü de verilir.
- **Eşik taraması**: birleşik z ≥ t için (t = 1,0 … 8,0) yakalama / yanlış alarm / F1; F1'i en
  yüksek t "budandı" eşiği önerisidir, yakalamanın ≥ %85 kaldığı en yüksek t de "olası" eşiği.
- En az **15 pozitif + 15 negatif** etiket olmadan öneri üretilmez ("kalibre edilmedi").

## 4. Eşiklerin motora işlenmesi

```bash
# siteden etiketleri indir: Kalibrasyon sekmesi → "Etiketler (CSV)"  (areas/:id/calibration/labels.csv)
npm run calibrate-fusion -- --province Trabzon --district Of --neighborhood Çataldere --season 2025 --labels kalibrasyon-etiketleri.csv
# pruning-fusion/calibration.json yazılır; fuse-pruning bir sonraki koşuda zPruned / zLikely'yi buradan alır
npm run fuse-pruning -- --province Trabzon --district Of --neighborhood Çataldere --season 2025
npm run export-site -- ...   # bundle'da fusion.calibrated = true ve ölçütler
```

`calibrate-fusion` siteyle aynı ölçütleri hesaplar (aynı kurallar, aynı eşik taraması) ve
`--apply` olmadan yalnız raporlar; `--apply` ile `calibration.json` içine `applied: true` yazar.

## 5. Zaman planı (öneri)

- Ekim: plan çıkar, saha ekibine sekme ve bu protokol anlatılır (yarım gün).
- Kasım–Aralık: budama sırasında 2–3 tur (her 2 haftada bir 60–80 bahçe); kesim tazeyken etiket en güvenilir.
- Ocak–Şubat: kalan bahçeler + "belirsiz" grubunun tekrar ziyareti.
- Mart: puanlama, eşik önerisi, `calibrate-fusion --apply`, sezon raporu "kalibre edildi" ile yayımlanır.
