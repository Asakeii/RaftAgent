import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { config } from "dotenv";
import { runAgent } from "./agent.js";
import { createAgentOptions } from "./config.js";
import { controlCommand, controlHelp, sendControl, identifyCommand, ControlTransportError } from "./control.js";
import { join } from "node:path";
import { homedir } from "node:os";

const projectDir = fileURLToPath(new URL("../", import.meta.url));
const help = `RaftAgent — Claude Agent SDK TypeScript CLI

用法：
  npm run dev -- "交给 Agent 的任务"
  npm start -- "交给 Agent 的任务"（先执行 npm run build）

选项：
  -h, --help  显示帮助
`;

async function main(): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  let listening = false;
  try {
    const args = (() => {
      try {
        return parseArgs({
          options: { help: { type: "boolean", short: "h" } },
          allowPositionals: true,
          strict: true,
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        console.error(help);
        return undefined;
      }
    })();
    if (!args) return 2;
    const { values, positionals } = args;
    if (values.help) {
      console.log(help);
      return 0;
    }
    if (positionals.length !== 1 || !positionals[0]?.trim()) {
      console.error(help);
      console.error("请用引号传入一个非空任务。");
      return 2;
    }

    const loaded = config({ path: new URL("../.env", import.meta.url), quiet: true });
    if (loaded.error && (loaded.error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw loaded.error;
    }
    const options = createAgentOptions(process.env, projectDir, controller);
    process.on("SIGINT", stop);
    listening = true;
    const code = await runAgent(positionals[0].trim(), options);
    if (controller.signal.aborted) {
      console.error("已停止。");
      return 130;
    }
    return code;
  } catch (error) {
    if (controller.signal.aborted) {
      console.error("已停止。");
      return 130;
    }
    console.error(`[运行失败] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (listening) process.off("SIGINT", stop);
  }
}

async function dispatch(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === "ctl") {
    const ownArgs = args.slice(0, args.indexOf('--') < 0 ? undefined : args.indexOf('--'));
    if (args.length === 1 || ownArgs.includes("--help") || ownArgs.includes("-h")) { console.log(controlHelp); return 0; }
    try {
      const command = await controlCommand(args.slice(1), async () => { let input = ""; for await (const chunk of process.stdin) { input += String(chunk); if (input.length > 100_000) throw new Error("输入过大"); } return input; });
      identifyCommand(command);
      // Emit before dispatch so even an interrupted CLI leaves its operation ID in tool output.
      console.error(JSON.stringify({ event: 'request.started', requestId: command.requestId, command: command.name }));
      const result = command.name === 'skill.run' ? await (await import('./skill-runner.js')).runSkillScript(command, process.env) : await sendControl(command, process.env);
      console.log(JSON.stringify(result)); return result.ok ? 0 : 3;
    } catch (error) {
      console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), ...(error instanceof ControlTransportError ? { requestId: error.requestId, outcome: error.outcome } : {}) })); return 4;
    }
  }
  if (args[0] === "serve") {
    config({ path: new URL("../.env", import.meta.url), quiet: true });
    const { startService } = await import("./server.js");
    const service = await startService(projectDir, process.env.RAFT_DATA_DIR || join(homedir(), "Library/Application Support/RaftAgent"), process.env);
    console.log(JSON.stringify({ ready: true, url: service.url }));
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; void service.close().then(() => { process.exitCode = 0; }).catch(error => { console.error(String(error)); process.exitCode = 1; }); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    return 0;
  }
  return main();
}
try { process.exitCode = await dispatch(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
