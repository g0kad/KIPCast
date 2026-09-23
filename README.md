# KIPCast

Put live [KIP](https://github.com/mxtommy/Kip) dashboards on cheap ESP32 touchscreens around the boat.

A Signal K plugin on the Raspberry Pi runs KIP in headless Chromium and streams it as JPEG frames to a Waveshare ESP32-S3-Touch-LCD-7 (800×480) over WiFi. Touches on the screen are sent back and injected into KIP as real touch events, so tapping, swiping between dashboards and KIP's menus all work as they do on a tablet.

```
 Raspberry Pi (Signal K)                          ESP32-S3 7" display
 ┌─────────────────────────────────┐   JPEG     ┌────────────────────┐
 │ signalk-kipcast                 │  frames    │ kipcast-display    │
 │  headless Chromium              │ ─────────▶ │  JPEGDEC → RGB LCD │
 │   one window per display id,    │  TCP 3051  │                    │
 │   each running KIP              │ ◀───────── │  GT911 touch       │
 │                                 │  touches   └────────────────────┘
 │  browser test viewer, port 3050 │
 └─────────────────────────────────┘
```

Each display has an id (for example `saloon` or `helm`). Each id gets its own KIP instance, so swiping to another dashboard on one screen doesn't change the others. Two displays with the same id show the same thing.

> **Status:** the Pi side is tested on a Pi 5 running Signal K with KIP 4.8. The ESP32 firmware builds, but it hasn't been tested on hardware yet.

## Repository layout

| Folder | What it is |
|---|---|
| [`signalk-kipcast/`](signalk-kipcast/) | Signal K plugin (Node.js). Also runs on its own with `node standalone.js`. |
| [`kipcast-display/`](kipcast-display/) | PlatformIO firmware for the Waveshare ESP32-S3-Touch-LCD-7. |

## Pi: install the plugin

Requirements: Signal K with KIP installed, Node.js 22.12 or later, and Chromium.

```bash
sudo apt install chromium               # skip if already installed

git clone https://github.com/g0kad/KIPCast.git ~/KIPCast
cd ~/KIPCast/signalk-kipcast && npm ci --omit=dev
cd ~/.signalk && npm install ~/KIPCast/signalk-kipcast
sudo systemctl restart signalk
```

Then in the Signal K admin UI go to **Server → Plugin Config → KIPCast**, enable it and save.

To update later: `cd ~/KIPCast && git pull`, run `npm ci --omit=dev` in `signalk-kipcast/`, then restart Signal K.

### Try it without a display

Open `http://<pi>:3050/?id=saloon` in any browser. The test viewer uses the same protocol as the ESP32, and mouse drags are sent as touches. It's also the easiest way to set up KIP for a display: anything you change here is what the `saloon` screen will show.

The first time, KIP shows its "Getting Started" guide. Dismiss it once in the viewer. KIP's settings are shared by every display, so this only needs doing once.

### Plugin settings

| Setting | Default | Notes |
|---|---|---|
| Dashboard URL | `http://localhost:3000/@mxtommy/kip/` | Any web page works, not just KIP. |
| Display width / height | 800 × 480 | The size KIP is drawn at. Must match the panel. |
| JPEG quality | 70 | Frames are typically 30–50 KB at 800×480. |
| Max frames per second | 8 | Per display. Frames are only sent when the page changes, so an idle dashboard sends very few. |
| Display TCP port | 3051 | Port the ESP32 connects to. |
| Browser viewer port | 3050 | Port for the test viewer. |
| Input mode | `touch` | Switch to `mouse` if a page ignores touch events. |
| Chromium path | auto | Checks `/usr/bin/chromium`, `chromium-browser` and `google-chrome`. |

A display's KIP window is closed 5 minutes after its last screen disconnects, and reopens when a screen connects.

**Memory:** in testing on a Pi 5, Chromium used about 1.4–1.7 GB with two displays open. Plan for that alongside everything else the Pi runs.

## ESP32: build and flash the display

Hardware: [Waveshare ESP32-S3-Touch-LCD-7](https://www.waveshare.com/wiki/ESP32-S3-Touch-LCD-7) (ESP32-S3, 16 MB flash, 8 MB PSRAM, ST7262 800×480 RGB panel, GT911 touch, CH422G I/O expander).

1. Install [PlatformIO](https://platformio.org/). The project uses the community [pioarduino](https://github.com/pioarduino/platform-espressif32) platform, because ESP32_Display_Panel v1.x needs Arduino core 3.x and the official platform is still on 2.x. PlatformIO downloads it automatically.
2. Set up your WiFi details:
   ```bash
   cd kipcast-display/include
   cp secrets.example.h secrets.h          # secrets.h is ignored by git
   ```
   Edit `secrets.h` and fill in your SSID and password.
3. In [`include/config.h`](kipcast-display/include/config.h), set:
   - `KIPCAST_HOST`: the Pi's address. An IP address is the most reliable; a `.local` name is looked up over mDNS.
   - `DISPLAY_ID`: a different id for each screen.
4. Build and flash over the USB-C port marked **USB** (the ESP32's native USB):
   ```bash
   cd kipcast-display
   pio run -t upload
   pio device monitor
   ```

The board config in [`include/esp_panel_board_custom_conf.h`](kipcast-display/include/esp_panel_board_custom_conf.h) comes from Waveshare's `09_lvgl_v8_demo` example (Apache-2.0). The build shows a warning that this file is in an older format than the library expects. The newer settings it lacks don't apply to this board, so the warning can be ignored.

### What the screen shows while connecting

| Screen | Meaning |
|---|---|
| Dark blue | Joining WiFi |
| Dark amber | WiFi up, trying to reach KIPCast on the Pi |
| Dashboard | Connected |

The serial monitor (115200 baud) prints each step, plus frame size and decode time every 50 frames.

## Protocol

This is the same for the ESP32 (TCP) and the browser viewer (WebSocket), so other displays can be added easily.

**Display → Pi**: text lines ending in `\n`:

| Line | Meaning |
|---|---|
| `H <id> <width> <height>` | Hello. Must be the first line on TCP. The browser viewer passes the id as `/ws?id=` instead. |
| `A` | Ready for the next frame. The Pi sends nothing new until it gets this, so a slow display never builds up a backlog. |
| `T D <x> <y>` / `T M <x> <y>` / `T U <x> <y>` | Touch down / move / up, in display pixels. |
| `P` | Keepalive. The ESP32 sends it after 10 s of silence. |

**Pi → display**:
- **TCP:** each frame is `KCF` + a 4-byte big-endian length + the JPEG bytes.
- **WebSocket:** each frame is one binary message.

If a display doesn't send `A` within 5 s, the Pi sends the next frame anyway.

## Developing the plugin

Run it outside Signal K:

```bash
cd signalk-kipcast
npm ci
KIPCAST_URL=http://openplotter.local:3000/@mxtommy/kip/ node standalone.js
```

Environment variables:
- `KIPCAST_URL`
- `KIPCAST_QUALITY`
- `KIPCAST_FPS`
- `KIPCAST_INPUT` (`touch` or `mouse`)
- `KIPCAST_CHROMIUM`

The ports are fixed at 3050 and 3051 in this mode, so stop the plugin first.

## Licence

MIT. `kipcast-display/include/esp_panel_board_custom_conf.h` is Apache-2.0 (Espressif Systems / Waveshare).
