"use client";

import { useParams } from "next/navigation";

type RecorderWindow = Window & { __PARAMS_HISTORY_RENDERS__?: string[] };

// Records the params every render observes, so a test can catch a render
// that briefly sees another route's params.
export function ParamsRecorder() {
  const params = useParams<{ id?: string }>();
  if (typeof window !== "undefined") {
    const recorderWindow = window as RecorderWindow;
    (recorderWindow.__PARAMS_HISTORY_RENDERS__ ??= []).push(params?.id ?? "(missing)");
  }
  return <p id="params-history-id">{params?.id ?? "(missing)"}</p>;
}
