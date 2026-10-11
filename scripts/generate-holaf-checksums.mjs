#!/usr/bin/env node
/**
 * Switchy — régénère public/vendor/holaf/holaf-checksums.json.
 *
 * À LANCER APRÈS tout `holaf install` / `holaf upgrade` des briques, puis :
 *   1. `node scripts/extract-holaf-css.mjs`   (si modal/toast ont bougé) ;
 *   2. `node scripts/check-holaf-vendor.mjs`  (doit passer).
 *
 * Le CLI holaf n'existe pas sur GitHub : ce fichier d'empreintes est le pin
 * qui permet à la CI de détecter toute dérive des .js vendorisés.
 *
 * Node pur, aucun réseau : tout est lu depuis public/vendor/holaf/.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CHECKSUMS_FILE,
  MANIFEST_FILE,
  PINNED_BRICKS,
  VENDOR_DIR,
  brickFile,
  sha256,
} from "./holaf-vendor-lib.mjs";

const manifest = JSON.parse(await readFile(MANIFEST_FILE, "utf8"));

const bricks = {};
const problems = [];

for (const brick of PINNED_BRICKS) {
  const version = manifest[brick];
  if (typeof version !== "string" || !version) {
    problems.push(`« ${brick} » absent de ${MANIFEST_FILE} (installer la brique via le CLI holaf).`);
    continue;
  }
  const file = brickFile(brick);
  let text;
  try {
    text = await readFile(join(VENDOR_DIR, file), "utf8");
  } catch {
    problems.push(`« ${file} » introuvable (installer la brique via le CLI holaf).`);
    continue;
  }
  bricks[brick] = { file, version, sha256: sha256(text) };
  console.log(`  ${brick} ${version} — ${file} sha256 ${bricks[brick].sha256.slice(0, 12)}…`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error("ÉCHEC — empreintes NON régénérées.");
  process.exit(1);
}

const payload = {
  $comment:
    "GÉNÉRÉ par scripts/generate-holaf-checksums.mjs — empreintes pinnées des briques holaf-lib vendorisées (ne pas éditer à la main).",
  bricks,
};

await writeFile(CHECKSUMS_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(`OK — ${Object.keys(bricks).length} briques épinglées dans ${CHECKSUMS_FILE}.`);
