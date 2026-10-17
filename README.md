# Çay Envanter

ÇAYKUR çay havzası (Giresun, Trabzon, Rize, Artvin) için mekansal envanter çalışması:

1. **Parsel kütüphanesi:** TKGM'den ilçe/mahalle bazında tüm ada/parsellerin geometrisi ve niteliği *(bu aşama)*
2. **Çay tespiti (Opsiyon A):** Sentinel-2/1 zaman serisi ile parsel başına çay oranı *(sıradaki)*
3. **Ruhsat eşleştirme:** TKGM × ÇAYKUR ruhsat × uydu tespiti → karar matrisi *(sıradaki)*
4. **Opsiyon C:** Yüksek çözünürlüklü görüntüde derin öğrenme ile bahçe poligonu ve m² *(görüntü temin edilince)*

Kod, `cayhesabim` platformunun konvansiyonlarını izler: TypeScript, İngilizce kod/alan adları,
Türkçe ürün metni, 4 boşluk girinti. TKGM uç noktaları `cayhesabim/apps/api/src/geo/geo.service.ts`
ile aynıdır.

## Kurulum

Node.js ≥ 22.18 (TypeScript derleme adımı olmadan doğrudan çalışır).

```bash
npm install
npm run typecheck
```

## Parsel kütüphanesi oluşturma

```bash
# Tek mahalle (pilot)
npm run harvest -- --province Trabzon --district Of --neighborhood Çataldere

# İlçenin tüm mahalleleri = ilçe kütüphanesi
npm run harvest -- --province Trabzon --district Of

# Deneme için istek sınırı
npm run harvest -- --province Trabzon --district Of --neighborhood Çataldere --max-requests 100
```

İş yarıda kesilirse aynı komut kaldığı yerden devam eder; daha önce yapılmış sorgular tekrarlanmaz.

### Çıktı yapısı

```
data/library/<il>/<ilçe>/<mahalle>/
  meta.json                 mahalle sınırı ve adları
  parcels.ndjson            her satır bir parsel (ham kayıt, eklemeli)
  probes.ndjson             yapılan her TKGM sorgusu ve sonucu (denetim izi + devam)
  parcels.geojson           mahalleye ait parseller (QGIS'te doğrudan açılır)
  neighbor-parcels.geojson  sınırdan taşan komşu mahalle parselleri
  summary.json              parsel sayısı, niteliklere göre dağılım, kapsama oranı
```

Parsel alanları: `block` (ada), `parcel`, `nature` (nitelik), `deedAreaM2` (tapu alanı),
`geometryAreaM2` (poligondan hesaplanan yatay alan), `successorParcels` / `successorReason`
(TKGM `gittigiParselListe` — ifraz/tevhit sonrası yeni parseller; eski→yeni parsel eşleştirmesinin anahtarı).

### Nasıl çalışır

TKGM'nin açık servisinde "mahalledeki tüm parseller" sorgusu yoktur. Toplayıcı iki geçiş yapar:

1. **Ada taraması:** `parsel/{mahalleId}/{ada}/{parsel}` ile ada 101'den başlayarak yukarı/aşağı ve ada 0
   (eski paftalı kayıtlar) sırayla sorgulanır. Ardışık 3 boş parsel numarasında ada, ardışık 8 boş adada
   tarama biter.
2. **Boşluk doldurma:** Mahalle sınırında hâlâ kapsanmamış alanlardan nokta seçilip `parsel/{lat}/{lng}`
   ile sorgulanır. Bulunan yeni bir ada o adanın taranmasını tetikler. 8 m'den dar şeritler
   (yol/dere/koordinat yuvarlama boşlukları) sorgulanmaz.

### TKGM kullanım notu

Varsayılan hız saniyede en fazla 1 istektir (`--min-interval-ms`, alt sınır 500). Bu açık servis pilot
ölçek içindir; 55 ilçenin tamamı için ÇAYKUR–TKGM kurumsal protokolü (MEGSİS WFS) gerekir.
`TkgmClient` bu geçişte değiştirilecek tek bileşendir.

## Budama takibi (Sentinel, kalibre edilmedi)

```bash
# Parsel bazında sezon karşılaştırması + NDVI eğrileri (referans Eki–Kas, kış Ara–Oca, bahar Mar–Nis)
npm run detect-pruning -- --province Trabzon --district Of --neighborhood Çataldere --seasons 2023,2024,2025

# Sezon görüntüleri (her dönemin en temiz tek sahnesi + değişim katmanı), Python
.venv/Scripts/python py/season_imagery.py --dir data/library/trabzon/of/cataldere --seasons 2023,2024,2025

# Müstahsil bazında 5 günlük taramalar (DEMO müstahsil–bahçe kaydı ile)
npm run scan-producers -- --province Trabzon --district Of --neighborhood Çataldere --season 2025 --every 5

# Siteye paket (v3: envanter + budama + müstahsiller) ve görüntüler
npm run export-site -- --province Trabzon --district Of --neighborhood Çataldere
```

Müstahsil kuralı: 1/7, müstahsilin tüm bahçelerindeki toplam ruhsat alanı üzerinden. Uydu yalnızca çok
yüksek güvende (hedefin %120'si, çayın %90'ı gözlenmiş, art arda 2 tarama, ≥1.400 m² çay) alımı otomatik
açar; alımı kapatma kararı her zaman eksperindir.

### Müstahsil bazlı takip (v2)

Sistemin birimi parsel değil **müstahsil**dir. Her müstahsilin bahçeleri (hisseli parselde kendi alt
poligonu) birlikte değerlendirilir; 1/7 hedefi müstahsilin ruhsatlı alanı üzerinden hesaplanır.

```bash
# Sezonlar SIRAYLA çalıştırılır: çakışma hesabı önceki sezonların olay poligonlarını kullanır
npm run scan-producers -- --province Trabzon --district Of --neighborhood Çataldere --season 2023
npm run scan-producers -- --province Trabzon --district Of --neighborhood Çataldere --season 2024
npm run scan-producers -- --province Trabzon --district Of --neighborhood Çataldere --season 2025

# Sezonun bütün bulutsuz sahneleri (müstahsil ekranındaki uydu zaman çizelgesi)
.venv/Scripts/python py/season_imagery.py --dir data/library/trabzon/of/cataldere --seasons 2023,2024,2025 --all-scenes
```

Her tarama (≤ 5 gün) için: son 20 günün bulutsuz sahneleri referansla karşılaştırılır, bahçe bazında
biriken budama güncellenir. Sezon sonunda budama **olay poligonları** çıkarılır; her olayın yeri ve
**gözlem aralığı** (son değişimsiz gözlem → ilk değişimli gözlem, tespit tarihi) saklanır. Aynı 7 sezonluk
döngüde daha önce hesaba alınmış yerle çakışan alan "çakışan" olarak ayrılır; hedefe yalnızca
**yeni alan** sayılır. Sınırı ölçülmemiş hisseli bahçelerdeki budama müstahsile atanmaz
(`boundary_unresolved`). Uydu alımı yalnızca çok yüksek güvende otomatik açar; kapatma kararı eksperindir.

## Radar teyidi (ayrı modül, Sentinel-1 GRD — çayır biçme tespiti yöntemi)

```bash
# Optik taramaya dokunmaz; o sezonun kayıtlarına radar teyidi yazar
npm run detect-pruning-radar -- --province Trabzon --district Of --neighborhood Çataldere --season 2025
```

`pruning-radar/season-<yyyy-yy>.json`: bahçe bazında, yörünge yönüne göre ayrı (çıkış/iniş) VV/VH
serileri; komşuluğun aynı tarihteki medyanı çıkarılarak göreli hale getirilir. Her optik kayıt için
değişim penceresinin 48 gün öncesi ile 60 gün sonrası karşılaştırılır; düşüş bahçenin kendi benek
gürültüsüne (sağlam σ) göre z-skoruna çevrilir, yörüngeler Stouffer ile birleştirilir:
`confirmed` (z ≥ 2,5, ≥ 0,8 dB, kalıcılık ≥ %60) · `weak` · `neutral` · `contradicted` (z ≤ −2,5) · `no_data`.
Optik kaydı olmayan bahçelerde yalnız-radar adayı için çok daha yüksek bar (z ≥ 4, ≥ 5 gözlem).
Çataldere 2025-26: 109 kayıttan 4 teyitli, 14 zayıf, 62 nötr, 7 çelişkili, 22 verisiz; 2 yalnız-radar
aday — 10 m GRD 0,1 ha bahçede çoğu budamayı ayırt edemez; koherans (SLC) hattı 2. fazdır.
Paket: `export-site` dosya varsa isteğe bağlı `radar` bloğunu ekler; site yoksa aynen çalışır.

## Dijital ruhsat kaydı (DEMO, müstahsil bazlı)

```bash
# Müstahsil → ruhsat → çaylık alt-poligonu → parsel kaydı; eğim Copernicus DEM'den okunur
npm run build-licensing -- --province Trabzon --district Of --neighborhood Çataldere

# Siteye paket (v5: envanter + budama + müstahsiller + ruhsat kaydı)
npm run export-site -- --province Trabzon --district Of --neighborhood Çataldere
```

`data/library/<il>/<ilçe>/<mahalle>/licensing/registry.json` ÇAYKUR verisi gelene kadar yerine geçen,
BİLFERA tasarımındaki bütün kayıt sorunlarını kasıtlı olarak içeren deterministik bir demo kayıttır:

- **Ruhsat eşleşme düzeyi** — `exact` (ada/parsel birebir), `historical` (eski pafta/parsel → eski–yeni
  parsel tablosu `lineage` ile: 22-a yenileme, ifraz, tevhit), `probable` (yalnızca mevki/zilyetlik tarifi;
  aday parseller), `unmatched` (güncel kadastroda bulunamadı). Yalnızca `exact`/`historical` ruhsatlara
  alan tahsis edilir; diğerleri `lineage_unresolved` uyuşmazlığıyla bekler.
- **Çaylık alt-poligonu** — hissedarın parsel dilimi ∩ uydu çay örtüsü (4 m yumuşatılmış, dilime kırpılmış);
  çay yoksa dilimin kendisi (büyük parselde merkez çevresinde 60 m). Her bahçede üç alan tutulur:
  `licensedAreaM2` (ruhsattan pro-rata tahsis), `planimetricAreaM2` (izdüşüm), `surfaceAreaM2`
  (izdüşüm × ortalama 1/cos(eğim), DEM 30 m — teknik tahmin, hukuki alan değil); ayrıca `measuredTeaAreaM2`.
- **Sınır durumu** — `approved`, `proposed` (hisseli parselde öneri), `boundary_conflict` (öneri komşu
  hissedarla ≥ 25 m² çakışıyor; `conflicts[]` çakışma poligonunu taşır), `field_check_required`, `unresolved`.
  Geometri **sürümleri** (`versions[]`, eski çizim → RTK düzeltmesi) saklanır.
- **Uyuşmazlıklar** — `area_over`/`area_under` (±%15), `no_tea` (hayalet ruhsat), `no_license`,
  `lineage_unresolved`, `overlap`.
- **Başvurular** — `new_license`, `area_correction`, `transfer` (vefat/intikal), `boundary_determination`,
  `parcel_update`; durumlar `DRAFT → DOCUMENTS_PENDING / MATCHING_REQUIRED / GEOMETRY_PROPOSED →
  BOUNDARY_CONFLICT / UNDER_REVIEW / FIELD_CHECK_REQUIRED → DEMO_APPROVED / RETURNED_FOR_CORRECTION /
  REJECTED / SUPERSEDED`, belge listesi ve tarihçe ile.
- **Ruhsatsız çay** — paket, uydu çay yamalarından ruhsat tahsisli alt-poligonları çıkararak (mekânsal fark)
  `licensing.unlicensedTea` katmanını üretir.

Kayıt varsa `scan-producers` ve `export-site` müstahsilin ruhsat alanını bu kayıttan alır (ruhsatsız
müstahsil → `no_license`, alım kapalı); sezon sonuçları uyduya dokunmadan `src/producers/evaluate.ts`
ile yeniden hesaplanır.
