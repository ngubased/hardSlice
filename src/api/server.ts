import http from "node:http";
import { config } from "../config.js";
import {
  arm,
  disarm,
  getArmStatus,
  warmGlobal,
} from "../state/arm.js";
import { loadWallets } from "../state/wallets.js";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
  });
  res.end(raw);
}

function authorized(req: http.IncomingMessage): boolean {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : hdr.trim();
  return token === config.authToken;
}

export function startHttpServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      json(res, 204, {});
      return;
    }

    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const path = url.pathname;

    try {
      if (path === "/health" && req.method === "GET") {
        json(res, 200, { ok: true, service: "hardslice" });
        return;
      }

      if (!authorized(req) && path !== "/health") {
        json(res, 401, { error: "unauthorized" });
        return;
      }

      if (path === "/status" && req.method === "GET") {
        json(res, 200, {
          ok: true,
          wallets: loadWallets().map((w) => ({
            address: w.address,
            label: w.label,
          })),
          arm: getArmStatus(),
          udpPort: config.udpPort,
          httpPort: config.httpPort,
        });
        return;
      }

      if (path === "/arm" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as {
          mint?: string;
          targetSolMc?: number;
          creator?: string;
        };
        if (!body.mint || !body.creator || !(Number(body.targetSolMc) > 0)) {
          json(res, 400, {
            error: "mint, creator, and targetSolMc > 0 required",
          });
          return;
        }
        await warmGlobal();
        const status = await arm({
          mint: body.mint.trim(),
          creator: body.creator.trim(),
          targetSolMc: Number(body.targetSolMc),
        });
        json(res, 200, { ok: true, arm: status });
        return;
      }

      if (path === "/disarm" && req.method === "POST") {
        disarm();
        json(res, 200, { ok: true, arm: getArmStatus() });
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[http]", message);
      json(res, 500, { error: message });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[http] control API on 0.0.0.0:${port}`);
  });
  return server;
}
