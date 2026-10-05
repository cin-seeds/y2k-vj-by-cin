// CoreMIDI via midir. The Windows desk keeps using Web MIDI in the webview.
// This module only answers the midi_* commands; the Mac shell calls them.

use std::collections::HashMap;
use std::sync::{Mutex, Once, OnceLock};
use std::thread;
use std::time::Duration;

use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

struct MidiState {
  inputs: Vec<MidiInputConnection<()>>,
  outputs: HashMap<String, MidiOutputConnection>,
  input_names: Vec<String>,
  output_names: Vec<String>,
}

fn state() -> std::sync::MutexGuard<'static, MidiState> {
  static MIDI: OnceLock<Mutex<MidiState>> = OnceLock::new();
  MIDI
    .get_or_init(|| Mutex::new(MidiState {
      inputs: Vec::new(),
      outputs: HashMap::new(),
      input_names: Vec::new(),
      output_names: Vec::new(),
    }))
    .lock()
    .unwrap_or_else(|err| err.into_inner())
}

#[derive(Clone, Serialize)]
pub struct PortList {
  inputs: Vec<String>,
  outputs: Vec<String>,
}

#[derive(Clone, Serialize)]
struct MidiInEvent {
  port: String,
  bytes: Vec<u8>,
}

fn lock() -> std::sync::MutexGuard<'static, MidiState> {
  state()
}

fn input_names() -> Result<Vec<String>, String> {
  let midi = MidiInput::new("y2k-vj").map_err(|err| err.to_string())?;
  let mut names = Vec::new();
  for port in midi.ports() {
    if let Ok(name) = midi.port_name(&port) {
      names.push(name);
    }
  }
  Ok(names)
}

fn output_names() -> Result<Vec<String>, String> {
  let midi = MidiOutput::new("y2k-vj").map_err(|err| err.to_string())?;
  let mut names = Vec::new();
  for port in midi.ports() {
    if let Ok(name) = midi.port_name(&port) {
      names.push(name);
    }
  }
  Ok(names)
}

fn connect_inputs(app: &AppHandle) -> Result<(), String> {
  let mut state = lock();
  state.inputs.clear();
  let scout = MidiInput::new("y2k-vj").map_err(|err| err.to_string())?;
  let ports = scout.ports();
  drop(scout);
  let mut names = Vec::new();
  for port in ports {
    let mut midi = MidiInput::new("y2k-vj").map_err(|err| err.to_string())?;
    midi.ignore(Ignore::None);
    let Ok(name) = midi.port_name(&port) else { continue };
    let handle = app.clone();
    let port_name = name.clone();
    match midi.connect(
      &port,
      "y2k-vj",
      move |_stamp, message, _| {
        let _ = handle.emit("midi-in", MidiInEvent {
          port: port_name.clone(),
          bytes: message.to_vec(),
        });
      },
      (),
    ) {
      Ok(conn) => {
        names.push(name);
        state.inputs.push(conn);
      }
      Err(_) => {}
    }
  }
  state.input_names = names;
  Ok(())
}

fn refresh_outputs(known: &[String]) -> Result<(), String> {
  let mut state = lock();
  state.outputs.retain(|name, _| known.iter().any(|port| port == name));
  state.output_names = known.to_vec();
  Ok(())
}

fn ensure_poller(app: AppHandle) {
  static START: Once = Once::new();
  START.call_once(|| {
    thread::spawn(move || {
      let mut last_in = input_names().unwrap_or_default();
      let mut last_out = output_names().unwrap_or_default();
      loop {
        thread::sleep(Duration::from_secs(2));
        let inputs = match input_names() {
          Ok(names) => names,
          Err(_) => continue,
        };
        let outputs = match output_names() {
          Ok(names) => names,
          Err(_) => continue,
        };
        if inputs == last_in && outputs == last_out {
          continue;
        }
        last_in = inputs.clone();
        last_out = outputs.clone();
        let _ = connect_inputs(&app);
        let _ = refresh_outputs(&outputs);
        let _ = app.emit("midi-ports", PortList { inputs, outputs });
      }
    });
  });
}

#[tauri::command(async)]
pub fn midi_list() -> Result<PortList, String> {
  Ok(PortList {
    inputs: input_names()?,
    outputs: output_names()?,
  })
}

#[tauri::command(async)]
pub fn midi_open(app: AppHandle) -> Result<(), String> {
  let outputs = output_names()?;
  connect_inputs(&app)?;
  refresh_outputs(&outputs)?;
  ensure_poller(app);
  Ok(())
}

#[tauri::command(async)]
pub fn midi_send(port: String, bytes: Vec<u8>) -> Result<(), String> {
  let mut state = lock();
  if !state.outputs.contains_key(&port) {
    let midi = MidiOutput::new("y2k-vj").map_err(|err| err.to_string())?;
    let ports = midi.ports();
    let Some(found) = ports.iter().find(|candidate| midi.port_name(candidate).ok().as_deref() == Some(port.as_str())) else {
      return Err(format!("MIDI output \"{port}\" is not connected."));
    };
    let conn = midi.connect(found, "y2k-vj").map_err(|err| err.to_string())?;
    state.outputs.insert(port.clone(), conn);
  }
  let conn = state.outputs.get_mut(&port).ok_or_else(|| format!("MIDI output \"{port}\" is not connected."))?;
  if let Err(err) = conn.send(&bytes) {
    state.outputs.remove(&port);
    return Err(err.to_string());
  }
  Ok(())
}
