import { Connection } from "@solana/web3.js";

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  udpPort: num("UDP_PORT", 8001),
  httpPort: num("HTTP_PORT", 8787),
  authToken: process.env.AUTH_TOKEN?.trim() || "change-me",
  rpcUrl:
    process.env.SOLANA_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
    "https://api.mainnet-beta.solana.com",
  jitoTipSol: num("JITO_TIP_SOL", 0.001),
  priorityMicroLamports: num("PRIORITY_MICRO_LAMPORTS", 100_000),
  sellPackSize: Math.min(5, Math.max(1, num("SELL_PACK_SIZE", 4))),
  heliusUseSender: process.env.HELIUS_USE_SENDER === "1",
  heliusApiKey: process.env.HELIUS_API_KEY?.trim() || "",
  jitoUuid: process.env.JITO_UUID?.trim() || "",
};

export function coldRpc(): Connection {
  return new Connection(config.rpcUrl, "confirmed");
}
