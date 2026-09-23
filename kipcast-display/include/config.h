#pragma once

// ---- WiFi ----
#define WIFI_SSID      "your-ssid"
#define WIFI_PASS      "your-password"

// ---- KIPCast server (the Pi) ----
// An IP address is most reliable. A name ending in ".local" is resolved via mDNS.
#define KIPCAST_HOST   "openplotter.local"
#define KIPCAST_PORT   3051

// Each physical screen gets its own id -> its own KIP tab on the Pi,
// so swiping on one screen doesn't change the others.
#define DISPLAY_ID     "saloon"

// ---- Panel ----
#define SCREEN_W       800
#define SCREEN_H       480

// Largest JPEG we'll accept. 800x480 at quality 70 is typically 40-90 KB.
#define MAX_JPEG_BYTES (256 * 1024)

// Touch tuning
#define TOUCH_MOVE_MIN_MS   30   // don't send moves faster than this
#define TOUCH_MOVE_MIN_PX   3    // ignore jitter smaller than this
