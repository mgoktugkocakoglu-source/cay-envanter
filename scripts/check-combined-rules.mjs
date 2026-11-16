import assert from 'node:assert/strict';
import { combine } from '../src/cli/combine-pruning.ts';
import { repeatedCellArea } from '../src/pruning/repeated-ground.ts';
// Isolated rule fixtures only: never written into the observation library or site bundle.
function fixture(pixel = 'deep', repeat = false, previous = new Map(), dates = ['2026-02-02', '2026-02-10']) {
 const fusion = {gardens:[{id:'rule-fixture',producerId:'producer',areaM2:1000,licensedAreaM2:700,unit:'garden',unitAreaM2:1000,repeat:null,verdict:{class:'pruned',kind:'deep_pruning',changeDate:'2026-02-05',lastBeforeAt:'2026-02-01',firstAfterAt:'2026-02-10'}}],producers:[{id:'producer',licensedAreaM2:700,requiredM2:100}]};
 const px = [{id:'rule-fixture',verdict:pixel,best:{date:dates[1],lastBefore:dates[0],score:5},prunedM2:200,prunedLowM2:100,prunedUpperM2:300,mainCluster:0,clusters:[{kind:pixel,confidence:'high'}],px:[[10,20,100,null,null,2,0,0],[20,20,100,null,null,2,0,0]]}];
 const before=JSON.stringify([fusion,px]);const result=combine(fusion,px,null,()=>({drop:.2,prevStep:0,repeat}),false,previous);assert.equal(JSON.stringify([fusion,px]),before);return result;
}
assert.equal(fixture().gardens[0].class,'confirmed');
assert.equal(fixture().gardens[0].countedM2,100);
assert.equal(fixture('light').gardens[0].kind,'light');assert.equal(fixture('light').gardens[0].countedM2,0);
assert.equal(fixture('pending').gardens[0].kind,null);assert.equal(fixture('pending').gardens[0].countedM2,0);
assert.equal(fixture('deep',true).gardens[0].class,'seasonal');assert.equal(fixture('light',true).gardens[0].class,'seasonal');
assert.equal(fixture('deep',null).gardens[0].class,'probable');
assert.equal(fixture('deep',false,new Map(),['2026-02-15','2026-02-20']).gardens[0].agreement,'both_other_dates');
assert.equal(fixture('deep',false,new Map([['rule-fixture',new Set(['10_20'])]])).gardens[0].countedM2,0);
assert.equal(fixture('deep',false,new Map([['other-garden',new Set(['10_20'])]])).gardens[0].countedM2,100);
assert.equal(repeatedCellArea([[1,2,50],[1,2,50]],new Set(['1_2'])),50);
assert.equal(repeatedCellArea([[1,2,50]],new Set()),0);
assert.equal(fixture('pending').producers[0].countedM2,0);
assert.equal(fixture().producers[0].confirmedM2,100);
console.log('16 pruning rule assertions passed, plus immutable-input checks. Not a field accuracy estimate.');
