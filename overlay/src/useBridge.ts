import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// The SAME UI runs in two places:
//   • Desktop overlay (Tauri webview) — talks to the in-app relay via Tauri IPC.
//   • Phone / tablet in a browser     — talks to the relay over a WebSocket (/ui).
// `isTauri` picks the transport. Either way the Bridge interface is identical.
export const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
  focus?: number | null;
  ang?: { pitch?: number; yaw?: number; roll?: number } | null;
  tick?: number;
  time?: number;
};
export type Keyframes = { count: number; enabled: boolean; items: Keyframe[] };

export type Status = { hlae: boolean; text: string };
export type LogLine = { t: string; msg: string };
export type DemoInfo = {
  file: string;
  arg: string;
  map: string;
  size_mb: number;
  modified: number;
};
export type PlayerInfo = { idx: number; name: string; team: number; alive: boolean };

export type Bridge = {
  status: Status;
  cam: Cam | null;
  keyframes: Keyframes;
  players: PlayerInfo[];
  log: LogLine[];
  send: (obj: Record<string, unknown>) => void;
  exec: (cmd: string) => void;
  listDemos: () => Promise<DemoInfo[]>;
  installBridge: () => Promise<string>;
  bridgeInstalled: () => Promise<boolean>;
};

export function useBridge(): Bridge {
  const [status, setStatus] = useState<Status>({ hlae: false, text: "connecting…" });
  const [cam, setCam] = useState<Cam | null>(null);
  const [keyframes, setKeyframes] = useState<Keyframes>({ count: 0, enabled: false, items: [] });
  const [players, setPlayers] = useState<PlayerInfo[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const lastCamPaint = useRef(0); // throttle the 60+/s cam stream to ~12fps

  const pushLog = useCallback((msg: string) => {
    const t = new Date().toLocaleTimeString();
    setLog((prev) => [{ t, msg }, ...prev].slice(0, 80));
  }, []);

  const send = useCallback(
    (obj: Record<string, unknown>) => {
      const payload = JSON.stringify(obj);
      if (isTauri()) {
        invoke("hlae_send", { msg: payload }).catch((err) => pushLog(String(err)));
      } else {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
        else pushLog("not connected");
      }
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

  // Demo list: desktop reads the disk via the Tauri command; phone/browser
  // fetches the relay's /demos endpoint (same data, served by the hub).
  const listDemos = useCallback(async (): Promise<DemoInfo[]> => {
    try {
      if (isTauri()) return await invoke<DemoInfo[]>("list_demos");
      const res = await fetch("/demos");
      return (await res.json()) as DemoInfo[];
    } catch (err) {
      pushLog("demo scan failed: " + String(err));
      return [];
    }
  }, [pushLog]);

  // Shared message handling (HLAE cam/keyframes, plus status over the browser WS).
  const handleMsg = useCallback((raw: string) => {
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
    } else if (m.type === "players") {
      setPlayers(Array.isArray(m.items) ? m.items : []);
    } else if (m.type === "status") {
      setStatus({ hlae: !!m.hlae, text: m.hlae ? "CS2 connected" : "waiting for CS2" });
    }
  }, []);

  // --- Tauri transport: listen to relay events + send via command ---
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const unlistens: UnlistenFn[] = [];
    setStatus({ hlae: false, text: "starting relay…" });
    (async () => {
      const subs = await Promise.all([
        listen<string>("hlae:msg", (e) => handleMsg(e.payload)),
        listen<boolean>("hlae:status", (e) =>
          setStatus({ hlae: e.payload, text: e.payload ? "CS2 connected" : "waiting for CS2" }),
        ),
        listen<string>("relay:listening", () => setStatus({ hlae: false, text: "waiting for CS2" })),
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
  }, [handleMsg]);

  // --- Browser transport: WebSocket to the relay's /ui endpoint ---
  useEffect(() => {
    if (isTauri()) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const ws = new WebSocket(`ws://${location.host}/ui`);
      wsRef.current = ws;
      ws.onopen = () => setStatus({ hlae: false, text: "server connected — waiting for CS2" });
      ws.onclose = () => {
        if (closed) return;
        setStatus({ hlae: false, text: "server offline — retrying" });
        retry = setTimeout(connect, 1000);
      };
      ws.onerror = () => {};
      ws.onmessage = (ev) => handleMsg(String(ev.data));
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [handleMsg]);

  // One-click setup: ask the desktop app to drop the bridge + cfg into CS2.
  const installBridge = useCallback(async (): Promise<string> => {
    if (!isTauri()) throw new Error("Run the install from the desktop app.");
    return await invoke<string>("install_bridge");
  }, []);
  const bridgeInstalled = useCallback(async (): Promise<boolean> => {
    if (!isTauri()) return false;
    try {
      return await invoke<boolean>("bridge_installed");
    } catch {
      return false;
    }
  }, []);

  return {
    status, cam, keyframes, players, log, send, exec, listDemos, installBridge, bridgeInstalled,
  };
}
