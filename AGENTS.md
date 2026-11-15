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
The `AGENTS.md` in its root is an unrelated n8n prompt; ignore it. Use `corepack pnpm@8.15.0 --filter <pkg> …` there,
`npx vue-tsc --noEmit` in `apps/web` for the web type-check. Local database: `node start-db.mjs` in `../lokal`.
The API reads test credentials from `apps/api/.env`; never echo them.

## Open items

- Real ÇAYKUR licence and producer lists (everything licence-based is DEMO).
- Compliance rule set (`src/compliance/model.ts`, K1–K10) is a draft; its legal basis is not yet matched with ÇAYKUR.
- Drone readings are unverified; no systematic field validation exists for any module.
- Drone video 0–128 s and 340–409 s are not processed.
- Proposed next: field verification loop, work queue with assignments, per-parcel PDF record.
