# Devam notu (18.11.2026)

Yeni bir oturumda kaldığımız yerden sürdürmek için. Ayrıntılı kurallar `AGENTS.md` dosyalarındadır; bu not yalnızca
"şu an neredeyiz" bilgisini taşır.

## Yeni oturuma ilk mesaj

> cay-envanter/docs/DEVAM-NOTU.md, iki depodaki AGENTS.md ve cayhesabim/CLAUDE.md dosyalarını oku; iki depoda
> git status ve git log'a bak. Sonra şunu yap: ...

## Durumun yazılı olduğu yerler

- `cay-envanter/AGENTS.md`: motor rehberi, arazi örtüsü v2, tek parsel sorgusu, iki ajan (Claude + Codex) kuralları, ürün hedefi.
- `cayhesabim/AGENTS.md` ve `cayhesabim/CLAUDE.md`: site tarafı.
- `cay-envanter/docs/arazi-ortusu-arastirma-2026-11.md`: arazi tespiti yöntemi ve ölçümler.
- `cay-envanter/docs/budama-ruhsatlama-modulleri-2026-11.pdf`: budama ve ruhsatlama modülleri.
- Claude hafızası (kendiliğinden yüklenir): `C:\Users\msefa\.claude\projects\D--evim-web-sitesi\memory\`.

## Yerelde çalıştırma

1. Veritabanı: `lokal` klasöründe `node start-db.mjs` (port 5433).
2. API: `cayhesabim/apps/api` içinde `npx nest build`, ardından `SEED_DEMO=true node dist/main.js` (port 3000).
3. Web: Claude önizlemesi "cayhesabim-web" (port 5173). Giriş kullanıcı tarafından yapılır.

Bu servisler oturum kapanınca durur.

## Tek parsel sorgusu

```
npm run cover-parcel -- --province Trabzon --district Of --neighborhood Çataldere --parcels "241/2,238/26"
.venv/Scripts/python.exe py/cover_classify.py data/library/trabzon/of/cataldere
```

Eksik her parsel için bir TKGM sorgusu yapılır (günlük kota aşılmaz). Sonuç `land-cover/cover.json` içindedir.
Sahadan bilinen durum `land-cover/field-notes.json` dosyasına yazılır, ardından `py/cover_reference.py` çalıştırılır.

## Tek parsel sınama günlüğü (hepsi 1 130-1 210 m)

| Parsel | Tapu niteliği | Alan m² | Çay payı | Okuma | Saha bilgisi |
|---|---|---|---|---|---|
| 117/10 | - | 81 | - | değerlendirilemez (çok küçük) | yok |
| 252/30 | Ahşap Ev ve Çayır | 3 339 | %49-51 | çay var / kısmen (sınırda) | sahibi: en az %50 çay |
| 244/3 | Çayır | 620 | %37,5 (kural %75) | kısmen; büyük olasılıkla çay | yok |
| 241/6 | 1 Katlı Ahşap Ev ve Çayır | 3 721 | %0 | çay yok, açık alan %78 | yok |
| 241/2 | Çayır | 1 510 | %0 | çay yok; seyrek örtü | yok |
| 238/26 | Ahşap Ev ve Çayır | 5 100 | %0 | çay yok, açık alan %82 | yok |
| 244/1 | Çay Bahçesi | 310 | %0 (4 piksel) | model "ağaç" dedi: KAÇIRILDI | kullanıcı: yaklaşık 300 m² çay |

Dersler: 800 m üstünde kış karı çayı gizler (kar maskeli `evergreen` bandı kullanılır); 800 m üstü referans çay
parsellerinde 7/12 bulunur, altında 60/61. Yüksek kesimde model çıktısından "çay olamaz" denmez. Yalnız yaz
verisiyle (Mayıs-Ağustos) okuma daha kötüdür (%84,4'e karşı %88,6).

244/1 kaçırması: 4 piksel, kış oranı 0,86 (eşik 0,90), ağaç yüksekliği haritası piksellerin yarısını "ağaç" gösteriyor
(komşu ağaçların taşması ya da harita hatası). Küçük parsellerde (yaklaşık 500 m² altı) okuma güvenilmez.

Referans başarımı (244/1 eklendikten sonra): çay 67/74, çaysız 41/48, dengeli %88,0; 800 m üstü çay 7/13. Mahalle toplamı: var 242, kısmen 86, yok 123,
değerlendirilemez 97.

## Açık işler ve kararlar

- Yukarıdaki yedi parsel site paketinde yok; paket yeniden dışa aktarılmadı.
- Kullanıcı bildiği alanları sitede işaretleyecek ("Arazi Tespiti" > işaretleme); sonra
  `sample-cover --only field` ve `cover_classify.py` ile kalibrasyon.
- 244/3, 241/6, 241/2, 238/26 için saha bilgisi beklenir.
- Karar bekleyenler: ruhsat denetimi yeni arazi tespiti okumasına geçsin mi; 3 ha üstü parseller yalnız çerçeve
  olarak mı çizilsin; drone doğrulama "Arazi Tespiti" altına mı alınsın.
- Hiçbir şey push edilmedi; son commit'ler yereldedir.
