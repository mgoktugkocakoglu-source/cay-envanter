/** Whole overlapping cells are conservatively excluded: subpixel cut locations are unknown. */
export function repeatedCellArea(current: Array<[number, number, number]>, previous: Set<string>): number {
    const seen = new Set<string>();
    return current.reduce((sum, [e, n, area]) => {
        const key = `${e}_${n}`;
        if (seen.has(key)) return sum;
        seen.add(key);
        return sum + (previous.has(key) ? Math.max(0, area) : 0);
    }, 0);
}
