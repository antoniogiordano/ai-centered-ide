import { app, BrowserWindow, Menu, screen, shell } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDatabase,
  ProjectStorage,
} from "@ai-ide/storage";
import { createKeytarCredentialStore } from "./credentials.js";
import { SessionManager } from "./session.js";
import { registerIpcHandlers } from "./ipc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let appStorage: ProjectStorage | null = null;
let persistMainWindowState: (() => void) | null = null;

const UI_FOCUS_COMPOSER = "ui:focus-composer";
const UI_TOGGLE_PALETTE = "ui:toggle-palette";
const UI_OPEN_WORKSPACE = "ui:open-workspace";
const UI_NEW_SESSION = "ui:new-session";
const UI_OPEN_PROVIDER = "ui:open-provider";

type WindowState = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
};

const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1280,
  height: 800,
};

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function windowStatePath(): string {
  return join(app.getPath("userData"), "window-state.json");
}

function loadWindowState(): WindowState {
  try {
    const path = windowStatePath();
    if (!existsSync(path)) return { ...DEFAULT_WINDOW_STATE };
    const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<WindowState>;
    const width = Math.max(
      640,
      Math.round(saved.width || DEFAULT_WINDOW_STATE.width),
    );
    const height = Math.max(
      480,
      Math.round(saved.height || DEFAULT_WINDOW_STATE.height),
    );
    const state: WindowState = {
      width,
      height,
      isMaximized: Boolean(saved.isMaximized),
    };

    if (
      typeof saved.x === "number" &&
      typeof saved.y === "number" &&
      Number.isFinite(saved.x) &&
      Number.isFinite(saved.y)
    ) {
      const bounds = {
        x: Math.round(saved.x),
        y: Math.round(saved.y),
        width,
        height,
      };
      if (isBoundsOnScreen(bounds)) {
        state.x = bounds.x;
        state.y = bounds.y;
      }
    }
    return state;
  } catch (error) {
    console.warn("Could not load window state:", error);
    return { ...DEFAULT_WINDOW_STATE };
  }
}

function saveWindowState(state: WindowState): void {
  try {
    writeFileSync(windowStatePath(), JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.warn("Could not save window state:", error);
  }
}

function isBoundsOnScreen(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapX =
      Math.min(bounds.x + bounds.width, area.x + area.width) -
      Math.max(bounds.x, area.x);
    const overlapY =
      Math.min(bounds.y + bounds.height, area.y + area.height) -
      Math.max(bounds.y, area.y);
    return overlapX > 40 && overlapY > 40;
  });
}

function trackWindowState(win: BrowserWindow): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastState: WindowState | null = null;

  const capture = (): WindowState | null => {
    if (win.isDestroyed()) return lastState;
    const isMaximized = win.isMaximized();
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
    lastState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized,
    };
    return lastState;
  };

  const persist = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const state = capture() ?? lastState;
    if (state) saveWindowState(state);
  };

  const schedule = () => {
    capture();
    if (timer) clearTimeout(timer);
    timer = setTimeout(persist, 150);
  };

  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("maximize", persist);
  win.on("unmaximize", persist);
  win.on("close", persist);
  // Seed so quit-before-first-move still has something sensible.
  capture();
  return persist;
}

function installAppMenu(): void {
  const isMac = process.platform === "darwin";
  const send = (channel: string) => {
    mainWindow?.webContents.send(channel);
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            role: "appMenu" as const,
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Chat",
          accelerator: "CommandOrControl+N",
          click: () => send(UI_NEW_SESSION),
        },
        {
          label: "Open Workspace…",
          accelerator: "CommandOrControl+O",
          click: () => send(UI_OPEN_WORKSPACE),
        },
        {
          label: "Provider Settings…",
          accelerator: "CommandOrControl+P",
          click: () => send(UI_OPEN_PROVIDER),
        },
        { type: "separator" },
        {
          label: "Command Palette",
          accelerator: "CommandOrControl+K",
          click: () => send(UI_TOGGLE_PALETTE),
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Agent",
      submenu: [
        {
          label: "Focus Composer",
          accelerator: "CommandOrControl+I",
          click: () => send(UI_FOCUS_COMPOSER),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function createMainWindow(_storage: ProjectStorage): BrowserWindow {
  const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
  const windowState = loadWindowState();

  const win = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    ...(typeof windowState.x === "number" ? { x: windowState.x } : {}),
    ...(typeof windowState.y === "number" ? { y: windowState.y } : {}),
    show: false,
    backgroundColor: "#0f1218",
    webPreferences: {
      preload: join(__dirname, "preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // Force bounds after construction — some platforms ignore x/y at create time.
  if (
    typeof windowState.x === "number" &&
    typeof windowState.y === "number" &&
    !windowState.isMaximized
  ) {
    win.setBounds({
      x: windowState.x,
      y: windowState.y,
      width: windowState.width,
      height: windowState.height,
    });
  }

  persistMainWindowState = trackWindowState(win);

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    // Vite HMR injects inline scripts and may use eval in development.
    const csp = isDev
      ? [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*",
        ].join("; ")
      : [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "connect-src 'self'",
        ].join("; ");

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      console.warn("Blocked navigation:", url);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2 || message.includes("Content Security Policy")) {
      console.warn(`[renderer] ${message}`);
    }
  });

  win.webContents.on("preload-error", (_e, path, error) => {
    console.error("Preload failed:", path, error);
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("Failed to load", url, code, desc);
  });

  // Catch app shortcuts before Monaco / OS defaults can swallow them.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const mod = input.meta || input.control;
    if (!mod || input.alt || input.shift) return;
    const key = input.key.toLowerCase();
    const channel =
      key === "i"
        ? UI_FOCUS_COMPOSER
        : key === "k"
          ? UI_TOGGLE_PALETTE
          : key === "n"
            ? UI_NEW_SESSION
            : key === "o"
              ? UI_OPEN_WORKSPACE
              : key === "p"
                ? UI_OPEN_PROVIDER
                : null;
    if (!channel) return;
    event.preventDefault();
    win.webContents.send(channel);
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
    if (isDev) win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(
      join(__dirname, "../../renderer/dist/index.html"),
    );
  }

  win.once("ready-to-show", () => {
    if (windowState.isMaximized) {
      win.maximize();
    }
    win.show();
  });
  return win;
}

function isAllowedNavigation(url: string): boolean {
  if (url.startsWith("file://")) return true;
  if (process.env.VITE_DEV_SERVER_URL && url.startsWith(process.env.VITE_DEV_SERVER_URL)) {
    return true;
  }
  return false;
}

function ensureGitOnPath(): void {
  // Electron apps often inherit a minimal PATH (no Homebrew). simple-git needs `git`.
  const extras = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
  const current = process.env.PATH ?? "";
  const parts = current.split(":").filter(Boolean);
  for (const dir of extras) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  process.env.PATH = parts.join(":");
}

app.whenReady().then(async () => {
  ensureGitOnPath();
  installAppMenu();
  const dbPath = join(app.getPath("userData"), "ai-first-ide.sqlite");
  const storage = new ProjectStorage(openDatabase(dbPath));
  appStorage = storage;
  const session = new SessionManager(storage);
  const credentials = await createKeytarCredentialStore();
  session.setCredentials(credentials);
  registerIpcHandlers(session, credentials, storage);
  mainWindow = createMainWindow(storage);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && appStorage) {
      mainWindow = createMainWindow(appStorage);
    }
  });
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function flushWindowStateAndQuit(): void {
  persistMainWindowState?.();
}

app.on("before-quit", flushWindowStateAndQuit);

app.on("will-quit", flushWindowStateAndQuit);

// pnpm dev kills Electron with SIGINT/SIGTERM — flush before exit.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    flushWindowStateAndQuit();
    app.quit();
  });
}

app.on("window-all-closed", () => {
  flushWindowStateAndQuit();
  if (process.platform !== "darwin") app.quit();
});
