# Budama tespiti: dünya pratiği, açık kaynaklar ve bizim eksiklerimiz (Kasım 2026)

Amaç: ÇAYKUR'a sunulacak pilotta budama tespitini "çok düşük hata oranı" ile çalıştırmak. Satın alma yok,
kendi geliştirmemiz esas. Bu not üç şeyi bir araya getirir: (1) Gemini/ChatGPT araştırmalarının özeti ve
doğrulanan noktaları, (2) kendi literatür/GitHub taramamız, (3) mevcut modülün (detect-pruning →
scan-producers → detect-pruning-radar → koherans → fuse-pruning → calibrate-fusion) açık eksikleri ve
yapılacaklar.

## 1. Önce gerçekçi beklenti: literatür ne diyor

- **MODCiX (Schwieder vd., RSE 2026)**: Avrupa'da 10 biçme algoritması, 8 ülke, 5 yıl, >5.000 referans biçme
  tarihi. Genel F1 **0,55–0,74**. Optik + SAR birleşimi *tutarlı* bir iyileşme vermedi; kural tabanlı yöntemler
  makine öğrenmesinin hemen arkasında. Sezonda **≥ 16 bulutsuz gözlem** olduğunda veri yoğunluğunun etkisi
  azalıyor. → En olgun problemde bile F1 ~0,7; "hata %1" vaat edilemez, ama budama biçmeden daha kolay bir
  olaydır (aşağıda).
- **Sen4CAP L4B (De Vroey vd. 2022; Belçika ~2.000 olay)**: S2 NDVI'da ardışık gözlemler arası keskin düşüş +
  S1 6-günlük koherans artışı; en iyi birleşim NDVI + VH koheransı. Ödeme kurumlarında operasyonel.
- **Komisarenko vd. 2022 (Estonya, KappaZeta)**: S2 indeksleri + S1 6-günlük koherans zaman serisi, derin öğrenme,
  **"reddetme bölgesi"** (model emin değilse karar vermez) — 2017'den beri Estonya ödeme kurumunda operasyonel.
  Bizim "belirsiz" sınıfımızın literatürdeki karşılığı; doğru yaklaşım.
- **Lobert vd. 2021 (RSE)**: girdi özelliklerinin sistematik karşılaştırması; koherans ve NDVI en bilgilendirici,
  geri saçılım tek başına zayıf. → Bizim Çataldere bulgumuzla (GRD VH çoğu kayıtta nötr) uyumlu.
- **Çay özelinde**: Sentinel ile çay *budaması* tespit eden yayın yok. Çay haritalama literatürü (Çin, Assam, Sri
  Lanka) budamayı fenolojik işaret olarak kullanıyor: derin budama sonrası NDVI düşüşü ve toparlanma (Agronomy
  2024; Zhejiang; Shihe). Assam'da BFAST ile NDVI kırılma tespiti (SPIE 2025). Türkiye'de çay budaması uydu
  çalışması bulunamadı → yaptığımız iş yeni; doğrulama verisini kendimiz üreteceğiz.

**Budama neden biçmeden kolay**: ÇAYKUR gençleştirme budaması kök boğazından **20 cm**'den kesim (ÇAYKUR 2022
Budama Genelgesi, 971 sayılı); yaprak örtüsü aylarca gelmez. NDVI 0,8 → 0,3–0,4'e düşer ve bahar sürgününe kadar
orada kalır. Biçilen çayır 3–4 haftada toparlanırken budanan çay 4–6 ay çıplaktır: **kalıcılık** bizim en güçlü
ayırt edici işaretimizdir ve modelde zaten var.

**Budama neden yine de zor**: (a) Ekim–Nisan Doğu Karadeniz bulutu; (b) bahçe ≈ 0,1 ha = ~10 S2 pikseli, kenar
karışımı; (c) yılda bahçenin **1/7 ya da 1/10**'u budanır → olay parsel altı yamadır; (d) kar ve don yaprağı
kızartır, NDVI düşer ama geri döner; (e) 300–600 m yükseltide gölge ve kar. Bu beş sorun için aşağıdaki
yöntemler.

## 2. Mevzuat ve kural (ÇAYKUR)

RTEÜ Fen ve Mühendislik Bilimleri Dergisi'ndeki makale (Özcan & Yıldız 2025, doi 10.53501/rteufemud.1522280):
- 93/5096 sayılı Bakanlar Kurulu Kararı (RG 27.12.1993): ruhsatlı bahçeler **1/5** oranında budanır, budanan
  alandan elde edilecek ürün bedelinin **%70'i tazminat** olarak ödenir. 1994–2003 1/5, sonraki dönem **1/7**
  (7 yıl), **2012 kararnamesiyle 1/10**. Basında 2022 için "yedide bir" ifadesi de var → **güncel oran ÇAYKUR'dan
  teyit edilmeli; modülde oran parametre olmalı** (bugün sabit 1/7).
- Gençleştirme budaması kök boğazından 20 cm (ÇAYKUR 2022 Genelgesi; 2024 açıklaması "20 cm'nin altında").
- 2026 budama bedeli: 177.731 üretici, 70.612 dekar budanmış alan, 2,595 milyar TL (ÇAYKUR açıklaması, basın).
  → Yılda ~70 bin dekar budama **sahada denetlenip ödeniyor**: bu kayıtlar hazır etiket setidir (bkz. §5).

## 3. Mevcut modülün durumu ve eksikleri

| Katman | Bugün | Eksik / risk |
|---|---|---|
| Optik seri | Yalnız S2 L2A, Cloud Score+ ≥ 0,6, NDVI + NBR, 10 m, parsel/yama ortalaması | Kış serisi seyrek; Landsat 8/9 yok; 20 m kırmızı-kenar (NDRE) yok; kar/gölge yalnız NDSI ile |
| Değişim modeli | Aday t₀ için önce/sonra ortalama farkı, bahçenin kendi gürültüsüne göre z, kalıcılık, büyüklük kapısı, komşuluğa göreli | Çok yıllı baz çizgisi yok (bahçenin önceki kışları); ardışık izleme (CUSUM/EWMA) yok; olasılık kalibre değil |
| Karar | "Budandı" = optik VE radar aynı t₀'da | Radar 0,1 ha bahçede çoğu kez nötr → yakalama düşüyor; literatür optik + koheransı destekliyor, GRD geri saçılımı değil |
| Radar GRD | GEE S1_GRD VH, komşuluğa göreli, yörünge ayrı | Arazi düzleştirme (gamma0) ve çok zamanlı benek filtresi yok (Karadeniz dik yamaç!) |
| Koherans | SNAP, yerel, sezon başına 15 GB, 4×2 bakış (~9×28 m), 6-günlük kış çiftleri | Hava kaynaklı dekorelasyon; işlem ağır; 12-günlük çift ve 10×3 bakış denenmedi; S1C/S1D ile 6-günlük tekrar geri geldi |
| Birim | Bahçe + optik değişim yaması + parselsiz yama | Yama sınırları 10 m; alt-parsel budama payı kaba |
| Doğrulama | Protokol ve site sekmesi var, etiket yok | **Kalibre edilmedi** — en büyük eksik |
| Kural | 1/7 sabit | 1/10 olabilir; üretici/alan bazlı oran parametresi yok |

Çataldere 2025-26 sonucu (344 bahçe): 4 kesin, 69 olası, 173 belirsiz, 98 budama yok. "Belirsiz" payı %50:
bu oran düşmeden ÇAYKUR'a hata oranı söylenemez.

## 4. Dünyada ne var, bizde ne olur (yöntem önerileri)

### 4.1 Gözlem yoğunluğu (en büyük kaldıraç)
- **Landsat 8/9 eklemek** (30 m, birlikte 8 gün): S2 + L8/9 "harmonize" seri (HLS mantığı); parsel ortalaması
  30 m'de bile 0,1 ha bahçeye bilgi taşır. MODCiX: ≥ 16 gözlem eşiği.
- **S2 20 m bantları**: NDRE (B8A/B5) ve SWIR (B11/B12) — budanmış çıplak dal/toprak SWIR'de parlar; klaveflo
  tezinde en iyi özellikler NDII ve SWIR farkları.
- **Bulut maskesi**: Cloud Score+ kalsın; şüpheli kış sahnelerinde ikinci görüş olarak **OmniCloudMask**
  (açık kaynak, CloudSEN12'de en iyi F1); kar için NDSI + CS+ birlikte.
- **Gözlenebilirlik raporu**: her bahçe için sezonda kaç temiz gözlem var; < 8 ise "gözlenemedi" (budama yok
  değil). Bu, ÇAYKUR'a dürüst kapsam raporu verir.

### 4.2 Değişim modeli
- **Çok yıllı baz çizgisi**: bahçenin önceki 2–3 kışının NDVI/NBR klimatolojisi; sapma bu bazdan ölçülür
  (komşuluk medyanı ile birlikte).
- **Ardışık izleme**: JRC **nrt** kütüphanesi (EWMA, CUSUM, MOSUM, CCDC; Sentinel-2 için tasarlandı, pip) ya da
  **pyxccd** (S-CCD). Bizim "tarama taklidi"nin yerine gerçek ardışık test; olay tarihi ve güven birlikte çıkar.
- **Tarih kestirimi**: olay aralığı = son değişimsiz gözlem → ilk değişimli gözlem (var); Bayes çevrimiçi
  değişim noktası ile en olası gün (opsiyonel).
- **Reddetme bölgesi**: iki eşikli karar (kesin / incelensin / yok); "incelensin" oranı eksper kapasitesine göre
  ayarlanır (Komisarenko yaklaşımı).

### 4.3 Radar
- **S1 ARD (Mullissa vd. 2021, gee_s1_ard)**: GEE'de kenar gürültüsü düzeltme, çok zamanlı Gamma MAP benek
  filtresi, **radyometrik arazi düzleştirme (gamma0)**. Dik yamaçlarda geri saçılım değişiminin yarısı geometri
  kaynaklı; düzleştirme şart.
- **Koherans için ASF HyP3 Burst InSAR** (ücretsiz: ayda 8.000 kredi; 20 m piksel aralığı 5×1 bakış, 1 çift = 1
  kredi; `_corr.tif` 0–1 koherans dahil; ISCE2; aynı burst + aynı yörünge; indirme 14 gün). SNAP yerel işlem
  yerine bulutta, otomatik, `hyp3_sdk` + `asf_search` ile. Mahalle başına kış sezonu (Ekim–Nisan, 2 yörünge,
  6-günlük) ≈ 70 çift ≈ 70 kredi: tüm Of için bile aylık kota yeter. S1C + S1D ile 6-günlük tekrar yeniden
  tam (1D Mayıs 2026'da operasyonel, 1A Haziran 2026'da emekli).
- **12-günlük çiftler**: hava dekorelasyonu 6-günlükte baskın; 12-günlük çift kalıcı yapısal değişimi (kesilmiş
  çıplak dallar + toprak) daha net gösterir; ikisi birlikte kullanılır.
- **SNAP hattı** ince pencere (4×2) denemeleri için kalır; `eo_tools` (saf Python, burst bazlı, SNAP'siz) alternatif.
- Rolü: koherans ve geri saçılım **destek** kanalı; "budandı" kararı için optik yeterliyse radar zorunlu
  olmasın, optik boşluğu > 20 gün ise radar belirleyici olsun.

### 4.4 Alt-parsel ve çözünürlük
- **Yama birimi** kalsın; yama sınırı için SEN2SR (ESA OpenSR, 2,5 m süper çözünürlük, açık kaynak) yalnız
  **görselleştirme ve sınır keskinleştirme** için; karar 10 m'de kalır (SR değişim tespitinde halüsinasyon riski).
- Budama payı: yama alanı / bahçe alanı; 1/7–1/10 hedefi üretici toplamında (var).

### 4.5 Öğrenme (etiket geldikten sonra)
- **Presto** (NASA Harvest, açık kaynak): S1 + S2 + iklim piksel zaman serisi üzerinde ön-eğitimli hafif
  transformer; az etiketle ince ayar. Sezon sonu "bu bahçe bu kış budandı mı?" sınıflandırıcısı için uygun.
- **TempCNN / gradient boosting** önce kural tabanlı modelin özellikleri (z, kalıcılık, büyüklük, gözlem sayısı,
  koherans artışı) üzerinde; MODCiX kural tabanlının yakın olduğunu gösteriyor — ML ikinci aşama.
- Değerlendirme: bahçe ve yıl bazlı ayrım (sızıntı yok), precision / recall / F1, tarih hatası (gün), reddetme oranı.

### 4.6 Ürün tanımı (iki ayrı çıktı)
1. **Sezon sonu hak ediş kararı** (Nisan): üretici bazında budanan alan payı; hedef yüksek doğruluk; eksper
   yalnız "incelensin" kuyruğunu görür. ÇAYKUR'un asıl ihtiyacı budur.
2. **Sezon içi erken uyarı** (Kasım–Mart): olası budama ve tarihi; düşük güven etiketiyle.

## 5. En kritik kaldıraç: ÇAYKUR'un kendi budama kayıtları

ÇAYKUR her yıl ~70 bin dekar budamayı sahada tespit edip tazminat ödüyor. Geçmiş 2–3 sezonun **onaylanmış budama
listesi** (üretici/ruhsat, parsel, budama tarihi ya da tespit tarihi, alan) alınırsa:
- binlerce pozitif etiket + budanmamış ruhsatlı bahçeler negatif etiket → eşik kalibrasyonu ve ML eğitimi
  hemen;
- pilotta "yakalama %X, yanlış alarm %Y" sayısı sunum öncesi hazır olur;
- sahada 240 bahçelik kampanya yalnız doğrulama için kalır.
Talep edilecek alanlar: ruhsat no, parsel/mevki, budama yılı, tespit tarihi, budanan dekar, ödeme durumu.
KVKK: kişi verisi yerine ruhsat/parsel anahtarı yeterli.

## 6. Açık kaynak araç listesi (satın alma yok)

| Araç | Ne için | Not |
|---|---|---|
| ec-jrc/**nrt** (Python, JOSS 2024) | EWMA / CUSUM / MOSUM / CCDC ardışık değişim tespiti, S2 odaklı | xarray; pip |
| **pyxccd** | S-CCD sürekli değişim tespiti | çoklu sensör |
| nasaharvest/**presto** | S1+S2+iklim piksel serisi ön-eğitimli transformer | az etiketle ince ayar |
| adugnag/**gee_s1_ard** | S1 ARD: kenar gürültüsü, çok zamanlı benek filtresi, gamma0 arazi düzleştirme | GEE JS/Python |
| ASF **hyp3_sdk** + **asf_search** | Burst InSAR koherans (ücretsiz kredi) | 20 m, `_corr.tif` |
| ESA-PhiLab/**OpenSarToolkit**, **pyroSAR**, odhondt/**eo_tools** | S1 SLC/koherans yerel işleme | SNAP'li / SNAP'siz |
| ESAOpenSR/**sen2sr** | S2 2,5 m süper çözünürlük | yalnız görsel/sınır |
| **OmniCloudMask** | S2/Landsat bulut-gölge maskesi | ikinci görüş |
| Sen2Agri/**Sen2Agri-System** (Sen4CAP) | L4B biçme algoritması referansı | lisansı kontrol et |
| ec-jrc **cbm** (marker detection) | NDVI + koherans işaretleyici Python modülleri | AB AMS pratiği |
| klaveflo/**satellite-mowing-detection**, andreattad/**S2_mowing_detection** | biçme tespiti örnek kodları (RF/SVM; GEE) | tez ve GEE |
| geo-masc/**modcix** (CC0) | değerlendirme kodu ve ölçütler | referans veri talep üzerine |

## 7. Uygulama planı (öncelik sırasıyla)

| # | İş | Etki | Süre |
|---|---|---|---|
| 1 | ÇAYKUR geçmiş budama kayıtlarını talep et; etiket içe aktarma (ruhsat/parsel anahtarı) | kalibrasyon mümkün olur | talep: hemen; kod: 1–2 gün |
| 2 | Optik seriye Landsat 8/9 + S2 20 m (NDRE, SWIR/NDII) ekle; gözlenebilirlik raporu | gözlem sayısı ↑, kaçırma ↓ | 2–3 gün |
| 3 | Çok yıllı baz çizgisi + ardışık izleme (nrt/CUSUM) + iki eşikli karar (kesin / incelensin / yok); radar zorunluluğunu "optik boşluğu > 20 gün" kuralına çevir | belirsiz payı ↓ | 3–4 gün |
| 4 | S1 ARD (gamma0 + çok zamanlı filtre) GEE'de; VH, VV/VH | radar sinyali ↑ | 1–2 gün |
| 5 | HyP3 Burst InSAR koherans hattı (6 ve 12 günlük, 2 yörünge), SNAP hattının yerine operasyonel | koherans tüm mahallelerde | 2–3 gün |
| 6 | Kalibrasyon: etiketlerle eşik/olasılık (Platt), bahçe-yıl ayrımı, F1 ve tarih hatası raporu; site "kalibre edildi" | ÇAYKUR'a sayı | etiket gelince 2 gün |
| 7 | Presto/TempCNN ikinci aşama sınıflandırıcı (sezon sonu hak ediş) | doğruluk ↑ | 1 hafta |
| 8 | Budama oranı parametresi (1/7 ↔ 1/10), tazminat hesabına girdi | mevzuat uyumu | yarım gün |
| 9 | Pilot raporu: kapsam (gözlenebilen bahçe payı), karışıklık matrisi, örnek kanıt paketleri | sunum | 1 gün |

Satın alma kararı (Planet 3 m, Pléiades 30 cm, ticari AMS) askıda: yukarıdaki açık yöntemler tüketilmeden
gerek yok; VHR yalnız "incelensin" kuyruğundaki az sayıda bahçe için anlamlı olur.

## 8. Uygulama durumu — füzyon v2.1 (10 Kasım 2026)

Bölüm 7'deki planın ilk üç adımı koda indi (`src/fusion/model.ts`, `src/cli/fuse-pruning.ts`, `py/hyp3_coherence.py`):

- **Gözlem yoğunluğu:** Sentinel-2 + Landsat 8/9 (≥ 1 200 m² birimlerde) tek seride; Çataldere 2025-26 için
  1 Eyl → 12 Tem arası 145 optik tarih (75 S2, 35 L8, 35 L9). Seri Temmuz ortasına kadar çekilir: yaz başı gözlemi
  kış adımının derin budama mı hafif budama mı olduğunu söyler.
- **Tarih eleme:** mahalle ortanca NDVI'si < 0,65 olan günler (Ocak 2026 kar günleri: ortanca 0,46 ve 0,38) ve
  sensörünün görebildiği bahçelerin < %25'ini kapsayan günler herkes için dışlanır; çıktıda listelenir.
- **Fiziksel korumalar:** ham NDVI düşüşü ≥ 0,08 (göreli düşüş tek başına yetmez), basamak/eğim ayrımı (sezon boyu
  kademeli kayıp → terk/sökme şüphesi, budama değil), yaz toparlanma testi (20 May – 15 Tem göreli NDVI ≥ 0,06 aşağıda,
  z ≥ 2; toparlanan kış adımı derin budama sayılmaz, yaz teyidi varsa kar ve bulut boşluğu kuralları aranmaz),
  ÇAYKUR takvimi bayrağı.
- **Toplum kalibrasyonu:** bahçe birimi optik z'lerinin sağlam ortanca/IQR dağılımı ampirik sıfır hipotezi olarak
  kullanılır (en fazla 1/7 budandığı için kütle budanmamıştır); "budandı" ≥ 1,5, "olası" ≥ 0,5 sağlam σ ayrışmalı,
  kütlenin içindeki zayıf sinyaller "budama yok" olur. Saha etiketi gelene kadar eşiklerin tek nesnel dayanağı budur.
- **Radar:** S1 σ0 → γ0 arazi düzleştirme (hacim modeli), VH ve VH/VV; koherans ASF HyP3 burst InSAR'dan
  (ücretsiz, 5×1 bakış 20 m, 1 çift = 1 kredi; Çataldere 2025-26 için 102 çift ≈ 102 kredi).
- **Earth Engine dayanıklılığı:** uzun sezon serisi "memory capacity exceeded" verdiğinde parça ikiye bölünür,
  tek tarihte tileScale artırılır; optik ve her yörünge çekildikçe önbelleğe yazılır (yarım kalan koşu kaybolmaz).
- **Sentetik doğrulama:** 15 senaryo (derin/hafif/geçici/kar/yalnız optik/bulut boşluğu/çelişki/kademeli/ham NDVI
  sabit/yaz toparlanma/Nisan budaması) beklenen sınıfta.

**Çataldere 2025-26 sonucu (v2.1):** 344 bahçede 9 kesin (hepsi yaz testi ✓, ham NDVI düşüşü 0,12–0,36, toplum z ≥ 1,7;
6'sı yalnız optik, 2'si radar teyitli, 1'i ortak), 6 olası, 107 belirsiz (43 yazın toparlanan kış adımı, 56 zayıf sinyal,
3 kademeli kayıp, 3 geçici, 2 diğer), 222 budama yok. Eksper kuyruğu 14 bahçe (v2'de 87). Müstahsil: 7 tam, 6 kısmen,
7 belirsiz, 109 görülmedi, 7 ruhsatsız. Ocak 2026'nın iki kar günü ve 55 günlük kış boşluğu en büyük gözlem engeli;
yaz teyidi bu boşluğu kapatıyor, HyP3 koheransı yalnız bahçe birimlerinde (yamalar için henüz hesaplanmıyor).

Açık kalanlar: saha etiketiyle gerçek kalibrasyon (`calibrate-fusion`), HyP3 koheransının diğer mahallelere
yayılması, ÇAYKUR budama takvimi ve 1/7–1/10 oranının resmî teyidi (parametre), 50 cm optik örneklem (askıda).

## Kaynaklar

- Schwieder vd. 2026, MODCiX, Remote Sensing of Environment 342 (S0034425726002361); GitHub geo-masc/modcix.
- De Vroey vd. 2022, Mowing detection using Sentinel-1 and Sentinel-2 time series for large scale grassland
  monitoring, RSE (S0034425722002590); Sen4CAP L4B belgeleri (esa-sen4cap.org).
- Komisarenko vd. 2022, Scientific Reports 12:983 (doi 10.1038/s41598-022-04932-6).
- Lobert vd. 2021, Mowing event detection in permanent grasslands: systematic evaluation of input features, RSE
  (S0034425721004715).
- Mullissa vd. 2021, Sentinel-1 SAR Backscatter ARD Preparation in GEE, Remote Sensing 13:1954; gee_s1_ard.
- ASF HyP3 belgeleri: credits (8.000/ay; burst InSAR 20 m 1 çift = 1 kredi), Burst InSAR Product Guide (5×1
  bakış 20 m, `_corr.tif`).
- Tschernij vd. 2023 (Presto), arXiv 2304.14065; nasaharvest/presto.
- JRC nrt (JOSS 2024, ec-jrc/nrt); pyxccd (PyPI).
- ESAOpenSR/sen2sr; OmniCloudMask (CloudSEN12 değerlendirmesi).
- Agronomy 2024 (14/12/2986) çay haritalama ve budama NDVI işareti; SPIE 13666 (Assam BFAST).
- Özcan & Yıldız 2025, RTEÜ Fen ve Müh. Bil. Dergisi 6(2) 530–542 (ÇAYKUR 2022 Budama Genelgesi, 1/5–1/7–1/10,
  20 cm, %70 tazminat); ÇAYKUR 2026 budama bedeli açıklaması (basın).
- Gemini ve ChatGPT araştırma notları (kullanıcı, Kasım 2026): ticari sistemler (GeoVille AMS, EOSDA, Planet,
  Airbus, Satellize), sinyal matrisi; bu notta doğrulanan kısımları kullanıldı.
