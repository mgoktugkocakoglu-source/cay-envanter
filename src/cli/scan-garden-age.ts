import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { initEarthEngine } from '../ee/session.ts';
import { NeighborhoodStore } from '../library/store.ts';
import { landsatYearly, s2Monthly, type LandsatYearlyRaw, type S2MonthlyRaw } from '../age/ee-series.ts';
import { AGE_CLASS_LABEL, AGE_RULES, AGE_SOURCES, evaluateParcelAge, type AbandonClass, type ActivityClass, type AgeClass, type ParcelAge, type PriorityClass } from '../age/model.ts';

type Poly = Polygon | MultiPolygon;

const USAGE = `Bahçe yaşı ve yenileme (ayrı modül): çaylı parseller için Landsat yıllık yaz NDVI (1984→) ile kuruluş yılı,
gençleştirme olayları ve canlılık eğilimi; Sentinel-2 aylık NDVI (2017→) ile hasat etkinliği ve terk belirtisi;
yenileme öncelik puanı.

  npm run garden-age -- --province Trabzon --district Of --neighborhood Çataldere [--from 1984] [--refetch]

Çıktı: age/evaluation.json (ham seriler age/raw-landsat.json, age/raw-s2.json)
`;

interface ParcelProps {
    key: string;
    block: string;
    parcel: string;
    nature: string;
    geometryAreaM2: number;
    teaShare: number | null;
}

export interface AgeEvaluationFile {
    generatedAt: string;
    method: string;
    rules: typeof AGE_RULES;
    sources: typeof AGE_SOURCES;
    summary: {
        parcels: number;
        teaAreaM2: number;
        byAgeClass: Record<AgeClass, number>;
        byActivity: Record<ActivityClass, number>;
        byAbandonment: Record<AbandonClass, number>;
        byPriority: Record<PriorityClass, number>;
        establishmentByDecade: Record<string, number>;
        renewalsByYear: Record<number, number>;
        meanAgeYears: number | null;
        medianEstablishmentYear: number | null;
        highPriorityAreaM2: number;
        likelyAbandonedAreaM2: number;
    };
    parcels: ParcelAge[];
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            province: { type: 'string' },
            district: { type: 'string' },
            neighborhood: { type: 'string' },
            from: { type: 'string', default: '1984' },
            refetch: { type: 'boolean', default: false },
        },
    });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const meta = store.readMeta();
    if (!meta) throw new Error('meta.json yok; önce harvest çalıştırın.');
    const parcelsPath = join(store.dir, 'parcels-tea.geojson');
    const all = existsSync(parcelsPath) ? (JSON.parse(readFileSync(parcelsPath, 'utf8')) as FeatureCollection<Poly, ParcelProps>).features : [];
    // Tea candidates: satellite tea share or a tea deed title.
    const parcels = all.filter((f) => (f.properties.teaShare ?? 0) >= 0.2 || /çay/i.test(f.properties.nature));
    const fromYear = Number(values.from);
    const thisYear = new Date().getFullYear();
    const outDir = join(store.dir, 'age');
    mkdirSync(outDir, { recursive: true });
    console.log(`${meta.neighborhood}: ${parcels.length} çaylı parsel (${all.length} içinden) · Landsat ${fromYear}–${thisYear}, Sentinel-2 2017–${thisYear}`);

    const cached = <T>(name: string, build: () => Promise<T>): Promise<T> => {
        const path = join(outDir, name);
        if (existsSync(path) && !values.refetch) {
            console.log(`  ${name}: önbellekten`);
            return Promise.resolve(JSON.parse(readFileSync(path, 'utf8')) as T);
        }
        return build().then((v) => {
            writeFileSync(path, JSON.stringify(v));
            return v;
        });
    };
    const ee = await initEarthEngine();
    const inputs = parcels.map((f) => ({ key: f.properties.key, geometry: f.geometry }));
    console.log('Landsat yıllık yaz NDVI…');
    const landsat = await cached<LandsatYearlyRaw>('raw-landsat.json', () => landsatYearly(ee, meta.boundary, inputs, fromYear, thisYear, (s) => console.log(s)));
    console.log('Sentinel-2 aylık NDVI…');
    const s2 = await cached<S2MonthlyRaw>('raw-s2.json', () => s2Monthly(ee, meta.boundary, inputs, 2017, thisYear, (s) => console.log(s)));

    const evaluate = (nbhdRecentMedian: number | null): ParcelAge[] =>
        parcels.map((f) => {
            const p = f.properties;
            const ls = landsat.parcels[p.key] ?? { ndvi: landsat.years.map(() => null), obs: landsat.years.map(() => null) };
            return evaluateParcelAge({
                key: p.key,
                block: p.block,
                parcel: p.parcel,
                nature: p.nature,
                areaM2: Math.round(p.geometryAreaM2),
                teaShare: p.teaShare,
                years: landsat.years,
                ndvi: ls.ndvi,
                obs: ls.obs,
                s2Years: s2.years,
                s2Months: s2.months,
                s2: s2.parcels[p.key] ?? {},
                thisYear,
                nbhdRecentMedian,
            });
        });
    // Two passes: the neighbourhood median of recent vigour comes from the first, the peer comparison from the second.
    const firstPass = evaluate(null);
    const recent = firstPass.filter((e) => e.ageClass !== 'not_tea').map((e) => e.vigour.recentMean).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const nbhdRecentMedian = recent.length ? recent[Math.floor(recent.length / 2)]! : null;
    const evaluated = evaluate(nbhdRecentMedian);
    console.log(`  mahalle ortanca canlılık (son 5 yıl NDVI): ${nbhdRecentMedian === null ? '—' : nbhdRecentMedian.toFixed(3)}`);

    const count = <K extends string>(keys: readonly K[], pick: (e: ParcelAge) => K) => Object.fromEntries(keys.map((k) => [k, evaluated.filter((e) => pick(e) === k).length])) as Record<K, number>;
    const establishmentByDecade: Record<string, number> = {};
    const renewalsByYear: Record<number, number> = {};
    for (const e of evaluated) {
        const decade = e.establishment.preRecord ? '1986 öncesi' : e.establishment.year !== null ? `${Math.floor(e.establishment.year / 10) * 10}’ler` : 'belirsiz';
        if (e.ageClass !== 'not_tea') establishmentByDecade[decade] = (establishmentByDecade[decade] ?? 0) + 1;
        for (const r of e.renewals) renewalsByYear[r.year] = (renewalsByYear[r.year] ?? 0) + 1;
    }
    const ages = evaluated.map((e) => e.ageYears).filter((a): a is number => a !== null);
    const estYears = evaluated.map((e) => e.establishment.year).filter((y): y is number => y !== null).sort((a, b) => a - b);
    const summary: AgeEvaluationFile['summary'] = {
        parcels: evaluated.length,
        teaAreaM2: evaluated.filter((e) => e.ageClass !== 'not_tea').reduce((s, e) => s + e.areaM2, 0),
        byAgeClass: count(Object.keys(AGE_CLASS_LABEL) as AgeClass[], (e) => e.ageClass),
        byActivity: count(['harvested', 'low', 'none', 'no_data'] as ActivityClass[], (e) => e.activity.class),
        byAbandonment: count(['active', 'weak', 'likely_abandoned', 'not_tea'] as AbandonClass[], (e) => e.abandonment.class),
        byPriority: count(['high', 'medium', 'low', 'not_applicable'] as PriorityClass[], (e) => e.priority.class),
        establishmentByDecade,
        renewalsByYear,
        meanAgeYears: ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null,
        medianEstablishmentYear: estYears.length ? estYears[Math.floor(estYears.length / 2)]! : null,
        highPriorityAreaM2: evaluated.filter((e) => e.priority.class === 'high').reduce((s, e) => s + e.areaM2, 0),
        likelyAbandonedAreaM2: evaluated.filter((e) => e.abandonment.class === 'likely_abandoned').reduce((s, e) => s + e.areaM2, 0),
    };
    const file: AgeEvaluationFile = {
        generatedAt: new Date().toISOString(),
        method: 'Landsat 5/7/8/9 yıllık yaz NDVI (1984→): kapalı örtünün (NDVI ≥ 0,55) sürekli başladığı ve öncesinde düşük faz (< 0,40) görülen yıl = kuruluş yılı; kayıt başında kapalı örtü = 1986 öncesi tesis; ≥ 0,15 düşüş ve 4 yılda toparlanma = gençleştirme/yenileme; son 12 yıl eğilimi ve zirve döneme göre düşüş = canlılık. Sentinel-2 aylık NDVI (2017→): sezon içi düşüş sayısı ve genlik = hasat etkinliği; etkinlik yok + düşük çay payı + düz yüksek örtü = terk belirtisi. Öncelik: yaş, son gençleştirme, canlılık eğilimi, aktif hasat.',
        rules: AGE_RULES,
        sources: AGE_SOURCES,
        summary,
        parcels: evaluated,
    };
    writeFileSync(join(outDir, 'evaluation.json'), JSON.stringify(file));
    console.log(`Yaş sınıfları: ${JSON.stringify(summary.byAgeClass)} · kuruluş on yılı ${JSON.stringify(establishmentByDecade)}`);
    console.log(`Etkinlik: ${JSON.stringify(summary.byActivity)} · terk ${JSON.stringify(summary.byAbandonment)}`);
    console.log(`Yenileme önceliği: ${JSON.stringify(summary.byPriority)} · yüksek öncelik ${Math.round(summary.highPriorityAreaM2 / 1000)} da · gençleştirme olayı ${Object.values(renewalsByYear).reduce((a, b) => a + b, 0)}`);
    console.log(`Çıktı: ${join(outDir, 'evaluation.json')}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
