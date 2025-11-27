import { app, BrowserWindow } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let serverProcess = null;
let serverStarted = false;

// PREVENT MULTIPLE INSTANCE
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit();
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function startServer() {
  if (serverStarted) return;  // <-- prevents repeated server spawns
  serverStarted = true;

  const serverPath = path.join(__dirname, "index.js");
  const nodeCmd = process.platform === "win32" ? "node.exe" : "node";

  serverProcess = spawn(nodeCmd, [serverPath], {
    cwd: __dirname,
    env: { ...process.env }
  });

  serverProcess.stdout.on("data", d => console.log("[SERVER]", d.toString()));
  serverProcess.stderr.on("data", d => console.error("[SERVER ERR]", d.toString()));
  serverProcess.on("close", code => console.error("Server exited:", code));
}

function createWindow() {
  if (mainWindow) return;  // <-- prevents duplicate windows

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: { contextIsolation: true }
  });

  setTimeout(() => {
    mainWindow.loadURL("http://localhost:3000");
  }, 1200);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startServer();
  createWindow();
});

app.on("window-all-closed", () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});
