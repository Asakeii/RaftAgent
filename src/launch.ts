import { spawn } from "node:child_process";
import electron from "electron";
import { fileURLToPath } from "node:url";
const env: NodeJS.ProcessEnv = { ...process.env, RAFT_NODE: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron as unknown as string, [fileURLToPath(new URL("./desktop.js", import.meta.url))], { stdio: "inherit", env });
child.on("exit", code => { process.exitCode = code ?? 1; });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
