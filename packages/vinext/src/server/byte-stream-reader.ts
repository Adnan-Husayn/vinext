const BYTE_STREAM_READ_SIZE = 64 * 1024;

// Default readers on workerd's native byte streams (cached or fetched response
// bodies) yield 4 KiB chunks. Node yields fully-buffered bodies as one chunk,
// which BYOB reads would split and copy, so other runtimes keep default reads.
const PREFER_BYOB_READS =
  typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

type ByteStreamReader = Pick<
  ReadableStreamDefaultReader<Uint8Array>,
  "read" | "cancel" | "releaseLock"
>;
type ByteReadResult = ReadableStreamReadResult<Uint8Array<ArrayBuffer>>;

/**
 * Get a reader that reads byte streams in chunks of up to 64 KiB on workerd.
 *
 * Every JS stream layer downstream of a body pays a per-chunk cost. BYOB reads
 * resolve with whatever bytes are available, so streaming latency is
 * unchanged. A partial read is copied out and its buffer reused, keeping every
 * chunk exact-size. Other streams and runtimes use a default reader.
 *
 * A byte source that closes while a BYOB read is pending must also call
 * `byobRequest.respond(0)` to settle that read, which sources that only
 * enqueue (such as React's) never do. Such reads are settled as done once the
 * reader closes. The settlement waits a task because `closed` resolves before
 * a final read fulfilled by the same close, which must still deliver its bytes.
 */
export function getByteStreamReader(stream: ReadableStream<Uint8Array>): ByteStreamReader {
  if (!PREFER_BYOB_READS) return stream.getReader();

  let reader: ReadableStreamBYOBReader;
  try {
    reader = stream.getReader({ mode: "byob" });
  } catch {
    // Non-byte streams reject BYOB readers; locked streams throw here too.
    return stream.getReader();
  }

  let spare: ArrayBuffer | undefined;
  const pendingReads = new Set<(result: ByteReadResult) => void>();
  reader.closed.then(
    () => {
      if (pendingReads.size === 0) return;
      setTimeout(() => {
        for (const settle of pendingReads) settle({ done: true, value: undefined });
      }, 0);
    },
    // Errors reject the pending reads themselves.
    () => {},
  );

  return {
    read() {
      const view = new Uint8Array(spare ?? new ArrayBuffer(BYTE_STREAM_READ_SIZE));
      spare = undefined;
      return new Promise<ByteReadResult>((resolve, reject) => {
        const settle = (result: ByteReadResult) => {
          pendingReads.delete(settle);
          resolve(result);
        };
        pendingReads.add(settle);
        reader.read(view).then(settle, (error: unknown) => {
          pendingReads.delete(settle);
          reject(error);
        });
      }).then((result) => {
        // A BYOB read on a closed stream resolves with an empty view.
        if (result.done) return { done: true, value: undefined };
        const { value } = result;
        if (value.byteLength === value.buffer.byteLength) return result;
        spare = value.buffer;
        return { done: false, value: value.slice() };
      });
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
    releaseLock() {
      reader.releaseLock();
    },
  };
}
