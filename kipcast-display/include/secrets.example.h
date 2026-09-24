#pragma once
// Optional. Copy this file to secrets.h (ignored by git) to build your
// details into the firmware, so a freshly flashed screen connects without
// going through its setup page. Anything saved on the setup page takes
// priority over these; erase the flash (pio run -t erase) to clear it.

#define WIFI_SSID      "your-ssid"
#define WIFI_PASS      "your-password"

// The Pi. Leave out to find the Signal K server on the network by itself.
// #define KIPCAST_HOST   "openplotter.local"

// This screen's id: each screen gets its own KIP on the Pi.
// If you build for more than one board, give each its own id:
#ifdef KIPCAST_BOARD_LCD4
  #define DISPLAY_ID   "helm"      // 4" (pio run -e kipcast-display-4in)
#else
  #define DISPLAY_ID   "saloon"    // 7" (pio run -e kipcast-display)
#endif
