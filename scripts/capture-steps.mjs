/**
 * Captures d'écran de la fenêtre « Modifier » et de la carte de service
 * (glisser-déposer des étapes LLM) — SANS appel à un fournisseur LLM.
 *
 * Usage : `node scripts/capture-steps.mjs [dossier-de-sortie]`
 *
 * Principe : répertoire de données TEMPORAIRE (`SWITCHY_DATA_DIR`), catalogue
 * amorcé avec 3 fournisseurs + 1 service à 3 étapes, serveur lancé sur un port
 * libre, puis Chromium headless piloté en CDP (aucune dépendance npm).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const OUT = resolve(process.argv[2] || join(tmpdir(), "switchy-captures"));
const PORT = await freePort();
const DATA = mkdtempSync(join(tmpdir(), "switchy-capture-data-"));
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

const now = new Date().toISOString();
const provider = (id, label) => ({
  id,
  label,
  type: "ollama",
  baseUrl: "https://ollama.com/v1",
  enabled: true,
  createdAt: now,
  updatedAt: now,
});

// Catalogue d'amorçage — 3 FOURNISSEURS (aucune clé : rien ne sera appelé).
writeFileSync(
  join(DATA, "catalog.json"),
  JSON.stringify(
    {
      version: 1,
      providers: [provider("ollama-pro", "Ollama Pro"), provider("ollama-free-1", "Ollama Free 1"), provider("ollama-free-2", "Ollama Free 2")],
      services: [
        {
          name: "gemma-rapide",
          description: "Gemma 4 avec deux replis",
          principal: { providerId: "ollama-pro", model: "gemma4:31b", reasoning: "off" },
          fallbacks: [
            { providerId: "ollama-free-1", model: "gemma4:31b", reasoning: "low" },
            { providerId: "ollama-free-2", model: "gemma4:31b", reasoning: "high" },
          ],
          contextWindow: 131072,
          maxOutputTokens: 8192,
          vision: true,
          prioritaire: true,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
    null,
    2,
  )
);

const base = `http://127.0.0.1:${PORT}`;
const server = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: resolve(import.meta.dirname, ".."),
  env: {
    ...process.env,
    SWITCHY_DATA_DIR: DATA,
    SWITCHY_PORT: String(PORT),
    SWITCHY_HOST: "127.0.0.1",
  },
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

// ── Mini client CDP ──
let nextId = 1;
const pending = new Map();

async function launchChromium() {
  const dir = mkdtempSync(join(tmpdir(), "switchy-chrome-"));
  const chrome = spawn("/usr/bin/chromium", [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "--remote-debugging-port=0",
    `--user-data-dir=${dir}`,
    "--window-size=1600,1000",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const portFile = join(dir, "DevToolsActivePort");
  let port = null;
  for (let i = 0; i < 160 && !port; i += 1) {
    try {
      const { readFileSync } = await import("node:fs");
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
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
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
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
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
  // garde-fou du serveur refuse toute écriture (« Changez le mot de passe… »).
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
  await sleep(1500);

  // ① Fenêtre « Modifier » — liste ordonnée, poignées, ↑/↓, libellés.
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /Modifier/.test(b.getAttribute('aria-label') || b.title || b.textContent || '') && (b.closest('.service-card') || /service/i.test(b.closest('[class*=service]')?.className || '')));
    (btn || null)?.click();
    return true;
  })()`);
  await sleep(600);
  if (!(await evaluate(`!!document.querySelector('.steps-editor')`))) {
    // Repli : le premier bouton « Modifier » visible.
    await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find((x)=>x.textContent.trim()==='Modifier'); b&&b.click(); return true; })()`);
    await sleep(600);
  }
  const file1 = await shot("01-modale-etapes.png");

  // ② Après un déplacement (bouton ↓ sur la 1re ligne) : ordre + renumérotation.
  await evaluate(`(() => {
    const row = document.querySelector('.steps-editor .step-editor-row');
    const down = row && [...row.querySelectorAll('button')].find((b) => /descendre|↓/i.test(b.getAttribute('aria-label') || b.title || b.textContent || ''));
    down && down.click();
    return !!down;
  })()`);
  await sleep(500);
  const file2 = await shot("02-apres-deplacement.png");

  // ④ Retour visuel pendant le glisser (classe .dragging posée à la main,
  // même rendu que pendant un vrai glisser : la poignée et la ligne s'allument).
  await evaluate(`(() => {
    const row = document.querySelector('.steps-editor .step-editor-row');
    if (!row) return false;
    row.classList.add('is-dragging');
    const list = row.closest('.steps-editor');
    if (list) list.classList.add('is-dragging-list');
    const target = list && list.children[2];
    if (target) target.classList.add('insert-before');
    return true;
  })()`);
  await sleep(300);
  const file4 = await shot("04-pendant-le-glisser.png");
  await evaluate(`(() => {
    document.querySelectorAll('.is-dragging').forEach((n) => n.classList.remove('is-dragging'));
    document.querySelectorAll('.is-dragging-list').forEach((n) => n.classList.remove('is-dragging-list'));
    document.querySelectorAll('.insert-before, .insert-after').forEach((n) => n.classList.remove('insert-before', 'insert-after'));
    return true;
  })()`);

  // ⑤ La correction : un repli laissé SANS modèle est écarté à l'enregistrement
  // (avant : le serveur refusait « fallbacks[i].model: required »).
  await evaluate(`(() => {
    const add = [...document.querySelectorAll('button')].find((b) => /Ajouter une étape/.test(b.textContent || ''));
    add && add.click();
    return !!add;
  })()`);
  await sleep(350);
  const clicked = await evaluate(`(() => {
    const editor = document.querySelector('.steps-editor');
    const root = editor && editor.closest('[role="dialog"], dialog, .modal');
    const form = editor && editor.closest('form');
    const candidates = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Enregistrer');
    const save =
      (root && [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Enregistrer')) ||
      (form && candidates.find((b) => b.getAttribute('form') === form.id)) ||
      null;
    if (!save) return 'introuvable';
    save.click();
    return 'ok';
  })()`);
  console.error(`[capture] bouton Enregistrer = ${clicked}`);
  await sleep(700);
  const file5 = await shot("05-repli-vide-ignore.png");
  const saved = await evaluate(`(async () => {
    const r = await fetch('/api/services', { headers: { Accept: 'application/json' } });
    const data = await r.json();
    const svc = (data.services || [])[0];
    return svc ? svc.fallbacks.length : -1;
  })()`);
  console.error(`[capture] replis enregistrés = ${saved}`);

  // ③ la carte du service avec ses poignées.
  await evaluate(`(() => {
    const close = document.querySelector('#service-form [aria-label*="ermer"], #service-form .modal__close, .modal [data-close]');
    close && close.click();
    const annuler = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Annuler');
    annuler && annuler.click();
    return true;
  })()`);
  await sleep(900);
  const file3 = await shot("03-carte-service.png");

  console.log(JSON.stringify({ files: [file1, file2, file3, file4, file5], savedFallbacks: saved }, null, 2));
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
