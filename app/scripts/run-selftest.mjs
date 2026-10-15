// Runs the built app in self-test mode with throwaway settings, a throwaway
// reminder database and no API keys, then prints the results.
//   npm run selftest            (results go to ./selftest-output)

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import electron from "electron";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.env.BIT_SELFTEST_DIR ?? path.join(appDir, "selftest-output"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bit-selftest-"));

fs.rmSync(outDir, { recursive: true, force: true });
const env = {
  ...process.env,
  BIT_SELFTEST_DIR: outDir,
  BIT_USER_DATA: path.join(tmp, "userData"),
  BIT_BACKEND_DB: path.join(tmp, "selftest.db"),
  BIT_NO_LLM: "1",
  REMINDER_APPS_DRY_RUN: "1", // "open calculator" is checked, never really opened
};
delete env.ELECTRON_RUN_AS_NODE; // would turn electron.exe into plain node

const child = spawn(electron, [appDir], { env, stdio: "inherit" });
const timer = setTimeout(() => {
  console.error("self-test timed out");
  child.kill();
}, 10 * 60_000);
child.on("exit", (code) => {
  clearTimeout(timer);
  const file = path.join(outDir, "results.json");
  if (fs.existsSync(file)) console.log(fs.readFileSync(file, "utf8"));
  else console.error("no results written");
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code ?? 1);
});
