import { getByteStreamReader } from "./byte-stream-reader.js";

/**
 * Defers cleanup until the downstream consumer drains or cancels the stream.
 *
 * The wrapper reads the source directly rather than piping it through an
 * intermediate TransformStream, so each chunk crosses one JS stream layer.
 */
export function deferUntilStreamConsumed(
  stream: ReadableStream<Uint8Array>,
  onFlush: () => void,
  onError?: (error: unknown) => void,
): ReadableStream<Uint8Array> {
  let called = false;
  const once = () => {
    if (!called) {
      called = true;
      onFlush();
    }
  };

  const reader = getByteStreamReader(stream);
  // Unlock the source once the wrapper settles, as pipeThrough did.
  const release = () => {
    try {
      reader.releaseLock();
    } catch {
      // Runtimes that predate releasing with pending reads throw here.
    }
  };
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      return reader.read().then(
        ({ done, value }) => {
          if (done) {
            release();
            once();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        },
        (error) => {
          release();
          onError?.(error);
          once();
          controller.error(error);
        },
      );
    },
    cancel(reason) {
      once();
      return reader.cancel(reason).finally(release);
    },
  });
}
