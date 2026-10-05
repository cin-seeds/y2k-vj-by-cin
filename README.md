# Y2K VJ by Cín

A live VJ desk with a late-90s, early-2000s look. Mix three video layers, make them move to the music, and play the whole show from an Akai APC Mini MK2.

![Y2K VJ by Cín, Live VJ workspace](docs/img/hero.png)

## Download

Get the newest version from the [Releases page](https://github.com/cin-seeds/y2k-vj-by-cin/releases/latest).

Pick the file for your computer:

| Computer | File to download |
| --- | --- |
| Windows | The file ending in `_x64-setup.exe` |
| Mac with Apple Silicon (M1, M2, M3, M4) | The file ending in `_aarch64.dmg` |
| Mac with Intel | The file ending in `_x64.dmg` |

Windows also gets an `.msi` file. Use it if your IT setup needs MSI. Otherwise use the `-setup.exe`.

Not sure which Mac you have? Open the Apple menu, then **About This Mac**. "Chip: Apple M…" means Apple Silicon. "Processor: Intel" means Intel.

## Install

### Windows

1. Run the `-setup.exe` file.
2. Windows SmartScreen may say "Windows protected your PC". Click **More info**, then **Run anyway**.
3. Follow the installer.

### Mac

1. Open the `.dmg` file.
2. Drag **Y2K VJ by Cín** into the **Applications** folder.
3. Open the app from Applications.
4. If the Mac says the app "is damaged and can't be opened", open **Terminal** and run:

   ```
   xattr -cr "/Applications/Y2K VJ by Cín.app"
   ```

   Then open the app again.

### Allow the microphone

The app listens to sound through your audio input. When the app asks for the microphone, click **Allow**.

- Mac: if you clicked Don't Allow, go to **System Settings > Privacy & Security > Microphone** and turn on Y2K VJ by Cín.
- Windows: go to **Settings > Privacy & security > Microphone** and allow desktop apps to use the microphone.

## Features

- **Three layers (A, B, C)** of video, images, webcams or NDI / Spout / Syphon sources, with 16 looks such as Glitch, VHS, Y2K / 2000s, Black Metallic Y2K, PS1 / N64 CRT and Windows 98 Crash.
- **Three engines** per layer: Standard Video / Image FX, Particle Vector Swarm and Hydra Feedback Synth.
- **Sound to picture**: live audio input or a music file drives any slider, with kick, snare, energy, breakdown and drop detection.
- **Tempo**: tap tempo, automatic BPM from the music, and LFOs that lock to the beat.
- **Scenes and a timeline**: save the whole desk as a scene, launch it with a crossfade, and lay scenes on a bar-based timeline.
- **Akai APC Mini MK2 built in**, plus MIDI Learn for any controller and macro knobs that move many sliders at once.
- **Overlays**: a code overlay, up to three logo videos and a screensaver title, each fired from one button.
- **Output and recording**: a borderless projector window with corner pins and LED masks, recording in 16:9, 9:16 or 1:1, and NDI / Spout / Syphon send.

## Quick start

1. Open the app. The first time, it opens in the **Live VJ** workspace.
2. In the **Media Library** fold, click **+ Add media files** and pick a few videos or images. Click **A**, **B** or **C** on a card to put it on a layer.
3. In the **Audio** fold, pick your sound card under **Live Hardware**, or choose **Local File** and drop in a song.
4. Press **1** to **9** on the keyboard to change the look of the selected layer. Press **Q**, **W** or **E** to select layer A, B or C. Raise the opacity faders to mix layers.
5. In the **Output** fold, click **Master Output** and pick your projector. Press **● REC** to record.

## Learn more

- [User guide](docs/GUIDE.md): every workspace, panel and button.
- [MIDI guide](docs/MIDI.md): the full APC Mini MK2 map, MIDI Learn and macros.

## Credits

Made by Cín.

Built with [Three.js](https://threejs.org/), [Tauri](https://tauri.app/) and [Vite](https://vitejs.dev/). Video transcoding uses [FFmpeg](https://ffmpeg.org/).

TODO: confirm any other people or projects to credit.

## License

Y2K VJ by Cín is licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). You may share and change it for non-commercial use, give credit, and share your changes under the same license.

The installers bundle FFmpeg, which is licensed under the GPL. See [LICENSE](LICENSE) for the full text and [ffmpeg.org](https://ffmpeg.org/) for FFmpeg.
