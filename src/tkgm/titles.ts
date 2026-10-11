/**
 * Deed-title ("nitelik") helpers. A plain /çay/ test is wrong: "Çayır" (meadow) contains it.
 */
const TEA_IN_TITLE = /çay(?!ır)/i;

/** True when the title mentions tea: "Çay Bahçesi", "Ahşap Ev Ve Çay Bahçesi", "Çaylık" — not "Çayır". */
export function isTeaTitle(nature: string): boolean {
    return TEA_IN_TITLE.test(nature.toLocaleLowerCase('tr'));
}
