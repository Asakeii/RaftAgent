import { app, BrowserWindow, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
let service: ChildProcess | undefined;
let exiting = false;
const singleton = app.requestSingleInstanceLock();
if (!singleton) app.quit();
else {
  app.on("second-instance", () => { const w = BrowserWindow.getAllWindows()[0]; w?.show(); w?.focus(); });
  void app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1350, height: 900, minWidth: 850, minHeight: 640, title: "Raft", backgroundColor: "#f6f7f3", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url).catch(error => console.error("打开链接失败", error));
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", event => event.preventDefault());
  const node = process.env.RAFT_NODE;
  if (!node) throw new Error("请通过 npm run desktop 启动，以提供 Node 24 运行时");
  const childEnv = { ...process.env }; delete childEnv.ELECTRON_RUN_AS_NODE;
  service = spawn(node, [fileURLToPath(new URL("./cli.js", import.meta.url)), "serve"], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let errors = ""; let loaded = false;
  service.stdout?.on("data", chunk => {
    output += String(chunk);
    for (;;) {
      const end = output.indexOf("\n"); if (end < 0) break; const line = output.slice(0, end); output = output.slice(end + 1);
      try { const result = JSON.parse(line) as { ready?: boolean; url?: string }; if (result.ready && result.url && !loaded) { loaded = true; void window.loadURL(result.url); } } catch { /* 非启动元数据不用于导航 */ }
    }
  });
  service.stderr?.on("data", chunk => { errors = (errors + String(chunk)).slice(-4000); process.stderr.write(chunk); });
  service.on("exit", () => { if (!exiting && !window.isDestroyed()) { void window.loadURL(`data:text/plain;charset=utf-8,${encodeURIComponent(`Raft 本地服务已退出。\n${errors}`)}`); } });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", event => {
    if (exiting) return; event.preventDefault(); exiting = true;
    if (!service || service.exitCode !== null) { app.quit(); return; }
    service.once("exit", () => app.quit()); service.kill("SIGTERM");
    setTimeout(() => { service?.kill("SIGKILL"); app.quit(); }, 15_000).unref();
  });
  }).catch(error => { console.error(error); app.exit(1); });
}
