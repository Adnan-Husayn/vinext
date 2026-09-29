import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { createElement, Suspense, use } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { describe, expect, it, vi } from "vite-plus/test";
import { deferUntilStreamConsumed } from "../packages/vinext/src/server/defer-until-stream-consumed.js";

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

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe("deferUntilStreamConsumed", () => {
  it("calls onFlush once after a byte stream is drained", async () => {
    const onFlush = vi.fn();
    const reader = deferUntilStreamConsumed(
      byteStream([new Uint8Array(70000), new Uint8Array(10)]),
      onFlush,
    ).getReader();

    expect((await reader.read()).value).toHaveLength(65536);
    expect(onFlush).not.toHaveBeenCalled();
    expect((await reader.read()).value).toHaveLength(4474);
    expect((await reader.read()).done).toBe(true);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("calls onFlush when the last chunk is read without a further read", async () => {
    const onFlush = vi.fn();
    const reader = deferUntilStreamConsumed(
      byteStream([encoder.encode("a"), encoder.encode("b")]),
      onFlush,
    ).getReader();

    expect(decoder.decode((await reader.read()).value)).toBe("ab");
    await vi.waitFor(() => expect(onFlush).toHaveBeenCalledTimes(1));
  });

  it("waits for the consumer to drain or cancel before calling onFlush", async () => {
    const onFlush = vi.fn();
    const wrapped = deferUntilStreamConsumed(byteStream([encoder.encode("a")]), onFlush);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onFlush).not.toHaveBeenCalled();

    await wrapped.cancel();
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("reports byte stream errors and calls onFlush once", async () => {
    const onFlush = vi.fn();
    const onError = vi.fn();
    const streamError = new Error("boom");
    let pullCount = 0;
    const source = new ReadableStream({
      type: "bytes",
      pull(controller) {
        if (pullCount++ === 0) controller.enqueue(encoder.encode("partial"));
        else controller.error(streamError);
      },
    });
    const reader = deferUntilStreamConsumed(source, onFlush, onError).getReader();

    expect(decoder.decode((await reader.read()).value)).toBe("partial");
    await expect(reader.read()).rejects.toThrow("boom");
    expect(onError).toHaveBeenCalledWith(streamError);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("calls onFlush once and cancels the byte source when the consumer cancels", async () => {
    const onFlush = vi.fn();
    const cancel = vi.fn();
    const source = new ReadableStream({
      type: "bytes",
      pull(controller) {
        controller.enqueue(encoder.encode("x"));
      },
      cancel,
    });
    const reader = deferUntilStreamConsumed(source, onFlush).getReader();

    await reader.read();
    await reader.cancel("bye");

    expect(cancel).toHaveBeenCalledWith("bye");
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("releases the source reader once the wrapper settles", async () => {
    const drained = byteStream([encoder.encode("a")]);
    await new Response(deferUntilStreamConsumed(drained, () => {})).arrayBuffer();
    expect(drained.locked).toBe(false);

    const cancelled = byteStream([encoder.encode("a")]);
    await deferUntilStreamConsumed(cancelled, () => {}).cancel();
    expect(cancelled.locked).toBe(false);

    const errored = new ReadableStream({
      type: "bytes",
      pull(controller) {
        controller.error(new Error("boom"));
      },
    });
    await expect(
      new Response(deferUntilStreamConsumed(errored, () => {})).arrayBuffer(),
    ).rejects.toThrow("boom");
    expect(errored.locked).toBe(false);

    // React-style sources close without settling the pending BYOB read.
    const react = await renderToReadableStream(createElement("p", null, "hi"));
    const html = await new Response(deferUntilStreamConsumed(react, () => {})).text();
    expect(html).toBe("<p>hi</p>");
    expect(react.locked).toBe(false);
  });

  it("runs callbacks in the async context that created the wrapper", async () => {
    // Callbacks read request-scoped state (such as collected fetch tags), but
    // the consumer that drains the body pulls from outside the request scope.
    const als = new AsyncLocalStorage<string>();
    const lazyByteSource = (end: (controller: ReadableByteStreamController) => void) => {
      let pulls = 0;
      return new ReadableStream({
        type: "bytes",
        pull(controller) {
          if (pulls++ < 3) controller.enqueue(encoder.encode("chunk"));
          else end(controller);
        },
      });
    };
    const lazyDefaultSource = () => {
      let pulls = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ < 3) controller.enqueue(encoder.encode("chunk"));
          else controller.close();
        },
      });
    };
    const wrap = (source: ReadableStream<Uint8Array>) => {
      const seen: Array<string | undefined> = [];
      const stream = als.run("request", () =>
        deferUntilStreamConsumed(
          source,
          () => seen.push(als.getStore()),
          () => seen.push(als.getStore()),
        ),
      );
      return { seen, stream };
    };

    const drained = wrap(lazyByteSource((controller) => controller.close()));
    expect(await new Response(drained.stream).text()).toBe("chunkchunkchunk");
    expect(drained.seen).toEqual(["request"]);

    const drainedDefault = wrap(lazyDefaultSource());
    expect(await new Response(drainedDefault.stream).text()).toBe("chunkchunkchunk");
    expect(drainedDefault.seen).toEqual(["request"]);

    const errored = wrap(lazyByteSource((controller) => controller.error(new Error("boom"))));
    await expect(new Response(errored.stream).text()).rejects.toThrow("boom");
    expect(errored.seen).toEqual(["request", "request"]);

    const cancelled = wrap(lazyByteSource((controller) => controller.close()));
    const reader = cancelled.stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled.seen).toEqual(["request"]);
  });

  it("preserves bytes across randomized byte sources", async () => {
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const sizes = [1, 7, 4096, 65535, 65536, 65537, 150000];
    const pool = new Uint8Array(300000);
    for (let i = 0; i < pool.length; i++) pool[i] = random(256);

    for (let iteration = 0; iteration < 150; iteration++) {
      const chunks = Array.from({ length: 1 + random(8) }, () => {
        const offset = random(pool.length - 150000);
        return pool.subarray(offset, offset + sizes[random(sizes.length)]);
      });
      // 0: enqueue everything in start; 1: sync pulls; 2: async pulls;
      // 3: enqueue the last chunk and close in the same pull.
      const style = random(4);
      let index = 0;
      const source = new ReadableStream({
        type: "bytes",
        autoAllocateChunkSize: random(2) ? 1024 : undefined,
        start(controller) {
          if (style !== 0) return;
          for (const chunk of chunks) controller.enqueue(chunk.slice());
          controller.close();
        },
        async pull(controller) {
          if (style === 0) return;
          if (style === 2) await new Promise((resolve) => setTimeout(resolve, random(3)));
          if (index < chunks.length) {
            controller.enqueue(chunks[index++].slice());
            if (style === 3 && index === chunks.length) controller.close();
          } else {
            controller.close();
          }
        },
      });
      const onFlush = vi.fn();

      const output = Buffer.from(
        await new Response(deferUntilStreamConsumed(source, onFlush)).arrayBuffer(),
      );

      expect(output.equals(concat(chunks)), `iteration ${iteration}, style ${style}`).toBe(true);
      expect(onFlush).toHaveBeenCalledTimes(1);
    }
  });

  it("passes a streamed React render through unchanged", async () => {
    function Deferred({ index }: { index: number }) {
      if (index % 25 === 0) {
        return createElement(
          "b",
          null,
          use(new Promise<number>((resolve) => setTimeout(() => resolve(index), 1))),
        );
      }
      return createElement("i", null, "x".repeat(index % 300));
    }
    const app = () =>
      createElement(
        "html",
        null,
        createElement(
          "body",
          null,
          Array.from({ length: 500 }, (_, index) =>
            createElement(
              Suspense,
              { key: index, fallback: createElement("span", null, "loading") },
              createElement(Deferred, { index }),
            ),
          ),
        ),
      );
    const onFlush = vi.fn();

    const direct = await new Response(await renderToReadableStream(app())).text();
    const wrapped = await new Response(
      deferUntilStreamConsumed(await renderToReadableStream(app()), onFlush),
    ).text();

    expect(wrapped).toBe(direct);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });
});
