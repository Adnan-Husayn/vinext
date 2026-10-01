import type { NavigationRuntimeVisibleCommitMode } from "../client/navigation-runtime.js";

/**
 * A settled prefetch carries already-decoded elements, so its commit is
 * upgraded to a synchronous (flushSync) render. Run inside the initiating
 * click or router.push() task, that render is charged to the interaction's
 * next paint (INP). Next.js avoids this by dispatching navigations inside
 * React.startTransition, so its click handler returns before rendering.
 *
 * Only ordinary navigations whose commit vinext upgrades yield. Traversals
 * restore scroll in the same commit and are not input-driven, and an
 * explicitly synchronous commit (gesture push) keeps its own timing.
 */
export function shouldYieldBeforePreparedPrefetchCommit(options: {
  hasPreparedElements: boolean;
  navigationKind: "navigate" | "traverse" | "refresh";
  visibleCommitMode: NavigationRuntimeVisibleCommitMode;
}): boolean {
  return (
    options.hasPreparedElements &&
    options.navigationKind === "navigate" &&
    options.visibleCommitMode === "transition"
  );
}

/**
 * Resolves once the browser has had the chance to present the frame for the
 * triggering input. requestAnimationFrame runs just before that frame's paint;
 * the posted message runs as a task after it. A message is used instead of
 * setTimeout so the yield also completes under fake or frozen timers.
 *
 * Hidden documents don't produce frames, so the yield is skipped up front and
 * abandoned if the document is hidden while waiting.
 */
export function waitForNextPaint(): Promise<void> {
  if (
    typeof requestAnimationFrame !== "function" ||
    typeof MessageChannel !== "function" ||
    document.visibilityState === "hidden"
  ) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = () => {
      document.removeEventListener("visibilitychange", finish);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve();
    };
    channel.port1.onmessage = finish;
    document.addEventListener("visibilitychange", finish);
    requestAnimationFrame(() => channel.port2.postMessage(null));
  });
}
