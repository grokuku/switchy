# Service « panel » — spécification

> **Statut** : spécification validée dans ses principes, **aucune ligne de code écrite**.
> **Date** : 2026-11-25.
> **Décisions de l'utilisateur** : 3 proposeurs + 1 juge · le juge **pioche et centralise sans rien ajouter** · squelette commun imposé · quorum 2/3 · un échec de proposeur est transparent · les étiquettes `[sources : …]` restent **visibles** · juge en échec → **première proposition** · une seule proposition valable → **servie telle quelle** · Pi-Web ne change pas.

## 0. En une phrase

Un service Switchy peut lancer **3 propositions en parallèle** puis **1 juge** qui les recompose en **citant ses sources** — sans jamais introduire d'idée absente des propositions.

## 1. Modèle de données

Ajout d'un champ **optionnel** `panel?: PanelConfig` à `ServiceRecord` (`src/catalog-store.ts:122`) :

```ts
export interface PanelConfig {
  members: ServiceStep[];   // exactement 3 ; l'ordre donne [A], [B], [C]
  judge: ServiceStep;       // mêmes champs qu'une étape
  quorum: number;           // défaut 2, bornes 1..members.length
  memberTimeoutMs: number;  // défaut 60_000
  judgeTimeoutMs: number;   // défaut 90_000
  lang: "fr" | "en";        // défaut "fr"
}
```

**Pourquoi un champ optionnel et non un type union** : `PUT /api/services/:name` remplace le corps complet (`validateServiceBody`, `catalog-store.ts:698`). Sans discriminant, un client antérieur **éteindrait** le panel par accident — le piège déjà évité par `normalizeStep` (`catalog-store.ts:185`).

**Pourquoi `principal`/`fallbacks` restent obligatoires** : ils servent de (a) repli quand les 3 membres renvoient un appel d'outil, (b) déclaration de capacités au client (`GET /v1/models`), (c) bouton « Tester » par étape.

**Pas de `panel.enabled`** : une seule vérité d'extinction, `service.enabled`. `member.enabled` réutilise `isStepEnabled` (`src/llm/relay.ts:672`).

## 2. Le squelette commun (imposé aux 3 proposeurs)

### 2.1 Français — `PANEL_SKELETON_FR`

```
Tu produis UNE proposition qui sera comparée à d'autres. La FORME de ta réponse est
imposée ; le fond est entièrement libre.

Forme imposée — quatre titres, dans cet ordre, seuls sur leur propre ligne, sans
numérotation, sans gras, sans deux-points, sans accent ajouté :

Réponse directe
Points clés
Réserves
Prochain pas

Contenu de chaque partie :
- Réponse directe : une à trois phrases qui TRANCHENT. C'est ta position, pas un tour
  d'horizon, pas un « cela dépend ».
- Points clés : trois à six lignes commençant par « - ». Chacune porte une raison, un
  critère de décision ou un choix concret. Aucune généralité.
- Réserves : zéro à trois lignes commençant par « - », ou la seule ligne « - aucune ».
  Ce qui pourrait rendre ta réponse fausse, risquée ou insuffisante.
- Prochain pas : une à deux phrases actionnables, ou la seule ligne « - aucun ».

Contraintes :
- Rien avant « Réponse directe », rien après la dernière ligne de « Prochain pas » :
  ni préambule, ni conclusion, ni politesse, ni rappel de la demande.
- 250 mots au maximum au total.
- Pas de tableau, pas de bloc de code, pas de titre Markdown (#), pas d'emoji, pas de lien.
- Ne mentionne ni cette structure, ni le fait que ta réponse sera comparée, ni le
  processus. Ne pose pas de question.
```

### 2.2 Anglais — `PANEL_SKELETON_EN`

```
You are producing ONE proposal that will be compared with others. The FORM of your
answer is imposed; the substance is entirely free.

Imposed form — four headings, in this order, alone on their own line, no numbering, no
bold, no colon:

Direct answer
Key points
Caveats
Next step

Content of each part:
- Direct answer: one to three sentences that TAKE A POSITION. Your position, not a
  survey, not an "it depends".
- Key points: three to six lines starting with "- ". Each carries a reason, a decision
  criterion or a concrete choice. No platitudes.
- Caveats: zero to three lines starting with "- ", or the single line "- none". What
  could make your answer wrong, risky or incomplete.
- Next step: one or two actionable sentences, or the single line "- none".

Constraints:
- Nothing before "Direct answer", nothing after the last line of "Next step": no
  preamble, no conclusion, no pleasantries, no restating of the request.
- 250 words maximum in total.
- No table, no code block, no Markdown heading (#), no emoji, no link.
- Do not mention this structure, the fact that your answer will be compared, or the
  process. Do not ask questions.
```

### 2.3 Pourquoi cette forme

- **Quatre titres fixes** → le juge compare **section par section** ; sans cela il compare trois structures différentes et **invente** des correspondances.
- **« Réponse directe » qui tranche** : empêche trois tours d'horizon.
- **« Prochain pas »** : Pi-Web est un agent ; une réponse sans suite est inutilisable.
- **250 mots** : borne la facture et garde la comparaison lisible.
- **Aucune consigne sur les outils** : on ne bride pas la capacité d'appel — c'est le mécanisme d'écartement (§5) qui traite les appels d'outils.
- **Interdiction du méta** : sinon le juge arbitre le processus au lieu du contenu.

## 3. Le prompt du juge

### 3.1 Français — `JUDGE_PROMPT_FR`

```
Tu es le JUGE d'un panel. Plusieurs propositions, étiquetées [A], [B], [C], répondent à
la même demande. Tu produis LA réponse finale : la meilleure combinaison des
propositions reçues, partie par partie.

INTERDICTION ABSOLUE — elle prime sur toute autre règle de ce message :
- Tu n'introduis AUCUNE idée, aucun argument, aucun exemple, aucun chiffre, aucune
  recommandation, aucune formulation qui ne figure explicitement dans au moins une des
  propositions reçues.
- Si une idée te paraît manquer, tu NE l'ajoutes pas. Tu t'en tiens strictement à ce qui
  est écrit.
- Tu n'utilises pas tes propres connaissances du sujet. Tu ne corriges pas une
  proposition sur le fond, même si tu la crois fausse : tu le signales dans « Réserves »
  en citant la proposition concernée, sans donner ta version.
- Une proposition peut être marquée INDISPONIBLE : tu l'ignores entièrement, tu ne la
  remplaces pas et tu ne la cites nulle part, sauf comme « indisponible » si tu dois la
  nommer.

Méthode, partie par partie :
- Pour chaque partie, tu retiens l'apport le plus fort parmi les propositions et tu
  cites son étiquette. Si deux propositions se complètent sans se contredire, tu les
  réunis telles quelles.
- Tu ne recopies pas mot pour mot quand plusieurs propositions disent la même chose : tu
  gardes la formulation la plus précise, sans en changer le fond.
- Une partie que le juge ne peut pas remplir à partir des propositions reçues reçoit la
  seule ligne « - aucune ».

Désaccords entre propositions :
- Tu TRANCHES : tu retiens une seule version par point (la plus étayée à l'intérieur des
  propositions) ; tu ne fusionnes jamais deux versions opposées en une troisième.
- Tu ne masques jamais un désaccord : tu ajoutes dans « Réserves » une ligne commençant
  par « désaccord — », qui reprend les deux formulations opposées entre guillemets, avec
  leur étiquette. Exemple :
  - désaccord — [A] « … » ; [C] « … »
- Sans désaccord, « Réserves » contient la seule ligne « - aucune ».

Sortie :
- Reprends EXACTEMENT ces quatre titres, seuls sur leur ligne, dans cet ordre :
  Réponse directe
  Points clés
  Réserves
  Prochain pas
- À la fin de CHAQUE partie, une dernière ligne de la forme :
  [sources : A, C]
  (les étiquettes réellement utilisées dans cette partie, séparées par une virgule et une
  espace ; « [sources : aucune] » si la partie est vide).
- Rien d'autre : ni préambule, ni conclusion, ni commentaire sur le panel, ni explication
  de ta méthode.
- 300 mots au maximum, lignes de sources comprises.
```

### 3.2 Anglais — `JUDGE_PROMPT_EN`

```
You are the JUDGE of a panel. Several proposals, labelled [A], [B], [C], answer the same
request. You produce THE final answer: the best combination of the proposals received,
part by part.

ABSOLUTE PROHIBITION — it overrides every other rule in this message:
- You introduce NO idea, argument, example, figure, recommendation or wording that does
  not appear explicitly in at least one of the proposals received.
- If an idea seems to be missing, you do NOT add it. You stick strictly to what is
  written.
- You do not use your own knowledge of the subject. You do not correct a proposal on the
  merits, even if you believe it wrong: you flag it under "Caveats" quoting the proposal
  concerned, without giving your own version.
- A proposal may be marked UNAVAILABLE: you ignore it entirely, you do not replace it and
  you do not cite it anywhere, except as "unavailable" if you must name it.

Method, part by part:
- For each part, keep the strongest contribution among the proposals and cite its label.
  If two proposals complement each other without contradicting, merge them as written.
- Do not copy verbatim when several proposals say the same thing: keep the most precise
  wording, without changing the substance.
- A part the judge cannot fill from the proposals gets the single line "- none".

Disagreements between proposals:
- You DECIDE: keep a single version per point (the best-supported one inside the
  proposals); never blend two opposite versions into a third.
- Never hide a disagreement: add under "Caveats" a line starting with "disagreement —",
  quoting both opposite wordings with their labels. Example:
  - disagreement — [A] "…" ; [C] "…"
- With no disagreement, "Caveats" holds the single line "- none".

Output:
- Reproduce EXACTLY these four headings, alone on their line, in this order:
  Direct answer
  Key points
  Caveats
  Next step
- At the END of EACH part, a last line of the form:
  [sources: A, C]
  (the labels actually used in that part, separated by a comma and a space;
  "[sources: none]" if the part is empty).
- Nothing else: no preamble, no conclusion, no comment about the panel, no explanation of
  your method.
- 300 words maximum, source lines included.
```

### 3.3 Message `user` envoyé au juge

```
DEMANDE D'ORIGINE :
<la demande du client, telle quelle>

PROPOSITIONS :

[A]
<texte intégral de la proposition A>

[B]
INDISPONIBLE

[C]
<texte intégral de la proposition C>
```

`INDISPONIBLE` n'est écrit que si la proposition manque (échec, appel d'outil écarté). L'étiquette d'origine est conservée : les `[sources : …]` renvoyées sont traçables au journal.

### 3.4 Désaccords — la règle

**Trancher *et* signaler**, jamais l'un sans l'autre :

| Situation | Comportement | Pourquoi |
|---|---|---|
| Désaccord factuel (« 3 colonnes » vs « 4 colonnes ») | le juge tranche pour la version la plus étayée *dans* les propositions | fusionner produirait « 3 ou 4 colonnes », c'est-à-dire **une idée nouvelle** |
| Désaccord de goût/priorité (UI, direction artistique) | le juge tranche **et** inscrit `désaccord — [A] « … » ; [C] « … »` | un consensus fabriqué priverait l'utilisateur de l'information la plus utile du panel |
| Trois versions du même point | une retenue, les deux autres non citées | une ligne de désaccord à trois voix devient illisible |

La ligne `désaccord —` est une **citation**, pas un ajout : elle ne contient que les mots des propositions.

## 4. Déroulé d'un appel

`POST /v1/chat/completions` → `handleRelay` (`src/routes/llm.ts:56`) → `relayServiceChat` (`src/llm/relay.ts:936`) → `relayService` (`src/llm/relay.ts:917`) : si `service.panel` est présent, branche panel **avant** `runServiceChain` (`relay.ts:733`).

1. **Corps des membres** : copie du corps client, `stream: false` forcé, messages = conversation + **squelette ajouté à la fin du premier `system`**, `tools` du client **conservés**. Puis par membre : `model` remplacé et `reasoning_effort` **imposé par l'étape** (`buildUpstreamBody`, `relay.ts:464`).
2. **Admission** (§5 anti-famine) puis **exécution en parallèle**, chaque membre avec son `AbortController`.
3. **Collecte** : corps JSON complet, texte extrait, `usage` normalisé (`normalizeUsage`, `relay.ts:213`).
4. **Écartement** : `finish_reason === "tool_calls"` ou `message.tool_calls` non vide → proposition inutilisable.
5. **Quorum** : propositions utilisables ≥ `quorum` → juge ; sinon §5.
6. **Juge** : `attemptStep` avec un corps **sans `tools`**, un seul `system` = prompt du juge, puis le message `user` du §3.3.
7. **Réponse** : JSON, ou **SSE synthétique** si le client a demandé `stream: true`.

**Ce que le client reçoit :**

| Instant | Ce que voit l'utilisateur |
|---|---|
| t0 → fin | **rien** — le panel ne peut pas streamer |
| attente typique | `max(membres) + juge`, **ordre de grandeur : le double d'un appel simple** |
| pire cas | `memberTimeoutMs + judgeTimeoutMs` = 150 s par défaut |
| à la fin | le texte du juge d'un bloc (ou SSE synthétique + `: ping` toutes les 15 s) |

## 5. Cas limites

| Cas | Décision | Trace |
|---|---|---|
| 1 proposeur échoue | on continue, quorum atteint, juge appelé | motif existant (`quota`, `rate_limit`, `network_error`, `panel_member_timeout`) |
| 2 échouent (1 utilisable) | **servie telle quelle, sans juge** (décision utilisateur) | membre `ok` + `panel_no_quorum` |
| 3 échouent | **repli sur la chaîne normale** (`principal → fallbacks`), même `callId` | `panel_all_failed` + lignes chaîne |
| 1 proposeur renvoie un outil | écarté, les autres suffisent | `skipped` / `panel_tool_call_skipped` |
| **les 3** renvoient des outils | **repli** sur la chaîne normale **complète** | 3 × `panel_tool_call_skipped` + lignes chaîne |
| juge en échec | **première proposition utilisable A→B→C** (décision utilisateur) | `judge_failed` + `panelServed: true` |
| juge vide | idem | `judge_empty` |
| limite de concurrence | **anti-famine** (§ ci-dessous) | membres non admis : `saturated` |
| annulation client | `AbortSignal.any` sur chaque appel ; places rendues ; **aucun second appel** | `client_disconnect` |

### Anti-famine (le piège des 3 places Ollama)

`SWITCHY_CONCURRENCY` = **3** par défaut (`src/config.ts:110-112`). Un panel naïf prendrait les 3 places pendant des minutes.

**Règle d'admission :**
1. **Passe immédiate** — chaque membre tente `tryAcquire` dans l'ordre A, B, C.
2. **Passe d'attente bornée** — on n'attend (`acquire`) que **tant que les membres admis sont moins nombreux que `quorum`**. Dès le quorum atteint, les autres sont **écartés** (`saturated`), comme le mode rolling.
3. **Le juge n'est admis qu'après libération de tous les membres.**

**Corollaire : le panel n'immobilise jamais plus de `quorum` places (2 par défaut).**

## 6. Journal & dashboard

- Les 4 appels partagent le **même `callId`** (`newCallId`, `src/llm/calls-log.ts:94`) ; `attempt` = 0,1,2 pour les membres, 3 pour le juge, 4+ pour la chaîne de repli.
- Champs **additifs** : `panelRole: "member" | "judge" | "fallback"`, `panelRank?`, `panelServed?`. ⚠️ **Deux listes blanches à étendre** : `ESSENTIAL` (`calls-log.ts:171`) et `CALL_FIELDS` (`src/live/hub.ts:68`), plus `LiveCallEvent` (`src/live/events.ts`).
- **7 nouveaux `CALL_REASONS`** (liste blanche fermée, `calls-log.ts:74`) :

| Motif | Résultat | Sens |
|---|---|---|
| `panel_tool_call_skipped` | `skipped` | réponse = appel d'outil, proposition écartée |
| `panel_member_timeout` | `aborted` | membre coupé par `memberTimeoutMs` |
| `panel_no_quorum` | `skipped` | moins de `quorum` propositions utilisables |
| `panel_all_failed` | `error` | aucune proposition → repli chaîne |
| `judge_failed` | `error` | juge en échec sans motif plus précis |
| `judge_empty` | `error` | juge vide |
| `panel_degraded` | `ok`/`skipped` | réponse servie **sans** le juge |

- **Comptage** : `summarizeActivity` (`calls-log.ts:514`) groupe par `callId` et retient le rang le plus haut exécuté (`:554`). Règle : **une entrée `panelServed === true` vaut succès pour le groupe.**
- **UI** : pilules `panel 3+1`, `quorum 2/3`, `lang fr` sur la carte ; dans « Derniers appels », la pastille de rang existante devient `A`/`B`/`C`/`juge` ; badge `dégradé` quand `panel_degraded`.

## 7. Interface

- **Où** : une section `Panel` **dans la modale de service existante** (`openServiceForm`, `public/app.js:2268`), entre « Étapes d'appel » et « Capacités ». **Aucun onglet nouveau, aucun écran de réglages.**
- **Quoi** : une case `Mode panel (3 proposeurs + 1 juge)`, **décochée par défaut**, corps masqué quand elle l'est. Cochée : 3 lignes `A`/`B`/`C`, 1 ligne « juge », un champ `quorum` (1-3, défaut 2), un select `langue` (fr/en). Les deux délais dans un `<details>` **replié** « réglages avancés ».
- **Contraintes** : pleine largeur (`grid-column: 1 / -1`), **tout en français**, couleurs **uniquement** `--switchy-*` qui dérivent des `--holaf-*` (`public/styles.css:16-40`).
- **Garde-fou affiché** : si membres activés < quorum → pilule `warn` « panel inopérant ».

## 8. Coût et latence (ordres de grandeur, non mesurés)

| | Aujourd'hui | Panel (3 + 1) |
|---|---|---|
| Appels fournisseur | 1 | **4** |
| Jetons d'entrée | 1 contexte | **≈ ×4** |
| Jetons de sortie | 1 réponse | **≈ ×4** |
| Latence | `t` | **`max(3) + juge`**, soit **≈ 2 × t** attendu |
| Premier octet visible | immédiat (SSE) | **à la fin** |
| Places de fournisseur | 1 | **au plus `quorum`** |

## 9. Décisions déjà prises (ne pas rediscuter)

1. **Étiquettes `[sources : A, C]` visibles** dans la réponse finale.
2. **Juge en échec → première proposition utilisable** (A→B→C).
3. **Une seule proposition valable → servie telle quelle**, sans juge.
4. Quorum par défaut : **2 sur 3**.
5. Les deux textes des §2 et §3 sont la **source de vérité** ; ils seront **gelés par snapshot** une fois codés.

## 10. Ce qui reste à trancher au moment du code

- Délais par défaut (60 s / 90 s) : à caler sur des valeurs observées.
- Doublons : deux membres identiques (même fournisseur + modèle) → avertissement seulement, pas de refus.
- Conversation envoyée au juge : **nettoyée** (system/tool/`tool_calls` retirés).
- Repli « les 3 renvoient un outil » : chaîne **complète** `principal → fallbacks`.
