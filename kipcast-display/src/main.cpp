/*
 * KIPCast display firmware for the Waveshare ESP32-S3-Touch-LCD-7 (800x480)
 *
 * - Connects to the KIPCast server on the Pi over TCP
 * - Receives JPEG frames, decodes them straight onto the RGB panel
 * - Sends touch down/move/up back, which the Pi injects into KIP
 *
 * Build: PlatformIO (see platformio.ini). Panel config lives in
 * include/esp_panel_board_custom_conf.h, copied from Waveshare's demo.
 */
#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <JPEGDEC.h>
#include <esp_display_panel.hpp>
#include "config.h"

using namespace esp_panel::drivers;
using namespace esp_panel::board;

static Board  *board = nullptr;
static LCD    *lcd   = nullptr;
static Touch  *touch = nullptr;
static JPEGDEC jpeg;
static WiFiClient server;  // not "link": clashes with POSIX link()

static uint8_t *jpegBuf = nullptr;

/* ------------------------------------------------------------------ */
/* Display helpers                                                     */
/* ------------------------------------------------------------------ */

// JPEGDEC hands us decoded blocks; push each straight to the panel.
static int onJpegDraw(JPEGDRAW *d) {
  lcd->drawBitmap(d->x, d->y, d->iWidth, d->iHeight, (const uint8_t *)d->pPixels);
  return 1;
}

// Solid colour fill, used as a simple status indicator before frames arrive.
static void fillScreen(uint16_t rgb565) {
  static uint16_t *band = nullptr;
  const int bandH = 40;
  if (!band) band = (uint16_t *)heap_caps_malloc(SCREEN_W * bandH * 2, MALLOC_CAP_SPIRAM);
  for (int i = 0; i < SCREEN_W * bandH; i++) band[i] = rgb565;
  for (int y = 0; y < SCREEN_H; y += bandH) lcd->drawBitmap(0, y, SCREEN_W, bandH, (const uint8_t *)band);
}
static const uint16_t COL_WIFI   = 0x0010;  // dark blue: joining WiFi
static const uint16_t COL_SERVER = 0x4200;  // dark amber: looking for KIPCast

static void initDisplay() {
  board = new Board();
  if (!board->init()) { Serial.println("board init failed"); while (true) delay(1000); }
  lcd = board->getLCD();
  // Bounce buffer keeps the RGB panel stable while WiFi hammers PSRAM.
  auto *bus = lcd->getBus();
  if (bus->getBasicAttributes().type == ESP_PANEL_BUS_TYPE_RGB) {
    static_cast<BusRGB *>(bus)->configRGB_BounceBufferSize(lcd->getFrameWidth() * 10);
  }
  if (!board->begin()) { Serial.println("board begin failed"); while (true) delay(1000); }
  touch = board->getTouch();
  if (!touch) Serial.println("no touch controller: view-only mode");
}

/* ------------------------------------------------------------------ */
/* Network                                                             */
/* ------------------------------------------------------------------ */

static void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  fillScreen(COL_WIFI);
  Serial.printf("WiFi: joining %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // power save adds big latency to every frame
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(250);
  Serial.printf("WiFi: %s\n", WiFi.localIP().toString().c_str());
  MDNS.begin("kipcast-" DISPLAY_ID);
}

static bool resolveHost(IPAddress &ip) {
  String host = KIPCAST_HOST;
  if (host.endsWith(".local")) {
    ip = MDNS.queryHost(host.substring(0, host.length() - 6), 2000);
    return ip != IPAddress(0, 0, 0, 0);
  }
  return WiFi.hostByName(host.c_str(), ip) == 1;
}

enum RxState { RX_HEADER, RX_BODY };
static RxState  rxState = RX_HEADER;
static uint8_t  rxHdr[7];
static size_t   rxHdrGot = 0;
static uint32_t rxLen = 0, rxGot = 0;
static bool     rxSkip = false;
static uint32_t lastTx = 0;

static void sendLine(const char *s) {
  server.print(s);
  server.print('\n');
  lastTx = millis();
}

static void ensureLink() {
  if (server.connected()) return;
  fillScreen(COL_SERVER);
  while (!server.connected()) {
    ensureWifi();
    IPAddress ip;
    if (resolveHost(ip) && server.connect(ip, KIPCAST_PORT, 3000)) break;
    Serial.println("KIPCast: server not reachable, retrying");
    delay(2000);
  }
  server.setNoDelay(true);
  rxState = RX_HEADER; rxHdrGot = 0;
  char hello[64];
  snprintf(hello, sizeof hello, "H %s %d %d", DISPLAY_ID, SCREEN_W, SCREEN_H);
  sendLine(hello);
  Serial.println("KIPCast: connected");
}

static void showFrame(uint32_t len) {
  uint32_t t0 = millis();
  if (jpeg.openRAM(jpegBuf, len, onJpegDraw)) {
    jpeg.setPixelType(RGB565_LITTLE_ENDIAN);
    jpeg.decode(0, 0, 0);
    jpeg.close();
  } else {
    Serial.printf("bad JPEG (err %d)\n", jpeg.getLastError());
  }
  static uint32_t n = 0;
  if ((++n % 50) == 0) Serial.printf("frame %lu: %lu bytes, decode %lu ms\n", n, len, millis() - t0);
}

// Non-blocking receive so touch keeps being polled mid-frame.
static void pumpNetwork() {
  int avail;
  while ((avail = server.available()) > 0) {
    if (rxState == RX_HEADER) {
      rxHdrGot += server.read(rxHdr + rxHdrGot, sizeof rxHdr - rxHdrGot);
      if (rxHdrGot < sizeof rxHdr) continue;
      if (memcmp(rxHdr, "KCF", 3) != 0) { Serial.println("stream out of sync, reconnecting"); server.stop(); return; }
      rxLen = ((uint32_t)rxHdr[3] << 24) | ((uint32_t)rxHdr[4] << 16) | ((uint32_t)rxHdr[5] << 8) | rxHdr[6];
      rxSkip = rxLen > MAX_JPEG_BYTES;
      if (rxSkip) Serial.printf("frame too big (%lu), skipping\n", rxLen);
      rxGot = 0; rxHdrGot = 0; rxState = RX_BODY;
    } else {
      uint32_t want = rxLen - rxGot;
      if (rxSkip) {
        uint8_t scratch[512];
        rxGot += server.read(scratch, min<uint32_t>(want, sizeof scratch));
      } else {
        rxGot += server.read(jpegBuf + rxGot, want);
      }
      if (rxGot >= rxLen) {
        if (!rxSkip) showFrame(rxLen);
        rxState = RX_HEADER;
        sendLine("A");  // ready for the next one
        return;         // give touch a look-in between frames
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Touch                                                               */
/* ------------------------------------------------------------------ */

static bool readTouch(int &x, int &y) {
  TouchPoint pt;
  // Returns number of points read, or -1 on error. timeout 0 = don't wait for IRQ.
  if (touch->readPoints(&pt, 1, 0) <= 0) return false;
  x = pt.x;
  y = pt.y;
  return true;
}

static void pollTouch() {
  if (!touch) return;
  static bool down = false;
  static int lastX = 0, lastY = 0;
  static uint32_t lastMoveAt = 0, lastSeenAt = 0;
  char msg[32];
  int x, y;
  uint32_t now = millis();

  if (readTouch(x, y)) {
    lastSeenAt = now;
    if (!down) {
      down = true;
      snprintf(msg, sizeof msg, "T D %d %d", x, y);
      sendLine(msg);
      lastX = x; lastY = y; lastMoveAt = now;
    } else if (now - lastMoveAt >= TOUCH_MOVE_MIN_MS &&
               (abs(x - lastX) >= TOUCH_MOVE_MIN_PX || abs(y - lastY) >= TOUCH_MOVE_MIN_PX)) {
      snprintf(msg, sizeof msg, "T M %d %d", x, y);
      sendLine(msg);
      lastX = x; lastY = y; lastMoveAt = now;
    }
  } else if (down && now - lastSeenAt > 60) {
    // GT911 reports in bursts; only call it a lift after a short silence.
    down = false;
    snprintf(msg, sizeof msg, "T U %d %d", lastX, lastY);
    sendLine(msg);
  }
}

/* ------------------------------------------------------------------ */

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("KIPCast display starting");
  jpegBuf = (uint8_t *)heap_caps_malloc(MAX_JPEG_BYTES, MALLOC_CAP_SPIRAM);
  if (!jpegBuf) { Serial.println("PSRAM alloc failed: is OPI PSRAM enabled?"); while (true) delay(1000); }
  initDisplay();
  ensureWifi();
}

void loop() {
  ensureLink();
  pumpNetwork();
  pollTouch();
  if (millis() - lastTx > 10000) sendLine("P");  // lets both ends notice a dead link
  delay(1);
}
