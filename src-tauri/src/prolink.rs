// Pioneer Pro DJ Link beats. Type 0x28 is broadcast on UDP 50001.
// Port 50002 carries status packets, not this beat packet.
// Byte 0x21 is the player number (1–4). The mixer uses a different number.

use std::net::UdpSocket;
use std::sync::Once;
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const MAGIC: &[u8] = b"Qspt1WmJOL";
const BEAT_PORT: u16 = 50001;

#[derive(Clone, Serialize)]
struct ProLinkEvent {
  deck: u8,
  is_beat: bool,
}

/// Open the beat port once. A second call does not start another listener.
#[tauri::command]
pub fn start_pro_dj_link(app: AppHandle) {
  static START: Once = Once::new();
  START.call_once(|| {
    thread::spawn(move || listen(app));
  });
}

fn listen(app: AppHandle) {
  let socket = match UdpSocket::bind(("0.0.0.0", BEAT_PORT)) {
    Ok(socket) => socket,
    Err(err) => {
      log::warn!("Pro DJ Link beat port {BEAT_PORT} did not open: {err}");
      return;
    }
  };
  let mut buf = [0u8; 1024];
  loop {
    let Ok((size, _)) = socket.recv_from(&mut buf) else { continue };
    if size <= 0x24 || size < MAGIC.len() {
      continue;
    }
    if &buf[..MAGIC.len()] != MAGIC || buf[0x0a] != 0x28 {
      continue;
    }
    let deck = buf[0x21];
    if !(1..=4).contains(&deck) {
      continue;
    }
    let _ = app.emit("prolink-beat", ProLinkEvent {
      deck,
      is_beat: true,
    });
  }
}
