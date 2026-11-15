import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { AuditFile } from './audit-licensing.ts';
import { buildCompliance, COMPLIANCE_RULES } from '../compliance/model.ts';
import type { DroneVerificationFile } from '../drone/model.ts';
import { NeighborhoodStore } from '../library/store.ts';

const USAGE = `
Kullanım:
  npm run check-compliance -- --province Trabzon --district Of --neighborhood Çataldere

Kural tabanlı ruhsat uygunluk raporu (ruhsatlandırma altında ayrı modül; diğer modüllerin çıktısına dokunmaz):
  girdi : licence-audit/audit.json (audit-licensing) + varsa drone/verification.json (verify-drone)
  çıktı : compliance/report.json  — parsel başına her kuralın sonucu (uygun · aykırı · inceleme · kanıt yok) ve dayandığı kanıt
Kural seti taslaktır; sonuç ön değerlendirmedir, idari karar üretmez.
`;

function main(): void {
    const { values } = parseArgs({ options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' } } });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const auditPath = join(store.dir, 'licence-audit', 'audit.json');
    if (!existsSync(auditPath)) throw new Error('licence-audit/audit.json yok; önce audit-licensing çalıştırın.');
    const audit = JSON.parse(readFileSync(auditPath, 'utf8')) as AuditFile;
    const dronePath = join(store.dir, 'drone', 'verification.json');
    const drone = existsSync(dronePath) ? (JSON.parse(readFileSync(dronePath, 'utf8')) as DroneVerificationFile) : null;
    const file = buildCompliance(audit, drone);
    const outDir = join(store.dir, 'compliance');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'report.json'), JSON.stringify(file));

    const o = file.summary.byOverall;
    for (const [certainty, stats] of Object.entries(file.summary.byCertainty)) {
        console.log(`Kesinlik ${certainty}: ${stats.parcels} parsel, ${stats.areaM2.toFixed(2)} m2 (ön değerlendirme; ruhsat: ${file.licenceSource})`);
    }
    console.log(`Parsel: ${file.summary.parcels} · ruhsat kaydı: ${file.licenceSource === 'demo' ? 'DEMO' : 'ÇAYKUR'} · drone okuması olan: ${file.sources.droneParcels}`);
    console.log(`Uygun ${o.conforming} · aykırılık bulgusu ${o.finding} · inceleme ${o.review} · kanıt yok ${o.no_evidence} · kapsam dışı ${o.out_of_scope}`);
    for (const r of COMPLIANCE_RULES) {
        const c = file.summary.byRule[r.id];
        if (c) console.log(`  ${r.id.padEnd(3)} ${r.title.padEnd(48)} uygun ${String(c.pass).padStart(3)} · aykırı ${String(c.fail).padStart(3)} · inceleme ${String(c.review).padStart(3)} · kanıt yok ${String(c.unknown).padStart(3)} · uygulanmaz ${String(c.na).padStart(3)}`);
    }
    console.log(`Çıktı: ${join(outDir, 'report.json')}`);
}

main();
