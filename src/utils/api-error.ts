/**
 * Erreur HTTP typée de Switchy — porte un statut et un code structuré, pour que
 * les routes répondent de façon homogène sans deviner la nature de l'échec.
 *
 * Codes utilisés par l'API de configuration :
 *   - 400 `VALIDATION_ERROR` : corps ou valeurs invalides (`errors[]` détaillé) ;
 *   - 404 `NOT_FOUND`        : fournisseur ou service inexistant ;
 *   - 409 `CONFLICT`         : identifiant/nom déjà pris, ou référence utilisée.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly errors: string[] | undefined;

  constructor(status: number, code: string, message: string, errors?: string[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.errors = errors;
  }

  static validation(errors: string[]): ApiError {
    const message = errors.length === 1 ? errors[0] : "Invalid request";
    return new ApiError(400, "VALIDATION_ERROR", message, errors);
  }

  static notFound(message: string): ApiError {
    return new ApiError(404, "NOT_FOUND", message);
  }

  static conflict(message: string): ApiError {
    return new ApiError(409, "CONFLICT", message);
  }

  /**
   * 503 `STORAGE_NOT_WRITABLE` : le dossier de données n'existe pas ou n'est pas
   * accessible en écriture (volume absent, mauvais propriétaire, lecture seule).
   * Cas typique : dossier de volume recréé par Docker en root alors que le
   * service tourne en uid 10001 → l'écriture du secret de session échoue.
   * L'erreur BRUTE ne doit jamais remonter en HTML opaque : elle est typée pour
   * que l'interface affiche la VRAIE cause (et non « mot de passe incorrect »).
   */
  static storage(message: string): ApiError {
    return new ApiError(503, "STORAGE_NOT_WRITABLE", message);
  }
}

/** Sérialise une erreur inconnue en réponse JSON homogène. */
export function errorBody(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof ApiError) {
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.errors) body.errors = err.errors;
    return { status: err.status, body };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: message || "Internal error", code: "INTERNAL_ERROR" } };
}
