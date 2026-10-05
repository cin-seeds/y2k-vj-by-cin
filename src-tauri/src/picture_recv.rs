// Picture input. Windows receives Spout and NDI. macOS receives Syphon and NDI.
// Each source keeps only its latest frame. The desk copies that into the layer
// texture; nothing here allocates a render target.

use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;

use libloading::Library;
use serde::Serialize;

use crate::picture_send::ndi_library_path;

const MAX_EDGE: u32 = 3840;
const HEADER: usize = 17;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
  Ndi,
  Local,
}

#[derive(Serialize)]
pub struct SourceList {
  ndi: Vec<String>,
  spout: Vec<String>,
  local: String,
}

#[derive(Serialize)]
pub struct WatchReport {
  ok: bool,
  reason: String,
}

enum Pull {
  Frame { width: u32, height: u32, pixels: Vec<u8> },
  Same,
  Gone,
  Fault(String),
}

enum Msg {
  Sources { reply: Sender<SourceList> },
  Watch { source: String, reply: Sender<WatchReport> },
  Frame { source: String, seen: u64, reply: Sender<Vec<u8>> },
  Unwatch { source: String },
}

fn worker() -> Sender<Msg> {
  static TX: OnceLock<Sender<Msg>> = OnceLock::new();
  TX.get_or_init(|| {
    let (tx, rx) = mpsc::channel::<Msg>();
    std::thread::Builder::new()
      .name("picture-recv".into())
      .spawn(move || {
        let mut hub = Hub::default();
        while let Ok(msg) = rx.recv() {
          match msg {
            Msg::Sources { reply } => {
              let _ = reply.send(hub.sources());
            }
            Msg::Watch { source, reply } => {
              let _ = reply.send(hub.watch(&source));
            }
            Msg::Frame { source, seen, reply } => {
              let _ = reply.send(hub.frame(&source, seen));
            }
            Msg::Unwatch { source } => hub.unwatch(&source),
          }
        }
      })
      .expect("picture receiver thread");
    tx
  })
  .clone()
}

async fn ask<T: Send + 'static>(msg: impl FnOnce(Sender<T>) -> Msg) -> Result<T, String> {
  let (reply, rx) = mpsc::channel();
  worker()
    .send(msg(reply))
    .map_err(|_| "The picture receiver stopped.".to_string())?;
  tokio::task::spawn_blocking(move || rx.recv().map_err(|_| "The picture receiver stopped.".to_string()))
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn picture_recv_sources() -> Result<SourceList, String> {
  ask(|reply| Msg::Sources { reply }).await
}

#[tauri::command]
pub async fn picture_recv_watch(source: String) -> Result<WatchReport, String> {
  ask(|reply| Msg::Watch { source, reply }).await
}

#[tauri::command]
pub async fn picture_recv_frame(source: String, seen: u64) -> Result<tauri::ipc::Response, String> {
  let bytes = ask(|reply| Msg::Frame { source, seen, reply }).await?;
  Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn picture_recv_unwatch(source: String) -> Result<(), String> {
  worker()
    .send(Msg::Unwatch { source })
    .map_err(|_| "The picture receiver stopped.".to_string())
}

struct Hub {
  slots: HashMap<String, Slot>,
  ndi: Option<NdiRuntime>,
  ndi_error: Option<String>,
}

impl Default for Hub {
  fn default() -> Self {
    Self {
      slots: HashMap::new(),
      ndi: None,
      ndi_error: None,
    }
  }
}

impl Hub {
  fn sources(&mut self) -> SourceList {
    SourceList {
      ndi: self.ndi_names(),
      spout: local_names(),
      local: local_label().into(),
    }
  }

  fn watch(&mut self, source: &str) -> WatchReport {
    let (kind, name) = match parse_source(source) {
      Ok(parsed) => parsed,
      Err(reason) => return WatchReport { ok: false, reason },
    };
    if let Some(slot) = self.slots.get_mut(source) {
      slot.users = slot.users.saturating_add(1);
      return WatchReport { ok: true, reason: String::new() };
    }
    match Slot::open(kind, name, self) {
      Ok(slot) => {
        self.slots.insert(source.to_string(), slot);
        WatchReport { ok: true, reason: String::new() }
      }
      Err(reason) => WatchReport { ok: false, reason },
    }
  }

  fn unwatch(&mut self, source: &str) {
    let empty = match self.slots.get_mut(source) {
      Some(slot) => {
        slot.users = slot.users.saturating_sub(1);
        slot.users == 0
      }
      None => false,
    };
    if empty {
      self.slots.remove(source);
    }
  }

  fn frame(&mut self, source: &str, seen: u64) -> Vec<u8> {
    let Some(slot) = self.slots.get_mut(source) else {
      return pack(FLAG_GONE, 0, 0, 0, b"");
    };
    if let Pull::Fault(reason) = slot.pull() {
      return pack(FLAG_FAULT, slot.generation, 0, 0, reason.as_bytes());
    }
    if slot.gone {
      return pack(FLAG_GONE, slot.generation, slot.width, slot.height, b"");
    }
    if slot.pixels.is_empty() || slot.generation == 0 || slot.generation == seen {
      return pack(FLAG_SAME, slot.generation, slot.width, slot.height, b"");
    }
    pack(0, slot.generation, slot.width, slot.height, &slot.pixels)
  }

  fn ndi_names(&mut self) -> Vec<String> {
    match self.ndi_runtime() {
      Ok(runtime) => runtime.names(),
      Err(reason) => {
        self.ndi_error = Some(reason);
        Vec::new()
      }
    }
  }

  fn ndi_runtime(&mut self) -> Result<&mut NdiRuntime, String> {
    if self.ndi.is_none() && self.ndi_error.is_none() {
      match NdiRuntime::open() {
        Ok(runtime) => self.ndi = Some(runtime),
        Err(reason) => self.ndi_error = Some(reason),
      }
    }
    self.ndi.as_mut().ok_or_else(|| {
      self.ndi_error.clone().unwrap_or_else(|| "NDI runtime was not found. Install the NDI Runtime.".into())
    })
  }
}

struct Slot {
  users: usize,
  generation: u64,
  width: u32,
  height: u32,
  pixels: Vec<u8>,
  gone: bool,
  saw: bool,
  feed: Feed,
}

enum Feed {
  Ndi(NdiRecv),
  #[cfg(windows)]
  Spout(SpoutHold),
  #[cfg(target_os = "macos")]
  Syphon(SyphonHold),
}

impl Slot {
  fn open(kind: Kind, name: String, hub: &mut Hub) -> Result<Self, String> {
    let feed = match kind {
      Kind::Ndi => {
        let runtime = hub.ndi_runtime()?;
        Feed::Ndi(runtime.recv(&name)?)
      }
      Kind::Local => open_local(name)?,
    };
    Ok(Self {
      users: 1,
      generation: 0,
      width: 0,
      height: 0,
      pixels: Vec::new(),
      gone: false,
      saw: false,
      feed,
    })
  }

  fn pull(&mut self) -> Pull {
    let pulled = match &mut self.feed {
      Feed::Ndi(recv) => recv.pull(),
      #[cfg(windows)]
      Feed::Spout(recv) => recv.pull(),
      #[cfg(target_os = "macos")]
      Feed::Syphon(recv) => recv.pull(),
    };
    match pulled {
      Pull::Frame { width, height, pixels } => {
        self.gone = false;
        self.saw = true;
        self.width = width;
        self.height = height;
        self.generation = self.generation.wrapping_add(1).max(1);
        self.pixels = pixels;
        Pull::Same
      }
      Pull::Gone => {
        self.gone = self.saw;
        Pull::Same
      }
      other => other,
    }
  }
}

fn open_local(name: String) -> Result<Feed, String> {
  #[cfg(windows)]
  {
    return Ok(Feed::Spout(SpoutHold::open(name)));
  }
  #[cfg(target_os = "macos")]
  {
    return Ok(Feed::Syphon(SyphonHold::open(name)));
  }
  #[cfg(not(any(windows, target_os = "macos")))]
  {
    let _ = name;
    Err("This desktop does not receive Spout or Syphon.".into())
  }
}

fn local_names() -> Vec<String> {
  #[cfg(windows)]
  {
    spout_rs::Directory::senders()
      .into_iter()
      .filter(|name| !name.is_empty())
      .collect()
  }
  #[cfg(target_os = "macos")]
  {
    syphon_rs::Directory::shared()
      .servers()
      .into_iter()
      .map(|server| server.name)
      .filter(|name| !name.is_empty())
      .collect()
  }
  #[cfg(not(any(windows, target_os = "macos")))]
  {
    Vec::new()
  }
}

fn local_label() -> &'static str {
  #[cfg(target_os = "macos")]
  { "Syphon" }
  #[cfg(not(target_os = "macos"))]
  { "Spout" }
}

fn parse_source(source: &str) -> Result<(Kind, String), String> {
  let (prefix, name) = source.split_once(':').ok_or("That picture source is not valid.")?;
  let name = name.trim();
  if name.is_empty() || name.len() > 200 {
    return Err("That picture source is not valid.".into());
  }
  let kind = match prefix {
    "ndi" => Kind::Ndi,
    "spout" => Kind::Local,
    _ => return Err("That picture source is not valid.".into()),
  };
  Ok((kind, name.to_string()))
}

const FLAG_GONE: u8 = 1;
const FLAG_SAME: u8 = 2;
const FLAG_FAULT: u8 = 4;

fn pack(flags: u8, generation: u64, width: u32, height: u32, extra: &[u8]) -> Vec<u8> {
  let mut out = Vec::with_capacity(HEADER + extra.len());
  out.push(flags);
  out.extend_from_slice(&generation.to_le_bytes());
  out.extend_from_slice(&width.to_le_bytes());
  out.extend_from_slice(&height.to_le_bytes());
  out.extend_from_slice(extra);
  out
}

#[cfg(windows)]
struct SpoutHold {
  receiver: spout_rs::SpoutReceiver,
  tex: u32,
  width: u32,
  height: u32,
  saw: bool,
}

#[cfg(windows)]
impl Drop for SpoutHold {
  fn drop(&mut self) {
    if self.tex != 0 {
      unsafe { glDeleteTextures(1, &self.tex) };
      self.tex = 0;
    }
  }
}

#[cfg(windows)]
impl SpoutHold {
  fn open(name: String) -> Self {
    Self {
      receiver: spout_rs::SpoutReceiver::new(Some(&name)),
      tex: 0,
      width: 0,
      height: 0,
      saw: false,
    }
  }

  fn pull(&mut self) -> Pull {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.pull_inner()));
    match result {
      Ok(pulled) => pulled,
      Err(_) => Pull::Fault("Spout could not receive the frame.".into()),
    }
  }

  fn pull_inner(&mut self) -> Pull {
    const GL_TEXTURE_2D: u32 = 0x0DE1;
    if self.saw && self.receiver.is_connected() && !self.receiver.is_frame_new() {
      return Pull::Same;
    }
    let target = if self.tex == 0 { 0 } else { self.tex };
    let ok = self.receiver.receive_texture(target, GL_TEXTURE_2D, false);
    if !ok || !self.receiver.is_connected() {
      return if self.saw { Pull::Gone } else { Pull::Same };
    }
    let (width, height) = self.receiver.sender_size();
    if width < 2 || height < 2 || width > MAX_EDGE || height > MAX_EDGE {
      return Pull::Fault("That send size is not supported.".into());
    }
    if self.tex == 0 || self.width != width || self.height != height {
      if !self.alloc(width, height) {
        return Pull::Fault("Spout could not receive the frame.".into());
      }
      if !self.receiver.receive_texture(self.tex, GL_TEXTURE_2D, false) {
        return if self.saw { Pull::Gone } else { Pull::Same };
      }
    }
    match self.read(width, height) {
      Some(pixels) => {
        self.saw = true;
        Pull::Frame { width, height, pixels }
      }
      None => Pull::Fault("Spout could not receive the frame.".into()),
    }
  }

  fn alloc(&mut self, width: u32, height: u32) -> bool {
    const GL_TEXTURE_2D: u32 = 0x0DE1;
    const GL_RGBA: u32 = 0x1908;
    const GL_UNSIGNED_BYTE: u32 = 0x1401;
    const GL_TEXTURE_MIN_FILTER: u32 = 0x2801;
    const GL_TEXTURE_MAG_FILTER: u32 = 0x2800;
    const GL_LINEAR: i32 = 0x2601;
    unsafe {
      if self.tex == 0 {
        glGenTextures(1, &mut self.tex);
      }
      if self.tex == 0 {
        return false;
      }
      glBindTexture(GL_TEXTURE_2D, self.tex);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
      glTexImage2D(
        GL_TEXTURE_2D,
        0,
        GL_RGBA as i32,
        width as i32,
        height as i32,
        0,
        GL_RGBA,
        GL_UNSIGNED_BYTE,
        std::ptr::null(),
      );
    }
    self.width = width;
    self.height = height;
    true
  }

  fn read(&self, width: u32, height: u32) -> Option<Vec<u8>> {
    const GL_TEXTURE_2D: u32 = 0x0DE1;
    const GL_RGBA: u32 = 0x1908;
    const GL_UNSIGNED_BYTE: u32 = 0x1401;
    const GL_PACK_ALIGNMENT: u32 = 0x0D05;
    let len = (width as usize).checked_mul(height as usize)?.checked_mul(4)?;
    let mut pixels = vec![0u8; len];
    unsafe {
      glPixelStorei(GL_PACK_ALIGNMENT, 1);
      glBindTexture(GL_TEXTURE_2D, self.tex);
      glGetTexImage(GL_TEXTURE_2D, 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels.as_mut_ptr().cast());
    }
    flip_rows(&mut pixels, width, height);
    Some(pixels)
  }
}

#[cfg(windows)]
#[link(name = "opengl32")]
unsafe extern "system" {
  fn glGenTextures(n: i32, textures: *mut u32);
  fn glDeleteTextures(n: i32, textures: *const u32);
  fn glBindTexture(target: u32, texture: u32);
  fn glTexParameteri(target: u32, pname: u32, param: i32);
  fn glTexImage2D(
    target: u32,
    level: i32,
    internal: i32,
    width: i32,
    height: i32,
    border: i32,
    format: u32,
    kind: u32,
    pixels: *const c_void,
  );
  fn glGetTexImage(target: u32, level: i32, format: u32, kind: u32, pixels: *mut c_void);
  fn glPixelStorei(pname: u32, param: i32);
}

fn flip_rows(pixels: &mut [u8], width: u32, height: u32) {
  let stride = (width as usize).saturating_mul(4);
  let rows = height as usize;
  if stride == 0 || pixels.len() < stride.saturating_mul(rows) {
    return;
  }
  let mut scratch = vec![0u8; stride];
  for y in 0..rows / 2 {
    let top = y * stride;
    let bot = (rows - 1 - y) * stride;
    scratch.copy_from_slice(&pixels[top..top + stride]);
    pixels.copy_within(bot..bot + stride, top);
    pixels[bot..bot + stride].copy_from_slice(&scratch);
  }
}

#[cfg(target_os = "macos")]
struct SyphonHold {
  name: String,
  client: Option<syphon_rs::Client>,
  fresh: std::sync::Arc<std::sync::atomic::AtomicBool>,
  saw: bool,
}

#[cfg(target_os = "macos")]
impl SyphonHold {
  fn open(name: String) -> Self {
    Self {
      name,
      client: None,
      fresh: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
      saw: false,
    }
  }

  fn pull(&mut self) -> Pull {
    use std::sync::atomic::Ordering;
    let description = syphon_rs::Directory::shared()
      .servers()
      .into_iter()
      .find(|server| server.name == self.name);
    let Some(description) = description else {
      self.client = None;
      return if self.saw { Pull::Gone } else { Pull::Same };
    };
    if self.client.is_none() {
      let flag = self.fresh.clone();
      match syphon_rs::Client::new(&description, move || {
        flag.store(true, Ordering::Release);
      }) {
        Ok(client) => self.client = Some(client),
        Err(err) => return Pull::Fault(err.to_string()),
      }
    }
    let ready = self.fresh.swap(false, Ordering::Acquire);
    if !ready && self.saw {
      return Pull::Same;
    }
    let Some(client) = self.client.as_ref() else {
      return Pull::Same;
    };
    let Some(frame) = client.new_frame() else {
      return if self.saw { Pull::Same } else { Pull::Same };
    };
    let width = frame.width();
    let height = frame.height();
    if width < 2 || height < 2 || width > MAX_EDGE || height > MAX_EDGE {
      return Pull::Fault("That send size is not supported.".into());
    }
    let pixels = frame.read_rgba_pixels();
    if pixels.len() != (width as usize) * (height as usize) * 4 {
      return Pull::Fault("Syphon did not accept the frame.".into());
    }
    self.saw = true;
    Pull::Frame { width, height, pixels }
  }
}

struct NdiRuntime {
  _lib: Library,
  find: *mut c_void,
  destroy_find: FindDestroyFn,
  wait: FindWaitFn,
  current: FindCurrentFn,
  recv_create: RecvCreateFn,
  recv_destroy: RecvDestroyFn,
  capture: CaptureFn,
  free_video: FreeVideoFn,
  connections: ConnectionsFn,
}

unsafe impl Send for NdiRuntime {}

impl Drop for NdiRuntime {
  fn drop(&mut self) {
    if !self.find.is_null() {
      unsafe { (self.destroy_find)(self.find) };
      self.find = std::ptr::null_mut();
    }
  }
}

impl NdiRuntime {
  fn open() -> Result<Self, String> {
    let path = ndi_library_path()?;
    let lib = unsafe { Library::new(&path) }.map_err(|err| format!("NDI runtime could not load ({}): {err}", path.display()))?;
    let initialize: InitializeFn = load_sym(&lib, "NDIlib_initialize")?;
    let find_create: FindCreateFn = load_sym(&lib, "NDIlib_find_create_v2")?;
    let destroy_find: FindDestroyFn = load_sym(&lib, "NDIlib_find_destroy")?;
    let wait: FindWaitFn = load_sym(&lib, "NDIlib_find_wait_for_sources")?;
    let current: FindCurrentFn = load_sym(&lib, "NDIlib_find_get_current_sources")?;
    let recv_create: RecvCreateFn = load_sym(&lib, "NDIlib_recv_create_v3")?;
    let recv_destroy: RecvDestroyFn = load_sym(&lib, "NDIlib_recv_destroy")?;
    let capture: CaptureFn = load_sym(&lib, "NDIlib_recv_capture_v2")?;
    let free_video: FreeVideoFn = load_sym(&lib, "NDIlib_recv_free_video_v2")?;
    let connections: ConnectionsFn = load_sym(&lib, "NDIlib_recv_get_no_connections")?;
    if !unsafe { initialize() } {
      return Err("NDI runtime did not initialize. Install the NDI Runtime.".into());
    }
    let create = NdiFindCreate {
      show_local_sources: true,
      groups: std::ptr::null(),
      extra_ips: std::ptr::null(),
    };
    let find = unsafe { find_create(&create) };
    if find.is_null() {
      return Err("NDI did not open a finder.".into());
    }
    unsafe { wait(find, 120) };
    Ok(Self {
      _lib: lib,
      find,
      destroy_find,
      wait,
      current,
      recv_create,
      recv_destroy,
      capture,
      free_video,
      connections,
    })
  }

  fn names(&mut self) -> Vec<String> {
    unsafe { (self.wait)(self.find, 0) };
    let mut count = 0u32;
    let list = unsafe { (self.current)(self.find, &mut count) };
    if list.is_null() || count == 0 {
      return Vec::new();
    }
    let sources = unsafe { std::slice::from_raw_parts(list, count as usize) };
    sources
      .iter()
      .filter_map(|source| c_string(source.name))
      .filter(|name| !name.is_empty())
      .collect()
  }

  fn recv(&self, name: &str) -> Result<NdiRecv, String> {
    let c_name = CString::new(name).map_err(|_| "The sender name is not valid.".to_string())?;
    let create = NdiRecvCreate {
      source_name: c_name.as_ptr(),
      source_url: std::ptr::null(),
      color_format: 2,
      bandwidth: 100,
      allow_video_fields: false,
      recv_name: std::ptr::null(),
    };
    let instance = unsafe { (self.recv_create)(&create) };
    if instance.is_null() {
      return Err("NDI did not open a receiver.".into());
    }
    Ok(NdiRecv {
      instance,
      destroy: self.recv_destroy,
      capture: self.capture,
      free_video: self.free_video,
      connections: self.connections,
      saw: false,
    })
  }
}

struct NdiRecv {
  instance: *mut c_void,
  destroy: RecvDestroyFn,
  capture: CaptureFn,
  free_video: FreeVideoFn,
  connections: ConnectionsFn,
  saw: bool,
}

unsafe impl Send for NdiRecv {}

impl Drop for NdiRecv {
  fn drop(&mut self) {
    if !self.instance.is_null() {
      unsafe { (self.destroy)(self.instance) };
      self.instance = std::ptr::null_mut();
    }
  }
}

impl NdiRecv {
  fn pull(&mut self) -> Pull {
    let mut latest = None;
    for _ in 0..8 {
      match self.capture_one() {
        Pull::Frame { width, height, pixels } => latest = Some((width, height, pixels)),
        Pull::Gone => return if self.saw { Pull::Gone } else { Pull::Same },
        Pull::Fault(reason) => return Pull::Fault(reason),
        Pull::Same => break,
      }
    }
    if let Some((width, height, pixels)) = latest {
      self.saw = true;
      return Pull::Frame { width, height, pixels };
    }
    if self.saw && unsafe { (self.connections)(self.instance) } == 0 {
      return Pull::Gone;
    }
    Pull::Same
  }

  fn capture_one(&mut self) -> Pull {
    let mut frame = NdiVideoFrame::zero();
    let kind = unsafe { (self.capture)(self.instance, &mut frame, std::ptr::null_mut(), std::ptr::null_mut(), 0) };
    if kind == 1 {
      let copied = copy_ndi(&frame);
      unsafe { (self.free_video)(self.instance, &frame) };
      return match copied {
        Ok(pixels) => Pull::Frame { width: frame.xres as u32, height: frame.yres as u32, pixels },
        Err(reason) => Pull::Fault(reason),
      };
    }
    if kind == 4 {
      return Pull::Gone;
    }
    Pull::Same
  }
}

fn copy_ndi(frame: &NdiVideoFrame) -> Result<Vec<u8>, String> {
  let width = frame.xres;
  let height = frame.yres;
  if width < 2 || height < 2 || width > MAX_EDGE as i32 || height > MAX_EDGE as i32 || frame.data.is_null() {
    return Err("That send size is not supported.".into());
  }
  let stride = frame.line_stride_in_bytes;
  let row_bytes = (width as usize).saturating_mul(4);
  let abs_stride = stride.unsigned_abs() as usize;
  if abs_stride < row_bytes {
    return Err("NDI did not accept the frame.".into());
  }
  let rgba = rgba_fourcc();
  let rgbx = rgbx_fourcc();
  let bgra = bgra_fourcc();
  if frame.fourcc != rgba && frame.fourcc != rgbx && frame.fourcc != bgra {
    return Err("NDI did not accept the frame.".into());
  }
  let mut out = vec![0u8; row_bytes * height as usize];
  for y in 0..height as usize {
    let src_y = if stride >= 0 { y } else { height as usize - 1 - y };
    let src = unsafe { frame.data.add(src_y * abs_stride) };
    let row = unsafe { std::slice::from_raw_parts(src, row_bytes) };
    let dst = &mut out[y * row_bytes..(y + 1) * row_bytes];
    if frame.fourcc == bgra {
      for (pixel, sample) in dst.chunks_exact_mut(4).zip(row.chunks_exact(4)) {
        pixel[0] = sample[2];
        pixel[1] = sample[1];
        pixel[2] = sample[0];
        pixel[3] = sample[3];
      }
    } else {
      dst.copy_from_slice(row);
      if frame.fourcc == rgbx {
        for pixel in dst.chunks_exact_mut(4) {
          pixel[3] = 255;
        }
      }
    }
  }
  Ok(out)
}

fn rgba_fourcc() -> i32 {
  let r = b'R' as i32;
  let g = b'G' as i32;
  let b = b'B' as i32;
  let a = b'A' as i32;
  r | (g << 8) | (b << 16) | (a << 24)
}

fn rgbx_fourcc() -> i32 {
  let r = b'R' as i32;
  let g = b'G' as i32;
  let b = b'B' as i32;
  let x = b'X' as i32;
  r | (g << 8) | (b << 16) | (x << 24)
}

fn bgra_fourcc() -> i32 {
  let b = b'B' as i32;
  let g = b'G' as i32;
  let r = b'R' as i32;
  let a = b'A' as i32;
  b | (g << 8) | (r << 16) | (a << 24)
}

fn c_string(ptr: *const c_char) -> Option<String> {
  if ptr.is_null() {
    return None;
  }
  Some(unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned())
}

fn load_sym<T: Copy>(lib: &Library, name: &str) -> Result<T, String> {
  let mut bytes = name.as_bytes().to_vec();
  bytes.push(0);
  unsafe { lib.get::<T>(&bytes) }
    .map(|sym| *sym)
    .map_err(|_| format!("NDI runtime is missing {name}."))
}

#[repr(C)]
struct NdiFindCreate {
  show_local_sources: bool,
  groups: *const c_char,
  extra_ips: *const c_char,
}

#[repr(C)]
struct NdiSource {
  name: *const c_char,
  url: *const c_char,
}

#[repr(C)]
struct NdiRecvCreate {
  source_name: *const c_char,
  source_url: *const c_char,
  color_format: i32,
  bandwidth: i32,
  allow_video_fields: bool,
  recv_name: *const c_char,
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

impl NdiVideoFrame {
  fn zero() -> Self {
    Self {
      xres: 0,
      yres: 0,
      fourcc: 0,
      frame_rate_n: 0,
      frame_rate_d: 0,
      picture_aspect_ratio: 0.0,
      frame_format_type: 0,
      timecode: 0,
      data: std::ptr::null_mut(),
      line_stride_in_bytes: 0,
      metadata: std::ptr::null(),
      timestamp: 0,
    }
  }
}

type InitializeFn = unsafe extern "C" fn() -> bool;
type FindCreateFn = unsafe extern "C" fn(*const NdiFindCreate) -> *mut c_void;
type FindDestroyFn = unsafe extern "C" fn(*mut c_void);
type FindWaitFn = unsafe extern "C" fn(*mut c_void, u32) -> bool;
type FindCurrentFn = unsafe extern "C" fn(*mut c_void, *mut u32) -> *const NdiSource;
type RecvCreateFn = unsafe extern "C" fn(*const NdiRecvCreate) -> *mut c_void;
type RecvDestroyFn = unsafe extern "C" fn(*mut c_void);
type CaptureFn = unsafe extern "C" fn(*mut c_void, *mut NdiVideoFrame, *mut c_void, *mut c_void, u32) -> i32;
type FreeVideoFn = unsafe extern "C" fn(*mut c_void, *const NdiVideoFrame);
type ConnectionsFn = unsafe extern "C" fn(*mut c_void) -> i32;
