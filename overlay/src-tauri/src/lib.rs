// Noise Cam overlay — Tauri shell.
// A transparent, frameless, always-on-top window that floats over CS2 and is
// toggled with a global hotkey. It is an EXTERNAL window only — nothing is
// injected into cs2.exe; the UI talks to the in-app relay (relay.rs) over a
// WebSocket, exactly like the browser/phone panel does.

mod demos;
mod relay;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(relay::RelayState::default())
        .invoke_handler(tauri::generate_handler![
            relay::hlae_send,
            list_demos,
            bridge_installed,
            install_bridge
        ])
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
            // The phone UI is the dist embedded at build time, so rebuild to refresh it.
            let relay_state = app.state::<relay::RelayState>().inner().clone();
            relay::start(app.handle().clone(), relay_state);

            // Dock the panel to the top-right corner on launch.
            if let Some(win) = app.get_webview_window("main") {
                let _ = dock_top_right(&win);
            }

            // System-tray icon — the reliable way to find the overlay (it's a
            // frameless, always-on-top panel with no taskbar button). Left-click
            // toggles show/hide; right-click opens a Show-Hide / Quit menu.
            #[cfg(desktop)]
            {
                let show = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
                let sep = PredefinedMenuItem::separator(app)?;
                let quit = MenuItem::with_id(app, "quit", "Quit Noise Cam", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &sep, &quit])?;

                TrayIconBuilder::with_id("main")
                    .tooltip("Noise Cam — click to show/hide (Alt+Shift+D)")
                    .icon(app.default_window_icon().unwrap().clone())
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => toggle_overlay(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            toggle_overlay(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// List the CS2 demos found across Steam libraries (for the Demos tab).
#[tauri::command]
fn list_demos() -> Vec<demos::DemoInfo> {
    demos::list()
}

/// Whether the bridge + cfg are already in CS2's cfg folder (so we don't nag the
/// user to install when they've done it before).
#[tauri::command]
fn bridge_installed() -> bool {
    demos::csgo_dirs().into_iter().any(|csgo| {
        csgo.join("cfg/noisecam.cfg").is_file() && csgo.join("cfg/noisecam-bridge.js").is_file()
    })
}

/// One-click setup: write the in-game bridge + a loader cfg (with binds) straight
/// into CS2's `cfg` folder, so the user never has to find it. Returns the folder.
#[tauri::command]
fn install_bridge() -> Result<String, String> {
    // The bridge source is embedded at build time, so the app is self-contained
    // and always installs the matching version.
    const BRIDGE_JS: &str = include_str!("../../../bridge/noisecam-bridge.js");

    let csgo = demos::csgo_dirs()
        .into_iter()
        .next()
        .ok_or("Couldn't find your CS2 install — is CS2 installed through Steam?")?;
    let cfg_dir = csgo.join("cfg");
    std::fs::create_dir_all(&cfg_dir).map_err(|e| format!("couldn't open the cfg folder: {e}"))?;

    let bridge_path = cfg_dir.join("noisecam-bridge.js");
    std::fs::write(&bridge_path, BRIDGE_JS).map_err(|e| format!("couldn't write the bridge: {e}"))?;

    let cfg = format!(
        "// noisecam.cfg — auto-installed by Noise Cam. Run:  exec noisecam\n\
         mirv_script_load \"{path}\"\n\
         bind \"F8\"          \"exec noisecam\"\n\
         bind \"F9\"          \"mirv_dolly preview\"\n\
         bind \"F7\"          \"demo_togglepause\"\n\
         bind \"KP_PLUS\"     \"mirv_dolly capture\"\n\
         bind \"KP_MINUS\"    \"mirv_dolly clear\"\n\
         bind \"KP_ENTER\"    \"mirv_dolly enable\"\n\
         bind \"KP_DEL\"      \"mirv_dolly disable\"\n\
         bind \"KP_MULTIPLY\" \"mirv_dolly draw\"\n\
         bind \"KP_DIVIDE\"   \"mirv_dolly drawoff\"\n\
         echo \"Noise Cam bridge loaded — open the overlay; the dot turns amber.\"\n",
        path = bridge_path.display()
    );
    std::fs::write(cfg_dir.join("noisecam.cfg"), cfg)
        .map_err(|e| format!("couldn't write the cfg: {e}"))?;

    Ok(cfg_dir.display().to_string())
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
