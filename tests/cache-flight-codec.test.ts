import { describe, expect, it } from "vite-plus/test";
import { loadCacheFlightCodec } from "./helpers/cache-flight-codec.js";
import { patchCacheFlightCodec } from "../packages/vinext/src/plugins/cache-flight-codec.js";
import {
  CacheFlightFormData,
  snapshotFlightReply,
  restoreFlightReply,
} from "../packages/vinext/src/shims/cache-flight-arguments.js";

describe("Flight cache multipart factory", () => {
  it.each(["production", "development"] as const)(
    "is scoped to one encode call (%s)",
    async (mode) => {
      const codec = loadCacheFlightCodec(mode);
      const nativeFormData = globalThis.FormData;
      const file = new File(["x"], "blob", { type: "text/plain", lastModified: 111 });
      const form = new FormData();
      form.append("file", file);
      const [cacheReply, ordinaryReply] = (await Promise.all([
        codec.encodeReply([new Blob(["x"]), file, form], {
          formDataConstructor: CacheFlightFormData,
        }),
        codec.encodeReply([new Blob(["x"]), file, form]),
      ])) as [FormData, FormData];
      expect(globalThis.FormData).toBe(nativeFormData);
      expect(Object.getPrototypeOf(ordinaryReply)).toBe(FormData.prototype);
      expect(Object.getPrototypeOf(cacheReply)).toBe(CacheFlightFormData.prototype);
      expect((cacheReply.get("1") as File).lastModified).toBe(0);
      expect((ordinaryReply.get("1") as File).lastModified).toBeGreaterThan(0);
      const decoded = await codec.decodeReply(
        restoreFlightReply(await snapshotFlightReply(cacheReply)),
      );
      expect(decoded[1].lastModified).toBe(111);
      expect(decoded[2].get("file").lastModified).toBe(111);
    },
  );

  it("fails explicitly when an encoder upgrade changes the integration seam", () => {
    expect(() => patchCacheFlightCodec("exports.encodeReply = somethingElse;", "codec.js")).toThrow(
      "unsupported Flight cache encoder",
    );
  });
});
