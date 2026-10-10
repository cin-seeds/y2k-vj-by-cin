// Desktop MIDI via midir (Windows, macOS, Linux). Shaped like Web MIDI's
// MIDIAccess so MidiManager can attach the same way it does in a browser.
// Primary path in the Tauri app; Web MIDI is browser-only.

import { IS_TAURI, invoke } from '../ipc.js';

let opening = null;

function asList(value) {
  return Array.isArray(value) ? value : [];
}

export function requestNativeMidiAccess() {
  if (!IS_TAURI) {
    console.warn('midi_open needs the desktop app.');
    return Promise.resolve({
      inputs: new Map(),
      outputs: new Map(),
      sysexEnabled: false,
      onstatechange: null,
    });
  }
  if (!opening) {
    opening = openNative().catch((err) => {
      opening = null;
      throw err;
    });
  }
  // A second Enable MIDI click re-lists ports in case the first scan was empty.
  return opening.then(async (access) => {
    try {
      const ports = await invoke('midi_list');
      access.applyPorts?.(ports, false);
      await invoke('midi_open');
    } catch { /* keep the access from the first open */ }
    return access;
  });
}

async function openNative() {
  const { listen } = await import('@tauri-apps/api/event');
  const inputs = new Map();
  const outputs = new Map();
  const access = {
    inputs,
    outputs,
    sysexEnabled: false,
    onstatechange: null,
  };

  const applyPorts = (payload, notify) => {
    const nextIn = asList(payload?.inputs);
    const nextOut = asList(payload?.outputs);
    for (const name of [...inputs.keys()]) {
      if (!nextIn.includes(name)) inputs.delete(name);
    }
    for (const name of nextIn) {
      if (inputs.has(name)) continue;
      inputs.set(name, { id: name, name, onmidimessage: null });
    }
    for (const name of [...outputs.keys()]) {
      if (!nextOut.includes(name)) outputs.delete(name);
    }
    for (const name of nextOut) {
      if (outputs.has(name)) continue;
      outputs.set(name, {
        id: name,
        name,
        send(bytes) {
          const data = bytes instanceof Uint8Array ? Array.from(bytes) : [...bytes];
          return invoke('midi_send', { port: name, bytes: data }).catch(() => {});
        },
      });
    }
    if (notify && typeof access.onstatechange === 'function') access.onstatechange();
  };
  access.applyPorts = applyPorts;

  await listen('midi-in', (event) => {
    const port = event.payload?.port;
    const input = inputs.get(port);
    if (!input || typeof input.onmidimessage !== 'function') return;
    const bytes = event.payload?.bytes;
    input.onmidimessage({ data: new Uint8Array(Array.isArray(bytes) ? bytes : []), port });
  });
  await listen('midi-ports', (event) => applyPorts(event.payload, true));

  applyPorts(await invoke('midi_list'), false);
  await invoke('midi_open');
  return access;
}
