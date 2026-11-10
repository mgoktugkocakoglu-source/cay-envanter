# -*- coding: utf-8 -*-
"""Builds docs/budama-modulu-v2.1-teknik-rapor.pdf: what v2.1 added, where, how the module decides, evidence and accuracy."""
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_JUSTIFY
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

pdfmetrics.registerFont(TTFont("Arial", "C:/Windows/Fonts/arial.ttf"))
pdfmetrics.registerFont(TTFont("Arial-Bold", "C:/Windows/Fonts/arialbd.ttf"))
pdfmetrics.registerFontFamily("Arial", normal="Arial", bold="Arial-Bold", italic="Arial", boldItalic="Arial-Bold")

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("docs/budama-modulu-v2.1-teknik-rapor.pdf")
ss = getSampleStyleSheet()
H1 = ParagraphStyle("h1", parent=ss["Heading1"], fontName="Arial-Bold", fontSize=15, spaceBefore=10, spaceAfter=6, textColor=colors.HexColor("#14532d"))
H2 = ParagraphStyle("h2", parent=ss["Heading2"], fontName="Arial-Bold", fontSize=12, spaceBefore=8, spaceAfter=4, textColor=colors.HexColor("#1f2937"))
P = ParagraphStyle("p", parent=ss["Normal"], fontName="Arial", fontSize=9.5, leading=13, alignment=TA_JUSTIFY, spaceAfter=5)
B = ParagraphStyle("b", parent=P, leftIndent=10, bulletIndent=0, spaceAfter=3)
SM = ParagraphStyle("sm", parent=P, fontSize=8, leading=10.5, textColor=colors.HexColor("#4b5563"))
TITLE = ParagraphStyle("t", parent=ss["Title"], fontName="Arial-Bold", fontSize=19, leading=23, textColor=colors.HexColor("#14532d"), spaceAfter=4)
SUB = ParagraphStyle("st", parent=P, fontSize=10, textColor=colors.HexColor("#4b5563"), alignment=0)
TC = ParagraphStyle("tc", parent=P, fontSize=8.3, leading=10.5, alignment=0, spaceAfter=0)
TH = ParagraphStyle("th", parent=TC, fontName="Arial-Bold")


def p(t, st=P):
    return Paragraph(t, st)


def bullets(items):
    return [Paragraph(f"• {t}", B) for t in items]


def table(head, rows, widths):
    data = [[Paragraph(h, TH) for h in head]] + [[Paragraph(str(c), TC) for c in r] for r in rows]
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#dcfce7")),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#9ca3af")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f9fafb")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return t


W = A4[0] - 36 * mm
s = []
s.append(p("Budama Takibi Modülü v2.1 — Teknik Rapor", TITLE))
s.append(p("ÇAYKUR pilot sunumu için: eklemeler, dosya konumları, karar zinciri, bilimsel dayanaklar ve doğruluk değerlendirmesi · Çataldere (Trabzon/Of) 2025-26 sezonu · 10 Kasım 2026", SUB))
s.append(Spacer(1, 8))

s.append(p("1. Özet", H1))
s.append(p("Budama modülü, bir çay bahçesinin kışın derin budamaya (ocağın 20 cm'ye kesilmesi, ÇAYKUR 2022 Budama Genelgesi) uğrayıp uğramadığını yalnız ücretsiz uydu verisiyle "
           "söyler. v2.1 sürümü, önceki sürümün sinyal tabanlı karar zincirine dört fiziksel kontrol ve bir istatistiksel kalibrasyon ekler; böylece karar artık "
           "'bir indeks düştü' gözlemine değil, derin budamanın bitki fizyolojisinde bıraktığı zorunlu izlere dayanır: bahçenin kendi örtüsü düşmüş olmalı, düşüş ani bir basamak olmalı, "
           "kar veya bulut tarafından açıklanamamalı ve yaz başında örtü hâlâ komşularının altında kalmalı. Çataldere'de 344 bahçede 'kesin' sınıfı 9 bahçeye daraldı; "
           "bu 9 bahçenin tamamı yaz testini geçti, eksper kuyruğu 87'den 14'e indi."))

s.append(p("2. Nereye ne eklendi", H1))
s.append(table(["Dosya / konum", "Ekleme"], [
    ["cay-envanter/src/fusion/model.ts", "Karar modeli v2.1: tarih eleme (dateQuality), ham NDVI seviye kontrolü (rawLevels), basamak/eğim ayrımı (stepShape), yaz toparlanma testi (recoveryTest), takvim bayrağı, karar türü (kind), yeni karar zinciri ve gerekçe metinleri."],
    ["cay-envanter/src/cli/fuse-pruning.ts", "Seri penceresi Eylül → 15 Temmuz; çekilen her parça anında önbelleğe yazılır; toplum kalibrasyonu (mahalle sağlam ortanca/IQR); müstahsil durumunda yalnız incelemelik belirsizler dosyayı açık tutar; özet alanları (dışlanan tarihler, kontrol sayıları, karar türleri)."],
    ["cay-envanter/src/fusion/optical-series.ts, src/radar/series.ts, src/ee/session.ts", "Sentinel-2 + Landsat 8/9 optik ve Sentinel-1 γ0 serileri, Earth Engine bellek sınırında parçayı ikiye bölen kapasiteye duyarlı çekim (reduceDatesInChunks)."],
    ["cay-envanter/py/hyp3_coherence.py", "ASF HyP3 burst InSAR koherans (ücretsiz, ayda 8.000 kredi; 1 çift = 1 kredi); aynı geçişin yörüngeleri tek seride birleştirilir. Çataldere 2025-26: 102 çift."],
    ["cay-envanter/scripts/fusion-synthetic.ts", "15 sentetik senaryo (derin/hafif/geçici/kar/bulut boşluğu/çelişki/kademeli/yaz toparlanma/Nisan budaması); hepsi beklenen sınıfta."],
    ["cayhesabim (site) API + web", "Karar türü, seviye, şekil, toparlanma ve toplum z alanları; 'Fiziksel kontroller' satırı, yeni rozetler ('Yaz toparlanma testi ✓', 'Kademeli kayıp', 'Takvim dışı'); kanal etiketleri. Çataldere paketi yeniden üretildi."],
    ["Dokümantasyon", "cay-envanter/README.md (füzyon bölümü), docs/budama-arastirma-2026-11.md (8. bölüm: uygulama durumu)."],
], [55 * mm, W - 55 * mm]))

s.append(p("3. Modül ne yapıyor — karar zinciri", H1))
s.append(p("Her bahçe (ve optik taramanın çizdiği kısmi değişim yaması) için Eylül'den Temmuz ortasına kadar sensör serileri çekilir ve her tarihte mahalle ortancası çıkarılarak komşuluğa göreli hale getirilir. "
           "Böylece hava, mevsim ve kar gibi herkesi birlikte oynatan etkiler düşer; geriye bahçeye özgü değişim kalır."))
s.append(table(["Adım", "İşlem", "Gerekçe"], [
    ["1 Veri", "S2 (B4/B8/B5/B8A/B11/B12) + Landsat 8/9 NDVI, NBR, NDRE, NDII; S1 VH ve VH/VV (γ0 arazi düzleştirme, hacim modeli, Copernicus DEM); koherans (HyP3 5×1 bakış, 20 m).", "Gözlem yoğunluğu doğruluğun en büyük kaldıracıdır (MODCiX 2026: ≥16 temiz gözlem); Landsat kışın bulut boşluklarını kapatır."],
    ["2 Tarih eleme", "Mahalle ortanca NDVI'si < 0,65 olan günler (kar, don, alçak kış güneşi gölgesi) ve sensörün görebildiği bahçelerin < %25'ini kapsayan günler herkes için dışlanır.", "Mahallenin en fazla 1/7'si budanır; ortancanın çökmesi budamayla açıklanamaz. Çataldere'de 6 ve 26 Ocak 2026 (ortanca 0,46 / 0,38) elendi."],
    ["3 Basamak testi", "Aday her değişim tarihi için önce/sonra (75+75 gün) farkı, bahçenin kendi sağlam gürültüsüne bölünerek z-skoru; kalıcılık (t0+25 gün sonrası) ile çarpılır; sensörler Stouffer ile birleşir.", "Değişim noktası analizi (Lobert 2021 biçme tespiti; Komisarenko 2022 reddetme bölgesi mantığı)."],
    ["4 Fiziksel kapılar", "NDVI/NBR ≥ 0,12, NDRE ≥ 0,08, NDII ≥ 0,10, VH ≥ 1 dB; NDVI ile bir SWIR indeksi birlikte düşmeli (kar NDVI'yi düşürür, NBR'yi yükseltir).", "Derin budama örtüyü kaldırır: NIR düşer, SWIR yükselir. Kar ise SWIR'de karanlıktır → zıt işaret."],
    ["5 Ham seviye", "Bahçenin kendi NDVI'si de ≥ 0,08 düşmüş olmalı.", "Komşular yeşillenirken yerinde sayan bahçe göreli düşer ama budanmamıştır (geçen yıl budanan ya da yaşlı bahçeler)."],
    ["6 Basamak/eğim", "Sezon serisine bir çizgi, basamağı ≤ 1,15 kat artıkla açıklıyorsa veya t0 öncesi zaten ≥ 0,12 kaymışsa 'kademeli kayıp'.", "Terk, sökme, hastalık ve yapılaşma yavaş düşer; budama ani basamaktır (BFAST/LandTrendr'daki ani–kademeli ayrımı)."],
    ["7 Yaz testi", "20 Mayıs – 15 Temmuz göreli NDVI, Eylül–Ekim'e göre ≥ 0,06 aşağıda (z ≥ 2) olmalı; toparlanmışsa derin budama değil.", "ÇAYKUR budama bedelinin dayanağı o yılın ürün kaybıdır (%70 tazminat): yaz başında tam örtüye dönmüş bahçede tazminata esas derin budama yoktur."],
    ["8 Toplum kalibrasyonu", "Mahalledeki bahçe birimi optik z'lerinin sağlam ortanca/IQR'ı ampirik sıfır hipotezi; 'kesin' ≥ 1,5 σ, 'olası' ≥ 0,5 σ ayrışmalı; kütle içindeki zayıf sinyaller 'budama yok'.", "En fazla 1/7 budandığından kütle budanmamıştır (Efron'un ampirik sıfır yaklaşımı); en iyi tarih seçimi ve otokorelasyon z'yi N(0,1)'in üstüne şişirir."],
    ["9 Radar", "Optik boşluğu > 20 gün ise radar (geri saçılım ya da koherans) aynı fikirde olmalı; yaz teyidi varsa bu şart aranmaz. Radar yalnız anlamlı yükselişle veto eder.", "0,1 ha bahçede S1 geri saçılımı tek başına taşıyıcı değildir (MODCiX 2026); koherans bare-stem fazında yükselir."],
    ["10 Tarama taklidi", "15 Ekim → 15 Temmuz her 2 günde yalnız o güne kadarki veriyle karar; ilk 'olası' ve ilk 'kesin' tarihleri raporlanır.", "Operasyonel gecikmeyi dürüstçe gösterir (kalıcılık için ≥ 25 gün + 2 gözlem gerekir)."],
], [24 * mm, 70 * mm, W - 94 * mm]))

s.append(Spacer(1, 6))
s.append(p("4. Çataldere 2025-26 sonucu", H1))
s.append(table(["Sınıf", "v2 (Nisan sonu)", "v2.1 (yaz dahil)", "v2.1 açıklama"], [
    ["Budandı (kesin)", "6", "9", "Hepsi yaz testi ✓, ham NDVI düşüşü 0,12–0,36, toplum z ≥ 1,7; 6'sı yalnız optik, 2'si radar teyitli, 1'i optik+radar ortak"],
    ["Olası budama", "58", "6", "Güçlü sinyal, bir koşul eksik (mahalleden yeterince ayrışmıyor, ham NDVI sınırda) → eksper"],
    ["Belirsiz", "143", "107", "43 yazın toparlanan kış adımı (hafif budama/kar hasarı), 56 zayıf sinyal, 3 kademeli kayıp, 3 geçici, 2 diğer"],
    ["Budama yok", "137", "222", "115'i toplum kalibrasyonuyla (mahalle geneliyle aynı davranış)"],
    ["Eksper kuyruğu", "87", "14", "Yalnız gerçek belirsizlikler"],
    ["Müstahsil", "—", "7 tam, 6 kısmen, 7 belirsiz, 109 görülmedi, 7 ruhsatsız", "Alım: 5 otomatik açık, 13 bekliyor, 109 budama yok, 3 eksper"],
], [30 * mm, 24 * mm, 28 * mm, W - 82 * mm]))
s.append(Spacer(1, 4))
s.append(p("Gözlem tabanı: 145 optik tarih (75 S2, 35 L8, 35 L9; 74'ü elendi — 4 kar/gölge çöküşü, 70 seyrek kapsama), Sentinel-1 γ0 58 + 54 tarih, HyP3 koherans 70 + 32 çift. "
           "Bahçe başına temiz optik gözlem ortancası 34, optik boşluk ortancası 13 gün; en büyük engel 22 Aralık – 15 Şubat arasındaki 55 günlük kar/bulut boşluğu."))
s.append(p("Örnek (DEMO-B-0089 yaması, 1.068 m²): ham NDVI Eylül–Aralık 0,80–0,86 → Şubat sonundan itibaren 0,33–0,47; mahalle ortancası aynı dönemde 0,76–0,84. "
           "Göreli basamak 0,36 (optik z 13,0, toplum z 4,4), yaz başında komşulara göre −0,15. Kesim 55 günlük boşluğa düştüğü için radar teyidi arandı; yaz teyidi bu şartı kaldırdı → 'Budandı'."))

s.append(p("5. Bilimsel dayanaklar", H1))
s.append(table(["Kaynak", "Modüle katkısı"], [
    ["MODCiX karşılaştırması (2026), Avrupa çayır biçme tespiti", "Optik tabanlı değişim tespitinde F1 0,55–0,74; S1+S2 birleşimi tek başına optikten güvenilir biçimde iyi değil; ≥16 temiz gözlem şartı. → Optik taşıyıcı, radar teyit; gözlem yoğunluğu önceliği."],
    ["Lobert vd. 2021 (Remote Sens. Environ.), Komisarenko vd. 2022", "Sentinel-2/-1 zaman serisinde biçme olaylarının basamak tespiti; belirsiz bölge (reject region) kavramı → 'olası/belirsiz' sınıfları."],
    ["Sen4CAP L4B (ESA) biçme/budama işaretleme", "Operasyonel CAP denetimlerinde optik+SAR zaman serisi ile faaliyet kanıtı; parsel düzeyi karar ve eksper kuyruğu mantığı."],
    ["Mullissa vd. 2021 (Remote Sensing 13:1954)", "Sentinel-1 ARD: arazi düzleştirme (hacim modeli γ0) ve çoklu bakış; dağlık Of'ta eğim etkisini kaldırır."],
    ["ASF HyP3 Burst InSAR ürün kılavuzu", "Ücretsiz koherans (5×1 bakış, 20 m, _corr.tif); bitki örtüsü kalkınca koherans yükselir."],
    ["Agronomy 2024 (14/12/2986) çay haritalama; SPIE 13666 (Assam, BFAST)", "Çayda budama NDVI işareti ve ani–kademeli ayrımı için BFAST tipi değişim analizi."],
    ["Efron 2004, büyük ölçekli çıkarsamada ampirik sıfır", "Binlerce eşzamanlı testte teorik N(0,1) yanlıştır; sıfır dağılımı verinin kütlesinden tahmin edilir → toplum kalibrasyonu."],
    ["ÇAYKUR 2022 Budama Genelgesi; Özcan & Yıldız 2025 (RTEÜ); 2026 budama bedeli açıklaması", "20 cm kesim, 1/5→1/7→1/10 oranı (parametre), %70 tazminat; 177.731 üretici, 70.612 da, 2,595 milyar TL → yaz testinin ekonomik gerekçesi."],
], [60 * mm, W - 60 * mm]))

s.append(p("6. Doğruluk: ne iddia ediyoruz, ne etmiyoruz", H1))
s.extend(bullets([
    "<b>Henüz saha etiketi yok.</b> Bütün eşikler fizik ve literatürden gelen ön tahminlerdir; sitedeki 'kalibre edilmedi' etiketi bilinçlidir. 15 sentetik senaryonun tamamı beklenen sınıfa düşer; bu, modelin iç tutarlılığını kanıtlar, saha doğruluğunu değil.",
    "<b>'Kesin' sınıfı yüksek kesinlik (precision) için tasarlandı:</b> bir bahçenin 'budandı' sayılması için yedi bağımsız koşulun hepsi sağlanmalıdır. Çataldere'de yaz testi, güçlü optik sinyalli 184 bahçenin 162'sini eledi — bunlar v2'de 'olası' sayılan ama yaz başında tam örtüye dönen kış düşüşleridir.",
    "<b>Duyarlılık (recall) maliyeti bilinçlidir:</b> kısmi/küçük kesimler 'olası' ya da 'belirsiz'de kalabilir; bunlar eksper kuyruğuna gider, otomatik ödemeye gitmez. ÇAYKUR kayıtları geldiğinde calibrate-fusion ile eşikler etiketten öğrenilir (≥15 pozitif + 15 negatif).",
    "<b>Gözlem sınırı:</b> Karadeniz kışında 55 günlük boşluk kaçınılmaz; değişim tarihi bu boşluğa düşen bahçelerde yalnız 'ne zaman' belirsizdir, 'olup olmadığı' yazın kesinleşir.",
    "<b>Ölçek sınırı:</b> 10 m piksel; 100 m² altı yamalar görülmez. Yamalar için koherans henüz hesaplanmıyor (yalnız bahçe geometrileri).",
    "<b>Yorumlama:</b> Karar, ÇAYKUR'un 'bedel ödemeye esas derin budama' sorusunu hedefler; hafif budama ve kar hasarı ayrı türler olarak etiketlenir, cezalandırıcı bir hüküm değildir.",
]))

s.append(p("7. Açık işler", H1))
s.extend(bullets([
    "Diğer 12 Of mahallesi v2 çıktısı taşıyor; v2.1 ile yeniden koşulacak (mahalle başına ~15 dk çekim, HyP3 için burst listesi).",
    "ÇAYKUR budama takvimi ve 1/7–1/10 oranının resmî teyidi (parametre olarak hazır).",
    "Saha etiketi kampanyası (docs/calibration-protocol.md) ve eşik kalibrasyonu.",
    "Yamalar için HyP3 koherans; 50 cm optik örneklem (satın alma askıda).",
]))
s.append(Spacer(1, 6))
s.append(p("Kaynak kodu: cay-envanter (motor, commit b0069ca) ve cayhesabim feat/tea-inventory (site, commit ee2ec4f). Tüm demo müstahsil/ruhsat verileri DEMO etiketlidir; uydu gözlemleri gerçektir.", SM))

doc = SimpleDocTemplate(str(OUT), pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                        title="Budama Takibi Modülü v2.1 — Teknik Rapor", author="Çay Envanteri")
doc.build(s)
print(OUT)
