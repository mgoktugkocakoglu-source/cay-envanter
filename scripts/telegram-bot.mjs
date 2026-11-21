// Telegram bot for the local Çataldere work: parcel readings, images already on disk, single-parcel queries.
//
//   node scripts/telegram-bot.mjs
//
// Runs on this machine with long polling: no public address, no dependency. It answers only while it is running.
// Configuration lives in secrets/telegram-bot.json (gitignored):
//   { "token": "<from @BotFather>", "allowedChatIds": [123456789] }
// Chats outside allowedChatIds get nothing but their own chat id, so the owner can add it to the file.
// The bot only reads module outputs; /sorgula is the one command that runs the engine (one TKGM query per missing
// parcel, the daily quota is left to cover-parcel). Every reading is a preliminary assessment.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AREA = { province: 'Trabzon', district: 'Of', neighborhood: 'Çataldere', library: 'data/library/trabzon/of/cataldere', site: 'trabzon-of-cataldere' };
const COVER = path.join(ROOT, AREA.library, 'land-cover', 'cover.json');
const IMAGERY = path.join(ROOT, 'data', 'site', 'imagery', AREA.site);
const CONFIG_PATH = path.join(ROOT, 'secrets', 'telegram-bot.json');
const MAX_PHOTOS = 6;
const PARCEL = /^\d+\/\d+$/;

if (!existsSync(CONFIG_PATH)) {
    console.error('secrets/telegram-bot.json yok. Icerik: { "token": "...", "allowedChatIds": [] }');
    process.exit(1);
}
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const allowed = new Set((config.allowedChatIds ?? []).map(String));
const api = (method) => `https://api.telegram.org/bot${config.token}/${method}`;

async function call(method, body) {
    const res = await fetch(api(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    if (!json.ok) throw new Error(`${method}: ${json.description}`);
    return json.result;
}

const say = (chat, text) => call('sendMessage', { chat_id: chat, text: text.slice(0, 4000) });

async function sendPhoto(chat, file, caption) {
    const form = new FormData();
    form.set('chat_id', String(chat));
    if (caption) form.set('caption', caption);
    form.set('photo', new Blob([readFileSync(file)]), path.basename(file));
    const json = await (await fetch(api('sendPhoto'), { method: 'POST', body: form })).json();
    if (!json.ok) throw new Error(`sendPhoto: ${json.description}`);
}

const cover = () => JSON.parse(readFileSync(COVER, 'utf8'));
const pct = (v) => (v == null ? '-' : `%${Math.round(v * 100)}`);
const TEA = { present: 'çay var', partial: 'kısmen çay', absent: 'çay yok', not_assessable: 'değerlendirilemez (çok küçük)' };
const CONFIDENCE = { high: 'yüksek', medium: 'orta', low: 'düşük' };
const FLAGS = {
    tea_under_canopy: 'ağaç haritası ağaç gösteriyor: ağaç altı çay olabilir',
    evergreen_open_not_tea: 'açık ve her dem yeşil ama model çay okumadı',
    rule_disagrees: 'fiziksel kural çay göstermiyor',
    high_altitude_rule: 'yüksek rakım kuralıyla çay sayıldı',
};

function parcelText(p) {
    const lines = [`${p.block}/${p.parcel} · ${p.nature} · ${p.areaM2} m²`, `Okuma: ${TEA[p.tea]}`];
    if (p.tea !== 'not_assessable') {
        lines.push(
            `Çay payı ${pct(p.teaShare)} (yaklaşık ${Math.round(p.teaShare * p.areaM2)} m²), güven ${CONFIDENCE[p.confidence]}`,
            `Ağaç ${pct(p.shares.trees)}, açık alan ${pct(p.shares.open)}, yapı/çıplak ${pct(p.shares.built)}`,
            `Rakım ${p.elevationM} m, ${p.pixels} piksel, kış yeşilliği ${pct(p.evidence.winterRatio)}, ağaç altı pay ${pct(p.evidence.tallShare)}`,
        );
        for (const f of p.flags) lines.push(`Not: ${FLAGS[f] ?? f}`);
        if (p.pixels < 6) lines.push('Not: parsel çok küçük, okuma güvenilir değil.');
        if (p.elevationM >= 800) lines.push('Not: 800 m üstünde yöntem daha zayıf.');
    }
    lines.push('Ön değerlendirmedir.');
    return lines.join('\n');
}

function summaryText() {
    const c = cover();
    const s = c.summary;
    const u = c.model.used;
    const lines = [
        `${AREA.neighborhood} · arazi tespiti (${c.generatedAt.slice(0, 10)})`,
        `Parsel ${s.parcels}: çay var ${s.byTea.present}, kısmen ${s.byTea.partial}, çay yok ${s.byTea.absent}, değerlendirilemez ${s.byTea.not_assessable}`,
        `Tahmini çay alanı ${Math.round(s.teaAreaM2 / 1000) / 10} ha`,
    ];
    if (u) lines.push(`Sınama (${c.model.reference.parcels} parsel): çay ${u.teaFound}/${u.teaTotal}, çaysız ${u.noTeaRight}/${u.noTeaTotal}, dengeli ${pct(u.balanced)}`);
    for (const b of c.model.byElevation ?? []) lines.push(`${b.band}: çay ${b.teaFound}/${b.teaParcels}`);
    lines.push('Sınama seti küçüktür ve tek mahalledendir. Ön değerlendirmedir.');
    return lines.join('\n');
}

const HELP = [
    'Komutlar:',
    '/ozet  mahalle özeti ve sınama sayıları',
    '/parsel 252/30  parselin kayıtlı okuması',
    '/sorgula 252/30  kayıtta olmayan parseli TKGM’den alıp okur (yaklaşık 10-15 dk)',
    '/harita 252/30  parsel sınırı çizilmiş hava görüntüsü',
    '/drone 106/1  parselin drone kareleri',
    '/sezon 2025-26  sezonun uydu görüntüleri',
    '/ekran  arazi tespiti ekran görüntüleri',
    '/claude <istek>  Claude’a salt okunur soru (CLI kuruluysa)',
].join('\n');

let busy = false;

function run(command, args, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd: ROOT, windowsHide: true });
        let out = '';
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('error', (e) => { clearTimeout(timer); resolve({ code: 1, out: String(e) }); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
}

async function queryParcel(chat, id) {
    if (busy) return say(chat, 'Başka bir sorgu sürüyor; bitince yeniden deneyin.');
    busy = true;
    try {
        await say(chat, `${id} sorgulanıyor. Kayıtta yoksa TKGM’den bir sorgu yapılır; sonuç yaklaşık 10-15 dakikada gelir.`);
        const fetched = await run(process.execPath, ['src/cli/cover-parcel.ts', '--province', AREA.province, '--district', AREA.district, '--neighborhood', AREA.neighborhood, '--parcels', id], 20 * 60_000);
        if (fetched.code !== 0) return say(chat, `Sorgu tamamlanamadı:\n${fetched.out.slice(-600)}`);
        const classified = await run(path.join(ROOT, '.venv', 'Scripts', 'python.exe'), ['py/cover_classify.py', AREA.library], 30 * 60_000);
        if (classified.code !== 0) return say(chat, `Okuma tamamlanamadı:\n${classified.out.slice(-600)}`);
        const p = find(id);
        return say(chat, p ? parcelText(p) : `${id} okunamadı (TKGM’de bulunamamış olabilir).`);
    } finally {
        busy = false;
    }
}

const find = (id) => cover().parcels.find((p) => `${p.block}/${p.parcel}` === id);

async function photos(chat, files, label) {
    if (!files.length) return say(chat, `${label}: görüntü yok.`);
    for (const f of files.slice(0, MAX_PHOTOS)) await sendPhoto(chat, f, path.basename(f));
    if (files.length > MAX_PHOTOS) await say(chat, `${files.length} görüntüden ilk ${MAX_PHOTOS} tanesi gönderildi.`);
}

const hasClaude = () => spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude']).status === 0;

async function askClaude(chat, prompt) {
    if (!prompt) return say(chat, 'Kullanım: /claude <istek>');
    if (!hasClaude()) return say(chat, 'Bu bilgisayarda Claude Code komut satırı kurulu değil; kurulunca bu komut çalışır.');
    if (busy) return say(chat, 'Başka bir iş sürüyor; bitince yeniden deneyin.');
    busy = true;
    try {
        await say(chat, 'Claude’a iletildi (salt okunur).');
        // Read-only on purpose: a chat message must not be able to change files or run commands on this machine.
        const res = await run(process.platform === 'win32' ? 'claude.cmd' : 'claude', ['-p', prompt, '--allowedTools', 'Read,Grep,Glob', '--permission-mode', 'plan'], 15 * 60_000);
        return say(chat, res.out.trim() || 'Yanıt boş döndü.');
    } finally {
        busy = false;
    }
}

async function handle(message) {
    const chat = message.chat.id;
    const text = (message.text ?? '').trim();
    if (!allowed.has(String(chat))) return say(chat, `Bu sohbet yetkili değil. Sohbet numaranız: ${chat}`);
    const [command, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (command.toLowerCase().replace(/@.*$/, '')) {
        case '/start': case '/yardim': case '/help':
            return say(chat, HELP);
        case '/ozet':
            return say(chat, summaryText());
        case '/parsel': {
            if (!PARCEL.test(arg)) return say(chat, 'Kullanım: /parsel 252/30');
            const p = find(arg);
            return say(chat, p ? parcelText(p) : `${arg} kayıtta yok. TKGM’den almak için: /sorgula ${arg}`);
        }
        case '/sorgula':
            if (!PARCEL.test(arg)) return say(chat, 'Kullanım: /sorgula 252/30');
            return queryParcel(chat, arg);
        case '/harita': {
            if (!PARCEL.test(arg)) return say(chat, 'Kullanım: /harita 252/30');
            if (!find(arg)) return say(chat, `${arg} kayıtta yok. Önce: /sorgula ${arg}`);
            const out = path.join(os.tmpdir(), `parsel-${arg.replace('/', '-')}-${Date.now()}.jpg`);
            const res = await run(path.join(ROOT, '.venv', 'Scripts', 'python.exe'), ['py/parcel_map.py', AREA.library, arg, out], 120_000);
            if (res.code !== 0 || !existsSync(out)) return say(chat, `Harita üretilemedi:
${res.out.slice(-400)}`);
            try {
                // The basemap is context only: its date is unknown, so it is not a reading of today's cover.
                return await sendPhoto(chat, out, `${arg} · sarı çizgi TKGM parsel sınırı. Altlık görüntünün tarihi bilinmiyor; güncel durumu göstermeyebilir.`);
            } finally {
                rmSync(out, { force: true });
            }
        }
        case '/drone': {
            if (!PARCEL.test(arg)) return say(chat, 'Kullanım: /drone 106/1');
            const dir = path.join(IMAGERY, 'drone');
            const prefix = arg.replace('/', '-') + '-';
            const files = existsSync(dir) ? readdirSync(dir).flatMap((project) => readdirSync(path.join(dir, project)).filter((f) => f.startsWith(prefix) && f.endsWith('-frame.jpg')).map((f) => path.join(dir, project, f))) : [];
            return photos(chat, files, `${arg} drone kareleri`);
        }
        case '/sezon': {
            if (!/^\d{4}-\d{2}$/.test(arg)) return say(chat, 'Kullanım: /sezon 2025-26');
            const files = existsSync(IMAGERY) ? readdirSync(IMAGERY).filter((f) => f.startsWith(arg + '-')).map((f) => path.join(IMAGERY, f)) : [];
            return photos(chat, files, `${arg} sezonu`);
        }
        case '/ekran': {
            const docs = path.join(ROOT, 'docs');
            return photos(chat, readdirSync(docs).filter((f) => /^arazi-ortusu-ekran-.*\.png$/.test(f)).map((f) => path.join(docs, f)), 'Ekran görüntüleri');
        }
        case '/claude':
            return askClaude(chat, arg);
        default:
            return say(chat, HELP);
    }
}

let offset = 0;
console.log('Telegram botu calisiyor. Durdurmak icin Ctrl+C.');
for (;;) {
    try {
        const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
        for (const u of updates) {
            offset = u.update_id + 1;
            if (u.message) handle(u.message).catch((e) => say(u.message.chat.id, `Hata: ${e.message}`).catch(() => {}));
        }
    } catch (e) {
        console.error(String(e.message ?? e));
        await new Promise((r) => setTimeout(r, 5000));
    }
}
