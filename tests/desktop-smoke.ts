import { _electron } from "playwright";
import electronPath from "electron";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const data = await mkdtemp(join(tmpdir(), "raft-electron-"));
const env: NodeJS.ProcessEnv = { ...process.env, RAFT_NODE: process.execPath, RAFT_DATA_DIR: data, ANTHROPIC_API_KEY: "" };
delete env.ELECTRON_RUN_AS_NODE;
const launchEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const app = await _electron.launch({ executablePath: electronPath as unknown as string, args: [resolve("dist/desktop.js"), `--user-data-dir=${join(data, "electron")}`], env: launchEnv, timeout: 30_000 });
try {
  const window = await app.firstWindow();
  await window.getByRole("heading", { name: /让想法汇合/ }).waitFor({ timeout: 25_000 });
  await app.evaluate(({ shell }) => {
    const state = globalThis as unknown as { openedUrls: string[] };
    state.openedUrls = [];
    // 验证系统浏览器桥接，不实际打开外部网站。
    shell.openExternal = async url => { state.openedUrls.push(url); };
  });
  await window.getByRole("button", { name: "＋ 创建 Agent", exact: true }).click();
  await window.getByLabel("名称", { exact: true }).fill("链接验证");
  await window.getByRole("button", { name: "创建", exact: true }).click();
  await window.getByRole("heading", { name: "链接验证", exact: true }).waitFor();
  await window.getByLabel("输入消息").fill("**桌面 Markdown**\n\n[外部文档](https://example.com/docs)");
  await window.getByLabel("发送消息").click();
  await window.getByRole("link", { name: "外部文档", exact: true }).click();
  const opened = () => app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls);
  for (let i = 0; i < 50 && !(await opened()).length; i++) await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(await opened(), ["https://example.com/docs"]);
  await window.evaluate("void window.open('file:///tmp/blocked', '_blank')");
  assert.deepEqual(await opened(), ["https://example.com/docs"]);
  assert.equal(app.windows().length, 1);
  await window.screenshot({ path: resolve(".raft/verification/desktop.png"), animations: "disabled" });
  console.log("ELECTRON_UI_OK: Markdown 展示、外部链接桥接、禁止 file 协议且不打开额外应用窗口");
} finally { await app.close(); }
await assert.rejects(access(join(data, "service.lock")), /ENOENT/);
await rm(data, { recursive: true, force: true });
console.log("ELECTRON_EXIT_OK: 服务正常退出、数据库锁已释放");
