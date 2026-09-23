#pragma once
// Copy this file to secrets.h (ignored by git) and fill in your details.

#define WIFI_SSID      "your-ssid"
#define WIFI_PASS      "your-password"

// This screen's id: each screen gets its own KIP tab on the Pi.
// If you build for more than one board, give each its own id:
#ifdef KIPCAST_BOARD_LCD4
  #define DISPLAY_ID   "helm"      // 4" (pio run -e kipcast-display-4in)
#else
  #define DISPLAY_ID   "saloon"    // 7" (pio run -e kipcast-display)
#endif
