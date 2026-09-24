# signalk-kipcast

Put live [KIP](https://github.com/mxtommy/Kip) dashboards on low-cost ESP32 touchscreens around the boat.

<p>
  <img src="https://raw.githubusercontent.com/g0kad/KIPCast/main/signalk-kipcast/images/windsteer.jpeg" alt="KIP wind steering gauge on a 4-inch KIPCast screen" width="260">
  <img src="https://raw.githubusercontent.com/g0kad/KIPCast/main/signalk-kipcast/images/battery.jpeg" alt="House battery current, voltage and state of charge" width="260">
  <img src="https://raw.githubusercontent.com/g0kad/KIPCast/main/signalk-kipcast/images/switches.jpeg" alt="Digital switches for the plotter, AIS and VHF" width="260">
</p>

This Signal K plugin runs KIP in headless Chromium on the server and streams it as JPEG frames over WiFi to Waveshare ESP32-S3 touchscreens: the 7" (800×480) and the 4" (480×480). Touches on the screen are sent back to KIP as real touch events, so tapping, swiping between dashboards and KIP's menus all work as they do on a tablet.

Each display has its own id, and each id gets its own KIP, drawn at that screen's size with its own login and dashboards.

The screens need the KIPCast display firmware, which you can install from Chrome or Edge with the [web installer](https://g0kad.github.io/KIPCast/). The full instructions are in the [KIPCast repository](https://github.com/g0kad/KIPCast#readme).

## Requirements

- Signal K with KIP installed
- Node.js 22.12 or later
- Chromium: `sudo apt install chromium`

Each connected display has its own Chromium, which uses about 370 MB on a Pi 5. A display's Chromium is shut down 5 minutes after its screen disconnects.

## Setting up

1. Install **KIPCast** from the Signal K App Store, then enable it in **Server → Plugin Config → KIPCast**.
2. Install the firmware on a screen with the [web installer](https://g0kad.github.io/KIPCast/), then give it your WiFi details and a display id on its setup page. It finds the Signal K server by itself.
3. Open **Webapps → KIPCast**. The screen appears in the list once it connects.

### Recommended workflow for a new screen size

Editing KIP's layout on the touchscreen itself is fiddly, so build the dashboards on a computer and use the screen only to check the result:

1. **Create a Signal K user for the screen size**, for example `kip480` for the 4" screens, in **Security → Users**.
2. **Build the dashboards in an ordinary browser.** Open KIP, log in as that user, and add the dashboards and widgets.
3. **Log the display in as the same user.** In **Webapps → KIPCast**, click **Open** for the display and log its KIP in as that user. The dashboards load from the Signal K server.
4. **Fine-tune while watching the screen.** The viewer is drawn at the screen's exact size and everything you do in it appears on the screen straight away.

## Security

The browser viewer on port 3050 has no password of its own. Anyone who can reach that port can use KIP as whichever user a display is logged in as, so only run KIPCast on a network you trust. Adding and forgetting displays needs a Signal K login.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Dashboard URL | `http://localhost:3000/@mxtommy/kip/` | Any web page works, not just KIP. |
| Default width / height | 800 × 480 | Only for a display id the server has never seen. Screens report their own size. |
| JPEG quality | 70 | |
| Max frames per second | 8 | Per display. Frames are only sent when the page changes. |
| Display TCP port | 3051 | Port the screens connect to. |
| Browser viewer port | 3050 | |
| Input mode | `touch` | Switch to `mouse` if a page ignores touch events. |
| Chromium path | auto | |

## Licence

MIT
