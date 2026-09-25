import { PUMP_PROGRAM_ID, PUMP_SDK } from "@pump-fun/pump-sdk";
import {
  ComputeBudgetProgram,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config } from "../config.js";
import {
  getGlobal,
  getLiveArm,
  markFired,
  tokenProgram,
} from "../state/arm.js";
import { walletKeypairs } from "../state/wallets.js";
import { sendBundles, sendIndividual, tipInstruction } from "./submit.js";

const SELL_COMPUTE_UNITS = 180_000;
const ANY_PRICE_SLIPPAGE = 100;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function dummyCurveInfo(): AccountInfo<Buffer> {
  return {
    data: Buffer.alloc(82),
    executable: false,
    owner: PUMP_PROGRAM_ID,
    lamports: 1_000_000,
  };
}

/**
 * Hot path fire: no RPC reads.
 * Uses latest shred blockhash + stream-tracked balances.
 */
export async function fireSells(): Promise<unknown> {
  const live = getLiveArm();
  if (!live) throw new Error("not armed");
  if (live.fired) return live.fireResult ?? { ok: true, already: true };

  const blockhash = live.latestBlockhash;
  if (!blockhash) {
    throw new Error("no shred blockhash yet — cannot sign");
  }

  const global = getGlobal();
  const tipLamports = Math.round(config.jitoTipSol * 1e9);
  const wallets = walletKeypairs();
  const holders: { keypair: Keypair; label: string; tokens: BN }[] = [];

  for (const w of wallets) {
    const addr = w.keypair.publicKey.toBase58();
    const tokens = live.balances.get(addr) ?? new BN(0);
    if (tokens.gtn(0)) holders.push({ ...w, tokens });
  }

  if (holders.length === 0) {
    const result = { ok: false, reason: "no tracked token balances to sell" };
    markFired(result);
    return result;
  }

  const curveInfo = dummyCurveInfo();
  const packResults: {
    packIndex: number;
    wallets: string[];
    signatures: string[];
    bundleId?: string;
  }[] = [];

  const packs = chunk(holders, config.sellPackSize);

  await Promise.all(
    packs.map(async (pack, i) => {
      const encoded: string[] = [];
      const sigs: string[] = [];
      const addrs: string[] = [];

      for (const h of pack) {
        const owner = h.keypair.publicKey;
        const sellIxs = await PUMP_SDK.sellInstructions({
          global,
          bondingCurveAccountInfo: curveInfo,
          bondingCurve: live.curve,
          mint: live.mint,
          user: owner,
          amount: h.tokens,
          solAmount: new BN(0),
          slippage: ANY_PRICE_SLIPPAGE,
          tokenProgram: tokenProgram(),
          mayhemMode: live.curve.isMayhemMode,
        });

        const instructions = [
          ComputeBudgetProgram.setComputeUnitLimit({
            units: SELL_COMPUTE_UNITS,
          }),
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: config.priorityMicroLamports,
          }),
          ...sellIxs,
        ];
        if (tipLamports > 0) {
          instructions.push(tipInstruction(owner, tipLamports));
        }

        const message = new TransactionMessage({
          payerKey: owner,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message([]);

        const tx = new VersionedTransaction(message);
        tx.sign([h.keypair]);
        const raw = Buffer.from(tx.serialize());
        if (raw.length > 1232) {
          throw new Error(`sell tx too large for ${owner.toBase58()}`);
        }
        encoded.push(raw.toString("base64"));
        sigs.push(bs58.encode(tx.signatures[0]!));
        addrs.push(owner.toBase58());
      }

      let bundleId: string | undefined;
      try {
        bundleId = await sendBundles(encoded);
      } catch (err) {
        console.warn(
          `[fire] pack ${i} bundle failed:`,
          err instanceof Error ? err.message : err,
        );
        await sendIndividual(encoded);
      }
      packResults.push({
        packIndex: i,
        wallets: addrs,
        signatures: sigs,
        bundleId,
      });
    }),
  );

  const result = {
    ok: true,
    mint: live.mintStr,
    blockhash,
    packs: packResults,
    at: new Date().toISOString(),
  };
  markFired(result);
  console.log(
    `[fire] submitted ${holders.length} sells in ${packResults.length} packs`,
  );
  return result;
}
