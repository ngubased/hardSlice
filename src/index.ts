import fs from "node:fs";
import path from "node:path";
import { startHttpServer } from "./api/server.js";
import { config } from "./config.js";
import { handleShredTx, warmPumpAlt } from "./parse/pump.js";
import { warmGlobal } from "./state/arm.js";
import { startUdpListener } from "./udp/listener.js";

function loadEnvFile() {
  const p = path.join(process.cwd(), ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

async function main() {
  loadEnvFile();
  console.log(
    `[hardslice] starting udp=${config.udpPort} http=${config.httpPort}`,
  );

  try {
    await warmGlobal();
    await warmPumpAlt();
  } catch (err) {
    console.warn(
      "[hardslice] cold warm failed (will retry on /arm):",
      err instanceof Error ? err.message : err,
    );
  }

  startUdpListener(config.udpPort, (update) => {
    handleShredTx(update.tx, update.slot);
  });

  startHttpServer(config.httpPort);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
