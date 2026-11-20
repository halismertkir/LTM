import { startBrowserCapture } from "@ltm/capture/browser";
// Built by Vite as its own file (an AudioWorklet module must be loaded by URL); the service
// worker's shell list picks it up from the bundle like any other asset.
import workletUrl from "@ltm/capture/worklet?worker&url";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type CaptureEventLike,
  ListenController,
  type ListenDeps,
  type ListenState,
  localDeviceStorage,
} from "../lib/listen";
import { api } from "./client";
import { qk, useMeData } from "./queries";

declare const __LTM_VERSION__: string;

function realDeps(): ListenDeps {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  const wl =
    typeof navigator !== "undefined"
      ? (
          navigator as Navigator & {
            wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> };
          }
        ).wakeLock
      : undefined;
  return {
    origin: window.location.origin,
    workletUrl,
    userAgent: navigator.userAgent,
    appVersion: typeof __LTM_VERSION__ === "string" ? __LTM_VERSION__ : "dev",
    createPairingCode: () => api.createPairingCode({ access: "capture" }),
    pairDevice: (body) => api.pairDevice(body),
    getUserMedia: md?.getUserMedia ? (c) => md.getUserMedia(c) : null,
    startCapture: (o) =>
      startBrowserCapture({ ...o, onEvent: (e) => o.onEvent(e as CaptureEventLike) }),
    requestWakeLock: wl ? () => wl.request("screen") : null,
    storage: localDeviceStorage(),
  };
}

interface ListenCtx {
  controller: ListenController;
}
const Ctx = createContext<ListenCtx | null>(null);

/**
 * Owns "listen with this device" for the whole signed-in app, so capture keeps running while
 * the user moves between pages. Unmounting (sign-out) stops it.
 */
export function ListenProvider({ children, deps }: { children: ReactNode; deps?: ListenDeps }) {
  const [controller] = useState(() => new ListenController(deps ?? realDeps()));
  const me = useMeData();
  const qc = useQueryClient();
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  useEffect(() => () => void controller.stop(), [controller]);

  // The account-wide kill switch wins, from whichever device it was flipped.
  useEffect(() => {
    if (me.ingestPaused && controller.active) void controller.stop("paused");
  }, [me.ingestPaused, controller]);

  // The server refused for missing consent: refresh /me so the gate shows what is missing.
  useEffect(() => {
    if (state.error?.kind === "consent") void qc.invalidateQueries({ queryKey: qk.me });
  }, [state.error, qc]);

  // A freshly self-paired browser should appear in the device list right away.
  const deviceId = state.device?.id;
  useEffect(() => {
    if (deviceId) void qc.invalidateQueries({ queryKey: qk.devices });
  }, [deviceId, qc]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void controller.reacquireWakeLock();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [controller]);

  return <Ctx.Provider value={{ controller }}>{children}</Ctx.Provider>;
}

export function useListen(): { state: ListenState; controller: ListenController } {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useListen outside ListenProvider");
  const state = useSyncExternalStore(ctx.controller.subscribe, ctx.controller.getState);
  return { state, controller: ctx.controller };
}
