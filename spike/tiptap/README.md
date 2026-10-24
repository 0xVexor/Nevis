# not — TipTap app

Notes app (Persian/RTL-first) built on React + Vite + TipTap. See the project README and `docs/` one level up.

```
npm install
npm run dev      # browser, http://127.0.0.1:5173 (data in IndexedDB)
npm run build
```

## Desktop app (Tauri)

Data is stored in a real SQLite file (`noviq.db`) and `files/` under the OS app-data folder
(`%APPDATA%\com.vexor.noviq` on Windows, `~/Library/Application Support/com.vexor.noviq` on macOS).

Prerequisites: Rust **MSVC** toolchain (`rustup default stable-x86_64-pc-windows-msvc`) and Visual Studio Build Tools
("Desktop development with C++") on Windows; Xcode Command Line Tools on macOS.

```
npm run tauri dev      # window with hot reload
npm run tauri build    # installers in src-tauri/target/release/bundle (nsis/*.exe, msi/*.msi, dmg/*.dmg)
```

A macOS installer can only be built on a Mac. Without one, push the repo to GitHub and run the
`Build installers` workflow (`.github/workflows/release.yml`): it builds both and attaches them to the run.
