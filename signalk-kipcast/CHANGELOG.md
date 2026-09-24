# Changelog

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
