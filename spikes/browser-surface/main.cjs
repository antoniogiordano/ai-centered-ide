/**
 * Spike browser surface + recorder (Phase 1.2 / 1.3) — CommonJS for Electron main.
 * Isolated BrowserView with dedicated session; console/network/screenshot/viewport;
 * optional injected recorder producing structured JSON traces.
 */
const {
  app,
  BrowserWindow,
  BrowserView,
  session,
  ipcMain,
} = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 3921;
const RECORD = process.argv.includes("--recorder");
const PARTITION = "persist:qa-spike-isolated";
const OUT = path.join(__dirname, "artifacts");

function ensureOut() {
  fs.mkdirSync(OUT, { recursive: true });
}

function startFixtureServer() {
  const html = fs.readFileSync(path.join(__dirname, "fixture.html"), "utf8");
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/" || req.url?.startsWith("/?")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (req.url === "/api/ping") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, t: Date.now() }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

const RECORDER_SCRIPT = `
(() => {
  if (window.__SPIKE_RECORDER__) return;
  window.__SPIKE_RECORDER__ = true;
  const events = [];
  const push = (e) => {
    events.push({ ...e, t: Date.now() });
    console.log('[recorder]', JSON.stringify(e));
  };

  function selectorCandidates(el) {
    if (!el || el.nodeType !== 1) return [];
    const c = [];
    if (el.getAttribute('data-testid')) c.push({ type: 'testid', value: '[data-testid=\"' + el.getAttribute('data-testid') + '\"]' });
    if (el.getAttribute('role')) c.push({ type: 'role', value: el.getAttribute('role'), name: (el.getAttribute('aria-label') || el.innerText || '').slice(0, 80) });
    if (el.id) c.push({ type: 'id', value: '#' + CSS.escape(el.id) });
    const name = el.getAttribute('name');
    if (name) c.push({ type: 'name', value: '[name=\"' + name + '\"]' });
    const text = (el.innerText || '').trim().slice(0, 40);
    if (text) c.push({ type: 'text', value: text });
    // structural path
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.body) {
      let part = n.tagName.toLowerCase();
      const parent = n.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((x) => x.tagName === n.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(n) + 1) + ')';
      }
      parts.unshift(part);
      n = parent;
    }
    c.push({ type: 'path', value: 'body > ' + parts.join(' > ') });
    return c;
  }

  let inputTimer = null;
  let lastInput = null;
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    push({ kind: 'click', selectors: selectorCandidates(t), x: ev.clientX, y: ev.clientY });
  }, true);
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    lastInput = { kind: 'type', selectors: selectorCandidates(t), value: t.value };
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => { if (lastInput) { push(lastInput); lastInput = null; } }, 300);
  }, true);
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.tagName === 'SELECT') push({ kind: 'select', selectors: selectorCandidates(t), value: t.value });
    if (t.type === 'checkbox') push({ kind: 'checkbox', selectors: selectorCandidates(t), checked: t.checked });
  }, true);
  document.addEventListener('submit', (ev) => {
    push({ kind: 'submit', selectors: selectorCandidates(ev.target) });
  }, true);
  window.addEventListener('hashchange', () => {
    push({ kind: 'navigate', url: location.href });
  });
  window.__SPIKE_DUMP__ = () => JSON.stringify({ events, url: location.href }, null, 2);
})();
`;

async function createWindow() {
  ensureOut();
  const ses = session.fromPartition(PARTITION, { cache: true });

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Spike Browser Surface",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Host chrome (IDE stand-in) — no access to QA session
  win.loadURL(
    `data:text/html,${encodeURIComponent(`
      <html><body style="font-family:system-ui;margin:0;padding:8px;background:#111;color:#eee">
        <h3>IDE chrome (isolated from QA view)</h3>
        <p>Partition: ${PARTITION}. Recorder: ${RECORD}</p>
        <button id="shot">Screenshot viewport</button>
        <button id="mobile">Viewport mobile</button>
        <button id="desktop">Viewport desktop</button>
        <button id="clear">Clear session</button>
        <button id="dump">Dump recorder</button>
        <pre id="log" style="font-size:11px;max-height:120px;overflow:auto"></pre>
        <script>
          const { ipcRenderer } = require('electron');
        </script>
      </body></html>
    `)}`,
  );

  // Actually host needs preload for IPC — keep it simple: use main-driven automation after load
  const view = new BrowserView({
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Intentionally NO preload — QA content must not reach IDE APIs
    },
  });
  win.setBrowserView(view);
  view.setBounds({ x: 0, y: 160, width: 1200, height: 640 });

  const consoleLogs = [];
  const network = [];

  view.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    const entry = { level, message, line, sourceId, ts: Date.now() };
    consoleLogs.push(entry);
    console.log("[console]", level, message);
  });

  view.webContents.session.webRequest.onCompleted((details) => {
    if (!details.url.startsWith(`http://127.0.0.1:${PORT}`)) return;
    network.push({
      method: details.method,
      url: details.url,
      status: details.statusCode,
      fromCache: details.fromCache,
      ts: Date.now(),
    });
  });

  await view.webContents.loadURL(`http://127.0.0.1:${PORT}/`);

  if (RECORD) {
    await view.webContents.executeJavaScript(RECORDER_SCRIPT, true);
  }

  // Drive a short automated demo for headless-ish verification
  setTimeout(async () => {
    try {
      // network ping from page
      await view.webContents.executeJavaScript(`fetch('/api/ping').then(r=>r.json())`);

      // screenshot viewport
      const img = await view.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, "viewport.png"), img.toPNG());
      console.log("Wrote viewport.png");

      // mobile viewport
      view.setBounds({ x: 0, y: 160, width: 390, height: 640 });
      await view.webContents.executeJavaScript(
        `window.resizeTo(390,640); console.log('viewport-mobile')`,
      );
      const imgM = await view.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, "viewport-mobile.png"), imgM.toPNG());

      // desktop again
      view.setBounds({ x: 0, y: 160, width: 1200, height: 640 });

      if (RECORD) {
        const steps = [
          `document.querySelector('[data-testid="login"]').click()`,
          `document.querySelector('#email').value = 'a@b.c'; document.querySelector('#email').dispatchEvent(new Event('input', { bubbles: true }))`,
          `document.querySelector('#remember').click()`,
          `document.querySelector('#role').value = 'admin'; document.querySelector('#role').dispatchEvent(new Event('change', { bubbles: true }))`,
          `document.querySelector('#login-form').requestSubmit()`,
          `document.querySelector('[data-testid="go-items"]').click()`,
          `document.querySelector('[data-testid="new-item"]').value = 'Widget'; document.querySelector('[data-testid="new-item"]').dispatchEvent(new Event('input', { bubbles: true }))`,
          `document.querySelector('[data-testid="add"]').click()`,
          `location.hash = '#/done'`,
          `document.querySelector('[data-testid="nav-home"]').click()`,
        ];
        for (const step of steps) {
          await view.webContents.executeJavaScript(step);
          await new Promise((r) => setTimeout(r, 250));
        }
        const dump = await view.webContents.executeJavaScript(`window.__SPIKE_DUMP__()`);
        fs.writeFileSync(path.join(OUT, "trace.json"), dump);
        console.log("Wrote trace.json events=", JSON.parse(dump).events.length);
      }

      fs.writeFileSync(
        path.join(OUT, "observation.json"),
        JSON.stringify({ consoleLogs, network }, null, 2),
      );

      // clear session data
      await ses.clearStorageData();
      console.log("Session cleared");

      console.log("Browser surface spike checks complete — closing in 2s");
      setTimeout(() => app.quit(), 2000);
    } catch (err) {
      console.error(err);
      app.quit();
    }
  }, 1500);

  return { win, view };
}

app.whenReady().then(async () => {
  await startFixtureServer();
  await createWindow();
});

app.on("window-all-closed", () => app.quit());
