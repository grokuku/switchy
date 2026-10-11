#!/usr/bin/env node
/**
 * Réinitialisation du mot de passe administrateur de Switchy — PROCÉDURE DE SECOURS.
 *
 * ─── Quand l'utiliser ────────────────────────────────────────────────────────
 * Le mot de passe admin est stocké (hashé) dans `$SWITCHY_DATA_DIR/config.json`.
 * Le défaut `admin` n'est accepté QUE tant qu'aucun hash n'y est enregistré :
 * dès qu'un mot de passe a été changé, `admin` ne fonctionne plus — et le dossier
 * de données PERSISTE (volume Docker), donc l'ancien mot de passe reste.
 * Si le mot de passe est perdu, ce script remet le compte à zéro.
 *
 * ─── Usage (à exécuter SUR la machine qui héberge Switchy) ───────────────────
 *   # Défaut : efface le hash → le mot de passe redevient `admin`
 *   node scripts/reset-admin-password.mjs
 *
 *   # Ou définit directement un nouveau mot de passe (≥ 4 caractères)
 *   node scripts/reset-admin-password.mjs --password 'MonNouveauMotDePasse'
 *
 *   # Docker (conteneur `switchy`) :
 *   docker compose exec switchy node scripts/reset-admin-password.mjs
 *   docker compose exec switchy node scripts/reset-admin-password.mjs --password 'MonNouveauMotDePasse'
 *
 *   # Dossier de données explicite (sinon $SWITCHY_DATA_DIR, sinon /app/data) :
 *   node scripts/reset-admin-password.mjs --data-dir /chemin/vers/data
 *
 * ⚠️ SÉCURITÉ : aucune réinitialisation n'est accessible par le réseau (pas de
 * route HTTP, pas de valeur par défaut piégée). Il faut un accès au système de
 * fichiers de la machine — c'est volontaire. `--password` passe par la ligne de
 * commande (visible dans `ps`) : préférez la remise à `admin` puis le changement
 * depuis l'interface. Chaque exécution incrémente l'époque de session, ce qui
 * INVALIDE toutes les sessions déjà ouvertes.
 *
 * Le format de hash est celui de `src/utils/secret-hash.ts`. Un test
 * (`tests/session.test.ts`) vérifie que le hash produit ici est bien reconnu par
 * `verifySecretHash` de l'application — les deux ne peuvent pas diverger.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const KEY_HASH = "SWITCHY_ADMIN_PASSWORD_HASH";
const KEY_EPOCH = "SWITCHY_SESSION_EPOCH";
const DEFAULT_PASSWORD = "admin";

// Paramètres scrypt identiques à src/utils/secret-hash.ts (NE PAS diverger).
const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

const USAGE = `Usage: node scripts/reset-admin-password.mjs [options]

  --data-dir <chemin>   Dossier de données de Switchy (défaut : $SWITCHY_DATA_DIR, sinon /app/data)
  --password <valeur>   Définit directement ce mot de passe (≥ 4 caractères)
                        Sans cette option : efface le hash → le mot de passe redevient « admin »
  --help                Affiche cette aide
`;

/** Lit les arguments de la ligne de commande (jamais de valeur sortante secrète). */
function parseArgs(argv) {
  const out = { dataDir: null, password: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--data-dir") out.dataDir = argv[++i] ?? null;
    else if (arg === "--password") out.password = argv[++i] ?? null;
    else if (arg.startsWith("--data-dir=")) out.dataDir = arg.slice("--data-dir=".length);
    else if (arg.startsWith("--password=")) out.password = arg.slice("--password=".length);
    else {
      console.error(`Option inconnue : ${arg}`);
      console.error(USAGE);
      process.exit(2);
    }
  }
  return out;
}

/** Hash scrypt au format de `src/utils/secret-hash.ts` : "scrypt:<sel>:<hash>". */
function hashSecret(secret) {
  const salt = crypto.randomBytes(SALT_LEN);
  const hash = crypto.scryptSync(secret, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function fail(message) {
  console.error(`[switchy] ${message}`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.password !== null && args.password.trim().length < 4) {
    fail("Le mot de passe doit faire au moins 4 caractères.");
  }

  const dataDir = path.resolve(args.dataDir ?? process.env.SWITCHY_DATA_DIR ?? "/app/data");
  const file = path.join(dataDir, "config.json");

  // Lecture tolérante : fichier absent ou illisible = objet vide.
  let current = {};
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === "string") current[k] = v;
          else if (typeof v === "number" || typeof v === "boolean") current[k] = String(v);
        }
      }
    } catch (e) {
      fail(`Le fichier « ${file} » n'est pas un JSON lisible (${e.code ?? e.message}).`);
    }
  }

  const hadHash = typeof current[KEY_HASH] === "string" && current[KEY_HASH].trim() !== "";
  const next = { ...current };
  if (args.password !== null) next[KEY_HASH] = hashSecret(args.password);
  else delete next[KEY_HASH];
  const epoch = Number.parseInt(current[KEY_EPOCH] ?? "0", 10);
  next[KEY_EPOCH] = String((Number.isFinite(epoch) && epoch >= 0 ? epoch : 0) + 1);

  // Tri des clés + écriture atomique 0600, comme `writeSettings` de l'application.
  const sorted = {};
  for (const key of Object.keys(next).sort()) sorted[key] = next[key];
  const tmp = `${file}.tmp`;
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(sorted, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600);
      chmodSync(dataDir, 0o700);
    } catch {
      /* best-effort : un système de fichiers sans permissions POSIX reste acceptable */
    }
  } catch (e) {
    fail(
      `Impossible d'écrire « ${file} » (${e.code ?? e.message}). Vérifiez que « ${dataDir} » ` +
        `existe et appartient à l'utilisateur de Switchy (en Docker : uid 10001 — ` +
        `chown -R 10001:10001 <dossier>).`,
    );
  }

  const action = args.password !== null ? "nouveau mot de passe défini" : `hash effacé → mot de passe « ${DEFAULT_PASSWORD} »`;
  console.log(`[switchy] Réinitialisation du mot de passe admin : ${action}.`);
  console.log(`[switchy] Fichier modifié : ${file}`);
  console.log(`[switchy] Hash présent avant : ${hadHash ? "oui" : "non"} — après : ${args.password !== null ? "oui" : "non"}.`);
  console.log(`[switchy] Les sessions déjà ouvertes sont invalidées. Reconnectez-vous dans l'interface.`);
}

main();
