mod midi;
mod picture_recv;
mod picture_send;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use futures_util::StreamExt;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::io::AsyncWriteExt;

fn stock_root() -> PathBuf {
  dirs::video_dir()
    .or_else(dirs::download_dir)
    .unwrap_or_else(std::env::temp_dir)
    .join("Y2K VJ")
}

fn safe_filename(filename: &str) -> Result<String, String> {
  let leaf = Path::new(filename)
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("video.mp4");
  let clean: String = leaf
    .chars()
    .map(|ch| if "\\/:*?\"<>|".contains(ch) { '-' } else { ch })
    .collect();
  let name = clean.trim().trim_start_matches('.').to_string();
  if name.is_empty() {
    return Err("The video needs a file name.".into());
  }
  let lower = name.to_ascii_lowercase();
  if lower.ends_with(".mp4") || lower.ends_with(".webm") {
    Ok(name)
  } else {
    Ok(format!("{name}.mp4"))
  }
}

#[tauri::command]
fn default_stock_dir() -> Result<String, String> {
  let dir = stock_root();
  std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
  Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn download_video(
  app: tauri::AppHandle,
  url: String,
  filename: String,
  save_dir: String,
) -> Result<String, String> {
  let parsed = reqwest::Url::parse(&url).map_err(|_| "That video link is not a download address.".to_string())?;
  if parsed.scheme() != "http" && parsed.scheme() != "https" {
    return Err("That video link is not a download address.".into());
  }
  let name = safe_filename(&filename)?;
  let dir = if save_dir.trim().is_empty() {
    stock_root()
  } else {
    PathBuf::from(save_dir.trim())
  };
  tokio::fs::create_dir_all(&dir).await.map_err(|err| err.to_string())?;
  let dest = dir.join(&name);
  if tokio::fs::metadata(&dest).await.map(|meta| meta.is_file() && meta.len() > 0).unwrap_or(false) {
    app.asset_protocol_scope().allow_directory(&dir, true).map_err(|err| err.to_string())?;
    return Ok(dest.to_string_lossy().to_string());
  }
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(180))
    .build()
    .map_err(|err| err.to_string())?;
  let response = client.get(parsed).send().await.map_err(|_| "Download failed".to_string())?;
  if !response.status().is_success() {
    return Err("Download failed".into());
  }
  let part = dir.join(format!("{name}.part"));
  let written = async {
    let mut file = tokio::fs::File::create(&part).await.map_err(|err| err.to_string())?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
      let chunk = chunk.map_err(|_| "Download failed".to_string())?;
      file.write_all(&chunk).await.map_err(|err| err.to_string())?;
    }
    file.flush().await.map_err(|err| err.to_string())?;
    drop(file);
    tokio::fs::rename(&part, &dest).await.map_err(|err| err.to_string())
  }
  .await;
  if let Err(err) = written {
    let _ = tokio::fs::remove_file(&part).await;
    return Err(err);
  }
  app.asset_protocol_scope().allow_directory(&dir, true).map_err(|err| err.to_string())?;
  Ok(dest.to_string_lossy().to_string())
}

fn library_dir(save_dir: &str) -> PathBuf {
  let trimmed = save_dir.trim();
  if trimmed.is_empty() {
    stock_root()
  } else {
    PathBuf::from(trimmed)
  }
}

fn safe_leaf(filename: &str) -> String {
  let leaf = Path::new(filename)
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("video.mp4");
  let clean: String = leaf
    .chars()
    .map(|ch| if "\\/:*?\"<>|".contains(ch) { '-' } else { ch })
    .collect();
  let name = clean.trim().trim_start_matches('.').to_string();
  if name.is_empty() { "video.mp4".into() } else { name }
}

const FFMPEG_MISSING: &str = "FFmpeg binary missing in src-tauri/bin/ - please install sidecar binary";

fn ffmpeg_file_name() -> String {
  let triple = option_env!("TAURI_ENV_TARGET_TRIPLE").unwrap_or(if cfg!(windows) {
    "x86_64-pc-windows-msvc"
  } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
    "aarch64-apple-darwin"
  } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
    "x86_64-apple-darwin"
  } else {
    "x86_64-unknown-linux-gnu"
  });
  if cfg!(windows) {
    format!("ffmpeg-{triple}.exe")
  } else {
    format!("ffmpeg-{triple}")
  }
}

fn locate_ffmpeg() -> Result<PathBuf, String> {
  let file = ffmpeg_file_name();
  let mut candidates = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin").join(&file)];
  if let Ok(exe) = std::env::current_exe() {
    if let Some(folder) = exe.parent() {
      candidates.push(folder.join(&file));
      candidates.push(folder.join("bin").join(&file));
      // Tauri copies the registered sidecar next to the app as ffmpeg.exe.
      candidates.push(folder.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" }));
    }
  }
  candidates
    .into_iter()
    .find(|path| path.is_file())
    .ok_or_else(|| FFMPEG_MISSING.to_string())
}

fn ffmpeg_launch_error(detail: &str) -> String {
  let lower = detail.to_ascii_lowercase();
  if lower.contains("os error 3")
    || lower.contains("cannot find the path")
    || lower.contains("not found")
    || lower.contains("no such file")
    || lower.contains("sidecar")
  {
    FFMPEG_MISSING.to_string()
  } else {
    format!("FFmpeg failed to launch: {detail}")
  }
}

/// A cleaned absolute path. On Windows the result has a drive prefix and no `.` or `..`.
fn absolute_sanitized(path: &Path) -> Result<PathBuf, String> {
  let raw = if path.as_os_str().is_empty() {
    stock_root()
  } else if path.is_absolute() {
    path.to_path_buf()
  } else {
    std::env::current_dir().unwrap_or_else(|_| stock_root()).join(path)
  };
  let mut clean = PathBuf::new();
  for component in raw.components() {
    match component {
      std::path::Component::CurDir => {}
      std::path::Component::ParentDir => {
        if !clean.pop() {
          return Err("The output folder path is not valid.".into());
        }
      }
      std::path::Component::Normal(part) => {
        let text = part.to_string_lossy();
        if text.is_empty() || text.contains('\0') {
          return Err("The output folder path is not valid.".into());
        }
        if cfg!(windows) && text.chars().any(|ch| matches!(ch, '<' | '>' | '"' | '|' | '?' | '*')) {
          return Err("The output folder path contains characters Windows cannot use.".into());
        }
        clean.push(part);
      }
      other => clean.push(other.as_os_str()),
    }
  }
  if cfg!(windows) && !clean.has_root() {
    return Err("The output folder must be an absolute path.".into());
  }
  if clean.as_os_str().is_empty() {
    return Err("The output folder path is not valid.".into());
  }
  Ok(clean)
}

fn prep_output(dir: &Path, input: &Path) -> PathBuf {
  let stem = input.file_stem().and_then(|name| name.to_str()).unwrap_or("video");
  let mut dest = dir.join(format!("{stem}.mp4"));
  if dest == input {
    dest = dir.join(format!("{stem}-web.mp4"));
  }
  let base = dest.file_stem().and_then(|name| name.to_str()).unwrap_or("video").to_string();
  let mut n = 2;
  while dest.exists() {
    dest = dir.join(format!("{base}-{n}.mp4"));
    n += 1;
    if n > 99 {
      break;
    }
  }
  dest
}

fn clock_after(text: &str, key: &str) -> Option<f64> {
  let rest = text.split(key).nth(1)?.trim();
  let token = rest.split([',', ' ']).next()?;
  let mut parts = token.split(':');
  let hours: f64 = parts.next()?.parse().ok()?;
  let mins: f64 = parts.next()?.parse().ok()?;
  let secs: f64 = parts.next()?.parse().ok()?;
  Some(hours * 3600.0 + mins * 60.0 + secs)
}

#[derive(Clone, serde::Serialize)]
struct PrepEvent {
  id: String,
  kind: String,
  line: String,
  percent: Option<f64>,
  output: String,
  error: String,
}

fn emit_prep(app: &tauri::AppHandle, event: PrepEvent) {
  let _ = app.emit("media-prep", event);
}

/// Header values arrive percent-encoded so non-ASCII file names survive.
fn percent_decode(text: &str) -> String {
  let raw = text.as_bytes();
  let mut out = Vec::with_capacity(raw.len());
  let mut i = 0;
  while i < raw.len() {
    if raw[i] == b'%' && i + 2 < raw.len() {
      let hex = std::str::from_utf8(&raw[i + 1..i + 3]).ok();
      if let Some(byte) = hex.and_then(|pair| u8::from_str_radix(pair, 16).ok()) {
        out.push(byte);
        i += 3;
        continue;
      }
    }
    out.push(raw[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

fn staged_path(filename: &str, save_dir: &str) -> PathBuf {
  library_dir(save_dir).join("_incoming").join(safe_leaf(filename))
}

/// Copy a dropped video into the library folder when the webview has no path.
/// The body is one raw chunk; filename, save-dir, and append ride in headers.
#[tauri::command]
async fn stage_prep_bytes(request: tauri::ipc::Request<'_>) -> Result<String, String> {
  let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
    return Err("The video chunk did not arrive as binary.".into());
  };
  let header = |key: &str| {
    request
      .headers()
      .get(key)
      .and_then(|value| value.to_str().ok())
      .map(percent_decode)
      .unwrap_or_default()
  };
  let filename = header("x-filename");
  let save_dir = header("x-save-dir");
  let append = header("x-append") == "1";
  let dest = staged_path(&filename, &save_dir);
  if let Some(dir) = dest.parent() {
    tokio::fs::create_dir_all(dir).await.map_err(|err| err.to_string())?;
  }
  let mut file = tokio::fs::OpenOptions::new()
    .create(true)
    .write(true)
    .append(append)
    .truncate(!append)
    .open(&dest)
    .await
    .map_err(|err| err.to_string())?;
  file.write_all(bytes).await.map_err(|err| err.to_string())?;
  file.flush().await.map_err(|err| err.to_string())?;
  Ok(dest.to_string_lossy().to_string())
}

/// Delete a half-copied file from _incoming after staging fails.
#[tauri::command]
async fn stage_prep_discard(filename: String, save_dir: String) -> Result<(), String> {
  let dest = staged_path(&filename, &save_dir);
  match tokio::fs::remove_file(&dest).await {
    Ok(()) => Ok(()),
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(err) => Err(err.to_string()),
  }
}

struct RunningTranscode {
  child: CommandChild,
  output: PathBuf,
}

fn transcodes() -> std::sync::MutexGuard<'static, HashMap<String, RunningTranscode>> {
  static JOBS: OnceLock<Mutex<HashMap<String, RunningTranscode>>> = OnceLock::new();
  JOBS
    .get_or_init(|| Mutex::new(HashMap::new()))
    .lock()
    .unwrap_or_else(|err| err.into_inner())
}

fn cancelled_jobs() -> std::sync::MutexGuard<'static, HashSet<String>> {
  static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
  CANCELLED
    .get_or_init(|| Mutex::new(HashSet::new()))
    .lock()
    .unwrap_or_else(|err| err.into_inner())
}

/// Stop a running transcode and delete the half-written MP4.
#[tauri::command]
async fn transcode_cancel(job_id: String) -> Result<(), String> {
  let running = transcodes().remove(&job_id);
  let Some(running) = running else { return Ok(()) };
  cancelled_jobs().insert(job_id);
  running.child.kill().map_err(|err| err.to_string())?;
  // Windows releases the file handle a moment after the process dies.
  for _ in 0..20 {
    match tokio::fs::remove_file(&running.output).await {
      Ok(()) => return Ok(()),
      Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
      Err(_) => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
    }
  }
  Err(format!("Could not delete {}", running.output.display()))
}

/// Fit a video to 1920x1080 and write an MP4 into the shared media library folder.
/// The FFmpeg binary is the `bin/ffmpeg` sidecar (src-tauri/bin/ffmpeg-<target>).
#[tauri::command]
async fn transcode_media(
  app: tauri::AppHandle,
  job_id: String,
  input_path: String,
  save_dir: String,
) -> Result<String, String> {
  let input = absolute_sanitized(Path::new(input_path.trim()))?;
  if !input.is_file() {
    return Err("That video file was not found.".into());
  }
  let output_dir = absolute_sanitized(&library_dir(&save_dir))?;
  std::fs::create_dir_all(&output_dir).map_err(|err| {
    format!("Could not create the output folder {}: {err}", output_dir.display())
  })?;
  let dest = prep_output(&output_dir, &input);
  let output = dest.to_string_lossy().to_string();
  let input_arg = input.to_string_lossy().to_string();

  // The sidecar name stays bin/ffmpeg. Spawn only after the file is on disk,
  // so a missing binary does not surface as Windows os error 3.
  locate_ffmpeg()?;
  let (mut rx, child) = app
    .shell()
    .sidecar("bin/ffmpeg")
    .map_err(|err| ffmpeg_launch_error(&err.to_string()))?
    .args([
      "-i",
      &input_arg,
      "-vf",
      "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(1920-iw)/2:(1080-ih)/2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "1",
      "-bf",
      "0",
      "-movflags",
      "+faststart",
      "-c:a",
      "aac",
      &output,
    ])
    .spawn()
    .map_err(|err| ffmpeg_launch_error(&err.to_string()))?;
  transcodes().insert(job_id.clone(), RunningTranscode { child, output: dest.clone() });
  let from_incoming = input.components().any(|part| part.as_os_str() == "_incoming");

  let mut duration = 0.0;
  let mut pending = String::new();
  let mut last_line = String::new();
  let mut finished = false;
  while let Some(event) = rx.recv().await {
    match event {
      CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
        pending.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(index) = pending.find(&['\n', '\r'][..]) {
          let line = pending[..index].trim().to_string();
          pending.replace_range(..=index, "");
          if line.is_empty() {
            continue;
          }
          last_line = line.clone();
          if let Some(secs) = clock_after(&line, "Duration: ") {
            duration = secs;
          }
          let mut percent = None;
          if duration > 0.0 {
            if let Some(secs) = clock_after(&line, "time=") {
              percent = Some((secs / duration * 100.0).clamp(0.0, 99.0));
            }
          }
          emit_prep(&app, PrepEvent {
            id: job_id.clone(),
            kind: "log".into(),
            line,
            percent,
            output: String::new(),
            error: String::new(),
          });
        }
      }
      CommandEvent::Error(err) => {
        transcodes().remove(&job_id);
        return Err(ffmpeg_launch_error(&err));
      }
      CommandEvent::Terminated(payload) => {
        transcodes().remove(&job_id);
        if cancelled_jobs().remove(&job_id) {
          if from_incoming {
            let _ = tokio::fs::remove_file(&input).await;
          }
          return Err("Transcode cancelled".into());
        }
        let code = payload.code.unwrap_or(1);
        if code != 0 {
          let message = if last_line.is_empty() {
            format!("FFmpeg stopped ({code})")
          } else {
            last_line
          };
          emit_prep(&app, PrepEvent {
            id: job_id.clone(),
            kind: "error".into(),
            line: String::new(),
            percent: None,
            output: String::new(),
            error: message.clone(),
          });
          return Err(message);
        }
        finished = true;
      }
      _ => {}
    }
  }
  transcodes().remove(&job_id);
  if cancelled_jobs().remove(&job_id) {
    return Err("Transcode cancelled".into());
  }
  if !finished {
    return Err("FFmpeg stopped before the file was written.".into());
  }
  if from_incoming {
    let _ = tokio::fs::remove_file(&input).await;
  }
  app.asset_protocol_scope().allow_directory(&output_dir, true).map_err(|err| err.to_string())?;
  emit_prep(&app, PrepEvent {
    id: job_id,
    kind: "done".into(),
    line: String::new(),
    percent: Some(100.0),
    output: output.clone(),
    error: String::new(),
  });
  Ok(output)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
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
    .invoke_handler(tauri::generate_handler![
      download_video,
      default_stock_dir,
      stage_prep_bytes,
      stage_prep_discard,
      transcode_media,
      transcode_cancel,
      midi::midi_list,
      midi::midi_open,
      midi::midi_send,
      picture_send::picture_send_start,
      picture_send::picture_send_frame,
      picture_send::picture_send_stop,
      picture_recv::picture_recv_sources,
      picture_recv::picture_recv_watch,
      picture_recv::picture_recv_frame,
      picture_recv::picture_recv_unwatch
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
