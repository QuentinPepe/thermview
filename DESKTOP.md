# ThermView Desktop (Windows)

A portable build of the viewer: one `thermview.exe`, no installer, no runtime to
install, nothing written outside the folder you put it in. Double-click and it
opens. The whole app — every thermal parser — runs locally; no file ever leaves
the machine and no network connection is needed.

## Building it

```bash
npm install
npm run desktop
```

Requires the Rust toolchain (<https://rustup.rs>) in addition to Node.

The executable lands at:

```
src-tauri/target/release/thermview.exe
```

Copy that single file anywhere (USB stick, network share, Desktop) and run it.
Rename it to whatever you like — nothing depends on the file name. The first
Rust build takes a couple of minutes; later builds are much faster.

To develop against the desktop shell with hot reload:

```bash
npm run desktop:dev
```

## What the recipient needs

Only the **WebView2 runtime**, which supplies the rendering engine:

| Windows version | WebView2 |
|---|---|
| Windows 11 | always present |
| Windows 10, kept updated | present (ships with Edge) |
| Windows 10 never updated | may be missing |

In the rare missing case, the app shows an error on launch. The fix is
Microsoft's free "Evergreen Standalone Installer" from
<https://developer.microsoft.com/microsoft-edge/webview2/>.

If you need a build with *zero* dependency, Electron bundles its own engine
instead, at the cost of a ~185 MB executable rather than ~12 MB.

## Self-update

The app checks this project's GitHub releases on launch. When a newer tag is
published it shows a banner; one click downloads the new executable, replaces
itself and restarts. Someone using the app is only ever sent one file — every
later version arrives on its own.

Publishing a new version is just the existing tag flow:

```bash
git tag v0.3.0 && git push origin v0.3.0
```

Tauri's own updater is not used here: it installs an NSIS/MSI package, which
would give up the portable single-file build. Instead `src-tauri/src/updater.rs`
swaps the executable directly, which Windows permits because a running exe can
be renamed even though it cannot be overwritten. The live copy is moved to
`<name>.exe.old`, the download takes its place, and the leftover is deleted on
the next launch — so a failed install still leaves a working app on disk.

Guards, since this downloads and then runs code:

- only `https://` URLs on GitHub's own hosts are fetched, checked by exact host
  match so a lookalike domain cannot pass
- the download must match the size the release feed declared and start with a
  `MZ` header, or it is discarded
- the release tag must parse as a higher version number; anything unparseable
  is treated as "no update"
- a failed network call is swallowed, never blocking the app from starting

`cargo test` covers the version comparison, the host allow-list and the file
swap. The check against the real feed is opt-in:

```bash
cd src-tauri
THERMVIEW_LIVE_UPDATE_TEST=1 cargo test --test updater_live -- --nocapture
```

The repository it looks at is the `REPO` constant in `updater.rs`.

## DJI camera support (optional)

Newer DJI cameras — M3T, M30T, M4T, H20T/H20N/H30T — map their raw sensor
values through a per-image calibration curve that is not derivable from the
file. The browser build rejects those files rather than show wrong readings.
The desktop build can measure them exactly by calling DJI's own library.

**The SDK binaries are deliberately not in this repository.** DJI's developer
policy allows shipping their object code *inside* an application, but forbids
integrating it "such that any part becomes subject to an open source license" —
and this project is MIT. Supply them yourself:

1. Download the DJI Thermal SDK from
   <https://www.dji.com/downloads/softwares/dji-thermal-sdk>
2. Copy the contents of `tsdk-core/lib/windows/release_x64/` into
   `src-tauri/vendor/dji/` (that path is git-ignored)
3. Build with the feature enabled:

```bash
npx tauri build --features dji-sdk
```

The DLLs are embedded in the executable and unpacked to a temp folder on first
use, so the result is still one portable file — about 10 MB instead of 3.6 MB.
Without the feature the app builds and runs normally; DJI files from those
cameras simply stay unsupported.

Measured against DJI's reference output on Matrice 4T captures, the SDK path
reproduces min/mean/max exactly, including low-gain images that the built-in
formula read as −210 °C. To re-check after changing the bridge:

```bash
cd src-tauri
THERMVIEW_DJI_SAMPLE=/path/to/DJI_0001_R.JPG cargo test --features dji-sdk
```

If you distribute a build with this feature, keep DJI's copyright notice and
review their developer policy — the bundled SDK is not covered by this
project's MIT license.

## Notes on the desktop build

- `dragDropEnabled` is set to `false` in `src-tauri/tauri.conf.json`. Tauri
  otherwise swallows OS drag-and-drop before the page sees it, which would break
  the drop zone. Do not re-enable it.
- `bundle.active` is `false`: the build deliberately produces only the portable
  executable, not MSI/NSIS installers. Set it to `true` and run
  `npx tauri build` if you ever want a real installer.
- The release profile trades compile time for binary size (`opt-level = "s"`,
  LTO, stripped symbols).
