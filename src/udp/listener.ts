import dgram from "node:dgram";
import { VersionedTransaction } from "@solana/web3.js";

const FRAME_MAGIC = 0x5ae7;
const FRAME_VERSION = 2;
const MSG_DECODED_TX = 2;
const HEADER_LEN = 16;
const SLOT_LEN = 8;

export type DecodedShred = {
  seq: bigint;
  slot: bigint;
  tx: VersionedTransaction;
  raw: Buffer;
};

export type ShredHandler = (update: DecodedShred) => void;

export function parseDecodedDatagram(dgramBuf: Buffer): DecodedShred | null {
  if (dgramBuf.length < HEADER_LEN + SLOT_LEN + 32) return null;
  const magic = dgramBuf.readUInt16LE(0);
  const version = dgramBuf.readUInt8(2);
  const msgType = dgramBuf.readUInt8(3);
  if (magic !== FRAME_MAGIC || version !== FRAME_VERSION) return null;
  if (msgType !== MSG_DECODED_TX) return null;

  const seq = dgramBuf.readBigUInt64LE(8);
  const slot = dgramBuf.readBigUInt64LE(HEADER_LEN);
  const txBytes = dgramBuf.subarray(HEADER_LEN + SLOT_LEN);
  try {
    const tx = VersionedTransaction.deserialize(txBytes);
    return { seq, slot, tx, raw: Buffer.from(txBytes) };
  } catch {
    return null;
  }
}

/** Always-on UDP drain — big RCVBUF, dedicated socket loop. */
export function startUdpListener(
  port: number,
  onTx: ShredHandler,
): dgram.Socket {
  const sock = dgram.createSocket("udp4");
  let expected: bigint | null = null;
  let gaps = 0;
  let ok = 0;

  sock.on("message", (msg) => {
    const parsed = parseDecodedDatagram(msg);
    if (!parsed) return;
    if (expected !== null && parsed.seq !== expected) {
      gaps += Number(parsed.seq - expected);
      if (gaps % 100 === 1) {
        console.warn(
          `[udp] seq gap — lost≈${gaps} total (last expected ${expected}, got ${parsed.seq})`,
        );
      }
    }
    expected = parsed.seq + 1n;
    ok += 1;
    if (ok % 5000 === 0) {
      console.log(`[udp] decoded ${ok} txs · gaps≈${gaps} · slot=${parsed.slot}`);
    }
    try {
      onTx(parsed);
    } catch (err) {
      console.error(
        "[udp] handler error:",
        err instanceof Error ? err.message : err,
      );
    }
  });

  sock.on("listening", () => {
    try {
      sock.setRecvBufferSize(8 * 1024 * 1024);
    } catch {
      // platform may clamp
    }
    const addr = sock.address();
    console.log(
      `[udp] listening 0.0.0.0:${typeof addr === "object" ? addr.port : port}`,
    );
  });

  sock.on("error", (err) => {
    console.error("[udp]", err.message);
  });

  sock.bind(port);
  return sock;
}
