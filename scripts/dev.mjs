import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import electronPath from "electron";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({ root, server: { port: 5177, strictPort: false } });
await server.listen();

const urls = server.resolvedUrls?.local ?? [];
const devServerUrl = urls[0] ?? "http://127.0.0.1:5177/";
console.log(`MindBoard dev server: ${devServerUrl}`);

const electron = spawn(electronPath, ["."], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: devServerUrl
  }
});

const shutdown = async (code = 0) => {
  await server.close();
  process.exit(code);
};

electron.on("exit", (code) => {
  void shutdown(code ?? 0);
});

process.on("SIGINT", () => {
  electron.kill("SIGINT");
  void shutdown(0);
});
