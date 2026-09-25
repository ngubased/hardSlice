/**
 * Decoded Shredstream UDP — uses the official StreamDecoder so multi-datagram
 * transactions (frag_count > 1) are reassembled. Our old parser treated each
 * fragment as a full tx → fake "decode failed" + inflated seq gaps.
 */
import dgram from "node:dgram";
import { VersionedTransaction } from "@solana/web3.js";
import {
  DEFAULT_RECV_BUFFER_BYTES,
  StreamDecoder,
} from "decoded-shredstream";

export type DecodedShred = {
  seq: bigint | null;
  slot: bigint;
  tx: VersionedTransaction;
  raw: Buffer;
};

export type ShredHandler = (update: DecodedShred) => void;

const RECV_BUF = DEFAULT_RECV_BUFFER_BYTES; // 64 MiB
const FRAME_MAGIC = 0x5ae7;

/** Always-on UDP drain — big RCVBUF, official codec (incl. fragment reassembly). */
export function startUdpListener(
  port: number,
  onTx: ShredHandler,
): dgram.Socket {
  const sock = dgram.createSocket("udp4");
  const decoder = new StreamDecoder();

  let ok = 0;
  let deserializeFails = 0;
  let lastHeartbeat = Date.now();
  let okSinceHeartbeat = 0;
  let waitingLogged = false;
  let lastSeq: bigint | null = null;
  let seqGaps = 0;

  const waitTimer = setInterval(() => {
    if (ok > 0) return;
    if (!waitingLogged) {
      console.warn(
        `[udp] still waiting for shredstream on :${port} — check dashboard IP/port + cloud SG`,
      );
      waitingLogged = true;
    }
  }, 15_000);
  waitTimer.unref?.();

  sock.on("message", (msg) => {
    // True loss: seq jumps across every datagram (including fragments).
    if (msg.length >= 16 && msg.readUInt16LE(0) === FRAME_MAGIC && msg[2] === 2) {
      const seq = msg.readBigUInt64LE(8);
      if (lastSeq !== null && seq > lastSeq + 1n) {
        seqGaps += Number(seq - lastSeq - 1n);
      }
      if (lastSeq === null || seq > lastSeq) lastSeq = seq;
    }

    const result = decoder.push(msg);
    if (result.type !== "transaction") return;

    const update = result.update;
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(update.bytes);
    } catch {
      deserializeFails += 1;
      if (deserializeFails <= 3 || deserializeFails % 1000 === 0) {
        console.warn(
          `[udp] tx deserialize failed · ${deserializeFails} total · ${update.bytes.length}B slot=${update.slot}`,
        );
      }
      return;
    }

    ok += 1;
    okSinceHeartbeat += 1;
    const slot = BigInt(update.slot);

    if (ok === 1) {
      console.log(
        `[udp] first decoded tx · slot=${slot} — stream alive (frag reassembly on)`,
      );
    } else if (ok === 10 || ok === 100 || ok === 1000 || ok % 5000 === 0) {
      const snap = decoder.stats();
      console.log(
        `[udp] decoded ${ok} txs · trueGaps≈${seqGaps} · decodeErr=${snap.decodeErrors} · slot=${slot}`,
      );
    }

    const now = Date.now();
    if (now - lastHeartbeat >= 10_000) {
      const perSec = (
        okSinceHeartbeat /
        ((now - lastHeartbeat) / 1000)
      ).toFixed(1);
      const snap = decoder.stats();
      console.log(
        `[udp] heartbeat · ${perSec} tx/s · total=${ok} · trueGaps≈${seqGaps} · deserFail=${deserializeFails} · dgrams=${snap.datagrams} · slot=${slot}`,
      );
      lastHeartbeat = now;
      okSinceHeartbeat = 0;
    }

    try {
      onTx({
        seq: null,
        slot,
        tx,
        raw: Buffer.from(update.bytes),
      });
    } catch (err) {
      console.error(
        "[udp] handler error:",
        err instanceof Error ? err.message : err,
      );
    }
  });

  sock.on("listening", () => {
    try {
      sock.setRecvBufferSize(RECV_BUF);
    } catch {
      // platform may clamp
    }
    let effective = 0;
    try {
      effective = sock.getRecvBufferSize();
    } catch {
      /* ignore */
    }
    // Linux doubles SO_RCVBUF in getsockopt
    if (process.platform === "linux" && effective > 0) {
      effective = Math.floor(effective / 2);
    }
    if (effective > 0 && effective < RECV_BUF) {
      console.warn(
        `[udp] SO_RCVBUF clamped to ${effective} (wanted ${RECV_BUF}) — run scripts/setup-ufw-shredstream.sh`,
      );
    }
    const addr = sock.address();
    console.log(
      `[udp] listening 0.0.0.0:${typeof addr === "object" ? addr.port : port} · rcvbuf≈${effective || "?"} — waiting for shredstream…`,
    );
  });

  sock.on("error", (err) => {
    console.error("[udp]", err.message);
  });

  sock.bind(port);
  return sock;
}
