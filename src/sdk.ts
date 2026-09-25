/**
 * Load @pump-fun/pump-sdk via CommonJS.
 * The package's ESM build pulls agent-payments-sdk which does
 * `import { BN } from "@coral-xyz/anchor"` — that named export does not
 * exist under Node ESM and crashes on start. CJS require works.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sdk = require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");

export const {
  OnlinePumpSdk,
  PUMP_SDK,
  PUMP_PROGRAM_ID,
  newBondingCurve,
} = sdk;

export type {
  BondingCurve,
  FeeConfig,
  Global,
} from "@pump-fun/pump-sdk";
