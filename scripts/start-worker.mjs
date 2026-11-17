#!/usr/bin/env node
/**
 * Локальное продакшен-превью: запускает собранный Worker через Wrangler
 * (Miniflare) с привязками D1/R2 и общим состоянием .wrangler/state —
 * как описано в README («npm run start»).
 *
 * Пример: npm start
 *         npm start -- --port 8790
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = path.join(projectRoot, "dist", "server", "wrangler.json");

if (!existsSync(config)) {
  console.error("Не найден dist/server/wrangler.json. Сначала выполните сборку: npm run build.");
  process.exit(1);
}

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const port = portFlag >= 0 ? args[portFlag + 1] : "8787";
const extraArgs = args.filter((_value, index) => portFlag < 0 || !(index === portFlag || index === portFlag + 1));

const wrangler = path.join(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const child = spawn(
  process.execPath,
  [
    "--import",
    path.join(projectRoot, "scripts", "sites-env.mjs"),
    wrangler,
    "dev",
    "--config",
    config,
    "--persist-to",
    path.join(projectRoot, ".wrangler", "state"),
    "--ip",
    "127.0.0.1",
    "--port",
    port,
    ...extraArgs,
  ],
  { stdio: "inherit", cwd: projectRoot },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
