// Built-in WebSocket relay.
//
// The in-game HLAE bridge (noisecam-bridge.js) is a WebSocket *client* that dials
// OUT to ws://localhost:31337/mirv. Historically a small Node server hosted that
// endpoint and relayed messages to the browser UI. Here the Tauri app hosts it
// itself, so launching the overlay launches the relay — one process, no Node, no
// orphans. Messages flow:
//
//   HLAE  --(JSON text)-->  this relay  --(Tauri event "hlae:msg")-->  webview
//   webview  --(invoke "hlae_send")-->  this relay  --(WS)-->  HLAE
//
// Still an external window only — nothing is injected into cs2.exe.

use std::sync::Arc;

use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

pub const RELAY_ADDR: &str = "127.0.0.1:31337";

type HlaeSink = SplitSink<WebSocketStream<TcpStream>, Message>;

/// Shared handle to the currently-connected HLAE bridge's outgoing sink.
#[derive(Clone, Default)]
pub struct HlaeState {
    sink: Arc<Mutex<Option<HlaeSink>>>,
}

/// Spawn the relay listener. One CS2/HLAE client at a time; it loops so the
/// bridge can disconnect and reconnect (e.g. reloading the script).
pub fn start<R: Runtime>(app: AppHandle<R>, state: HlaeState) {
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(RELAY_ADDR).await {
            Ok(l) => l,
            Err(e) => {
                let _ = app.emit("relay:error", format!("cannot bind {RELAY_ADDR}: {e}"));
                return;
            }
        };
        let _ = app.emit("relay:listening", RELAY_ADDR);

        loop {
            match listener.accept().await {
                Ok((stream, _)) => handle_conn(&app, &state, stream).await,
                Err(_) => continue,
            }
        }
    });
}

async fn handle_conn<R: Runtime>(app: &AppHandle<R>, state: &HlaeState, stream: TcpStream) {
    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(_) => return,
    };
    let (write, mut read) = ws.split();
    *state.sink.lock().await = Some(write);
    let _ = app.emit("hlae:status", true);

    // Pull the current keyframe list immediately (as the Node relay did).
    if let Some(sink) = state.sink.lock().await.as_mut() {
        let _ = sink.send(Message::Text("{\"type\":\"list\"}".to_string())).await;
    }

    while let Some(msg) = read.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                let _ = app.emit("hlae:msg", text);
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }

    *state.sink.lock().await = None;
    let _ = app.emit("hlae:status", false);
}

/// Frontend -> HLAE. The webview sends JSON command strings (exec/capture/etc.).
#[tauri::command]
pub async fn hlae_send(state: tauri::State<'_, HlaeState>, msg: String) -> Result<(), String> {
    let mut guard = state.sink.lock().await;
    match guard.as_mut() {
        Some(sink) => sink
            .send(Message::Text(msg))
            .await
            .map_err(|e| e.to_string()),
        None => Err("CS2 / HLAE not connected".to_string()),
    }
}
