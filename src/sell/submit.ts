import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
].map((a) => new PublicKey(a));

export const HELIUS_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
].map((a) => new PublicKey(a));

const JITO_REGIONS = [
  "mainnet",
  "amsterdam",
  "frankfurt",
  "ny",
  "tokyo",
] as const;

function pick(accounts: PublicKey[]): PublicKey {
  return accounts[Math.floor(Math.random() * accounts.length)]!;
}

function heliusSenderUrl(): string {
  return process.env.HELIUS_SENDER_URL?.trim() || "https://sender.helius-rpc.com/fast";
}

function useHelius(): boolean {
  return (
    process.env.HELIUS_USE_SENDER === "1" &&
    Boolean(process.env.HELIUS_API_KEY?.trim() || process.env.HELIUS_RPC_URL?.trim())
  );
}

export function tipInstruction(
  payer: PublicKey,
  tipLamports: number,
): TransactionInstruction {
  if (useHelius()) {
    return SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: pick(HELIUS_TIP_ACCOUNTS),
      lamports: Math.max(tipLamports, 1_000_000),
    });
  }
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: pick(JITO_TIP_ACCOUNTS),
    lamports: tipLamports,
  });
}

function jitoAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const uuid = process.env.JITO_UUID?.trim();
  if (uuid) headers["x-jito-auth"] = uuid;
  return headers;
}

function withUuid(url: string): string {
  const uuid = process.env.JITO_UUID?.trim();
  if (!uuid) return url;
  return `${url}${url.includes("?") ? "&" : "?"}uuid=${encodeURIComponent(uuid)}`;
}

function bundlesUrl(region: (typeof JITO_REGIONS)[number]): string {
  if (region === "mainnet") {
    return "https://mainnet.block-engine.jito.wtf/api/v1/bundles";
  }
  return `https://${region}.mainnet.block-engine.jito.wtf/api/v1/bundles`;
}

function txUrl(region: (typeof JITO_REGIONS)[number]): string {
  if (region === "mainnet") {
    return "https://mainnet.block-engine.jito.wtf/api/v1/transactions";
  }
  return `https://${region}.mainnet.block-engine.jito.wtf/api/v1/transactions`;
}

/** Submit-only — no RPC reads. */
export async function sendBundles(serializedTxsBase64: string[]): Promise<string> {
  if (serializedTxsBase64.length === 0) {
    throw new Error("empty bundle");
  }
  if (useHelius()) {
    if (serializedTxsBase64.length > 4) {
      throw new Error("Helius Sender Max: max 4 txs per bundle");
    }
    const res = await fetch(heliusSenderUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now().toString(),
        method: "sendBundle",
        params: [serializedTxsBase64, { encoding: "base64" }],
      }),
    });
    const json = (await res.json()) as {
      result?: string;
      error?: { message?: string };
    };
    if (json.error) throw new Error(json.error.message || "Helius sendBundle failed");
    return json.result || "helius-ok";
  }

  if (serializedTxsBase64.length > 5) {
    throw new Error("Jito bundles: max 5 txs");
  }
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "sendBundle",
    params: [serializedTxsBase64, { encoding: "base64" }],
  });
  const errors: string[] = [];
  const results = await Promise.allSettled(
    JITO_REGIONS.map(async (region) => {
      const res = await fetch(withUuid(bundlesUrl(region)), {
        method: "POST",
        headers: jitoAuthHeaders(),
        body,
      });
      const json = (await res.json()) as {
        result?: string;
        error?: { message?: string };
      };
      if (json.error) throw new Error(json.error.message || "Jito error");
      if (!json.result) throw new Error(`No bundle id from ${region}`);
      return json.result;
    }),
  );
  for (const r of results) {
    if (r.status === "fulfilled") return r.value;
    errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
  }
  throw new Error(`Jito sendBundle failed: ${errors.join(" | ")}`);
}

export async function sendIndividual(serializedTxBase64: string[]): Promise<void> {
  await Promise.allSettled(
    serializedTxBase64.map(async (raw) => {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [raw, { encoding: "base64" }],
      });
      await Promise.allSettled(
        JITO_REGIONS.map((region) =>
          fetch(withUuid(txUrl(region)), {
            method: "POST",
            headers: jitoAuthHeaders(),
            body,
          }),
        ),
      );
    }),
  );
}

/** Optional fallback broadcast — only if env allows; not used on first fire. */
export async function rpcBroadcast(
  connection: Connection,
  serializedTxBase64: string[],
): Promise<void> {
  await Promise.allSettled(
    serializedTxBase64.map((raw) =>
      connection.sendRawTransaction(Buffer.from(raw, "base64"), {
        skipPreflight: true,
        maxRetries: 3,
      }),
    ),
  );
}
