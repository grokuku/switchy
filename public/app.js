/**
 * Switchy — interface web (Lot 2 : modèle de données + configuration).
 *
 * Quatre responsabilités, AUCUNE logique de passerelle :
 *   1. navigation entre les onglets (Services / Fournisseurs / Réglages) ;
 *   2. le THÈME : la brique `tokens` (vendorisée) est la SEULE à poser les
 *      variables --holaf-* sur :root ; ce fichier choisit un preset
 *      `<famille>-<mode>`, le persiste (`localStorage["switchy.theme"]`) et
 *      ALIGNE les briques modal/toast sur le même preset ;
 *   3. la configuration (Lot 2) : CRUD fournisseurs & services, réglages
 *      globaux, clés d'API — via l'API `/api/*` ;
 *   4. l'ACCÈS : un écran de CONNEXION (mot de passe admin + session, cookie
 *      signé HMAC) est la page d'entrée ; AUCUN contenu applicatif n'est
 *      affiché avant authentification. Les clés d'API des outils restent
 *      gérées dans l'onglet Réglages.
 *
 * Le premier rendu (anti-flash) est déjà posé par le boot inline du <head>.
 *
 * CSP / CSS : les feuilles de modal/toast sont servies en FICHIERS statiques
 * (public/vendor/holaf/*.css, extraits par scripts/extract-holaf-css.mjs),
 * d'où `configure({ injectStyles: false })` — aucune balise <style> ni attribut
 * `style=` n'est posé (CSP `style-src 'self'`).
 *
 * MISE EN PAGE : PLEINE LARGEUR (aucun `max-width`, aucun centrage).
 *
 * Chargement : ce fichier est un MODULE (comme les briques devant lui dans
 * <body>) — l'exécution est différée et strictement ordonnée, les globales
 * window.Holaf* sont donc déjà posées.
 *
 * ORDRE DES ÉTAPES : glisser-déposer, boutons ↑/↓, libellés (« principal »,
 * « repli n ») et conversion liste ↔ `{principal, fallbacks}` viennent de
 * `./service-steps.js` — la carte ET la fenêtre « Modifier » partagent donc
 * exactement la même logique (aucune duplication).
 */
import {
  dropToIndex,
  moveStep,
  nonEmptySteps,
  serviceToSteps,
  stepRoleLabel,
  stepsToServiceShape,
} from "./service-steps.js";
(() => {
  "use strict";

  // ── Briques holaf ────────────────────────────────────────────────────────
  const tokens = window.HolafTokens || null;
  const icons = window.HolafIcons || null;
  const modal = window.HolafModal || null;
  const toast = window.HolafToast || null;
  const http = window.HolafFetch || null;

  // ── Onglets ──────────────────────────────────────────────────────────────

  const tabs = Array.from(document.querySelectorAll(".tab"));
  const panels = {
    services: document.getElementById("panel-services"),
    activity: document.getElementById("panel-activity"),
    providers: document.getElementById("panel-providers"),
    settings: document.getElementById("panel-settings"),
  };

  /** Onglet affiché (sert à ne PAS rafraîchir un onglet inactif). */
  let activeTab = "services";

  /** Affiche l'onglet demandé et masque les autres. */
  function activate(name) {
    activeTab = name;
    for (const tab of tabs) {
      const selected = tab.dataset.tab === name;
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", selected ? "true" : "false");
    }
    for (const [key, panel] of Object.entries(panels)) {
      if (panel) panel.hidden = key !== name;
    }
    if (name === "providers") loadProviders();
    else if (name === "settings") loadSettings();
    else if (name === "activity") {
      loadDashboard();
      startDashboardAutoRefresh();
    } else loadServices();
    // L'auto-rafraîchissement ne tourne QUE sur l'onglet Activité.
    if (name !== "activity") stopDashboardAutoRefresh();
  }

  // ── Thème (brique tokens) ────────────────────────────────────────────────

  /** Clé de persistance (relue par le boot inline du <head> au chargement). */
  const STORAGE_KEY = "switchy.theme";
  /** Preset par défaut, aligné sur le markup (`data-theme`) et le boot. */
  const DEFAULT_THEME = "neutre-dark";

  const root = document.documentElement;

  const themeControl = document.getElementById("theme-control");
  const familySelect = document.getElementById("theme-family");
  const modeToggle = document.getElementById("theme-toggle");

  /** État courant du sélecteur (toujours un preset appliqué). */
  let currentFamily = "neutre";
  let currentMode = "dark";

  // Feuilles servies en fichiers : jamais d'injection <style> par les briques.
  if (modal && typeof modal.configure === "function") {
    modal.configure({ injectStyles: false });
  }
  if (toast && typeof toast.configure === "function") {
    toast.configure({ injectStyles: false });
  }

  /** Découpe « famille-mode » (le mode est le DERNIER segment). */
  function splitPreset(preset) {
    const dash = String(preset).lastIndexOf("-");
    if (dash <= 0) return { family: String(preset), mode: "dark" };
    return { family: String(preset).slice(0, dash), mode: String(preset).slice(dash + 1) };
  }

  /**
   * Nom équivalent pour les catalogues modal/toast : ils connaissent les
   * 12 presets <famille>-<mode> des 6 familles couleur, PAS la famille
   * d'identité `matrix` (propre à la brique tokens) → repli sur `neutre-<mode>`.
   */
  function bridgePreset(preset) {
    const { family, mode } = splitPreset(preset);
    return family === "matrix" ? `neutre-${mode}` : preset;
  }

  /** Persiste le choix (mode privé / quota : toute erreur est non bloquante). */
  function saveTheme(preset) {
    try {
      window.localStorage.setItem(STORAGE_KEY, preset);
    } catch {
      /* Optionnel : le thème reste appliqué jusqu'au rechargement. */
    }
  }

  /**
   * Applique un preset : variables --holaf-* (HolafTokens), `data-theme` pour
   * les sélecteurs locaux (icône clair/sombre, color-scheme), puis alignement
   * modal/toast. Retourne false si la brique n'a rien appliqué.
   */
  function applyTheme(preset, persist) {
    if (!tokens) return false;
    try {
      tokens.setTheme(preset);
    } catch {
      return false;
    }
    root.setAttribute("data-theme", preset);
    if (persist) saveTheme(preset);
    const bridged = bridgePreset(preset);
    if (modal && typeof modal.setTheme === "function") {
      try {
        modal.setTheme(bridged);
      } catch {
        /* Brique optionnelle : la modale garde son thème précédent. */
      }
    }
    if (toast && typeof toast.setTheme === "function") {
      try {
        toast.setTheme(bridged);
      } catch {
        /* Brique optionnelle : le toast garde son thème précédent. */
      }
    }
    return true;
  }

  /** Icônes du bouton de mode (brique icons) — texte de repli sans la brique. */
  function renderModeIcons() {
    if (!modeToggle) return;
    if (icons && typeof icons.render === "function") {
      try {
        modeToggle.innerHTML =
          icons.render("sun", { class: "icon icon--sun" }) +
          icons.render("moon", { class: "icon icon--moon" });
        return;
      } catch {
        /* Nom d'icône indisponible : repli texte ci-dessous. */
      }
    }
    modeToggle.textContent = "◐";
  }

  /** Reflète l'état (famille, mode) dans les contrôles. */
  function setControls(family, mode) {
    currentFamily = family;
    currentMode = mode;
    if (familySelect && familySelect.value !== family) {
      familySelect.value = family;
    }
  }

  /** Construit le sélecteur depuis le catalogue holaf et câble les contrôles. */
  function initTheme() {
    if (!tokens || !themeControl || !familySelect || !modeToggle) return;

    const families = typeof tokens.listFamilies === "function" ? tokens.listFamilies() : [];
    for (const family of families) {
      const option = document.createElement("option");
      option.value = family;
      const label = tokens.FAMILIES && tokens.FAMILIES[family] ? tokens.FAMILIES[family].label : "";
      option.textContent = label || family.charAt(0).toUpperCase() + family.slice(1);
      familySelect.appendChild(option);
    }

    renderModeIcons();

    const applied = typeof tokens.getTheme === "function" ? tokens.getTheme() : null;
    const { family, mode } = splitPreset(applied && applied.name ? applied.name : DEFAULT_THEME);
    setControls(families.includes(family) ? family : "neutre", mode === "light" ? "light" : "dark");
    themeControl.hidden = false;

    function applySelection() {
      if (applyTheme(`${currentFamily}-${currentMode}`, true)) return;
      const fallback = typeof tokens.getTheme === "function" ? tokens.getTheme() : null;
      const { family: family2, mode: mode2 } = splitPreset(
        fallback && fallback.name ? fallback.name : DEFAULT_THEME,
      );
      setControls(family2, mode2 === "light" ? "light" : "dark");
    }

    familySelect.addEventListener("change", () => {
      currentFamily = familySelect.value;
      applySelection();
    });

    modeToggle.addEventListener("click", () => {
      currentMode = currentMode === "light" ? "dark" : "light";
      applySelection();
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Outils DOM
  // ════════════════════════════════════════════════════════════════════════

  const $ = (id) => document.getElementById(id);

  /** Construit un élément DOM sans jamais interpréter de texte utilisateur. */
  function h(tag, opts, ...children) {
    const node = document.createElement(tag);
    opts = opts || {};
    if (opts.class) node.className = opts.class;
    if (opts.text !== undefined) node.textContent = String(opts.text);
    if (opts.value !== undefined) node.value = String(opts.value);
    if (opts.html !== undefined) node.innerHTML = opts.html;
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
    if (opts.on) for (const [k, v] of Object.entries(opts.on)) node.addEventListener(k, v);
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  }

  /** SVG d'une icône de la brique `icons` (chaîne vide sans la brique). */
  function iconHtml(name) {
    if (icons && typeof icons.render === "function") {
      try {
        return icons.render(name);
      } catch {
        return "";
      }
    }
    return "";
  }

  /** Bouton avec icône (brique `icons`) + libellé texte. */
  function iconButton(name, label, opts) {
    opts = opts || {};
    const btn = h("button", {
      class: opts.class || "btn",
      attrs: { type: "button", ...(opts.attrs || {}) },
      on: opts.on,
    });
    const svg = iconHtml(name);
    if (svg) {
      const span = h("span", { class: "icon", html: svg, attrs: { "aria-hidden": "true" } });
      btn.append(span);
    }
    btn.append(document.createTextNode(label));
    return btn;
  }

  /** Petite étiquette d'état (source, redémarrage, activé…). */
  function badge(text, variant) {
    return h("span", { class: "badge" + (variant ? ` badge--${variant}` : ""), text });
  }

  function notify(message, type, opts) {
    if (toast) {
      try {
        const callOpts = opts || {};
        if (type === "error") toast.error(message, callOpts);
        else if (type === "warning") toast.warning(message, callOpts);
        else if (type === "info") toast.info(message, callOpts);
        else toast.success(message, callOpts);
        return;
      } catch {
        /* Brique indisponible : repli console ci-dessous. */
      }
    }
    if (type === "error") console.error("[switchy]", message);
    else console.log("[switchy]", message);
  }

  /**
   * Confirmation destructive via la brique `modal` (repli `window.confirm`).
   * Retourne une promesse booléenne — jamais d'exception.
   */
  function confirmAction(title, message, opts) {
    opts = opts || {};
    if (modal && typeof modal.confirm === "function") {
      return Promise.resolve(modal.confirm(title, message, opts))
        .then(Boolean)
        .catch(() => false);
    }
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }

  function showAlert(title, message) {
    if (modal && typeof modal.alert === "function") {
      try {
        return modal.alert(title, message);
      } catch {
        /* repli ci-dessous */
      }
    }
    window.alert(`${title}\n\n${message}`);
    return null;
  }

  /**
   * Copie `text` dans le presse-papiers (best-effort). Retourne une promesse
   * booléenne : true UNIQUEMENT si la copie a réellement réussi.
   */
  async function copyText(text) {
    const value = String(text == null ? "" : text);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        /* Contexte non sécurisé / permission refusée : repli ci-dessous. */
      }
    }
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.setAttribute("aria-hidden", "true");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.append(area);
    let ok = false;
    try {
      area.select();
      area.setSelectionRange(0, value.length);
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return !!ok;
  }

  const DATE_FMT = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
  function fmtDate(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    return DATE_FMT.format(date);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Client API (brique fetch ; repli natif si absente)
  // ════════════════════════════════════════════════════════════════════════

  /** Repli sans dépendance : fetch natif + JSON vérifié + erreur typée. */
  async function nativeRequest(path, init) {
    const opts = {
      method: init.method,
      credentials: "same-origin",
      headers: { ...(init.headers || {}) },
    };
    if (init.body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(init.body);
    }
    const res = await fetch(path, opts);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.detail)) || `Erreur HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      err.body = text;
      throw err;
    }
    return data;
  }

  /**
   * Appel API JSON. Le navigateur s'authentifie par SA SESSION (cookie) : aucun
   * en-tête de clé n'est posé (les clés d'API restent réservées aux outils).
   * Sur les mutations, le jeton CSRF de session est renvoyé en `X-CSRF-Token`
   * (double-submit avec le cookie `switchy_csrf`).
   */
  function apiRequest(path, options) {
    options = options || {};
    const method = String(options.method || "GET").toUpperCase();
    const init = {
      method,
      headers: {},
      credentials: "same-origin",
      timeout: 20000,
    };
    if (state.csrfToken && method !== "GET" && method !== "HEAD") {
      init.headers["X-CSRF-Token"] = state.csrfToken;
    }
    if (options.body !== undefined) init.body = options.body;
    if (http && typeof http.request === "function") {
      return Promise.resolve(http.request(path, init));
    }
    return nativeRequest(path, init);
  }

  /** Affiche/masque le bandeau « mot de passe par défaut » (session requise). */
  function showDefaultPasswordBanner(show) {
    const banner = $("default-password-banner");
    if (banner) banner.hidden = !show;
  }

  function handleApiError(err, fallbackMessage) {
    const status = err && err.status;
    const code = err && err.data && err.data.code;
    if (status === 401) {
      // Session absente/expirée : retour à l'écran de connexion SEUL.
      showLogin();
      notify(fallbackMessage || "Session expirée — reconnectez-vous.", "error");
      return;
    }
    if (status === 403 && code === "PASSWORD_NOT_CHANGED") {
      showDefaultPasswordBanner(true);
      notify("Changez le mot de passe administrateur par défaut avant cette action.", "error");
      return;
    }
    if (status === 400 || status === 409) {
      const errors = err && err.data && Array.isArray(err.data.errors) ? err.data.errors : [];
      notify(errors.length ? errors.join(" ; ") : (err.message || fallbackMessage || "Requête invalide."), "error");
      return;
    }
    if (status === 404) {
      notify((err && err.message) || "Ressource introuvable.", "error");
      return;
    }
    notify((err && err.message) || fallbackMessage || "Une erreur est survenue.", "error");
  }

  // ════════════════════════════════════════════════════════════════════════
  // État partagé
  // ════════════════════════════════════════════════════════════════════════

  const state = {
    providers: [],
    services: [],
    settingsGroups: [],
    keys: [],
    authenticated: false,
    passwordIsDefault: false,
    csrfToken: null,
  };

  const PROVIDER_TYPES = [
    { value: "openai-compatible", label: "OpenAI-compatible (/v1)" },
    { value: "ollama-native", label: "Ollama (API native)" },
    { value: "anthropic", label: "Anthropic" },
    { value: "google", label: "Google" },
  ];

  // ════════════════════════════════════════════════════════════════════════
  // Niveaux de réflexion
  //
  // La LISTE proposée vient de la DÉTECTION du fournisseur (`reasoningLevels`
  // et `reasoningDefault` renvoyés par `/api/providers/:id/models/:model`) ;
  // il n'y a donc AUCUNE liste figée en dur. Le standard OpenAI ne sert que de
  // repli quand le fournisseur n'expose rien. Ce bloc ne fait que NOMMER les
  // niveaux (le vocabulaire interne est partagé avec le serveur).
  // ════════════════════════════════════════════════════════════════════════

  const REASONING_LABELS = {
    off: "désactivée",
    minimal: "minimale",
    low: "faible",
    medium: "moyenne",
    high: "élevée",
    xhigh: "très élevée",
    max: "maximale",
  };

  /** Repli quand le fournisseur n'expose rien (affiché honnêtement, jamais « détecté »). */
  const STANDARD_REASONING_LEVELS = ["off", "low", "medium", "high"];

  function reasoningLabel(value) {
    return REASONING_LABELS[value] || value;
  }

  function reasoningOptions(levels) {
    const list = Array.isArray(levels) && levels.length ? levels : STANDARD_REASONING_LEVELS;
    return list.map((value) => ({ value, label: reasoningLabel(value) }));
  }

  /**
   * Remplit un <select> depuis la DÉTECTION serveur et renvoie une phrase d'état,
   * ou `null` si le fournisseur n'a rien exposé (on laisse le sélecteur tel quel).
   *
   * `preserve` = ne JAMAIS remplacer le niveau enregistré (édition) ; sinon on
   * propose le niveau par défaut du modèle quand il est connu et supporté.
   * ⚠️ Un niveau enregistré absent de la détection est CONSERVÉ (tolérance : un
   * service antérieur ne doit jamais être modifié en silence — le serveur le
   * replie à l'envoi sur le niveau supporté le plus proche).
   */
  function applyDetectedReasoning(select, info, preserve) {
    const detected = Array.isArray(info && info.reasoningLevels)
      ? info.reasoningLevels.filter(Boolean)
      : [];
    if (detected.length === 0) return null;
    const current = select.value;
    const list = detected.slice();
    if (current && !list.includes(current)) list.unshift(current);
    select.replaceChildren();
    for (const value of list) select.append(h("option", { value, text: reasoningLabel(value) }));
    const def = info.reasoningDefault;
    if (!preserve && def && list.includes(def)) select.value = def;
    else if (list.includes(current)) select.value = current;
    else select.value = list[0];
    const labels = detected.map(reasoningLabel).join(", ");
    const defNote = def ? ` — défaut du modèle : ${reasoningLabel(def)}` : "";
    return `réflexion : ${labels}${defNote}`;
  }

  function providerLabel(id) {
    const found = state.providers.find((p) => p.id === id);
    return found ? found.label || found.id : `(inconnu: ${id})`;
  }

  function typeLabel(value) {
    const found = PROVIDER_TYPES.find((t) => t.value === value);
    return found ? found.label : value;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Formulaires : petits constructeurs réutilisables
  // ════════════════════════════════════════════════════════════════════════

  let fieldSeq = 0;
  function nextId(prefix) {
    fieldSeq += 1;
    return `${prefix}-${fieldSeq}`;
  }

  /** Champ étiqueté (label relié au contrôle). */
  function field(labelText, control, hint) {
    if (!control.id) control.id = nextId("f");
    const wrap = h("div", { class: "field" });
    wrap.append(h("label", { text: labelText, attrs: { for: control.id } }));
    wrap.append(control);
    if (hint) wrap.append(h("span", { class: "field-hint muted", text: hint }));
    return wrap;
  }

  function buildSelect(options, value, extraClass) {
    const sel = h("select", { class: extraClass || "" });
    for (const opt of options) sel.append(h("option", { text: opt.label, value: opt.value }));
    sel.value = value !== undefined && value !== null ? String(value) : "";
    return sel;
  }

  function inputText(value, type) {
    return h("input", { value: value == null ? "" : value, attrs: { type: type || "text" } });
  }

  function inputNumber(value, min, max) {
    const input = h("input", { value: value == null ? "" : String(value), attrs: { type: "number" } });
    if (min !== undefined) input.setAttribute("min", String(min));
    if (max !== undefined) input.setAttribute("max", String(max));
    return input;
  }

  function checkbox(checked, labelText) {
    const wrap = h("label", { class: "checkbox" });
    const input = h("input", { attrs: { type: "checkbox" } });
    input.checked = !!checked;
    wrap.append(input, document.createTextNode(" " + labelText));
    return { wrap, input };
  }

  /** Sous-titre de section dans un formulaire. */
  function formSection(title) {
    return h("h4", { class: "form-section-title", text: title });
  }

  /**
   * Ouvre une modale de formulaire : le contenu est le `<form>` fourni, la
   * soumission est déclenchée par l'action « Enregistrer » (bouton associé au
   * formulaire via `form=`). `save()` fait l'appel réseau ; à la réussite la
   * modale se ferme, à l'échec le message d'erreur est affiché sans fermer.
   */
  function openForm({ modalId, title, form, save }) {
    let ctrl = null;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (ctrl) ctrl.setBusy(true, "Enregistrement…");
      try {
        await save();
        if (ctrl) ctrl.close(true);
      } catch (err) {
        if (ctrl) ctrl.setBusy(false);
        handleApiError(err, "Échec de l'enregistrement.");
      }
    });

    if (!modal || typeof modal.open !== "function") {
      notify("La modale est indisponible : rechargez la page.", "error");
      return null;
    }
    ctrl = modal.open({
      id: modalId,
      title,
      size: "xl",
      content: form,
      actions: [
        { label: "Annuler", type: "cancel" },
        { label: "Enregistrer", type: "primary", form: form.id },
      ],
    });
    return ctrl;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Modèles du fournisseur (combobox + capacités)
  //
  // Switchy interroge le FOURNISSEUR (avec sa clé) pour proposer ses modèles ;
  // la liste est mise en cache côté page (le fournisseur n'est pas questionné à
  // chaque frappe) et un bouton « rafraîchir » la force. Le champ reste TOUJOURS
  // saisissable à la main (un modèle absent de la liste reste utilisable).
  // ════════════════════════════════════════════════════════════════════════

  /** Cache page : identifiant de fournisseur → liste d'identifiants de modèles. */
  const modelLists = new Map();

  async function fetchProviderModels(providerId, force) {
    if (!providerId) return [];
    if (!force && modelLists.has(providerId)) return modelLists.get(providerId);
    const data = await apiRequest(
      `/api/providers/${encodeURIComponent(providerId)}/models${force ? "?refresh=1" : ""}`,
    );
    const models = Array.isArray(data && data.models)
      ? data.models.map((m) => m && m.id).filter(Boolean)
      : [];
    modelLists.set(providerId, models);
    return models;
  }

  /**
   * Combobox de modèle : champ texte LIBRE + champ de filtre + liste déroulante
   * alimentée par le fournisseur + bouton « rafraîchir » + ligne d'état.
   * `onSelect(model)` est appelé à chaque sélection (ou saisie validée).
   */
  function modelCombo(opts) {
    opts = opts || {};
    const valueInput = inputText(opts.value || "");
    valueInput.setAttribute("placeholder", "modèle (saisie libre possible)");
    valueInput.setAttribute("aria-label", opts.label || "modèle");
    const filterInput = inputText("");
    filterInput.setAttribute("placeholder", "filtrer les modèles…");
    filterInput.setAttribute("aria-label", "filtrer les modèles");
    const list = h("select", {
      class: "model-list",
      attrs: { size: "6", "aria-label": "modèles proposés" },
    });
    const status = h("p", { class: "model-status muted" });
    const refreshBtn = iconButton("refresh", "Rafraîchir", {
      class: "btn btn--ghost btn--icon",
      attrs: { title: "Interroger à nouveau le fournisseur" },
    });

    let providerId = opts.providerId || "";
    let loading = false;

    function renderOptions() {
      const all = modelLists.get(providerId) || [];
      const filter = filterInput.value.trim().toLowerCase();
      const visible = filter ? all.filter((m) => m.toLowerCase().includes(filter)) : all;
      list.replaceChildren();
      for (const m of visible) list.append(h("option", { value: m, text: m, attrs: { title: m } }));
      if (valueInput.value && !visible.includes(valueInput.value)) {
        list.prepend(h("option", { value: valueInput.value, text: valueInput.value }));
      }
      list.value = valueInput.value;
      if (!loading) {
        status.textContent = all.length
          ? `${visible.length} / ${all.length} modèle(s)`
          : "Aucun modèle listé — saisissez l'identifiant à la main.";
      }
    }

    async function load(force) {
      if (!providerId) {
        list.replaceChildren();
        status.textContent = "";
        return;
      }
      loading = true;
      status.textContent = "Interrogation du fournisseur…";
      try {
        await fetchProviderModels(providerId, force);
      } catch (err) {
        modelLists.delete(providerId);
        status.textContent = (err && err.message) || "Fournisseur injoignable.";
      } finally {
        loading = false;
      }
      renderOptions();
    }

    list.addEventListener("change", () => {
      valueInput.value = list.value;
      if (opts.onSelect) opts.onSelect(list.value);
    });
    filterInput.addEventListener("input", renderOptions);
    valueInput.addEventListener("change", () => {
      if (opts.onSelect) opts.onSelect(valueInput.value.trim());
    });
    refreshBtn.addEventListener("click", () => {
      void load(true);
    });

    const wrap = h(
      "div",
      { class: "model-combo" },
      h("div", { class: "model-combo-top" }, valueInput, refreshBtn),
      filterInput,
      list,
      status,
    );

    void load(false);

    return {
      wrap,
      getValue: () => valueInput.value.trim(),
      setValue: (v) => {
        valueInput.value = v == null ? "" : String(v);
        renderOptions();
      },
      setProvider: (id) => {
        providerId = id || "";
        renderOptions();
        void load(false);
      },
    };
  }

  /**
   * Champ modèle compact pour une ligne de repli : `<input list>` alimenté par
   * les modèles du fournisseur choisi (filtrage natif + saisie libre).
   */
  function modelInputWithSuggestions(providerId, value) {
    const input = inputText(value);
    input.setAttribute("placeholder", "modèle");
    input.setAttribute("aria-label", "modèle du repli");
    const listId = nextId("models");
    input.setAttribute("list", listId);
    const datalist = h("datalist", { attrs: { id: listId } });

    async function load(id) {
      datalist.replaceChildren();
      if (!id) return;
      try {
        const models = await fetchProviderModels(id, false);
        for (const m of models) datalist.append(h("option", { value: m }));
      } catch {
        /* Fournisseur injoignable : la saisie libre reste possible. */
      }
    }
    void load(providerId);

    return { input, datalist, setProvider: load };
  }

  // ════════════════════════════════════════════════════════════════════════
  // Fournisseurs
  // ════════════════════════════════════════════════════════════════════════

  async function loadProviders() {
    try {
      const data = await apiRequest("/api/providers");
      state.providers = Array.isArray(data && data.providers) ? data.providers : [];
      renderProviders();
    } catch (err) {
      handleApiError(err, "Impossible de charger les fournisseurs.");
    }
  }

  function renderProviders() {
    const list = $("providers-list");
    const empty = $("providers-empty");
    const status = $("providers-status");
    if (!list || !empty) return;

    const filter = ($("providers-filter") && $("providers-filter").value.trim().toLowerCase()) || "";
    const visible = state.providers.filter((p) => {
      if (!filter) return true;
      return [p.id, p.label, p.type].some((v) => String(v || "").toLowerCase().includes(filter));
    });

    list.replaceChildren();
    if (state.providers.length === 0) {
      empty.hidden = false;
      empty.textContent = "Aucun fournisseur. Créez-en un pour relier un service.";
      if (status) status.textContent = "";
      return;
    }
    if (visible.length === 0) {
      empty.hidden = false;
      empty.textContent = "Aucun fournisseur ne correspond au filtre.";
      if (status) status.textContent = "";
      return;
    }
    empty.hidden = true;
    if (status) status.textContent = `${visible.length} / ${state.providers.length}`;

    for (const p of visible) list.append(renderProviderCard(p));
  }

  function renderProviderCard(p) {
    const card = h("article", { class: "card item-card" });

    const head = h("header", { class: "item-head" });
    // Titre tronqué à une ligne (CSS) : l'infobulle garde le libellé complet.
    const providerTitle = p.label || p.id;
    head.append(h("h3", { class: "item-title", text: providerTitle, attrs: { title: providerTitle } }));
    const badges = h("div", { class: "badges" });
    badges.append(badge(p.id, "id"));
    badges.append(badge(typeLabel(p.type)));
    badges.append(p.enabled ? badge("activé", "ok") : badge("désactivé", "warn"));
    badges.append(
      p.apiKey && p.apiKey.configured ? badge("clé configurée", "ok") : badge("sans clé", "warn"),
    );
    head.append(badges);

    const actions = h("div", { class: "item-actions" });
    actions.append(iconButton("pencil", "Modifier", { on: { click: () => openProviderForm(p) } }));
    actions.append(
      iconButton("trash", "Supprimer", {
        class: "btn btn--danger",
        on: { click: () => deleteProvider(p) },
      }),
    );
    head.append(actions);
    card.append(head);

    const dl = h("dl", { class: "kv" });
    dl.append(h("div", null, h("dt", { text: "/v1" }), h("dd", { text: p.baseUrl })));
    if (p.nativeUrl) dl.append(h("div", null, h("dt", { text: "native" }), h("dd", { text: p.nativeUrl })));
    dl.append(
      h(
        "div",
        null,
        h("dt", { text: "simultané" }),
        h("dd", {
          text:
            p.maxConcurrency !== undefined && p.maxConcurrency !== null
              ? `${p.maxConcurrency} appel(s) / compte`
              : "défaut global",
        }),
      ),
    );
    dl.append(
      h(
        "div",
        null,
        h("dt", { text: "clé" }),
        h("dd", { text: p.apiKey && p.apiKey.configured ? `configurée ${p.apiKey.preview}` : "—" }),
      ),
    );
    card.append(dl);
    return card;
  }

  function openProviderForm(provider) {
    const editing = !!provider;
    const form = h("form", { class: "form-grid", attrs: { id: nextId("provider-form") } });

    const idInput = inputText(editing ? provider.id : "");
    idInput.setAttribute("placeholder", "ex. ollama-cloud");
    if (editing) idInput.disabled = true;
    idInput.required = true;
    form.append(field("identifiant (id)", idInput, "Lettres, chiffres, . _ - (unique)"));

    const labelInput = inputText(editing ? provider.label : "");
    labelInput.required = true;
    form.append(field("libellé", labelInput));

    const typeSelect = buildSelect(PROVIDER_TYPES, editing ? provider.type : "openai-compatible");
    form.append(field("type", typeSelect));

    const baseInput = inputText(editing ? provider.baseUrl : "");
    baseInput.setAttribute("placeholder", "https://ollama.com/v1");
    baseInput.required = true;
    form.append(field("URL /v1 (OpenAI-compatible)", baseInput));

    const nativeInput = inputText(editing ? provider.nativeUrl || "" : "");
    nativeInput.setAttribute("placeholder", "https://ollama.com/api");
    form.append(field("URL native (optionnelle)", nativeInput, "Découverte des modèles (ex. Ollama /api/tags)"));

    // Limite de concurrence DU COMPTE (la limite appartient au fournisseur).
    const concurrencyInput = inputNumber(
      editing && provider.maxConcurrency !== undefined && provider.maxConcurrency !== null ? provider.maxConcurrency : "",
      1,
      1000,
    );
    concurrencyInput.setAttribute("placeholder", "défaut global (3)");
    form.append(
      field(
        "appels simultanés du compte",
        concurrencyInput,
        "Limite du COMPTE chez ce fournisseur (ex. 3 pour Ollama Pro). Laisser vide = valeur par défaut globale. Minimum 1.",
      ),
    );

    // Clé : jamais réaffichée. Champ vide = inchangé.
    const keyWrap = h("div", { class: "field" });
    const keyLabel = h("label", { text: "clé d'API du fournisseur" });
    const keyInput = h("input", { attrs: { type: "password", autocomplete: "new-password" } });
    keyInput.id = nextId("f");
    keyLabel.setAttribute("for", keyInput.id);
    const keyState = h("div", { class: "field-inline" });
    if (editing && provider.apiKey && provider.apiKey.configured) {
      keyState.append(badge("configurée", "ok"), h("span", { class: "muted", text: provider.apiKey.preview }));
    } else {
      keyState.append(badge("non configurée", "warn"));
    }
    keyInput.setAttribute("placeholder", editing ? "•••• (vide = inchangé)" : "clé du fournisseur");
    const clearKey = checkbox(false, "Effacer la clé");
    keyWrap.append(keyLabel, keyInput, keyState, clearKey.wrap);
    form.append(keyWrap);

    const enabledBox = checkbox(editing ? provider.enabled !== false : true, "Activé");
    form.append(enabledBox.wrap);

    openForm({
      modalId: "provider-form",
      title: editing ? `Fournisseur — ${provider.id}` : "Nouveau fournisseur",
      form,
      save: async () => {
        const body = {
          label: labelInput.value.trim(),
          type: typeSelect.value,
          baseUrl: baseInput.value.trim(),
          nativeUrl: nativeInput.value.trim(),
          enabled: enabledBox.input.checked,
        };
        const mcRaw = concurrencyInput.value.trim();
        if (mcRaw !== "") body.maxConcurrency = Number(mcRaw);
        else if (editing) body.maxConcurrency = null; // retour au défaut global
        if (editing) {
          if (clearKey.input.checked) body.apiKey = null;
          else if (keyInput.value.trim() !== "") body.apiKey = keyInput.value.trim();
          await apiRequest(`/api/providers/${encodeURIComponent(provider.id)}`, { method: "PUT", body });
          notify(`Fournisseur « ${provider.id} » mis à jour.`);
        } else {
          body.id = idInput.value.trim();
          if (keyInput.value.trim() !== "") body.apiKey = keyInput.value.trim();
          await apiRequest("/api/providers", { method: "POST", body });
          notify(`Fournisseur « ${body.id} » créé.`);
        }
        await loadProviders();
      },
    });
  }

  async function deleteProvider(provider) {
    const ok = await confirmAction(
      "Supprimer le fournisseur",
      `Supprimer « ${provider.label || provider.id} » ? Cette action est définitive. Un fournisseur utilisé par un service ne peut pas être supprimé.`,
      { danger: true, confirmText: "Supprimer" },
    );
    if (!ok) return;
    try {
      await apiRequest(`/api/providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      notify(`Fournisseur « ${provider.id} » supprimé.`);
      await loadProviders();
    } catch (err) {
      handleApiError(err, "Échec de la suppression.");
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Services
  // ════════════════════════════════════════════════════════════════════════

  async function loadServices() {
    try {
      // Les fournisseurs alimentent les menus du formulaire : on les charge aussi.
      const [servicesData, providersData] = await Promise.all([
        apiRequest("/api/services"),
        apiRequest("/api/providers").catch(() => null),
      ]);
      state.services = Array.isArray(servicesData && servicesData.services) ? servicesData.services : [];
      if (providersData && Array.isArray(providersData.providers)) state.providers = providersData.providers;
      renderServices();
    } catch (err) {
      handleApiError(err, "Impossible de charger les services.");
    }
  }

  function servicesView() {
    const filter = ($("services-filter") && $("services-filter").value.trim().toLowerCase()) || "";
    return state.services.filter((s) => {
      if (!filter) return true;
      const hay = [s.name, s.description, s.principal && s.principal.model, providerLabel(s.principal && s.principal.providerId)];
      for (const f of s.fallbacks || []) hay.push(f.model, providerLabel(f.providerId));
      return hay.some((v) => String(v || "").toLowerCase().includes(filter));
    });
  }

  function renderServices() {
    const list = $("services-list");
    const empty = $("services-empty");
    const status = $("services-status");
    if (!list || !empty) return;

    const visible = servicesView();
    list.replaceChildren();
    if (state.services.length === 0) {
      empty.hidden = false;
      empty.textContent = "Aucun service. Créez-en un pour exposer un nom aux autres projets.";
      if (status) status.textContent = "";
      return;
    }
    if (visible.length === 0) {
      empty.hidden = false;
      empty.textContent = "Aucun service ne correspond au filtre.";
      if (status) status.textContent = "";
      return;
    }
    empty.hidden = true;
    if (status) status.textContent = `${visible.length} / ${state.services.length}`;

    for (const s of visible) list.append(renderServiceCard(s));
  }

  function renderServiceCard(s) {
    const card = h("article", { class: "card item-card" });

    const head = h("header", { class: "item-head" });
    // Titre tronqué à une ligne (CSS) : l'infobulle garde le nom complet.
    head.append(h("h3", { class: "item-title", text: s.name, attrs: { title: s.name } }));
    const badges = h("div", { class: "badges" });
    badges.append(s.enabled ? badge("activé", "ok") : badge("désactivé", "warn"));
    if (s.prioritaire) badges.append(badge("prioritaire", "env"));
    if (s.vision) badges.append(badge("vision", "ok"));
    badges.append(badge(`${s.fallbacks ? s.fallbacks.length : 0} repli(s)`));
    head.append(badges);

    const actions = h("div", { class: "item-actions" });
    actions.append(iconButton("pencil", "Modifier", { on: { click: () => openServiceForm(s) } }));
    actions.append(
      iconButton("trash", "Supprimer", {
        class: "btn btn--danger",
        on: { click: () => deleteService(s) },
      }),
    );
    head.append(actions);
    card.append(head);

    if (s.description) card.append(h("p", { class: "item-desc muted", text: s.description }));

    const stepsEl = h("ol", { class: "steps steps--sortable" });
    let currentSteps = serviceToSteps(s);
    const drawSteps = () => {
      stepsEl.replaceChildren();
      currentSteps.forEach((step, index) => {
        stepsEl.append(cardStepItem(step, index, currentSteps.length, (from, to) => void reorderServiceSteps(s, from, to)));
      });
    };
    drawSteps();
    attachStepReordering(stepsEl, (from, to) => void reorderServiceSteps(s, from, to));
    card.append(stepsEl);

    const dl = h("dl", { class: "kv" });
    dl.append(h("div", null, h("dt", { text: "contexte" }), h("dd", { text: formatNumber(s.contextWindow) })));
    dl.append(h("div", null, h("dt", { text: "tokens max" }), h("dd", { text: formatNumber(s.maxOutputTokens) })));
    if (s.prioritaire) {
      dl.append(h("div", null, h("dt", { text: "priorité" }), h("dd", { text: "passe en premier" })));
    }
    card.append(dl);
    return card;
  }

  /**
   * Une étape de la CARTE : poignée de glisser + boutons ↑/↓.
   * La persistance est IMMÉDIATE (aucun bouton « Enregistrer ») : `onMove`
   * remonte des index de liste, traités par `reorderServiceSteps`.
   */
  function cardStepItem(step, index, total, onMove) {
    const li = h("li", { class: "step step--sortable", attrs: { "data-step-index": String(index) } });
    const role = stepRoleLabel(index);
    const grip = stepGrip(role);
    li.append(grip);
    // Bloc central : libellé + modèle + fournisseur + réflexion (une seule
    // colonne, pour que les flèches restent TOUJOURS alignées à droite).
    const main = h("div", { class: "step-main" });
    main.append(h("span", { class: "step-role", text: role }));
    main.append(h("span", { class: "step-model", text: step.model }));
    main.append(h("span", { class: "step-provider muted", text: providerLabel(step.providerId) }));
    main.append(h("span", { class: "step-reason muted", text: `réflexion: ${step.reasoning || "off"}` }));
    li.append(main);
    const tools = stepMoveTools(index, total, role, onMove);
    li.append(tools.wrap);
    // Une seule étape : ni poignée ni flèches (rien à déplacer).
    if (total < 2) {
      grip.hidden = true;
      tools.wrap.hidden = true;
    }
    return li;
  }

  /** Poignée de préhension EXPLICITE : seule zone qui démarre un glisser. */
  function stepGrip(role) {
    return h("span", {
      class: "step-grip",
      text: "⠿",
      attrs: {
        draggable: "true",
        "aria-hidden": "false",
        role: "button",
        tabindex: "-1",
        title: "Glisser pour changer l'ordre",
        "aria-label": `Déplacer l'étape ${role} (glisser)`,
      },
    });
  }

  /**
   * Boutons ↑/↓ d'une étape — OBLIGATOIRES (clavier, mobile, sans souris).
   * Bornes : les flèches impossibles sont désactivées (et `moveStep` ignore
   * de toute façon un index hors bornes).
   */
  function stepMoveTools(index, total, role, onMove) {
    const wrap = h("div", { class: "step-tools" });
    // Flèche seule à l'écran (le libellé complet reste dans aria-label/title).
    const arrow = (glyph, label, target, disabled) => {
      const btn = h("button", {
        class: "btn btn--ghost btn--icon",
        text: glyph,
        attrs: { type: "button", "aria-label": `${label} ${role}`, title: `${label} ${role}` },
        on: { click: () => onMove(index, target) },
      });
      btn.disabled = disabled;
      return btn;
    };
    const up = arrow("↑", "Monter", index - 1, index === 0);
    const down = arrow("↓", "Descendre", index + 1, index >= total - 1);
    wrap.append(up, down);
    return { wrap, up, down };
  }

  /**
   * Glisser-déposer d'une liste ordonnée d'étapes (`<li data-step-index>` avec
   * une `.step-grip`). UNE SEULE implémentation : la carte et la fenêtre
   * « Modifier » l'utilisent toutes les deux.
   *
   * Seule la POIGNÉE démarre un glisser (`draggable` sur elle) : un clic sur
   * « Modifier » / « Supprimer », une sélection de texte ou l'édition d'un
   * champ ne déplacent donc jamais rien.
   */
  function attachStepReordering(listEl, onMove) {
    let draggingIndex = null;

    const clearMarks = () => {
      for (const li of listEl.children) li.classList.remove("is-dragging", "insert-before", "insert-after");
    };

    /** Position d'insertion (0..n) dans la liste ORIGINALE, moitié haute/basse. */
    const insertionIndexAt = (event, li) => {
      const rect = li.getBoundingClientRect();
      const index = Number(li.dataset.stepIndex);
      const after = event.clientY > rect.top + rect.height / 2;
      return after ? index + 1 : index;
    };

    /** `onMove(from, to)` : même contrat que `moveStep`. */
    const fire = (from, to) => {
      if (typeof onMove === "function") onMove(from, to);
    };

    listEl.addEventListener("dragstart", (event) => {
      const grip = event.target && event.target.closest ? event.target.closest(".step-grip") : null;
      if (!grip) {
        // Glisser démarré ailleurs (sélection de texte, bouton…) : on le refuse.
        event.preventDefault();
        return;
      }
      const li = grip.closest("li");
      if (!li || !listEl.contains(li)) {
        event.preventDefault();
        return;
      }
      draggingIndex = Number(li.dataset.stepIndex);
      li.classList.add("is-dragging");
      listEl.classList.add("is-dragging-list");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(draggingIndex));
      }
    });

    listEl.addEventListener("dragover", (event) => {
      if (draggingIndex === null) return;
      const li = event.target && event.target.closest ? event.target.closest("li") : null;
      if (!li || !listEl.contains(li)) return;
      event.preventDefault(); // « drop » autorisé
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const index = Number(li.dataset.stepIndex);
      const insertion = insertionIndexAt(event, li);
      for (const el of listEl.children) el.classList.remove("insert-before", "insert-after");
      if (insertion !== draggingIndex && insertion !== draggingIndex + 1) {
        li.classList.add(insertion > index ? "insert-after" : "insert-before");
      }
    });

    listEl.addEventListener("dragleave", (event) => {
      if (!event.relatedTarget || !listEl.contains(event.relatedTarget)) {
        for (const el of listEl.children) el.classList.remove("insert-before", "insert-after");
      }
    });

    listEl.addEventListener("drop", (event) => {
      if (draggingIndex === null) return;
      event.preventDefault();
      const li = event.target && event.target.closest ? event.target.closest("li") : null;
      const from = draggingIndex;
      const to = li ? dropToIndex(from, insertionIndexAt(event, li)) : from;
      draggingIndex = null;
      clearMarks();
      listEl.classList.remove("is-dragging-list");
      if (to === from) return;
      fire(from, to);
    });

    listEl.addEventListener("dragend", () => {
      draggingIndex = null;
      clearMarks();
      listEl.classList.remove("is-dragging-list");
    });
  }

  /**
   * Persistance IMMÉDIATE de l'ordre des étapes d'un service (carte).
   *
   * Choix d'annulation : `toast` avec bouton « Annuler » (PAS de délai avant
   * enregistrement). Raison : un délai laisse une fenêtre où l'écran montre un
   * ordre non encore enregistré ; ici l'écran bascule tout de suite, puis le
   * serveur confirme. Et si l'enregistrement ÉCHOUE, l'ordre précédent est
   * remis à l'écran et une erreur honnête est affichée — jamais un affichage
   * qui ne correspond pas à ce qui est enregistré.
   */
  async function reorderServiceSteps(service, from, to) {
    const previous = serviceToSteps(service);
    const next = moveStep(previous, from, to);
    if (next.length === 0) return; // jamais de liste vide
    if (sameSteps(previous, next)) return;

    applyStepsToService(service, next); // affichage optimiste
    renderServices();

    try {
      await saveServiceSteps(service, next);
    } catch (err) {
      applyStepsToService(service, previous); // retour à l'ordre réellement enregistré
      renderServices();
      const reason = (err && err.message) || "réseau indisponible";
      notify(`Ordre non enregistré (${reason}). « ${service.name} » garde son ordre précédent.`, "error");
      return;
    }

    notify(`Ordre des étapes de « ${service.name} » enregistré.`, "success", {
      actions: [{ label: "Annuler", onClick: () => void undoServiceSteps(service, previous) }],
    });
  }

  /** « Annuler » du toast : remet l'ordre précédent (et le persiste). */
  async function undoServiceSteps(service, previous) {
    const current = serviceToSteps(service);
    if (sameSteps(current, previous)) return;
    applyStepsToService(service, previous);
    renderServices();
    try {
      await saveServiceSteps(service, previous);
      notify(`Ordre précédent rétabli pour « ${service.name} ».`, "info");
    } catch (err) {
      applyStepsToService(service, current);
      renderServices();
      const reason = (err && err.message) || "réseau indisponible";
      notify(`Annulation impossible (${reason}) : l'ordre enregistré est conservé.`, "error");
    }
  }

  /** Écrit l'ordre dans le service EN MÉMOIRE (l'écran ne ment jamais). */
  function applyStepsToService(service, steps) {
    const shape = stepsToServiceShape(steps);
    if (!shape.principal) return;
    service.principal = shape.principal;
    service.fallbacks = shape.fallbacks;
  }

  /** PUT partiel (le serveur n'exige que les champs fournis). */
  async function saveServiceSteps(service, steps) {
    const shape = stepsToServiceShape(steps);
    if (!shape.principal) throw new Error("un service garde toujours au moins une étape");
    await apiRequest(`/api/services/${encodeURIComponent(service.name)}`, {
      method: "PUT",
      body: { principal: shape.principal, fallbacks: shape.fallbacks },
    });
  }

  const sameSteps = (a, b) => a.length === b.length && a.every((step, i) => step === b[i]);

  function formatNumber(n) {
    const num = Number(n);
    return Number.isFinite(num) ? num.toLocaleString("fr-FR") : String(n == null ? "—" : n);
  }

  /**
   * ÉDITEUR D'ÉTAPES (fenêtre « Modifier ») : UNE liste ordonnée — la 1re étape
   * est le PRINCIPAL, les suivantes sont les replis 1, 2… Chaque ligne porte sa
   * poignée de glisser (⠿), ses boutons ↑/↓ et son couple (fournisseur, modèle,
   * réflexion). Les libellés sont RENUMÉROTÉS à chaque déplacement.
   *
   * `steps()` renvoie la liste ordonnée SANS les lignes restées vides, sauf la
   * 1re (le principal, toujours conservée pour un message d'erreur explicite) ;
   * l'appelant la convertit avec `stepsToServiceShape` — aucune logique de
   * conversion n'est dupliquée ici. `ignoredEmpty()` compte les replis écartés
   * pour pouvoir prévenir l'utilisateur au lieu de les supprimer en silence.
   *
   * `opts.onCapabilities(info)` : capacités du modèle PRINCIPAL (ligne 0),
   * remontées à l'appelant pour pré-remplir contexte / tokens / vision.
   */
  function buildStepsEditor(initialSteps, opts) {
    opts = opts || {};
    const wrap = h("div", { class: "steps-editor-wrap" });
    const rows = h("ol", { class: "steps-editor" });
    const firstProvider = (state.providers[0] && state.providers[0].id) || "";
    let steps =
      Array.isArray(initialSteps) && initialSteps.length > 0
        ? initialSteps.slice()
        : [{ providerId: firstProvider, model: "", reasoning: "off" }];

    /** Relit une ligne du DOM : une saisie en cours n'est jamais perdue. */
    function readRow(li) {
      const providerSel = li.querySelector("select.step-provider-select");
      const modelInput = li.querySelector("input.step-model-input");
      const reasoningSel = li.querySelector("select.step-reasoning-select");
      return {
        providerId: providerSel ? providerSel.value : "",
        model: modelInput ? modelInput.value.trim() : "",
        reasoning: reasoningSel ? reasoningSel.value : "off",
      };
    }

    /** Fige les saisies dans le modèle avant tout re-rendu. */
    function commit() {
      const read = [];
      for (const li of rows.children) read.push(readRow(li));
      if (read.length > 0) steps = read;
    }

    function move(from, to) {
      commit();
      const next = moveStep(steps, from, to);
      if (next.length === 0 || sameSteps(steps, next)) return;
      steps = next;
      draw();
    }

    function removeAt(index) {
      commit();
      if (steps.length <= 1) return; // jamais de liste vide : le principal reste
      if (index < 0 || index >= steps.length) return;
      steps = steps.filter((_, i) => i !== index);
      draw();
    }

    function makeRow(step, index) {
      const li = h("li", { class: "step-editor-row", attrs: { "data-step-index": String(index) } });
      const role = stepRoleLabel(index);

      li.append(stepGrip(role));
      li.append(h("span", { class: "step-role", text: role }));

      const providerSel = buildSelect(
        state.providers.map((p) => ({ value: p.id, label: p.label || p.id })),
        step.providerId || firstProvider,
      );
      providerSel.className = "step-provider-select";
      providerSel.setAttribute("aria-label", `fournisseur — ${role}`);

      const model = modelInputWithSuggestions(step.providerId || providerSel.value, step.model);
      model.input.className = "step-model-input";
      model.input.setAttribute("aria-label", `modèle — ${role}`);

      const reasoningSel = buildSelect(reasoningOptions(null), step.reasoning || "off");
      reasoningSel.className = "step-reasoning-select";
      reasoningSel.setAttribute("aria-label", `réflexion — ${role}`);
      reasoningSel.addEventListener("change", () => {
        reasoningSel.dataset.touched = "1";
      });

      const hint = h("p", { class: "step-hint muted", attrs: { hidden: "hidden" } });

      /**
       * Niveaux de réflexion réels du modèle (détection chez le fournisseur).
       * `userAction` = changement/blur volontaire : seul ce cas remonte les
       * capacités, pour ne jamais écraser une valeur saisie à la main lors
       * d'un simple ré-rendu (déplacement d'étape).
       */
      async function detect(userAction) {
        const providerId = providerSel.value;
        const modelId = model.input.value.trim();
        hint.hidden = true;
        if (!providerId || !modelId) return;
        try {
          const data = await apiRequest(
            `/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`,
          );
          const info = data && data.model ? data.model : null;
          if (!info) return;
          // Un niveau déjà enregistré (≠ défaut « off ») n'est jamais écrasé.
          const preserve =
            reasoningSel.dataset.touched === "1" || (step.reasoning && step.reasoning !== "off");
          const note = info.detected ? applyDetectedReasoning(reasoningSel, info, preserve) : null;
          if (userAction && index === 0 && typeof opts.onCapabilities === "function") opts.onCapabilities(info);
          hint.textContent = note || info.note || "réflexion non exposée — liste standard.";
          hint.hidden = hint.textContent === "";
        } catch (err) {
          hint.textContent = (err && err.message) || "Niveaux de réflexion indisponibles.";
          hint.hidden = false;
        }
      }

      providerSel.addEventListener("change", () => {
        model.setProvider(providerSel.value);
        void detect(true);
      });
      model.input.addEventListener("change", () => void detect(true));
      model.input.addEventListener("blur", () => void detect(true));

      const tools = stepMoveTools(index, steps.length, role, move);
      const removeBtn = h("button", {
        class: "btn btn--ghost btn--icon",
        text: "✕",
        attrs: { type: "button", "aria-label": `Retirer ${role}`, title: `Retirer ${role}` },
        on: { click: () => removeAt(index) },
      });
      removeBtn.disabled = steps.length <= 1;
      tools.wrap.append(removeBtn);
      if (steps.length < 2) {
        li.querySelector(".step-grip").hidden = true;
        tools.up.hidden = true;
        tools.down.hidden = true;
      }

      li.append(providerSel, model.input, model.datalist, reasoningSel, tools.wrap, hint);
      if (step.model) void detect(false);
      return li;
    }

    function draw() {
      rows.replaceChildren();
      steps.forEach((step, index) => rows.append(makeRow(step, index)));
    }

    draw();
    attachStepReordering(rows, move);
    wrap.append(rows);

    const add = iconButton("plus", "Ajouter une étape (repli)", {
      class: "btn",
      on: {
        click: () => {
          commit();
          const last = steps[steps.length - 1];
          steps = steps.concat([
            {
              providerId: (last && last.providerId) || firstProvider,
              model: "",
              reasoning: "off",
            },
          ]);
          draw();
          const lastRow = rows.lastElementChild;
          const input = lastRow && lastRow.querySelector("input.step-model-input");
          if (input) input.focus();
        },
      },
    });
    wrap.append(add);

    return {
      wrap,
      /**
       * Liste ordonnée finale (1re = principal) — lue au moment d'enregistrer.
       * Une ligne de repli sans modèle n'est jamais envoyée au serveur (il la
       * refuserait : `fallbacks[i].model: required`). La 1re ligne est toujours
       * conservée, même vide : c'est le principal, jamais supprimé en silence.
       */
      steps() {
        commit();
        return nonEmptySteps(steps);
      },
      /** Nombre de lignes de repli écartées à l'enregistrement (sans modèle). */
      ignoredEmpty() {
        commit();
        return steps.filter((step, i) => i > 0 && !step.model).length;
      },
    };
  }

  function openServiceForm(service) {
    const editing = !!service;
    if (state.providers.length === 0) {
      notify("Créez d'abord un fournisseur (onglet « Fournisseurs »).", "warning");
      return;
    }

    const form = h("form", { class: "form-grid", attrs: { id: nextId("service-form") } });
    const formId = form.id;

    const nameInput = inputText(editing ? service.name : "");
    nameInput.setAttribute("placeholder", "ex. Deepseek-Fast");
    nameInput.required = true;
    if (editing) nameInput.disabled = true;
    form.append(field("nom du service", nameInput, "Le nom appelé par les clients (unique)"));

    const descInput = h("textarea", { value: editing ? service.description || "" : "", attrs: { rows: "2" } });
    form.append(field("description", descInput));

    const enabledBox = checkbox(editing ? service.enabled !== false : true, "Activé");
    form.append(enabledBox.wrap);

    // Étapes d'appel : UNE liste ordonnée (1re = principal, puis replis 1, 2…).
    // Le glisser-déposer, les flèches et la renumérotation viennent de
    // public/service-steps.js (source de vérité unique, partagée avec la carte).
    form.append(formSection("Étapes d'appel"));
    form.append(
      h("p", {
        class: "field-hint muted",
        text: "La 1re étape est le principal ; les suivantes sont les replis, essayés dans cet ordre. Glissez la poignée ⠿ ou utilisez les flèches ↑/↓ (clavier, mobile).",
      }),
    );
    const stepsEditor = buildStepsEditor(editing ? serviceToSteps(service) : [], { onCapabilities });
    form.append(stepsEditor.wrap);

    // Capacités
    form.append(formSection("Capacités"));
    const caps = h("div", { class: "form-cols" });
    const contextInput = inputNumber(editing ? service.contextWindow : 128000, 1, 100000000);
    contextInput.required = true;
    caps.append(field("taille de contexte", contextInput));
    const maxOutInput = inputNumber(editing ? service.maxOutputTokens : 8192, 1, 10000000);
    maxOutInput.required = true;
    caps.append(field("tokens de sortie max", maxOutInput));
    form.append(caps);

    const visionBox = checkbox(editing ? !!service.vision : false, "Vision (entrée image)");
    form.append(visionBox.wrap);

    const capStatus = h("p", { class: "model-status muted" });

    /**
     * Pré-remplit les capacités du service d'après le modèle PRINCIPAL (1re
     * étape), détecté par l'éditeur d'étapes ; aucune valeur n'est imposée.
     */
    function onCapabilities(info) {
      if (!info) {
        capStatus.textContent = "";
        return;
      }
      if (!info.detected) {
        capStatus.textContent =
          info.note || "Capacités non exposées par ce fournisseur — saisissez-les à la main.";
        return;
      }
      const detected = [];
      if (info.capabilities) {
        visionBox.input.checked = !!info.capabilities.vision;
        detected.push(`vision : ${info.capabilities.vision ? "oui" : "non"}`);
        detected.push(`outils : ${info.capabilities.tools ? "oui" : "non"}`);
        detected.push(`réflexion : ${info.capabilities.thinking ? "oui" : "non"}`);
      }
      if (typeof info.contextWindow === "number") {
        contextInput.value = String(info.contextWindow);
        detected.push(`contexte : ${formatNumber(info.contextWindow)}`);
      }
      if (typeof info.maxOutputTokens === "number") {
        maxOutInput.value = String(info.maxOutputTokens);
        detected.push(`tokens max : ${formatNumber(info.maxOutputTokens)}`);
      }
      capStatus.textContent = `Détecté chez le fournisseur — ${detected.join(" · ")}. Champs pré-remplis, corrigez si besoin.`;
    }

    form.append(capStatus);

    // Priorité (intrinsèque au service — plus aucune réservation par classe).
    form.append(formSection("Priorité"));
    const prioritaireBox = checkbox(editing ? service.prioritaire === true : false, "Prioritaire");
    form.append(prioritaireBox.wrap);
    form.append(
      h("p", {
        class: "field-hint muted",
        text: "Ses appels passent en premier quand une place se libère chez le fournisseur (le léger n'attend pas derrière le lourd).",
      }),
    );

    openForm({
      modalId: "service-form",
      title: editing ? `Service — ${service.name}` : "Nouveau service",
      form,
      save: async () => {
        // Liste ordonnée → forme du catalogue (une seule conversion, partagée).
        const shape = stepsToServiceShape(stepsEditor.steps());
        // Des replis laissés sans modèle sont écartés (comportement historique) :
        // on le dit explicitement plutôt que de les supprimer en silence.
        const ignored = stepsEditor.ignoredEmpty();
        if (ignored > 0) {
          notify(
            ignored === 1
              ? "Une étape de repli sans modèle a été ignorée à l'enregistrement."
              : `${ignored} étapes de repli sans modèle ont été ignorées à l'enregistrement.`,
            "warning",
          );
        }
        if (!shape.principal) throw new Error("Ajoutez au moins une étape : le principal est obligatoire.");
        if (!shape.principal.model) throw new Error("L'étape principale doit avoir un modèle.");
        const body = {
          description: descInput.value.trim(),
          principal: shape.principal,
          fallbacks: shape.fallbacks,
          contextWindow: Number(contextInput.value),
          maxOutputTokens: Number(maxOutInput.value),
          vision: visionBox.input.checked,
          prioritaire: prioritaireBox.input.checked,
          enabled: enabledBox.input.checked,
        };
        if (editing) {
          await apiRequest(`/api/services/${encodeURIComponent(service.name)}`, { method: "PUT", body });
          notify(`Service « ${service.name} » mis à jour.`);
        } else {
          body.name = nameInput.value.trim();
          await apiRequest("/api/services", { method: "POST", body });
          notify(`Service « ${body.name} » créé.`);
        }
        await loadServices();
      },
    });
    // formId conservé pour lisibilité (le bouton Enregistrer est associé via openForm).
    void formId;
  }

  async function deleteService(service) {
    const ok = await confirmAction(
      "Supprimer le service",
      `Supprimer le service « ${service.name} » ? Les clients qui l'appellent par ce nom ne seront plus servis.`,
      { danger: true, confirmText: "Supprimer" },
    );
    if (!ok) return;
    try {
      await apiRequest(`/api/services/${encodeURIComponent(service.name)}`, { method: "DELETE" });
      notify(`Service « ${service.name} » supprimé.`);
      await loadServices();
    } catch (err) {
      handleApiError(err, "Échec de la suppression.");
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Réglages globaux
  // ════════════════════════════════════════════════════════════════════════

  const settingState = new Map();
  const SOURCE_LABEL = { env: "env", file: "fichier", default: "défaut" };

  const GROUP_LABEL = {
    server: "Serveur",
    data: "Données",
    runtime: "Runtime",
    callsLog: "Journal d'appels",
    security: "Sécurité / accès",
  };

  function renderSettings(groups) {
    const container = $("settings-form");
    if (!container) return;
    container.replaceChildren();
    settingState.clear();

    for (const group of groups) {
      const section = h("section", { class: "settings-group" });
      section.append(h("h4", { text: GROUP_LABEL[group.id] || group.id }));
      for (const spec of group.settings) section.append(renderSettingRow(spec));
      container.append(section);
    }
  }

  function renderSettingRow(spec) {
    const row = h("div", { class: "setting-row" });

    const label = h("div", { class: "setting-label" });
    label.append(h("span", { class: "name", text: spec.name }));
    const sourceVariant = spec.source === "env" ? "env" : spec.source === "file" ? "ok" : "warn";
    label.append(badge(SOURCE_LABEL[spec.source] || spec.source, sourceVariant));
    if (spec.restartRequired) label.append(badge("redémarrage requis", "warn"));
    if (!spec.editable) {
      label.append(
        h("span", {
          class: "setting-help",
          text: "Fourni par l'environnement : lecture seule, non modifiable depuis l'interface.",
        }),
      );
    }
    row.append(label);

    const control = h("div", { class: "setting-control" });

    if (spec.sensitive) {
      const configured = spec.configured === true;
      control.append(badge(configured ? "configuré" : "non configuré", configured ? "ok" : "warn"));
      const input = h("input", {
        attrs: {
          type: "password",
          autocomplete: "new-password",
          placeholder: "•••• (vide = inchangé)",
          "aria-label": `Nouvelle valeur de ${spec.name}`,
        },
      });
      if (!spec.editable) input.disabled = true;
      control.append(input);

      let cleared = false;
      const clearBtn = h("button", {
        class: "btn btn--ghost",
        text: "Effacer",
        attrs: { type: "button" },
      });
      if (!spec.editable) {
        clearBtn.disabled = true;
      } else {
        clearBtn.addEventListener("click", () => {
          cleared = !cleared;
          input.disabled = cleared;
          if (cleared) input.value = "";
          clearBtn.textContent = cleared ? "Effacer (annulé)" : "Effacer";
        });
      }
      control.append(clearBtn);

      settingState.set(spec.name, { sensitive: true, editable: spec.editable, input, getCleared: () => cleared });
      row.append(control);
      return row;
    }

    const original = spec.value !== undefined ? String(spec.value) : "";
    let input;
    if (spec.type === "boolean") {
      input = buildSelect([{ value: "true", label: "true" }, { value: "false", label: "false" }], original === "true" ? "true" : "false");
    } else if (spec.type === "number") {
      input = inputNumber(original, spec.min, spec.max);
    } else if (Array.isArray(spec.options) && spec.options.length) {
      input = buildSelect(spec.options.map((o) => ({ value: o, label: o })), original);
    } else {
      input = inputText(original);
    }
    input.setAttribute("aria-label", spec.name);
    if (!spec.editable) input.disabled = true;
    control.append(input);

    settingState.set(spec.name, { sensitive: false, editable: spec.editable, input, original });
    row.append(control);
    return row;
  }

  async function loadSettings() {
    try {
      const data = await apiRequest("/api/settings");
      state.settingsGroups = Array.isArray(data && data.groups) ? data.groups : [];
      renderSettings(state.settingsGroups);
      showDefaultPasswordBanner(state.authenticated && state.passwordIsDefault);
      await loadKeys();
    } catch (err) {
      handleApiError(err, "Impossible de charger les paramètres.");
    }
  }

  async function saveSettings() {
    const payload = {};
    for (const [name, st] of settingState) {
      if (!st.editable) continue;
      if (st.sensitive) {
        if (st.getCleared()) payload[name] = null;
        else if (st.input.value.trim() !== "") payload[name] = st.input.value;
        continue;
      }
      const value = st.input.value;
      if (value !== st.original) payload[name] = value;
    }

    if (Object.keys(payload).length === 0) {
      notify("Aucune modification à enregistrer.", "info");
      return;
    }

    try {
      const data = await apiRequest("/api/settings", { method: "POST", body: { settings: payload } });
      const updated = Array.isArray(data && data.updated) ? data.updated : [];
      notify(`Réglages enregistrés (${updated.length}).`);
      if (Array.isArray(data && data.groups)) {
        state.settingsGroups = data.groups;
        renderSettings(state.settingsGroups);
      } else {
        await loadSettings();
      }
    } catch (err) {
      handleApiError(err, "Échec de l'enregistrement des paramètres.");
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Clés d'API du serveur
  // ════════════════════════════════════════════════════════════════════════

  async function loadKeys() {
    try {
      const data = await apiRequest("/api/keys");
      state.keys = Array.isArray(data && data.keys) ? data.keys : [];
      renderKeys();
    } catch (err) {
      handleApiError(err, "Impossible de charger les clés d'API.");
    }
  }

  function renderKeys() {
    const list = $("keys-list");
    const empty = $("keys-empty");
    if (!list || !empty) return;
    list.replaceChildren();
    if (state.keys.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    for (const k of state.keys) {
      const li = h("li", { class: "list-item" });
      const main = h("div", { class: "list-main" });
      main.append(h("strong", { text: k.name || "(sans nom)" }));
      main.append(h("span", { class: "muted", text: k.keyPreview || "" }));
      const meta = h("span", { class: "muted", text: `créée le ${fmtDate(k.createdAt)}${k.lastUsedAt ? ` · vue le ${fmtDate(k.lastUsedAt)}` : ""}` });
      main.append(meta);
      li.append(main);

      const actions = h("div", { class: "list-actions" });
      actions.append(
        iconButton("trash", "Révoquer", { class: "btn btn--danger", on: { click: () => revokeKey(k) } }),
      );
      li.append(actions);
      list.append(li);
    }
  }

  async function createKey() {
    const input = $("key-name");
    const name = input ? input.value.trim() : "";
    if (!name) {
      notify("Nommez la clé avant de la créer.", "warning");
      return;
    }
    try {
      const data = await apiRequest("/api/keys", { method: "POST", body: { name } });
      if (input) input.value = "";
      await loadKeys();
      showSecret(data, name);
    } catch (err) {
      handleApiError(err, "Échec de la création de la clé.");
    }
  }

  /** Modale « secret affiché une seule fois » (copie + avertissement). */
  function showSecret(data, name) {
    const secret = data && data.secret ? String(data.secret) : "";
    const box = h("div", { class: "secret-box" });
    const value = h("code", { class: "secret-value", text: secret });
    box.append(value);
    const copyBtn = h("button", { class: "btn btn--accent", text: "Copier la clé", attrs: { type: "button" } });
    copyBtn.addEventListener("click", async () => {
      const ok = await copyText(secret);
      notify(ok ? "Clé copiée." : "Copie impossible — sélectionnez le texte à la main.", ok ? "success" : "warning");
    });
    const btns = h("div", { class: "form-row" }, copyBtn);
    box.append(btns);
    box.append(
      h("p", {
        class: "muted",
        text: "Ce secret ne sera plus jamais affiché. Conservez-le en lieu sûr ; en cas de perte, révoquez la clé et créez-en une autre.",
      }),
    );

    if (modal && typeof modal.open === "function") {
      modal.open({
        id: "secret-modal",
        title: `Clé « ${name} » créée`,
        size: "md",
        content: box,
        closeOnOverlay: false,
        actions: [{ label: "J'ai copié la clé", type: "primary" }],
      });
    } else {
      showAlert("Clé créée", secret);
    }
  }

  async function revokeKey(k) {
    const ok = await confirmAction(
      "Révoquer la clé",
      `Révoquer « ${k.name || k.id} » ? Les appels qui l'utilisent cesseront immédiatement d'être acceptés.`,
      { danger: true, confirmText: "Révoquer" },
    );
    if (!ok) return;
    try {
      await apiRequest(`/api/keys/${encodeURIComponent(k.id)}`, { method: "DELETE" });
      notify("Clé révoquée.");
      await loadKeys();
    } catch (err) {
      handleApiError(err, "Échec de la révocation.");
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Tableau de bord « Activité » (auto-rafraîchi, PLEINE LARGEUR)
  //
  // Une SEULE requête (`GET /api/dashboard`) porte tout l'onglet. Le minuteur
  // ne rafraîchit QUE lorsque l'onglet Activité est affiché ET la page visible
  // (aucun appel inutile en arrière-plan). Le re-rendu est complet mais garde
  // la même structure : pas de saut visuel.
  // ════════════════════════════════════════════════════════════════════════

  /** Période d'auto-rafraîchissement (ms) — onglet actif uniquement. */
  const DASHBOARD_REFRESH_MS = 5000;

  let dashboardTimer = null;
  let dashboardLoading = false;

  /** Grand nombre lisible : 1234567 → « 1,2 M », 340000 → « 340 k ». */
  function formatCompact(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "—";
    const abs = Math.abs(num);
    if (abs >= 1e6) return `${(num / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M`;
    if (abs >= 1e3) return `${(num / 1e3).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} k`;
    return num.toLocaleString("fr-FR");
  }

  /** Token : « — » si inconnu (jamais un 0 trompeur). */
  function formatTokens(value) {
    return value === null || value === undefined ? "—" : formatCompact(value);
  }

  /** Pourcentage à partir d'un ratio 0..1 : « 98 % », « — » si inconnu. */
  function formatPercent(ratio) {
    if (ratio === null || ratio === undefined) return "—";
    const num = Number(ratio);
    return Number.isFinite(num) ? `${Math.round(num * 100)} %` : "—";
  }

  /** Durée lisible : « 850 ms », « 1,5 s », « 2 min 05 s ». */
  function formatDuration(ms) {
    const num = Number(ms);
    if (!Number.isFinite(num) || num < 0) return "—";
    if (num < 1000) return `${Math.round(num)} ms`;
    if (num < 60000) return `${(num / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s`;
    const minutes = Math.floor(num / 60000);
    const seconds = Math.round((num % 60000) / 1000);
    return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
  }

  /** Heure locale d'une entrée du journal (HH:MM:SS). */
  function formatClock(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("fr-FR", { hour12: false });
  }

  /**
   * Pastilles ● / ○ : jusqu'à 5 points, remplis ∝ aux places occupées (jamais
   * 2500 points pour un plafond de 2500). Le chiffre exact reste affiché à côté.
   */
  function occupancyDots(active, limit) {
    const total = Math.min(Math.max(Number(limit) || 1, 1), 5);
    let filled = limit > 0 ? Math.round((active / limit) * total) : 0;
    if (active > 0 && filled === 0) filled = 1;
    if (active >= limit) filled = total;
    const wrap = h("span", { class: "dots", attrs: { "aria-hidden": "true" } });
    for (let i = 0; i < total; i++) wrap.append(h("span", { class: "dot" + (i < filled ? " dot--on" : "") }));
    return wrap;
  }

  function dashboardStat(label, value, opts) {
    opts = opts || {};
    const box = h("div", { class: "stat" + (opts.alert ? " stat--alert" : "") });
    box.append(h("span", { class: "stat-value", text: value }));
    box.append(h("span", { class: "stat-label", text: label }));
    if (opts.hint) box.append(h("span", { class: "stat-hint", text: opts.hint }));
    return box;
  }

  /** Bloc ① — « En ce moment » : concurrence par fournisseur. */
  function renderLiveBlock(live) {
    const block = h("section", { class: "dash-block" });
    block.append(h("h3", { class: "dash-title", text: "En ce moment" }));
    const providers = (live && live.providers) || [];
    if (providers.length === 0) {
      block.append(h("p", { class: "muted", text: "Aucun fournisseur configuré." }));
      return block;
    }
    const list = h("div", { class: "live-list" });
    for (const p of providers) {
      const row = h("div", { class: `live-row live-row--${p.state || "free"}` });
      row.append(h("span", { class: "live-name", text: p.label || p.id, attrs: { title: p.label || p.id } }));
      row.append(occupancyDots(Number(p.active) || 0, Number(p.limit) || 0));
      row.append(h("span", { class: "live-count", text: `${p.active}/${p.limit}` }));
      row.append(
        h("span", {
          class: "live-queued" + (p.queued > 0 ? " live-queued--busy" : ""),
          text: p.queued > 0 ? `${p.queued} en attente` : "file vide",
        }),
      );
      list.append(row);
    }
    block.append(list);
    block.append(
      h("p", {
        class: "dash-note muted",
        text: `${Number(live.active) || 0} appel(s) en cours · ${Number(live.queued) || 0} en attente au total`,
      }),
    );
    return block;
  }

  /** Bloc ② — « 24 h » : appels, réussite, replis (alerte), latence. */
  function renderSummaryBlock(activity) {
    activity = activity || {};
    const block = h("section", { class: "dash-block" });
    block.append(h("h3", { class: "dash-title", text: "24 h" }));
    const stats = h("div", { class: "stats" });
    stats.append(dashboardStat("appels", formatCompact(activity.calls)));
    stats.append(dashboardStat("réussite", formatPercent(activity.successRate)));
    stats.append(
      dashboardStat("replis", formatCompact(activity.fallbacks), {
        alert: Number(activity.fallbacks) > 0,
        hint: `${formatPercent(activity.fallbackRate)} des appels`,
      }),
    );
    const latency = activity.latency || {};
    stats.append(
      dashboardStat("latence moy.", formatDuration(latency.avgMs), { hint: `max ${formatDuration(latency.maxMs)}` }),
    );
    block.append(stats);
    return block;
  }

  /** Ligne du tableau de tokens (total, service ou fournisseur). */
  function tokenRow(name, totals, opts) {
    opts = opts || {};
    const tr = h("tr", { class: opts.total ? "token-row token-row--total" : "token-row" });
    tr.append(h("th", { text: name, attrs: { scope: "row" } }));
    tr.append(h("td", { text: formatTokens(totals.prompt) }));
    tr.append(h("td", { text: formatTokens(totals.completion) }));
    tr.append(h("td", { text: formatTokens(totals.reasoning) }));
    return tr;
  }

  function tokenGroupRow(label) {
    return h("tr", { class: "token-group" }, h("th", { text: label, attrs: { colspan: "4" } }));
  }

  /** Bloc ③ — « Tokens (24 h) » : total, par service, par fournisseur. */
  function renderTokensBlock(tokens) {
    tokens = tokens || {};
    const block = h("section", { class: "dash-block" });
    block.append(h("h3", { class: "dash-title", text: "Tokens (24 h)" }));

    const table = h("table", { class: "token-table" });
    const head = h("tr");
    head.append(h("th", { text: "" }));
    head.append(h("th", { text: "entrée" }));
    head.append(h("th", { text: "sortie" }));
    head.append(h("th", { text: "réflexion" }));
    const thead = h("thead");
    thead.append(head);
    table.append(thead);

    const tbody = h("tbody");
    tbody.append(tokenRow("Total", tokens.total || { prompt: null, completion: null, reasoning: null }, { total: true }));
    const services = Object.entries(tokens.byService || {});
    if (services.length > 0) {
      tbody.append(tokenGroupRow("Par service"));
      for (const [name, totals] of services) tbody.append(tokenRow(name, totals));
    }
    const providers = Object.entries(tokens.byProvider || {});
    if (providers.length > 0) {
      tbody.append(tokenGroupRow("Par fournisseur"));
      for (const [name, totals] of providers) tbody.append(tokenRow(name, totals));
    }
    table.append(tbody);
    block.append(table);

    if (services.length === 0 && providers.length === 0) {
      block.append(h("p", { class: "dash-note muted", text: "Aucune consommation rapportée sur la période." }));
    } else {
      block.append(h("p", { class: "dash-note muted", text: "« — » = non exposé par le fournisseur (ou compte inconnu)." }));
    }
    return block;
  }

  function resultBadge(entry) {
    const result = entry.result || "error";
    const labels = { ok: "OK", error: "erreur", aborted: "interrompu", skipped: "ignoré" };
    const variant = result === "ok" ? "ok" : result === "error" ? "danger" : "warn";
    return badge(labels[result] || result, variant);
  }

  /** Bloc ④ — « Derniers appels » (badge REPLI visible). */
  function renderRecentBlock(recent) {
    const block = h("section", { class: "dash-block" });
    block.append(h("h3", { class: "dash-title", text: "Derniers appels" }));
    const rows = recent || [];
    if (rows.length === 0) {
      block.append(h("p", { class: "muted", text: "Aucun appel journalisé." }));
      return block;
    }
    const list = h("ol", { class: "recent-list" });
    for (const entry of rows) {
      const li = h("li", { class: "recent-row" });
      li.append(h("span", { class: "recent-time", text: formatClock(entry.ts) }));
      li.append(h("span", { class: "recent-service", text: entry.service || "?", attrs: { title: entry.service || "?" } }));
      li.append(h("span", { class: "recent-provider muted", text: providerLabel(entry.provider) }));
      li.append(resultBadge(entry));
      li.append(h("span", { class: "recent-duration muted", text: formatDuration(entry.durationMs) }));
      if (entry.isFallback) li.append(h("span", { class: "badge badge--danger repli-badge", text: "REPLI" }));
      list.append(li);
    }
    block.append(list);
    return block;
  }

  /** Peint le tableau de bord à partir de la réponse `/api/dashboard`. */
  function renderDashboard(data) {
    const host = $("dashboard");
    const empty = $("activity-empty");
    if (!host) return;
    if (!data || typeof data !== "object") {
      if (empty) {
        empty.hidden = false;
        empty.textContent = "Aucune donnée d'activité pour l'instant.";
      }
      host.replaceChildren();
      return;
    }
    if (empty) empty.hidden = true;
    const row = h("div", { class: "dash-row" });
    row.append(renderLiveBlock(data.live));
    row.append(renderSummaryBlock(data.activity));
    host.replaceChildren(row, renderTokensBlock(data.tokens), renderRecentBlock(data.recent));
  }

  /** Charge (et peint) le tableau de bord — garde anti-réentrance. */
  async function loadDashboard() {
    if (dashboardLoading) return;
    dashboardLoading = true;
    try {
      const data = await apiRequest("/api/dashboard");
      renderDashboard(data);
      const status = $("activity-status");
      if (status) status.textContent = `Mis à jour à ${new Date().toLocaleTimeString("fr-FR", { hour12: false })}`;
    } catch (err) {
      handleApiError(err, "Impossible de charger l'activité.");
    } finally {
      dashboardLoading = false;
    }
  }

  /** Démarre l'auto-rafraîchissement (onglet actif visible uniquement). */
  function startDashboardAutoRefresh() {
    stopDashboardAutoRefresh();
    const auto = $("activity-auto");
    if (auto && !auto.checked) return;
    dashboardTimer = setInterval(() => {
      if (activeTab === "activity" && !document.hidden) loadDashboard();
    }, DASHBOARD_REFRESH_MS);
  }

  function stopDashboardAutoRefresh() {
    if (dashboardTimer !== null) {
      clearInterval(dashboardTimer);
      dashboardTimer = null;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Connexion / session (accès de l'humain)
  //
  // L'écran de connexion est la PAGE D'ENTRÉE. Tant qu'aucune session valide
  // n'existe, `#app-shell` reste masqué : aucun contenu applicatif n'est
  // visible (pas d'en-tête, d'onglets, de listes ni de modale).
  // ════════════════════════════════════════════════════════════════════════

  const loginScreen = $("login-screen");
  const appShell = $("app-shell");

  /** Affiche l'écran de connexion SEUL (aucun contenu applicatif derrière). */
  function showLogin() {
    state.authenticated = false;
    state.passwordIsDefault = false;
    state.csrfToken = null;
    state.providers = [];
    state.services = [];
    state.settingsGroups = [];
    state.keys = [];
    if (appShell) appShell.hidden = true;
    if (loginScreen) loginScreen.hidden = false;
    const input = $("login-password");
    if (input) input.focus();
  }

  /** Révèle l'application (après authentification) et charge l'onglet courant. */
  function showApp() {
    if (loginScreen) loginScreen.hidden = true;
    if (appShell) appShell.hidden = false;
    showDefaultPasswordBanner(state.authenticated && state.passwordIsDefault);
    activate(tabFromHash());
  }

  /** Applique la réponse de `GET /api/session` (ou de `POST /login`). */
  function applySession(data) {
    state.authenticated = Boolean(data && data.authenticated);
    state.passwordIsDefault = Boolean(data && data.passwordIsDefault);
    if (data && typeof data.csrfToken === "string" && data.csrfToken) {
      state.csrfToken = data.csrfToken;
    }
    return state.authenticated;
  }

  /** Interroge l'état de session ; bascule écran de connexion OU application. */
  async function initSession() {
    try {
      const data = await apiRequest("/api/session");
      if (applySession(data)) showApp();
      else showLogin();
    } catch {
      showLogin();
    }
  }

  /** Rafraîchit l'état de session (jeton CSRF, bandeau mot de passe par défaut). */
  async function refreshSession() {
    try {
      return applySession(await apiRequest("/api/session"));
    } catch {
      return false;
    }
  }

  /** Soumission du mot de passe : connexion ou message d'erreur clair. */
  async function submitLogin(event) {
    event.preventDefault();
    const input = $("login-password");
    const error = $("login-error");
    const button = $("login-submit");
    const password = input ? input.value : "";
    if (error) {
      error.hidden = true;
      error.textContent = "";
    }
    if (!password) return;
    // GET /api/session (au chargement) a déjà posé le cookie CSRF anonyme.
    if (!state.csrfToken) await refreshSession();
    if (button) button.disabled = true;
    try {
      const data = await apiRequest("/api/session/login", { method: "POST", body: { password } });
      if (input) input.value = "";
      applySession(data);
      showApp();
    } catch (err) {
      if (error) {
        error.textContent = loginErrorMessage(err);
        error.hidden = false;
      }
      if (input) {
        input.value = "";
        input.focus();
      }
    } finally {
      if (button) button.disabled = false;
    }
  }

  /**
   * Message de connexion adapté à la CAUSE RÉELLE.
   * Auparavant, tout ce qui n'était pas un 429 était affiché « Mot de passe
   * incorrect. » — y compris un 503 (dossier de données non inscriptible) ou un
   * 403 (jeton CSRF expiré) : l'utilisateur croyait que son mot de passe était
   * faux alors que ce n'était pas la cause.
   */
  function loginErrorMessage(err) {
    const status = (err && err.status) || 0;
    const code = err && err.data && err.data.code;
    if (code === "LOGIN_RATE_LIMITED" || status === 429) {
      return "Trop de tentatives — patientez une minute, puis réessayez.";
    }
    if (code === "CONFIG_UNREADABLE") {
      return "La configuration de Switchy est illisible ou invalide. Restaurez un fichier config.json valide avant de vous reconnecter.";
    }
    if (code === "STORAGE_NOT_WRITABLE" || status >= 500) {
      return (
        "Le dossier de données de Switchy n'est pas accessible en écriture : la connexion ne peut pas " +
        "aboutir même avec le bon mot de passe. Vérifiez le dossier de données (voir README, « Mot de passe " +
        "administrateur »)."
      );
    }
    if (code === "CSRF_FAILED" || status === 403) {
      return "Session de page expirée — rechargez la page (F5), puis réessayez.";
    }
    if (status === 400) {
      return "Saisissez le mot de passe puis validez.";
    }
    return "Mot de passe incorrect.";
  }

  /** Déconnexion : retour EXACT à l'écran de connexion. */
  async function logout() {
    try {
      await apiRequest("/api/session/logout", { method: "POST" });
    } catch {
      /* Même en cas d'erreur réseau, on revient à l'écran de connexion. */
    }
    showLogin();
    notify("Déconnecté.", "info");
  }

  /** Changement du mot de passe admin (invalide la session → reconnexion). */
  async function changePassword(event) {
    event.preventDefault();
    const current = $("pwd-current");
    const next = $("pwd-next");
    const confirm = $("pwd-confirm");
    const currentValue = current ? current.value : "";
    const nextValue = next ? next.value : "";
    const confirmValue = confirm ? confirm.value : "";
    if (nextValue.trim().length < 4) {
      notify("Le nouveau mot de passe doit faire au moins 4 caractères.", "warning");
      return;
    }
    if (nextValue !== confirmValue) {
      notify("Les deux saisies du nouveau mot de passe diffèrent.", "warning");
      return;
    }
    try {
      await apiRequest("/api/session/password", {
        method: "POST",
        body: { current: currentValue, next: nextValue },
      });
      if (current) current.value = "";
      if (next) next.value = "";
      if (confirm) confirm.value = "";
      notify("Mot de passe changé — reconnectez-vous.", "success");
      showLogin();
    } catch (err) {
      handleApiError(err, "Échec du changement de mot de passe.");
    }
  }

  /** Câble les contrôles de session (connexion, déconnexion, mot de passe). */
  function wireSession() {
    const loginForm = $("login-form");
    if (loginForm) loginForm.addEventListener("submit", submitLogin);
    const logoutBtn = $("logout-btn");
    if (logoutBtn) logoutBtn.addEventListener("click", () => logout());
    const passwordForm = $("password-form");
    if (passwordForm) passwordForm.addEventListener("submit", changePassword);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Câblage & démarrage
  // ════════════════════════════════════════════════════════════════════════

  function wireTabs() {
    for (const tab of tabs) tab.addEventListener("click", () => activate(tab.dataset.tab));
  }

  function wireToolbars() {
    const servicesFilter = $("services-filter");
    if (servicesFilter) servicesFilter.addEventListener("input", renderServices);
    const servicesReload = $("services-reload");
    if (servicesReload) servicesReload.addEventListener("click", () => loadServices());
    const servicesNew = $("services-new");
    if (servicesNew) servicesNew.addEventListener("click", () => openServiceForm(null));

    const providersFilter = $("providers-filter");
    if (providersFilter) providersFilter.addEventListener("input", renderProviders);
    const providersReload = $("providers-reload");
    if (providersReload) providersReload.addEventListener("click", () => loadProviders());
    const providersNew = $("providers-new");
    if (providersNew) providersNew.addEventListener("click", () => openProviderForm(null));

    const settingsSave = $("settings-save");
    if (settingsSave) settingsSave.addEventListener("click", () => saveSettings());

    const activityReload = $("activity-reload");
    if (activityReload) activityReload.addEventListener("click", () => loadDashboard());
    const activityAuto = $("activity-auto");
    if (activityAuto) {
      activityAuto.addEventListener("change", () => {
        if (activityAuto.checked && activeTab === "activity") startDashboardAutoRefresh();
        else stopDashboardAutoRefresh();
      });
    }

    const keyForm = $("key-form");
    if (keyForm) {
      keyForm.addEventListener("submit", (event) => {
        event.preventDefault();
        createKey();
      });
    }
  }

  /** Onglet porté par l'ancre d'URL (`#settings`), défaut « services ». */
  function tabFromHash() {
    const hash = (window.location.hash || "").replace(/^#/, "");
    return hash === "settings" || hash === "providers" || hash === "activity" ? hash : "services";
  }

  // Revient sur l'onglet Activité après un passage en arrière-plan : on relit
  // l'état tout de suite plutôt que d'attendre le prochain tic.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && activeTab === "activity") loadDashboard();
  });

  wireSession();
  initTheme();
  wireTabs();
  wireToolbars();
  initSession();
})();
