import {
  decryptActionBoundArgs,
  encryptActionBoundArgs,
} from "@vitejs/plugin-rsc/utils/encryption-runtime";
import { encodeReply, decodeReply } from "@vitejs/plugin-rsc/react/rsc";
import {
  isUseCacheFunction,
  replayCachedFunction,
  registerCachedFunction as registerCachedFunctionBase,
  type RegisterCachedFunctionOptions,
} from "./cache-runtime.js";
import {
  CacheFlightFormData,
  snapshotFlightReply,
  restoreFlightReply,
  type CacheFlightArguments,
} from "./cache-flight-arguments.js";
import type { VinextCacheFunctionInvocation } from "../server/multi-stage.js";

const CACHE_CAPTURE_TYPE = "use-cache-captures";
type CacheCaptureEnvelope = {
  type: typeof CACHE_CAPTURE_TYPE;
  encrypted: Promise<string>;
};

/** Captures and invocations use Flight's argument codec, never its result codec. */
export async function encodeCacheArguments(args: unknown[]): Promise<CacheFlightArguments> {
  return snapshotFlightReply(
    await encodeReply(args, {
      formDataConstructor: CacheFlightFormData,
    } as Parameters<typeof encodeReply>[1]),
  );
}

export async function decodeCacheArguments(value: CacheFlightArguments): Promise<unknown[]> {
  if (!value || value.version !== 1) throw new Error("Invalid cache function arguments");
  return (await decodeReply(restoreFlightReply(value))) as unknown[];
}

async function encryptArguments(value: CacheFlightArguments): Promise<string> {
  // The encryption helper uses the result codec internally. A string preserves
  // the argument payload exactly, including File metadata and multipart order.
  return encryptActionBoundArgs(JSON.stringify(value));
}

async function decryptArguments(
  encrypted: string | PromiseLike<string>,
): Promise<CacheFlightArguments> {
  const serialized = await decryptActionBoundArgs(Promise.resolve(encrypted));
  if (typeof serialized !== "string") throw new Error("Invalid cache function arguments");
  const value = JSON.parse(serialized) as CacheFlightArguments;
  if (value?.version !== 1) throw new Error("Invalid cache function arguments");
  return value;
}

export function encryptCacheCaptures(captures: unknown[]): CacheCaptureEnvelope {
  return {
    type: CACHE_CAPTURE_TYPE,
    encrypted: encodeCacheArguments(captures).then(encryptArguments),
  };
}

async function decryptCacheCaptures(value: unknown): Promise<unknown[] | undefined> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== CACHE_CAPTURE_TYPE ||
    !("encrypted" in value)
  )
    return;
  const encrypted = value.encrypted;
  if (
    typeof encrypted !== "string" &&
    !(
      typeof encrypted === "object" &&
      encrypted !== null &&
      "then" in encrypted &&
      typeof encrypted.then === "function"
    )
  )
    return;
  return decodeCacheArguments(await decryptArguments(encrypted as string | PromiseLike<string>));
}

export function registerCachedFunction<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  id: string,
  variant: string,
  options: RegisterCachedFunctionOptions,
): (...args: TArgs) => Promise<TResult> {
  return registerCachedFunctionBase(fn, id, variant, {
    ...options,
    decryptCaptures: decryptCacheCaptures,
    encodeInvocation: encryptArguments,
  });
}

/** Replay the persisted payload without re-reading or re-encoding caller objects. */
export async function invokeCacheFunction(
  invocation: VinextCacheFunctionInvocation,
  loadServerAction: (id: string) => Promise<unknown>,
): Promise<void> {
  const fn = await loadServerAction(invocation.referenceId);
  if (!isUseCacheFunction(fn)) {
    throw new Error(`Server reference ${invocation.referenceId} is not a cache function`);
  }
  await replayCachedFunction(fn, await decryptArguments(invocation.encryptedArgs));
}
