/**
 * Evidence base of the land-evaluation module: every threshold, rule and official figure points to one
 * of these sources. Types: mevzuat (law/regulation/decree), kurum (ministry / chamber / institute report),
 * akademik (peer-reviewed or thesis), istatistik (official statistics), meteoroloji (MGM), cografi-isaret
 * (TÜRKPATENT GI registration), veri (remote-sensing / model data set).
 */
export type SourceType = 'mevzuat' | 'kurum' | 'akademik' | 'istatistik' | 'meteoroloji' | 'cografi-isaret' | 'veri';

export interface SourceRef {
    id: string;
    title: string;
    org: string;
    year: number | string;
    url: string;
    type: SourceType;
    /** What was taken from it (Turkish, one line). */
    used: string;
    /** Caveat when the figure is second-hand or needs confirmation. */
    caveat?: string;
}

export const SOURCES: SourceRef[] = [
    // ── Mevzuat ──
    { id: 'kanun-5403', title: 'Toprak Koruma ve Arazi Kullanımı Kanunu (5403)', org: 'TBMM', year: 2005, url: 'https://www.mevzuat.gov.tr/mevzuat?MevzuatNo=5403&MevzuatTur=1&MevzuatTertip=5', type: 'mevzuat', used: 'Tarım arazisi sınıfları (mutlak, özel ürün, dikili, marjinal) ve tarım dışı kullanım çerçevesi.' },
    { id: 'rg-2026-33214', title: 'Arazi Kullanım Planlaması Uygulama Yönetmeliği (RG 04.04.2026, 33214)', org: 'Tarım ve Orman Bakanlığı', year: 2026, url: 'https://www.resmigazete.gov.tr/eskiler/2026/04/20260404-1-1.pdf', type: 'mevzuat', used: 'Madde 4 tanımları: mutlak / özel ürün / dikili / marjinal tarım arazisi; AKK I–IV tarım arazisi, V ıslah gerektiren, VI–VII entansif ve korumalı tekniklerle özel ürün üretimine uygun.' },
    { id: 'kanun-2844', title: 'Fındık Üretiminin Planlanması ve Dikim Alanlarının Belirlenmesi Hakkında Kanun (2844)', org: 'TBMM', year: 1983, url: 'https://www.mevzuat.gov.tr/mevzuat?MevzuatNo=2844&MevzuatTur=1&MevzuatTertip=5', type: 'mevzuat', used: 'Fındık dikimine izin verilen alanlar: rakımı 750 m’yi geçmeyen ve eğimi %12’den fazla olan araziler (1. ve 2. sınıf tarım arazileri dışında).', caveat: 'Eşikler ikincil kaynaktan (basın) alındı; kanun ve yönetmelik metninden doğrulanmalı.' },
    { id: 'karar-6243', title: '2022 Yılında Yapılacak Tarımsal Desteklemelere İlişkin Karar (6243) — Tarım Havzaları ekli listesi', org: 'Cumhurbaşkanlığı / Tarım ve Orman Bakanlığı', year: 2022, url: 'https://www.resmigazete.gov.tr/eskiler/2022/10/20221025-5.pdf', type: 'mevzuat', used: 'Türkiye Tarım Havzaları Üretim ve Destekleme Modeli kapsamında ilçe bazında desteklenen ürünler (Trabzon-Of: Mısır (dane), Yem bitkileri, Fındık, Yaş çay).', caveat: 'Liste her yıl yeni kararla güncellenir; son yıl tebliği kontrol edilmeli.' },
    // ── Kurum raporları ──
    { id: 'tepge-cay-2025', title: 'Çay — Tarım Ürünleri Piyasaları Raporu, Temmuz 2025', org: 'TEPGE (Tarım ve Orman Bakanlığı)', year: 2025, url: 'https://arastirma.tarimorman.gov.tr/tepge/Belgeler/PDF%20Tar%C4%B1m%20%C3%9Cr%C3%BCnleri%20Piyasalar%C4%B1/2025-Temmuz%20Tar%C4%B1m%20%C3%9Cr%C3%BCnleri%20Raporu/%C3%87ay%20Tar%C4%B1m%20%C3%9Cr%C3%BCnleri%20Piyasalar%C4%B1%20Raporu%20Temmuz-2025.pdf', type: 'kurum', used: 'Türkiye çay alanı 810 bin da (2023/24), yaş çay 1,357 milyon t, verim 1.713 kg/da; 2024 üretim 1,4 Mt, Rize payı %67,7, ÇAYKUR alım payı %54; 2025 alım fiyatı 25,44 TL/kg.' },
    { id: 'rtb-cay-2026', title: 'Çay Sektörü Raporu, Ocak 2026', org: 'Rize Ticaret Borsası', year: 2026, url: 'https://www.rtb.org.tr/uploads/files/110-%C3%87ay_Sekt%C3%B6r%C3%BC_Raporu_Ocak_2026.doc', type: 'kurum', used: 'Doğu Karadeniz çay alanı 791.287 da, 205.118 üretici (yeni ölçüm); hammadde maliyet payı %75–80.' },
    { id: 'tzob-cay', title: 'TZOB açıklaması: 1990–2014 döneminde çaylıklar ve üretim', org: 'Türkiye Ziraat Odaları Birliği', year: 2015, url: 'https://bigpara.hurriyet.com.tr/kobi/sektor-haberleri/cayda-uretim-artiyor_ID1423443/', type: 'kurum', used: '1990–2014: çay alanı %16 azalırken yaş çay üretimi 608 bin t → 1,26 milyon t (verim artışı); Çay Kanunu talebi.' },
    { id: 'trabzon-iltarim-arazi', title: 'İl Arazisinin İlçeler İtibariyle Dağılımı', org: 'Trabzon İl Tarım ve Orman Müdürlüğü (TÜİK 2023, Mera Bilgi Sistemi 2024, OBM)', year: 2024, url: 'https://trabzon.tarimorman.gov.tr/Menu/32/Arazi-Durumu', type: 'istatistik', used: 'Of: tarım alanı 111.050 da, çayır-mera 968 da, orman 105.500 da, tarım dışı 42.382 da, toplam 259.900 da.' },
    { id: 'trabzon-bel-cevre', title: 'Trabzon il raporu (çevre / tarım bölümü)', org: 'Trabzon Büyükşehir Belediyesi', year: 2024, url: 'https://kurumsal.trabzon.bel.tr/Upload/WebAdmin/BasitBaglanti/20241001081412g6XpK.pdf', type: 'kurum', used: 'Trabzon’da çay yalnız Araklı, Sürmene ve Of ilçelerinde üretilir; yıllık yaş çay ≈ 150 bin t; fındık ≈ 50 bin t (Türkiye’nin %10’u).' },
    { id: 'cem-atlas-2018', title: 'Türkiye Su Erozyonu Atlası ve Dinamik Erozyon Modeli (DEMİS)', org: 'ÇEM Genel Müdürlüğü (Erpul vd.)', year: 2018, url: 'https://acikders.ankara.edu.tr/mod/resource/view.php?id=173824', type: 'kurum', used: 'RUSLE A = R·K·LS·C·P; R 357 OMGİ dakikalık veriden EI30, K Römkens, LS Moore–Burch, C CORINE/Panagos; erozyon şiddeti sınıfları.' },
    // ── Meteoroloji ──
    { id: 'mgm-normals', title: 'Resmi İklim İstatistikleri (il merkez istasyonları, aylık ortalamalar)', org: 'Meteoroloji Genel Müdürlüğü', year: '1927–2025', url: 'https://www.mgm.gov.tr/veridegerlendirme/il-ve-ilceler-istatistik.aspx', type: 'meteoroloji', used: 'Rize, Trabzon, Giresun, Artvin aylık sıcaklık / yağış / yağışlı gün normalleri; model serisi bu normallere bağlanır.' },
    { id: 'mgm-siniflandirma', title: 'İklim Sınıflandırmaları (1991–2020): Aydeniz, De Martonne, Erinç, Thornthwaite, Trewartha', org: 'Meteoroloji Genel Müdürlüğü', year: 2021, url: 'https://www.mgm.gov.tr/iklim/iklim-siniflandirmalari.aspx?m=RIZE', type: 'meteoroloji', used: 'Rize: Erinç 121,6 çok nemli, De Martonne 71,2, Aydeniz 0,11, Thornthwaite A B’2 r b’4; Trabzon: Erinç 45,4 nemli, De Martonne 23,3 yarı nemli, Thornthwaite C2 B’2 s b’4; Hopa: De Martonne 71,9.' },
    { id: 'mgm-erinc', title: 'Erinç İklim Sınıflandırmasına Göre Türkiye İklimi', org: 'Meteoroloji Genel Müdürlüğü', year: 2016, url: 'https://www.mgm.gov.tr/FILES/iklim/iklim_siniflandirmalari/erinc.pdf', type: 'meteoroloji', used: 'Im = P / Tom; sınıflar: <8 tam kurak, 8–15 kurak, 15–23 yarı kurak, 23–40 yarı nemli, 40–55 nemli, >55 çok nemli.' },
    { id: 'demartonne-1942', title: 'De Martonne kuraklık indisi', org: 'De Martonne (1942); MGM uygulaması', year: 1942, url: 'https://acikders.ankara.edu.tr/mod/resource/view.php?id=2210', type: 'akademik', used: 'I = P / (T + 10); sınıflar: <10 kurak, 10–20 yarı kurak, 20–24 yarı nemli, 24–28 nemli, 28–35 çok nemli, >35 ıslak.' },
    { id: 'sen-trend-karadeniz', title: 'Karadeniz Bölgesinde Yağış ve Sıcaklık Verilerinin Yenilikçi Şen Yöntemi ile Trend Analizi (16 istasyon, 1960–2015)', org: 'OMÜ (açık erişim)', year: 2019, url: 'https://acikerisim.omu.edu.tr/entities/publication/4f66bae4-f57f-457a-90b9-7a9d663bd73b', type: 'akademik', used: 'Yıllık sıcaklık tüm istasyonlarda artış; yıllık yağış 16 istasyonun 15’inde artış; kış yağışlarında azalma eğilimi.' },
    { id: 'ita-trend-karadeniz', title: 'Trend Analysis of Precipitation and Temperatures in the Black Sea Region Using the Innovative Trend Analysis (13 il)', org: 'Atatürk Üniversitesi', year: 2021, url: 'https://avesis.atauni.edu.tr/yayin/7f56cd1f-7d5a-4de0-bb08-53464e8669c1', type: 'akademik', used: 'Rize ve Trabzon istasyonlarında yağış ve sıcaklıkta artış; sıcaklık artışı yağıştan belirgin.' },
    // ── Coğrafi işaretler ──
    { id: 'rize-cayi-ci', title: 'Rize Çayı — Menşe Adı (Tescil No 707)', org: 'TÜRKPATENT / Rize Ticaret Borsası', year: 2021, url: 'https://rtb.org.tr/uploads/files/2041-Rize_%C3%87ay%C4%B1_Co%C4%9Frafi_%C4%B0%C5%9Faret_%C5%9Eartlar%C4%B1.pdf', type: 'cografi-isaret', used: 'Rize kıyıdan ≈750 m’ye kadar geniş yapraklı, 800–1400 m karışık orman kuşağı; çayın karakterini iklim, toprak ve topografya verir.' },
    { id: 'akcakoca-findik-ci', title: 'Akçakoca Sarı Fındığı — Menşe Adı (Tescil No 419)', org: 'TÜRKPATENT / Akçakoca TSO', year: 2019, url: 'https://duzce.tarimorman.gov.tr/Belgeler/Cografi_%C4%B0saret/Ak%C3%A7akoca_Sari_Findigi.pdf', type: 'cografi-isaret', used: 'Fındık: en düşük sıcaklık −8/−10 °C’yi, en yüksek 36–37 °C’yi geçmemeli; yıllık yağış >700 mm ve dengeli; Haziran–Temmuz nemi %60’ın altına düşmemeli.' },
    { id: 'duzce-kestane-bali-ci', title: 'Düzce Kestane Balı — Menşe Adı (Tescil No 882)', org: 'TÜRKPATENT / Düzce İl Tarım ve Orman Müdürlüğü', year: 2021, url: 'https://duzce.tarimorman.gov.tr/Belgeler/Cografi_%C4%B0saret/Duzce_Kestane_Bali.pdf', type: 'cografi-isaret', used: 'Kestane çiçeği yağmura hassastır; çiçeklenmede az yağış bal üretimini artırır; çiçeklenme ≈ 1 ay.' },
    { id: 'ayder-bali-ci', title: 'Çamlıhemşin Ayder Balı — Coğrafi İşaret', org: 'TÜRKPATENT', year: 2020, url: 'https://ci.turkpatent.gov.tr/Files/GeographicalSigns/4ac2b783-3c5d-4782-a154-68063ae4fd51.pdf', type: 'cografi-isaret', used: 'Kaçkar kuzey yamaçlarından Ardeşen’e; kestane balı Hala Deresi çevresinden; uzun çiçeklenme periyodu.' },
    // ── Akademik / enstitü ──
    { id: 'au-cay-ders', title: 'Çay Yetiştiriciliği ders notu (ekolojik istekler)', org: 'Ankara Üniversitesi Açık Ders', year: 2020, url: 'https://acikders.ankara.edu.tr/mod/resource/view.php?id=18508', type: 'akademik', used: 'Yıllık ortalama sıcaklık ≥14 °C, −15 °C dondurur, >40 °C yakar; yıllık yağış ≥1200–1500 mm ve düzenli; pH 4,5–6, kireç <%5.' },
    { id: 'rize-ph-tez', title: 'Rize yöresi topraklarında çay tarımında uygun pH koşullarının belirlenmesi', org: 'YÖK Tez', year: 2019, url: 'https://acikbilim.yok.gov.tr/handle/20.500.12812/51454', type: 'akademik', used: 'Rize–Artvin çay toprak örneklerinin ≈%90’ı ideal pH’nin altında (çok asit); bahçe toprakları pH 3,5–5,0.' },
    { id: 'omu-rize-erozyon', title: 'Rize’de organik ve geleneksel çay tarımı yapılan toprakların kalitesi ve erozyona duyarlılığı', org: 'OMÜ (açık erişim)', year: 2021, url: 'https://acikerisim.omu.edu.tr/entities/publication/7d7596e3-3941-493c-875f-d1be98a0bfcd', type: 'akademik', used: 'Çay toprakları çoğunlukla hafif bünyeli ve erozyona duyarlı.' },
    { id: 'au-findik-ders', title: 'Fındık Yetiştiriciliği ders notu (ekolojik istekler)', org: 'Ankara Üniversitesi Açık Ders', year: 2020, url: 'https://acikders.ankara.edu.tr/mod/resource/view.php?id=109670', type: 'akademik', used: 'Yıllık ortalama 13–16 °C; kış −8/−10 °C’nin altına inmemeli; yaz 36–37 °C’yi aşmamalı; yağış >750 mm ve dengeli; hafif asit (pH 6–6,5), humuslu, tınlı, geçirgen toprak.' },
    { id: 'giresun-findik-iklim', title: 'The effect of climatic conditions on hazelnut yield in Giresun', org: 'TR Dizin', year: 2010, url: 'https://search.trdizin.gov.tr/publication/detail/134653/', type: 'akademik', used: 'Sıcaklık fındık verimini belirleyen başlıca iklim etmeni.' },
    { id: 'kastamonu-findik-yukselti', title: 'Fındık yetiştirme alanlarının yükseltisi (Araklı–Ordu 0–700 m)', org: 'Kastamonu Üniversitesi (açık erişim)', year: 2022, url: 'https://acikerisim.kastamonu.edu.tr/bitstreams/32344850-7300-41f3-ac07-efc82cf9b0f4/download', type: 'akademik', used: 'Doğu Karadeniz’de fındık çoğunlukla 0–700 m kuşağında.' },
    { id: 'tagem-kivi-2022', title: 'Kivi Yetiştiriciliği (broşür)', org: 'TAGEM Alata Bahçe Kültürleri Araştırma Enstitüsü (K. Erçik)', year: 2022, url: 'https://arastirma.tarimorman.gov.tr/alata/Belgeler/brosurler/brosur2022/KiviYeti%C5%9Ftricili%C4%9Fi-KaderER%C3%87%C4%B0K.pdf', type: 'kurum', used: 'Yıllık ortalama 12–16 °C; 240–260 gün donsuz dönem; kış −6/−10 °C zarar (verim yaşında −13 °C’ye dayanır), ilkbahar −0,5 °C sürgün, sonbahar −2 °C meyve; 400–600 saat soğuklama (<7,2 °C); nem %50–70; sürekli sert rüzgâr olmamalı; süzek, hafif, derin toprak; taban suyu yüksek ve ağır topraklar uygun değil; pH 5,5–7,0; kireç ≤%8.' },
    { id: 'yalova-kivi', title: 'Kivi yetiştiriciliği için uygun bölgeler (Doğu Karadeniz, Yalova)', org: 'Yalova Atatürk Bahçe Kültürleri Merkez Araştırma Enstitüsü', year: 2020, url: 'https://arastirma.tarimorman.gov.tr/yalovabahce/Menu/52/Bagcilik', type: 'kurum', used: 'Doğu Karadeniz kıyı kuşağı kivi için uygun bölge.' },
    { id: 'ktae-maviyemis-2025', title: 'Maviyemiş Yetiştiriciliği (BÜBS 2. Bölge Grup Toplantısı sunumu; Çelik 2012’ye dayanır)', org: 'Karadeniz Tarımsal Araştırma Enstitüsü (D. Çil)', year: 2025, url: 'https://arastirma.tarimorman.gov.tr/ktae/Belgeler/BGT/bgt_2025_2_Maviyemis_Aronya.pdf', type: 'kurum', used: '1. iklim tipi (Doğu Karadeniz yüksek yerler): soğuklama >1000 saat, donsuz 130–180 gün, yaz <30 °C; 2. tip: soğuklama >600 saat, donsuz 170–200 gün; organik maddece zengin, düşük pH’lı kumlu-tınlı topraklar; asitleştirme için kükürt.' },
    { id: 'euforgen-castanea', title: 'Castanea sativa — species description', org: 'EUFORGEN', year: 2009, url: 'https://www.euforgen.org/species/castanea-sativa', type: 'akademik', used: 'Kestane: iyi drene topraklar, yıllık >600 mm yağış, kısa ya da hiç kurak mevsim; kireçli toprakları sevmez.' },
    { id: 'kestane-yukselti', title: 'Türkiye’de kestane meşcerelerinin yükselti kuşağı (Aydın 700 m+, Isparta 1090–1170 m, Arhavi 1000 m’ye kadar)', org: 'Tez ve coğrafi işaret kayıtları', year: 2018, url: 'https://tezara.org/theses/545273', type: 'akademik', used: 'Kestane Karadeniz’de kıyıdan ≈1000 m’ye kadar; en verimli kuşak 300–1000 m.' },
    { id: 'ktu-catak-rusle', title: 'Trabzon Değirmendere–Çatak alt havzası erozyon risk haritası (RUSLE)', org: 'KTÜ', year: 2022, url: 'https://avesis.ktu.edu.tr/yayin/baecb088-e939-4a94-bd52-47db8f9e90fb', type: 'akademik', used: 'Ortalama R 324,65 · K 0,029 · LS 11,23 · C 0,038 · toprak kaybı 3,28 t/ha/yıl (Trabzon).' },
    { id: 'bartin-fol-rusle', title: 'Foldere yağış havzasında RUSLE ile toprak erozyonu (Trabzon)', org: 'Bartın Üniversitesi', year: 2021, url: 'https://acikerisim.bartin.edu.tr/entities/publication/ee68c25a-4ee9-41d8-a2f5-573d80261b2d', type: 'akademik', used: 'R 422 · K 0,018 · LS 10,7 · C 0,026 · 3,76 t/ha/yıl; R yağıştan (R ≈ 38,5 + 0,35·P) türetilir.' },
    { id: 'ordu-rusle-2025', title: 'GEE-based RUSLE soil loss in Ordu province', org: 'Annals of GIS', year: 2025, url: 'https://doaj.org/article/4d2e5a6dae074be687978915125ba743', type: 'akademik', used: 'Ordu il ortalaması 12,58 t/ha/yıl; LS en etkili faktör.' },
    { id: 'renard-rusle-1997', title: 'Predicting Soil Erosion by Water: RUSLE (Agriculture Handbook 703)', org: 'USDA (Renard vd.)', year: 1997, url: 'https://www.ars.usda.gov/arsuserfiles/64080530/rusle/ah_703.pdf', type: 'akademik', used: 'LS = (λ/22,13)^m · (65,41 sin²θ + 4,56 sinθ + 0,065); A = R·K·LS·C·P.' },
    { id: 'usda-akk', title: 'Land Capability Classification (Agriculture Handbook 210) ve Türkiye uyarlaması (Toprak ve Arazi Sınıflaması Standartları Teknik Talimatı)', org: 'USDA / Tarım ve Orman Bakanlığı', year: 1961, url: 'https://acikders.ankara.edu.tr/mod/resource/view.php?id=166193', type: 'akademik', used: 'Eğim sınıfları A %0–2, B %2–6, C %6–12, D %12–20, E %20–30, F >%30; I–IV işlemeli tarıma uygun, V–VIII uygun değil; sınırlama kodları e (erozyon), w (ıslaklık), s (toprak), c (iklim).' },
    // ── Veri setleri ──
    { id: 'copernicus-dem', title: 'Copernicus DEM GLO-30 (TanDEM-X radar)', org: 'ESA / Airbus', year: 2021, url: 'https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_DEM_GLO30', type: 'veri', used: 'Yükselti, eğim, bakı, TPI (30 m).' },
    { id: 'merit-hydro', title: 'MERIT Hydro', org: 'Yamazaki vd.', year: 2019, url: 'https://developers.google.com/earth-engine/datasets/catalog/MERIT_Hydro_v1_0_1', type: 'veri', used: 'Dere kotu üstü yükseklik (HAND), havza alanı, akarsu ağı (90 m).' },
    { id: 'jrc-gsw', title: 'JRC Global Surface Water', org: 'JRC / Pekel vd.', year: 2016, url: 'https://developers.google.com/earth-engine/datasets/catalog/JRC_GSW1_4_GlobalSurfaceWater', type: 'veri', used: 'Yüzey suyu sıklığı (30 m).' },
    { id: 'openlandmap', title: 'OpenLandMap toprak katmanları (kil, kum, pH, organik karbon, hacim ağırlığı, bünye)', org: 'OpenGeoHub / Hengl', year: 2018, url: 'https://developers.google.com/earth-engine/datasets/catalog/OpenLandMap_SOL_SOL_PH-H2O_USDA-4C1A2A_M_v02', type: 'veri', used: '0–30 cm toprak özellikleri (250 m).' },
    { id: 'dynamic-world', title: 'Dynamic World V1', org: 'Google / WRI', year: 2022, url: 'https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1', type: 'veri', used: 'Yıllık arazi örtüsü (10 m, 2015→).' },
    { id: 'worldcover', title: 'ESA WorldCover 2021 v200', org: 'ESA', year: 2022, url: 'https://developers.google.com/earth-engine/datasets/catalog/ESA_WorldCover_v200', type: 'veri', used: 'Arazi örtüsü karşılaştırması (10 m).' },
    { id: 'landsat', title: 'Landsat 5/7/8/9 Collection 2 Level-2', org: 'USGS', year: '1984→', url: 'https://developers.google.com/earth-engine/datasets/catalog/landsat', type: 'veri', used: '1986’dan bugüne yaz NDVI bileşikleri: bitki örtüsü yoğunluğu tarihi (30 m).' },
    { id: 'era5-land', title: 'ERA5-Land günlük', org: 'ECMWF / Copernicus', year: '1950→', url: 'https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_LAND_DAILY_AGGR', type: 'veri', used: 'Günlük sıcaklık, çiy noktası (nem), yağış (11 km); MGM normallerine bağlanır.' },
    { id: 'chirps', title: 'CHIRPS günlük yağış', org: 'UCSB CHG', year: '1981→', url: 'https://developers.google.com/earth-engine/datasets/catalog/UCSB-CHG_CHIRPS_DAILY', type: 'veri', used: 'Yağış karşılaştırma serisi (5 km).' },
];

export const SOURCE_BY_ID = new Map(SOURCES.map((s) => [s.id, s]));

/** Monthly normals of MGM provincial stations used to anchor the model series. */
export interface StationNormals {
    id: string;
    name: string;
    lat: number;
    lng: number;
    elevationM: number;
    period: string;
    /** Jan..Dec */
    tmean: number[];
    tmax: number[];
    tmin: number[];
    rainDays: number[];
    precipMm: number[];
    /** MGM climate-classification values (1991–2020) when published. */
    classes?: { erinc?: number; deMartonne?: number; aydeniz?: number; thornthwaite?: string };
    /** false: shown for reference only, never used for anchoring (inland valley station). */
    anchor?: boolean;
    sources: string[];
}

export const STATIONS: StationNormals[] = [
    {
        id: '17040', name: 'Rize', lat: 41.04, lng: 40.5, elevationM: 9, period: '1927–2025',
        tmean: [6.9, 6.8, 8.2, 11.7, 16.0, 20.4, 22.9, 23.3, 20.4, 16.5, 12.4, 8.8],
        tmax: [10.7, 10.8, 12.0, 15.5, 19.4, 23.6, 26.0, 26.6, 24.1, 20.5, 16.6, 12.9],
        tmin: [3.9, 3.7, 5.0, 8.4, 12.7, 16.8, 19.7, 20.1, 17.0, 13.2, 9.2, 5.8],
        rainDays: [14.52, 14.15, 15.65, 14.52, 14.25, 13.97, 13.66, 14.13, 14.61, 14.76, 13.34, 14.01],
        precipMm: [231.2, 186.1, 159.8, 97.6, 96.5, 133.9, 150.9, 193.1, 256.6, 293.8, 250.4, 241.8],
        classes: { erinc: 121.59, deMartonne: 71.2, aydeniz: 0.11, thornthwaite: "A B'2 r b'4" },
        sources: ['mgm-normals', 'mgm-siniflandirma'],
    },
    {
        id: '17037', name: 'Trabzon', lat: 41.0, lng: 39.72, elevationM: 30, period: '1927–2025',
        tmean: [7.6, 7.3, 8.5, 11.8, 15.9, 20.3, 23.1, 23.5, 20.5, 16.7, 13.1, 9.6],
        tmax: [10.9, 10.8, 12.0, 15.6, 19.2, 23.3, 26.1, 26.7, 23.9, 20.1, 16.6, 13.1],
        tmin: [4.8, 4.5, 5.5, 8.8, 13.0, 17.2, 20.0, 20.5, 17.5, 13.7, 10.1, 6.8],
        rainDays: [11.78, 11.56, 12.78, 12.46, 12.32, 10.32, 7.66, 8.31, 10.4, 11.81, 11.32, 11.88],
        precipMm: [82.8, 64.2, 60.0, 57.0, 52.6, 52.2, 36.6, 47.8, 79.0, 113.4, 99.3, 85.3],
        classes: { erinc: 45.44, deMartonne: 23.34, aydeniz: 0.33, thornthwaite: "C2 B'2 s b'4" },
        sources: ['mgm-normals', 'mgm-siniflandirma'],
    },
    {
        id: '17034', name: 'Giresun', lat: 40.92, lng: 38.39, elevationM: 37, period: '1929–2025',
        tmean: [7.4, 7.2, 8.2, 11.4, 15.6, 20.3, 23.0, 23.4, 20.3, 16.5, 12.9, 9.6],
        tmax: [10.7, 10.7, 11.9, 15.1, 19.0, 23.6, 26.2, 26.7, 23.7, 20.0, 16.4, 13.0],
        tmin: [4.8, 4.5, 5.4, 8.5, 12.8, 17.2, 19.9, 20.4, 17.4, 13.8, 10.2, 7.0],
        rainDays: [14.68, 14.27, 15.87, 14.67, 14.21, 11.9, 10.83, 10.73, 12.48, 14.02, 13.23, 14.29],
        precipMm: [128.3, 100.9, 99.2, 75.7, 68.5, 77.3, 81.4, 89.1, 130.4, 162.9, 150.9, 127.4],
        sources: ['mgm-normals'],
    },
    {
        id: '17045', name: 'Artvin', lat: 41.18, lng: 41.82, elevationM: 597, period: '1949–2025',
        tmean: [2.8, 3.8, 7.1, 12.0, 15.9, 18.9, 20.9, 21.3, 18.4, 14.2, 9.1, 4.5],
        tmax: [6.4, 8.4, 12.5, 18.0, 21.9, 24.3, 25.9, 26.5, 24.0, 19.7, 13.5, 8.0],
        tmin: [-0.1, 0.5, 3.0, 7.3, 11.2, 14.4, 17.0, 17.3, 14.3, 10.3, 5.8, 1.9],
        rainDays: [12.96, 12.62, 13.52, 12.73, 14.14, 12.56, 8.39, 8.09, 8.64, 10.97, 10.88, 11.71],
        precipMm: [84.6, 72.2, 60.5, 52.7, 53.8, 48.4, 31.7, 28.7, 39.0, 60.8, 74.9, 86.8],
        anchor: false,
        sources: ['mgm-normals'],
    },
];

/** Official district-level facts shown next to the model results (keyed by canonical "il/ilçe"). */
export interface DistrictFacts {
    province: string;
    district: string;
    landUseDa: { agriculture: number; pasture: number; forest: number; nonAgri: number; total: number; source: string } | null;
    /** Products supported under Tarım Havzaları model for this district. */
    supportedProducts: { products: string[]; source: string } | null;
    notes: Array<{ text: string; source: string }>;
}

export const DISTRICT_FACTS: DistrictFacts[] = [
    {
        province: 'Trabzon',
        district: 'Of',
        landUseDa: { agriculture: 111050, pasture: 968, forest: 105500, nonAgri: 42382, total: 259900, source: 'trabzon-iltarim-arazi' },
        supportedProducts: { products: ['Mısır (dane)', 'Yem bitkileri', 'Fındık', 'Yaş çay'], source: 'karar-6243' },
        notes: [
            { text: 'Trabzon’da çay yalnız Araklı, Sürmene ve Of’ta üretilir; üç ilçenin yıllık yaş çayı ≈ 150 bin ton.', source: 'trabzon-bel-cevre' },
            { text: 'Doğu Karadeniz çay alanı 791.287 da, 205.118 üretici (RTB 2026); Türkiye verimi 1.713 kg/da (TEPGE 2025).', source: 'rtb-cay-2026' },
            { text: '1990–2014: çaylık alanı %16 azalırken üretim iki katına çıktı (verim artışı) — TZOB.', source: 'tzob-cay' },
        ],
    },
    { province: 'Trabzon', district: 'Sürmene', landUseDa: { agriculture: 55023, pasture: 27263, forest: 132610, nonAgri: 100104, total: 315000, source: 'trabzon-iltarim-arazi' }, supportedProducts: { products: ['Mısır (dane)', 'Yem bitkileri', 'Fındık', 'Yaş çay'], source: 'karar-6243' }, notes: [] },
    { province: 'Trabzon', district: 'Araklı', landUseDa: { agriculture: 78723, pasture: 149870, forest: 153440, nonAgri: 69767, total: 451800, source: 'trabzon-iltarim-arazi' }, supportedProducts: { products: ['Mısır (dane)', 'Yem bitkileri', 'Fındık', 'Yaş çay'], source: 'karar-6243' }, notes: [] },
    { province: 'Trabzon', district: 'Hayrat', landUseDa: { agriculture: 29727, pasture: 98223, forest: 91510, nonAgri: 28340, total: 247800, source: 'trabzon-iltarim-arazi' }, supportedProducts: { products: ['Yem bitkileri', 'Fındık', 'Yaş çay'], source: 'karar-6243' }, notes: [] },
    { province: 'Trabzon', district: 'Dernekpazarı', landUseDa: { agriculture: 9126, pasture: 1109, forest: 13100, nonAgri: 9665, total: 33000, source: 'trabzon-iltarim-arazi' }, supportedProducts: { products: ['Mısır (dane)', 'Kuru fasulye', 'Yem bitkileri', 'Fındık', 'Yaş çay'], source: 'karar-6243' }, notes: [] },
    { province: 'Trabzon', district: 'Köprübaşı', landUseDa: { agriculture: 19742, pasture: 64077, forest: 50850, nonAgri: 9331, total: 144000, source: 'trabzon-iltarim-arazi' }, supportedProducts: { products: ['Mısır (dane)', 'Yem bitkileri', 'Fındık', 'Yaş çay'], source: 'karar-6243' }, notes: [] },
    { province: 'Trabzon', district: 'Arsin', landUseDa: { agriculture: 88553, pasture: 3643, forest: 81600, nonAgri: 38704, total: 212500, source: 'trabzon-iltarim-arazi' }, supportedProducts: { products: ['Mısır (dane)', 'Kuru fasulye', 'Yem bitkileri', 'Fındık'], source: 'karar-6243' }, notes: [] },
    { province: 'Rize', district: 'Merkez', landUseDa: null, supportedProducts: { products: ['Mısır (dane)', 'Yem bitkileri', 'Yaş çay'], source: 'karar-6243' }, notes: [] },
    { province: 'Rize', district: 'Çayeli', landUseDa: null, supportedProducts: { products: ['Mısır (dane)', 'Yem bitkileri', 'Yaş çay'], source: 'karar-6243' }, notes: [] },
    { province: 'Rize', district: 'Derepazarı', landUseDa: null, supportedProducts: { products: ['Mısır (dane)', 'Yem bitkileri', 'Yaş çay'], source: 'karar-6243' }, notes: [] },
    { province: 'Rize', district: 'Pazar', landUseDa: null, supportedProducts: { products: ['Mısır (dane)', 'Yem bitkileri', 'Fındık', 'Yaş çay'], source: 'karar-6243' }, notes: [] },
    { province: 'Artvin', district: 'Hopa', landUseDa: null, supportedProducts: { products: ['Mısır (dane)', 'Yem bitkileri', 'Fındık', 'Yaş çay'], source: 'karar-6243' }, notes: [] },
    { province: 'Artvin', district: 'Kemalpaşa', landUseDa: null, supportedProducts: { products: ['Buğday', 'Mısır (dane)', 'Yem bitkileri', 'Fındık', 'Yaş çay'], source: 'karar-6243' }, notes: [] },
    { province: 'Giresun', district: 'Tirebolu', landUseDa: null, supportedProducts: { products: ['Yem bitkileri', 'Fındık', 'Yaş çay'], source: 'karar-6243' }, notes: [] },
];

const canonical = (s: string) => s.trim().toLocaleLowerCase('tr').replace(/ı/g, 'i');

export function districtFactsOf(province: string, district: string): DistrictFacts | null {
    return DISTRICT_FACTS.find((d) => canonical(d.province) === canonical(province) && canonical(d.district) === canonical(district)) ?? null;
}

/** Products in the district support list that correspond to our crop keys. */
export const SUPPORT_PRODUCT_TO_CROP: Record<string, string> = { 'Yaş çay': 'tea', 'Fındık': 'hazelnut', 'Yem bitkileri': 'pasture', 'Mısır (dane)': 'vegetable' };
