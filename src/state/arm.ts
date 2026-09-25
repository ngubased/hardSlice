import {
  OnlinePumpSdk,
  newBondingCurve,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from "@pump-fun/pump-sdk";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { coldRpc, config } from "../config.js";
import { walletKeypairs, walletPubkeySet } from "./wallets.js";

export type ArmStatus =
  | { kind: "idle" }
  | {
      kind: "armed";
      mint: string;
      targetSolMc: number;
      creator: string;
      armedAt: string;
      fired: boolean;
      firedAt?: string;
      solMc: number;
      balances: Record<string, string>;
      createSeen: boolean;
      latestBlockhash: string | null;
      lastSlot: string | null;
      fireResult?: unknown;
    };

let globalCache: Global | null = null;
let feeConfigCache: FeeConfig | null = null;

export async function warmGlobal(): Promise<Global> {
  if (globalCache) return globalCache;
  const online = new OnlinePumpSdk(coldRpc());
  globalCache = await online.fetchGlobal();
  try {
    feeConfigCache = await online.fetchFeeConfig();
  } catch {
    feeConfigCache = null;
  }
  console.log("[cold] loaded Pump global + feeConfig");
  return globalCache;
}

export function getGlobal(): Global {
  if (!globalCache) {
    throw new Error("Global not warmed — call warmGlobal() at startup");
  }
  return globalCache;
}

export function getFeeConfig(): FeeConfig | null {
  return feeConfigCache;
}

type LiveArm = {
  mint: PublicKey;
  mintStr: string;
  targetSolMc: number;
  creator: PublicKey;
  curve: BondingCurve;
  balances: Map<string, BN>;
  watched: Set<string>;
  createSeen: boolean;
  fired: boolean;
  firedAt?: string;
  armedAt: string;
  latestBlockhash: string | null;
  lastSlot: bigint | null;
  fireResult?: unknown;
  firing: Promise<void> | null;
};

let live: LiveArm | null = null;

/** SOL market cap from virtual reserves (same units as targetSolMc). */
export function solMcFromCurve(curve: BondingCurve, global: Global): number {
  if (curve.virtualTokenReserves.lten(0)) return 0;
  // price * supply in SOL
  const lamports = curve.virtualQuoteReserves
    .mul(global.tokenTotalSupply)
    .div(curve.virtualTokenReserves);
  return lamports.toNumber() / 1e9;
}

export function getArmStatus(): ArmStatus {
  if (!live) return { kind: "idle" };
  const balances: Record<string, string> = {};
  for (const [k, v] of live.balances) balances[k] = v.toString();
  return {
    kind: "armed",
    mint: live.mintStr,
    targetSolMc: live.targetSolMc,
    creator: live.creator.toBase58(),
    armedAt: live.armedAt,
    fired: live.fired,
    firedAt: live.firedAt,
    solMc: solMcFromCurve(live.curve, getGlobal()),
    balances,
    createSeen: live.createSeen,
    latestBlockhash: live.latestBlockhash,
    lastSlot: live.lastSlot?.toString() ?? null,
    fireResult: live.fireResult,
  };
}

export function getLiveArm(): LiveArm | null {
  return live;
}

export function disarm(): void {
  live = null;
}

export type ArmInput = {
  mint: string;
  targetSolMc: number;
  /** Bonding-curve creator (usually the launch station dev wallet) */
  creator: string;
};

/**
 * Cold path: derive watch set + seed curve from global.
 * UDP listener is already running — this only flips the filter.
 */
export async function arm(input: ArmInput): Promise<ArmStatus> {
  await warmGlobal();
  const global = getGlobal();
  const wallets = walletKeypairs();
  if (wallets.length === 0) {
    throw new Error("No wallets on VPS — PUT /wallets first");
  }
  if (!input.mint || input.targetSolMc <= 0) {
    throw new Error("mint and targetSolMc > 0 required");
  }

  const mint = new PublicKey(input.mint);
  const creator = new PublicKey(input.creator);
  const watched = walletPubkeySet();
  watched.add(creator.toBase58());

  const balances = new Map<string, BN>();
  for (const addr of watched) balances.set(addr, new BN(0));

  live = {
    mint,
    mintStr: mint.toBase58(),
    targetSolMc: input.targetSolMc,
    creator,
    curve: {
      ...newBondingCurve(global),
      creator,
      isMayhemMode: false,
    },
    balances,
    watched,
    createSeen: false,
    fired: false,
    armedAt: new Date().toISOString(),
    latestBlockhash: null,
    lastSlot: null,
    fireResult: undefined,
    firing: null,
  };

  console.log(
    `[arm] mint=${live.mintStr} targetSolMc=${live.targetSolMc} wallets=${wallets.length} tip=${config.jitoTipSol}`,
  );
  return getArmStatus();
}

export function noteBlockhash(blockhash: string, slot: bigint) {
  if (!live) return;
  live.latestBlockhash = blockhash;
  live.lastSlot = slot;
}

export function noteCreateSeen() {
  if (!live) return;
  live.createSeen = true;
}

export function creditBuy(owner: string, tokens: BN) {
  if (!live || tokens.lten(0)) return;
  if (!live.watched.has(owner)) return;
  const prev = live.balances.get(owner) ?? new BN(0);
  live.balances.set(owner, prev.add(tokens));
}

export function debitSell(owner: string, tokens: BN) {
  if (!live || tokens.lten(0)) return;
  const prev = live.balances.get(owner) ?? new BN(0);
  const next = prev.sub(tokens);
  live.balances.set(owner, next.gtn(0) ? next : new BN(0));
}

export function applyBuyTokens(tokenAmount: BN) {
  if (!live || tokenAmount.lten(0)) return;
  const curve = live.curve;
  const remaining = curve.virtualTokenReserves.sub(tokenAmount);
  if (remaining.lten(0)) return;
  const solIn = tokenAmount
    .mul(curve.virtualQuoteReserves)
    .div(remaining);
  live.curve = {
    ...curve,
    virtualTokenReserves: remaining,
    virtualQuoteReserves: curve.virtualQuoteReserves.add(solIn),
    realTokenReserves: curve.realTokenReserves.sub(tokenAmount),
    realQuoteReserves: curve.realQuoteReserves.add(solIn),
  };
}

export function applySellTokens(tokenAmount: BN) {
  if (!live || tokenAmount.lten(0)) return;
  const curve = live.curve;
  const solOut = tokenAmount
    .mul(curve.virtualQuoteReserves)
    .div(curve.virtualTokenReserves.add(tokenAmount));
  live.curve = {
    ...curve,
    virtualTokenReserves: curve.virtualTokenReserves.add(tokenAmount),
    virtualQuoteReserves: curve.virtualQuoteReserves.sub(solOut),
    realTokenReserves: curve.realTokenReserves.add(tokenAmount),
    realQuoteReserves: BN.max(new BN(0), curve.realQuoteReserves.sub(solOut)),
  };
}

export function tokenProgram(): PublicKey {
  return TOKEN_2022_PROGRAM_ID;
}

export function markFired(result: unknown) {
  if (!live) return;
  live.fired = true;
  live.firedAt = new Date().toISOString();
  live.fireResult = result;
}

export function setFiring(p: Promise<void> | null) {
  if (!live) return;
  live.firing = p;
}
