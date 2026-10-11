/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafTokens · version 0.6.0
 * ─────────────────────────────────────────────────────────────────────────────
 * BRIQUE « FONDATION » — les tokens CSS de PAGE.
 *
 * ▸ RUPTURE 0.6.0 (variante de surfaces « C — Neutres purs + accent ») ───────
 *   Les 6 familles « couleur » (corail, ambre, emeraude, turquoise, amethyste,
 *   neutre) adoptent la variante C VALIDÉE par l'utilisateur : surfaces GRIS
 *   NEUTRE (chroma OKLCH 0) sur une rampe de profondeur UNIQUE PARTAGÉE, et
 *   l'ACCENT (inchangé) porte seul l'identité de la famille. Conséquence : les
 *   fonds des 6 familles d'un même mode sont désormais IDENTIQUES (ΔEok = 0) ;
 *   la distinction entre familles repose UNIQUEMENT sur l'accent (ΔEok ≥ 0,071
 *   en clair, ≥ 0,125 en sombre, seuil de la garde 0,040).
 *   Les valeurs de surface (surface / surface-elev / surface-raised /
 *   surface-hover / border), de texte (text / text-muted — légèrement teintés
 *   vers la teinte de l'accent, chroma ≤ 0,018) et de danger (recalculé sur la
 *   nouvelle surface) sont recopiées EXACTEMENT de la maquette de décision
 *   `Yuki and Libs/_tools/theme-variants.mjs` (PARAMS.C + variantPalette,
 *   primitives de `_tools/theme-lib.mjs`) : la profondeur mesurée vaut
 *   0,062 · 0,048 · 0,030 (sombre) / 0,046 · 0,038 (clair). Les accents des 6
 *   familles sont INCHANGÉS.
 *   ⚠️ La famille d'IDENTITÉ `matrix` est EXPLICITEMENT HORS de cette règle :
 *   ses surfaces sont déjà monochromes mais FIGÉES (identité Pi-Web), elle n'a
 *   ni rampe partagée ni teinte d'accent à suivre — ses valeurs sont
 *   strictement INCHANGÉES.
 *   La garde V2 (tests/helpers/theme-guard.js) est REPENSÉE en conséquence :
 *   le contrôle « écart de FOND ≥ 0,040 entre familles » (faux par construction
 *   quand les familles partagent la surface) est REMPLACÉ par deux invariants
 *   positifs — surfaces NEUTRES (chroma ≈ 0) et RAMPE PARTAGÉE (écart entre
 *   familles ≈ 0) — le contrôle « écart d'ACCENT ≥ 0,040 » étant conservé et
 *   devenant le porteur de la distinction (voir tests/helpers/theme-guard.js).
 *
 * ▸ AJOUT 0.5.0 (famille d'IDENTITÉ `matrix`) ───────────────────────────────
 *   Nouvelle famille `matrix` (identité Pi-Web, monochrome à accent néon vert)
 *   fournissant les presets `matrix-dark` et `matrix-light`. Contrairement aux
 *   6 familles « couleur » du catalogue V2, `matrix` n'appartient PAS à la roue
 *   chromatique : sa garde de distinction/profondeur ne s'y applique donc pas
 *   (voir tests). Elle est en REVANCHE le thème d'identité historique de Pi-Web
 *   et ses valeurs y sont FIGÉES (zéro changement visuel) ; elle porte EN PLUS
 *   les clés hôtes non standard nécessaires à Pi-Web (`border-bright`,
 *   `text-bright`, `info`, `warn`, `code-inline-bg`, `code-block-bg`,
 *   `tool-output-bg`). Aucun changement d'API.
 *
 * ▸ PATCH 0.4.1 (contraste du texte atténué) ────────────────────────────────
 *   Correction de VALEUR (aucun changement d'API, aucune clé nouvelle) :
 *   6 `text-muted` du catalogue V2 passaient sous le seuil AA 4,5:1 sur un
 *   palier de fond (le pire étant `ambre-light` sur `surface` = 4,42:1, et
 *   `neutre-dark` sur `surface-hover` = 2,97:1). Chacun est retouché A MINIMA
 *   (luminosité ajustée, teinte/saturation de la famille PRÉSERVÉES) jusqu'à
 *   ≥ 4,5:1 sur LES QUATRE paliers de profondeur. Aucune autre valeur n'est
 *   touchée. La garde V2 (tests/helpers/theme-guard.js) contrôle désormais
 *   AUSSI `text-muted` sur les 4 paliers (lacune comblée : elle ne vérifiait
 *   que `text` et l'accent).
 *
 * ▸ RUPTURE 0.4.0 (catalogue V2) ─────────────────────────────────────────────
 *   Le catalogue à 2 axes est REMPLACÉ : 6 familles × 2 modes = 12 presets
 *   `<famille>-<mode>` (corail, ambre, emeraude, turquoise, amethyste, neutre),
 *   valeurs FIGÉES en hex, calculées une fois depuis la maquette V2 validée
 *   (`Yuki and Libs/_tools/theme-accents.mjs` : FAMILIES_WHEEL + ACCENTS_V2).
 *   Les 10 presets de la 0.2/0.3 (indigo/midnight/slate/emerald/amber ×
 *   light/dark) DISPARAISSENT. Les 4 alias historiques (dark/light/midnight/
 *   slate) sont CONSERVÉS mais REMAPPÉS (table MIGRATIONS exportée) pour ne
 *   pas casser les préférences « plates ».
 *   Chaque preset porte 16 clés : les 15 clés standard + `surface-hover`, le 4ᵉ
 *   palier de profondeur (surface → surface-elev → surface-raised →
 *   surface-hover). La règle V2 (fonds/accents distincts par mode, texte — y
 *   compris le texte ATTÉNUÉ — /fond ≥ 4,5:1, non-textuel ≥ 3:1, profondeur ≥
 *   seuil) est REJOUÉE en test (tests/holaf-tokens.test.js), sans coût runtime.
 *
 * ▸ HÉRITAGE 0.3.0 (conservé) ────────────────────────────────────────────────
 *   23 clés optionnelles (13 dérivables + 5 d'état + 5 d'identité), registre
 *   de PACKS hôte (registerPreset / updatePreset / unregisterPreset /
 *   getPreset / alpha), PURGE PAR POSSESSION D'ENSEMBLE, et fichier chargeable
 *   en <script> classique (file:// ET HTTP) : AUCUN export top-level (l'`export
 *   { HolafTokens }` de la 0.2.0 est retiré).
 *   ⚠️ Les VALEURS du catalogue changent (rupture) mais l'API, l'événement et
 *   le mécanisme de packs de la 0.3.0 sont inchangés.
 *
 * ▸ PRIVILÈGE (par CONTRAT EXPLICITE) ───────────────────────────────────────
 *   HolafTokens est la SEULE brique du kit autorisée à poser des variables
 *   CSS sur `:root` (document.documentElement), sous le préfixe RÉSERVÉ
 *   --holaf-*. C'est l'exception à la règle du kit (« chaque brique scope son
 *   CSS sous ses propres classes, jamais sur :root »). Installer cette brique,
 *   c'est savoir (opt-in) qu'on installe un THÈME GLOBAL de page : elle prend
 *   le contrôle de la palette (surface, texte, accent, danger…).
 *
 * ▸ SANS RENDU ──────────────────────────────────────────────────────────────
 *   La brique ne rend AUCUN élément : elle ne fait que poser/retirer des
 *   variables CSS sur :root. Le CSS auto-injecté est donc minimal (un commentaire
 *   de repère, injecté une seule fois) — rien de scopé n'est nécessaire.
 *
 * ▸ CONTRAT DE SURFACE ───────────────────────────────────────────────────────
 *   Tokens posés (préfixe --holaf-*) :
 *     surface, surface-elev, surface-raised, border, text, text-muted,
 *     accent, accent-hover, accent-text, danger, danger-hover, danger-text,
 *     radius, shadow, font-size.
 *   Clés OPTIONNELLES 0.3.0 (23 — jamais posées par les presets intégrés,
 *     EXCEPTÉ surface-hover, désormais porté par les 12 presets V2) :
 *     groupe A (dérivables) : accent-soft, accent-glow, accent-gradient,
 *       accent-gradient-hover, accent-shadow, danger-soft, danger-shadow,
 *       danger-gradient*, border-muted, text-faint, surface-hover,
 *       chrome-header, chrome-footer          (* hors dérivation par défaut)
 *     groupe B (états, fournis par le pack) : ok, ok-text, ok-soft, warn,
 *       warn-text
 *     groupe C (identité) : bg-image, txt-glow*, radius-sm, font-sans,
 *       font-mono                              (* opt-in : jamais dérivés)
 *   Mapping hôte (ex. Homy — ses 11 vars actuelles) :
 *     --bg         → var(--holaf-surface)
 *     --bg-elev    → var(--holaf-surface-elev)
 *     --bg-elev-2  → var(--holaf-surface-raised)
 *     --border     → var(--holaf-border)
 *     --text       → var(--holaf-text)
 *     --text-muted → var(--holaf-text-muted)
 *     --accent         → var(--holaf-accent)
 *     --accent-hover   → var(--holaf-accent-hover)
 *     --danger     → var(--holaf-danger)
 *     --radius     → var(--holaf-radius)
 *     --shadow     → var(--holaf-shadow)
 *   Voir js/README-holaf-tokens.md pour le mapping complet.
 *
 * ▸ FAMILLES × MODES (catalogue à 2 axes — V2 + identité) ──────────────────
 *   La famille d'IDENTITÉ `matrix` ouvre le catalogue (Pi-Web), puis les
 *   6 familles « couleur » (corail, ambre, emeraude, turquoise, amethyste,
 *   neutre) × 2 modes (light, dark) = 12 presets `<famille>-<mode>` (soit 14
 *   presets `<famille>-<mode>` au total), PLUS 4 alias
 *   historiques (dark / light / midnight / slate) REMAPPÉS vers les nouvelles
 *   familles (valeurs RIGOUREUSEMENT identiques à leur jumeau). Depuis 0.6.0,
 *   les 6 familles « couleur » PARTAGENT la même rampe de surfaces neutres
 *   (chroma 0) : c'est l'ACCENT, propre à chaque famille, qui les distingue
 *   (variante C). Contraste des textes (`text` ET `text-muted`) ≥ 4.5:1 sur les
 *   4 paliers de surface. Si l'hôte n'a fait
 *   AUCUN choix, la brique applique au chargement
 *   le preset initial issu de `prefers-color-scheme` (dark/light).
 *
 * ▸ API 0.5.0 ────────────────────────────────────────────────────────────────
 *   setTokens / setTheme / setFamily / getTheme / getFamily / getMode /
 *   applyPalette / reset / listPresets / listFamilies / FAMILIES / PRESETS /
 *   ALIASES / PREFIX / VERSION                    — INCHANGÉS (0.2.0)
 *   registerPreset(name, tokens, options?)   → { name, vars } (remplace si repris)
 *   updatePreset(name, tokens)               → { name, vars } (fusion + re-dérivés)
 *   unregisterPreset(name)                   → boolean (false si intégré/inconnu)
 *   getPreset(name)                          → copie | null (intégré/alias/pack)
 *   alpha(color, a)                          → hex → rgba (non-hex inchangé)
 *   MIGRATIONS                               → table ancien→nouveau (hôtes)
 *   listPresets() = 18 intégrés (14 presets + 4 alias) PUIS packs dans l'ordre.
 *   Événement : à CHAQUE changement de palette appliquée (setTokens / setTheme /
 *   applyPalette / reset / initial). register / update / unregister n'émettent
 *   PAS ; setTheme("<pack>") émet comme les autres.
 *
 * ▸ REGISTRE DE PACKS (0.3.0) ───────────────────────────────────────────────
 *   Un PACK hôte est un preset nommé enregistré via registerPreset, sans
 *   toucher aux 18 intégrés. options.extends : nom d'un intégré / alias / pack
 *   (base = copie complète). options.derive : true (défaut = groupe A+B moins
 *   danger-gradient/txt-glow) | false | tableau de clés. Priorité de fusion :
 *   spec explicite > extends > dérivé. Une dérivation dont la source est
 *   absente ou non-hex est SAUTÉE silencieusement (clé non posée, pas d'erreur).
 *   Noms réservés : les 14 <famille>-<mode> + 4 alias + 7 familles → throw.
 *   Registre VOLATILE : les packs sont perdus au rechargement, l'hôte les
 *   ré-enregistre au boot. getFamily() / getMode() renvoient null pour un pack.
 *
 * ▸ PURGE PAR POSSESSION D'ENSEMBLE (correctif 0.3.0) ─────────────────────────
 *   La brique mémorise un Set des clés qu'ELLE a posées. À chaque application,
 *   elle retire d'abord les clés possédées ABSENTES du nouveau lot puis pose le
 *   nouveau lot (même tâche JS → aucun flash). reset() retire tout le set. Les
 *   variables posées HORS brique ne sont jamais touchées. Corrige le résidu
 *   constaté en 0.2.0 (ex. une clé posée par un setTokens riche puis absente
 *   d'un setTokens minimal reste purgée).
 *
 * Autonome : la brique RÉIMPLÉMENTE une version minimale de mix/contrast (pas
 * de dépendance inter-briques vers HolafColor).
 *
 * Fichier CLASSIC-COMPATIBLE (correctif 0.3.0) : AUCUN export top-level —
 * chargeable en <script> classique (file:// ET HTTP), en <script type="module"
 * src> et en import ESM par effet de bord (`import "./holaf-tokens.js"`).
 * L'API est exposée via window.HolafTokens (repli globalThis).
 * ═════════════════════════════════════════════════════════════════════════ */

const HolafTokens = (function () {
    "use strict";

    const VERSION = "0.6.0";

    // Préfixe RÉSERVÉ : toutes les variables posées sont sous --holaf-*.
    const PREFIX = "--holaf-";
    const EVENT_NAME = "holaf-tokens-changed";

    // ─── État interne ──────────────────────────────────────────────────────
    let currentName = null;      // nom du preset en cours (ou null si custom)
    let appliedVars = null;      // dernières variables posées (clés --holaf-*)
    let initialized = false;     // le preset initial par défaut a-t-il été posé ?
    let explicitChoice = false;  // l'hôte a-t-il choisi lui-même ?
    // POSSESSION D'ENSEMBLE (correctif 0.3.0) : toutes les clés --holaf-* que
    // la brique a posées AU MOINS UNE FOIS. Seules celles-ci sont purgées ; une
    // variable posée hors brique n'entre jamais dans ce set.
    const ownedKeys = new Set();
    // REGISTRE DE PACKS (0.3.0) : name → { spec, resolved }. `spec` garde la
    // spec explicite + les options (pour updatePreset) ; `resolved` est la carte
    // finale (extends + spec + dérivées) réellement applicable.
    const PACKS = new Map();

    // ─── Utilitaires internes (pas dépendance inter-briques) ──────────────
    function parseHex(hex) {
        if (typeof hex !== "string") {
            throw new Error("[HolafTokens] hex invalide : " + String(hex) + " (chaîne attendue).");
        }
        let h = hex.trim();
        if (h.charAt(0) === "#") h = h.slice(1);
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        if (!/^[0-9a-fA-F]{6}$/.test(h)) {
            throw new Error('[HolafTokens] hex invalide : "' + hex + '" (attendu "#rgb" ou "#rrggbb").');
        }
        return [
            parseInt(h.slice(0, 2), 16),
            parseInt(h.slice(2, 4), 16),
            parseInt(h.slice(4, 6), 16),
        ];
    }
    function toHex(r, g, b) {
        const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).toUpperCase().padStart(2, "0");
        return "#" + c(r) + c(g) + c(b);
    }
    // mix(a, b, ratio) : ratio 0..1 = part de b.
    function mix(a, b, ratio) {
        const ca = parseHex(a);
        const cb = parseHex(b);
        return toHex(
            ca[0] + (cb[0] - ca[0]) * ratio,
            ca[1] + (cb[1] - ca[1]) * ratio,
            ca[2] + (cb[2] - ca[2]) * ratio
        );
    }
    // Contrast ratio WCAG 2.1 minimal (luminance relative) — pour les accents.
    function lumChannel(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    function contrastRatio(a, b) {
        const la = [0.2126, 0.7152, 0.0722].reduce((acc, w, i) => acc + w * lumChannel(parseHex(a)[i]), 0);
        const lb = [0.2126, 0.7152, 0.0722].reduce((acc, w, i) => acc + w * lumChannel(parseHex(b)[i]), 0);
        const hi = Math.max(la, lb), lo = Math.min(la, lb);
        return (hi + 0.05) / (lo + 0.05);
    }

    // ─── Choix du texte lisible (dérivations ok-text / warn-text) ─────────
    // La brique reste AUTONOME (pas de dépendance inter-briques vers HolafColor) :
    // on retient la plus lisible des deux couleurs (sombre / claire), ≥ 4.5:1
    // quand c'est possible.
    function readableText(bg, dark, light) {
        const d = dark || "#000000";
        const l = light || "#ffffff";
        const rDark = contrastRatio(bg, d);
        const rLight = contrastRatio(bg, l);
        const darkOk = rDark >= 4.5;
        const lightOk = rLight >= 4.5;
        if (darkOk && !lightOk) return d;
        if (lightOk && !darkOk) return l;
        return rDark >= rLight ? d : l;
    }

    // ─── Catalogue V2 — 6 familles × 2 modes, valeurs FIGÉES en hex ───────
    // Depuis 0.6.0 (variante C), les valeurs de surface/texte/danger des 6
    // familles « couleur » sont recopiées UNE FOIS depuis la maquette de
    // décision validée `Yuki and Libs/_tools/theme-variants.mjs` (PARAMS.C +
    // variantPalette, primitives `_tools/theme-lib.mjs`) : surfaces GRIS NEUTRE
    // (chroma 0) sur une rampe UNIQUE PARTAGÉE, accent INCHANGÉ (0.4.0). AUCUN
    // moteur OKLCH n'est embarqué (précédent accepté : modal / toast figent
    // déjà leurs palettes littérales). La famille `matrix` (0.5.0) reste FIGÉE,
    // hors règle. Chaque mode porte
    // 16 clés : les 15 clés standard + `surface-hover` (4ᵉ palier de profondeur
    // surface → surface-elev → surface-raised → surface-hover). Les clés NON
    // produites par la maquette suivent des règles documentées (README) :
    //   accent-hover = mix(accent, surface, 15 %)    (comme applyPalette)
    //   danger       = graine #dc2626 (clair) / #f87171 (sombre), assombrie par
    //                  pas de 5 % jusqu'à ≥ 4.5:1 sur la surface de la famille
    //   danger-hover = mix(danger, surface, 15 %)
    //   danger-text  = readableText(danger) (#ffffff ou #000000)
    //   radius = "12px" ; font-size = "14px" ; shadow = ombre par mode.
    const FAMILIES = {
        // Famille d'IDENTITÉ (Pi-Web) : monochrome à accent néon vert. Valeurs
        // FIGÉES (= ex-thème « Matrix » de Pi-Web, zéro changement visuel). Elle
        // porte 7 clés hôte EN PLUS des 16 clés standard (border-bright,
        // text-bright, info, warn, code-inline-bg, code-block-bg, tool-output-bg).
        // Hors roue chromatique : non soumise à la garde de distinction/profondeur.
        matrix: {
            label: "Matrix", hue: 135,
            light: {
                "surface": "#eeece6",
                "surface-elev": "#f8f7f4",
                "surface-raised": "#ffffff",
                "surface-hover": "#f1f0ea",
                "border": "#d0d0c8",
                "border-bright": "#b8b8b0",
                "text": "#3d3d3a",
                "text-bright": "#1a1a18",
                "text-muted": "#777770",
                "info": "#0070cc",
                "warn": "#cc8800",
                "accent": "#166534",
                "accent-hover": "#15803d",
                "accent-text": "#ffffff",
                "danger": "#cc2222",
                "danger-hover": "#D1403F",
                "danger-text": "#ffffff",
                "code-inline-bg": "rgba(0, 0, 0, 0.06)",
                "code-block-bg": "rgba(0, 0, 0, 0.08)",
                "tool-output-bg": "rgba(0, 0, 0, 0.05)",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(24, 24, 27, 0.18)",
                "font-size": "14px",
            },
            dark: {
                "surface": "#0a0a0a",
                "surface-elev": "#161616",
                "surface-raised": "#1e1e1e",
                "surface-hover": "#262626",
                "border": "#2a2a2a",
                "border-bright": "#3a3a3a",
                "text": "#c0c0c0",
                "text-bright": "#e0e0e0",
                "text-muted": "#888888",
                "info": "#00aaff",
                "warn": "#ffaa00",
                "accent": "#00ff41",
                "accent-hover": "#00cc34",
                "accent-text": "#000000",
                "danger": "#ff4444",
                "danger-hover": "#DA3B3B",
                "danger-text": "#000000",
                "code-inline-bg": "rgba(0, 0, 0, 0.3)",
                "code-block-bg": "rgba(0, 0, 0, 0.4)",
                "tool-output-bg": "rgba(0, 0, 0, 0.3)",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(0, 0, 0, 0.55)",
                "font-size": "14px",
            },
        },
        corail: {
            label: "Corail", hue: 354,
            light: {
                "surface": "#eeeeee",
                "surface-elev": "#ffffff",
                "surface-raised": "#e0dfdf",
                "surface-hover": "#d4d2d3",
                "border": "#c4c0c1",
                "text": "#2b2226",
                "text-muted": "#4b3f43",
                "accent": "#9c045e",
                "accent-hover": "#ac3b72",
                "accent-text": "#ffffff",
                "danger": "#cd2323",
                "danger-hover": "#d74e45",
                "danger-text": "#ffffff",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(24, 24, 27, 0.18)",
                "font-size": "14px",
            },
            dark: {
                "surface": "#171717",
                "surface-elev": "#262526",
                "surface-raised": "#323132",
                "surface-hover": "#3b3939",
                "border": "#4d494a",
                "text": "#f5f0f2",
                "text-muted": "#c3bbbe",
                "accent": "#fa7fb5",
                "accent-hover": "#d46e9b",
                "accent-text": "#0b0b12",
                "danger": "#f87171",
                "danger-hover": "#d26362",
                "danger-text": "#000000",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(0, 0, 0, 0.55)",
                "font-size": "14px",
            },
        },
        ambre: {
            label: "Ambre", hue: 66,
            light: {
                "surface": "#eeeeee",
                "surface-elev": "#ffffff",
                "surface-raised": "#e0dfde",
                "surface-hover": "#d4d3d1",
                "border": "#c3c1be",
                "text": "#2a241e",
                "text-muted": "#494138",
                "accent": "#7a4800",
                "accent-hover": "#8c6031",
                "accent-text": "#ffffff",
                "danger": "#cd2323",
                "danger-hover": "#d74e45",
                "danger-text": "#ffffff",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(24, 24, 27, 0.18)",
                "font-size": "14px",
            },
            dark: {
                "surface": "#171717",
                "surface-elev": "#262625",
                "surface-raised": "#323130",
                "surface-hover": "#3a3938",
                "border": "#4c4a48",
                "text": "#f5f1ee",
                "text-muted": "#c2bdb7",
                "accent": "#f29a2d",
                "accent-hover": "#cd852f",
                "accent-text": "#0b0b12",
                "danger": "#f87171",
                "danger-hover": "#d26362",
                "danger-text": "#000000",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(0, 0, 0, 0.55)",
                "font-size": "14px",
            },
        },
        emeraude: {
            label: "Émeraude", hue: 138,
            light: {
                "surface": "#eeeeee",
                "surface-elev": "#ffffff",
                "surface-raised": "#dfdfdf",
                "surface-hover": "#d2d3d2",
                "border": "#c0c2bf",
                "text": "#222720",
                "text-muted": "#3e453c",
                "accent": "#276701",
                "accent-hover": "#467b32",
                "accent-text": "#ffffff",
                "danger": "#cd2323",
                "danger-hover": "#d74e45",
                "danger-text": "#ffffff",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(24, 24, 27, 0.18)",
                "font-size": "14px",
            },
            dark: {
                "surface": "#171717",
                "surface-elev": "#252625",
                "surface-raised": "#313231",
                "surface-hover": "#383a38",
                "border": "#494b48",
                "text": "#f0f3ef",
                "text-muted": "#bbbfb9",
                "accent": "#7fc765",
                "accent-hover": "#6ea959",
                "accent-text": "#0b0b12",
                "danger": "#f87171",
                "danger-hover": "#d26362",
                "danger-text": "#000000",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(0, 0, 0, 0.55)",
                "font-size": "14px",
            },
        },
        turquoise: {
            label: "Turquoise", hue: 210,
            light: {
                "surface": "#eeeeee",
                "surface-elev": "#ffffff",
                "surface-raised": "#dedfdf",
                "surface-hover": "#d1d3d3",
                "border": "#bec2c3",
                "text": "#1d2729",
                "text-muted": "#384548",
                "accent": "#07606c",
                "accent-hover": "#38747f",
                "accent-text": "#ffffff",
                "danger": "#cd2323",
                "danger-hover": "#d74e45",
                "danger-text": "#ffffff",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(24, 24, 27, 0.18)",
                "font-size": "14px",
            },
            dark: {
                "surface": "#171717",
                "surface-elev": "#252626",
                "surface-raised": "#303232",
                "surface-hover": "#373a3a",
                "border": "#474b4c",
                "text": "#edf3f4",
                "text-muted": "#b7c0c1",
                "accent": "#0ec7de",
                "accent-hover": "#22aabc",
                "accent-text": "#0b0b12",
                "danger": "#f87171",
                "danger-hover": "#d26362",
                "danger-text": "#000000",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(0, 0, 0, 0.55)",
                "font-size": "14px",
            },
        },
        amethyste: {
            label: "Améthyste", hue: 282,
            light: {
                "surface": "#eeeeee",
                "surface-elev": "#ffffff",
                "surface-raised": "#dfdfe0",
                "surface-hover": "#d2d3d4",
                "border": "#c0c1c4",
                "text": "#24242c",
                "text-muted": "#41414c",
                "accent": "#4d41b0",
                "accent-hover": "#615dbb",
                "accent-text": "#ffffff",
                "danger": "#cd2323",
                "danger-hover": "#d74e45",
                "danger-text": "#ffffff",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(24, 24, 27, 0.18)",
                "font-size": "14px",
            },
            dark: {
                "surface": "#171717",
                "surface-elev": "#262626",
                "surface-raised": "#313133",
                "surface-hover": "#39393b",
                "border": "#4a4a4d",
                "text": "#f1f1f6",
                "text-muted": "#bcbdc4",
                "accent": "#a1a3ff",
                "accent-hover": "#8a8cd8",
                "accent-text": "#0b0b12",
                "danger": "#f87171",
                "danger-hover": "#d26362",
                "danger-text": "#000000",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(0, 0, 0, 0.55)",
                "font-size": "14px",
            },
        },
        neutre: {
            label: "Neutre", hue: 250,
            light: {
                "surface": "#eeeeee",
                "surface-elev": "#ffffff",
                "surface-raised": "#dfdfe0",
                "surface-hover": "#d2d3d4",
                "border": "#bfc1c4",
                "text": "#20262c",
                "text-muted": "#3b434c",
                "accent": "#515457",
                "accent-hover": "#67696c",
                "accent-text": "#ffffff",
                "danger": "#cd2323",
                "danger-hover": "#d74e45",
                "danger-text": "#ffffff",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(24, 24, 27, 0.18)",
                "font-size": "14px",
            },
            dark: {
                "surface": "#171717",
                "surface-elev": "#252626",
                "surface-raised": "#313233",
                "surface-hover": "#38393b",
                "border": "#494a4d",
                "text": "#eff2f6",
                "text-muted": "#babec4",
                "accent": "#aeb1b5",
                "accent-hover": "#95979a",
                "accent-text": "#0b0b12",
                "danger": "#f87171",
                "danger-hover": "#d26362",
                "danger-text": "#000000",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(0, 0, 0, 0.55)",
                "font-size": "14px",
            },
        },
    };

    // Ordre d'affichage stable : la famille d'IDENTITÉ `matrix` d'abord
    // (thème de référence Pi-Web), puis les 6 familles « couleur » par teinte
    // (le Neutre en dernier).
    const MODES = ["light", "dark"];
    const FAMILY_NAMES = ["matrix", "corail", "ambre", "emeraude", "turquoise", "amethyste", "neutre"];

    // ─── Catalogue des presets (12 familles×modes + 4 alias REMAPPÉS) ──────
    const PRESETS = {};
    FAMILY_NAMES.forEach((family) => {
        MODES.forEach((mode) => {
            PRESETS[family + "-" + mode] = Object.assign({}, FAMILIES[family][mode]);
        });
    });

    // Alias historiques → valeurs RIGOUREUSEMENT identiques (copies des jumeaux).
    // REMAPPÉS : les anciennes familles (indigo/midnight/slate/emerald/amber)
    // n'existent plus (voir MIGRATIONS). `midnight` était violet → amethyste ;
    // `slate` était gris → neutre.
    const ALIASES = {
        dark: "amethyste-dark",
        light: "amethyste-light",
        midnight: "amethyste-dark",
        slate: "neutre-dark",
    };
    Object.keys(ALIASES).forEach((alias) => {
        PRESETS[alias] = Object.assign({}, PRESETS[ALIASES[alias]]);
    });

    // ─── Table de MIGRATION (0.4.0) — fournie AUX HÔTES ────────────────────
    // Les hôtes l'appliquent EUX-MÊMES à leur préférence stockée : <ancien nom>
    // (10 anciens presets + 4 alias) → <nouveau nom>. La brique n'effectue
    // AUCUNE migration automatique (elle ne stocke aucune préférence).
    const MIGRATIONS = {
        "indigo-light": "amethyste-light",
        "indigo-dark": "amethyste-dark",
        "midnight-light": "amethyste-light",
        "midnight-dark": "amethyste-dark",
        "slate-light": "neutre-light",
        "slate-dark": "neutre-dark",
        "emerald-light": "emeraude-light",
        "emerald-dark": "emeraude-dark",
        "amber-light": "ambre-light",
        "amber-dark": "ambre-dark",
        dark: "amethyste-dark",
        light: "amethyste-light",
        midnight: "amethyste-dark",
        slate: "neutre-dark",
    };

    // ─── Noms réservés (0.4.0) ──────────────────────────────────────────────
    // Les 12 <famille>-<mode>, les 4 alias et les 6 noms de familles sont
    // RÉSERVÉS : un pack hôte ne peut pas les reprendre (throw clair).
    const RESERVED_NAMES = new Set(Object.keys(PRESETS).concat(FAMILY_NAMES));

    // ─── Clés optionnelles 0.3.0 (23) + moteur de dérivation ───────────────
    // Groupe A (dérivables) : accent-soft … chrome-footer, plus danger-gradient
    //   (dérivable mais HORS DÉFAUT : opt-in).
    // Groupe B (états, fournis par le pack puis dérivés) : ok / warn et leurs
    //   dérivées ok-text, ok-soft, warn-text.
    // Groupe C (identité) : bg-image, txt-glow (opt-in, aucune règle), radius-sm
    //   (dérivable à la demande), font-sans, font-mono.
    // Une règle reçoit la carte fusionnée (clés non préfixées) et retourne la
    // valeur dérivée, ou undefined si la source manque / n'est pas exploitable :
    // la clé n'est alors PAS posée, silencieusement (pas d'erreur).
    function hexToken(value) {
        if (typeof value !== "string") return null;
        try { return parseHex(value); } catch (e) { return null; }
    }
    function hexOf(value) {
        const c = hexToken(value);
        return c ? toHex(c[0], c[1], c[2]) : null;
    }
    // Dérivée de couleur : null si la source n'est pas un hex exploitable.
    function rgbaOf(value, a) {
        return hexToken(value) ? alpha(value, a) : null;
    }
    // Ordre = ordre des dépendances (accent-soft avant accent-shadow…).
    const DERIVE_RULES = {
        // — Groupe A —
        "accent-soft": (t) => rgbaOf(t.accent, 0.16),
        "accent-glow": (t) => rgbaOf(t.accent, 0.5),
        "accent-gradient": (t) => {
            const a = hexOf(t.accent);
            const h = hexOf(t["accent-hover"]);
            return a && h ? "linear-gradient(135deg, " + a + ", " + h + ")" : undefined;
        },
        "accent-gradient-hover": (t) => {
            const a = hexOf(t.accent);
            const h = hexOf(t["accent-hover"]);
            return a && h
                ? "linear-gradient(135deg, " + mix(a, "#ffffff", 0.12) + ", " + mix(h, "#ffffff", 0.12) + ")"
                : undefined;
        },
        "accent-shadow": (t) => (t["accent-soft"] ? "0 0 18px var(--holaf-accent-soft)" : undefined),
        "danger-soft": (t) => rgbaOf(t.danger, 0.12),
        "danger-shadow": (t) => (t["danger-soft"] ? "0 0 16px var(--holaf-danger-soft)" : undefined),
        // danger-gradient : dérivable mais HORS DÉFAUT (opt-in via derive:[…]).
        "danger-gradient": (t) => {
            const d = hexOf(t.danger);
            const h = hexOf(t["danger-hover"]);
            return d && h ? "linear-gradient(135deg, " + d + ", " + h + ")" : undefined;
        },
        "border-muted": (t) => rgbaOf(t.border, 0.45),
        "text-faint": (t) => {
            const a = hexOf(t["text-muted"]);
            const b = hexOf(t.surface);
            return a && b ? mix(a, b, 0.42) : undefined;
        },
        "surface-hover": (t) => rgbaOf(t["surface-raised"], 0.7),
        "chrome-header": (t) => {
            const a = rgbaOf(t.surface, 0.92);
            const b = rgbaOf(t.surface, 0.66);
            return a && b ? "linear-gradient(180deg, " + a + ", " + b + ")" : undefined;
        },
        "chrome-footer": (t) => {
            const a = rgbaOf(t.surface, 0.95);
            const b = rgbaOf(t.surface, 0.66);
            return a && b ? "linear-gradient(0deg, " + a + ", " + b + ")" : undefined;
        },
        // — Groupe B (états) —
        "ok-text": (t) => (hexToken(t.ok) ? readableText(hexOf(t.ok)) : undefined),
        "ok-soft": (t) => rgbaOf(t.ok, 0.1),
        "warn-text": (t) => (hexToken(t.warn) ? readableText(hexOf(t.warn)) : undefined),
        // — Groupe C —
        "radius-sm": (t) => (typeof t.radius === "string" && t.radius.trim()
            ? "calc(" + t.radius.trim() + " - 2px)"
            : undefined),
    };
    const DERIVE_ORDER = Object.keys(DERIVE_RULES);
    // Dérivations par DÉFAUT = « liste A+B » moins les opt-in : danger-gradient
    // et txt-glow restent HORS défaut.
    const DEFAULT_DERIVE = [
        "accent-soft", "accent-glow", "accent-gradient", "accent-gradient-hover",
        "accent-shadow", "danger-soft", "danger-shadow", "border-muted",
        "text-faint", "surface-hover", "chrome-header", "chrome-footer",
        "ok-text", "ok-soft", "warn-text",
    ];

    function deriveInto(tokens, requested) {
        DERIVE_ORDER.forEach((key) => {
            if (!requested.has(key)) return;
            // Priorité : spec explicite > extends > dérivé.
            if (Object.prototype.hasOwnProperty.call(tokens, key)) return;
            const rule = DERIVE_RULES[key];
            if (!rule) return; // clé sans règle (opt-in) → sautée silencieusement
            const value = rule(tokens);
            if (value !== undefined && value !== null && value !== "") tokens[key] = value;
        });
    }

    // options.derive → Set de clés. true / undefined = liste par défaut.
    function deriveList(derive) {
        if (derive === undefined || derive === null || derive === true) return new Set(DEFAULT_DERIVE);
        if (derive === false) return new Set();
        if (Array.isArray(derive)) return new Set(derive.filter((k) => typeof k === "string"));
        throw new Error("[HolafTokens] options.derive : attendu true | false | tableau de clés.");
    }

    // Preset intégré, alias ou pack → carte (clés non préfixées) ; null sinon.
    function findPreset(name) {
        if (typeof name !== "string" || !name) return null;
        if (PACKS.has(name)) return PACKS.get(name).resolved;
        if (Object.prototype.hasOwnProperty.call(PRESETS, name)) return PRESETS[name];
        return null;
    }

    // Résolution d'un pack : base (extends) → spec explicite → dérivations.
    function resolvePack(tokens, options) {
        const opts = options || {};
        let base = {};
        if (opts.extends !== undefined && opts.extends !== null) {
            const inherited = findPreset(opts.extends);
            if (!inherited) {
                throw new Error('[HolafTokens] options.extends : preset inconnu "' + opts.extends + '".');
            }
            base = Object.assign({}, inherited);
        }
        const merged = Object.assign({}, base, tokens);
        const requested = deriveList(opts.derive);
        if (requested.size) deriveInto(merged, requested);
        return merged;
    }

    // ─── Application DOM ────────────────────────────────────────────────────
    function root() {
        return typeof document !== "undefined" ? document.documentElement : null;
    }

    // Préfixe une clé de token : passé tel quel si déjà "--", sinon --holaf-*.
    function prefixKey(key) {
        return key.indexOf("--") === 0 ? key : PREFIX + key;
    }

    // Prend un objet { key: value } (clés sans préfixe ou avec) → objet de
    // variables --holaf-* prêtes pour la pose.
    function tokenVars(values) {
        const vars = {};
        Object.keys(values).forEach((k) => {
            if (values[k] === undefined || values[k] === null) return;
            vars[prefixKey(k)] = String(values[k]);
        });
        return vars;
    }

    function dispatch(theme) {
        if (typeof document === "undefined") return;
        document.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { theme } }));
    }

    // Pose des variables --holaf-* sur :root et met à jour l'état interne.
    // `name` = nom de preset (ou null si palette custom). `explicit` distingue
    // la pose volontaire de l'hôte du preset initial automatique.
    function applyTokens(values, name, explicit) {
        const el = root();
        const vars = tokenVars(values);
        if (el) {
            // PURGE PAR POSSESSION D'ENSEMBLE (correctif 0.3.0) : retire d'abord
            // les clés possédées ABSENTES du nouveau lot, PUIS pose le nouveau
            // lot — même tâche JS, donc aucun flash intermédiaire.
            ownedKeys.forEach((k) => {
                if (!Object.prototype.hasOwnProperty.call(vars, k)) el.style.removeProperty(k);
            });
            Object.keys(vars).forEach((k) => el.style.setProperty(k, vars[k]));
        }
        Object.keys(vars).forEach((k) => ownedKeys.add(k));
        currentName = name || null;
        appliedVars = vars;
        if (explicit) explicitChoice = true;
        initialized = true;
        dispatch(name || { vars: Object.assign({}, vars) });
    }

    // ─── Preset initial par défaut (prefers-color-scheme, si AUCUN choix) ──
    // Posé au chargement de la brique, UNIQUEMENT si l'hôte n'a pas déjà fait
    // un choix explicite (donc jamais après un setTheme/setTokens/applyPalette).
    function ensureInitial() {
        if (initialized || explicitChoice) return;
        let preset = "light";
        if (typeof window !== "undefined" && window.matchMedia &&
            window.matchMedia("(prefers-color-scheme: dark)").matches) {
            preset = "dark";
        }
        applyTokens(PRESETS[preset], preset, false);
    }

    // ─── API publique ───────────────────────────────────────────────────────
    // setTokens({ name?, values }) — pose des tokens --holaf-* sur :root.
    function setTokens(spec) {
        if (!spec || typeof spec !== "object" || !spec.values || typeof spec.values !== "object") {
            throw new Error("[HolafTokens] setTokens : attendu { name?, values }.");
        }
        applyTokens(spec.values, spec.name || null, true);
        return getTheme();
    }

    // setTheme(presetName) — applique un preset par son nom. Accepte les
    // <famille>-<mode> (ex. "turquoise-light") ET les alias (dark/light/midnight/slate).
    function setTheme(presetName) {
        const preset = findPreset(presetName);
        if (!preset) {
            throw new Error(
                '[HolafTokens] setTheme : preset inconnu "' + presetName + '" — disponibles : ' +
                listPresets().join(", ") + "."
            );
        }
        applyTokens(preset, presetName, true);
        return getTheme();
    }

    // listPresets() → TOUS les noms valides : 12 familles×modes + 4 alias
    // (intégrés) PUIS les packs hôte dans leur ordre d'enregistrement (0.3.0).
    function listPresets() {
        return Object.keys(PRESETS).concat(Array.from(PACKS.keys()));
    }

    // listFamilies() → noms des familles (axe 1).
    function listFamilies() {
        return FAMILY_NAMES.slice();
    }

    // setFamily(family, mode?) — applique <famille>-<mode>. Sans `mode`, garde le
    // mode courant de cette famille si elle est déjà active, sinon "light".
    function setFamily(family, mode) {
        if (!FAMILIES[family]) {
            throw new Error(
                '[HolafTokens] setFamily : famille inconnue "' + family + '" — disponibles : ' +
                FAMILY_NAMES.join(", ") + "."
            );
        }
        let m = mode;
        if (m === undefined || m === null) {
            m = (currentName && currentName.indexOf(family + "-") === 0)
                ? currentName.slice(family.length + 1)
                : "light";
        }
        if (MODES.indexOf(m) === -1) {
            throw new Error(
                '[HolafTokens] setFamily : mode inconnu "' + m + '" — attendu : ' + MODES.join(" ou ") + "."
            );
        }
        return setTheme(family + "-" + m);
    }

    // describeName(name) → { name, family, mode } | null (résout aussi les alias).
    // Un PACK hôte ne décrit jamais une famille / un mode : getFamily() et
    // getMode() renvoient null pour un pack (contrat 0.3.0).
    function describeName(name) {
        if (!name) return null;
        if (PACKS.has(name)) return null;
        if (ALIASES[name]) {
            const twin = ALIASES[name];
            const i = twin.indexOf("-");
            return { name, family: twin.slice(0, i), mode: twin.slice(i + 1) };
        }
        const i = name.indexOf("-");
        if (i > 0) {
            const fam = name.slice(0, i);
            const md = name.slice(i + 1);
            if (FAMILIES[fam] && MODES.indexOf(md) !== -1) return { name, family: fam, mode: md };
        }
        return null;
    }

    // getFamily() / getMode() → axe 1 / axe 2 du thème courant (ou null).
    function getFamily() {
        const d = describeName(currentName);
        return d ? d.family : null;
    }
    function getMode() {
        const d = describeName(currentName);
        return d ? d.mode : null;
    }

    // getTheme() → { name, vars } (copie) avec les variables actuellement posées,
    // ou les valeurs du dernier preset/tokens appliqué ; null si reset() fait.
    function getTheme() {
        if (!initialized || !appliedVars) {
            return currentName ? { name: currentName, vars: Object.assign({}, PRESETS[currentName] || {}) } : null;
        }
        return { name: currentName, vars: Object.assign({}, appliedVars) };
    }

    // applyPalette(accentHex, opts?) — calcule la palette via les calculs
    // internes (mix/contrast) et la pose. Base = preset en cours (sinon dark).
    function applyPalette(accentHex, opts) {
        const options = opts || {};
        // Base : les surfaces du preset en cours, sinon dark.
        // Base : les surfaces du preset en cours, sinon dark. Le pack (ou le
        // preset) est fusionné PAR-DESSUS dark pour garantir une base complète
        // même si un pack hôte ne fournit qu'une partie des clés.
        const baseName = (currentName && findPreset(currentName)) ? currentName : "dark";
        const base = Object.assign({}, PRESETS.dark, findPreset(baseName));
        const accent = options.accent || accentHex;
        // Validation de l'accent (throw clair) avant tout calcul.
        parseHex(accent);
        const hoverRatio = typeof options.hoverRatio === "number" ? options.hoverRatio : 0.15;
        const borderRatio = typeof options.borderRatio === "number" ? options.borderRatio : 0.22;
        const danger = options.danger || base.danger;
        const accentText = options.accentText
            || (contrastRatio(accent, "#000000") >= contrastRatio(accent, "#ffffff") ? "#000000" : "#ffffff");

        const palette = {
            surface: options.surface || base.surface,
            "surface-elev": options.surfaceElev || base["surface-elev"],
            "surface-raised": options.surfaceRaised || base["surface-raised"],
            border: options.border || mix(base.surface, accent, borderRatio),
            text: options.text || base.text,
            "text-muted": options.textMuted || mix(base.text, base.surface, 0.42),
            accent: toHex.apply(null, parseHex(accent)),
            "accent-hover": options.accentHover || mix(accent, base.surface, hoverRatio),
            "accent-text": accentText,
            danger: toHex.apply(null, parseHex(danger)),
            "danger-text": options.dangerText || base["danger-text"],
            radius: options.radius || base.radius,
            shadow: options.shadow || base.shadow,
            "font-size": options.fontSize || base["font-size"],
        };
        // danger-hover dérivé.
        palette["danger-hover"] = mix(danger, base.surface, hoverRatio);
        applyTokens(palette, null, true);
        return getTheme();
    }

    // reset() — retire TOUTES les variables --holaf-* posées par la brique.
    function reset() {
        const el = root();
        // Retire TOUT le set possédé (pas seulement appliedVars) : les clés
        // posées lors d'applications antérieures sont purgées elles aussi.
        if (el) {
            ownedKeys.forEach((k) => el.style.removeProperty(k));
        }
        ownedKeys.clear();
        currentName = null;
        appliedVars = null;
        // Ne réarme PAS le presets initial automatique : après reset, on est
        // « sans thème » jusqu'au prochain choix de l'hôte.
        dispatch(null);
    }

    // ─── API 0.3.0 — registre de packs hôte (additive) ─────────────────────
    // Les 16 presets INTÉGRÉS sont figés : registerPreset ne les touche jamais.
    // Le registre est VOLATILE (perdu au rechargement) : l'hôte ré-enregistre
    // ses packs au boot, avant de rejouer setTheme.
    function isPlainObject(v) {
        return v !== null && typeof v === "object" && !Array.isArray(v);
    }

    function validatePackName(name) {
        const clean = typeof name === "string" ? name.trim() : "";
        if (!clean) {
            throw new Error("[HolafTokens] registerPreset : nom de pack vide (chaîne non vide attendue).");
        }
        if (RESERVED_NAMES.has(clean)) {
            throw new Error(
                '[HolafTokens] registerPreset : nom réservé "' + clean +
                '" (preset intégré, alias ou famille) — choisissez un autre nom.'
            );
        }
        return clean;
    }

    // registerPreset(name, tokens, options?) → { name, vars } (copie protégée).
    // Un nom déjà enregistré est REMPLACÉ (le pack, pas les intégrés). N'émet
    // PAS d'événement : setTheme("<pack>") émet comme n'importe quel preset.
    function registerPreset(name, tokens, options) {
        const packName = validatePackName(name);
        if (tokens !== undefined && !isPlainObject(tokens)) {
            throw new Error("[HolafTokens] registerPreset : tokens attendu sous forme d'objet { clé: valeur }.");
        }
        if (options !== undefined && !isPlainObject(options)) {
            throw new Error("[HolafTokens] registerPreset : options attendu sous forme d'objet { extends?, derive? }.");
        }
        const opts = options || {};
        // Copie protégée : le registre ne partage AUCUNE référence avec l'hôte
        // (ni les tokens, ni le tableau derive).
        const spec = {
            tokens: Object.assign({}, tokens || {}),
            options: {
                extends: opts.extends,
                derive: Array.isArray(opts.derive) ? opts.derive.slice() : opts.derive,
            },
        };
        const resolved = resolvePack(spec.tokens, spec.options);
        PACKS.set(packName, { spec, resolved });
        return { name: packName, vars: Object.assign({}, resolved) };
    }

    // updatePreset(name, tokens) → { name, vars }. Fusionne dans la spec
    // explicite puis re-résout : les dérivées non re-fournies par l'appel sont
    // recalculées depuis les nouvelles sources. Throw si intégré ou inconnu.
    function updatePreset(name, tokens) {
        if (typeof name === "string" && RESERVED_NAMES.has(name)) {
            throw new Error(
                '[HolafTokens] updatePreset : "' + name +
                '" est un preset intégré (figé) — seuls les packs enregistrés sont modifiables.'
            );
        }
        const pack = PACKS.get(name);
        if (!pack) {
            throw new Error(
                '[HolafTokens] updatePreset : pack inconnu "' + String(name) + '" — packs enregistrés : ' +
                (PACKS.size ? Array.from(PACKS.keys()).join(", ") : "(aucun)") + "."
            );
        }
        if (!isPlainObject(tokens)) {
            throw new Error("[HolafTokens] updatePreset : tokens attendu sous forme d'objet { clé: valeur }.");
        }
        Object.assign(pack.spec.tokens, tokens);
        pack.resolved = resolvePack(pack.spec.tokens, pack.spec.options);
        return { name: name, vars: Object.assign({}, pack.resolved) };
    }

    // unregisterPreset(name) → boolean : false si intégré (jamais dans PACKS)
    // ou inconnu. N'émet PAS d'événement ; la palette déjà posée n'est pas retirée.
    function unregisterPreset(name) {
        return PACKS.delete(name);
    }

    // getPreset(name) → copie (clés non préfixées) d'un intégré / alias / pack,
    // null si inconnu. Copie protégée : muter le retour n'affecte pas le registre.
    function getPreset(name) {
        const preset = findPreset(name);
        return preset ? Object.assign({}, preset) : null;
    }

    // alpha(color, a) — utilitaire public : hex → "rgba(r, g, b, a)", alpha
    // borné à [0, 1]. Couleur non-hex ou alpha non numérique → valeur inchangée.
    function alpha(color, a) {
        const c = hexToken(color);
        if (!c) return color;
        if (a !== undefined && (typeof a !== "number" || !isFinite(a))) return color;
        const av = a === undefined ? 1 : Math.max(0, Math.min(1, a));
        return "rgba(" + c[0] + ", " + c[1] + ", " + c[2] + ", " + av + ")";
    }

    // ─── Injection CSS minimale (une seule fois) ────────────────────────────
    // La brique ne rend rien : le CSS injecté est un simple repère documentant
    // que les variables proviennent du JS, rien de scopé. Guard idempotent.
    const CSS_ID = "holaf-tokens-style";
    function ensureCss() {
        if (typeof document === "undefined") return;
        if (document.getElementById(CSS_ID)) return;
        const style = document.createElement("style");
        style.id = CSS_ID;
        style.textContent =
            "/* HolafTokens (FONDATION) : les variables --holaf-* sont posées " +
            "sur :root par cette brique (JS), aucune règle scopée nécessaire " +
            "— la brique est sans rendu. */";
        const head = document.head || document.documentElement;
        if (head) head.appendChild(style);
    }

    // ─── Initialisation au chargement ───────────────────────────────────────
    ensureCss();
    ensureInitial();

    return {
        VERSION,
        setTokens,
        setTheme,
        setFamily,
        getTheme,
        getFamily,
        getMode,
        applyPalette,
        reset,
        listPresets,
        listFamilies,
        // — API 0.3.0 (additive) —
        registerPreset,
        updatePreset,
        unregisterPreset,
        getPreset,
        alpha,
        PREFIX,
        PRESETS: (function () { const c = {}; Object.keys(PRESETS).forEach((k) => { c[k] = Object.assign({}, PRESETS[k]); }); return c; })(),
        FAMILIES: (function () {
            const c = {};
            FAMILY_NAMES.forEach((f) => {
                c[f] = { label: FAMILIES[f].label, hue: FAMILIES[f].hue };
                MODES.forEach((m) => { c[f][m] = Object.assign({}, FAMILIES[f][m]); });
            });
            return c;
        })(),
        ALIASES: Object.assign({}, ALIASES),
        MIGRATIONS: Object.assign({}, MIGRATIONS),
    };
})();

// ─── Exposition (correctif 0.3.0 : AUCUN export top-level) ───────────────────
// Le fichier est chargeable À LA FOIS :
//   • en <script> classique (file:// ET HTTP)   → window.HolafTokens ;
//   • en <script type="module" src>             → window.HolafTokens ;
//   • en import ESM par effet de bord (`import "./holaf-tokens.js"`) → globalThis.
// La ligne `export { HolafTokens }` de la 0.2.0 est SUPPRIMÉE : elle rendait le
// fichier inutilisable en <script> classique (SyntaxError) alors qu'il pose ses
// variables dès l'évaluation. Conséquence : un consommateur doit désormais
// faire `import "./holaf-tokens.js"; const { HolafTokens } = window;`.
if (typeof window !== "undefined") {
    window.HolafTokens = HolafTokens;
} else if (typeof globalThis !== "undefined") {
    globalThis.HolafTokens = HolafTokens;
}
