# Desktop packaging evaluation

Status: Tauri 2 desktop-shell prototype under `src-tauri/`. It loads the existing Vite UI and provides native `.elsim` Open/Save dialogs through the official Tauri dialog and filesystem plugins. The capability grants only dialog open/save and single-file read/stat/write operations; dialog-selected paths enter the temporary filesystem scope, and ELSim does not expose arbitrary directory access, shell commands, native ngspice, or installer bundling. The checked-in Cargo lockfile pins Tauri 2.12.5 and its plugins; the desktop shell requires Rust 1.90 or newer. `npm run build:offline` verifies the production frontend and copies the already-built local ngspice WASM into `dist`. This is a development prototype, not a verified desktop release. M4.2 remains open until the shell launches and the required workflows/builds are exercised on Windows, macOS, and Linux and packaging/signing are reviewed.

## Recommendation

Keep the browser PWA as the primary product and keep the simulation engine behind the existing worker/engine adapter. For a later installed desktop app, prototype Tauri 2 wrapping the same built web UI and the same ngspice WebAssembly worker. Do not add a native ngspice binding or fork the UI before a measured browser/WASM limitation requires it.

This route best preserves the current local-first architecture: the web build remains independently deployable, while the desktop shell adds native file dialogs and OS packaging around the same project format and simulation protocol. The recommendation does not establish that one artifact can be cross-compiled or signed for all three operating systems; release jobs must build on each target OS and verify its own installer.

## Options

| Option | Advantages for ELSim | Costs and risks | Current disposition |
| --- | --- | --- | --- |
| Browser PWA | Already implemented; one web build; offline editing; no installer or platform-specific signing | Browser support and origin policies; engine assets are intentionally excluded from the standard public build until the ngspice license gate passes | Keep as the primary and fully supported distribution |
| Tauri 2 + shared WASM | Reuses the Vite UI and worker; native file dialogs and window integration can be added without changing project/engine contracts; avoids bundling a second Chromium runtime | Depends on platform WebViews (the platform system WebView on each operating system); WebView behavior and OS packaging need per-platform testing; Rust/OS build toolchains and signing add release work | Preferred desktop prototype after web workflows and license gate are ready |
| Electron + shared WASM | Bundles Chromium, reducing dependence on different system WebView versions; mature packaging options | Ships a browser runtime with the app; larger distribution; Node/Electron security surface and update maintenance; built-in updater does not cover Linux | Keep as fallback if Tauri WebView differences break required editor or plotting behavior |
| Tauri/Electron + native libngspice | Potentially useful for native model loading, callbacks, or measured performance needs | Separate engine build and adapter; three native packaging pipelines; ABI/runtime differences; adds ngspice-linked materials to every installer and does not remove the existing license review/relinking obligations | Defer; only prototype after a browser/WASM limitation is demonstrated |

Tauri uses the operating system WebView, while Electron packages its application resources and provides an OS-specific distribution/signing workflow. Electron's built-in auto-updater currently targets macOS and Windows; Linux updates are expected to use package managers. These tradeoffs support Tauri as the first small-shell experiment and Electron as the compatibility fallback, not as a tested performance conclusion.

## Proposed desktop boundary

1. Keep schematic, project validation, netlisting, results, plotting, and component animation in the existing TypeScript application.
2. Keep `.elsim` as the single native project format on web and desktop. Desktop file-open/save should call the same validated archive reader/writer and preserve current size/path limits.
3. Keep `EngineAdapter` requests/responses platform-neutral. First desktop prototype should run the same ngspice WASM worker, not create a second native netlist/result path.
4. Let the shell provide narrowly scoped file picker and save dialog capabilities. Do not grant arbitrary filesystem access to the webview; keep the app content local and permissions explicit.
5. Treat PWA and desktop packaging as separate delivery targets. Their content security policies, worker loading, WASM loading, offline behavior, and update mechanisms need separate verification.

## Prototype and release gates

### Current prototype commands

Run `npm ci` to install the project-pinned Tauri 2 CLI and plugins, then use `npm run desktop:dev` for the live Vite UI inside the desktop webview or `npm run desktop:build` to build the desktop application binary from production web assets. The app uses native Open/Save dialogs on Tauri and keeps the browser file-input/download fallback elsewhere. A preflight checks Rust and Linux WebKitGTK versions before starting and checks the locally built engine before packaging. The production shell build uses `build:offline`, so it requires the developer-built, ignored `public/engine/ngspice.mjs` and `.wasm` files. Tauri's Linux build requires the distribution's WebKitGTK 4.1 and related development packages; Windows and macOS require their platform toolchains. Platform-specific bundle icons are generated from the existing ELSim PWA icon and are configured, but installer bundling is still disabled until the prototype passes desktop runtime checks. Browser builds and GitHub Pages remain independent.

- [ ] Verify desktop dev and production binaries on Linux with the required WebKitGTK packages installed.
- [ ] Verify the same shell on Windows and macOS.
- [ ] Validate service-worker, ngspice worker/WASM loading, and `.elsim` save/open behavior in each OS webview.
- [ ] Verify native `.elsim` open/save dialogs on each OS, including cancellation, overwrite confirmation, 50 MiB rejection, and archive/hash validation.
- [x] Generate original platform icons from the existing ELSim PWA icon and configure them for desktop bundling.
- [ ] Enable target installers only after these checks.

Local verification on 2026-10-25: The Tauri and capability JSON parse, Cargo lock metadata and `cargo fmt --check` pass. Desktop Linux/Windows/macOS icons are generated and present. The offline frontend and local `/ELSim/` base-path checks pass. Firefox verifies that browser open/save behavior remains unchanged. `cargo check` cannot compile on the current host: Rust/Cargo 1.84 are below the locked Tauri/plugin Rust 1.90 requirement, and the dependency graph includes an edition-2024 crate; Linux WebKitGTK 4.1 is also not installed. Native permission-schema validation, dialog runtime behavior, and desktop binaries/installers are not yet verified.

- Build and launch the unchanged app shell in Tauri on Windows, macOS, and Linux from clean checkouts. Record OS, toolchain, WebView version, installer size, and startup time.
- Verify project open/save, user model/symbol import, worker initialization, RC transient, AC, DC sweep, cancellation, waveform zoom/pan, and large-trace interaction on each target.
- Confirm that the WebView can load the WASM worker under the production CSP and that project files remain accessible only through user-selected paths.
- Compare installed size, idle memory, startup, 1-million-sample solve/render, and selection responsiveness against the browser baseline in `PERFORMANCE_BENCHMARKS.md`. Do not select native ngspice without a measured need.
- Produce native installers on their target CI runners. Test signing/notarization and update installation with release credentials stored outside the repository. Publish checksums and platform-specific dependency notices.
- Keep automatic updates disabled in the first desktop prototype. Before enabling them, define signed metadata/artifact verification, rollback behavior, release channels, and Linux update ownership (app updater versus package manager).
- Repeat the ngspice object/source license audit for the exact desktop engine artifacts. A native wrapper does not make static-linking obligations disappear; do not distribute an engine-containing installer until the existing legal release gate is satisfied.

## Decision status

Provisional choice: PWA first, Tauri 2 + shared WASM as the desktop prototype, Electron as the fallback, and native ngspice deferred. Evidence still needed: target-OS prototypes, actual installer sizes and performance, WebView workflow parity, signing and notarization, and completed ngspice distribution review. No cross-platform desktop release is claimed by this decision.

## References

- [Tauri architecture and license](https://tauri.app/concept/architecture/)
- [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri updater signatures](https://v2.tauri.app/plugin/updater/)
- [Electron distribution and signing](https://www.electronjs.org/docs/latest/tutorial/distribution-overview)
- [Electron updater platform notes](https://www.electronjs.org/docs/latest/api/auto-updater/)
- [ngspice shared-library API](https://ngspice.sourceforge.io/shared.html)
