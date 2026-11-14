import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { AuditFile } from './audit-licensing.ts';
import { buildDroneVerification, type DroneAnalysisFile, type DroneParcelRecord, type DroneReview } from '../drone/model.ts';
import { NeighborhoodStore, slugify } from '../library/store.ts';

const USAGE = `
Kullanım:
  npm run verify-drone -- --project data/drone/cataldere-2024-07

Drone destekli arazi doğrulama (ruhsatlandırma altında ayrı modül; diğer modüllerin çıktısına dokunmaz):
  1. Görüntü analizi :  .venv/Scripts/python.exe py/drone_verify.py <proje>   → <proje>/out/analysis.json + kanıt kareleri
  2. Görsel inceleme :  <proje>/review.json  [{ "parcel": "106/23", "class": "tea_not_found", "observer": "...", "verified": false, "date": "...", "frames": [...], "note": "..." }]
  3. Bu komut        :  analiz + inceleme + kayıt (tapu niteliği, ruhsat, uydu tespiti: licence-audit/audit.json) → drone/verification.json
Sınıflar: çay mevcut · çay bulunamadı · kısmen çay mevcut · belirsiz. Uyuşmazlık yalnız yerinde kontrol önerir; idari karar üretmez.
`;

function main(): void {
    const { values } = parseArgs({ options: { project: { type: 'string' } } });
    if (!values.project) {
        console.log(USAGE);
        process.exit(1);
    }
    const analysisPath = join(values.project, 'out', 'analysis.json');
    if (!existsSync(analysisPath)) throw new Error(`${analysisPath} yok; önce py/drone_verify.py çalıştırın.`);
    const analysis = JSON.parse(readFileSync(analysisPath, 'utf8')) as DroneAnalysisFile;
    const reviewPath = join(values.project, 'review.json');
    const reviews = existsSync(reviewPath) ? (JSON.parse(readFileSync(reviewPath, 'utf8')) as DroneReview[]) : [];
    const { province, district, neighborhood, id } = analysis.project;
    const store = new NeighborhoodStore(province, district, neighborhood);
    const auditPath = join(store.dir, 'licence-audit', 'audit.json');
    if (!existsSync(auditPath)) throw new Error('licence-audit/audit.json yok; önce audit-licensing çalıştırın (kayıt ve uydu bilgisi oradan okunur).');
    const audit = JSON.parse(readFileSync(auditPath, 'utf8')) as AuditFile;
    const records: DroneParcelRecord[] = audit.parcels.map((p) => ({
        key: p.key,
        block: p.block,
        parcel: p.parcel,
        nature: p.nature,
        locality: p.locality,
        areaM2: p.areaM2,
        deedAreaM2: p.deedAreaM2,
        titleTea: p.title.tea,
        licence: p.licence,
        satellite: { tea: p.detection.tea, teaShare: p.detection.teaShare, fullPixels: p.detection.fullPixels },
    }));
    const missing = analysis.parcels.filter((a) => !records.some((r) => `${r.block}/${r.parcel}` === a.parcel)).map((a) => a.parcel);
    if (missing.length) console.log(`Kayıtta bulunamayan parseller atlandı: ${missing.join(', ')} (audit-licensing --parcels ile eklenebilir)`);

    const code = [province, district, neighborhood].map(slugify).join('-');
    const file = buildDroneVerification({ analysis, reviews, records, licenceSource: audit.licenceSource, imageryBaseUrl: `/inventory-imagery/${code}/drone/${id}/`, analysedAt: statSync(analysisPath).mtime.toISOString().slice(0, 10) });
    const outDir = join(store.dir, 'drone');
    const evidenceDir = join(outDir, 'evidence', id);
    mkdirSync(evidenceDir, { recursive: true });
    const images = readdirSync(join(values.project, 'out')).filter((f) => /\.(jpe?g|mp4)$/i.test(f));
    for (const f of images) copyFileSync(join(values.project, 'out', f), join(evidenceDir, f));
    writeFileSync(join(outDir, 'verification.json'), JSON.stringify(file));

    const v = file.validation;
    console.log(`Kaynak: ${file.sources[0]?.title} · ${file.capture.width}×${file.capture.height}, ${file.capture.bitrateMbps} Mb/sn · konum verisi: yok`);
    console.log(`Otomatik sınıflandırıcı (çekim içi çapraz sınama): doğruluk %${Math.round(v.accuracy * 100)} · çay yakalama %${Math.round(v.teaRecall * 100)} · çay kesinliği %${Math.round(v.teaPrecision * 100)} → ${v.usable ? 'kullanılabilir' : 'DENEYSEL (haritayı renklendirmez)'}`);
    for (const p of file.parcels) {
        console.log(`${p.block}/${p.parcel} · kayıt: ${p.nature}, ${p.licence.licensed ? 'ruhsatlı' : 'ruhsatsız'} · video ${p.video.visible[0]}–${p.video.visible[1]} sn · sınıf: ${p.class} (${p.classSource}, güven ${p.confidence}) · otomatik: ${p.automatic.class} (çay payı %${Math.round(p.automatic.teaShareMedian * 100)}) · durum: ${p.status}`);
        if (p.discrepancy) console.log(`  Uyuşmazlık: ${p.discrepancy}`);
        console.log(`  Öneri: ${p.action}`);
    }
    console.log(`Kanıt kareleri ve klip: ${images.length} → ${evidenceDir}`);
    console.log(`Çıktı: ${join(outDir, 'verification.json')}`);
}

main();
