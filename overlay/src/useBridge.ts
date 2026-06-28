import { useCallback, useEffect, useRef, useState } from "react";

// The overlay is a Tauri webview, so it is NOT served from the relay's origin —
// we always dial the Node relay explicitly. (The browser panel used location.host;
// here we hardcode the relay port.)
const RELAY_URL = "ws://localhost:31337/ui";
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
  const [status, setStatus] = useState<Status>({ hlae: false, text: "connecting…" });
  const [cam, setCam] = useState<Cam | null>(null);
  const [keyframes, setKeyframes] = useState<Keyframes>({ count: 0, enabled: false, items: [] });
  const [log, setLog] = useState<LogLine[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // throttle cam UI updates to ~12fps so React isn't slammed by the 60+/s stream
  const lastCamPaint = useRef(0);

  const pushLog = useCallback((msg: string) => {
    const t = new Date().toLocaleTimeString();
    setLog((prev) => [{ t, msg }, ...prev].slice(0, 80));
  }, []);

  const send = useCallback(
    (obj: Record<string, unknown>) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
        if (obj.type && obj.type !== "exec") {
          const on = obj.on === true ? " on" : obj.on === false ? " off" : "";
          const idx = obj.index !== undefined ? ` #${obj.index}` : "";
          pushLog(`» ${obj.type}${on}${idx}`);
        }
      } else {
        pushLog("not connected");
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
    let closed = false;

    const connect = () => {
      const ws = new WebSocket(RELAY_URL);
      wsRef.current = ws;

      ws.onopen = () => setStatus({ hlae: false, text: "server connected — waiting for CS2" });
      ws.onclose = () => {
        if (closed) return;
        setStatus({ hlae: false, text: "server offline — retrying" });
        retryRef.current = setTimeout(connect, 1000);
      };
      ws.onerror = () => {};
      ws.onmessage = (ev) => {
        let m: any;
        try {
          m = JSON.parse(ev.data);
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
        } else if (m.type === "status") {
          setStatus({ hlae: !!m.hlae, text: m.hlae ? "CS2 connected" : "waiting for CS2" });
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, []);

  return { status, cam, keyframes, log, send, exec };
}
