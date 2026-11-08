/**
 * [16] Un 500 ne divulgue RIEN : le message brut d'une erreur inattendue
 * (chemins du dossier de données, `EACCES`, `ENOTDIR`…) reste côté serveur
 * (journalisé), la réponse ne porte qu'un code générique. Les erreurs TYPÉES
 * (`ApiError`) gardent, elles, leur message et leur statut.
 */
import { describe, it, expect } from "vitest";
import { ApiError, errorBody } from "../src/utils/api-error.js";

describe("[16] redaction des 500", () => {
  it("une erreur non typée devient { error: 'Internal error', code: 'INTERNAL_ERROR' }", () => {
    const err = Object.assign(new Error("EACCES: permission denied, open '/data/switchy/secret'"), {
      code: "EACCES",
    });
    const { status, body } = errorBody(err);
    expect(status).toBe(500);
    expect(body).toEqual({ error: "Internal error", code: "INTERNAL_ERROR" });
    expect(JSON.stringify(body)).not.toContain("EACCES");
    expect(JSON.stringify(body)).not.toContain("/data/");
  });

  it("une valeur non-Error ne fuit pas non plus", () => {
    const { status, body } = errorBody("boom: /etc/passwd");
    expect(status).toBe(500);
    expect(body).toEqual({ error: "Internal error", code: "INTERNAL_ERROR" });
  });

  it("une ApiError typée conserve son message, son code et son statut", () => {
    const { status, body } = errorBody(ApiError.notFound('service "chat" not found'));
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'service "chat" not found', code: "NOT_FOUND" });
  });

  it("une 503 de stockage reste lisible par l'interface", () => {
    const { status, body } = errorBody(ApiError.storage("data directory is not writable"));
    expect(status).toBe(503);
    expect(body.code).toBe("STORAGE_NOT_WRITABLE");
  });
});
