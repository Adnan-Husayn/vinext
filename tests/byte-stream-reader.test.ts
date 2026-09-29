import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vite-plus/test";
import { getByteStreamReader } from "../packages/vinext/src/server/byte-stream-reader.js";

// Byte streams only use BYOB reads on workerd.
vi.hoisted(() => {
  vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    type: "bytes",
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk.slice());
      controller.close();
    },
  });
}

async function readAll(reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">) {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe("getByteStreamReader", () => {
  it("coalesces queued byte-stream chunks into exact-size reads of up to 64 KiB", async () => {
    const source = Array.from({ length: 40 }, (_, i) => new Uint8Array(4096).fill(i));

    const chunks = await readAll(getByteStreamReader(byteStream(source)));

    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([65536, 65536, 32768]);
    expect(chunks.every((chunk) => chunk.byteLength === chunk.buffer.byteLength)).toBe(true);
    expect(Buffer.from(concat(chunks)).equals(concat(source))).toBe(true);
  });

  it("reads Response bodies through BYOB reads", async () => {
    const text = "hello world ".repeat(20000);

    const chunks = await readAll(getByteStreamReader(new Response(text).body!));

    expect(chunks.every((chunk) => chunk.byteLength <= 65536)).toBe(true);
    expect(decoder.decode(concat(chunks))).toBe(text);
  });

  it("falls back to a default reader for non-byte streams", async () => {
    const empty = new Uint8Array();
    const body = encoder.encode("body");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(empty);
        controller.enqueue(body);
        controller.close();
      },
    });

    const chunks = await readAll(getByteStreamReader(source));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(empty);
    expect(chunks[1]).toBe(body);
  });

  it("throws for a locked stream", () => {
    const source = byteStream([encoder.encode("a")]);
    source.getReader();

    expect(() => getByteStreamReader(source)).toThrow(TypeError);
  });

  it("resolves each read with the bytes available so far", async () => {
    let controller!: ReadableByteStreamController;
    const source = new ReadableStream({
      type: "bytes",
      start(c) {
        controller = c;
      },
    });
    const reader = getByteStreamReader(source);

    const first = reader.read();
    controller.enqueue(encoder.encode("abc"));
    const firstChunk = (await first).value!;
    expect(decoder.decode(firstChunk)).toBe("abc");
    expect(firstChunk.buffer.byteLength).toBe(3);

    const second = reader.read();
    controller.enqueue(encoder.encode("xyz"));
    expect(decoder.decode((await second).value)).toBe("xyz");
    // The reused read buffer must not alias chunks already handed out.
    expect(decoder.decode(firstChunk)).toBe("abc");

    const last = reader.read();
    controller.close();
    await expect(last).resolves.toEqual({ done: true, value: undefined });
  });

  it("settles a read left pending when the byte source closes without responding", async () => {
    const source = () =>
      new ReadableStream({
        type: "bytes",
        pull(controller) {
          controller.close();
        },
      });

    // Per spec a raw BYOB read here never settles, because the source does not
    // call byobRequest.respond(0).
    let rawSettled = false;
    void source()
      .getReader({ mode: "byob" })
      .read(new Uint8Array(16))
      .then(() => {
        rawSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rawSettled).toBe(false);

    await expect(getByteStreamReader(source()).read()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("settles every overlapping read left pending when the byte source closes", async () => {
    let controller!: ReadableByteStreamController;
    const reader = getByteStreamReader(
      new ReadableStream({
        type: "bytes",
        start(c) {
          controller = c;
        },
      }),
    );

    const reads = Promise.all([reader.read(), reader.read()]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.close();

    await expect(reads).resolves.toEqual([
      { done: true, value: undefined },
      { done: true, value: undefined },
    ]);
  });

  it("resolves reads after close like a default reader", async () => {
    const reader = getByteStreamReader(byteStream([encoder.encode("a")]));

    await readAll(reader);

    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("delivers the final chunk when the same close resolves the reader", async () => {
    // Reading the last queued bytes of a close-requested stream resolves
    // `closed` before the read itself.
    const chunks = await readAll(getByteStreamReader(byteStream([encoder.encode("final")])));

    expect(chunks.map((chunk) => decoder.decode(chunk))).toEqual(["final"]);
  });

  it("propagates cancellation to the byte source", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream({
      type: "bytes",
      pull(controller) {
        controller.enqueue(encoder.encode("x"));
      },
      cancel,
    });
    const reader = getByteStreamReader(source);

    await reader.read();
    await reader.cancel("bye");

    expect(cancel).toHaveBeenCalledWith("bye");
  });
});

describe("getByteStreamReader outside workerd", () => {
  it("keeps default reads so fully-buffered bodies stay one chunk", async () => {
    vi.stubGlobal("navigator", { userAgent: "Node.js/24" });
    vi.resetModules();
    const { getByteStreamReader: getNodeByteStreamReader } =
      await import("../packages/vinext/src/server/byte-stream-reader.js");
    const text = "hello world ".repeat(20000);
    const source = Array.from({ length: 40 }, (_, i) => new Uint8Array(4096).fill(i));

    const bodyChunks = await readAll(getNodeByteStreamReader(new Response(text).body!));
    const streamChunks = await readAll(getNodeByteStreamReader(byteStream(source)));

    expect(bodyChunks).toHaveLength(1);
    expect(decoder.decode(bodyChunks[0])).toBe(text);
    expect(streamChunks.map((chunk) => chunk.byteLength)).toEqual(source.map(() => 4096));
  });
});
