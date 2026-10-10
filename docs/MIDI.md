# Y2K VJ by Cín: MIDI guide

The Akai APC Mini MK2 works without any setup. Every other controller uses MIDI Learn.

![APC Mini MK2 and the on-screen APC view](img/apc-mini-mk2.png)

## Connect the APC Mini MK2

1. Plug in the APC Mini MK2 with USB.
2. Click **Perform** in the top bar.
3. Pick **APC Mini mk2** in the hardware menu.
4. Click **Enable MIDI**. MIDI only opens from that click (not on page load). The app remembers this for next time.

The desktop app uses native MIDI (midir). macOS may not show a system permission dialog — clicking **Enable MIDI** is still required. In a browser, MIDI uses Web MIDI (Chrome or Edge).

The app finds the APC by its port name, which must contain "APC" or "Akai". It listens on MIDI channel 1.

The APC works in every workspace. The on-screen APC view only shows in **Perform**.

**Windows: only one app can use the APC at a time.** Close Ableton, Resolume, or any other app that has the APC open, then click **Enable MIDI** again.

Tick **Show MIDI labels** to see small tags (F1, TRK1, SCN7 …) next to each mapped control on the desk.

---

## The grid (notes 0 to 63)

The grid is 8 × 8. The bottom row, next to the faders, is notes 0 to 7. The top row is notes 56 to 63.

| Row | Notes |
| --- | --- |
| Top (row 8) | 56 57 58 59 60 61 62 63 |
| Row 7 | 48 49 50 51 52 53 54 55 |
| Row 6 | 40 41 42 43 44 45 46 47 |
| Row 5 | 32 33 34 35 36 37 38 39 |
| Row 4 | 24 25 26 27 28 29 30 31 |
| Row 3 | 16 17 18 19 20 21 22 23 |
| Row 2 | 8 9 10 11 12 13 14 15 |
| Bottom (row 1) | 0 1 2 3 4 5 6 7 |

The grid has three pages. Pick a page with **SCN1**, **SCN2** or **SCN3**.

### Page 1: Scenes (SCN1)

Each pad is one scene. One APC bank holds 64 scenes.

- The top-left pad of bank 1 is scene 57, and the bottom-left pad is scene 1. The scene number is bank × 64 + note + 1, counting banks from 0.
- Press a pad to launch its scene.
- In Cue mode, the first press arms the scene on Preview. Press the pad again, or **GO**, to launch it.
- **Bank Up** and **Bank Down** move through up to 256 banks.

| LED | Meaning |
| --- | --- |
| Amber | A scene is saved here |
| Green, pulsing | The scene that is playing |
| Amber, blinking | The scene that is cued |
| Off | Empty |

The APC banks hold 64 scenes. The scene pads on screen show banks of 8.

### Page 2: Clips (SCN2)

Each pad is one clip from the Media Library, in library order. Press a pad to load that clip on the followed layer.

| LED | Meaning |
| --- | --- |
| Green | This clip is on the layer |
| Amber | Clip available |
| Off | Empty |

The followed layer is the layer selected on the desk (Q, W, E) while **Follow** is on.

### Page 3: Looks & FX (SCN3)

| Row | Notes | Pads do |
| --- | --- | --- |
| Top (row 8) | 56–63 | Layer A, looks 1–8 |
| Row 7 | 48–55 | Layer B, looks 1–8 |
| Row 6 | 40–47 | Layer C, looks 1–8 |
| Row 5 | 32–39 | Layer A, looks 9–16 |
| Row 4 | 24–31 | Layer B, looks 9–16 |
| Row 3 | 16–23 | Layer C, looks 9–16 |
| Row 2 | 8–15 | Mute an effect group on the selected layer |
| Bottom (row 1) | 0–7 | Shuffle an effect group on the selected layer |

There are 16 looks, so the last pad of each "looks 9–16" row is Black Metallic Y2K.

| Pad | Look |
| --- | --- |
| 1 | Glitch |
| 2 | Pixel Art / Dither |
| 3 | Y2K / 2000s |
| 4 | VHS |
| 5 | 3D Point Cloud |
| 6 | 3D Spatial Mesh |
| 7 | 90s Retro Gaming |
| 8 | Clean (no FX) |
| 9 | Windows 98 Crash |
| 10 | PS1 / N64 CRT |
| 11 | ASCII / Pointillism |
| 12 | Signal Eater |
| 13 | MiniDV |
| 14 | Flash MX |
| 15 | Starfield |
| 16 | Black Metallic Y2K |

The Mute and Shuffle rows follow the effect groups shown in the Inspector for the selected layer, from left to right. The first group is column 1. Columns with no group stay dark.

| LED | Meaning |
| --- | --- |
| Green | The look in use on that layer |
| Amber (look pads) | Look available |
| Red (Mute row) | The group is muted |
| Amber (Mute row) | The group is active |
| Amber (Shuffle row) | Ready |

---

## Track buttons (notes 100 to 107)

These are the round buttons under the grid, from left to right.

| Button | Note | Normal | With Shift |
| --- | --- | --- | --- |
| TRK1 | 100 | Strobe (hold) | Mute A |
| TRK2 | 101 | Y2K (hold) | Mute B |
| TRK3 | 102 | Shatter (hold) | Mute C |
| TRK4 | 103 | Invert (hold) | Solo A |
| TRK5 | 104 | Glitch (hold) | Solo B |
| TRK6 | 105 | Logo 1 | Solo C |
| TRK7 | 106 | Logo 2 | Shuffle FX |
| TRK8 | 107 | Logo 3 | HUD On / Off (Code Overlay) |

- TRK1 to TRK5 are the momentary pads: **Strobe/Flash**, **Y2K Crash**, **Particle Scatter**, **Invert Colors** and **Max Glitch**. They only act while you hold them.
- TRK6 to TRK8 show and hide logos 1 to 3. If you named a logo, the on-screen button shows that name.
- **Shuffle FX** does the same as **🎲 Shuffle Layer FX**.

The LED is on while a momentary is held, while a layer is muted (TRK1 to TRK3), or while a logo is showing (TRK6 to TRK8).

---

## Scene buttons (notes 112 to 119)

These are the round buttons on the right, from top to bottom.

| Button | Note | Normal | With Shift |
| --- | --- | --- | --- |
| SCN1 | 112 | Scenes page | Scenes page |
| SCN2 | 113 | Clips page | Clips page |
| SCN3 | 114 | Looks & FX page | Looks & FX page |
| SCN4 | 115 | Bank Up | Follow On / Off |
| SCN5 | 116 | Bank Down | Bank Down |
| SCN6 | 117 | Cue On / Off | Cue On / Off |
| SCN7 | 118 | Tap | Auto BPM |
| SCN8 | 119 | GO | Master Stop |

- The SCN1, SCN2 or SCN3 LED shows the current page. The SCN6 LED is on in Cue mode.
- **Follow** is on at first. With Follow on, the Clips page loads onto the selected layer. A launched scene also moves the APC to the Scenes page and that scene's bank.
- **Auto BPM** does the same as **Auto: Read Live**.
- **Master Stop** does the same as **■ Stop** in the top bar.

---

## Shift layer

Shift is note **122**. Hold it to use the "With Shift" column in the tables above.

You can also hold the **Shift** key on the computer, or Shift-click the on-screen APC buttons.

---

## Faders (CC 48 to 56)

| Fader | CC | Controls | Range |
| --- | --- | --- | --- |
| F1 | 48 | Layer A opacity | 0 to 1 |
| F2 | 49 | Layer B opacity | 0 to 1 |
| F3 | 50 | Layer C opacity | 0 to 1 |
| F4 | 51 | Master Speed | 0 to 4x |
| F5 | 52 | Fade (scene and timeline X-fade) | 0 to 10 s |
| F6 | 53 | Audio Gain (Master Gain) | 0 to 4 |
| F7 | 54 | Macro 1 (the first macro knob) | 0 to 1 |
| F8 | 55 | Macro 2 (the second macro knob) | 0 to 1 |
| F9 | 56 | Master (Output Brightness) | 0 to 1 |

**Soft takeover.** A fader does nothing until it passes the value shown on screen. This stops jumps when a scene has changed the value. Move the fader through the on-screen value to pick it up.

---

## LED colours

The app sets the APC LEDs for you.

| What | Colours used |
| --- | --- |
| Grid pads | Green, red, amber or off (palette 21, 5, 9 and 0, sent on status 0x96) |
| Track and scene buttons | On or off (velocity 1 or 0, sent on status 0x90) |

---

## Other controllers: MIDI Learn

Pick **APC40 mk2**, **Custom** or **Generic** in the hardware menu. Every control then goes through MIDI Learn.

TODO: confirm whether the APC40 mk2 has any built-in mapping. In this version it uses MIDI Learn like the others.

1. Click **Enable MIDI**.
2. Click **MIDI Learn**. The button reads **MIDI Learn On**.
3. Click a slider, menu, pad or button on the desk. It lights up.
4. Move a knob or fader (CC), press a key or pad (note), or move the pitch bend.
5. Repeat for more controls. Click **MIDI Learn On** to stop.

Other ways to learn:

- Click **M** next to a slider to learn just that slider. Right-click **M** to clear it.
- **Shift**-click a scene pad, or pick **MIDI learn** in its right-click menu.

How mappings act:

- A note mapped to a slider or button acts as a momentary.
- A control mapped to a scene launches that scene.
- Mappings are saved on this computer and in the project file.
- **Clear maps** removes all learned mappings.
- **APC Mini MK2 Default** brings back the built-in APC map.

---

## Macros

A macro knob moves several sliders with one CC.

![Macro Knobs](img/macros.png)

1. In **Perform**, open the **Macro Knobs** fold and click **Add macro knob**.
2. Click **Learn CC** and move a knob. The card shows "No CC yet" until a knob is bound.
3. Click **Add slider** and pick a slider. Add as many as you need.
4. For each slider, set **Depth**. Depth is how far the slider moves from where it sits. Tick **Invert** to move it the other way.
5. Click **×** on a slider row to remove that slider. Click **×** on the card to remove the macro.

On the APC Mini MK2, faders **F7** and **F8** drive the first two macro knobs.
