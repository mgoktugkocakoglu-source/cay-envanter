# Arazi örtüsü ve çay tespiti: araştırma notu (Kasım 2026)

Bu not, "bir parselde çay var mı" sorusunu uydu verisiyle en yüksek isabetle yanıtlamak için yapılan literatür ve
açık kaynak taramasını, Çataldere'de yapılan ölçümleri ve bunlardan çıkan yöntemi (v2) anlatır. Yöntemin kodu
`py/cover_classify.py`, çalıştırma sırası `AGENTS.md` içindedir.

## 1. Sorunun ne olduğu

İlk yöntem (v1) tapu niteliğini etiket alıyordu: "Çay Bahçesi" yazan parsellerin pikselleri çay, "Orman" ve "Fındık
Bahçesi" yazanlar çay değil. Tapuya karşı çapraz sınamada çay var/yok doğruluğu %86,5 çıkıyordu.

Aynı model, bir kişinin gerçekten baktığı parsellere karşı sınandığında tablo değişti. Sınama seti: drone videosunda
kare kare okunan 108 parsel ve 12 saha gözlemi (toplam 120 parsel; 72 çay, 48 çay yok).

| Yöntem | Çay bulunan | "Çay yok" doğru | Dengeli doğruluk |
|---|---|---|---|
| Tapu etiketi, Sentinel-2 + Sentinel-1 (v1) | 63 / 72 | 8 / 48 | %52 |
| Tapu etiketi + ağaç yüksekliği + Dynamic World + gömme vektörleri | 65 / 72 | 5 / 48 | %50 |

Neden: ağaçla kaplanmış eski çay bahçelerinin tapusunda hâlâ "çay bahçesi" yazıyor. Etiketli 3.000 çay pikselinin
428'inin üzerinde ağaç var. Model ağaç örtüsünü çay diye öğreniyor ve tapuya karşı sınandığında bu hata ödüllendiriliyor.
Girdiye ne eklenirse eklensin sonuç değişmiyor; sorun veride değil, etikette.

Bu, literatürle uyumlu: Pelletier ve ark. (2017, Remote Sensing 9(2):173) etiket gürültüsünün çapraz sınama sonucunu da
bozduğunu gösterir; Akar ve Güngör (2015, IJRS 36(2)) Sürmene'de sınıflandırma sonuçlarını kadastro ile karşılaştırıp
kadastro kayıtlarının güncellenmesi gerektiğini yazar.

## 2. Dünyada ne yapılmış

Kaynakların çoğu özet düzeyinde okundu; tam metni okunanlar belirtilmiştir.

**Çay haritalama.**
- Özen 2020, İTÜ yüksek lisans tezi (Doğu Karadeniz, Sentinel-2): piksel bazlı rastgele orman %74–76, U-Net %94,7.
  Bölgemiz için tek doğrudan emsal; piksel bazlı spektral sınıflandırmanın bu arazide zayıf kaldığını gösterir.
- Zhu ve ark. 2019, Sensors 19(9):2087 (tam metin): dört tarihli Sentinel-2 ile %96; en güçlü öznitelikler arasında
  Aralık NDVI'si ve kış-eksi-yaz NDVI farkı var. Yaprak döken ağaçla karışık çayda yakalama %82'ye düşüyor.
- Xiao ve ark. 2025, Remote Sensing 17(5):908 (tam metin): dağlık arazide 108 öznitelik, %95; çayla en çok karışan
  sınıf orman.
- Peng ve ark. 2024, RSE 303:114016 (MAP-Tea): fenoloji temelli üç gösterge, Çin geneli 10 m harita, %94,9.
- Xia ve ark. 2023, IJRS 44(9): önce "her dem yeşil" maskesi, sonra fenoloji; %87,6.

Ortak nokta: çayı ayıran şey kış yeşilliği ve kış-yaz farkıdır; her çalışmada en çok karışan sınıf ormandır. Hiçbiri
430 m² ortanca parsel büyüklüğüne yakın bir ölçekte çalışmıyor.

**Fındık.** Türkiye'de Beşikdüzü, Piraziz ve Sakarya çalışmaları (%85–99) çay bulunmayan alanlarda ve rastgele piksel
ayrımıyla yapılmış; bizim soruna aktarılamaz. **Çayı fındıktan Sentinel-1/2 ile ayıran yayımlanmış bir çalışma
bulunamadı.**

**Dik arazi.** Sentinel-1 için arazi düzleştirme orman tipinde +2–4 puan, dik yamaçta +16–20 puana kadar kazanç
bildiriyor (Dostálová ve ark. 2022); Sentinel-2 için SCS+C düzeltmesi +3 puan (Teijido-Murias ve ark. 2024).

**Gürültülü etiket.** Etiket temizleme ile +10 puana varan kazançlar bildiriliyor (Hell ve Brandmeier 2024).

**Açık kaynak ve hazır veri.** Çay ya da fındık için hazır bir harita ya da açık kod yok. Earth Engine'de kullanılabilir
katmanlar: Meta / WRI 1 m ağaç yüksekliği, GLAD orman yüksekliği, Google uydu gömme vektörleri (AlphaEarth),
Dynamic World, ESA WorldCover.

## 3. Çataldere'de ölçülenler

**Ağaç yüksekliği katmanları.** Drone'da çay sıraları görülen parsellerde Meta / WRI haritası 0 m, ağaçla kaplı
parsellerde 7–9 m gösteriyor. ETH 10 m haritası açık çay sıralarında 16 m okuyor; kullanılmadı.

**Kış yeşilliği.** Sınama setindeki çay parsellerinde kış NDVI'si yazın %91–99'u; ağaçla kaplı parsellerde %71–74.

**Yöntemlerin karşılaştırması** (aynı 120 parsel; hiçbiri eğitimde kullanılmadı):

| Yöntem | Çay bulunan | "Çay yok" doğru | Dengeli doğruluk | Tartışmalılar hariç |
|---|---|---|---|---|
| Tapu etiketi (v1) | 63 / 72 | 8 / 48 | %52 | — |
| Tapu etiketi, ağaç yüksekliğiyle düzeltilmiş | 66 / 72 | 35 / 48 | %82 | %91 |
| Kural: yalnız kış yeşilliği | 66 / 72 | 37 / 48 | %84 | %93 |
| Kural: yalnız ağaç yüksekliği | 69 / 72 | 30 / 48 | %79 | — |
| Kural: ikisi birlikte | 65 / 72 | 38 / 48 | %85 | %94 |
| Uzlaşı etiketi + gömme vektörleri | 64 / 72 | 37 / 48 | %83 | %89 |
| **Uzlaşı etiketi + Sentinel-2 (v2)** | **65 / 72** | **41 / 48** | **%88** | **%94** |

Güncel sayılar sitedeki "Yöntem ne kadar isabetli" kartında ve `cover.json` içindedir; yukarıdaki tablo araştırma
turundandır ve birkaç parsel oynayabilir.

**Tartışmalı okumalar.** 48 "çay yok" drone okumasının 11'inde hem ağaç yüksekliği hem kış yeşilliği açık ve her dem
yeşil örtü gösteriyor (106/5, 106/7, 106/36, 112/5, 112/13, 112/22, 112/73, 112/84, 119/8, 119/15, 123/15). Bunlar
küçük parseller ya da kontrol binalarından uzak; drone çiziminin birkaç metre kaymış ve komşu ağaçlığın okunmuş olması
olasıdır. Doğrusu yerinde bakılmadan bilinemez; iki sütun da bu yüzden ayrı verilir.

**Duyarlılık.** Uzlaşı eşikleri dokuz farklı bileşimle, üç farklı rastgele tohumla ve yalnız ilçenin diğer
mahallelerinin pikselleriyle eğitilerek yeniden sınandı: dengeli doğruluk %83–90, tartışmalılar hariç %92–95. Sonuç
tek bir eşik seçimine bağlı değil.

**İşe yaramayanlar.**
- Tapu etiketli modele ağaç yüksekliği, Dynamic World ya da gömme vektörü eklemek (%50–52).
- Güvenli öğrenme (confident learning) ile etiket temizleme: 3.956 pikseli attı, sonucu değiştirmedi (%55). Yöntem,
  modelin kendi olasılıklarına dayanıyor; model sistematik olarak yanlış öğrendiği için yanlışı temizleyemiyor.
- Gömme vektörleri tek başına Sentinel-2 özniteliklerinden kötü.
- Sentinel-1 geri saçılımı: düzeltilmemiş haliyle yamaç yönünü öğreniyor; sonuca katkısı yok.

## 4. Yöntem (v2)

1. Her piksel için iki fiziksel ölçüt hesaplanır: 3 m ve üzeri ağaç örtüsünün payı (Meta / WRI, 1 m) ve kış NDVI'sinin
   yaz NDVI'sine oranı (Sentinel-2, 2024–2026).
2. İkisinin açıkça uzlaştığı pikseller etiketlenir: ağaçsız + kışın yeşil + yoğun örtü = çay; ağaç altında = ağaç
   örtüsü; ağaçsız + kışın yeşilliğini kaybeden = açık alan; neredeyse bitkisiz = yapı / çıplak zemin.
3. Bu etiketlerle, girdi olarak yalnız güncel Sentinel-2 özniteliklerini kullanan bir sınıflandırıcı eğitilir ve
   uzlaşmayan pikselleri o okur. Ağaç yüksekliği girdi değildir: harita 2018–2020 görüntülerinden, Sentinel-2 günceldir;
   model aradaki değişimi izleyebilir.
4. Parsel, piksellerinin yarısı ya da fazlası çay ise "çay var" okunur.
5. Sitede işaretlenen kesin alanlar varsa eğitime daha yüksek ağırlıkla katılır ve model ayrıca onlara karşı sınanır.

Sınıflar bilerek dört tanedir: çay, ağaç örtüsü, açık alan, yapı. Fındık ile orman ayrılmaz; ikisi de "ağaç
örtüsü"dür. Eldeki hiçbir kaynak bu ayrımı güvenilir yapmıyor.

## 5. Sınırlar

- Sınama seti küçük (120 parsel), tek mahalleden ve tek uçuştan; drone okumaları doğrulanmamıştır.
- Ağaç yüksekliği haritası birkaç yıl öncesine aittir ve ortalama hatası yaklaşık 3 m'dir.
- Ağaç altındaki çay görülemez; "ağaç örtüsü" okunan bir parselde ağaç altı çay dışlanamaz.
- Diğer her dem yeşil alçak örtüler (defne, orman gülü, bakımlı çit) çayla karışabilir.
- Üç pikselden küçük parseller okunamaz.
- Yöntem başka ilçelerde sınanmadı.

## 6. Bundan sonra neyin kazandıracağı

1. Sitede işaretlenecek kesin alanlar (özellikle fındık bahçeleri ve çaya benzeyen ağaçlıklar): hem gerçek doğruluk
   ölçümü, hem fındığı ayrı bir sınıf yapma imkânı.
2. Sentinel-1 için arazi düzleştirme (Vollrath ve ark. 2020 açısal düzeltmesi; `ESA-PhiLab/radiometric-slope-correction`,
   `adugnag/gee_s1_ard`): radarın yamaç etkisinden arındırılması. Denenmedi.
3. Kış kompozitleri için topoğrafik aydınlatma düzeltmesi (SCS+C) ya da gölge maskesi.
4. Dik bakışlı, planlı drone çekimi: ağaç yüksekliğini güncel ve santimetre düzeyinde verir.
