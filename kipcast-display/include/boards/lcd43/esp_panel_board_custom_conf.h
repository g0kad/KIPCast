/*
 * Waveshare ESP32-S3-Touch-LCD-4.3 (and 4.3B)
 *
 * Electrically the same as the 7": 800x480 ST7262 on the same RGB pins,
 * GT911 touch, CH422G IO expander. ESP32_Display_Panel's own configs for
 * the two boards differ only in the name, so this reuses the 7" config,
 * including its tuning (12 MHz PCLK, larger bounce buffer).
 */
#pragma once

#include "../lcd7/esp_panel_board_custom_conf.h"

#undef  ESP_PANEL_BOARD_NAME
#define ESP_PANEL_BOARD_NAME                "Waveshare:ESP32-S3-Touch-LCD-4.3"
