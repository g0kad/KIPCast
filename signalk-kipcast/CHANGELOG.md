# Changelog

## 0.3.1 (2026-09-25)

- The App Store shows the KIPCast icon. It looks for it at the package root, while the Webapps page looks in `public/`, so the package now has it in both.
- Tested on Linux, Linux arm64, macOS and Windows with Node 22 and 24 by Signal K's plugin CI; the results show in the App Store.
- No firmware changes: screens on firmware 0.3.0 are up to date.

## 0.3.0 (2026-09-25)

Update the display firmware too: this plugin works with older firmware, but the fixes below are in the firmware.

- Screens report their firmware version. **Webapps → KIPCast** shows it for each screen, with a link to the web installer when a newer one is available, and the plugin status names screens that need updating.
- Screens reconnect within a few seconds after Signal K restarts, instead of about a minute. They notice straight away when the Pi closes the connection.
- Screens remember the address of the last server they connected to. They no longer get stuck on "Can't find the Signal K server" after the WiFi router restarts, when Signal K can stop answering on the network until it is restarted itself.
- Touch and hold for setup now works on the "Looking for KIPCast" screens. The network search used to interrupt the hold.
- Screens show their firmware version on their status screens and setup page.

## 0.2.0 (2026-09-24)

- The browser viewer now uses the Signal K login. **Open** on the Displays page hands it a one-time pass, swapped for a cookie that lasts 12 hours. Visiting port 3050 any other way shows how to get in. Can be switched off in the plugin settings.
- Fixed the app icon missing from Signal K's Webapps page.

## 0.1.1 (2026-09-24)

- Screenshots for the App Store listing and the README.

## 0.1.0 (2026-09-24)

First release.

- Casts KIP dashboards from headless Chromium on the Signal K server to ESP32 touchscreens as JPEG frames, with touch, text and keys passed back to KIP.
- Firmware for the Waveshare ESP32-S3-Touch-LCD-7 (800×480) and ESP32-S3-Touch-LCD-4 Rev4 (480×480).
- Each display id gets its own Chromium and profile, drawn at the display's own size, with its own KIP login and dashboards.
- Displays page in Signal K to add, open and forget displays, and a browser viewer for setting a display up.
- Frames are paced to a configurable maximum rate and only sent when the page changes.
- A missing Chromium is shown in the plugin status instead of stopping the plugin.
- Tests, run with `npm test`.
- Display firmware installable from the browser, set up from a phone on the screen's own WiFi network, and finds the Signal K server by itself.
