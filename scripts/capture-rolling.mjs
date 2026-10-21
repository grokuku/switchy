/**
 * Captures d'écran du mode « ROLLING » et de l'affinité de cache —
 * SANS AUCUN appel à un fournisseur LLM.
 *
 * Usage : `node scripts/capture-rolling.mjs [dossier-de-sortie]`
 *
 * Principe : répertoire de données TEMPORAIRE (`SWITCHY_DATA_DIR`), catalogue
 * amorcé (2 fournisseurs, 2 services — un en rolling, un en file d'attente) et
 * journal d'appels FICTIF (aucune requête sortante) pour que les compteurs
 * « sautés (charge) » et « affinité » du tableau de bord soient lisibles.
 * Puis Chromium headless piloté en CDP (aucune dépendance npm).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const OUT = resolve(process.argv[2] || join(tmpdir(), "switchy-rolling-captures"));
const DATA = mkdtempSync(join(tmpdir(), "switchy-rolling-data-"));
mkdirSync(OUT, { recursive: true });

function freePort() {
  return new Promise((done) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => done(port));
    });
  });
}

const PORT = await freePort();
const now = new Date().toISOString();

const provider = (id, label, maxConcurrency) => ({
  id,
  label,
  type: "openai-compatible",
  baseUrl: `https://${id}.example/v1`,
  maxConcurrency,
  enabled: true,
  createdAt: now,
  updatedAt: now,
});

const serviceStep = (providerId, model) => ({ providerId, model, reasoning: "off" });

writeFileSync(
  join(DATA, "catalog.json"),
  JSON.stringify(
    {
      version: 1,
      providers: [provider("ollama-pro", "Ollama Pro", 3), provider("deepseek", "DeepSeek", 2)],
      services: [
        {
          name: "gemma-rapide",
          description: "Répartit la charge sur les deux fournisseurs (aucune attente)",
          principal: serviceStep("ollama-pro", "gemma4:31b"),
          fallbacks: [serviceStep("deepseek", "deepseek-chat")],
          contextWindow: 131072,
          maxOutputTokens: 8192,
          vision: true,
          prioritaire: true,
          rolling: true,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          name: "deepseek-fort",
          description: "File d'attente classique (comportement historique)",
          principal: serviceStep("deepseek", "deepseek-chat"),
          fallbacks: [],
          contextWindow: 65536,
          maxOutputTokens: 8192,
          vision: false,
          prioritaire: false,
          rolling: false,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
    null,
    2,
  ),
);

// Journal FICTIF : montre la distinction « bascule pour charge » / « erreur ».
const call = (offsetMs, fields) => ({
  ts: new Date(Date.now() - offsetMs).toISOString(),
  ...fields,
});
const calls = [
  call(90_000, { callId: "a1b2c3d4e5f6", keyName: "pi-web", service: "gemma-rapide", attempt: 0, isFallback: false, provider: "ollama-pro", model: "gemma4:31b", result: "ok", status: 200, durationMs: 1240, tokens: { promptTokens: 820, completionTokens: 240, totalTokens: 1060 } }),
  call(70_000, { callId: "b2c3d4e5f6a1", keyName: "yuki", service: "gemma-rapide", attempt: 0, isFallback: false, provider: "ollama-pro", model: "gemma4:31b", result: "skipped", reason: "saturated", charge: true, durationMs: 0 }),
  call(69_900, { callId: "b2c3d4e5f6a1", keyName: "yuki", service: "gemma-rapide", attempt: 1, isFallback: true, provider: "deepseek", model: "deepseek-chat", result: "ok", status: 200, charge: true, durationMs: 980, tokens: { promptTokens: 820, completionTokens: 210, totalTokens: 1030 } }),
  call(45_000, { callId: "c3d4e5f6a1b2", keyName: "yuki", service: "gemma-rapide", attempt: 1, isFallback: true, provider: "deepseek", model: "deepseek-chat", result: "ok", status: 200, affinity: true, durationMs: 870, tokens: { promptTokens: 790, completionTokens: 180, totalTokens: 970 } }),
  call(20_000, { callId: "d4e5f6a1b2c3", keyName: "pi-web", service: "deepseek-fort", attempt: 0, isFallback: false, provider: "deepseek", model: "deepseek-chat", result: "error", status: 429, reason: "rate_limit", durationMs: 610 }),
];
writeFileSync(join(DATA, "calls.jsonl"), `${calls.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

const base = `http://127.0.0.1:${PORT}`;
const server = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: resolve(import.meta.dirname, ".."),
  env: { ...process.env, SWITCHY_DATA_DIR: DATA, SWITCHY_PORT: String(PORT), SWITCHY_HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[serveur] ${d}`));

async function waitServer() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${base}/`);
      if (res.ok) return;
    } catch {
      /* pas encore prêt */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("le serveur n'a pas démarré");
}

// ── Mini client CDP (WebSocket natif, aucune dépendance) ──
let nextId = 1;
const pending = new Map();

async function launchChromium() {
  const dir = mkdtempSync(join(tmpdir(), "switchy-chrome-"));
  const chrome = spawn(
    "/usr/bin/chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--remote-debugging-port=0",
      `--user-data-dir=${dir}`,
      "--window-size=1600,1200",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const portFile = join(dir, "DevToolsActivePort");
  let port = null;
  for (let i = 0; i < 160 && !port; i += 1) {
    try {
      const raw = readFileSync(portFile, "utf8").split("\n")[0].trim();
      if (raw) port = raw;
    } catch {
      /* pas encore écrit */
    }
    if (!port) await new Promise((r) => setTimeout(r, 100));
  }
  if (!port) throw new Error("DevToolsActivePort indisponible");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page") || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    ws.onopen = done;
    ws.onerror = fail;
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    // Diagnostic : toute exception JS de la page est remontée sur stderr.
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params?.exceptionDetails;
      console.error(`[page] exception JS : ${d?.exception?.description || d?.text}`);
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      console.error(`[page] console.error : ${(msg.params.args || []).map((a) => a.description || a.value).join(" ")}`);
    }
    if (msg.id && pending.has(msg.id)) {
      const { done, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) fail(new Error(JSON.stringify(msg.error)));
      else done(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = nextId++;
      pending.set(id, { done, fail });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { chrome, ws, send, dir };
}

const cdp = await launchChromium();

async function evaluate(expression) {
  const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "erreur JS");
  return res.result.value;
}

async function shot(name) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const file = join(OUT, name);
  writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await waitServer();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${base}/` });
  await sleep(1200);

  // Connexion (mot de passe par défaut `admin`, données temporaires).
  const login = await evaluate(`(async () => {
    const s = await (await fetch('/api/session')).json();
    const r = await fetch('/api/session/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrfToken },
      body: JSON.stringify({ password: 'admin' }),
    });
    return r.status;
  })()`);
  if (login !== 200) throw new Error(`connexion refusée (${login})`);
  // Données temporaires : on quitte le mot de passe par défaut, sinon le
  // garde-fou du serveur REFUSE toute écriture (le bouton rolling compris).
  const pwd = await evaluate(`(async () => {
    const s = await (await fetch('/api/session')).json();
    const r = await fetch('/api/session/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrfToken },
      body: JSON.stringify({ current: 'admin', next: 'recette-temporaire' }),
    });
    return r.status;
  })()`);
  if (pwd !== 200 && pwd !== 204) console.error(`[capture] changement de mot de passe : ${pwd}`);
  // Le changement de mot de passe invalide les sessions : on se reconnecte.
  const relogin = await evaluate(`(async () => {
    const s = await (await fetch('/api/session')).json();
    const r = await fetch('/api/session/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrfToken },
      body: JSON.stringify({ password: 'recette-temporaire' }),
    });
    return r.status;
  })()`);
  if (relogin !== 200) throw new Error(`reconnexion refusée (${relogin})`);
  await cdp.send("Page.reload");
  await sleep(1600);

  // ① Cartes de service : bouton rolling actif (accent) vs file d'attente.
  const file1 = await shot("01-cartes-rolling.png");

  // ② Bouton rolling basculé depuis la carte (bascule optimiste + PUT serveur).
  const toggled = await evaluate(`(async () => {
    const card = [...document.querySelectorAll('.item-card')].find((c) => /deepseek-fort/.test(c.textContent || ''));
    const btn = card && [...card.querySelectorAll('button')].find((b) => /rolling|file d'attente/i.test(b.textContent || ''));
    if (!btn) return 'introuvable';
    btn.click();
    await new Promise((r) => setTimeout(r, 600));
    const services = await (await fetch('/api/services', { headers: { Accept: 'application/json' } })).json();
    const svc = (services.services || []).find((s) => s.name === 'deepseek-fort');
    return svc ? String(svc.rolling) : 'absent';
  })()`);
  console.error(`[capture] 'deepseek-fort'.rolling après clic = ${toggled}`);
  await sleep(400);
  const file2 = await shot("02-rolling-active-par-clic.png");

  // ③ Fenêtre « Modifier » : la case « Rolling » (section Charge).
  // ⚠️ Sélection par TEXTE EXACT du bouton : un motif souple sur aria-label/title
  // peut viser un autre bouton de la carte et la modale ne s'ouvre pas.
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.item-card')].find((c) => /gemma-rapide/.test(c.textContent || ''));
    const btn = card && [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Modifier');
    btn && btn.click();
    return !!btn;
  })()`);
  await sleep(800);
  const modalOpen = await evaluate(`!!document.querySelector('form.form-grid')`);
  if (!modalOpen) {
    const diag = await evaluate(`(() => ({
      forms: [...document.querySelectorAll('form')].map((f) => f.className),
      dialogs: [...document.querySelectorAll('[role="dialog"], dialog, .modal')].map((n) => n.className + '|' + (n.id || '')),
      buttons: [...document.querySelectorAll('.item-card button')].map((b) => b.textContent.trim()).slice(0, 12),
      holafModal: typeof window.HolafModal,
      providers: (window.state || {}).providers ? window.state.providers.length : 'n/a',
    }))()`);
    console.error(`[capture] diagnostic modale = ${JSON.stringify(diag)}`);
    throw new Error("la fenêtre « Modifier » ne s'est pas ouverte");
  }
  // La case et son libellé doivent être visibles (on la centre avant la capture).
  const rollingBox = await evaluate(`(() => {
    const label = [...document.querySelectorAll('form.form-grid label')].find((l) => /Rolling/.test(l.textContent || ''));
    if (!label) return 'case absente';
    label.scrollIntoView({ block: 'center' });
    return label.textContent.trim();
  })()`);
  console.error(`[capture] case Rolling dans la modale = ${rollingBox}`);
  await sleep(400);
  const file3 = await shot("03-modale-charge-rolling.png");
  await evaluate(`(() => {
    const cancel = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Annuler');
    cancel && cancel.click();
    return true;
  })()`);
  await sleep(500);

  // ④ Tableau de bord « Activité » : compteurs « sautés (charge) » et « affinité ».
  await evaluate(`(() => { const tab = document.getElementById('tab-activity'); tab && tab.click(); return true; })()`);
  await sleep(1400);
  const file4 = await shot("04-dashboard-charge-affinite.png");

  // Mesures honnêtes (lues dans le DOM) : compteurs et libellés du bouton.
  const measured = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.item-card')].map((c) => ({
      name: (c.querySelector('.item-title') || {}).textContent || '',
      badges: [...c.querySelectorAll('.badge')].map((b) => b.textContent),
      toggle: [...c.querySelectorAll('button')].filter((b) => /rolling|file d'attente|activé|désactivé/i.test(b.textContent || '')).map((b) => b.textContent.trim()),
    }));
    const stats = [...document.querySelectorAll('#panel-activity .stat')].map((s) => s.textContent.replace(/\\s+/g, ' ').trim());
    return { cards, stats };
  })()`);
  console.log(JSON.stringify({ files: [file1, file2, file3, file4], rollingAfterClick: toggled, measured }, null, 2));
} finally {
  try {
    cdp.ws.close();
  } catch {
    /* rien */
  }
  cdp.chrome.kill("SIGKILL");
  server.kill("SIGKILL");
  await sleep(300);
  for (const dir of [DATA, cdp.dir]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* profil Chromium parfois encore verrouillé : sans conséquence */
    }
  }
}
