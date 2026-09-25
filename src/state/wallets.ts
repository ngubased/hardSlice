import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export type WalletRecord = {
  address: string;
  secret: string;
  label: string;
};

const DATA_DIR = path.join(process.cwd(), "data");
const WALLETS_PATH = path.join(DATA_DIR, "wallets.json");

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadWallets(): WalletRecord[] {
  ensureDataDir();
  if (!fs.existsSync(WALLETS_PATH)) return [];
  const raw = JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8")) as {
    wallets?: WalletRecord[];
  };
  return Array.isArray(raw.wallets) ? raw.wallets : [];
}

export function saveWallets(wallets: WalletRecord[]): void {
  ensureDataDir();
  for (const w of wallets) {
    if (!w.address || !w.secret) {
      throw new Error("Each wallet needs address + secret");
    }
    // validate secret matches address
    const kp = Keypair.fromSecretKey(bs58.decode(w.secret));
    if (kp.publicKey.toBase58() !== w.address) {
      throw new Error(`Secret mismatch for ${w.address}`);
    }
  }
  fs.writeFileSync(
    WALLETS_PATH,
    JSON.stringify({ wallets, updatedAt: new Date().toISOString() }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
}

export function walletKeypairs(): { keypair: Keypair; label: string }[] {
  return loadWallets().map((w) => ({
    keypair: Keypair.fromSecretKey(bs58.decode(w.secret)),
    label: w.label || w.address.slice(0, 8),
  }));
}

export function walletPubkeySet(): Set<string> {
  return new Set(loadWallets().map((w) => w.address));
}
