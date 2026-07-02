import { useRef, useState, useCallback } from "react";

import { buildEntropySeed, clamp16, clamp16Signed } from "@/utils/entropy";

const TARGET_ENTROPY = 2048;
const MAX_ENTROPY_BYTES = 4096;

/**
 * Collects user-interaction entropy for ceremony contributions.
 *
 * Entropy is gathered from pointer movements (2 bits each) and taps/clicks
 * (45 bits each). Each event is packed into a 16-byte sample containing
 * coordinates, deltas, timing, and a monotonic counter, then appended to
 * a ring buffer capped at {@link MAX_ENTROPY_BYTES}.
 *
 * Uses Pointer Events so touch, pen, and mouse all contribute equally.
 *
 * Once {@link TARGET_ENTROPY} bits are collected, `isReady` flips to `true`.
 * Call {@link buildSeed} to mix the collected bytes with CSPRNG output
 * via SHA-256, producing a 64-byte seed suitable for per-circuit derivation.
 */
export function useEntropyCollector() {
  const entropyCountRef = useRef(0);
  const entropyBytesRef = useRef<number[]>([]);
  const eventCountRef = useRef(0);
  const lastPointerRef = useRef({ x: 0, y: 0, time: 0 });
  const areaRef = useRef<HTMLDivElement>(null);

  const [entropyPercent, setEntropyPercent] = useState(0);
  const [isReady, setIsReady] = useState(false);

  const appendEntropyBytes = useCallback((bytes: Uint8Array) => {
    const bucket = entropyBytesRef.current;
    if (bucket.length + bytes.length > MAX_ENTROPY_BYTES) {
      bucket.splice(0, bytes.length);
    }
    for (const value of bytes) {
      bucket.push(value);
    }
  }, []);

  const recordSample = useCallback(
    (event: {
      x: number;
      y: number;
      dx: number;
      dy: number;
      typeCode: number;
    }) => {
      const time = Date.now();
      const buffer = new Uint8Array(16);
      const view = new DataView(buffer.buffer);
      const timeLow = time >>> 0;
      const timeHigh = Math.floor(time / 2 ** 32) >>> 0;

      view.setUint32(0, timeLow);
      view.setUint16(4, clamp16(event.x));
      view.setUint16(6, clamp16(event.y));
      view.setInt16(8, clamp16Signed(event.dx));
      view.setInt16(10, clamp16Signed(event.dy));

      buffer[12] = event.typeCode & 0xff;
      buffer[13] = eventCountRef.current & 0xff;
      buffer[14] = (eventCountRef.current >> 8) & 0xff;
      buffer[15] = (timeHigh ^ timeLow) & 0xff;

      eventCountRef.current += 1;
      appendEntropyBytes(buffer);
    },
    [appendEntropyBytes],
  );

  const addEntropy = useCallback(
    (amount: number) => {
      entropyCountRef.current += amount;
      const pct = Math.min(
        (entropyCountRef.current / TARGET_ENTROPY) * 100,
        100,
      );
      setEntropyPercent(Math.floor(pct));
      if (pct >= 100 && !isReady) {
        setIsReady(true);
      }
    },
    [isReady],
  );

  /** Records a pointer-move event, updating the CSS glow vars and sampling entropy. */
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = areaRef.current;
      if (!el || isReady) return;

      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const now = Date.now();

      el.style.setProperty("--mx", `${e.clientX}px`);
      el.style.setProperty("--my", `${e.clientY}px`);

      const dx = x - lastPointerRef.current.x;
      const dy = y - lastPointerRef.current.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const dt = now - lastPointerRef.current.time;

      if (dt > 0 && dist > 3) {
        recordSample({ x, y, dx, dy, typeCode: 1 });
        addEntropy(2);
      }

      lastPointerRef.current = { x, y, time: now };
    },
    [isReady, recordSample, addEntropy],
  );

  /** Records a tap/click entropy sample (45 bits). */
  const recordTap = useCallback(
    (x: number, y: number) => {
      if (isReady) return;
      recordSample({ x, y, dx: 0, dy: 0, typeCode: 2 });
      addEntropy(45);
    },
    [isReady, recordSample, addEntropy],
  );

  /** Records a keyboard event entropy sample (10 bits). */
  const recordKeyPress = useCallback(
    (keyCode: number) => {
      if (isReady) return;
      recordSample({ x: keyCode, y: 0, dx: 0, dy: 0, typeCode: 3 });
      addEntropy(10);
    },
    [isReady, recordSample, addEntropy],
  );

  /** Mixes collected bytes with CSPRNG output via SHA-256 into a 64-byte seed. */
  const buildSeed = useCallback(async (): Promise<Uint8Array> => {
    const seed = await buildEntropySeed(entropyBytesRef.current);
    entropyBytesRef.current = [];
    return seed;
  }, []);

  return {
    entropyPercent,
    isReady,
    areaRef,
    handlePointerMove,
    recordTap,
    recordKeyPress,
    buildSeed,
  };
}
