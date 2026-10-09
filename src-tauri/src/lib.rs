mod midi;
mod picture_recv;
mod picture_send;
mod prolink;

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

/// Portable projects keep clips in `<project>/Source/` (relative path `Source/<leaf>`).
fn project_media_dir(project_path: &str) -> Result<(PathBuf, String), String> {
  let project = project_file_path(project_path)?;
  let parent = project.parent().ok_or_else(|| "That project has no folder.".to_string())?;
  Ok((parent.join("Source"), "Source".to_string()))
}

fn allow_project_media(app: &tauri::AppHandle, project_path: &str) {
  let Ok((dir, _)) = project_media_dir(project_path) else { return };
  if dir.is_dir() {
    let _ = allow_media_dir(app, &dir);
  }
  // Older projects may still keep a `<stem>.media` folder beside the .vjproj.
  if let Ok(project) = project_file_path(project_path) {
    if let (Some(parent), Some(stem)) = (project.parent(), project.file_stem().and_then(|n| n.to_str())) {
      let legacy = parent.join(format!("{stem}.media"));
      if legacy.is_dir() {
        let _ = allow_media_dir(app, &legacy);
      }
    }
  }
}

fn project_file_path(path: &str) -> Result<PathBuf, String> {
  let trimmed = path.trim();
  if trimmed.is_empty() {
    return Err("Choose a project file.".into());
  }
  let file = PathBuf::from(trimmed);
  match file.extension().and_then(|ext| ext.to_str()).map(|ext| ext.to_ascii_lowercase()) {
    Some(ext) if ext == "vjproj" || ext == "json" => Ok(file),
    _ => Err("Save the project as a .vjproj file.".into()),
  }
}

#[tauri::command]
fn write_text_file(app: tauri::AppHandle, path: String, contents: String) -> Result<(), String> {
  if contents.len() > 32 * 1024 * 1024 {
    return Err("That project is too large to save.".into());
  }
  let file = project_file_path(&path)?;
  if let Some(dir) = file.parent() {
    std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
  }
  std::fs::write(&file, contents).map_err(|err| err.to_string())?;
  remember_saved_project(&app, &file);
  allow_project_media(&app, &path);
  Ok(())
}

#[tauri::command]
fn read_text_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
  let file = project_file_path(&path)?;
  allow_project_media(&app, &path);
  if !file.is_file() {
    return Err("Missing project file.".into());
  }
  let len = std::fs::metadata(&file).map_err(|err| err.to_string())?.len();
  if len > 32 * 1024 * 1024 {
    return Err("That project is too large to open.".into());
  }
  std::fs::read_to_string(file).map_err(|err| err.to_string())
}

/// Copy a file into `<project>/Source/` next to the .vjproj. Returns `Source/<leaf>`.
#[tauri::command]
fn copy_project_asset(
  app: tauri::AppHandle,
  project_path: String,
  source_path: String,
  leaf: String,
) -> Result<String, String> {
  let (dir, folder) = project_media_dir(&project_path)?;
  std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
  allow_media_dir(&app, &dir)?;
  let name = safe_leaf(&leaf);
  let dest = dir.join(&name);
  let source = absolute_sanitized(Path::new(source_path.trim()))?;
  if !source.is_file() {
    return Err(format!("Missing file: {leaf}"));
  }
  if source != dest {
    let src_len = std::fs::metadata(&source).map(|meta| meta.len()).unwrap_or(0);
    let dst_len = std::fs::metadata(&dest).ok().filter(|meta| meta.is_file()).map(|meta| meta.len());
    if dst_len != Some(src_len) {
      std::fs::copy(&source, &dest).map_err(|err| err.to_string())?;
    }
  }
  Ok(format!("{folder}/{name}"))
}

/// Relative path when that asset is already stored at the same size.
#[tauri::command]
fn project_asset_ready(project_path: String, leaf: String, size: u64) -> Result<Option<String>, String> {
  if size == 0 {
    return Ok(None);
  }
  let (dir, folder) = project_media_dir(&project_path)?;
  let name = safe_leaf(&leaf);
  let dest = dir.join(&name);
  if dest.is_file() && std::fs::metadata(&dest).map(|meta| meta.len()).unwrap_or(0) == size {
    return Ok(Some(format!("{folder}/{name}")));
  }
  Ok(None)
}

/// Write one chunk of a project asset. Filename and the project path ride in headers.
#[tauri::command]
async fn write_project_asset(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
  let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
    return Err("The file chunk did not arrive as binary.".into());
  };
  let header = |key: &str| {
    request
      .headers()
      .get(key)
      .and_then(|value| value.to_str().ok())
      .map(percent_decode)
      .unwrap_or_default()
  };
  let project_path = header("x-project");
  let leaf = header("x-leaf");
  let append = header("x-append") == "1";
  if project_path.trim().is_empty() || leaf.trim().is_empty() {
    return Err("The project file is missing a name.".into());
  }
  let (dir, folder) = project_media_dir(&project_path)?;
  tokio::fs::create_dir_all(&dir).await.map_err(|err| err.to_string())?;
  allow_media_dir(&app, &dir)?;
  let name = safe_leaf(&leaf);
  let dest = dir.join(&name);
  let mut file = tokio::fs::OpenOptions::new()
    .create(true)
    .write(true)
    .append(append)
    .truncate(!append)
    .open(&dest)
    .await
    .map_err(|err| err.to_string())?;
  file.write_all(&bytes).await.map_err(|err| err.to_string())?;
  file.flush().await.map_err(|err| err.to_string())?;
  Ok(format!("{folder}/{name}"))
}

#[tauri::command]
fn default_documents_dir() -> Result<String, String> {
  let dir = dirs::document_dir().unwrap_or_else(|| stock_root());
  Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn default_downloads_dir() -> Result<String, String> {
  let dir = dirs::download_dir().unwrap_or_else(|| stock_root());
  Ok(dir.to_string_lossy().to_string())
}

fn reserved_leaf(name: &str) -> bool {
  let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
  matches!(
    stem.as_str(),
    "CON" | "PRN" | "AUX" | "NUL"
      | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9"
      | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
  )
}

fn clean_project_name(name: &str) -> String {
  let folded: String = name
    .chars()
    .map(|ch| if ch.is_control() || "\\/:*?\"<>|".contains(ch) { ' ' } else { ch })
    .collect();
  let collapsed = folded.split_whitespace().collect::<Vec<_>>().join(" ");
  let trimmed = collapsed.trim().trim_matches('.').trim();
  let mut base = if trimmed.is_empty() { "Untitled".to_string() } else { trimmed.to_string() };
  if base.chars().count() > 48 {
    base = base.chars().take(48).collect();
    base = base.trim().trim_end_matches('.').to_string();
  }
  if base.is_empty() || reserved_leaf(&base) {
    base = format!("{base}_");
    if base == "_" { base = "Untitled".to_string(); }
  }
  base
}

/// Create `Y2K-VJ-<name>` once, with Recordings, Stock, and Source, and return the .vjproj path.
#[tauri::command]
fn create_project_folder(app: tauri::AppHandle, root: String, name: String) -> Result<String, String> {
  let base = PathBuf::from(root.trim());
  if root.trim().is_empty() || !base.is_absolute() {
    return Err("Choose where new projects are created.".into());
  }
  std::fs::create_dir_all(&base).map_err(|err| err.to_string())?;
  let title = clean_project_name(&name);
  let leaf = format!("Y2K-VJ-{title}");
  let mut folder = base.join(&leaf);
  let mut file_stem = title.clone();
  let mut n = 2;
  while folder.exists() {
    folder = base.join(format!("{leaf}-{n}"));
    file_stem = format!("{title}-{n}");
    n += 1;
    if n > 99 {
      return Err("That project name is already used.".into());
    }
  }
  for sub in ["Recordings", "Stock", "Source"] {
    std::fs::create_dir_all(folder.join(sub)).map_err(|err| err.to_string())?;
  }
  allow_media_dir(&app, &folder)?;
  Ok(folder.join(format!("{file_stem}.vjproj")).to_string_lossy().to_string())
}

#[tauri::command]
fn ensure_folder(app: tauri::AppHandle, path: String) -> Result<String, String> {
  let trimmed = path.trim();
  if trimmed.is_empty() {
    return Err("That folder is missing a path.".into());
  }
  let dir = PathBuf::from(trimmed);
  std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
  if dir.is_dir() {
    allow_media_dir(&app, &dir)?;
  }
  Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn default_stock_dir() -> Result<String, String> {
  let dir = stock_root();
  std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
  Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn default_recordings_dir() -> Result<String, String> {
  let dir = stock_root().join("Recordings");
  std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
  Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
  let dir = if path.trim().is_empty() {
    stock_root()
  } else {
    PathBuf::from(path.trim())
  };
  std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
  #[cfg(target_os = "windows")]
  {
    std::process::Command::new("explorer")
      .arg(&dir)
      .spawn()
      .map_err(|err| err.to_string())?;
  }
  #[cfg(target_os = "macos")]
  {
    std::process::Command::new("open")
      .arg(&dir)
      .spawn()
      .map_err(|err| err.to_string())?;
  }
  #[cfg(all(unix, not(target_os = "macos")))]
  {
    std::process::Command::new("xdg-open")
      .arg(&dir)
      .spawn()
      .map_err(|err| err.to_string())?;
  }
  Ok(())
}

/// Write one chunk of a recording or other binary file. Folder and name ride in headers.
#[tauri::command]
async fn write_binary_file(request: tauri::ipc::Request<'_>) -> Result<String, String> {
  let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
    return Err("The file did not arrive as binary.".into());
  };
  let header = |key: &str| {
    request
      .headers()
      .get(key)
      .and_then(|value| value.to_str().ok())
      .map(percent_decode)
      .unwrap_or_default()
  };
  let dir_text = header("x-dir");
  let name = safe_filename(&header("x-name"))?;
  let append = header("x-append") == "1";
  if dir_text.trim().is_empty() {
    return Err("Choose a folder first.".into());
  }
  let dir = PathBuf::from(dir_text.trim());
  tokio::fs::create_dir_all(&dir).await.map_err(|err| err.to_string())?;
  let dest = dir.join(&name);
  let mut file = tokio::fs::OpenOptions::new()
    .create(true)
    .write(true)
    .append(append)
    .truncate(!append)
    .open(&dest)
    .await
    .map_err(|err| err.to_string())?;
  file.write_all(&bytes).await.map_err(|err| err.to_string())?;
  file.flush().await.map_err(|err| err.to_string())?;
  Ok(dest.to_string_lossy().to_string())
}

fn stock_api_host(url: &reqwest::Url) -> bool {
  let host = url.host_str().unwrap_or("").to_ascii_lowercase();
  host == "commons.wikimedia.org"
    || host.ends_with(".wikimedia.org")
    || host == "archive.org"
    || host.ends_with(".archive.org")
}

/// Search JSON for the desktop app. The Mac web view drops these requests, so
/// the same Wikimedia and Archive calls go out through reqwest on every desktop.
#[tauri::command]
async fn fetch_stock_json(url: String) -> Result<String, String> {
  let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "That search link is not valid.".to_string())?;
  if parsed.scheme() != "https" || !stock_api_host(&parsed) {
    return Err("That search host cannot be used.".into());
  }
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(20))
    .user_agent("Y2KVJ/2.0 (https://github.com/cin-seeds/y2k-vj-by-cin; stock-video)")
    .build()
    .map_err(|err| err.to_string())?;
  let response = client.get(parsed).send().await.map_err(|err| err.to_string())?;
  if !response.status().is_success() {
    return Err(format!("Search failed ({})", response.status()));
  }
  let text = response.text().await.map_err(|err| err.to_string())?;
  if text.len() > 4 * 1024 * 1024 {
    return Err("That search response is too large.".into());
  }
  Ok(text)
}

#[tauri::command]
async fn download_video(
  app: tauri::AppHandle,
  url: String,
  filename: String,
  save_dir: String,
) -> Result<String, String> {
  ensure_ffmpeg_sidecar()?;
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
    .user_agent("Y2KVJ/2.0 (https://github.com/cin-seeds/y2k-vj-by-cin; stock-video)")
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

fn audio_download_host(url: &reqwest::Url) -> bool {
  let host = url.host_str().unwrap_or("").to_ascii_lowercase();
  host == "upload.wikimedia.org"
    || host.ends_with(".wikimedia.org")
    || host == "archive.org"
    || host.ends_with(".archive.org")
    || host == "freesound.org"
    || host.ends_with(".freesound.org")
}

fn safe_audio_leaf(filename: &str) -> String {
  let leaf = Path::new(filename)
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("sample");
  let clean: String = leaf
    .chars()
    .map(|ch| if "\\/:*?\"<>|".contains(ch) { '-' } else { ch })
    .collect();
  let stem = Path::new(clean.trim())
    .file_stem()
    .and_then(|name| name.to_str())
    .unwrap_or("sample");
  let name: String = stem
    .trim()
    .trim_start_matches('.')
    .chars()
    .take(80)
    .collect();
  let name = if name.is_empty() { "sample".to_string() } else { name };
  format!("{name}.wav")
}

/// Download a Commons audio file and write a 44.1 kHz stereo wav into the global library.
#[tauri::command]
async fn download_audio(app: tauri::AppHandle, url: String, filename: String, save_dir: String) -> Result<String, String> {
  let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "That audio link is not a download address.".to_string())?;
  if parsed.scheme() != "https" && parsed.scheme() != "http" {
    return Err("That audio link is not a download address.".into());
  }
  if !audio_download_host(&parsed) {
    return Err("That audio host cannot be downloaded.".into());
  }
  let dir = if save_dir.trim().is_empty() {
    global_media_root(&app)?
  } else {
    let chosen = PathBuf::from(save_dir.trim());
    tokio::fs::create_dir_all(&chosen).await.map_err(|err| err.to_string())?;
    chosen
  };
  allow_media_dir(&app, &dir)?;
  let leaf = safe_audio_leaf(&filename);
  let dest = dir.join(&leaf);
  if tokio::fs::metadata(&dest).await.map(|meta| meta.is_file() && meta.len() > 44).unwrap_or(false) {
    return Ok(dest.to_string_lossy().to_string());
  }
  let incoming = dir.join("_incoming");
  tokio::fs::create_dir_all(&incoming).await.map_err(|err| err.to_string())?;
  let part = incoming.join(format!("{leaf}.part"));
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(180))
    .user_agent("Y2KVJ/2.0 (https://github.com/cin-seeds/y2k-vj-by-cin; stock-audio)")
    .build()
    .map_err(|err| err.to_string())?;
  let response = client.get(parsed).send().await.map_err(|_| "Download failed".to_string())?;
  if !response.status().is_success() {
    return Err("Download failed".into());
  }
  if let Some(len) = response.content_length() {
    if len > 80 * 1024 * 1024 {
      return Err("That audio file is too large.".into());
    }
  }
  let written = async {
    let mut file = tokio::fs::File::create(&part).await.map_err(|err| err.to_string())?;
    let mut stream = response.bytes_stream();
    let mut total: u64 = 0;
    while let Some(chunk) = stream.next().await {
      let chunk = chunk.map_err(|_| "Download failed".to_string())?;
      total += chunk.len() as u64;
      if total > 80 * 1024 * 1024 {
        return Err("That audio file is too large.".into());
      }
      file.write_all(&chunk).await.map_err(|err| err.to_string())?;
    }
    file.flush().await.map_err(|err| err.to_string())?;
    Ok(())
  }
  .await;
  if let Err(err) = written {
    let _ = tokio::fs::remove_file(&part).await;
    return Err(err);
  }

  ensure_ffmpeg_sidecar()?;
  let input_arg = part.to_string_lossy().to_string();
  let output = dest.to_string_lossy().to_string();
  let (mut rx, child) = app
    .shell()
    .sidecar("ffmpeg")
    .map_err(|err| ffmpeg_launch_error(&err.to_string()))?
    .args([
      "-y",
      "-nostdin",
      "-i",
      &input_arg,
      "-vn",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      &output,
    ])
    .spawn()
    .map_err(|err| ffmpeg_launch_error(&err.to_string()))?;
  let mut code = 1;
  let mut last_line = String::new();
  let mut pending = String::new();
  while let Some(event) = rx.recv().await {
    match event {
      CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
        pending.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(index) = pending.find(['\n', '\r']) {
          let line = pending[..index].trim().to_string();
          pending.replace_range(..=index, "");
          if !line.is_empty() {
            last_line = line;
          }
        }
      }
      CommandEvent::Error(err) => {
        drop(child);
        let _ = tokio::fs::remove_file(&part).await;
        let _ = tokio::fs::remove_file(&dest).await;
        return Err(ffmpeg_launch_error(&err));
      }
      CommandEvent::Terminated(payload) => {
        code = payload.code.unwrap_or(1);
      }
      _ => {}
    }
  }
  drop(child);
  let _ = tokio::fs::remove_file(&part).await;
  if code != 0 || !dest.is_file() {
    let _ = tokio::fs::remove_file(&dest).await;
    let message = if last_line.is_empty() {
      format!("FFmpeg stopped ({code})")
    } else {
      last_line
    };
    return Err(message);
  }
  allow_media_dir(&app, &dir)?;
  Ok(output)
}

fn library_dir(save_dir: &str) -> PathBuf {
  let trimmed = save_dir.trim();
  if trimmed.is_empty() {
    stock_root()
  } else {
    PathBuf::from(trimmed)
  }
}

/// Permanent clip store. Survives restarts and is shared by every project.
fn global_media_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|err| err.to_string())?
    .join("global_media");
  std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
  Ok(dir)
}

fn allow_media_dir(app: &tauri::AppHandle, dir: &Path) -> Result<(), String> {
  app
    .asset_protocol_scope()
    .allow_directory(dir, true)
    .map_err(|err| err.to_string())
}

/// Let the asset protocol play files from a folder chosen on this computer.
#[tauri::command]
fn allow_media_folder(app: tauri::AppHandle, path: String) -> Result<bool, String> {
  let trimmed = path.trim();
  if trimmed.is_empty() {
    return Ok(false);
  }
  let dir = PathBuf::from(trimmed);
  if !dir.is_dir() {
    return Ok(false);
  }
  allow_media_dir(&app, &dir)?;
  Ok(true)
}

/// True when a clip, audio file, or logo is present, and its folder may play.
#[tauri::command]
fn media_file_ready(app: tauri::AppHandle, path: String) -> Result<bool, String> {
  let trimmed = path.trim();
  if trimmed.is_empty() {
    return Ok(false);
  }
  let file = PathBuf::from(trimmed);
  if !file.is_file() {
    return Ok(false);
  }
  if let Some(dir) = file.parent() {
    if !dir.as_os_str().is_empty() {
      allow_media_dir(&app, dir)?;
    }
  }
  Ok(true)
}

fn is_media_leaf(name: &str) -> bool {
  let lower = name.to_ascii_lowercase();
  lower.ends_with(".mp4")
    || lower.ends_with(".mov")
    || lower.ends_with(".m4v")
    || lower.ends_with(".webm")
    || lower.ends_with(".mkv")
    || lower.ends_with(".png")
    || lower.ends_with(".jpg")
    || lower.ends_with(".jpeg")
    || lower.ends_with(".gif")
    || lower.ends_with(".webp")
    || lower.ends_with(".bmp")
    || lower.ends_with(".avif")
    || lower.ends_with(".wav")
    || lower.ends_with(".mp3")
    || lower.ends_with(".ogg")
    || lower.ends_with(".flac")
    || lower.ends_with(".aiff")
    || lower.ends_with(".aif")
    || lower.ends_with(".m4a")
}

#[derive(Clone, serde::Serialize)]
struct GlobalMediaItem {
  name: String,
  path: String,
}

#[tauri::command]
fn global_media_dir(app: tauri::AppHandle) -> Result<String, String> {
  let dir = global_media_root(&app)?;
  allow_media_dir(&app, &dir)?;
  Ok(dir.to_string_lossy().to_string())
}

fn is_drive_root(dir: &Path) -> bool {
  let Ok(path) = dir.canonicalize() else { return false };
  path.parent().is_none()
}

fn append_media_dir(
  app: &tauri::AppHandle,
  dir: &Path,
  out: &mut Vec<GlobalMediaItem>,
  seen: &mut HashSet<String>,
) {
  if !dir.is_dir() || is_drive_root(dir) {
    return;
  }
  let _ = allow_media_dir(app, dir);
  let Ok(entries) = std::fs::read_dir(dir) else { return };
  for entry in entries.flatten() {
    let path = entry.path();
    if !path.is_file() {
      continue;
    }
    let Some(name) = path.file_name().and_then(|leaf| leaf.to_str()) else { continue };
    if !is_media_leaf(name) {
      continue;
    }
    let text = path.to_string_lossy().to_string();
    if !seen.insert(norm_path(&text)) {
      continue;
    }
    out.push(GlobalMediaItem { name: name.to_string(), path: text });
  }
}

/// Gallery files: the global library, plus clips already downloaded from Wikimedia,
/// Internet Archive, and the other stock sources into the videos folder.
#[tauri::command]
fn list_global_media(app: tauri::AppHandle, save_dir: String) -> Result<Vec<GlobalMediaItem>, String> {
  let mut out = Vec::new();
  let mut seen = HashSet::new();
  let global = global_media_root(&app)?;
  append_media_dir(&app, &global, &mut out, &mut seen);
  append_media_dir(&app, &stock_root(), &mut out, &mut seen);
  let chosen = save_dir.trim();
  if !chosen.is_empty() {
    append_media_dir(&app, Path::new(chosen), &mut out, &mut seen);
  }
  out.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
  Ok(out)
}

fn walk_media_dir(
  app: &tauri::AppHandle,
  dir: &Path,
  out: &mut Vec<GlobalMediaItem>,
  seen: &mut HashSet<String>,
  depth: u32,
) {
  if depth > 6 || out.len() > 4000 || !dir.is_dir() || is_drive_root(dir) {
    return;
  }
  let _ = allow_media_dir(app, dir);
  let Ok(entries) = std::fs::read_dir(dir) else { return };
  for entry in entries.flatten() {
    let path = entry.path();
    if path.is_dir() {
      let name = path.file_name().and_then(|leaf| leaf.to_str()).unwrap_or("");
      if name.starts_with('.') || name == "node_modules" {
        continue;
      }
      walk_media_dir(app, &path, out, seen, depth + 1);
      continue;
    }
    if !path.is_file() {
      continue;
    }
    let Some(name) = path.file_name().and_then(|leaf| leaf.to_str()) else { continue };
    if !is_media_leaf(name) {
      continue;
    }
    let text = path.to_string_lossy().to_string();
    if !seen.insert(norm_path(&text)) {
      continue;
    }
    out.push(GlobalMediaItem { name: name.to_string(), path: text });
  }
}

/// Media files under a project folder, including subfolders.
#[tauri::command]
fn list_dir_media(app: tauri::AppHandle, dir: String) -> Result<Vec<GlobalMediaItem>, String> {
  let mut out = Vec::new();
  let mut seen = HashSet::new();
  let root = PathBuf::from(dir.trim());
  if dir.trim().is_empty() || !root.is_dir() {
    return Ok(out);
  }
  walk_media_dir(&app, &root, &mut out, &mut seen, 0);
  out.sort_by(|a, b| a.path.len().cmp(&b.path.len()).then_with(|| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase())));
  Ok(out)
}

fn image_leaf(name: &str) -> bool {
  let lower = name.to_ascii_lowercase();
  lower.ends_with(".png")
    || lower.ends_with(".jpg")
    || lower.ends_with(".jpeg")
    || lower.ends_with(".gif")
    || lower.ends_with(".webp")
    || lower.ends_with(".bmp")
    || lower.ends_with(".avif")
}

/// Images and the app's prepared outputs can be connected. Original footage stays unconnected.
#[tauri::command]
async fn file_is_prepared(app: tauri::AppHandle, path: String) -> Result<bool, String> {
  let file = PathBuf::from(path.trim());
  if path.trim().is_empty() || !file.is_file() {
    return Ok(false);
  }
  let Some(name) = file.file_name().and_then(|leaf| leaf.to_str()) else { return Ok(false) };
  if image_leaf(name) || name.to_ascii_lowercase().ends_with(".m4a") {
    return Ok(true);
  }
  if !name.to_ascii_lowercase().ends_with(".mp4") {
    return Ok(false);
  }
  let input = file.to_string_lossy().to_string();
  let Ok(sidecar) = app.shell().sidecar("ffmpeg") else { return Ok(false) };
  let Ok((mut rx, _child)) = sidecar.args(["-hide_banner", "-i", &input]).spawn() else { return Ok(false) };
  let mut text = String::new();
  while let Some(event) = rx.recv().await {
    match event {
      CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
        text.push_str(&String::from_utf8_lossy(&bytes));
        if text.len() > 12000 {
          break;
        }
      }
      CommandEvent::Terminated(_) => break,
      _ => {}
    }
  }
  let lower = text.to_ascii_lowercase();
  Ok(lower.contains("video: h264") && lower.contains("1920x1080"))
}

fn path_inside(path: &Path, root: &Path) -> bool {
  let file = norm_path(&path.to_string_lossy());
  let base = norm_path(&root.to_string_lossy());
  !base.is_empty() && (file == base || file.starts_with(&format!("{base}/")))
}

/// Copy an already-playable file. A save dir keeps it there and does not copy it into the private library.
#[tauri::command]
fn copy_into_global_media(app: tauri::AppHandle, input_path: String, save_dir: String) -> Result<String, String> {
  let input = absolute_sanitized(Path::new(input_path.trim()))?;
  if !input.is_file() {
    return Err("That file was not found.".into());
  }
  let dir = if save_dir.trim().is_empty() {
    global_media_root(&app)?
  } else {
    let chosen = PathBuf::from(save_dir.trim());
    std::fs::create_dir_all(&chosen).map_err(|err| err.to_string())?;
    chosen
  };
  allow_media_dir(&app, &dir)?;
  if path_inside(&input, &dir) {
    return Ok(input.to_string_lossy().to_string());
  }
  let leaf = input
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("media.bin");
  let mut dest = dir.join(safe_leaf(leaf));
  if dest == input {
    return Ok(dest.to_string_lossy().to_string());
  }
  let stem = dest.file_stem().and_then(|name| name.to_str()).unwrap_or("media").to_string();
  let ext = dest.extension().and_then(|name| name.to_str()).unwrap_or("mp4").to_string();
  let mut n = 2;
  while dest.exists() {
    dest = dir.join(format!("{stem}-{n}.{ext}"));
    n += 1;
    if n > 99 {
      break;
    }
  }
  std::fs::copy(&input, &dest).map_err(|err| err.to_string())?;
  Ok(dest.to_string_lossy().to_string())
}

fn norm_path(path: &str) -> String {
  path.replace('\\', "/").trim().trim_end_matches('/').to_ascii_lowercase()
}

fn path_leaf(path: &str) -> String {
  Path::new(path)
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or(path)
    .to_string()
}

fn same_name(left: &str, right: &str) -> bool {
  let left = left.trim();
  let right = right.trim();
  !left.is_empty() && left.eq_ignore_ascii_case(right)
}

fn same_file_path(left: &str, right: &str) -> bool {
  let left = norm_path(left);
  let right = norm_path(right);
  !left.is_empty() && left == right
}

fn json_str<'a>(value: &'a serde_json::Value, key: &str) -> &'a str {
  value.get(key).and_then(|item| item.as_str()).unwrap_or("")
}

fn media_key_name(key: &str) -> &str {
  key.rsplit_once(':').map(|(_, name)| name).unwrap_or(key)
}

fn slot_uses(slot: &serde_json::Value, file_path: &str, leaf: &str) -> bool {
  let key = json_str(slot, "key");
  let label = json_str(slot, "label");
  let name = media_key_name(key);
  same_name(name, leaf)
    || same_name(label, leaf)
    || same_file_path(name, file_path)
    || same_file_path(key, file_path)
}

fn pool_item_uses(item: &serde_json::Value, file_path: &str, leaf: &str) -> bool {
  let item_path = json_str(item, "path");
  let item_name = json_str(item, "name");
  if item_name.is_empty() {
    let id = json_str(item, "id");
    return same_name(id, leaf) || same_file_path(item_path, file_path) || same_file_path(id, file_path);
  }
  same_name(item_name, leaf) || same_file_path(item_path, file_path) || same_file_path(item_name, file_path)
}

/// Where one saved project still points at this global file.
fn project_uses(value: &serde_json::Value, file_path: &str, leaf: &str) -> Vec<String> {
  let mut places = Vec::new();
  if let Some(pool) = value.get("mediaPool").and_then(|item| item.as_array()) {
    if pool.iter().any(|item| pool_item_uses(item, file_path, leaf)) {
      places.push("Project media bin".to_string());
    }
  }
  if let Some(files) = value.get("mediaFiles").and_then(|item| item.as_array()) {
    if files.iter().any(|item| item.as_str().is_some_and(|name| same_name(name, leaf))) {
      places.push("Project media bin".to_string());
    }
  }
  if let Some(scenes) = value.get("scenes").and_then(|item| item.as_array()) {
    for scene in scenes {
      let scene_name = {
        let named = json_str(scene, "name");
        if named.is_empty() { "Untitled scene" } else { named }
      };
      if let Some(media) = scene.get("media").and_then(|item| item.as_object()) {
        for (layer, slot) in media {
          if slot_uses(slot, file_path, leaf) {
            places.push(format!("Scene \"{scene_name}\" on layer {layer}"));
          }
        }
      }
    }
  }
  if let Some(cues) = value.get("timeline").and_then(|item| item.as_array()) {
    for cue in cues {
      let media_name = {
        let named = json_str(cue, "mediaName");
        if named.is_empty() { json_str(cue, "mediaId") } else { named }
      };
      if same_name(media_name, leaf) || same_file_path(media_name, file_path) {
        let layer = {
          let id = json_str(cue, "layerId");
          if id.is_empty() { "A" } else { id }
        };
        places.push(format!("Timeline clip on layer {layer}"));
      }
    }
  }
  if let Some(media) = value.pointer("/live/media").and_then(|item| item.as_object()) {
    for (layer, slot) in media {
      if slot_uses(slot, file_path, leaf) {
        places.push(format!("Live layer {layer}"));
      }
    }
  }
  places.sort();
  places.dedup();
  places
}

fn project_index_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_data_dir().map_err(|err| err.to_string())?.join("project_index.json"))
}

fn remember_saved_project(app: &tauri::AppHandle, file: &Path) {
  let Ok(index) = project_index_path(app) else { return };
  if let Some(dir) = index.parent() {
    let _ = std::fs::create_dir_all(dir);
  }
  let mut paths: Vec<String> = std::fs::read_to_string(&index)
    .ok()
    .and_then(|text| serde_json::from_str(&text).ok())
    .unwrap_or_default();
  let text = file.to_string_lossy().to_string();
  let key = norm_path(&text);
  if paths.iter().any(|item| norm_path(item) == key) {
    return;
  }
  paths.push(text);
  if let Ok(body) = serde_json::to_string_pretty(&paths) {
    let _ = std::fs::write(index, body);
  }
}

fn saved_project_paths(app: &tauri::AppHandle) -> Vec<PathBuf> {
  let mut out = Vec::new();
  if let Ok(index) = project_index_path(app) {
    if let Ok(text) = std::fs::read_to_string(index) {
      if let Ok(list) = serde_json::from_str::<Vec<String>>(&text) {
        for path in list {
          out.push(PathBuf::from(path));
        }
      }
    }
  }
  if let Ok(dir) = app.path().app_data_dir() {
    let projects = dir.join("projects");
    if let Ok(entries) = std::fs::read_dir(projects) {
      for entry in entries.flatten() {
        let path = entry.path();
        let ext = path.extension().and_then(|name| name.to_str()).unwrap_or("").to_ascii_lowercase();
        if path.is_file() && (ext == "vjproj" || ext == "json") {
          out.push(path);
        }
      }
    }
  }
  out
}

fn read_project_json(path: &Path) -> Option<serde_json::Value> {
  let len = std::fs::metadata(path).ok()?.len();
  if !path.is_file() || len > 32 * 1024 * 1024 {
    return None;
  }
  let text = std::fs::read_to_string(path).ok()?;
  serde_json::from_str(&text).ok()
}

#[derive(serde::Deserialize)]
struct InlineProject {
  name: String,
  path: String,
  document: String,
}

#[derive(serde::Serialize)]
struct MediaUse {
  project: String,
  places: Vec<String>,
}

#[derive(serde::Serialize)]
struct DeleteOutcome {
  deleted: bool,
  uses: Vec<MediaUse>,
}

fn inside_dir(root: &Path, file: &Path) -> bool {
  let Ok(root) = root.canonicalize() else { return false };
  let Ok(file) = file.canonicalize() else { return false };
  file.starts_with(root) && file.is_file()
}

/// Delete one file from the global library. Saved projects are scanned first.
/// A file that is still referenced is left on disk unless `force` is set.
#[tauri::command]
fn delete_global_media(
  app: tauri::AppHandle,
  path: String,
  force: bool,
  projects: Vec<InlineProject>,
  save_dir: String,
) -> Result<DeleteOutcome, String> {
  let target = absolute_sanitized(Path::new(path.trim()))?;
  if !target.is_file() {
    return Ok(DeleteOutcome { deleted: true, uses: Vec::new() });
  }
  let global = global_media_root(&app)?;
  let mut homes = vec![global, stock_root()];
  let chosen = save_dir.trim();
  if !chosen.is_empty() {
    homes.push(PathBuf::from(chosen));
  }
  let allowed = homes.iter().any(|dir| dir.is_dir() && !is_drive_root(dir) && inside_dir(dir, &target));
  if !allowed {
    return Err("That file is not in the Global Library.".into());
  }
  let file_path = target.to_string_lossy().to_string();
  let leaf = path_leaf(&file_path);
  let mut uses = Vec::new();
  let mut seen = HashSet::new();

  for inline in &projects {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&inline.document) else { continue };
    if !inline.path.trim().is_empty() {
      seen.insert(norm_path(&inline.path));
    }
    let places = project_uses(&value, &file_path, &leaf);
    if places.is_empty() {
      continue;
    }
    let project = {
      let given = inline.name.trim();
      if !given.is_empty() {
        given.to_string()
      } else if let Some(named) = value.get("name").and_then(|item| item.as_str()).filter(|text| !text.is_empty()) {
        named.to_string()
      } else {
        "This project".to_string()
      }
    };
    uses.push(MediaUse { project, places });
  }

  for saved in saved_project_paths(&app) {
    let key = norm_path(&saved.to_string_lossy());
    if key.is_empty() || !seen.insert(key) {
      continue;
    }
    let Some(value) = read_project_json(&saved) else { continue };
    let places = project_uses(&value, &file_path, &leaf);
    if places.is_empty() {
      continue;
    }
    let project = value
      .get("name")
      .and_then(|item| item.as_str())
      .filter(|text| !text.is_empty())
      .map(|text| text.to_string())
      .unwrap_or_else(|| path_leaf(&saved.to_string_lossy()));
    uses.push(MediaUse { project, places });
  }

  if !uses.is_empty() && !force {
    return Ok(DeleteOutcome { deleted: false, uses });
  }
  std::fs::remove_file(&target).map_err(|err| err.to_string())?;
  Ok(DeleteOutcome { deleted: true, uses })
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

const FFMPEG_MISSING: &str = "FFmpeg is not installed. Run npm run setup, then restart the desktop app.";

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

fn sidecar_runtime_path() -> Option<PathBuf> {
  let exe = std::env::current_exe().ok()?;
  let mut folder = exe.parent()?.to_path_buf();
  if folder.ends_with("deps") {
    if let Some(parent) = folder.parent() {
      folder = parent.to_path_buf();
    }
  }
  Some(folder.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" }))
}

/// Sidecar("ffmpeg") loads the file next to the app. externalBin stores the
/// triple-named build in src-tauri/bin and Tauri copies it beside the executable.
fn ensure_ffmpeg_sidecar() -> Result<(), String> {
  let Some(runtime) = sidecar_runtime_path() else {
    locate_ffmpeg()?;
    return Ok(());
  };
  if runtime.is_file() {
    return Ok(());
  }
  let source = locate_ffmpeg()?;
  if let Some(parent) = runtime.parent() {
    std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
  }
  std::fs::copy(&source, &runtime).map_err(|err| ffmpeg_launch_error(&err.to_string()))?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o755));
  }
  Ok(())
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

fn audio_output(dir: &Path, input: &Path) -> PathBuf {
  let stem = input.file_stem().and_then(|name| name.to_str()).unwrap_or("audio");
  let mut dest = dir.join(format!("{stem}.m4a"));
  if dest == input {
    dest = dir.join(format!("{stem}-light.m4a"));
  }
  let base = dest.file_stem().and_then(|name| name.to_str()).unwrap_or("audio").to_string();
  let mut n = 2;
  while dest.exists() {
    dest = dir.join(format!("{base}-{n}.m4a"));
    n += 1;
    if n > 99 {
      break;
    }
  }
  dest
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

/// Fit a video to 1920x1080 and write an H.264 MP4 into the global media library.
/// The FFmpeg binary is the `ffmpeg` sidecar (src-tauri/bin/ffmpeg-<target>, copied beside the app).
/// When `drop_audio` is true (Media Manager preference, default on), the AAC track is omitted.
#[tauri::command]
async fn transcode_media(
  app: tauri::AppHandle,
  job_id: String,
  input_path: String,
  save_dir: String,
  keyint: Option<u32>,
  drop_audio: Option<bool>,
) -> Result<String, String> {
  let input = absolute_sanitized(Path::new(input_path.trim()))?;
  if !input.is_file() {
    return Err("That video file was not found.".into());
  }
  let output_dir = if save_dir.trim().is_empty() {
    global_media_root(&app)?
  } else {
    let chosen = PathBuf::from(save_dir.trim());
    std::fs::create_dir_all(&chosen).map_err(|err| err.to_string())?;
    chosen
  };
  let dest = prep_output(&output_dir, &input);
  let output = dest.to_string_lossy().to_string();
  let input_arg = input.to_string_lossy().to_string();
  let gop_n = keyint.unwrap_or(1).clamp(1, 250);
  let gop = gop_n.to_string();
  let preset = if gop_n > 1 { "veryfast" } else { "medium" };
  let strip_audio = drop_audio.unwrap_or(true);

  ensure_ffmpeg_sidecar()?;
  let mut args = vec![
    "-y".into(),
    "-nostdin".into(),
    "-i".into(),
    input_arg,
    "-vf".into(),
    "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(1920-iw)/2:(1080-ih)/2".into(),
    "-c:v".into(),
    "libx264".into(),
    "-preset".into(),
    preset.into(),
    "-pix_fmt".into(),
    "yuv420p".into(),
    "-g".into(),
    gop,
    "-bf".into(),
    "0".into(),
    "-movflags".into(),
    "+faststart".into(),
  ];
  if strip_audio {
    args.push("-an".into());
  } else {
    args.push("-c:a".into());
    args.push("aac".into());
  }
  args.push(output.clone());
  let (mut rx, child) = app
    .shell()
    .sidecar("ffmpeg")
    .map_err(|err| ffmpeg_launch_error(&err.to_string()))?
    .args(args)
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

/// Write a 44.1 kHz stereo AAC file into the global media library.
/// A long wav or aiff becomes a much smaller .m4a the clock can still decode.
#[tauri::command]
async fn transcode_audio(
  app: tauri::AppHandle,
  job_id: String,
  input_path: String,
  save_dir: String,
) -> Result<String, String> {
  let input = absolute_sanitized(Path::new(input_path.trim()))?;
  if !input.is_file() {
    return Err("That audio file was not found.".into());
  }
  let output_dir = if save_dir.trim().is_empty() {
    global_media_root(&app)?
  } else {
    let chosen = PathBuf::from(save_dir.trim());
    std::fs::create_dir_all(&chosen).map_err(|err| err.to_string())?;
    chosen
  };
  allow_media_dir(&app, &output_dir)?;
  let dest = audio_output(&output_dir, &input);
  let output = dest.to_string_lossy().to_string();
  let input_arg = input.to_string_lossy().to_string();

  ensure_ffmpeg_sidecar()?;
  let (mut rx, child) = app
    .shell()
    .sidecar("ffmpeg")
    .map_err(|err| ffmpeg_launch_error(&err.to_string()))?
    .args([
      "-y",
      "-nostdin",
      "-i",
      &input_arg,
      "-vn",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
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
          let _ = tokio::fs::remove_file(&dest).await;
          return Err("Transcode cancelled".into());
        }
        let code = payload.code.unwrap_or(1);
        if code != 0 {
          let _ = tokio::fs::remove_file(&dest).await;
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
      if let Ok(dir) = global_media_root(app.handle()) {
        let _ = app.asset_protocol_scope().allow_directory(&dir, true);
      }
      prolink::start_pro_dj_link(app.handle().clone());
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      fetch_stock_json,
      download_video,
      download_audio,
      default_documents_dir,
      default_downloads_dir,
      create_project_folder,
      ensure_folder,
      default_stock_dir,
      default_recordings_dir,
      open_folder,
      write_binary_file,
      write_text_file,
      read_text_file,
      copy_project_asset,
      project_asset_ready,
      write_project_asset,
      stage_prep_bytes,
      stage_prep_discard,
      global_media_dir,
      allow_media_folder,
      media_file_ready,
      list_global_media,
      list_dir_media,
      file_is_prepared,
      copy_into_global_media,
      delete_global_media,
      transcode_media,
      transcode_audio,
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
      picture_recv::picture_recv_unwatch,
      prolink::start_pro_dj_link
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
