// Updates the board's ESP32-C6 (the ESP-Hosted co-processor that does its
// WiFi) to the firmware version this Arduino core expects, downloading it
// from Espressif. Joins the WiFi network KIPCast saved on the board.
#include <Arduino.h>
#include <WiFi.h>
#include <Preferences.h>
#include "ESP_HostedOTA.h"
#include "esp32-hal-hosted.h"

void setup() {
  Serial.begin(115200);
  delay(500);
  Preferences prefs;
  prefs.begin("kipcast", true);
  String ssid = prefs.getString("ssid", ""), pass = prefs.getString("pass", "");
  prefs.end();
  if (ssid.isEmpty()) {
    Serial.println("No WiFi saved: install KIPCast and set the screen up first.");
    return;
  }
  WiFi.STA.begin();
  Serial.printf("Joining %s\n", ssid.c_str());
  WiFi.STA.connect(ssid.c_str(), pass.c_str());
  for (uint32_t t0 = millis(); WiFi.STA.status() != WL_CONNECTED; delay(250)) {
    if (millis() - t0 > 60000) { Serial.println("Couldn't join the WiFi."); return; }
  }
  uint32_t a, b, c;
  hostedGetHostVersion(&a, &b, &c);
  if (!hostedHasUpdate()) {
    Serial.printf("Versions Match: the WiFi chip is on %lu.%lu.%lu. Install KIPCast again.\n", a, b, c);
    return;
  }
  Serial.printf("Updating the WiFi chip to %lu.%lu.%lu. Keep the screen powered.\n", a, b, c);
  if (updateEspHostedSlave()) {
    Serial.println("\nDone, restarting to check.");
    delay(1000);
    ESP.restart();
  }
  Serial.println("\nUpdate failed; the WiFi chip keeps its old firmware.");
}

void loop() { delay(1000); }
