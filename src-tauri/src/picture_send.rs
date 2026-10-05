// Picture output. Windows publishes Spout and NDI. macOS publishes Syphon and
// NDI. Receiving lives in picture_recv.

use std::ffi::{c_char, c_void, CString};
use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;

use libloading::Library;
use serde::Serialize;

const SENDER_NAME: &str = "Y2K VJ";
const MAX_EDGE: u32 = 3840;

#[derive(Clone, Serialize)]
pub struct SenderFault {
  name: String,
  reason: String,
}

#[derive(Clone, Serialize)]
pub struct StartReport {
  started: Vec<String>,
  errors: Vec<SenderFault>,
}

enum Msg {
  Start {
    width: u32,
    height: u32,
    reply: Sender<StartReport>,
  },
  Frame {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    reply: Sender<Result<(), String>>,
  },
  Stop {
    reply: Sender<()>,
  },
}

fn worker() -> Sender<Msg> {
  static TX: OnceLock<Sender<Msg>> = OnceLock::new();
  TX.get_or_init(|| {
    let (tx, rx) = mpsc::channel::<Msg>();
    std::thread::Builder::new()
      .name("picture-send".into())
      .spawn(move || {
        let mut live: Option<Live> = None;
        while let Ok(msg) = rx.recv() {
          match msg {
            Msg::Start { width, height, reply } => {
              live = Some(Live::start(width, height));
              let _ = reply.send(live.as_ref().map(|item| item.report.clone()).unwrap_or_else(|| StartReport {
                started: Vec::new(),
                errors: vec![SenderFault {
                  name: "Send".into(),
                  reason: "The picture sender did not start.".into(),
                }],
              }));
            }
            Msg::Frame { width, height, pixels, reply } => {
              let result = match live.as_mut() {
                Some(item) => item.push(width, height, &pixels),
                None => Err("Send is off.".into()),
              };
              let _ = reply.send(result);
            }
            Msg::Stop { reply } => {
              live = None;
              let _ = reply.send(());
            }
          }
        }
      })
      .expect("picture sender thread");
    tx
  })
  .clone()
}

fn check_size(width: u32, height: u32) -> Result<(), String> {
  if width < 2 || height < 2 || width > MAX_EDGE || height > MAX_EDGE {
    return Err("That send size is not supported.".into());
  }
  Ok(())
}

#[tauri::command]
pub async fn picture_send_start(width: u32, height: u32) -> Result<StartReport, String> {
  check_size(width, height)?;
  let (reply, rx) = mpsc::channel();
  worker()
    .send(Msg::Start { width, height, reply })
    .map_err(|_| "The picture sender stopped.".to_string())?;
  tokio::task::spawn_blocking(move || rx.recv().map_err(|_| "The picture sender stopped.".to_string()))
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn picture_send_frame(request: tauri::ipc::Request<'_>) -> Result<(), String> {
  let width = header_u32(&request, "x-width")?;
  let height = header_u32(&request, "x-height")?;
  check_size(width, height)?;
  let pixels = match request.body() {
    tauri::ipc::InvokeBody::Raw(pixels) => pixels.clone(),
    _ => return Err("The frame was not a picture.".into()),
  };
  let expected = (width as usize)
    .checked_mul(height as usize)
    .and_then(|px| px.checked_mul(4))
    .ok_or_else(|| "That send size is not supported.".to_string())?;
  if pixels.len() != expected {
    return Err("The frame did not match the send size.".into());
  }
  let (reply, rx) = mpsc::channel();
  worker()
    .send(Msg::Frame { width, height, pixels, reply })
    .map_err(|_| "The picture sender stopped.".to_string())?;
  tokio::task::spawn_blocking(move || rx.recv().map_err(|_| "The picture sender stopped.".to_string()))
    .await
    .map_err(|err| err.to_string())??
}

#[tauri::command]
pub async fn picture_send_stop() -> Result<(), String> {
  let (reply, rx) = mpsc::channel();
  worker()
    .send(Msg::Stop { reply })
    .map_err(|_| "The picture sender stopped.".to_string())?;
  tokio::task::spawn_blocking(move || rx.recv().map_err(|_| "The picture sender stopped.".to_string()))
    .await
    .map_err(|err| err.to_string())?
}

fn header_u32(request: &tauri::ipc::Request, name: &str) -> Result<u32, String> {
  let value = request
    .headers()
    .get(name)
    .ok_or_else(|| format!("missing {name}"))?;
  let text = value.to_str().map_err(|_| format!("bad {name}"))?;
  text.parse::<u32>().map_err(|_| format!("bad {name}"))
}

struct Live {
  width: u32,
  height: u32,
  report: StartReport,
  #[cfg(windows)]
  spout: Option<spout_rs::SpoutSender>,
  #[cfg(target_os = "macos")]
  syphon: Option<syphon_rs::Server>,
  ndi: Option<NdiSender>,
}

impl Live {
  fn start(width: u32, height: u32) -> Self {
    let mut started = Vec::new();
    let mut errors = Vec::new();

    #[cfg(windows)]
    let spout = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| spout_rs::SpoutSender::new(SENDER_NAME))) {
      Ok(sender) => {
        started.push("Spout".into());
        Some(sender)
      }
      Err(_) => {
        errors.push(SenderFault {
          name: "Spout".into(),
          reason: "Spout could not open a sender.".into(),
        });
        None
      }
    };

    #[cfg(target_os = "macos")]
    let syphon = match syphon_rs::Server::new(SENDER_NAME, width, height) {
      Ok(server) => {
        started.push("Syphon".into());
        Some(server)
      }
      Err(err) => {
        errors.push(SenderFault {
          name: "Syphon".into(),
          reason: err.to_string(),
        });
        None
      }
    };

    let ndi = match NdiSender::open(SENDER_NAME) {
      Ok(sender) => {
        started.push("NDI".into());
        Some(sender)
      }
      Err(reason) => {
        errors.push(SenderFault { name: "NDI".into(), reason });
        None
      }
    };

    Self {
      width,
      height,
      report: StartReport { started, errors },
      #[cfg(windows)]
      spout,
      #[cfg(target_os = "macos")]
      syphon,
      ndi,
    }
  }

  fn push(&mut self, width: u32, height: u32, pixels: &[u8]) -> Result<(), String> {
    if width != self.width || height != self.height {
      *self = Self::start(width, height);
    }
    if self.report.started.is_empty() {
      return Err(fault_line(&self.report));
    }
    let mut failed = Vec::new();

    #[cfg(windows)]
    if let Some(spout) = self.spout.as_mut() {
      let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        spout.send_image_rgba(pixels, width, height)
      }));
      match ok {
        Ok(true) => {}
        Ok(false) => failed.push("Spout did not accept the frame.".to_string()),
        Err(_) => failed.push("Spout could not send the frame.".to_string()),
      }
    }

    #[cfg(target_os = "macos")]
    if let Some(syphon) = self.syphon.as_mut() {
      if let Err(err) = syphon.send_frame(pixels) {
        failed.push(format!("Syphon did not accept the frame: {err}"));
      }
    }

    if let Some(ndi) = self.ndi.as_mut() {
      if let Err(err) = ndi.send(pixels, width, height) {
        failed.push(format!("NDI did not accept the frame: {err}"));
      }
    }

    if failed.len() >= self.report.started.len() && !failed.is_empty() {
      return Err(failed.join(" "));
    }
    Ok(())
  }
}

fn fault_line(report: &StartReport) -> String {
  if report.errors.is_empty() {
    return "No sender started.".into();
  }
  report
    .errors
    .iter()
    .map(|fault| format!("{} did not start: {}", fault.name, fault.reason))
    .collect::<Vec<_>>()
    .join(" ")
}

#[repr(C)]
struct NdiSendCreate {
  name: *const c_char,
  groups: *const c_char,
  clock_video: bool,
  clock_audio: bool,
}

#[repr(C)]
struct NdiVideoFrame {
  xres: i32,
  yres: i32,
  fourcc: i32,
  frame_rate_n: i32,
  frame_rate_d: i32,
  picture_aspect_ratio: f32,
  frame_format_type: i32,
  timecode: i64,
  data: *mut u8,
  line_stride_in_bytes: i32,
  metadata: *const c_char,
  timestamp: i64,
}

type InitializeFn = unsafe extern "C" fn() -> bool;
type SendCreateFn = unsafe extern "C" fn(*const NdiSendCreate) -> *mut c_void;
type SendDestroyFn = unsafe extern "C" fn(*mut c_void);
type SendVideoFn = unsafe extern "C" fn(*mut c_void, *const NdiVideoFrame);

struct NdiSender {
  _lib: Library,
  instance: *mut c_void,
  destroy_send: SendDestroyFn,
  send_video: SendVideoFn,
}

unsafe impl Send for NdiSender {}

impl Drop for NdiSender {
  fn drop(&mut self) {
    if !self.instance.is_null() {
      unsafe { (self.destroy_send)(self.instance) };
      self.instance = std::ptr::null_mut();
    }
    // NDIlib_destroy is process-wide. A receiver may still be using the runtime.
  }
}

impl NdiSender {
  fn open(name: &str) -> Result<Self, String> {
    let path = ndi_library_path()?;
    let lib = unsafe { Library::new(&path) }.map_err(|err| format!("NDI runtime could not load ({}): {err}", path.display()))?;
    let initialize: InitializeFn = load_sym(&lib, "NDIlib_initialize")?;
    let send_create: SendCreateFn = load_sym(&lib, "NDIlib_send_create")?;
    let destroy_send: SendDestroyFn = load_sym(&lib, "NDIlib_send_destroy")?;
    let send_video: SendVideoFn = load_sym(&lib, "NDIlib_send_send_video_v2")?;
    if !unsafe { initialize() } {
      return Err("NDI runtime did not initialize. Install the NDI Runtime.".into());
    }
    let c_name = CString::new(name).map_err(|_| "The sender name is not valid.".to_string())?;
    let create = NdiSendCreate {
      name: c_name.as_ptr(),
      groups: std::ptr::null(),
      clock_video: false,
      clock_audio: false,
    };
    let instance = unsafe { send_create(&create) };
    if instance.is_null() {
      return Err("NDI did not open a sender.".into());
    }
    Ok(Self {
      _lib: lib,
      instance,
      destroy_send,
      send_video,
    })
  }

  fn send(&mut self, pixels: &[u8], width: u32, height: u32) -> Result<(), String> {
    let frame = NdiVideoFrame {
      xres: width as i32,
      yres: height as i32,
      fourcc: rgba_fourcc(),
      frame_rate_n: 60000,
      frame_rate_d: 1001,
      picture_aspect_ratio: width as f32 / height as f32,
      frame_format_type: 1,
      timecode: i64::MAX,
      data: pixels.as_ptr() as *mut u8,
      line_stride_in_bytes: (width as i32).saturating_mul(4),
      metadata: std::ptr::null(),
      timestamp: 0,
    };
    unsafe { (self.send_video)(self.instance, &frame) };
    Ok(())
  }
}

fn rgba_fourcc() -> i32 {
  let r = b'R' as i32;
  let g = b'G' as i32;
  let b = b'B' as i32;
  let a = b'A' as i32;
  r | (g << 8) | (b << 16) | (a << 24)
}

fn load_sym<T: Copy>(lib: &Library, name: &str) -> Result<T, String> {
  let mut bytes = name.as_bytes().to_vec();
  bytes.push(0);
  unsafe { lib.get::<T>(&bytes) }
    .map(|sym| *sym)
    .map_err(|_| format!("NDI runtime is missing {name}."))
}

pub(crate) fn ndi_library_path() -> Result<std::path::PathBuf, String> {
  let mut candidates = Vec::new();
  for key in ["NDI_RUNTIME_DIR_V6", "NDI_RUNTIME_DIR_V5"] {
    if let Ok(dir) = std::env::var(key) {
      candidates.push(std::path::PathBuf::from(dir).join(ndi_file_name()));
    }
  }
  if let Ok(exe) = std::env::current_exe() {
    if let Some(folder) = exe.parent() {
      candidates.push(folder.join(ndi_file_name()));
    }
  }
  #[cfg(windows)]
  {
    candidates.push(std::path::PathBuf::from(r"C:\Program Files\NDI\NDI 6 Runtime\v6").join(ndi_file_name()));
    candidates.push(std::path::PathBuf::from(r"C:\Program Files\NDI\NDI 6 Runtime").join(ndi_file_name()));
    candidates.push(std::path::PathBuf::from(r"C:\Program Files\NDI\NDI 5 Runtime\v5").join(ndi_file_name()));
    candidates.push(std::path::PathBuf::from(r"C:\Program Files\NDI\NDI 6 Tools\Runtime\v6").join(ndi_file_name()));
    candidates.push(std::path::PathBuf::from(r"C:\Program Files\NDI\NDI 6 Tools\Runtime").join(ndi_file_name()));
  }
  #[cfg(target_os = "macos")]
  {
    candidates.push(std::path::PathBuf::from("/usr/local/lib").join(ndi_file_name()));
    candidates.push(std::path::PathBuf::from("/Library/NDI SDK for Apple/lib/macOS").join(ndi_file_name()));
    candidates.push(std::path::PathBuf::from("/Library/NDI").join(ndi_file_name()));
  }
  candidates
    .into_iter()
    .find(|path| path.is_file())
    .ok_or_else(|| "NDI runtime was not found. Install the NDI Runtime.".to_string())
}

fn ndi_file_name() -> &'static str {
  #[cfg(windows)]
  { "Processing.NDI.Lib.x64.dll" }
  #[cfg(target_os = "macos")]
  { "libndi.dylib" }
  #[cfg(not(any(windows, target_os = "macos")))]
  { "libndi.so" }
}
