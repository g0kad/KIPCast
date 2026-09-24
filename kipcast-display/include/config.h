#pragma once

// ---- Settings ----
// WiFi, display id and server address are set on the screen's setup page
// and saved on the board. An optional secrets.h (copy secrets.example.h)
// provides defaults for your own builds; the release builds have none, so
// the screen opens its setup page on first boot.
#if __has_include("secrets.h")
  #include "secrets.h"
#endif

#ifndef WIFI_SSID
  #define WIFI_SSID    ""
#endif
#ifndef WIFI_PASS
  #define WIFI_PASS    ""
#endif

// Blank: find the Signal K server on the network by itself (mDNS). Otherwise
// an IP address, or a name; one ending in ".local" is resolved via mDNS.
#ifndef KIPCAST_HOST
  #define KIPCAST_HOST ""
#endif
#define KIPCAST_PORT   3051

// Each physical screen gets its own id -> its own KIP on the Pi, so swiping
// on one screen doesn't change the others. Blank: made from the board's MAC.
#ifndef DISPLAY_ID
  #define DISPLAY_ID   ""
#endif

// ---- Panel ----
// Set per board in platformio.ini; these are the 7" defaults.
#ifndef SCREEN_W
  #define SCREEN_W     800
  #define SCREEN_H     480
#endif

// Largest JPEG we'll accept. 800x480 at quality 70 is typically 40-90 KB.
#define MAX_JPEG_BYTES (256 * 1024)

// Touch tuning
#define TOUCH_MOVE_MIN_MS   30   // don't send moves faster than this
#define TOUCH_MOVE_MIN_PX   3    // ignore jitter smaller than this

// Touch and hold this long on a status screen to open setup.
#define SETUP_HOLD_MS       2000
// Leave setup (restart unchanged) after this long with no settings saved.
#define SETUP_TIMEOUT_MS    (10UL * 60 * 1000)
