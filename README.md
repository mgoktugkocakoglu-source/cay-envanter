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

## Bölge genişletme (mahalle → ilçe → Karadeniz)

Pilot Çataldere'den başlayarak bölge **mahalle mahalle** büyür; her mahalle kendi kütüphane klasörü ve kendi site
paketiyle (`data/site/<il>-<ilçe>-<mahalle>.json`) gelir, site bütün paketleri yükler ve "Bölge" sekmesinde ilçe
bazında toplar.

```bash
# Sıradaki mahalleleri seçmek: TKGM listesi, alan, komşuluk, kütüphane/site durumu
npm run neighborhoods -- --province Trabzon --district Of --near Çataldere

# Bir ya da daha çok mahalle için zincirin tamamı (her gün aynı komut; güncel adımlar atlanır)
npm run pipeline -- --province Trabzon --district Of --neighborhoods "Tekoba,Gürpınar,Bölümlü,Uğurlu" --health-year 2026
#   harvest → detect-tea → detect-pruning → imagery → scan-producers (sezonlar) → build-licensing
#   → detect-pruning-radar → fuse-pruning → scan-health → export-site
#   --skip harvest,radar   --only detect-tea,export-site   --force   --harvest-requests 80
```

Kurallar ve davranış:

- **TKGM kotası paylaşılır.** Günde ~230 parsel sorgusu vardır; birden çok mahalle için `--harvest-requests` ile bütçe
  bölünür, kota dolunca zincir eldeki parsellerle devam eder, ertesi gün aynı komut kaldığı yerden toplar.
- **Sınıflandırıcı ilçe havuzundan eğitilir.** `detect-tea` ilçe kütüphanesindeki bütün mahallelerin tapu nitelikli
  parsellerini eğitim havuzu yapar (`model.trainingNeighborhoods`); parseli henüz az olan yeni mahalle de ilk günden
  taranır. `--own-training` yalnız hedef mahalleyle eğitir (pilot davranışı).
- **Parselsiz çaylık = serbest yama.** Çay tespiti ve budama kararı mahalle sınırının tamamında çalışır; parseli
  çekilmemiş çaylıklar serbest birim olarak yargılanır, parsel gelince sahibine bağlanır.
- **Eski beldeler.** Belediyesi kapatılmış yerlerde kadastro mahalleleri alt isimlerle sürer ("Gürpınar/Fatih",
  "Gürpınar/Yenimahalle"); toplayıcı bunları tek idari sınır altında birleştirir, her kadastro mahalleId'si için ayrı
  ada taraması yapar ve kaldığı yerden devam ederken eski kayıtların üyeliğini yeniden değerlendirir.
- **Koherans kanalı isteğe bağlıdır.** SLC indirme ve SNAP işlemesi mahalle başına saatler sürer; yeni mahalleler önce
  optik + GRD ile değerlendirilir, koherans sonradan eklenebilir.
- **Site paketi mahalle başınadır.** `node scripts/sync-site.mjs [--site ../cayhesabim]` bütün paketleri
  `cayhesabim/apps/api/src/tea-inventory/seed-data/` altına, görüntüleri `apps/web/public/inventory-imagery/<kod>/`
  altına kopyalar; API yeniden başlayınca yalnız `generatedAt`'i değişen paketleri içe aktarır, sitedeki sicil
  işlemleri korunur.

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

### Koherans kanalı (Sentinel-1 SLC burst çiftleri, SNAP)

```bash
# 1) Mahalleyi kapsayan burst'leri bul (ASF); Earthdata girişi secrets/earthdata.txt
.venv/Scripts/python py/s1_bursts.py --dir data/library/trabzon/of/cataldere --season 2025
# 2) Burst'leri indir (ASF boyutuyla doğrulanır) ve tarih tarih SAFE'e çevir (burst2safe; SNAP ham burst TIFF'i okumaz)
.venv/Scripts/python py/s1_bursts.py --dir ... --season 2025 --download --orbits 43 --min-cover 0.2 --dest data/s1/cataldere/safe/43
burst2safe <granule...> --output-dir data/s1/cataldere/safe/43        # her tarih için (burst2stack S1C yörüngelerinde hata veriyor)
# 3) Ardışık 6/12 günlük çiftlerin koheransı (SNAP gpt, çift başına ~1–1,6 dk) ve bahçe serileri
.venv/Scripts/python py/coherence/run.py --dir data/library/trabzon/of/cataldere --season 2025 --orbits 43,123
# 4) detect-pruning-radar koherans dosyasını otomatik alır
```

Gereksinim: ESA SNAP (`C:\Program Files\esa-snap`, gpt 11 GB heap), Earthdata hesabı + ASF uygulama onayı,
sezon başına ~15 GB (`data/s1/`, git dışı). Koherans kanalı geri saçılımla **birleştirilmez**, kendi
başına sınıflanır (bilgi taşımayan kanal bilgi taşıyanı sulandırmasın diye); ikisinden biri teyit edebilir.
Çataldere 2025-26 bulgusu: 4×2 pencerede (~9×28 m) 0,1 ha bahçelerde koherans artışı yok (z −0,5…0,6, 87 kayıt
nötr); 6 günlük kış çiftlerinde hava kaynaklı dekorelasyon baskın. Denenecekler: 10×3 pencere, yalnız 12
günlük çiftler, saha etiketleriyle kalibrasyon.

## Çok-sensör budama kararı (füzyon modülü)

```bash
# Bahçe + optik değişim yaması birimleri; S2 NDVI/NBR + S1 VH (2 yörünge) + koherans; 2 günde bir tarama taklidi
npm run fuse-pruning -- --province Trabzon --district Of --neighborhood Çataldere --season 2025 --every 2 [--refetch]
node scripts/fusion-synthetic.ts     # sentetik doğrulama: derin / hafif / geçici / yalnız optik / değişimsiz / bulutlu
```

`pruning-fusion/season-<yyyy-yy>.json` — "denklem" (`src/fusion/model.ts`):
1. Her kanal komşuluğa göreli (tarih medyanı çıkarılır): hava, mevsim, kar herkesi birlikte oynatır.
2. Aday değişim tarihi t₀ (Eki 15–Oca 31, Şub 15–Nis 10) için kanal basamağı δ = işaret·(sonra − önce),
   z = δ / (σ·√(1/n_önce + 1/n_sonra)); σ bahçenin kendi sağlam gürültüsü (ardışık farkların MAD'ı).
3. Büyüklük kapısı (derin budama): NDVI/NBR ≥ 0,12, VH ≥ 1 dB, koherans ≥ 0,06.
4. Kalıcılık: t₀+25 gün sonrası ve son iki gözlem erken basamağın ≥ %50'sini korumalı; z bununla çarpılır
   (gölge/kar/don geri döner, budama dönmez). Erken gözlem basamağı göstermiyorsa t₀ erken → kalıcılık 0.
5. Optik kanallar ortalanır (korelasyonlu), yörüngeler ve sensörler Stouffer ile birleşir (ağırlık optik 1,
   radar 0,9, koherans 0,2). En iyi t₀ seçilir; ~50 aday tarih gürültüyü |z|≈2,3'e şişirdiği için eşikler
   olası 2,8 / kesin 3,5.
6. **Budandı** = optik VE radar aynı t₀'da büyüklük + kalıcılık şartlarını sağlıyor, birleşik z ≥ 3,5;
   **olası** = tek birincil sensör; **belirsiz** = zayıf ya da geri dönen; **budama yok** = ≥ 12 gözlemle hiçbir sinyal.
7. Tarama taklidi: her 2 günde bir yalnız o güne kadarki gözlemlerle karar; ilk "olası" ve ilk "kesin" tarihleri.
   Müstahsil: kesin budanan birim alanı (yama ise yama) ruhsat alanının 1/7'siyle karşılaştırılır.

Çataldere 2025-26 (kalibre edilmedi): 344 bahçede 4 kesin, 69 olası (43 yalnız optik, 26 yalnız radar),
173 belirsiz, 98 budama yok; müstahsil: 3 tam, 42 kısmen, 47 belirsiz, 8 görülmedi, 36 ruhsatsız.
Sonraki kaldıraçlar: saha etiketleriyle eşik kalibrasyonu, 50 cm optik, S1'de 3×3 çoklu bakış.

**Parselsiz çaylıklar:** TKGM hasadı günlük kotayla büyüdüğü için (Çataldere %56) parsel dışında kalan
çay yamaları (≥ 300 m²) `unassigned` birimler olarak aynı modelle yargılanır; parsel/ruhsat gelince
sahibine bağlanır. Hasat büyüdükçe zincir (detect-tea → scan-producers → build-licensing → fuse-pruning)
yeniden koşturulmalıdır; demo müstahsil kaydı deterministik olduğundan kimlikler değişebilir.

**Alım kararı politikası** (`DECISION_POLICY`): kanıt temizse uydu kendi karar verir — `auto_open`
(teyitli, ya da z ≥ 4 ve kalıcı tek-sensör budama 1/7'yi karşılıyor), `auto_pending` (iz var, hedef dolmadı),
`auto_none` (iyi gözlendi, budama yok; alım yine de uydu tarafından kapatılmaz). Eksper yalnız **engelleyici
anomalileri** görür: sensörler çelişiyor, 7 yıllık döngü içinde tekrar budama (çakışma ≥ %50), sınır ihtilafı,
ruhsatsız/eşleşmemiş alanda budama, aşırı budama (hedefin 3 katı). Ruhsat–alan uyuşmazlığı ve belirsiz hisse
sınırı yalnızca not olarak düşer.

### Saha kalibrasyonu (etiket → eşik)

```bash
# Sitedeki "Kalibrasyon (saha)" sekmesinden etiketleri CSV olarak indirin (areas/:id/calibration/labels.csv)
npm run calibrate-fusion -- --province Trabzon --district Of --neighborhood Çataldere --season 2025 --labels etiketler.csv [--apply]
```

Saha ekibi bahçe başına *budandı / kısmen / budanmadı* etiketini konumlu fotoğrafla girer (protokol:
`docs/calibration-protocol.md`). `calibrate-fusion` etiketleri `pruning-fusion/season-<s>.json` kararlarıyla
karşılaştırır: karışıklık matrisi, yakalama, yanlış alarm, z eşiği taraması ve F1'i en yüksek eşik önerisi
(en az 15 pozitif + 15 negatif). `--apply` ile `pruning-fusion/calibration.json` "uygulanacak" yazılır; bir
sonraki `fuse-pruning` koşusu `zPruned` / `zLikely` değerlerini oradan alır, çıktıya `calibration` bloğunu ekler
ve `export-site` bundle'ı `fusion.calibrated = true` ile üretir (sitedeki "kalibre edilmedi" etiketi düşer).

## Bahçe sağlığı ve verim (P3, ayrı modül)

```bash
# Büyüme sezonu (15 Nis – 31 Eki) NDVI/NDRE/NBR + S1 VH; önbellek health/series-<yyyy>.json
npm run scan-health -- --province Trabzon --district Of --neighborhood Çataldere --year 2026 [--refetch]
```

`health/season-<yyyy>.json` (`src/health/model.ts`), budama modülüne dokunmadan:
- **Canlılık**: bahçenin Haz–Eyl ortalama NDVI'si / mahalle ortancası (0,6–1,3 arasına kırpılır).
- **Anomali** (komşuluğa göreli seriler, aday tarih 1 May–10 Eki, basamak z-skoru): *kimyasal şüphesi* =
  NDVI/NDRE ≥ 0,10 düşer, z ≥ 3,5, radar VH basamağı < 0,8 dB (yapı korunmuş: herbisit yanığı / kimyasal hasar,
  yaprak numunesi işareti); *yaprak kaybı* = optik + radar ≥ 0,8 dB (zararlı, dolu, izinsiz kesim); *stres* =
  hafif kayıp (z ≥ 2,5). 45–95 gün sonraki toparlanma payı da yazılır.
- **Rekolte tahmini**: çay alanı (da) × 1000 kg/da (demo norm) × canlılık × önceki kışın budama payı
  (budanan kısım 0,35) × anomali faktörü; müstahsilde kota = ruhsat alanı × 1000 kg/da; bayrak `low` (< %50),
  `high` (> %140), `no_license`.
- Sitede "Bahçe Sağlığı" sekmesi: anomaliler, rekolte/kota, harita, **gübreleme geri beslemesi** (kayıt
  girilen tarihten 10–35 gün sonra komşulara göre NDRE/NDVI tepkisi).

Çataldere 2026 (kalibre edilmedi): 344 bahçede 7 kimyasal şüphesi, 7 yaprak kaybı, 77 stres; 25 müstahsilde
tahmin kotanın altında, toplam tahmin ~155 t. Aynı tarihte kümelenen anomaliler (ör. 5–10 Tem) görüntü
artefaktı olabilir; saha teyidi gerekir.

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

**Site üzerinde sicil işlemleri (2026-10):** demo kayıt siteye yüklendikten sonra sicil sitenin veritabanında
yaşar. Ruhsatlandırma sekmesinden açılan dosyalar — *bahçe alt bölünmesi* (haritada çizgiyle/poligonla parçalara
ayırma, parça başına sahip ve ruhsat payı), *ruhsat ayırımı* (bahçeler üzerinden mirasçılara/alıcıya yeni ruhsat
numaraları), *devir/intikal*, *alan düzeltme*, *sınır tespiti* (RTK/harita, sürümlenir, komşu çakışması ihtilaf açar) —
onaylandığında ruhsat, bahçe ve müstahsil kayıtlarını değiştirir; eski bahçe "bölündü" olarak kalır, yeni kayıtlar
`source = 'site'` ile işaretlenir ve motor paketi yeniden yüklense bile korunur (`tea-inventory-seed.service.ts`,
snapshot → restore). Motor, siteden ayrılan yeni bahçeleri bir sonraki zincir koşusunda henüz değerlendirmez; bu
köprü (site sicili → `licensing/registry.json`) sıradaki adımdır.

Kayıt varsa `scan-producers` ve `export-site` müstahsilin ruhsat alanını bu kayıttan alır (ruhsatsız
müstahsil → `no_license`, alım kapalı); sezon sonuçları uyduya dokunmadan `src/producers/evaluate.ts`
ile yeniden hesaplanır.
