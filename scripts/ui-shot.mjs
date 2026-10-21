#!/usr/bin/env node
/**
 * Log into a running tio-server in headless Chrome and screenshot one hash route.
 *
 *   node scripts/ui-shot.mjs --url http://127.0.0.1:8765 --password <pw> \
 *        --hash "#/console/board" --out artifacts/live/console.png
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
].find((path) => existsSync(path));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const BASE = arg("url", "http://127.0.0.1:8765").replace(/\/$/, "");
const PASSWORD = arg("password", "");
const HASH = arg("hash", "#/sessions");
const OUT = arg("out", "artifacts/live/console.png");
const PORT = Number(arg("port", "9444"));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
    return result.result?.value;
  }
}

async function waitForHttp(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function main() {
  if (!CHROME) throw new Error("no Chrome/Edge found");
  const outFile = resolve(OUT);
  mkdirSync(dirname(outFile), { recursive: true });
  const profile = join(dirname(outFile), "chrome-profile");
  const logFile = join(dirname(outFile), "chrome-ui-shot.log");
  const logFd = openSync(logFile, "a");
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--window-size=1440,1000",
      "about:blank",
    ],
    { stdio: ["ignore", logFd, logFd] },
  );
  chrome.on("error", (error) => console.error("chrome spawn error:", error));
  chrome.on("exit", (code) => console.error(`chrome exited early: ${code}`));
  try {
    await waitForHttp(`http://127.0.0.1:${PORT}/json/version`);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((target) => target.type === "page");
    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: BASE + "/" });
    await sleep(1800);
    const login = await cdp.evaluate(
      `fetch('/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({username:'admin', password:${JSON.stringify(PASSWORD)}})}).then(r => r.status)`,
    );
    if (login !== 200) throw new Error(`login failed: ${login}`);
    await cdp.send("Page.reload", { ignoreCache: true });
    await sleep(2200);
    await cdp.evaluate(`location.hash = ${JSON.stringify(HASH)}`);
    await sleep(2500);
    const summary = await cdp.evaluate("document.body.innerText.slice(0, 300)");
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(outFile, Buffer.from(data, "base64"));
    console.log(`screenshot: ${outFile}`);
    console.log(summary.replace(/\n+/g, " | ").slice(0, 200));
  } finally {
    chrome.kill();
    closeSync(logFd);
  }
}

main().catch((error) => {
  console.error("ui-shot failed:", error);
  process.exitCode = 1;
});
