# FFmpeg sidecar

Media Prep transcodes with FFmpeg, bundled as the Tauri sidecar `bin/ffmpeg`
(`bundle.externalBin` in `src-tauri/tauri.conf.json`). The app never downloads
FFmpeg at runtime. Each build target needs its own binary in `src-tauri/bin/`,
named with the Rust target triple:

| Target | File |
| --- | --- |
| Windows x64 | `src-tauri/bin/ffmpeg-x86_64-pc-windows-msvc.exe` |
| macOS Apple Silicon | `src-tauri/bin/ffmpeg-aarch64-apple-darwin` |
| macOS Intel | `src-tauri/bin/ffmpeg-x86_64-apple-darwin` |
| Linux x64 | `src-tauri/bin/ffmpeg-x86_64-unknown-linux-gnu` |

Use static builds that include `libx264` and `aac`. On macOS, mark the files
executable (`chmod +x`). Do not add a `.exe` suffix twice on Windows.

For a local build, put FFmpeg in `src-tauri/bin/` yourself, using the name
above for your machine. The folder is git-ignored, so the binaries are never
committed.

The release workflow (`.github/workflows/release.yml`) downloads its own copy
for each target before it builds: BtbN's win64 GPL build for Windows, Martin
Riedl's static builds for macOS arm64 and x86_64, and John Van Sickle's static
amd64 release for Linux. If the file is missing after the download, the job
fails with a message naming it.
