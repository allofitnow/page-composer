// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// NOTE: tauri.conf.json sets `dragDropEnabled: false` on the main window and it
// must stay that way. On Windows, leaving it on registers an OS-level drop
// target over the webview which swallows drag operations before the page sees
// them, so HTML5 drag and drop in the Page Order rail silently does nothing --
// it works in a browser and fails only in the packaged app, which is a
// miserable thing to debug. Nothing here uses OS file-drop: copy docs are read
// out of the project folder, not dropped onto the window.
fn main() {
    page_composer_lib::run()
}
