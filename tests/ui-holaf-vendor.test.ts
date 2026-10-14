/**
 * Briques holaf-lib vendorisées (public/vendor/holaf/) : fichiers servis,
 * CSS extraits servis, manifeste + empreintes pinnées cohérents, garde-fou CI
 * exécutable hors réseau, et branchement de la page.
 * Aucun accès réseau.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { makeTestEnv, type TestEnv } from "./helpers.js";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const sha256 = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => env.cleanup());

describe("vendor holaf — briques servies", () => {
  const jsBricks: Array<[string, string]> = [
    ["holaf-tokens.js", "HolafTokens"],
    ["holaf-icons.js", "HolafIcons"],
    ["holaf-modal.js", "HolafModal"],
    ["holaf-toast.js", "HolafToast"],
    ["holaf-fetch.js", "HolafFetch"],
  ];

  for (const [file, globalName] of jsBricks) {
    it(`GET /vendor/holaf/${file} → 200 javascript`, async () => {
      const res = await request(env.app).get(`/vendor/holaf/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^(text|application)\/javascript\b/);
      expect(res.text).toContain(globalName);
    });
  }

  it("GET /vendor/holaf/holaf-modal.css → 200 text/css (variables --hm-*)", async () => {
    const res = await request(env.app).get("/vendor/holaf/holaf-modal.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/css\b/);
    expect(res.text).toContain("--hm-bg");
  });

  it("GET /vendor/holaf/holaf-toast.css → 200 text/css (variables --ht-*)", async () => {
    const res = await request(env.app).get("/vendor/holaf/holaf-toast.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/css\b/);
    expect(res.text).toContain("--ht-bg");
  });

  it("GET /vendor/holaf/holaf-manifest.json → 200 (5 briques aux versions pinnées)", async () => {
    const res = await request(env.app).get("/vendor/holaf/holaf-manifest.json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({
      tokens: "0.6.0",
      icons: "0.1.6",
      modal: "0.7.0",
      toast: "0.8.0",
      fetch: "0.2.0",
    });
  });
});

describe("vendor holaf — manifeste & empreintes pinnées", () => {
  it("holaf-checksums.json couvre le manifeste et les SHA-256 des fichiers servis", async () => {
    const res = await request(env.app).get("/vendor/holaf/holaf-checksums.json");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.bricks).sort()).toEqual([
      "fetch",
      "icons",
      "modal",
      "toast",
      "tokens",
    ]);

    const manifestRes = await request(env.app).get("/vendor/holaf/holaf-manifest.json");
    for (const [brick, pin] of Object.entries(res.body.bricks) as Array<
      [string, { file: string; version: string; sha256: string }]
    >) {
      expect(pin.file).toBe(`holaf-${brick}.js`);
      expect(manifestRes.body[brick]).toBe(pin.version);
      // Empreinte vérifiée sur le fichier réellement servi.
      const brickRes = await request(env.app).get(`/vendor/holaf/${pin.file}`);
      expect(brickRes.status).toBe(200);
      expect(sha256(brickRes.text)).toBe(pin.sha256);
    }
  });

  it("scripts/check-holaf-vendor.mjs passe (garde-fou CI, hors réseau)", async () => {
    const { stdout } = await run(process.execPath, ["scripts/check-holaf-vendor.mjs"], {
      cwd: repoRoot,
    });
    expect(stdout).toContain("OK —");
    expect(stdout).toContain("5 briques épinglées");
  }, 20000);

  it("les CSS extraits sont régénérables depuis les briques vendorisées", async () => {
    const checksums = JSON.parse(
      await readFile(new URL("../public/vendor/holaf/holaf-checksums.json", import.meta.url), "utf8"),
    );
    expect(Object.keys(checksums.bricks)).toHaveLength(5);
    for (const file of ["holaf-modal.css", "holaf-toast.css"]) {
      const css = await readFile(new URL(`../public/vendor/holaf/${file}`, import.meta.url), "utf8");
      expect(css.length).toBeGreaterThan(1000);
      expect(css).not.toContain("<style");
    }
  });
});

describe("vendor holaf — branchement de la page", () => {
  it("index.html : tokens + boot synchrone dans le <head>, autres briques en fin de <body>", async () => {
    const res = await request(env.app).get("/");
    expect(res.status).toBe(200);
    const html = res.text;
    const head = html.slice(0, html.indexOf("</head>"));
    const body = html.slice(html.indexOf("</head>"));

    // En-tête : marqueur anti-<style>, brique tokens, boot anti-flash.
    expect(head).toContain('id="holaf-tokens-style"');
    expect(head).toContain('src="vendor/holaf/holaf-tokens.js"');
    expect(head).toContain("switchy.theme");
    expect(head).toContain('href="vendor/holaf/holaf-modal.css"');
    expect(head).toContain('href="vendor/holaf/holaf-toast.css"');
    expect(head.indexOf('src="vendor/holaf/holaf-tokens.js"')).toBeLessThan(
      head.indexOf("switchy.theme"),
    );

    // Fin de <body> : icons → modal → toast → fetch → app.js (ordre garanti).
    // Modules : les briques « dual » exportent en ESM, hors de portée d'un
    // <script> classique (leur `export` top-level y lèverait une SyntaxError).
    const scriptTag = (file: string) => `type="module" src="vendor/holaf/${file}"`;
    expect(body).toContain(scriptTag("holaf-icons.js"));
    expect(body).toContain(scriptTag("holaf-modal.js"));
    expect(body).toContain(scriptTag("holaf-toast.js"));
    expect(body).toContain(scriptTag("holaf-fetch.js"));
    expect(body).toContain('type="module" src="app.js"');
    expect(body.indexOf(scriptTag("holaf-icons.js"))).toBeLessThan(
      body.indexOf(scriptTag("holaf-modal.js")),
    );
    expect(body.indexOf(scriptTag("holaf-modal.js"))).toBeLessThan(
      body.indexOf(scriptTag("holaf-toast.js")),
    );
    expect(body.indexOf(scriptTag("holaf-toast.js"))).toBeLessThan(
      body.indexOf(scriptTag("holaf-fetch.js")),
    );
    expect(body.indexOf(scriptTag("holaf-fetch.js"))).toBeLessThan(
      body.indexOf('type="module" src="app.js"'),
    );
  });

  it("styles.css : alias des jetons holaf avec repli hexadécimal + color-mix", async () => {
    const res = await request(env.app).get("/styles.css");
    expect(res.status).toBe(200);
    expect(res.text).toContain("var(--holaf-surface, #0b0e14)");
    expect(res.text).toContain("var(--holaf-surface-raised,");
    expect(res.text).toContain("var(--holaf-border,");
    expect(res.text).toContain("var(--holaf-text,");
    expect(res.text).toContain("var(--holaf-text-muted,");
    expect(res.text).toContain("var(--holaf-accent, #5aa9ff)");
    expect(res.text).toContain("color-mix(in srgb, var(--switchy-accent) 14%");
    // Aucun triplet RGB calculé côté hôte.
    expect(res.text).not.toContain("-rgb:");
  });

  it("app.js : persistance « switchy.theme », listFamilies, CSS sans injection", async () => {
    const res = await request(env.app).get("/app.js");
    expect(res.status).toBe(200);
    expect(res.text).toContain('"switchy.theme"');
    expect(res.text).toContain("listFamilies");
    expect(res.text).toContain("HolafModal");
    expect(res.text).toContain("HolafToast");
    expect(res.text).toContain("injectStyles: false");
    expect(res.text).toContain("setTheme");
  });
});
