#pragma once

// ---- WiFi ----
// Credentials live in secrets.h, which git ignores. Copy secrets.example.h
// to secrets.h and fill it in.
#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #error "include/secrets.h missing: copy include/secrets.example.h to include/secrets.h and set your WiFi details"
#endif

// ---- KIPCast server (the Pi) ----
// An IP address is most reliable. A name ending in ".local" is resolved via mDNS.
#define KIPCAST_HOST   "openplotter.local"
#define KIPCAST_PORT   3051

// Each physical screen gets its own id -> its own KIP tab on the Pi,
// so swiping on one screen doesn't change the others. Set it per screen in
// secrets.h; this is only the fallback.
#ifndef DISPLAY_ID
  #define DISPLAY_ID   "saloon"
#endif

// ---- Panel ----
#define SCREEN_W       800
#define SCREEN_H       480

// Largest JPEG we'll accept. 800x480 at quality 70 is typically 40-90 KB.
#define MAX_JPEG_BYTES (256 * 1024)

// Touch tuning
#define TOUCH_MOVE_MIN_MS   30   // don't send moves faster than this
#define TOUCH_MOVE_MIN_PX   3    // ignore jitter smaller than this
