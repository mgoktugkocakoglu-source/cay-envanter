import type { CropKey } from './model.ts';

/**
 * Crop requirement rules, each threshold tied to its source id (see sources.ts). A factor scores 100 inside
 * [lo1, hi1], falls linearly to 0 at lo0 / hi0, and the crop score is the lowest factor (Liebig's law of the
 * minimum, as in FAO land-suitability practice). Values missing for a parcel score neutral (60).
 */
export type FactorKey =
    | 'elevation' | 'slope' | 'ph' | 'precip' | 'tmean' | 'tminAbs' | 'tmaxAbs' | 'frostDays' | 'hotDays' | 'julyMean'
    | 'rhSummer' | 'chillHours' | 'frostFreeDays' | 'springFrostDays' | 'bloomRainDays' | 'drainage' | 'erosion' | 'lime';

export interface FactorRule {
    key: FactorKey;
    label: string;
    unit: string;
    digits: number;
    /** [lo0, lo1, hi1, hi0]; use -Infinity / Infinity for open ends. */
    band: [number, number, number, number];
    sources: string[];
    note: string;
}

export interface LegalRule {
    label: string;
    sources: string[];
    /** Evaluated against the parcel: returns true (meets), false (fails) or null (not applicable). */
    kind: 'hazelnut-planting-zone' | 'tea-licence';
}

export interface CropRule {
    key: CropKey;
    label: string;
    /** Why this crop is on the list for the Black Sea tea belt. */
    rationale: string;
    factors: FactorRule[];
    legal: LegalRule[];
    sources: string[];
}

const INF = Infinity;

export const CROP_RULES: CropRule[] = [
    {
        key: 'tea',
        label: 'Çay',
        rationale: 'Bölgenin ana ürünü; ruhsata bağlı. Çay Araştırma Enstitüsü / üniversite ders notları ve Rize Çayı coğrafi işaret kaydındaki ekolojik istekler.',
        factors: [
            { key: 'tmean', label: 'Yıllık ortalama sıcaklık', unit: ' °C', digits: 1, band: [8, 13, 23, 30], sources: ['au-cay-ders', 'rize-cayi-ci'], note: 'Ders notunda 14 °C ve üstü ideal; Rize çay kuşağı (≤750 m) lapse ile ≈10 °C’ye kadar iner.' },
            { key: 'tminAbs', label: 'En düşük sıcaklık (son yıllar)', unit: ' °C', digits: 1, band: [-15, -8, INF, INF], sources: ['au-cay-ders'], note: '−15 °C bitkiyi dondurur; −5 °C altına sık inmemeli.' },
            { key: 'precip', label: 'Yıllık yağış', unit: ' mm', digits: 0, band: [900, 1200, 4500, 6000], sources: ['au-cay-ders', 'rize-cayi-ci'], note: 'En az 1200–1500 mm, düzenli ve yavaş yağış.' },
            { key: 'ph', label: 'Toprak pH', unit: '', digits: 1, band: [3.6, 4.5, 6.0, 7.0], sources: ['au-cay-ders', 'rize-ph-tez'], note: 'pH 4,5–6; kireç <%5. Rize çay toprakları çoğunlukla 3,5–5,0.' },
            { key: 'elevation', label: 'Yükselti', unit: ' m', digits: 0, band: [-INF, -INF, 750, 1100], sources: ['rize-cayi-ci'], note: 'Rize’de çay kuşağı kıyıdan ≈750 m’ye kadar.' },
            { key: 'slope', label: 'Eğim', unit: ' %', digits: 0, band: [-INF, -INF, 35, 60], sources: ['usda-akk', 'omu-rize-erozyon'], note: 'Dik yamaçlarda teras/örtü ile sürdürülebilir; %60 üstü uygun değil.' },
            { key: 'frostDays', label: 'Don günü / yıl', unit: '', digits: 0, band: [-INF, -INF, 60, 130], sources: ['au-cay-ders'], note: 'Kar ve kısa süreli don tolere edilir.' },
            { key: 'erosion', label: 'Erozyon riski', unit: '', digits: 0, band: [0, 70, INF, INF], sources: ['cem-atlas-2018'], note: 'Yüksek riskte koruma önlemi gerekir.' },
            { key: 'drainage', label: 'Taşkın / drenaj', unit: '', digits: 0, band: [0, 100, INF, INF], sources: ['merit-hydro'], note: 'Dere kenarı, düşük HAND.' },
        ],
        legal: [{ label: 'Çay tarımı ruhsata bağlıdır; ruhsat alanı dışında yaş çay desteği ödenmez.', sources: ['karar-6243', 'tzob-cay'], kind: 'tea-licence' }],
        sources: ['au-cay-ders', 'rize-cayi-ci', 'rize-ph-tez', 'tepge-cay-2025'],
    },
    {
        key: 'hazelnut',
        label: 'Fındık',
        rationale: 'Trabzon’un ikinci ürünü; 2844 sayılı Kanun dikim alanını sınırlar. Üniversite ders notu ve Akçakoca Sarı Fındığı coğrafi işaret kaydındaki eşikler.',
        factors: [
            { key: 'tmean', label: 'Yıllık ortalama sıcaklık', unit: ' °C', digits: 1, band: [10, 13, 16, 20], sources: ['au-findik-ders', 'giresun-findik-iklim'], note: '13–16 °C.' },
            { key: 'tminAbs', label: 'En düşük sıcaklık (son yıllar)', unit: ' °C', digits: 1, band: [-14, -10, INF, INF], sources: ['au-findik-ders', 'akcakoca-findik-ci'], note: 'Kış −8/−10 °C altına inmemeli.' },
            { key: 'tmaxAbs', label: 'En yüksek sıcaklık', unit: ' °C', digits: 1, band: [-INF, -INF, 36, 40], sources: ['akcakoca-findik-ci'], note: '36–37 °C aşılmamalı.' },
            { key: 'precip', label: 'Yıllık yağış', unit: ' mm', digits: 0, band: [500, 750, 3500, 5000], sources: ['au-findik-ders', 'akcakoca-findik-ci'], note: '>700–750 mm ve dengeli dağılım.' },
            { key: 'rhSummer', label: 'Haziran–Temmuz nemi', unit: ' %', digits: 0, band: [40, 60, INF, INF], sources: ['akcakoca-findik-ci'], note: '%60 altı ürünü olumsuz etkiler.' },
            { key: 'ph', label: 'Toprak pH', unit: '', digits: 1, band: [4.5, 6.0, 6.5, 8.0], sources: ['au-findik-ders'], note: 'Hafif asit 6–6,5; daha asitte kireçleme.' },
            { key: 'elevation', label: 'Yükselti', unit: ' m', digits: 0, band: [-INF, -INF, 700, 1000], sources: ['kastamonu-findik-yukselti', 'kanun-2844'], note: 'Doğu Karadeniz’de 0–700 m kuşağı; yasal sınır 750 m.' },
            { key: 'slope', label: 'Eğim', unit: ' %', digits: 0, band: [-INF, -INF, 30, 50], sources: ['usda-akk'], note: '' },
            { key: 'erosion', label: 'Erozyon riski', unit: '', digits: 0, band: [0, 70, INF, INF], sources: ['cem-atlas-2018'], note: '' },
        ],
        legal: [{ label: 'Fındık dikim alanı: rakım ≤ 750 m ve eğim ≥ %12 (1. ve 2. sınıf tarım arazileri hariç).', sources: ['kanun-2844'], kind: 'hazelnut-planting-zone' }],
        sources: ['au-findik-ders', 'akcakoca-findik-ci', 'kanun-2844', 'kastamonu-findik-yukselti'],
    },
    {
        key: 'kiwi',
        label: 'Kivi',
        rationale: 'Doğu Karadeniz kıyı kuşağı kivi için uygun bölge (Yalova BKAE); TAGEM Alata broşürü eşikleri.',
        factors: [
            { key: 'tmean', label: 'Yıllık ortalama sıcaklık', unit: ' °C', digits: 1, band: [9, 12, 16, 22], sources: ['tagem-kivi-2022'], note: '12–16 °C.' },
            { key: 'tminAbs', label: 'En düşük sıcaklık (son yıllar)', unit: ' °C', digits: 1, band: [-13, -9, INF, INF], sources: ['tagem-kivi-2022'], note: 'Kışın −6…−10 °C zarar; verim yaşında −13 °C’ye dayanır.' },
            { key: 'frostFreeDays', label: 'Donsuz dönem', unit: ' gün', digits: 0, band: [200, 240, INF, INF], sources: ['tagem-kivi-2022'], note: '240–260 gün donsuz gelişme süresi.' },
            { key: 'springFrostDays', label: 'İlkbahar geç donu (15 Mar–30 Nis)', unit: ' gün', digits: 0, band: [-INF, -INF, 4, 15], sources: ['tagem-kivi-2022'], note: 'Geç donlar sürgün ve çiçek gözlerini vurur (−0,5 °C).' },
            { key: 'chillHours', label: 'Soğuklama (<7,2 °C)', unit: ' saat', digits: 0, band: [250, 400, 2000, 3000], sources: ['tagem-kivi-2022'], note: '400–600 saat.' },
            { key: 'rhSummer', label: 'Yaz nemi', unit: ' %', digits: 0, band: [35, 50, 85, 100], sources: ['tagem-kivi-2022', 'yalova-kivi'], note: '%50–70 ideal; Doğu Karadeniz kıyı kuşağının yüksek nemi uygulamada sorun yaratmaz.' },
            { key: 'ph', label: 'Toprak pH', unit: '', digits: 1, band: [4.8, 5.5, 7.0, 7.6], sources: ['tagem-kivi-2022'], note: '5,5–7,0; kireç ≤%8.' },
            { key: 'drainage', label: 'Taşkın / taban suyu', unit: '', digits: 0, band: [0, 100, INF, INF], sources: ['tagem-kivi-2022'], note: 'Taban suyu yüksek ve ağır topraklar uygun değil.' },
            { key: 'slope', label: 'Eğim', unit: ' %', digits: 0, band: [-INF, -INF, 8, 15], sources: ['tagem-kivi-2022'], note: 'Telli terbiye sistemi düz/az eğimli arazi ister.' },
            { key: 'elevation', label: 'Yükselti', unit: ' m', digits: 0, band: [-INF, -INF, 400, 700], sources: ['yalova-kivi'], note: 'Kıyı kuşağı.' },
        ],
        legal: [],
        sources: ['tagem-kivi-2022', 'yalova-kivi'],
    },
    {
        key: 'chestnut',
        label: 'Kestane (bal / kereste)',
        rationale: 'Mevcut orman örtüsünün parçası; kestane balı için çiçeklenme döneminde kuru hava belirleyici (coğrafi işaret kayıtları).',
        factors: [
            { key: 'elevation', label: 'Yükselti', unit: ' m', digits: 0, band: [50, 300, 1000, 1400], sources: ['kestane-yukselti', 'rize-cayi-ci'], note: 'Karadeniz’de kıyıdan ≈1000 m’ye kadar; 300–1000 m kuşağı.' },
            { key: 'precip', label: 'Yıllık yağış', unit: ' mm', digits: 0, band: [500, 700, 3500, 5000], sources: ['euforgen-castanea'], note: '>600 mm, kurak mevsim kısa.' },
            { key: 'ph', label: 'Toprak pH', unit: '', digits: 1, band: [3.8, 4.5, 6.5, 7.5], sources: ['euforgen-castanea'], note: 'Kireçli toprak sevmez.' },
            { key: 'drainage', label: 'Drenaj', unit: '', digits: 0, band: [0, 100, INF, INF], sources: ['euforgen-castanea'], note: 'İyi drene toprak.' },
            { key: 'slope', label: 'Eğim', unit: ' %', digits: 0, band: [-INF, -INF, 45, 70], sources: ['usda-akk'], note: 'Yamaçlarda doğal yayılış.' },
            { key: 'bloomRainDays', label: 'Çiçeklenmede yağışlı gün (1 Haz–15 Tem)', unit: ' gün', digits: 0, band: [-INF, -INF, 24, 42], sources: ['duzce-kestane-bali-ci'], note: 'Çiçek yağmura hassas; az yağış = çok bal. Doğu Karadeniz’de 45 günlük pencerede 25–28 yağışlı gün olağandır; bal verimi için yıl bazında iklim görünümüne bakılır.' },
        ],
        legal: [],
        sources: ['kestane-yukselti', 'euforgen-castanea', 'duzce-kestane-bali-ci', 'ayder-bali-ci'],
    },
    {
        key: 'blueberry',
        label: 'Yaban mersini (maviyemiş)',
        rationale: 'Asit topraklı Doğu Karadeniz yüksek kesimleri KTAE’nin 1. iklim tipi; dönüşüm ürünü olarak öne çıkıyor.',
        factors: [
            { key: 'ph', label: 'Toprak pH', unit: '', digits: 1, band: [3.4, 4.0, 5.5, 6.3], sources: ['ktae-maviyemis-2025'], note: 'Düşük pH’lı, organik maddece zengin kumlu-tınlı toprak.' },
            { key: 'chillHours', label: 'Soğuklama (<7,2 °C)', unit: ' saat', digits: 0, band: [400, 600, INF, INF], sources: ['ktae-maviyemis-2025'], note: 'Yüksek boylu çeşitler >600–1000 saat.' },
            { key: 'frostFreeDays', label: 'Donsuz dönem', unit: ' gün', digits: 0, band: [110, 130, 260, 320], sources: ['ktae-maviyemis-2025'], note: '130–200 gün.' },
            { key: 'hotDays', label: '30 °C üstü gün / yıl', unit: '', digits: 0, band: [-INF, -INF, 10, 40], sources: ['ktae-maviyemis-2025'], note: 'Yaz sıcaklıkları genellikle 30 °C altı.' },
            { key: 'drainage', label: 'Drenaj', unit: '', digits: 0, band: [0, 100, INF, INF], sources: ['ktae-maviyemis-2025'], note: 'Kökler su altında kalmamalı.' },
            { key: 'slope', label: 'Eğim', unit: ' %', digits: 0, band: [-INF, -INF, 15, 30], sources: ['usda-akk'], note: '' },
            { key: 'elevation', label: 'Yükselti', unit: ' m', digits: 0, band: [-INF, -INF, 1000, 1400], sources: ['ktae-maviyemis-2025'], note: 'Yüksek rakımlı lokal yerler.' },
        ],
        legal: [],
        sources: ['ktae-maviyemis-2025'],
    },
    {
        key: 'pasture',
        label: 'Mera / yem bitkisi',
        rationale: '5403’te marjinal ve VI–VII. sınıf arazilerin doğal kullanımı; yem bitkileri Of için desteklenen üründür.',
        factors: [
            { key: 'slope', label: 'Eğim', unit: ' %', digits: 0, band: [-INF, -INF, 30, 60], sources: ['usda-akk'], note: '' },
            { key: 'precip', label: 'Yıllık yağış', unit: ' mm', digits: 0, band: [300, 500, 4500, 6000], sources: ['era5-land'], note: '' },
            { key: 'erosion', label: 'Erozyon riski', unit: '', digits: 0, band: [0, 60, INF, INF], sources: ['cem-atlas-2018'], note: 'Otlatma baskısı erozyonu artırır.' },
        ],
        legal: [],
        sources: ['rg-2026-33214', 'karar-6243'],
    },
    {
        key: 'vegetable',
        label: 'Sebze / sera',
        rationale: 'Düz taban arazide yüksek getirili alternatif; sera-örtü altı arazi 5403’te ayrı sınıftır.',
        factors: [
            { key: 'slope', label: 'Eğim', unit: ' %', digits: 0, band: [-INF, -INF, 5, 12], sources: ['usda-akk'], note: '' },
            { key: 'ph', label: 'Toprak pH', unit: '', digits: 1, band: [4.8, 6.0, 7.2, 8.0], sources: ['openlandmap'], note: '' },
            { key: 'drainage', label: 'Taşkın / drenaj', unit: '', digits: 0, band: [0, 100, INF, INF], sources: ['merit-hydro'], note: 'Taşkın alanında sera kurulmaz.' },
            { key: 'julyMean', label: 'Temmuz ortalaması', unit: ' °C', digits: 1, band: [10, 16, 26, 32], sources: ['era5-land'], note: '' },
            { key: 'elevation', label: 'Yükselti', unit: ' m', digits: 0, band: [-INF, -INF, 700, 1200], sources: ['copernicus-dem'], note: '' },
        ],
        legal: [],
        sources: ['rg-2026-33214'],
    },
    {
        key: 'forestry',
        label: 'Ağaçlandırma / koruma',
        rationale: 'VII–VIII. sınıf ve erozyon riski yüksek arazilerde 5403’ün öngördüğü koruma kullanımı.',
        factors: [
            { key: 'slope', label: 'Eğim (yüksek = uygun)', unit: ' %', digits: 0, band: [0, 30, INF, INF], sources: ['usda-akk'], note: '%30 üstü yamaçlar.' },
            { key: 'erosion', label: 'Erozyon riski (yüksek = uygun)', unit: '', digits: 0, band: [0, 70, INF, INF], sources: ['cem-atlas-2018'], note: '' },
        ],
        legal: [],
        sources: ['rg-2026-33214', 'cem-atlas-2018'],
    },
];

export const CROP_RULE_BY_KEY = new Map(CROP_RULES.map((c) => [c.key, c]));
