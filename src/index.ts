import "./loadEnv.js";
import { startHttpServer } from "./api/server.js";
import { config } from "./config.js";
import { handleShredTx, warmPumpAlt } from "./parse/pump.js";
import { warmGlobal } from "./state/arm.js";
import { startUdpListener } from "./udp/listener.js";

async function main() {
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
