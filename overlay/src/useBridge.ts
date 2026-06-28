import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// The relay now lives inside the Tauri app (Rust). The webview talks to it over
// Tauri IPC: it listens for "hlae:*" / "relay:*" events and sends commands via
// the `hlae_send` command. (No browser WebSocket anymore.)
export const TICKRATE = 64; // CS2 demos

export type View = {
  x?: number; y?: number; z?: number;
  rX?: number; rY?: number; rZ?: number;
  fov?: number;
};
export type Cam = {
  demoTick?: number;
  demoTime?: number;
  curTime?: number;
  paused?: boolean;
  view?: View;
  width?: number;
  height?: number;
};
export type Keyframe = {
  pos?: { x: number; y: number; z: number };
  fov?: number;
  ang?: { pitch?: number; yaw?: number; roll?: number } | null;
  tick?: number;
  time?: number;
};
export type Keyframes = { count: number; enabled: boolean; items: Keyframe[] };

export type Status = { hlae: boolean; text: string };
export type LogLine = { t: string; msg: string };

export type Bridge = {
  status: Status;
  cam: Cam | null;
  keyframes: Keyframes;
  log: LogLine[];
  send: (obj: Record<string, unknown>) => void;
  exec: (cmd: string) => void;
};

export function useBridge(): Bridge {
  const [status, setStatus] = useState<Status>({ hlae: false, text: "starting relay…" });
  const [cam, setCam] = useState<Cam | null>(null);
  const [keyframes, setKeyframes] = useState<Keyframes>({ count: 0, enabled: false, items: [] });
  const [log, setLog] = useState<LogLine[]>([]);

  // throttle cam UI updates to ~12fps so React isn't slammed by the 60+/s stream
  const lastCamPaint = useRef(0);

  const pushLog = useCallback((msg: string) => {
    const t = new Date().toLocaleTimeString();
    setLog((prev) => [{ t, msg }, ...prev].slice(0, 80));
  }, []);

  const send = useCallback(
    (obj: Record<string, unknown>) => {
      invoke("hlae_send", { msg: JSON.stringify(obj) }).catch((err) => pushLog(String(err)));
      if (obj.type && obj.type !== "exec") {
        const on = obj.on === true ? " on" : obj.on === false ? " off" : "";
        const idx = obj.index !== undefined ? ` #${obj.index}` : "";
        pushLog(`» ${obj.type}${on}${idx}`);
      }
    },
    [pushLog],
  );

  const exec = useCallback(
    (cmd: string) => {
      send({ type: "exec", cmd });
      pushLog("» " + cmd);
    },
    [send, pushLog],
  );

  useEffect(() => {
    let active = true;
    const unlistens: UnlistenFn[] = [];

    const handleMsg = (raw: string) => {
      let m: any;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.type === "cam") {
        const now = performance.now();
        if (now - lastCamPaint.current < 80) return;
        lastCamPaint.current = now;
        setCam(m);
      } else if (m.type === "keyframes") {
        setKeyframes({ count: m.count ?? 0, enabled: !!m.enabled, items: m.items || [] });
      }
    };

    (async () => {
      const subs = await Promise.all([
        listen<string>("hlae:msg", (e) => handleMsg(e.payload)),
        listen<boolean>("hlae:status", (e) =>
          setStatus({ hlae: e.payload, text: e.payload ? "CS2 connected" : "waiting for CS2" }),
        ),
        listen<string>("relay:listening", () =>
          setStatus({ hlae: false, text: "waiting for CS2" }),
        ),
        listen<string>("relay:error", (e) => setStatus({ hlae: false, text: e.payload })),
      ]);
      if (!active) {
        subs.forEach((u) => u());
        return;
      }
      unlistens.push(...subs);
    })();

    return () => {
      active = false;
      unlistens.forEach((u) => u());
    };
  }, []);

  return { status, cam, keyframes, log, send, exec };
}
