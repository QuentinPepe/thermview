//! Checks the SDK bridge against temperatures produced by DJI's own tooling.
//!
//! Needs `--features dji-sdk` and a DJI sample; both are absent from a clean
//! checkout, so the test skips instead of failing when they are missing.
//! Point THERMVIEW_DJI_SAMPLE at an R-JPEG to run it.

#[cfg(feature = "dji-sdk")]
#[test]
fn measures_dji_rjpeg_against_reference() {
    let Ok(path) = std::env::var("THERMVIEW_DJI_SAMPLE") else {
        eprintln!("skipped: set THERMVIEW_DJI_SAMPLE to a DJI R-JPEG");
        return;
    };
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipped: cannot read {path}");
        return;
    };

    let out = thermview_lib::dji::dji_measure(bytes).expect("SDK measurement failed");

    assert_eq!(out.width * out.height, out.celsius.len() as u32);
    assert!(out.width > 0 && out.height > 0);

    let min = out.celsius.iter().copied().fold(f32::INFINITY, f32::min);
    let max = out.celsius.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let mean = out.celsius.iter().sum::<f32>() / out.celsius.len() as f32;
    println!(
        "{} -> {}x{} | min={min:.2} mean={mean:.2} max={max:.2} C | \
         dist={} hum={} emiss={} refl={}",
        path, out.width, out.height, out.distance, out.humidity, out.emissivity, out.reflection
    );

    // A wrong FFI struct layout or byte order shows up as absurd readings.
    assert!(min > -60.0 && max < 400.0, "implausible range {min}..{max}");

    // Optional exact check against a reference value.
    if let Ok(expected) = std::env::var("THERMVIEW_DJI_EXPECT_MAX") {
        let expected: f32 = expected.parse().expect("bad THERMVIEW_DJI_EXPECT_MAX");
        assert!(
            (max - expected).abs() < 0.05,
            "max {max:.2} C differs from reference {expected:.2} C"
        );
    }
}
