#!/usr/bin/env node
/**
 * UI verification probe.
 *
 * Drives the built SPA in headless Chrome over the DevTools protocol:
 * logs in through the real API, seeds a simulated session, sends one command
 * through the assistant-ui composer, and captures screenshots of every page.
 *
 * Usage:
 *   node scripts/ui-probe.mjs --url http://127.0.0.1:8765 \
 *        --user admin --password <pw> --out artifacts/ui
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const USER = arg("user", "admin");
const PASSWORD = arg("password", "");
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

  const profile = join(OUT, "profile");
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

    // 1. login screen
    await cdp.send("Page.navigate", { url: BASE + "/" });
    await sleep(2000);
    const loginText = await cdp.evaluate("document.body.innerText");
    check("login page renders", loginText.includes("Operator sign in"), loginText.slice(0, 80));
    await cdp.screenshot(join(OUT, "01-login.png"));

    // 2. log in through the real endpoint, reload so the SPA sees the cookie
    const loginStatus = await cdp.evaluate(
      `fetch('/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASSWORD)}})})
        .then(async r => ({status: r.status, body: await r.text()}))`,
    );
    check("login api accepted", loginStatus.status === 200, `status ${loginStatus.status}`);
    const csrf = JSON.parse(loginStatus.body).csrf;

    await cdp.send("Page.reload", { ignoreCache: true });
    await sleep(2600);
    await cdp.evaluate("location.hash = '#/sessions'");
    await sleep(1800);
    const bodyText = await cdp.evaluate("document.body.innerText");
    check(
      "sessions page renders",
      bodyText.includes("Sessions") && bodyText.includes("board-a"),
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
        `fetch('/api/sessions/ui-dialog', {method:'DELETE', headers:{'X-CSRF-Token': ${JSON.stringify(csrf)}}})`,
      );
      await sleep(500);
    }

    // 3. seed the simulated session through the real API (same origin, with CSRF)
    const sessionSetup = await cdp.evaluate(
      `(async () => {
        const csrf = ${JSON.stringify(csrf)};
        const headers = {'Content-Type':'application/json','X-CSRF-Token':csrf};
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

    await cdp.evaluate("location.hash = '#/console/board-a'");
    await sleep(2600);
    const consoleText = await cdp.evaluate("document.body.innerText");
    check(
      "console page renders",
      consoleText.includes("live rx") || consoleText.includes("LIVE RX"),
      consoleText.slice(0, 120),
    );
    check("live rx shows device output", consoleText.includes("TioSim"), "banner visible in RX panel");
    await cdp.screenshot(join(OUT, "03-console.png"));

    // 4b. hand control to the agent and back, through the toolbar
    await clickByText("Hand to agent");
    await sleep(1500);
    const agentState = await cdp.evaluate("document.body.innerText");
    check(
      "toolbar hands write control to the agent",
      agentState.includes("Take control") && agentState.includes("The agent owns write control"),
      agentState.slice(0, 160),
    );
    await clickByText("Take control");
    await sleep(1500);
    const humanState = await cdp.evaluate("document.body.innerText");
    check(
      "toolbar takes control back for the operator",
      !humanState.includes("The agent owns write control"),
      humanState.slice(0, 160),
    );

    const composer = await cdp.evaluate(
      `(() => {
        const area = document.querySelector('textarea');
        if (!area) return {found:false};
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(area, 'ping');
        area.dispatchEvent(new Event('input', {bubbles:true}));
        return {found:true};
      })()`,
    );
    check("assistant-ui composer present", composer.found);
    if (composer.found) {
      await sleep(300);
      const clicked = await cdp.evaluate(
        `(() => {
          const send = [...document.querySelectorAll('button')].find(b => b.title === 'send');
          if (!send) return false;
          send.click();
          return true;
        })()`,
      );
      check("composer send button present", clicked);
      await sleep(2600);
      const threadText = await cdp.evaluate(
        "(() => { const el = document.querySelector('[data-testid=\"console-thread\"]'); return el ? el.innerText : ''; })()",
      );
      check(
        "composer command reached the device",
        threadText.includes("pong") && threadText.length < 4000,
        `thread chars=${threadText.length}`,
      );
      await cdp.screenshot(join(OUT, "04-console-command.png"));
    }

    // 4. remaining pages via hash routing
    for (const [route, label, needle] of [
      ["config/board-a", "05-config.png", "Configuration"],
      ["logs/board-a", "06-logs.png", "Logs"],
      ["system", "07-system.png", "MCP"],
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
