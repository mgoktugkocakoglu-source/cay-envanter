# AGENTS.md

Guidance for coding agents working in this repository. Product text is Turkish; code, identifiers and comments are English.

## What this is

`cay-envanter` is the analysis engine of the ÇAYKUR tea-garden platform: it harvests cadastral parcels (TKGM), reads
satellite and drone imagery, and writes one JSON bundle per neighbourhood. The site lives in a sibling checkout,
`../cayhesabim` (NestJS API + Vue web, branch `feat/tea-inventory`), and only displays what this engine exports.
Pilot neighbourhood: Trabzon / Of / Çataldere (`trabzon-of-cataldere`).

## Layout

- `src/cli/*.ts` — one command per module (see `package.json` scripts). Node ≥ 22.18 runs TypeScript directly; no build step.
- `src/<module>/` — `model.ts` (rules and types), `bundle.ts` (loader for the site bundle).
- `py/*.py` — image work (drone SfM, georeferencing, radar). Run with `.venv/Scripts/python.exe`. Do not `pip install` without asking.
- `data/` — gitignored working data: `data/library/<province>/<district>/<neighbourhood>/` (per-module outputs),
  `data/drone/<project>/`, `data/site/` (exported bundles and imagery). It exists only on this machine.
- `secrets/` — gitignored. Never print, copy or commit its contents.
- `scripts/sync-site.mjs` — copies bundles and imagery into `../cayhesabim`.

## Engine → site flow

After any engine change that affects output:

```bash
npm run export-site -- --province Trabzon --district Of --neighborhood Çataldere
node scripts/sync-site.mjs --only trabzon-of-cataldere
# in ../cayhesabim/apps/api
npx nest build        # the API reads its own copy of the seed data from dist
# then restart the API: SEED_DEMO=true node dist/main.js
```

A sync without `nest build` and a restart imports nothing. `npm run typecheck` checks the engine.

Licensing chain, in order: `audit-licensing` → (drone) `py/drone_sfm.py` → `py/drone_georef.py` → `py/drone_parcels.py`
→ `<project>/review.json` → `verify-drone` → `check-compliance` → `export-site`.

- `py/drone_sfm.py` takes ~90 minutes on CPU and wipes `<project>/sfm`; do not rerun it without need.
- After a georeferencing change rerun `py/drone_parcels.py` (~15 minutes); the set of visible parcels may change, and
  `data/drone/<project>/work/make_review.py` must then be updated before it will write `review.json`.
- `verify-drone` publishes the video orthophoto only with `--ortho`. It is off on purpose: built from oblique video it
  shows seams and leaning roofs, and the owner asked for it to be removed until a planned nadir flight exists.

## Rules that are not negotiable

- **Preliminary assessment only.** No module produces an administrative decision. A finding suggests a field check.
- **DEMO records stay labelled.** Licence and producer registers are demo data until ÇAYKUR supplies the real lists;
  every output that rests on them says so.
- **Never fabricate evidence.** No invented detections, no made-up accuracy figures, no super-resolved or sharpened
  evidence imagery. Sentinel-2 is shown as 10 m, video frames at their own resolution.
- **A finding needs evidence that can carry it**: two records that contradict each other, a clear satellite reading, or
  an observation a person verified. Anything weaker goes to review. Unverified image readings stay `verified: false`.
- **TKGM daily quota is never bypassed.** Use the parcel library on disk; do not add retries or parallel requests.
- **Modules stay separate.** A new module reads other modules' outputs and writes its own; it does not change theirs.
- **Nothing is pushed or deployed unless the owner asks.** Commit locally. Do not run `vercel --prod`. In
  `../cayhesabim`, do not merge to `main` of the shared remote.
- No purchases, no paid services, no new accounts.

## What the product is for, and how rules may change

The owner sells this to ÇAYKUR as a tool that **decides as many gardens and parcels as the evidence allows**. Two
outcomes count as success on a screen: "the two pruning methods agree" (combined class `confirmed`, shown as *uyumlu*)
and "the sources agree" (compliance `agreed`). The owner wants these numbers **as high as measurement supports**; a
change that shrinks them is a regression unless a measurement shows it removed false alarms.

Caution is already built in (review classes, DEMO labels, "preliminary assessment"). Adding more of it by tightening
a detection rule is not neutral: on 15–16 Nov 2026 a tightening of the combined pruning rule cut agreed gardens from
10 to 1 in 2025-26 and removed no false alarm (0 before, 0 after on the mirrored series); it was withdrawn.

Rules for any agent:

- **Do not change a detection or promotion rule, a threshold, or what counts as agreement / conflict on reasoning
  alone.** Measure it. Pruning: `node scripts/combined-validate.mjs … --season <y>` (mirrored series = false alarms,
  shared simulated cuts = detection). NDVI screening: `node scripts/ndvi-threshold-check.mjs` in `cayhesabim/apps/api`.
  Compliance certainty: report the class counts before and after.
- A rule change goes in **only with the before/after numbers in the commit message**, and only if it keeps or raises
  the agreed counts, or lowers measured false alarms. Otherwise leave the rule and tell the owner what you found.
- **Never drop a validation, history or accuracy output because rules changed. Regenerate it** with the new rules in
  the same change. A module without its measured numbers is worse than the old rule.
- **A DEMO register is not evidence.** It may not create conflicts, findings of disagreement, or block agreement.
- Weak notes (area gap from 10 m pixels, open building footprints, deed-area gap) stay in their own rule; they do not
  turn a parcel into a conflict.
- Presentation work (maps, exports, wording, layout) is welcome and needs none of this. Do not rename result classes or
  hide result cards the owner already uses without being asked.
- When unsure whether something is a rule change, ask the owner before touching it.

## Two agents work on this code

Claude Code and Codex both work in this checkout and in `../cayhesabim`, at different times, for the same owner.
Neither sees the other's conversation; the repositories are the only shared state.

- Before starting, run `git status` and `git log --oneline -10` in both checkouts and read what changed since your last commit.
- Uncommitted changes you did not make belong to the other agent or the owner: leave them, do not revert, stash or reformat them. Ask the owner if they block you.
- Commit your own work in small commits with a message that says what the change does, so the other agent can follow it.
- Do not rewrite history (no amend of others' commits, no rebase, no force push).
- When you change how something is run or a standing rule, update this file in the same commit.
- Long-running local services (database, API, Vite) may have been started by the other agent: check the port before starting a second copy.

## Conventions

- 4-space indent, single quotes, trailing commas; match the surrounding file.
- Rules live as named constants with a comment saying why the value is what it is (`AUDIT_RULES`, `COMPLIANCE_RULES_CONFIG`, `RULES` in the Python steps).
- Comments state what the code does or why; no history of changes.
- Files are CRLF on this machine; keep line endings when patching.
- Console output on Windows is cp1254: avoid non-Latin-1 symbols (arrows etc.) in Python `print`.

## The site checkout

`../cayhesabim/CLAUDE.md` holds that repository's rules (English-only code, `@/` alias, thin controllers, DTOs,
`{ data, meta }` pagination, shadcn-vue kit, ≥ 44 px touch targets, no test runner, TypeORM `synchronize: true`).
Use `corepack pnpm@8.15.0 --filter <pkg> …` there,
`npx vue-tsc --noEmit` in `apps/web` for the web type-check. Local database: `node start-db.mjs` in `../lokal`.
The API reads test credentials from `apps/api/.env`; never echo them.

## Compliance certainty

`check-compliance` adds `certainty` / `certaintyReason` per parcel (`src/compliance/model.ts`, `classifyCertainty`);
`overall` and `checks` are untouched. Sources are satellite, drone and field observation. Satellite is clear with
≥ 3 whole pixels, no extrapolation beyond training, and presence share/probability ≥ 0.6 or absence share < 0.05.
Low-confidence, partial, uncertain and unusable automatic drone readings are not clear.

- `agreed` ("Kaynaklar uyumlu"): at least two sources say the same and match the deed title (and the licence register
  when it is the real one).
- `single_source`: one clear source that does not contradict the title.
- `conflict`: sources read the ground differently, a clear reading contradicts the title, tea on public land (K5),
  or — only with a real register — the register contradicts them.
- `undecidable`: no clear source.

A DEMO register is never compared (it made 155 of 542 parcels "conflict"); K6, K7 and K9 review notes neither make a
conflict nor block agreement. Çataldere, 16 Nov 2026: agreed 64, single source 181, conflict 40, undecidable 257
(was 33 / 93 / 155 / 261). Rerun `check-compliance` before export.

## Open items

- Real ÇAYKUR licence and producer lists (everything licence-based is DEMO).
- Compliance rule set (`src/compliance/model.ts`, K1–K10) is a draft; its legal basis is not yet matched with ÇAYKUR.
- Drone readings are unverified; no systematic field validation exists for any module.
- Drone video 0–128 s and 340–409 s are not processed.
- Land cover: hazelnut vs tea confusion needs field labels; the licence audit still uses its own detector (src/audit/tea-evidence.ts), not this module.

## Remote-only licensing workflow

No new field-verification workflow is planned. Use existing satellite observations and drone imagery; planned mapping flights may supply better evidence later. Historical field notes remain source records, not a required workflow. `npm run remote-evidence-coverage -- --province Trabzon --district Of --neighborhood Çataldere` inventories only local imagery and monthly series into `remote-evidence/coverage.json`; it does not change classifications or any site bundle.

## Existing relative terrain export

export-site adds remoteTerrain from existing drone project out/ortho.json and its published height PNG. It does not run reconstruction or enable the oblique-video orthophoto. Missing local height data yields null. Heights remain relative and georeferencing residuals are not independent accuracy. Follow the usual export, sync, build and restart flow.

## Combined pruning (v4)

`combine-pruning` reads the cached fusion and pixel-scan outputs and changes neither. The promotion rule is
`promote()` in `src/cli/combine-pruning.ts`; `scripts/combined-validate.mjs` imports the same function, so the measured
rule and the applied rule cannot drift apart.

- `confirmed` (*uyumlu*): both modules positive on the same event (change dates within 45 days). Nothing else is required.
- `probable`: one module, or both on different dates. `light`: pixel-only cut that recovered quickly; not credited.
- `seasonal`: a would-be `probable` whose step repeats a year earlier on the same pixels. Applied to `probable` only.
- A pixel-only cut whose recovery cannot be watched yet (running season) stays `probable` without credited area.
- Credited area = pixel cluster area, minus fusion reuse and minus cells already credited to the same garden in the
  preceding seven seasons (`src/pruning/repeated-ground.ts`), never subtracted twice.

Measured on the mirrored series (false alarms) against the real run: 2023-24 confirmed 4 real / 3 mirrored (a noisy
season: few Sentinel-2 dates), 2024-25 6 / 1, 2025-26 10 / 0. Stricter variants were measured on 16 Nov 2026
(pixel verdict not light, fusion `pruned` only, `pruned`+`deep_pruning`+deep pixel, extra repeat test): none removed a
mirrored false alarm that the plain rule keeps, all removed real agreement.

Order after any change: `combined-validate` for each finished season → `combine-pruning` for every season in
chronological order → `npm run pruning-history` → `export-site`. A validation file is shown only when its
`rulesVersion` equals `COMBINED_RULES.version`; history only when it is newer than every season file.
`node scripts/check-combined-rules.mjs` checks rule logic (21 fixtures); it is not an accuracy measurement.


## Land-cover module (tea or not, and what else grows there)

Separate module; reads the parcel library and Earth Engine, writes only `<neighbourhood>/land-cover/`. No TKGM requests.

```bash
npm run sample-cover -- --province Trabzon --district Of --neighborhood Çataldere   # EE: samples.csv (labelled pixels, district pool) + pixels.csv (every pixel of the target parcels); ~30 min
.venv/Scripts/python.exe py/cover_experiments.py data/library/trabzon/of/cataldere   # compares feature families and learners (~15 min); add --detail to redo only the chosen model's detail
.venv/Scripts/python.exe py/cover_classify.py data/library/trabzon/of/cataldere      # cover.json: per parcel tea reading + cover shares + model card
```

`export-site` ships `cover.json` as the `landCover` block. The service account may not export tables, so rows come back
through `reduceColumns(toList)` with numeric properties only (`rowsOf` in `src/cli/sample-cover.ts`).

Labels: tea / hazelnut / forest from clean deed titles (pixels 3 m inside the parcel); grass / crop / built / other from
ESA WorldCover, never inside tea-titled parcels. 63 bands (`src/cover/features.ts`): seasonal Sentinel-2 composites, NDVI
percentiles and monthly climatology, evergreen ratio, Sentinel-1 for four seasons plus its spread. No terrain, no position.
Measured by grouped 5-fold cross-validation (a parcel is never in train and test). Çataldere, 17 Nov 2026, 8 529 pixels:

| features (learner) | tea-vs-rest accuracy | tea recall | tea precision | tea F1 |
|---|---|---|---|---|
| all 63 bands (boosting) — **used** | 86.5 % | 85.9 % | 78.0 % | 0.815 ± 0.053 |
| optical 47 (boosting) | 85.1 % | 85.0 % | 76.1 % | 0.800 |
| all 63 (random forest) | 84.4 % | 75.2 % | 79.4 % | 0.770 |
| NDVI only, 20 bands (RF) | 83.0 % | 73.6 % | 77.2 % | 0.750 |
| top-10 optical (RF) | 82.0 % | 71.7 % | 76.0 % | 0.734 |
| radar only, 16 bands (RF) | 71.7 % | 50.9 % | 62.1 % | 0.555 |

Parcel level (held-out titled parcels with ≥ 3 pixels, "present" = tea share ≥ 0.3): 284 of 300 tea parcels found
(94.7 %), precision 90.7 %; but 24 of 38 hazelnut-titled and 5 of 21 forest-titled parcels read as tea. That is the weak
spot: either the model cannot split hazelnut from tea, or those titles are outdated. Only field labels can tell.
Differences between the optical variants are inside the fold spread; radar alone is clearly worse, radar added to
optical gains about one point. The choice of features, learner and share bands follows these numbers: change them only
with a new run of the experiments and the table above updated.

### Land cover without any reference, and marked areas

`py/cover_groups.py <neighbourhood dir>` (after `sample-cover`, before `cover_classify`) groups every parcel pixel by its
monthly NDVI curve and a few reflectances (k-means, 8 clusters, no radar: uncorrected backscatter follows the slope
here) and names each group from its own average curve with fixed physical rules (`RULES` in the script): evergreen
(tea candidate), evergreen in winter shadow, semi-evergreen, deciduous, sparse, built, bare. No title, no map, no trained
model. It gives no accuracy figure and cannot split tea from other evergreens; its naming thresholds are uncalibrated.
`cover_classify` merges it into `cover.json` (`unsupervised`, per parcel `group` / `groupShares`). Çataldere: of the 396
parcels the trained model reads as tea, 230 are also evergreen-dominant here; these two-method parcels are the firmest.

Marked areas are the real reference. The owner draws areas on the site ("İşaretleme" card, table `cover_labels`) and
downloads them as GeoJSON; saved as `<neighbourhood>/land-cover/field-labels.geojson` they are sampled by
`sample-cover` (`--only field` does only that, a few minutes) into `field-samples.csv`. Then `cover_experiments.py`
(`--detail` is enough) reports `fieldValidation`: the title-trained model scored on the marked pixels, and the model
with marked areas added to training (weight `fieldWeight`) scored area against area. `cover_classify.py` trains the
final model with them. Never write test or invented areas into `field-labels.geojson`: it is the owner's ground truth.
