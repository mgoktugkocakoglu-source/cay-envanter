/*
 * Live tracking of the running season: the pixel scan on the images that have arrived so far, the combined verdict
 * in live mode (only the pixel scan speaks; the multi-sensor verdict joins after the season), the retrospective
 * check and the site bundle. Run it again whenever new Sentinel-2 images are in; every step overwrites its output.
 *
 *   node scripts/live-season.mjs --province Trabzon --district Of --neighborhood Çataldere [--season 2026] [--no-export]
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { province: { type: "string" }, district: { type: "string" }, neighborhood: { type: "string" }, season: { type: "string" }, "no-export": { type: "boolean", default: false } } });
if (!values.province || !values.district || !values.neighborhood) throw new Error("--province --district --neighborhood gerekli");
// The season that is running today: it starts on 1 July.
const now = new Date();
const season = values.season ?? String(now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);
const where = ["--province", values.province, "--district", values.district, "--neighborhood", values.neighborhood];
const run = (script, extra = []) => execFileSync("node", [script, ...where, ...extra], { stdio: "inherit" });

run("src/cli/scan-pixels.ts", ["--season", season]);
// False-alarm estimate of the interim scan (mirrored series), kept beside the season file.
run("src/cli/scan-pixels.ts", ["--season", season, "--mirror", "--tag", "cv-mirror"]);
run("src/cli/combine-pruning.ts", ["--season", season]);
run("src/cli/check-pruning-history.ts");
if (!values["no-export"]) run("src/cli/export-site.ts");
