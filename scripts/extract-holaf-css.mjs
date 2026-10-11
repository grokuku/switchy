#!/usr/bin/env node
/**
 * Switchy — régénère les CSS EXTRAITS des briques modal et toast.
 *
 * Les briques holaf-modal / holaf-toast savent produire leur feuille complète
 * via `getCss()` (mode « CSS externe »). Switchy les sert en FICHIERS STATIQUES
 * (`style-src 'self'` strict) et désactive l'injection JS au runtime avec
 * `configure({ injectStyles: false })` (voir public/app.js).
 *
 * ⚠️ À RELANCER après chaque install/upgrade des briques modal/toast :
 *     node scripts/extract-holaf-css.mjs
 * (`check-holaf-vendor.mjs` échoue si un CSS committé n'est plus régénérable.)
 *
 * Node pur, aucun réseau : les briques sont lues depuis public/vendor/holaf/.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EXTRACTED_CSS,
  VENDOR_DIR,
  brickFile,
  importBrick,
  normalizeCss,
} from "./holaf-vendor-lib.mjs";

let failed = false;

for (const [brick, spec] of Object.entries(EXTRACTED_CSS)) {
  try {
    const namespace = await importBrick(brick);
    const api = namespace[spec.export];
    if (!api || typeof api.getCss !== "function") {
      throw new Error(`l'export ${spec.export} de ${brickFile(brick)} n'expose pas getCss()`);
    }
    const css = normalizeCss(api.getCss());
    const target = join(VENDOR_DIR, spec.file);
    let previous = null;
    try {
      previous = await readFile(target, "utf8");
    } catch {
      // Premier tirage : le fichier n'existe pas encore.
    }
    await writeFile(target, css, "utf8");
    const state = previous === css ? "inchangé" : previous === null ? "créé" : "mis à jour";
    console.log(
      `  ${state} ${spec.file} ← ${spec.export}.getCss() (${Buffer.byteLength(css)} octets)`,
    );
  } catch (error) {
    failed = true;
    console.error(`  ✗ ${spec.file} : ${error instanceof Error ? error.message : error}`);
  }
}

if (failed) {
  console.error("ÉCHEC — CSS extraits non régénérés.");
  process.exit(1);
}
console.log(`OK — CSS extraits à jour dans ${VENDOR_DIR}.`);
