/**
 * Switchy — socle commun des scripts « vendor holaf » (Node pur, HORS RÉSEAU).
 *
 * Les briques holaf-lib sont copiées VERBATIM par le CLI de la librairie
 * (`/projects/holaf-lib/scripts/holaf install <brique> public`) ; ce CLI ne
 * vit PAS dans ce dépôt (et n'existe pas sur GitHub). Les scripts de ce
 * dossier constituent donc l'invariant côté dépôt :
 *
 *   - generate-holaf-checksums.mjs : après un install/upgrade, fige les
 *     empreintes SHA-256 des .js vendorisés dans holaf-checksums.json ;
 *   - extract-holaf-css.mjs : régénère les CSS extraits (HolafModal.getCss /
 *     HolafToast.getCss) servis en fichiers statiques ;
 *   - check-holaf-vendor.mjs : VÉRIFIE le tout (exécuté en CI) — toute dérive
 *     entre les fichiers committés et les empreintes pinnées échoue.
 *
 * Aucun accès réseau : tout est lu depuis public/vendor/holaf/.
 */
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

/** Dossier des briques vendorisées (résolu depuis ce fichier, jamais du cwd). */
export const VENDOR_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "vendor",
  "holaf",
);

/** Manifeste local, écrit par le CLI holaf (brique → version installée). */
export const MANIFEST_FILE = join(VENDOR_DIR, "holaf-manifest.json");

/** Empreintes pinnées (générées par scripts/generate-holaf-checksums.mjs). */
export const CHECKSUMS_FILE = join(VENDOR_DIR, "holaf-checksums.json");

/** Briques holaf-lib consommées par Switchy (le manifeste local les suit). */
export const PINNED_BRICKS = ["tokens", "icons", "modal", "toast", "fetch"];

/** Convention du CLI holaf : fichier vendorisé = holaf-<brique>.js. */
export function brickFile(brick) {
  return `holaf-${brick}.js`;
}

/**
 * CSS EXTRAITS (mode « CSS externe » des briques modal/toast) : nom de la
 * brique → fichier committé + nom de l'export ESM portant getCss().
 * Les fichiers CSS sont SERVIS statiquement (CSP style-src 'self'), d'où
 * `configure({ injectStyles: false })` côté page.
 */
export const EXTRACTED_CSS = {
  modal: { file: "holaf-modal.css", export: "HolafModal" },
  toast: { file: "holaf-toast.css", export: "HolafToast" },
};

/** Empreinte SHA-256 (hex) d'une chaîne. */
export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Contenu canonique d'un CSS extrait : fin normalisée (un seul \n final). */
export function normalizeCss(css) {
  return String(css).replace(/\s+$/, "") + "\n";
}

/**
 * Importe une brique vendorisée par son nom de brique et retourne son
 * namespace ESM. Les briques sont auto-contenues et ne touchent pas au DOM
 * au chargement (getCss() est une pure lecture de chaîne).
 */
export async function importBrick(brick) {
  return import(pathToFileURL(join(VENDOR_DIR, brickFile(brick))).href);
}
