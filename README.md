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
