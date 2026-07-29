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

## Notes on the desktop build

- `dragDropEnabled` is set to `false` in `src-tauri/tauri.conf.json`. Tauri
  otherwise swallows OS drag-and-drop before the page sees it, which would break
  the drop zone. Do not re-enable it.
- `bundle.active` is `false`: the build deliberately produces only the portable
  executable, not MSI/NSIS installers. Set it to `true` and run
  `npx tauri build` if you ever want a real installer.
- The release profile trades compile time for binary size (`opt-level = "s"`,
  LTO, stripped symbols).
