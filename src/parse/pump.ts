import { PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { coldRpc } from "../config.js";
import {
  applyBuyTokens,
  applySellTokens,
  creditBuy,
  debitSell,
  getLiveArm,
  noteBlockhash,
  noteCreateSeen,
  solMcFromCurve,
  getGlobal,
  setFiring,
} from "../state/arm.js";
import { fireSells } from "../sell/fire.js";

const DISC_CREATE = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);
const DISC_CREATE_V2 = Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]);
const DISC_BUY = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const DISC_BUY_EXACT_SOL = Buffer.from([56, 252, 116, 8, 158, 223, 205, 95]);
const DISC_SELL = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

const PUMP_ALT =
  process.env.PUMP_ALT_ADDRESS?.trim() ||
  "7mFD2mUtRS65XstiSAvCJuYmdesZoQwCwRJhq1p3eRMe";

let pumpAlt: AddressLookupTableAccount | null = null;

/** Cold path — load Pump ALT once so v0 txs resolve mint/user keys. */
export async function warmPumpAlt(connection?: Connection): Promise<void> {
  try {
    const conn = connection ?? coldRpc();
    const res = await conn.getAddressLookupTable(new PublicKey(PUMP_ALT));
    pumpAlt = res.value;
    console.log(`[cold] Pump ALT ${pumpAlt ? "loaded" : "missing"}`);
  } catch (err) {
    console.warn(
      "[cold] ALT load failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

function discEq(data: Uint8Array, disc: Buffer): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) if (data[i] !== disc[i]) return false;
  return true;
}

function readU64LE(data: Uint8Array, offset: number): BN {
  const buf = Buffer.from(data.subarray(offset, offset + 8));
  return new BN(buf, "le");
}

function resolveAccountKeys(tx: VersionedTransaction): PublicKey[] {
  const msg = tx.message;
  try {
    const ak = msg.getAccountKeys(
      pumpAlt ? { addressLookupTableAccounts: [pumpAlt] } : undefined,
    );
    const out: PublicKey[] = [];
    for (let i = 0; i < ak.length; i++) {
      const k = ak.get(i);
      if (k) out.push(k);
    }
    if (out.length) return out;
  } catch {
    // fall through
  }
  return msg.staticAccountKeys.slice();
}

/**
 * Hot path: update curve / balances for armed mint; latch-fire on MC.
 */
export function handleShredTx(tx: VersionedTransaction, slot: bigint): void {
  const live = getLiveArm();
  if (!live || live.fired) return;

  noteBlockhash(tx.message.recentBlockhash, slot);

  const keys = resolveAccountKeys(tx);
  const pumpStr = PUMP_PROGRAM_ID.toBase58();
  const mintStr = live.mintStr;

  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program || program.toBase58() !== pumpStr) continue;
    const data = ix.data;
    const acc = (i: number) => {
      const idx = ix.accountKeyIndexes[i];
      return idx === undefined ? null : keys[idx] ?? null;
    };

    if (discEq(data, DISC_CREATE) || discEq(data, DISC_CREATE_V2)) {
      const mint = acc(0);
      if (mint?.toBase58() === mintStr) noteCreateSeen();
      continue;
    }

    const isBuy = discEq(data, DISC_BUY) || discEq(data, DISC_BUY_EXACT_SOL);
    const isSell = discEq(data, DISC_SELL);
    if (!isBuy && !isSell) continue;

    const mint = acc(2);
    if (!mint || mint.toBase58() !== mintStr) continue;

    const user = acc(6);
    if (!user) continue;
    const userStr = user.toBase58();

    if (isBuy) {
      if (discEq(data, DISC_BUY)) {
        const tokenAmount = readU64LE(data, 8);
        applyBuyTokens(tokenAmount);
        creditBuy(userStr, tokenAmount);
      } else {
        const solIn = readU64LE(data, 8);
        const curve = live.curve;
        const tokens = solIn
          .mul(curve.virtualTokenReserves)
          .div(curve.virtualQuoteReserves.add(solIn));
        applyBuyTokens(tokens);
        creditBuy(userStr, tokens);
      }
    } else {
      const tokenAmount = readU64LE(data, 8);
      applySellTokens(tokenAmount);
      debitSell(userStr, tokenAmount);
    }
  }

  const mc = solMcFromCurve(live.curve, getGlobal());
  if (mc >= live.targetSolMc && !live.fired && !live.firing) {
    console.log(
      `[trigger] SOL MC ${mc.toFixed(4)} ≥ ${live.targetSolMc} — firing sells`,
    );
    const p = fireSells()
      .then(() => undefined)
      .catch((err) => {
        console.error(
          "[fire] failed:",
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => setFiring(null));
    setFiring(p);
  }
}
