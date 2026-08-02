pub mod dji;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // Lets the "GitHub" header link open in the user's real browser instead of
    // dead-ending inside the app window.
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![
      dji::dji_measure,
      dji::dji_sdk_available,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
