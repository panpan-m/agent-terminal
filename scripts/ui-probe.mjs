#!/usr/bin/env node
/**
 * UI verification probe.
 *
 * Drives the built SPA in headless Chrome over the DevTools protocol:
 * opens the (login-free) UI, seeds a simulated session, types one command
 * into the xterm terminal, and captures screenshots of every page.
 *
 * Usage:
 *   node scripts/ui-probe.mjs --url http://127.0.0.1:8765 --out artifacts/ui
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const BASE = arg("url", "http://127.0.0.1:8765").replace(/\/$/, "");
const OUT = arg("out", "artifacts/ui");
const DEBUG_PORT = Number(arg("port", "9333"));

mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${String(detail).slice(0, 120)}` : ""}`);
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
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
      } else if (message.method) {
        this.events.push(message);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 30000);
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
    }
    return result.result?.value;
  }
  async screenshot(path) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(data, "base64"));
  }
}

async function waitForHttp(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${url}`);
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error("no Chrome/Edge binary found");

  const profile = resolve(OUT, "profile");
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--window-size=1440,1000",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let cdp;
  try {
    await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("no page target");
    cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const errors = [];
    const poller = setInterval(() => {
      while (cdp.events.length) {
        const event = cdp.events.shift();
        if (event.method === "Runtime.exceptionThrown") {
          errors.push(event.params.exceptionDetails?.exception?.description || "exception");
        }
        if (event.method === "Log.entryAdded" && event.params.entry.level === "error") {
          errors.push(event.params.entry.text);
        }
      }
    }, 100);

    // 1. the SPA opens straight into the sessions page (no login)
    await cdp.send("Page.navigate", { url: BASE + "/" });
    await sleep(2600);
    await cdp.evaluate("location.hash = '#/sessions'");
    await sleep(1800);
    const bodyText = await cdp.evaluate("document.body.innerText");
    check(
      "sessions page renders",
      bodyText.includes("Sessions") && bodyText.includes("New session"),
      bodyText.slice(0, 120),
    );
    await cdp.screenshot(join(OUT, "02-sessions.png"));

    // 2b. create a session through the New session dialog (real form interaction)
    const clickByText = (text) =>
      cdp.evaluate(
        `(() => {
          const el = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes(${JSON.stringify(text)}));
          if (!el) return false;
          el.click();
          return true;
        })()`,
      );

    const openedDialog = await clickByText("New session");
    await sleep(900);
    const filled = await cdp.evaluate(
      `(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return {ok:false, reason:'no dialog'};
        const inputs = [...dialog.querySelectorAll('input')];
        const byPlaceholder = (p) => inputs.find(i => (i.placeholder || '').includes(p));
        const id = byPlaceholder('board-a');
        const port = byPlaceholder('COM5');
        if (!id || !port) return {ok:false, reason:'inputs: ' + inputs.map(i => i.placeholder).join('|')};
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(id, 'ui-dialog');
        id.dispatchEvent(new Event('input', {bubbles:true}));
        setter.call(port, 'sim://ui-dialog');
        port.dispatchEvent(new Event('input', {bubbles:true}));
        return {ok:true};
      })()`,
    );
    check("new-session dialog opens with the form", openedDialog && filled.ok, filled.reason || "");
    if (openedDialog && filled.ok) {
      await sleep(250);
      await clickByText("Create & open");
      await sleep(2200);
      const afterCreate = await cdp.evaluate("document.body.innerText");
      check(
        "session created from the dialog is listed and open",
        afterCreate.includes("ui-dialog") && afterCreate.includes("open"),
        afterCreate.slice(0, 120),
      );
      await cdp.evaluate(
        `fetch('/api/sessions/ui-dialog', {method:'DELETE'})`,
      );
      await sleep(500);
    }

    // 3. seed the simulated session through the real API (same origin)
    const sessionSetup = await cdp.evaluate(
      `(async () => {
        const headers = {'Content-Type':'application/json'};
        let list = await (await fetch('/api/sessions')).json();
        if (!list.sessions.some(s => s.session_id === 'board-a')) {
          await fetch('/api/sessions', {method:'POST', headers,
            body: JSON.stringify({id:'board-a', name:'Board A', port:'sim://board-a', auto_open:true})});
        }
        list = await (await fetch('/api/sessions')).json();
        const s = list.sessions.find(x => x.session_id === 'board-a');
        if (s && s.state !== 'open') await fetch('/api/sessions/board-a/open', {method:'POST', headers});
        await fetch('/api/sessions/board-a/control', {method:'PUT', headers, body: JSON.stringify({owner:'human'})});
        const r = await fetch('/api/sessions/board-a/command', {method:'POST', headers,
          body: JSON.stringify({command:'help', expect:'commands:', timeout_ms:4000})});
        const out = await r.json();
        return {ok: r.status === 200, matched: out.matched};
      })()`,
    );
    check("seed command executed", sessionSetup.ok && sessionSetup.matched, JSON.stringify(sessionSetup));

    await cdp.evaluate("location.hash = '#/terminal/board-a'");
    await sleep(2800);
    const terminalText = await cdp.evaluate("document.body.innerText");
    check(
      "terminal page renders",
      terminalText.includes("LIVE RX") && terminalText.includes("STATUS"),
      terminalText.slice(0, 140),
    );
    const rows = await cdp.evaluate("document.querySelector('.xterm-rows')?.innerText || ''");
    check("terminal shows device output", rows.includes("TioSim"), rows.slice(0, 120));
    await cdp.screenshot(join(OUT, "03-terminal.png"));

    // 4b. hand control to the agent via the API, then take it back in the toolbar
    await cdp.evaluate(
      `fetch('/api/sessions/board-a/control', {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({owner:'agent'})})`,
    );
    await sleep(3600);
    const agentState = await cdp.evaluate("document.body.innerText");
    check(
      "toolbar offers Take control while the agent owns write",
      agentState.includes("Take control"),
      agentState.slice(0, 160),
    );
    await clickByText("Take control");
    await sleep(2400);
    const humanState = await cdp.evaluate("document.body.innerText");
    check(
      "toolbar takes control back for the operator",
      !humanState.includes("Take control"),
      humanState.slice(0, 160),
    );

    // 4c. type a command into xterm and read the device reply back
    await cdp.evaluate("document.querySelector('.xterm-helper-textarea')?.focus()");
    await cdp.send("Input.insertText", { text: "ping" });
    for (const type of ["keyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    }
    await sleep(2400);
    const afterType = await cdp.evaluate("document.querySelector('.xterm-rows')?.innerText || ''");
    check("typing reaches the device and output returns", afterType.includes("pong"), afterType.slice(-160));
    await cdp.screenshot(join(OUT, "04-terminal-command.png"));

    // 4d. light theme toggle (persisted by the provider)
    const toggled = await cdp.evaluate(
      "(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'light'); if (!b) return false; b.click(); return true; })()",
    );
    await sleep(800);
    const lightOn = await cdp.evaluate("document.documentElement.classList.contains('light')");
    check("theme toggle switches to light", toggled && lightOn, `clicked=${toggled} light=${lightOn}`);
    await cdp.screenshot(join(OUT, "04-terminal-light.png"));
    await cdp.evaluate(
      "(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'dark'); b?.click(); })()",
    );
    await sleep(600);
    const lightOff = await cdp.evaluate("!document.documentElement.classList.contains('light')");
    check("theme toggle switches back to dark", lightOff, `light=${!lightOff}`);

    // 4. remaining pages via hash routing
    for (const [route, label, needle] of [
      ["mcp", "08-mcp.png", "Streamable HTTP"],
      ["logs/board-a", "06-logs.png", "transcript"],
      ["sessions", "02-sessions.png", "New session"],
    ]) {
      await cdp.evaluate(`location.hash = '#/${route}'`);
      await sleep(2000);
      const text = await cdp.evaluate("document.body.innerText");
      check(`${route.split("/")[0]} page renders`, text.includes(needle), text.slice(0, 90));
      await cdp.screenshot(join(OUT, label));
    }

    clearInterval(poller);
    const realErrors = errors.filter(
      (line) =>
        !/favicon|clipboard|401 \(Unauthorized\)|Failed to load resource: the server responded with a status of 404/.test(
          line,
        ),
    );
    check("no browser console errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));
  } finally {
    try {
      cdp?.ws.close();
    } catch {
      /* ignore */
    }
    chrome.kill();
  }

  const failed = checks.filter((entry) => !entry.ok);
  writeFileSync(join(OUT, "ui-checks.json"), JSON.stringify({ base: BASE, checks, failed: failed.length }, null, 2));
  console.log(`\n${checks.length - failed.length}/${checks.length} UI checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("ui probe failed:", error);
  process.exitCode = 1;
});
