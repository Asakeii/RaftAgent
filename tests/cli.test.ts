import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));

function run(args: string[], cwd = root) {
  return spawnSync(process.execPath, ["--import", tsx, cli, ...args], {
    cwd,
    env: { ...process.env, ANTHROPIC_API_KEY: "" },
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("帮助无需凭证即可从项目外运行", () => {
  const result = run(["--help"], tmpdir());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TypeScript CLI/);
});

test("缺失、空白或多个任务返回参数错误", () => {
  for (const args of [[], [" "], ["任务一", "任务二"]]) {
    const result = run(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /非空任务/);
  }
});

test("已有空环境变量优先于 .env，缺少 Key 时不启动模型调用", () => {
  const result = run(["测试任务"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /ANTHROPIC_API_KEY/);
});

test("未知选项返回参数错误", () => {
  const result = run(["--unknown"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--unknown/);
});
