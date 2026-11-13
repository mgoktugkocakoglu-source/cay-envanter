/**
 * Field notes: a list kept by people who know the parcels (ada, parsel, deed title as they read it, area, note).
 * File: licence-audit/field-notes.csv — `ada;parsel;nitelik;alan_m2;arazi_notu` with a header line.
 *
 * Only what a note says outright is taken as an observation: "çay var" / "çay bahçesi seyrek" (tea on the ground),
 * "ev var" (a building), "kaçak" (tea without a licence). An empty note is not read as "nothing there": the row then
 * carries no observation and the satellite reading stands on its own.
 */
export interface FieldNote {
    block: string;
    parcel: string;
    /** Deed title as written in the list (a shortened form of the TKGM title), for cross-checking only. */
    nature: string;
    areaM2: number | null;
    note: string;
    /** Tea seen on the ground; null when the note does not speak of tea. */
    tea: boolean | null;
    /** Tea is there but sparse ("seyrek"). */
    sparse: boolean;
    building: boolean | null;
    /** The note calls the tea unlicensed ("kaçak"). */
    unlicensed: boolean;
}

export function parseFieldNotes(csv: string): FieldNote[] {
    const out: FieldNote[] = [];
    for (const line of csv.split(/\r?\n/).slice(1)) {
        const [block, parcel, nature, areaText, ...rest] = line.split(';').map((s) => s.trim());
        if (!block || !parcel) continue;
        const note = rest.join(';').trim();
        const t = note.toLocaleLowerCase('tr');
        const speaksOfTea = /çay/.test(t);
        out.push({
            block,
            parcel,
            nature: nature ?? '',
            areaM2: areaText && Number.isFinite(Number(areaText)) ? Number(areaText) : null,
            note,
            tea: speaksOfTea ? !/çay(\s+bahçesi)?\s+yok/.test(t) : null,
            sparse: /seyrek/.test(t),
            building: /\bev\b/.test(t) ? !/ev\s+yok/.test(t) : null,
            unlicensed: /kaçak|ruhsatsız/.test(t),
        });
    }
    return out;
}
