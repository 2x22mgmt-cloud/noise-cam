// Built-in relay / hub.
//
// One axum server on :31337 (all interfaces, so phones on the LAN can reach it):
//   GET /mirv  — the in-game HLAE bridge dials in here (WebSocket)
//   GET /ui    — browser / phone control clients connect here (WebSocket)
//   GET /*     — serves the embedded control UI (the React build)
//
// Flow: HLAE messages fan out to BOTH the desktop overlay (Tauri event) and every
// browser client (broadcast channel). Commands from any client — the overlay via
// the `hlae_send` command, or a browser over /ui — are forwarded to HLAE.
//
// Single monitor? Open http://<this-pc-ip>:31337 on your phone and drive the
// controls there while you fly the cam on the PC; CS2 never loses focus. Still an
// external tool only — nothing injected into cs2.exe.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use include_dir::{include_dir, Dir};
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, Mutex};

pub const BIND_ADDR: &str = "0.0.0.0:31337";

// The React build, embedded into the binary so the hub can serve it to phones in
// both dev and packaged builds. (Run `npm run build` before compiling.)
static UI_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/../dist");

type HlaeSink = SplitSink<WebSocket, Message>;

/// Shared relay state: the HLAE outgoing sink, a broadcast bus to all browser
/// clients, and whether HLAE is currently connected. Managed by Tauri and shared
/// into the axum server.
#[derive(Clone)]
pub struct RelayState {
    hlae: Arc<Mutex<Option<HlaeSink>>>,
    tx: broadcast::Sender<String>,
    connected: Arc<AtomicBool>,
}

impl Default for RelayState {
    fn default() -> Self {
        let (tx, _) = broadcast::channel(512);
        Self {
            hlae: Arc::new(Mutex::new(None)),
            tx,
            connected: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Clone)]
struct AppState {
    app: AppHandle,
    relay: RelayState,
}

/// Spawn the hub. `app` is the (Wry) app handle; `relay` is the managed state.
pub fn start(app: AppHandle, relay: RelayState) {
    tauri::async_runtime::spawn(async move {
        let state = AppState {
            app: app.clone(),
            relay,
        };
        let router = Router::new()
            .route("/mirv", get(mirv_ws))
            .route("/ui", get(ui_ws))
            .route("/demos", get(demos_handler))
            .fallback(static_handler)
            .with_state(state);

        let listener = match TcpListener::bind(BIND_ADDR).await {
            Ok(l) => l,
            Err(e) => {
                let _ = app.emit("relay:error", format!("cannot bind {BIND_ADDR}: {e}"));
                return;
            }
        };
        let _ = app.emit("relay:listening", BIND_ADDR);
        let _ = axum::serve(listener, router).await;
    });
}

/* --------------------------------------------------------------- HLAE side */
async fn mirv_ws(State(s): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle_hlae(socket, s))
}

async fn handle_hlae(socket: WebSocket, s: AppState) {
    let (sink, mut stream) = socket.split();
    *s.relay.hlae.lock().await = Some(sink);
    s.relay.connected.store(true, Ordering::SeqCst);
    let _ = s.app.emit("hlae:status", true);
    let _ = s.relay.tx.send(r#"{"type":"status","hlae":true}"#.to_string());

    // Pull the current keyframe list immediately.
    if let Some(sink) = s.relay.hlae.lock().await.as_mut() {
        let _ = sink.send(Message::Text(r#"{"type":"list"}"#.to_string())).await;
    }

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => {
                // Debug breadcrumb: print non-cam messages so the bridge's last
                // words survive a CS2 crash (visible in the dev console).
                if !t.contains("\"cam\"") {
                    println!("[hlae] {t}");
                }
                let _ = s.app.emit("hlae:msg", &t); // → desktop overlay
                let _ = s.relay.tx.send(t); // → browser clients
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    *s.relay.hlae.lock().await = None;
    s.relay.connected.store(false, Ordering::SeqCst);
    let _ = s.app.emit("hlae:status", false);
    let _ = s.relay.tx.send(r#"{"type":"status","hlae":false}"#.to_string());
}

/* ------------------------------------------------------------ browser side */
async fn ui_ws(State(s): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle_browser(socket, s))
}

async fn handle_browser(socket: WebSocket, s: AppState) {
    let (mut sink, mut stream) = socket.split();
    let mut rx = s.relay.tx.subscribe();

    // Tell the new client the current connection state, and pull keyframes.
    let connected = s.relay.connected.load(Ordering::SeqCst);
    let status = format!(r#"{{"type":"status","hlae":{}}}"#, connected);
    let _ = sink.send(Message::Text(status)).await;
    if let Some(h) = s.relay.hlae.lock().await.as_mut() {
        let _ = h.send(Message::Text(r#"{"type":"list"}"#.to_string())).await;
    }

    // broadcast (HLAE + status) -> this browser
    let send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    if sink.send(Message::Text(msg)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });

    // browser commands -> HLAE
    while let Some(Ok(msg)) = stream.next().await {
        if let Message::Text(t) = msg {
            if let Some(h) = s.relay.hlae.lock().await.as_mut() {
                let _ = h.send(Message::Text(t)).await;
            }
        }
    }
    send_task.abort();
}

/* ------------------------------------------------------------ demo list */
/// GET /demos — the CS2 demo list, for phone/browser clients (the desktop
/// overlay uses the `list_demos` Tauri command instead).
async fn demos_handler() -> Json<Vec<crate::demos::DemoInfo>> {
    Json(crate::demos::list())
}

/* ------------------------------------------------------------- static UI */
async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    if let Some(file) = UI_DIR.get_file(path) {
        return ([(header::CONTENT_TYPE, mime_for(path))], file.contents()).into_response();
    }
    // SPA fallback
    match UI_DIR.get_file("index.html") {
        Some(f) => ([(header::CONTENT_TYPE, "text/html")], f.contents()).into_response(),
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        _ => "application/octet-stream",
    }
}

/* --------------------------------------------------- webview -> HLAE command */
/// The desktop overlay (Tauri webview) sends JSON command strings here.
#[tauri::command]
pub async fn hlae_send(state: tauri::State<'_, RelayState>, msg: String) -> Result<(), String> {
    let mut guard = state.hlae.lock().await;
    match guard.as_mut() {
        Some(sink) => sink
            .send(Message::Text(msg))
            .await
            .map_err(|e| e.to_string()),
        None => Err("CS2 / HLAE not connected".to_string()),
    }
}
