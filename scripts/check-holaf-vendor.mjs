#!/usr/bin/env node
/**
 * Switchy — garde-fou CI : les briques holaf-lib vendorisées n'ont pas dérivé.
 *
 * Le CLI holaf (qui copie les briques depuis /projects/holaf-lib) n'existe PAS
 * sur GitHub ; ce script — Node pur, HORS RÉSEAU — est l'invariant du dépôt.
 * Exécuté en CI (`npm run check:vendor` ou directement), il vérifie :
 *
 *   1. chaque brique épinglée existe et son SHA-256 correspond au pin de
 *      public/vendor/holaf/holaf-checksums.json (fichier réécrit/modifié,
 *      copie partielle, édition accidentelle : échec) ;
 *   2. les versions de public/vendor/holaf/holaf-manifest.json (écrit par le
 *      CLI) correspondent aux versions épinglées ;
 *   3. aucune brique du manifeste n'est laissée hors des pins, et aucun .js
 *      inconnu ne traîne dans le dossier vendor ;
 *   4. les CSS extraits (holaf-modal.css / holaf-toast.css) sont EXACTEMENT
 *      régénérables depuis les .js vendorisés (getCss()) — détecte un upgrade
 *      de brique sans ré-extraction.
 *
 * Sortie : une ligne ✓ par contrôle ; ✗ + code de sortie 1 à la moindre dérive.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  CHECKSUMS_FILE,
  EXTRACTED_CSS,
  MANIFEST_FILE,
  PINNED_BRICKS,
  VENDOR_DIR,
  brickFile,
  importBrick,
  normalizeCss,
  sha256,
} from "./holaf-vendor-lib.mjs";

const done = [];
const errors = [];
const ok = (message) => done.push(`  ✓ ${message}`);
const fail = (message) => errors.push(`  ✗ ${message}`);

/** Message d'erreur lisible, quelle que soit la valeur jetée. */
const reason = (error) => (error instanceof Error ? error.message : String(error));

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    fail(`${label} illisible (${file}) : ${reason(error)}`);
    return null;
  }
}

const checksums = await readJson(CHECKSUMS_FILE, "holaf-checksums.json");
const manifest = await readJson(MANIFEST_FILE, "holaf-manifest.json");

if (checksums !== null && manifest !== null) {
  const pinned = checksums.bricks;
  const unpinnedFiles = new Set(
    (await readdir(VENDOR_DIR)).filter((name) => name.endsWith(".js")),
  );

  if (pinned === null || typeof pinned !== "object" || Array.isArray(pinned)) {
    fail("holaf-checksums.json : champ « bricks » absent ou invalide.");
  } else {
    // 1. Briques attendues par Switchy : toutes épinglées.
    for (const brick of PINNED_BRICKS) {
      if (!Object.prototype.hasOwnProperty.call(pinned, brick)) {
        fail(`brique « ${brick} » absente des empreintes pinnées.`);
      }
    }

    // 2. Empreintes + versions du manifeste, brique par brique.
    for (const [brick, pin] of Object.entries(pinned)) {
      if (pin === null || typeof pin !== "object") {
        fail(`pin « ${brick} » invalide.`);
        continue;
      }
      const file = typeof pin.file === "string" && pin.file ? pin.file : brickFile(brick);
      let text;
      try {
        text = await readFile(join(VENDOR_DIR, file), "utf8");
      } catch {
        fail(`${file} introuvable (brique « ${brick} »).`);
        continue;
      }
      unpinnedFiles.delete(file);

      const digest = sha256(text);
      if (digest !== pin.sha256) {
        fail(`${file} a dérivé : sha256 ${digest.slice(0, 12)}… ≠ pin ${String(pin.sha256).slice(0, 12)}… (régénérer via scripts/generate-holaf-checksums.mjs).`);
      } else {
        ok(`${brick} ${pin.version} — ${file} conforme (sha256 ${digest.slice(0, 12)}…).`);
      }

      const manifestVersion = manifest[brick];
      if (manifestVersion === undefined) {
        fail(`brique « ${brick} » épinglée mais absente de holaf-manifest.json.`);
      } else if (manifestVersion !== pin.version) {
        fail(`${brick} : holaf-manifest.json dit ${manifestVersion}, l'empreinte pinne ${pin.version} (mettre les deux à jour).`);
      }
    }

    // 3. Aucun .js non épinglé dans le dossier vendor.
    for (const stray of unpinnedFiles) {
      fail(`${stray} : fichier .js non épinglé (le supprimer ou régénérer les empreintes).`);
    }
    for (const brick of Object.keys(manifest)) {
      if (pinned !== null && !Object.prototype.hasOwnProperty.call(pinned, brick)) {
        fail(`brique « ${brick} » du manifeste absente des empreintes pinnées (régénérer via scripts/generate-holaf-checksums.mjs).`);
      }
    }
  }
}

// 4. CSS extraits : régénérables à l'identique depuis les .js vendorisés.
for (const [brick, spec] of Object.entries(EXTRACTED_CSS)) {
  let css;
  try {
    const namespace = await importBrick(brick);
    const api = namespace[spec.export];
    if (!api || typeof api.getCss !== "function") {
      throw new Error(`l'export ${spec.export} n'expose pas getCss()`);
    }
    css = normalizeCss(api.getCss());
  } catch (error) {
    fail(`${spec.file} non régénérable : ${reason(error)}`);
    continue;
  }
  let onDisk;
  try {
    onDisk = await readFile(join(VENDOR_DIR, spec.file), "utf8");
  } catch {
    fail(`${spec.file} introuvable (lancer scripts/extract-holaf-css.mjs).`);
    continue;
  }
  if (normalizeCss(onDisk) !== css) {
    fail(`${spec.file} diffère de ${brickFile(brick)}.getCss() (ré-extraire via scripts/extract-holaf-css.mjs).`);
  } else {
    ok(`${spec.file} régénérable depuis ${brickFile(brick)} (${Buffer.byteLength(onDisk)} octets).`);
  }
}

console.log("Garde-fou vendor holaf — public/vendor/holaf/");
for (const line of done) console.log(line);

if (errors.length > 0) {
  console.error(`ÉCHEC — ${errors.length} problème(s) :`);
  for (const line of errors) console.error(line);
  process.exit(1);
}
const pinnedCount = checksums && checksums.bricks ? Object.keys(checksums.bricks).length : 0;
console.log(`OK — ${pinnedCount} briques épinglées conformes, manifeste aligné, CSS extraits à jour.`);
