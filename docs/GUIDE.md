# Y2K VJ by Cín: User guide

This guide walks through the desk from left to right and top to bottom. Button names are written exactly as they appear in the app.

![The full desk](img/guide-overview.png)

Contents:

1. [Workspaces](#1-workspaces)
2. [Media in](#2-media-in)
3. [Layers](#3-layers)
4. [Audio input and files](#4-audio-input-and-files)
5. [Tempo / BPM](#5-tempo--bpm)
6. [Composition](#6-composition)
7. [Live performance tools and Overlay Triggers](#7-live-performance-tools-and-overlay-triggers)
8. [Project column folds](#8-project-column-folds)
9. [Scenes and timeline](#9-scenes-and-timeline)
10. [MIDI and macros](#10-midi-and-macros)
11. [Output: projector, mapping, recording, NDI/Spout/Syphon](#11-output-projector-mapping-recording-ndispoutsyphon)
12. [Projects: save, load, new](#12-projects-save-load-new)
13. [Keyboard shortcuts](#13-keyboard-shortcuts)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Workspaces

**What it does.** The top bar has three workspace buttons. Each one shows a different desk.

| Button | Use it for |
| --- | --- |
| **Media Manager** | Getting videos ready before the show. |
| **Live VJ** | The main desk: layers, inspector, composition, scenes and timeline. |
| **Perform** | Playing from a MIDI controller, with an on-screen APC Mini MK2, a Preview monitor and a Program monitor. |

![Workspace buttons in the top bar](img/workspaces.png)

**How to use it.** Click a workspace button. The first time, the app opens in **Live VJ**. After that it opens in the workspace you used last.

The top bar also holds:

- The **File** menu (see [Projects](#12-projects-save-load-new)).
- The fps readout.
- The master transport: **▶ Play**, **❚❚ Pause** and **■ Stop**.
- The record aspect menu and **● REC** (see [Recording](#recording)).
- **Diagnostics**, which opens and closes the Helper / Diagnostics fold.

**■ Stop** sends synced video back to the start, rewinds the timeline and blacks out the output.

**Tips.**

- The keyboard shortcuts do nothing while you are in **Media Manager**.
- The picture stops drawing in **Media Manager**. This keeps the computer free for transcoding.
- Use **File > View** to show or hide the Timeline, Media Library, Inspector, Layer A, Layer B, Layer C and Composition panels.

---

## 2. Media in

**What it does.** You can bring pictures in from video files, image files, webcams, other apps (NDI / Spout / Syphon), and stock video found online.

### Media Manager

![Media Manager](img/media-manager.png)

Media Manager makes your videos play smoothly in a live show. It fits each video to 1920×1080 and saves it to the media library folder.

1. Click **Media Manager**.
2. Drop a video on the drop area, or click it to choose a file.
3. Wait for the row to finish. The clip then appears in the Media Library.

To skip the conversion, click **Bypass Transcode & Add Directly** on the row.

Transcoding only works in the desktop app.

### Media Library

![Media Library fold](img/media-library.png)

1. Open the **Media Library** fold in the project column.
2. Click **+ Add media files** and pick images or videos. You can also drop files on the preview.
3. On a card, click **A**, **B** or **C** to load it on that layer. Click **×** to remove it from the library.

You can also drag a card onto the timeline. A single dropped file also goes onto the selected layer.

### Live Text-to-Visual

This finds a stock video clip online from a few words.

1. Pick a source: **All sources**, **Wikimedia Commons** or **Internet Archive**.
2. Type a few words, for example `clouds, neon sunset`.
3. Click **Fetch Video Loop**, or press Enter. A list of clips appears.
4. Click a clip. The desktop app downloads it, transcodes it to H.264, and puts that MP4 in the Media Library on the selected layer. If the transcode fails, the card shows the error and the original file stays off the layer.
5. In a browser, Wikimedia WebM clips are left out of the list. The status says "Open the desktop app to use this clip."

In the desktop app, set where the clips are saved with **Stock Media Download Folder** in **Preferences**.

### Cameras and other apps

Open the **Media** menu in the Inspector. Webcams are listed under **Cameras**. NDI and Spout sources (Syphon on Mac) are listed under **NDI / Spout**. Click **↻** to look again.

**Tips.**

- Clips that you add are cached on this computer, so scenes reload their clips on their own.
- If a project needs files that are not in the library, the Media Library shows a warning with the file names. Add those files again.
- NDI / Spout / Syphon sources only appear in the desktop app.

---

## 3. Layers

**What it does.** There are three layers: **A**, **B** and **C**. They are mixed on top of each other. Each layer has its own media, engine, look and sliders.

![Layer strips and the Inspector](img/layers.png)

### Layer strips (the mixer)

Each layer strip has:

- **Select**: shows this layer in the Inspector. The keys are **Q**, **W** and **E**.
- **Mute** and **Solo**.
- **Invert** and **Sync**.
- An engine menu and a blend menu.
- An opacity fader.
- A modulation source: **None**, **Sub-Bass**, **Mid-Energy**, **High-Hats**, **LFO 1** or **LFO 2**, with **Depth** and **Gate**.

The three engines are:

- **Standard Video / Image FX**
- **Particle Vector Swarm**
- **Hydra Feedback Synth**

The blend modes are:

- **Normal**
- **Add / Linear Dodge**
- **Screen**
- **Multiply**
- **Difference**
- **Exclusion**
- **Overlay**
- **Color Dodge**

When a new project starts:

- Layer A is at full opacity with **Glitch**.
- Layer B is at 0 with **Y2K / 2000s** and **Screen**.
- Layer C is at 0 with **3D Point Cloud** and **Screen**.

### Looks (shaders)

Press **1** to **9** to choose from the first nine looks for the selected layer. The full list is:

1. Glitch
2. Pixel Art / Dither
3. Y2K / 2000s
4. VHS
5. 3D Point Cloud
6. 3D Spatial Mesh
7. 90s Retro Gaming
8. Clean (no FX)
9. Windows 98 Crash
10. PS1 / N64 CRT
11. ASCII / Pointillism
12. Signal Eater
13. MiniDV
14. Flash MX
15. Starfield
16. Black Metallic Y2K

On the 3D looks, drag the preview to orbit and scroll to zoom.

### Inspector

The Inspector shows the selected layer.

- **Media** menu: **Test pattern**, Cameras, NDI / Spout sources and the Media library. Choose **+ Add files...** to add more.
- **Mirror** and **Sync to Master**.
- Video transport: **▶ Play**, **❚❚ Pause** and **⏮ Restart**, a scrub bar, and loop in and out handles.
- Playback modes: **Loop**, **Play Once & Hold Last Frame** and **Bounce / Ping-Pong**.
- Image entry for stills: **Cut / Instant**, **Linear Fade**, **Zoom & Dissolve** and **Glitch Flash**.

For **Particle Vector Swarm**, pick a particle source:

- **Current Layer Video**
- **Layer A Buffer**
- **Layer B Buffer**
- **Procedural Noise Grid**

The sliders sit in groups, such as **Source & Playback**, **Geometry & Scale** and **Audio Reactivity**.

Each group has:

- A title that opens and closes the group.
- **Mute**, which bypasses the whole group.
- **🎲**, which shuffles the group's sliders.

Each slider has:

- **?**: help text.
- **M**: MIDI Learn. Right-click it to clear the mapping.
- **A**: Automate (LFO). It has a shape, a rate, **Depth** and **Range**.
- An audio row: a sound route, **Depth** and **Gate**.

**Tips.**

- Double-click a slider name to reset it.
- Hover a slider to read what it changes on the picture.
- Bring a layer in with its opacity fader, or with a scene crossfade.

---

## 4. Audio input and files

**What it does.** Sound drives the picture. The app splits the sound into four bands and spots kicks, snares, energy, breakdowns and drops.

![Audio fold](img/audio.png)

**How to use it.** Open the **Audio** fold.

- **Live Hardware**: pick your sound card or microphone in the device menu. Click **↻** to look for devices again.
- **Local File**: choose a file, or drop an .mp3, .wav or .aiff file on the drop zone. Press **Play**. Use the scrub bar to move around in the song.
  - **Loop Audio** (on at first)
  - **Sync to Master** (on at first)
  - **Volume** (0.8 at first)

The other controls are:

- **Auto-Gain** (on at first) keeps the level steady.
- **Audio Override Stop** (off at first). When it is on, the top-bar **❚❚ Pause** and **■ Stop** leave the music, the live input and the beat reading running.
- **Master Gain** goes from 0 to 4, and starts at 1. **Mute** silences the speakers and the sound reading.
- **Attack** starts at 0.01 s. **Release** starts at 0.15 s. Raise them for smoother movement, and lower them for snappier movement.

The display shows four bands: **Sub**, **Low-Mid**, **High-Mid** and **Air**.

The meters show **KICK**, **SNARE**, **NRG** (energy), **BRK** (breakdown) and **DROP**.

To make a slider follow the music, use the audio row under the slider and pick a route:

- **None**
- **Sub-Bass**
- **Punch**
- **Mids**
- **Treble**
- **Peak Flash**
- **BPM Pulse**
- **Song Energy**
- **Breakdown State**
- **Drop Pulse**
- **Beat / Onset**

**Depth** sets how far the slider moves. **Gate** ignores quiet sound.

**Tips.**

- A beat is a sudden jump in level. A long, loud note does not count as a beat.
- If you unplug the audio input, the Audio fold shows a red message. Pick the device again.

---

## 5. Tempo / BPM

**What it does.** The tempo drives the beat-synced LFOs, the strobe and the timeline.

![Clock bar](img/bpm.png)

**How to use it.** The clock bar sits at the top of the Composition panel.

- The beat light flashes on each beat. The BPM readout starts at **120.0**.
- **Auto: Read Live** reads the tempo from the playing audio.
- **Tap/Phase** (key **T**): tap a few times to set the tempo. Tap once on the beat to line up the phase.
- **x2** doubles the tempo. **/2** halves it.
- **Nudge +** and **Nudge -** change the tempo by 0.1.
- The BPM slider goes from 20 to 300. Double-click it to return to 120.

**Tips.**

- If Auto reads double or half the real tempo, press **/2** or **x2**.
- Nudge a little at a time to drift back in line with the DJ.

---

## 6. Composition

**What it does.** Composition is the master bus. It changes the mixed picture after all three layers are put together.

![Composition panel](img/composition.png)

**How to use it.**

- **Master Speed** goes from 0 to 4 and starts at 1.00x. 0 freezes shader motion and automation, and 4 runs them four times faster. Double-click it to reset.
- **Output Brightness** sets the final level.
- **Barrel** (Barrel Curve) sits at the top of the project column. It bends the picture like an old CRT.

The master groups are:

- **Color & Texture**: Phosphor Bleed, Global Hue, Saturation and Contrast.
- **Distortion & Glitch**: Master Scanlines and Horiz. Chromatic Bleed.
- **Motion & Timing**:
  - **Strobe Amount**.
  - **Strobe Source**: Manual, Beat Pulse or Drop Pulse. Beat Pulse is the default.
  - **Strobe Color**: White or Black.

**Tips.**

- Hover a master slider to read what it does.
- Lock a group with its Lock button so **Shuffle** leaves it alone.

---

## 7. Live performance tools and Overlay Triggers

**What it does.** These are the buttons you hit during a set.

![Live Performance Tools and Overlay Triggers](img/live-tools.png)

### Live Performance Tools

- **🎲 Shuffle Layer FX** gives random values to the visible effect sliders on the selected layer.
- The momentary pads only act while you hold them. Each pad shows its MIDI note, or "unmapped".
  - **Strobe/Flash**
  - **Y2K Crash**
  - **Particle Scatter**
  - **Invert Colors**
  - **Max Glitch**

### Overlay Triggers

**Code Overlay**

- **Code Overlay** turns the overlay on or off on this monitor. It shows **On** or **Off**.
- **Define in Project** opens the Code Overlay fold.
- **Record / Output** copies the code overlay into the recording and the master output. It is off at first.

**Logos**

- **Logo 1**, **Logo 2** and **Logo 3** appear once a logo video is loaded. If you gave the logo a name, the button shows that name.
- Press a logo button to show the logo. Press it again to hide it.
- **Define in Project** shows when no logo is loaded. It takes you to the Brand Overlay fold.

**Screensaver**

- **Screensaver** turns the title screen on or off on this monitor.
- **Define in Project** opens the Screensaver fold.
- **Record / Output** draws the screensaver into the recording and the master output. It is off at first.

**Tips.**

- Map the momentary pads to the APC track buttons. **TRK1** to **TRK5** are already mapped. See [MIDI.md](MIDI.md).
- Turn on **Record / Output** before a set if the overlays should reach the projector.

---

## 8. Project column folds

**What it does.** The project column on the left holds folds you open and close. The app remembers which folds were open.

![Project column](img/project-column.png)

Many folds have a **Lock** button. A lock freezes the controls, and **Shuffle** skips that section.

### Helper / Diagnostics

This fold has four lists: **What's happening**, **What's messy**, **Performance** and **Keep it readable**. Click a warning to select its layer, open its group, and flash the slider for two seconds.

### Media Library

See [Media in](#2-media-in).

### Audio

See [Audio input and files](#4-audio-input-and-files).

### Output

See [Output](#11-output-projector-mapping-recording-ndispoutsyphon).

### Recordings

See [Recording](#recording).

### Code Overlay

![Code Overlay fold](img/code-overlay.png)

This draws scrolling code, data or a matrix over the picture.

- **Motion**: Cut, Fade, Zoom or Slide. **Duration** starts at 0.4.
- **Color**: Green, Amber, Cyan or White.
- **Scale**: 10 to 48. It starts at 16.
- **Preset**: Custom, ASCII, Terminal Logs, Kinetic Matrix, Live Diagnostics or Audio Reactive Data.
- **Display**: Active Scanner, Full GLSL Shader Source, Dynamic Matrix HUD, Compact Math Formula, Live Diagnostics or Audio Reactive Data.
- **Glyph**: Brightness ramp, Matrix or ASCII.
- **Line**, **Mix** and **Back** set the line height, the mix and the background.

The checkboxes are:

- **Automask**
- **Show on Master Output**
- **Include Logo in Recording/Output** (on at first)
- **Show on Perform Mode** (TODO: confirm. Perform Mode has no button in this version.)
- **Auto-adjust Overlays for Output DPI** (on at first)

Drag the box on the preview to move it. Drag a corner to resize it. Double-click it to swap between a column and a bar.

### Brand Overlay

![Brand Overlay fold](img/brand-overlay.png)

There are three logo cards: **Logo 1**, **Logo 2** and **Logo 3**. Each card has:

- **Load** (mp4, mov or webm) and **Remove**.
- **Name**, up to 16 characters. It shows on the fire button.
- **Opacity**.
- **Motion** (Fade at first) and **Duration** (0.5 at first).
- **Auto mask**.
- **Scale**, 0.25 to 2.5.
- **Position X** and **Position Y**, −0.5 to 0.5.
- **Blend**: Additive, Alpha or Invert/Key. Alpha is the default.
- **Effect**: None, Glitch, Hue, Pixelate or Flash, with **Amount** (0.5 at first) and **React**.

TODO: confirm whether a logo video loops or plays once.

### Screensaver

![Screensaver fold](img/screensaver.png)

This is a big title card, for the start of the night or between sets.

- **Text**: two lines are allowed. The default is "Y2K VJ//BY CÍN" and "CUSTOM CODED FOR LATE FUTURE".
- **Font**: Desk, Terminal, Fixedsys or MS Sans.
- **Shade**: 0 to 8. It starts at 8.
- **Background**: 0 to 1. It starts at 1.
- **Color**: White, Cyan, Magenta, Amber or Green.
- **Size**: 40 to 220 %. It starts at 100 %.

The credit line "OS CC BY-NC-SA // REPO ON GITHUB" is always shown.

**Tips.**

- Close the folds you do not need. The column stays short and easy to read.
- Lock a section before you use Shuffle in a set.

---

## 9. Scenes and timeline

**What it does.** A scene is a snapshot of the whole desk. The timeline plays scenes and clips on a bar grid.

![Scenes and timeline dock](img/scenes-timeline.png)

### Scenes

1. Type a name in **Scene name (optional)**.
2. Click **Save Current State as Scene**.
3. Click a scene pad to launch it with a crossfade.

Scenes come in banks of 8 (**Bank 1**, **Bank 2**, …).

- **Shift**-click a pad to MIDI Learn it.
- Right-click a pad for the menu: **Launch (cut)**, **Update with current state**, **Rename**, **MIDI learn** and **Delete**.
- Drag a pad onto the timeline.

### Timeline

- **▶** plays and **■** stops.
- **Loop** is on at first.
- **BPM** goes from 20 to 300 and starts at 120. **Tap** sets it by tapping.
- **Bars** goes from 1 to 128 and starts at 16.
- **X-fade** goes from 0 to 10 s and starts at 1.0 s.
- The transition styles are **Crossfade Alpha**, **Additive Bleed** and **Wiping Glitch**.
- The position readout shows bar.beat.

On the track:

- Drop a scene pad or a Media Library card onto the track to add a cue.
- Click the track to jump there.
- Drag a cue to move it.
- Double-click or right-click a cue to remove it.

**Tips.**

- Press **Shift+1** to **Shift+8** to launch scenes 1 to 8 of the current bank.
- Press **L** to switch to live mode, which hides the timeline. Press **L** again to bring it back.
- If storage is full, the app shows "Scenes could not be saved - storage is full". Delete old scenes or save the project to a file.

---

## 10. MIDI and macros

**What it does.** You can play the desk from a MIDI controller. The Akai APC Mini MK2 works without any setup. Other controllers use MIDI Learn.

![Perform workspace](img/perform.png)

**How to use it.**

1. Click **Perform**.
2. Pick your controller in the hardware menu: **APC Mini mk2**, **APC40 mk2**, **Custom** or **Generic**.
3. Click **Enable MIDI**. The app remembers this for next time.
4. To map a control, click **MIDI Learn**, click a slider, pad or button, then move a knob or press a key on the controller.

The other buttons are:

- **APC Mini MK2 Default** loads the built-in APC map.
- **Clear maps** removes your MIDI Learn mappings.
- **Show MIDI labels** shows small tags with the APC control name next to each mapped control.
- **Cue** on the Preview monitor turns on Cue mode. In Cue mode a scene pad first shows the scene on Preview. Press the pad again, or GO, to launch it.

### Macro Knobs

1. Click **Add macro knob**.
2. Click **Learn CC** and move a knob. The card shows "No CC yet" until a knob is bound.
3. Click **Add slider** to add the sliders this knob should move.
4. Set **Depth** for each slider. Tick **Invert** to flip the direction.

The full APC map is in [MIDI.md](MIDI.md).

**Tips.**

- Web MIDI only works in Chrome or Edge if you run the app in a browser.
- On Windows, only one app can use the APC at a time. Close other MIDI apps first.

---

## 11. Output: projector, mapping, recording, NDI/Spout/Syphon

**What it does.** This sends the picture to a projector, LED wall, recording file or another app.

![Output fold](img/output.png)

### Projector

1. Open the **Output** fold.
2. Pick a **Preview** shape: **16:9 (Landscape)**, **9:16 (Vertical/Social)** or **1:1 (Square/Diamond LED)**.
3. Click **Master Output** and pick a display. The picture opens in a borderless window on that display.

**Fullscreen** (key **F**) makes the app fill the screen.

### Mapping (Advanced Output)

![Advanced Output](img/advanced-output.png)

Click **Advanced Output**.

- Drag the corner pins to skew the picture onto the projector surface.
- **Reset corners** puts them back.
- **Output Mask** options:
  - None (Full Screen)
  - Circle/Ellipse
  - Triangle
  - Diamond
  - 16:9 Letterbox
  - Stepped Diamond (7x7 / 25-Panel LED)
- **Panel Bezels / Gaps** goes from 0 to 5 %.

The 25-panel LED mask locks the preview to 1:1 with a 1152×1152 reference frame. Cells outside the 25 panels are black.

### Recording

![Recordings fold](img/recordings.png)

1. Pick the aspect in the top bar:
   - **16:9 (1920×1080)**
   - **9:16 (1080×1920)**
   - **1:1 (1080×1080)**
   - **Native**
2. In the **Recordings** fold, set the remaining options:
   - **Scale**: Fill or Fit.
   - **Render scale**: 0.5x, 0.75x or 1x.
   - **Format**: MP4 or WebM. The list shows what your system supports.
   - **Include audio**: on at first.
3. Press **● REC** (key **R**). It changes to **■ STOP**. Press it again to finish.

### NDI / Spout / Syphon

- **Send it out.** In the Output fold, pick a size and turn on **Send**. It is off at first. The sizes are:
  - 1920×1080
  - 1280×720
  - 1080×1920
  - 1152×1152
  - 3840×2160
- **Bring it in.** Pick the source in the Inspector **Media** menu.

Windows uses NDI and Spout. Mac uses NDI and Syphon. Linux shows NDI, and says Spout and Syphon are not on this system. This only works in the desktop app.

**Tips.**

- Turn on **Record / Output** in Overlay Triggers if the code overlay or screensaver should be in the recording.
- Use a lower **Render scale** if recording makes the frame rate drop.
- In a browser, allow pop-ups so **Master Output** can open its window.

---

## 12. Projects: save, load, new

**What it does.** A project file stores the desk, scenes, timeline, MIDI maps, macros and output mapping.

![File menu](img/file-menu.png)

**How to use it.** Open the **File** menu.

- **New Project** starts from the defaults.
- **Load Project** opens a `.vjproj` or `.json` file.
- **Save** downloads a `vj-project-<date and time>.vjproj` file.
- **Save New** asks for a name, then saves.
- **Preferences** has two settings:
  - **Global UI Scale**, from 75 to 125 %.
  - **Stock Media Download Folder**. Click **Choose** to set it. This only works in the desktop app.

**Tips.**

- The project file holds the names of your media files. Keep the media on the same computer, or add the files again after loading.
- Drag the edges between the library, the preview and the inspector to resize them. Drag the top edge of the mixer too.

---

## 13. Keyboard shortcuts

The keys do nothing in **Media Manager**, while you type in a text box, or while you hold Ctrl, Cmd or Alt.

| Key | Action |
| --- | --- |
| Q / W / E | Select layer A / B / C |
| 1 to 9 | Set the look of the selected layer (the first nine looks) |
| Shift+1 to Shift+8 | Launch scene 1 to 8 in the current bank |
| Space | Master play / pause |
| T | Tap tempo |
| L | Switch between live mode (timeline hidden) and timeline mode |
| H | Code Overlay on / off |
| C | Next Code Overlay display |
| P | Hide or show the UI |
| F | Fullscreen |
| R | Start or stop recording |
| Esc | Close menus and windows |
| Shift (hold) | APC second function, the same as the APC Shift button |

The hint in the Recordings fold says "Space timeline play/pause". In this version, Space plays and pauses the master transport.

---

## 14. Troubleshooting

| You see | Do this |
| --- | --- |
| "Windows protected your PC" | Click **More info**, then **Run anyway**. |
| Mac says the app "is damaged" | Run `xattr -cr "/Applications/Y2K VJ by Cín.app"` in Terminal. |
| No sound reaction | Allow the microphone. Pick the device in the **Audio** fold and click **↻**. |
| "Audio input disconnected - pick the device again" | Plug the device back in, then pick it in the device menu. |
| "Picture lost - save and reload" | Click **Save Project**, then **Reload**. The graphics card reset. |
| "Scenes could not be saved - storage is full" | Delete old scenes, or save the project to a file. |
| "Scenes need these files. Add them to the library: …" | Add the listed files with **+ Add media files**. |
| "FFmpeg binary missing in src-tauri/bin/ - please install sidecar binary" | Reinstall the app from the Releases page. |
| The APC does nothing | Click **Enable MIDI**. Close other apps that use the APC. Check that **APC Mini mk2** is picked. |
| MIDI does not work in a browser | Use Chrome or Edge. |
| **Master Output** does not open in a browser | Allow pop-ups for the page. |
| Low frame rate | Lower **Render scale**, close unused folds, and check **Performance** in Helper / Diagnostics. |
| Transcoding does nothing | Transcoding only works in the desktop app. |
