/*
 * KIPCast display firmware for Waveshare ESP32-S3 touch LCDs:
 * ESP32-S3-Touch-LCD-7 (800x480) and ESP32-S3-Touch-LCD-4 Rev4 (480x480)
 *
 * - Connects to the KIPCast server on the Pi over TCP
 * - Receives JPEG frames, decodes them straight onto the RGB panel
 * - Sends touch down/move/up back, which the Pi injects into KIP
 * - WiFi, display id and server are set on a setup page the screen serves
 *   from its own WiFi network, and saved on the board
 *
 * Build: PlatformIO (see platformio.ini), one env per board. Panel configs
 * live in include/boards/<board>/esp_panel_board_custom_conf.h.
 */
#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <esp_mac.h>
#include <JPEGDEC.h>
#include <esp_display_panel.hpp>
#include "config.h"
#include "fonts.h"

using namespace esp_panel::drivers;
using namespace esp_panel::board;

static Board  *board = nullptr;
static LCD    *lcd   = nullptr;
static Touch  *touch = nullptr;
static JPEGDEC jpeg;
static WiFiClient server;  // not "link": clashes with POSIX link()

static uint8_t *jpegBuf = nullptr;

// Settings saved on the board by the setup page. secrets.h, if present,
// supplies the defaults.
static struct {
  String ssid, pass, host, id;
} cfg;

static void runSetup();
static bool readTouch(int &x, int &y);

/* ------------------------------------------------------------------ */
/* Display helpers                                                     */
/* ------------------------------------------------------------------ */

// JPEGDEC hands us decoded blocks; push each straight to the panel.
static int onJpegDraw(JPEGDRAW *d) {
  lcd->drawBitmap(d->x, d->y, d->iWidth, d->iHeight, (const uint8_t *)d->pPixels);
  return 1;
}

// Status and setup screens are drawn into a buffer, then copied to the panel.
static uint16_t *canvas = nullptr;
static const uint16_t COL_WIFI   = 0x0010;  // dark blue: joining WiFi
static const uint16_t COL_SERVER = 0x4200;  // dark amber: looking for KIPCast
static const uint16_t COL_SETUP  = 0x0200;  // dark green: setup
static const uint16_t COL_TEXT   = 0xFFFF;
static const uint16_t COL_DIM    = 0xBDF7;

static void pushCanvas() {
  const int bandH = 40;
  for (int y = 0; y < SCREEN_H; y += bandH)
    lcd->drawBitmap(0, y, SCREEN_W, min(bandH, SCREEN_H - y), (const uint8_t *)(canvas + y * SCREEN_W));
}

// Mixes two RGB565 colours; a is the weight of fg, 0-15.
static uint16_t blend(uint16_t fg, uint16_t bg, uint8_t a) {
  uint32_t r = (((fg >> 11) & 31) * a + ((bg >> 11) & 31) * (15 - a)) / 15;
  uint32_t g = (((fg >> 5) & 63) * a + ((bg >> 5) & 63) * (15 - a)) / 15;
  uint32_t b = ((fg & 31) * a + (bg & 31) * (15 - a)) / 15;
  return (r << 11) | (g << 5) | b;
}

static const Glyph *glyphFor(const Font &f, char c) {
  if (c < f.first || c > f.last) c = '?';
  return &f.glyphs[c - f.first];
}

static int textWidth(const Font &f, const String &s) {
  int w = 0;
  for (char c : s) w += glyphFor(f, c)->advance;
  return w;
}

// Draws one line of text with its baseline at y.
static void drawLine(int x, int y, const String &s, const Font &f, uint16_t colour) {
  for (char c : s) {
    const Glyph *g = glyphFor(f, c);
    const uint8_t *bits = f.bits + g->offset;
    const int rowBytes = (g->w + 1) / 2;
    for (int row = 0; row < g->h; row++) {
      int py = y + g->y + row;
      if (py < 0 || py >= SCREEN_H) continue;
      for (int col = 0; col < g->w; col++) {
        int px = x + g->x + col;
        if (px < 0 || px >= SCREEN_W) continue;
        uint8_t b = bits[row * rowBytes + col / 2];
        uint8_t a = col & 1 ? b & 15 : b >> 4;
        if (a) {
          uint16_t &dst = canvas[py * SCREEN_W + px];
          dst = blend(colour, dst, a);
        }
      }
    }
    x += g->advance;
  }
}

// Draws text centred and word-wrapped to the screen width, with the top of
// the first line at y. Returns the y below the last line.
static int drawText(int y, const String &text, const Font &font, uint16_t colour) {
  const int maxW = SCREEN_W - 48;
  String line, rest = text;
  auto flush = [&]() {
    drawLine((SCREEN_W - textWidth(font, line)) / 2, y + font.ascent, line, font, colour);
    y += font.lineHeight;
    line = "";
  };
  while (rest.length()) {
    int sp = rest.indexOf(' ');
    String word = sp < 0 ? rest : rest.substring(0, sp);
    rest = sp < 0 ? "" : rest.substring(sp + 1);
    String longer = line.length() ? line + " " + word : word;
    if (textWidth(font, longer) > maxW && line.length()) { flush(); line = word; }
    else line = longer;
  }
  if (line.length()) flush();
  return y;
}

// A full-screen message: background colour, a heading, lines of text and an
// optional footer.
static void showScreen(uint16_t bg, const String &heading, std::initializer_list<String> lines,
                       const String &footer = "") {
  for (int i = 0; i < SCREEN_W * SCREEN_H; i++) canvas[i] = bg;
  int y = drawText(SCREEN_H / 10, heading, FONT_HEADING, COL_TEXT) + 12;
  for (const String &l : lines)
    if (l.length()) y = drawText(y, l, FONT_BODY, COL_TEXT) + 10;
  if (footer.length()) drawText(SCREEN_H - 20 - FONT_SMALL.lineHeight, footer, FONT_SMALL, COL_DIM);
  pushCanvas();
}

static void showStatus(uint16_t bg, const String &status, const String &detail = "") {
  showScreen(bg, "KIPCast", {"Display: " + cfg.id, status, detail}, "Touch and hold for setup");
}

#ifdef KIPCAST_BOARD_LCD4
/*
 * The 4" Rev4 gates panel power and the LCD/touch resets through a CH32V003
 * IO expander (I2C 0x24), which ESP32_Display_Panel doesn't support. Do the
 * same writes as Waveshare's WS_CH32_IO::begin() before the board starts.
 * Bit-banged so no I2C driver owns these pins when the touch driver (same
 * bus) claims them.
 */
static const int CH32_SDA = 15, CH32_SCL = 7;
static const uint8_t CH32_ADDR = 0x24, CH32_REG_DIR = 0x02, CH32_REG_OUT = 0x03;
static const uint8_t CH32_TP_RST = 1 << 1, CH32_LCD_RST = 1 << 3, CH32_SYS_EN = 1 << 5;

// Open-drain: drive low, or release and let the pull-ups take the line high.
static void i2cLine(int pin, bool high) {
  if (high) pinMode(pin, INPUT_PULLUP);
  else { pinMode(pin, OUTPUT); digitalWrite(pin, LOW); }
  delayMicroseconds(5);
}

static bool i2cByte(uint8_t b) {
  for (int i = 7; i >= 0; i--) {
    i2cLine(CH32_SDA, b & (1 << i));
    i2cLine(CH32_SCL, true);
    i2cLine(CH32_SCL, false);
  }
  i2cLine(CH32_SDA, true);  // release for ACK
  i2cLine(CH32_SCL, true);
  bool ack = digitalRead(CH32_SDA) == LOW;
  i2cLine(CH32_SCL, false);
  return ack;
}

static bool ch32Write(uint8_t reg, uint8_t val) {
  i2cLine(CH32_SDA, false);  // start
  i2cLine(CH32_SCL, false);
  bool ok = i2cByte(CH32_ADDR << 1) && i2cByte(reg) && i2cByte(val);
  i2cLine(CH32_SDA, false);  // stop
  i2cLine(CH32_SCL, true);
  i2cLine(CH32_SDA, true);
  return ok;
}

static void ch32PowerOn() {
  i2cLine(CH32_SDA, true);
  i2cLine(CH32_SCL, true);
  // Clock out any half-finished transfer left from before a reset.
  for (int i = 0; i < 9 && digitalRead(CH32_SDA) == LOW; i++) {
    i2cLine(CH32_SCL, false);
    i2cLine(CH32_SCL, true);
  }
  bool ok = ch32Write(CH32_REG_DIR, 0xFF) && ch32Write(CH32_REG_OUT, 0);  // resets asserted, power off
  delay(200);
  ok = ok && ch32Write(CH32_REG_OUT, CH32_SYS_EN | CH32_LCD_RST | CH32_TP_RST);
  delay(200);
  pinMode(CH32_SDA, INPUT);
  pinMode(CH32_SCL, INPUT);
  Serial.println(ok ? "CH32 IO expander: panel powered" : "CH32 IO expander: no ACK at 0x24");
}
#endif

static void initDisplay() {
#ifdef KIPCAST_BOARD_LCD4
  ch32PowerOn();
#endif
  board = new Board();
  if (!board->init()) { Serial.println("board init failed"); while (true) delay(1000); }
  lcd = board->getLCD();
  // Bounce buffer keeps the RGB panel stable while WiFi hammers PSRAM.
  auto *bus = lcd->getBus();
  if (bus->getBasicAttributes().type == ESP_PANEL_BUS_TYPE_RGB) {
    static_cast<BusRGB *>(bus)->configRGB_BounceBufferSize(lcd->getFrameWidth() * 20);
  }
  if (!board->begin()) { Serial.println("board begin failed"); while (true) delay(1000); }
  touch = board->getTouch();
  if (!touch) Serial.println("no touch controller: view-only mode");
  canvas = (uint16_t *)heap_caps_malloc(SCREEN_W * SCREEN_H * 2, MALLOC_CAP_SPIRAM);
  if (!canvas) { Serial.println("canvas alloc failed"); while (true) delay(1000); }
  Serial.println("display ready");
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

// True once the screen has been touched continuously for SETUP_HOLD_MS.
// Only used on the status screens, never while KIP is showing.
static bool touchHeld() {
  if (!touch) return false;
  static uint32_t since = 0, lastSeen = 0;
  int x, y;
  uint32_t now = millis();
  if (readTouch(x, y)) {
    if (!since || now - lastSeen > 200) since = now;
    lastSeen = now;
    return now - since >= SETUP_HOLD_MS;
  }
  if (now - lastSeen > 200) since = 0;
  return false;
}

// Waits, but opens setup if the screen is touched and held meanwhile.
static void waitOrSetup(uint32_t ms) {
  for (uint32_t t0 = millis(); millis() - t0 < ms; delay(10))
    if (touchHeld()) runSetup();
}

/* ------------------------------------------------------------------ */
/* Network                                                             */
/* ------------------------------------------------------------------ */

static String hostName() {
  String h = "kipcast-" + cfg.id;
  h.toLowerCase();
  h.replace('_', '-');
  return h;
}

static void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  showStatus(COL_WIFI, "Joining WiFi", cfg.ssid);
  Serial.printf("WiFi: joining %s\n", cfg.ssid.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // power save adds big latency to every frame
  WiFi.setHostname(hostName().c_str());
  WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str());
  uint32_t t0 = millis(), lastBegin = t0;
  bool warned = false;
  while (WiFi.status() != WL_CONNECTED) {
    waitOrSetup(250);
    if (!warned && millis() - t0 > 30000) {
      showStatus(COL_WIFI, "Can't join " + cfg.ssid,
                 "Still trying. If the WiFi details have changed, touch and hold to set them.");
      warned = true;
    }
    if (millis() - lastBegin > 30000) {  // start over every 30 s
      Serial.printf("WiFi: still joining (status %d)\n", WiFi.status());
      WiFi.disconnect();
      WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str());
      lastBegin = millis();
    }
  }
  Serial.printf("WiFi: %s\n", WiFi.localIP().toString().c_str());
  MDNS.end();
  MDNS.begin(hostName().c_str());
}

// Finds the Pi: the configured host, or else the Signal K server announcing
// itself on the network. `where` names it for the status screen.
static bool resolveHost(IPAddress &ip, String &where) {
  const String &host = cfg.host;
  if (host.isEmpty()) {
    where = "the Signal K server";
    if (MDNS.queryService("signalk-http", "tcp") <= 0) return false;
    ip = MDNS.address(0);
    where = ip.toString();
    return true;
  }
  where = host;
  if (ip.fromString(host)) return true;
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
  ensureWifi();
  showStatus(COL_SERVER, "Looking for KIPCast",
             cfg.host.isEmpty() ? "Searching the network for the Signal K server" : cfg.host);
  for (int tries = 1; !server.connected(); tries++) {
    ensureWifi();
    IPAddress ip;
    String where;
    bool found = resolveHost(ip, where);
    if (found && server.connect(ip, KIPCAST_PORT, 3000)) break;
    Serial.printf("KIPCast: %s %s, retrying\n", where.c_str(), found ? "not answering" : "not found");
    if (tries == 3) {
      if (!found)
        showStatus(COL_SERVER, "Can't find " + where,
                   cfg.host.isEmpty() ? "Is Signal K running? Touch and hold to enter its address."
                                      : "Touch and hold to change the address.");
      else
        showStatus(COL_SERVER, "No answer from KIPCast at " + where,
                   "Is the KIPCast plugin enabled in Signal K?");
    }
    waitOrSetup(2000);
  }
  server.setNoDelay(true);
  rxState = RX_HEADER; rxHdrGot = 0;
  char hello[64];
  snprintf(hello, sizeof hello, "H %s %d %d", cfg.id.c_str(), SCREEN_W, SCREEN_H);
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
/* Settings and setup page                                             */
/* ------------------------------------------------------------------ */

static Preferences prefs;

// Same rule as the plugin's display ids.
static bool validId(const String &id) {
  if (id.isEmpty() || id.length() > 32) return false;
  for (char c : id)
    if (!isalnum((unsigned char)c) && c != '_' && c != '-') return false;
  return true;
}

static String macSuffix() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);  // works before WiFi has started
  char s[5];
  snprintf(s, sizeof s, "%02X%02X", mac[4], mac[5]);
  return s;
}

static void loadSettings() {
  prefs.begin("kipcast", false);
  cfg.ssid = prefs.getString("ssid", WIFI_SSID);
  cfg.pass = prefs.getString("pass", WIFI_PASS);
  cfg.host = prefs.getString("host", KIPCAST_HOST);
  cfg.id   = prefs.getString("id", DISPLAY_ID);
  prefs.end();
  if (!validId(cfg.id)) {
    cfg.id = "screen-" + macSuffix();
    cfg.id.toLowerCase();
  }
}

static String htmlEscape(const String &s) {
  String o;
  for (char c : s) {
    switch (c) {
      case '&': o += "&amp;"; break;
      case '<': o += "&lt;"; break;
      case '>': o += "&gt;"; break;
      case '"': o += "&quot;"; break;
      default: o += c;
    }
  }
  return o;
}

static const char PAGE_HEAD[] PROGMEM = R"(<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>KIPCast setup</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#1c2733;color:#d7dee6;margin:0}
main{max-width:420px;margin:0 auto;padding:16px}h1{font-size:22px}label{display:block;margin:16px 0 4px}
input{box-sizing:border-box;width:100%;font:inherit;padding:8px;border-radius:6px;border:1px solid #2d3640;background:#0e1216;color:#d7dee6}
small{color:#7d8a97}button{margin-top:24px;width:100%;font:inherit;padding:10px;border-radius:6px;border:0;background:#2f6a92;color:#fff}
.err{color:#e06c5f}</style></head><body><main>)";

static WebServer *web = nullptr;
static DNSServer *dns = nullptr;
static String networks;  // <option>s for the WiFi network list
static bool saved = false;

static void sendForm(const String &error = "") {
  String p = FPSTR(PAGE_HEAD);
  p += "<h1>KIPCast setup</h1><p>This screen is " + String(SCREEN_W) + "&times;" + String(SCREEN_H) + ".</p>";
  if (error.length()) p += "<p class=err>" + htmlEscape(error) + "</p>";
  p += "<form method=post action=/save>";
  p += "<label for=ssid>WiFi network</label>";
  p += "<input id=ssid name=ssid list=nets required autocomplete=off value=\"" + htmlEscape(cfg.ssid) + "\">";
  p += "<datalist id=nets>" + networks + "</datalist>";
  p += "<label for=pass>WiFi password</label><input id=pass name=pass type=password autocomplete=off";
  p += cfg.pass.length() ? " placeholder=\"Unchanged\">" : ">";
  p += "<label for=id>Display id</label>";
  p += "<input id=id name=id required maxlength=32 pattern=\"[A-Za-z0-9_\\-]+\" autocapitalize=none value=\"" + htmlEscape(cfg.id) + "\">";
  p += "<small>Letters, digits, - and _, for example <i>helm</i>. Each id gets its own KIP on the Pi; "
       "screens with the same id show the same thing.</small>";
  p += "<label for=host>Signal K server</label>";
  p += "<input id=host name=host autocomplete=off autocapitalize=none placeholder=\"Found automatically\" value=\"" + htmlEscape(cfg.host) + "\">";
  p += "<small>Leave blank to find it on the network, or enter the Pi's IP address or name.</small>";
  p += "<button>Save and restart</button></form></main></body></html>";
  web->send(200, "text/html", p);
}

static void handleSave() {
  String ssid = web->arg("ssid"), pass = web->arg("pass"), id = web->arg("id"), host = web->arg("host");
  ssid.trim(); id.trim(); host.trim();
  if (ssid.isEmpty()) return sendForm("Enter the WiFi network.");
  if (!validId(id)) return sendForm("The display id can only use letters, digits, - and _.");
  if (pass.isEmpty() && ssid == cfg.ssid) pass = cfg.pass;  // left as "Unchanged"
  prefs.begin("kipcast", false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  prefs.putString("id", id);
  prefs.putString("host", host);
  prefs.end();
  Serial.printf("setup: saved (WiFi %s, id %s, server %s)\n", ssid.c_str(), id.c_str(), host.length() ? host.c_str() : "auto");
  String p = FPSTR(PAGE_HEAD);
  p += "<h1>Saved</h1><p>The screen is restarting and will join <b>" + htmlEscape(ssid) +
       "</b>. You can reconnect this phone to your usual WiFi.</p></main></body></html>";
  web->send(200, "text/html", p);
  saved = true;
}

// The screen's own WiFi network and setup page. Never returns: restarts once
// settings are saved, when the screen is tapped, or after SETUP_TIMEOUT_MS.
static void runSetup() {
  server.stop();
  showScreen(COL_SETUP, "KIPCast setup", {"Looking for WiFi networks..."});
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP_STA);
  String ap = "KIPCast-" + macSuffix();

  int n = WiFi.scanNetworks();
  for (int i = 0; i < n; i++) {
    String opt = "<option value=\"" + htmlEscape(WiFi.SSID(i)) + "\">";
    if (WiFi.SSID(i).length() && networks.indexOf(opt) < 0) networks += opt;
  }
  WiFi.scanDelete();

  WiFi.softAP(ap.c_str());
  delay(100);
  IPAddress apIp = WiFi.softAPIP();
  dns = new DNSServer();
  dns->start(53, "*", apIp);  // every name leads here, so phones show the page by themselves
  web = new WebServer(80);
  web->on("/", HTTP_GET, []() { sendForm(); });
  web->on("/save", HTTP_POST, handleSave);
  web->onNotFound([apIp]() {
    web->sendHeader("Location", "http://" + apIp.toString() + "/");
    web->send(302, "text/plain", "");
  });
  web->begin();
  Serial.printf("setup: WiFi %s, page at http://%s/\n", ap.c_str(), apIp.toString().c_str());

  bool configured = cfg.ssid.length() > 0;
  showScreen(COL_SETUP, "KIPCast setup", {
      "1. On your phone, join the WiFi network " + ap,
      "2. The setup page opens by itself. If it doesn't, browse to http://" + apIp.toString(),
      "3. Choose the boat's WiFi and an id for this screen, then save."},
    configured ? "Tap the screen to leave setup without changes" : "");

  uint32_t started = millis(), lastTouch = millis();
  bool released = false;  // ignore the hold that opened setup
  while (true) {
    dns->processNextRequest();
    web->handleClient();
    if (saved) {
      showScreen(COL_SETUP, "Saved", {"Restarting..."});
      delay(1500);
      ESP.restart();
    }
    int x, y;
    if (touch && readTouch(x, y)) {
      if (released && configured) ESP.restart();
      lastTouch = millis();
    } else if (millis() - lastTouch > 500) {
      released = true;
    }
    if (configured && millis() - started > SETUP_TIMEOUT_MS) ESP.restart();
    delay(2);
  }
}

/* ------------------------------------------------------------------ */

void setup() {
  Serial.begin(115200);
  // Give the PC a moment to reopen the USB serial port after a reset, or the
  // startup messages are lost.
  while (!Serial && millis() < 3000) delay(10);
  delay(200);
  Serial.println("KIPCast display starting");
  jpegBuf = (uint8_t *)heap_caps_malloc(MAX_JPEG_BYTES, MALLOC_CAP_SPIRAM);
  if (!jpegBuf) { Serial.println("PSRAM alloc failed: is OPI PSRAM enabled?"); while (true) delay(1000); }
  initDisplay();
  loadSettings();
  Serial.printf("display id %s, server %s\n", cfg.id.c_str(), cfg.host.length() ? cfg.host.c_str() : "auto");
  if (cfg.ssid.isEmpty()) runSetup();
  // A moment to touch and hold for setup before anything else happens.
  showStatus(COL_WIFI, "Starting");
  waitOrSetup(2500);
}

void loop() {
  ensureLink();
  pumpNetwork();
  pollTouch();
  if (millis() - lastTx > 10000) sendLine("P");  // lets both ends notice a dead link
  delay(1);
}
