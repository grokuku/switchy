/**
 * Routes des réglages globaux — `/api/settings` (protégées par la clé d'API).
 *
 *   GET  /api/settings → réglages groupés (valeur effective OU secret masqué),
 *                        avec source (env/fichier/défaut), éditable et
 *                        « redémarrage requis ».
 *   POST /api/settings → écrit `$SWITCHY_DATA_DIR/config.json` (validation,
 *                        verrous env). Champ vide = inchangé, `null` = efface.
 *
 * Aucun secret n'est JAMAIS renvoyé en clair : seuls `{configured, preview:"••••"}`.
 */
import { Router, type Request, type Response } from "express";
import {
  SETTINGS_SPEC,
  getSettingSpec,
  getSettingSource,
  resolveSetting,
  validateSettingValue,
  writeSettings,
  type SettingSpec,
} from "../settings-store.js";
import { getConcurrency } from "../config.js";
import { requireCsrfForSession, rejectDefaultPassword } from "../middleware/api-auth.js";

const router = Router();

/** Vue NON secrète d'un réglage pour l'API (jamais de secret en clair). */
function describeSetting(spec: SettingSpec): Record<string, unknown> {
  const source = getSettingSource(spec.name);
  const editable = source !== "env" && !spec.envOnly;
  const base: Record<string, unknown> = {
    name: spec.name,
    group: spec.group,
    type: spec.type,
    source,
    editable,
    restartRequired: Boolean(spec.restartRequired),
    sensitive: spec.type === "secret",
  };
  if (spec.options) base.options = spec.options;
  if (spec.min !== undefined) base.min = spec.min;
  if (spec.max !== undefined) base.max = spec.max;

  if (spec.type === "secret") {
    // Secret : on n'expose JAMAIS la valeur, seulement « configuré ou non ».
    return { ...base, configured: resolveSetting(spec.name, "") !== "", preview: "••••" };
  }
  return { ...base, value: resolveSetting(spec.name, spec.default) };
}

/** Liste groupée des réglages (ordre de SETTINGS_SPEC). */
function buildGroups(): { id: string; settings: Record<string, unknown>[] }[] {
  const groups: { id: string; settings: Record<string, unknown>[] }[] = [];
  const index = new Map<string, number>();
  for (const spec of SETTINGS_SPEC) {
    let at = index.get(spec.group);
    if (at === undefined) {
      at = groups.length;
      index.set(spec.group, at);
      groups.push({ id: spec.group, settings: [] });
    }
    groups[at].settings.push(describeSetting(spec));
  }
  return groups;
}

// GET /api/settings — réglages groupés, sources et drapeaux (lecture seule).
router.get("/", (_req: Request, res: Response) => {
  res.json({
    groups: buildGroups(),
    concurrency: getConcurrency(),
  });
});

// POST /api/settings — met à jour `$SWITCHY_DATA_DIR/config.json`.
// CSRF si session ; refusé tant que le mot de passe par défaut n'a pas changé
// POUR UNE SESSION (les accès scriptés par clé d'API restent inchangés).
router.post("/", requireCsrfForSession, rejectDefaultPassword, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { settings?: unknown };
  const incoming = body.settings;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return res.status(400).json({
      error: "Body must be { settings: { NAME: value | null } }",
      code: "VALIDATION_ERROR",
    });
  }

  const updates: Record<string, string | null> = {};
  const lockedErrors: string[] = [];
  const invalidErrors: string[] = [];

  for (const [name, raw] of Object.entries(incoming as Record<string, unknown>)) {
    const spec = getSettingSpec(name);
    if (!spec) {
      invalidErrors.push(`${name}: unknown setting`);
      continue;
    }
    if (spec.envOnly || getSettingSource(name) === "env") {
      lockedErrors.push(`${name}: managed by the environment and cannot be edited`);
      continue;
    }
    if (raw === null) {
      updates[name] = null; // sentinelle : efface l'entrée (retour à l'env / au défaut)
      continue;
    }
    if (typeof raw === "string" && raw.trim() === "") continue; // champ vide = inchangé
    const result = validateSettingValue(spec, raw);
    if (!result.ok) {
      invalidErrors.push(result.error);
      continue;
    }
    updates[name] = result.value;
  }

  // Aucune modification si une clé est refusée (écriture atomique de bout en bout).
  if (lockedErrors.length > 0) {
    return res.status(409).json({
      error: "Some settings are locked by the environment",
      code: "LOCKED_BY_ENV",
      errors: lockedErrors,
    });
  }
  if (invalidErrors.length > 0) {
    return res.status(400).json({ error: "Invalid settings", code: "VALIDATION_ERROR", errors: invalidErrors });
  }

  const changed = Object.keys(updates);
  if (changed.length > 0) writeSettings(updates);
  res.json({
    success: true,
    updated: changed,
    groups: buildGroups(),
    concurrency: getConcurrency(),
  });
});

export default router;
