// Noise Cam overlay — Tauri shell.
// A transparent, frameless, always-on-top window that floats over CS2 and is
// toggled with a global hotkey. It is an EXTERNAL window only — nothing is
// injected into cs2.exe; the UI talks to the Node relay over WebSocket, exactly
// like the browser panel does.

mod relay;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(relay::RelayState::default())
        .invoke_handler(tauri::generate_handler![relay::hlae_send])
        .setup(|app| {
            // Global hotkey: Alt+Shift+D ("dolly") shows/hides the overlay.
            // Chosen to avoid clashing with common CS2 binds. Edit here.
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };

                let toggle = Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyD);
                let toggle_match = toggle.clone();

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if shortcut == &toggle_match
                                && event.state() == ShortcutState::Pressed
                            {
                                toggle_overlay(app);
                            }
                        })
                        .build(),
                )?;
                app.global_shortcut().register(toggle)?;
            }

            // Start the built-in relay/hub (HLAE socket + browser UI over the LAN).
            let relay_state = app.state::<relay::RelayState>().inner().clone();
            relay::start(app.handle().clone(), relay_state);

            // Dock the panel to the top-right corner on launch.
            if let Some(win) = app.get_webview_window("main") {
                let _ = dock_top_right(&win);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Show the overlay if hidden, hide it if visible, and focus it when shown.
fn toggle_overlay<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        match win.is_visible() {
            Ok(true) => {
                let _ = win.hide();
            }
            _ => {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    }
}

/// Park the window near the top-right corner of the primary monitor, with a margin.
fn dock_top_right<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>) -> tauri::Result<()> {
    if let Some(monitor) = win.primary_monitor()? {
        let screen = monitor.size(); // physical pixels
        let size = win.outer_size()?; // physical pixels
        let margin: i32 = 24;
        let x = (screen.width as i32 - size.width as i32 - margin).max(0);
        let y = margin;
        win.set_position(tauri::PhysicalPosition::new(x, y))?;
    }
    Ok(())
}
