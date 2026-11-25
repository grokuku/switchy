/**
 * Textes de prompt du panel — GEL PAR SNAPSHOT.
 *
 * `docs/panel-service.md` §2 et §3 sont la SOURCE DE VÉRITÉ : le squelette
 * imposé aux proposeurs et le prompt du juge définissent le comportement du
 * panel (comparabilité des propositions, interdiction d'ajouter une idée). Ces
 * tests figent les quatre textes ET le gabarit du message `user` : toute
 * reformulation casse la suite et doit donc être une décision explicite,
 * accompagnée d'un snapshot mis à jour dans le même changement.
 *
 * Aucun réseau, aucun appel LLM ici : uniquement des chaînes et des fonctions
 * pures (nettoyage de conversation, squelette, détection d'appel d'outil).
 */
import { describe, it, expect } from "vitest";
import {
  PANEL_LABELS,
  PANEL_SKELETON_EN,
  PANEL_SKELETON_FR,
  PANEL_UNAVAILABLE,
  JUDGE_PROMPT_EN,
  JUDGE_PROMPT_FR,
  buildJudgeUserMessage,
  judgePrompt,
  panelSkeleton,
} from "../src/llm/panel-prompts.js";
import { appendSkeleton, cleanConversation, hasToolCall, splitJudgeConversation } from "../src/llm/panel.js";

describe("panel — textes de prompt gelés", () => {
  it("squelette FR", () => {
    expect(PANEL_SKELETON_FR).toMatchSnapshot();
  });

  it("squelette EN", () => {
    expect(PANEL_SKELETON_EN).toMatchSnapshot();
  });

  it("prompt du juge FR", () => {
    expect(JUDGE_PROMPT_FR).toMatchSnapshot();
  });

  it("prompt du juge EN", () => {
    expect(JUDGE_PROMPT_EN).toMatchSnapshot();
  });

  it("gabarit du message `user` du juge (proposition manquante = INDISPONIBLE)", () => {
    const message = buildJudgeUserMessage("Quelle base de données choisir ?", [
      { label: "A", text: "PROP A" },
      { label: "B", text: null },
      { label: "C", text: "PROP C" },
    ]);
    expect(message).toMatchSnapshot();
    expect(message).toContain("[B]\nINDISPONIBLE");
    expect(message).not.toContain("[B]\nPROP");
  });

  it("les textes citent les quatre titres imposés et les étiquettes A/B/C", () => {
    for (const skeleton of [PANEL_SKELETON_FR, PANEL_SKELETON_EN]) {
      expect(skeleton).toMatch(/Réponse directe|Direct answer/);
      expect(skeleton).toMatch(/Prochain pas|Next step/);
    }
    expect(JUDGE_PROMPT_FR).toContain("[A], [B], [C]");
    expect(JUDGE_PROMPT_FR).toContain("[sources : A, C]");
    expect(JUDGE_PROMPT_EN).toContain("[sources: A, C]");
    expect(PANEL_LABELS).toEqual(["A", "B", "C"]);
    expect(PANEL_UNAVAILABLE).toBe("INDISPONIBLE");
    // Sélection par langue.
    expect(panelSkeleton("en")).toBe(PANEL_SKELETON_EN);
    expect(judgePrompt("fr")).toBe(JUDGE_PROMPT_FR);
  });
});

describe("panel — préparation des corps (fonctions pures)", () => {
  it("le squelette est ajouté à la FIN du premier system, corps client non muté", () => {
    const original = [
      { role: "system", content: "Tu es un assistant." },
      { role: "developer", content: "second system-like" },
      { role: "user", content: "Q" },
    ];
    const messages = appendSkeleton(original, "SQUELETTE");
    expect(messages[0]).toEqual({ role: "system", content: "Tu es un assistant.\n\nSQUELETTE" });
    expect(messages[1]).toEqual({ role: "developer", content: "second system-like" });
    expect((original[0] as { content: string }).content).toBe("Tu es un assistant.");
  });

  it("sans system, le squelette en crée un en tête", () => {
    const messages = appendSkeleton([{ role: "user", content: "Q" }], "SQUELETTE");
    expect(messages[0]).toEqual({ role: "system", content: "SQUELETTE" });
    expect(messages[1]).toEqual({ role: "user", content: "Q" });
  });

  it("conversation du juge nettoyée : ni system, ni tool, ni tool_calls", () => {
    const cleaned = cleanConversation([
      { role: "system", content: "sys" },
      { role: "user", content: "Q1" },
      { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
      { role: "tool", content: "résultat d'outil", tool_call_id: "1" },
      { role: "assistant", content: "R1" },
      { role: "user", content: "Q2" },
    ]);
    expect(cleaned).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "R1" },
      { role: "user", content: "Q2" },
    ]);
    // La demande d'origine = le dernier message user ; l'historique s'arrête là.
    const split = splitJudgeConversation([
      { role: "system", content: "sys" },
      { role: "user", content: "Q1" },
      { role: "assistant", content: "R1" },
      { role: "user", content: "Q2" },
    ]);
    expect(split.request).toBe("Q2");
    expect(split.history).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "R1" },
    ]);
  });

  it("un appel d'outil n'est pas une proposition", () => {
    expect(hasToolCall({ choices: [{ finish_reason: "tool_calls", message: { content: null } }] })).toBe(true);
    expect(hasToolCall({ choices: [{ finish_reason: "stop", message: { tool_calls: [{ id: "1" }] } }] })).toBe(true);
    expect(hasToolCall({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] })).toBe(false);
    expect(hasToolCall(null)).toBe(false);
  });
});
