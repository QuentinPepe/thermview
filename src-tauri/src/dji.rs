//! DJI Thermal SDK bridge.
//!
//! Newer DJI cameras (M3T, M30T, M4T, H20T/H30T…) map their raw sensor values
//! through a per-image calibration curve that is not derivable from the file's
//! metadata, so the pure-JavaScript parser cannot read them accurately. When
//! built with `--features dji-sdk`, the desktop app calls DJI's own libdirp to
//! get exact temperatures.
//!
//! The SDK binaries are embedded in the executable and unpacked to a temp
//! directory on first use, keeping the single-file portable build intact.
//!
//! DJI Thermal SDK, Copyright (c) DJI. Used under the DJI Developer Policy;
//! not covered by this project's MIT license.

use serde::Serialize;

#[derive(Serialize)]
pub struct DjiThermal {
    pub width: u32,
    pub height: u32,
    /// Per-pixel temperature in Celsius, row-major.
    pub celsius: Vec<f32>,
    pub distance: f32,
    pub humidity: f32,
    pub emissivity: f32,
    pub reflection: f32,
}

/// True when this build embeds the SDK and the libraries actually loaded.
#[tauri::command]
pub fn dji_sdk_available() -> bool {
    #[cfg(feature = "dji-sdk")]
    { sdk::library().is_ok() }
    #[cfg(not(feature = "dji-sdk"))]
    { false }
}

/// Measure every pixel of a DJI radiometric JPEG, in Celsius.
#[tauri::command]
pub fn dji_measure(rjpeg: Vec<u8>) -> Result<DjiThermal, String> {
    #[cfg(feature = "dji-sdk")]
    { sdk::measure(rjpeg) }
    #[cfg(not(feature = "dji-sdk"))]
    {
        let _ = rjpeg;
        Err("This build has no DJI Thermal SDK support (rebuild with --features dji-sdk)".into())
    }
}

#[cfg(feature = "dji-sdk")]
mod sdk {
    use super::DjiThermal;
    use libloading::{Library, Symbol};
    use std::ffi::c_void;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    type Handle = *mut c_void;

    #[repr(C)]
    #[derive(Default)]
    struct Resolution {
        width: i32,
        height: i32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct MeasureParams {
        distance: f32,
        humidity: f32,
        emissivity: f32,
        reflection: f32,
    }

    /// Every DLL the SDK needs at runtime, embedded at compile time.
    /// libdirp dispatches to the libv_*irp backend matching the camera, so all
    /// of them ship even though one image only touches one.
    const BUNDLE: &[(&str, &[u8])] = &[
        ("libdirp.dll", include_bytes!("../vendor/dji/libdirp.dll")),
        ("libv_dirp.dll", include_bytes!("../vendor/dji/libv_dirp.dll")),
        ("libv_girp.dll", include_bytes!("../vendor/dji/libv_girp.dll")),
        ("libv_hirp.dll", include_bytes!("../vendor/dji/libv_hirp.dll")),
        ("libv_iirp.dll", include_bytes!("../vendor/dji/libv_iirp.dll")),
        ("libv_list.ini", include_bytes!("../vendor/dji/libv_list.ini")),
        ("libiconv-2.dll", include_bytes!("../vendor/dji/libiconv-2.dll")),
        ("libintl-8.dll", include_bytes!("../vendor/dji/libintl-8.dll")),
        ("libexif.dll", include_bytes!("../vendor/dji/libexif.dll")),
        ("MicroIA_Release_x64.dll", include_bytes!("../vendor/dji/MicroIA_Release_x64.dll")),
        ("MicroJPEG_Release_x64.dll", include_bytes!("../vendor/dji/MicroJPEG_Release_x64.dll")),
        ("MicroTA_Release_x64.dll", include_bytes!("../vendor/dji/MicroTA_Release_x64.dll")),
    ];

    static LIB: OnceLock<Result<Library, String>> = OnceLock::new();

    /// Unpack the SDK next to the user's temp dir, keyed by version so an
    /// upgraded app does not reuse stale DLLs.
    fn unpack() -> Result<PathBuf, String> {
        let dir = std::env::temp_dir().join(format!("thermview-dji-{}", env!("CARGO_PKG_VERSION")));
        fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        for (name, bytes) in BUNDLE {
            let path = dir.join(name);
            // Rewrite only when missing or the wrong size: a DLL already
            // mapped by this process cannot be overwritten, and does not need
            // to be, since the path is versioned.
            let up_to_date = fs::metadata(&path)
                .map(|m| m.len() == bytes.len() as u64)
                .unwrap_or(false);
            if !up_to_date {
                fs::write(&path, *bytes)
                    .map_err(|e| format!("cannot unpack {name}: {e}"))?;
            }
        }
        Ok(dir)
    }

    pub fn library() -> Result<&'static Library, String> {
        LIB.get_or_init(|| {
            let dir = unpack()?;
            // Let Windows resolve the sibling DLLs libdirp depends on.
            unsafe {
                let _ = std::env::var("PATH").map(|p| {
                    std::env::set_var("PATH", format!("{};{}", dir.display(), p));
                });
                Library::new(dir.join("libdirp.dll")).map_err(|e| format!("cannot load libdirp.dll: {e}"))
            }
        })
        .as_ref()
        .map_err(|e| e.clone())
    }

    pub fn measure(rjpeg: Vec<u8>) -> Result<DjiThermal, String> {
        let lib = library()?;
        unsafe {
            let create: Symbol<unsafe extern "C" fn(*const u8, i32, *mut Handle) -> i32> =
                lib.get(b"dirp_create_from_rjpeg\0").map_err(|e| e.to_string())?;
            let destroy: Symbol<unsafe extern "C" fn(Handle) -> i32> =
                lib.get(b"dirp_destroy\0").map_err(|e| e.to_string())?;
            let get_res: Symbol<unsafe extern "C" fn(Handle, *mut Resolution) -> i32> =
                lib.get(b"dirp_get_rjpeg_resolution\0").map_err(|e| e.to_string())?;
            let get_params: Symbol<unsafe extern "C" fn(Handle, *mut MeasureParams) -> i32> =
                lib.get(b"dirp_get_measurement_params\0").map_err(|e| e.to_string())?;
            let measure: Symbol<unsafe extern "C" fn(Handle, *mut f32, i32) -> i32> =
                lib.get(b"dirp_measure_ex\0").map_err(|e| e.to_string())?;

            let mut handle: Handle = std::ptr::null_mut();
            let ret = create(rjpeg.as_ptr(), rjpeg.len() as i32, &mut handle);
            if ret != 0 || handle.is_null() {
                return Err(format!("not a DJI radiometric JPEG (dirp code {ret})"));
            }

            // Any early return past this point must still release the handle.
            let result = (|| -> Result<DjiThermal, String> {
                let mut res = Resolution::default();
                if get_res(handle, &mut res) != 0 || res.width <= 0 || res.height <= 0 {
                    return Err("SDK returned no thermal resolution".into());
                }
                let mut params = MeasureParams::default();
                get_params(handle, &mut params);

                let count = (res.width as usize) * (res.height as usize);
                let mut celsius = vec![0f32; count];
                let bytes = (count * std::mem::size_of::<f32>()) as i32;
                let ret = measure(handle, celsius.as_mut_ptr(), bytes);
                if ret != 0 {
                    return Err(format!("SDK measurement failed (dirp code {ret})"));
                }
                Ok(DjiThermal {
                    width: res.width as u32,
                    height: res.height as u32,
                    celsius,
                    distance: params.distance,
                    humidity: params.humidity,
                    emissivity: params.emissivity,
                    reflection: params.reflection,
                })
            })();

            destroy(handle);
            result
        }
    }
}
