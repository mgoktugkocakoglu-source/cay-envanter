/*
 * Rule fixtures of the combined pruning verdict (combine-pruning v4). They catch logic slips, they do not measure
 * accuracy: that is scripts/combined-validate.mjs (mirrored series + shared simulated cuts). Nothing is written.
 *
 *   node scripts/check-combined-rules.mjs
 */
import assert from 'node:assert/strict';
import { combine, promote } from '../src/cli/combine-pruning.ts';
import { repeatedCellArea } from '../src/pruning/repeated-ground.ts';

function fixture({ fusionClass = 'pruned', pixel = 'deep', repeat = false, previous = new Map(), dates = ['2026-02-02', '2026-02-10'] } = {}) {
    const fusion = {
        gardens: [{ id: 'rule-fixture', producerId: 'producer', areaM2: 1000, licensedAreaM2: 700, unit: 'garden', unitAreaM2: 1000, repeat: null, prunedArea: fusionClass === 'not_pruned' ? null : { m2: 180, lowM2: 90, highM2: 260, method: 'ndvi_fraction' }, verdict: { class: fusionClass, kind: fusionClass === 'pruned' ? 'deep_pruning' : null, changeDate: '2026-02-05', lastBeforeAt: '2026-02-01', firstAfterAt: '2026-02-10' } }],
        producers: [{ id: 'producer', licensedAreaM2: 700, requiredM2: 100 }],
    };
    const px = [{ id: 'rule-fixture', verdict: pixel, best: pixel === 'none' ? null : { date: dates[1], lastBefore: dates[0], score: 5 }, prunedM2: 200, prunedLowM2: 100, prunedUpperM2: 300, mainCluster: 0, clusters: [{ kind: pixel, confidence: 'high' }], px: [[10, 20, 100, null, null, 2, 0, 0], [20, 20, 100, null, null, 2, 0, 0]] }];
    const before = JSON.stringify([fusion, px]);
    const result = combine(fusion, px, null, () => ({ drop: 0.2, prevStep: 0, repeat }), false, previous);
    // The module reads the two source outputs and changes neither.
    assert.equal(JSON.stringify([fusion, px]), before);
    return { garden: result.gardens[0], producer: result.producers[0] };
}
let checks = 0;
const eq = (actual, expected, label) => { assert.equal(actual, expected, label); checks++; };

// Both modules on the same event: confirmed, whatever the two modules call the cut, and credited at the cluster area.
eq(fixture().garden.class, 'confirmed', 'pruned + deep');
eq(fixture().garden.countedM2, 200, 'confirmed is credited at the cluster area');
eq(fixture({ fusionClass: 'likely' }).garden.class, 'confirmed', 'likely + deep');
eq(fixture({ pixel: 'light' }).garden.class, 'confirmed', 'pruned + light pixel verdict');
eq(fixture({ fusionClass: 'likely', pixel: 'light' }).garden.class, 'confirmed', 'likely + light');
// The seasonal-pattern test moves only "probable"; agreement of the two modules stands.
eq(fixture({ repeat: true }).garden.class, 'confirmed', 'confirmed is not moved to seasonal');
eq(fixture({ repeat: null }).garden.class, 'confirmed', 'confirmed does not need the repeat test');
// Different dates: both saw something, not the same event.
eq(fixture({ dates: ['2026-05-15', '2026-05-20'] }).garden.agreement, 'both_other_dates', 'dates apart');
eq(fixture({ dates: ['2026-05-15', '2026-05-20'] }).garden.class, 'probable', 'dates apart is probable');
// One module only.
eq(fixture({ pixel: 'none' }).garden.class, 'probable', 'fusion only');
eq(fixture({ pixel: 'none', repeat: true }).garden.class, 'seasonal', 'fusion-only detection that repeats a year earlier');
eq(fixture({ fusionClass: 'not_pruned', pixel: 'deep' }).garden.class, 'probable', 'pixel only, deep');
eq(fixture({ fusionClass: 'not_pruned', pixel: 'light' }).garden.class, 'light', 'pixel only, light');
eq(fixture({ fusionClass: 'not_pruned', pixel: 'light' }).garden.countedM2, 0, 'light is not credited');
eq(fixture({ fusionClass: 'not_pruned', pixel: 'pending' }).garden.countedM2, 0, 'pending recovery is not credited yet');
// Ground already credited in the cycle is not credited again; another garden's cells do not matter.
eq(fixture({ previous: new Map([['rule-fixture', new Set(['10_20'])]]) }).garden.countedM2, 100, 'one of two cells already credited');
eq(fixture({ previous: new Map([['other-garden', new Set(['10_20'])]]) }).garden.countedM2, 200, 'other garden');
eq(repeatedCellArea([[1, 2, 50], [1, 2, 50]], new Set(['1_2'])), 50, 'a cell is counted once');
eq(fixture().producer.status, 'met', 'producer meets the target with confirmed area');
// The shared rule function, as the validation script calls it.
eq(promote(true, '2026-02-05', 'deep', '2026-02-10', '2026-02-02'), 'confirmed', 'promote: same event');
eq(promote(true, '2026-02-05', 'none', null, null), 'probable', 'promote: fusion only');
console.log(`${checks} pruning rule checks passed (logic only; accuracy is measured by scripts/combined-validate.mjs).`);
