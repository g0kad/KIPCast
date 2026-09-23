/*
 * SPDX-FileCopyrightText: 2023-2025 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * ESP32_Display_Panel board config for the Waveshare ESP32-S3-Touch-LCD-4, Rev4.0 (480x480).
 *
 * Pins, timings and the ST7701 init sequence come from Waveshare's BSP
 * (waveshare/esp32_s3_touch_lcd_4 v3.0.0 on the ESP component registry), with
 * the layout of this library's Jingcai ESP32-4848S040 config (also ST7701).
 *
 * Rev4 uses a CH32V003 as its IO expander, which this library doesn't know,
 * so the expander is disabled here: main.cpp powers the panel and pulses the
 * LCD/touch resets through it before the board starts (see ch32PowerOn()).
 */

#pragma once

// *INDENT-OFF*
#define ESP_PANEL_BOARD_DEFAULT_USE_CUSTOM  (1)

#if ESP_PANEL_BOARD_DEFAULT_USE_CUSTOM

#define ESP_PANEL_BOARD_NAME                "Waveshare:ESP32-S3-Touch-LCD-4-Rev4"
#define ESP_PANEL_BOARD_WIDTH               (480)
#define ESP_PANEL_BOARD_HEIGHT              (480)

/* ---------------------------------------------------------------- LCD ---- */
#define ESP_PANEL_BOARD_USE_LCD             (1)
#define ESP_PANEL_BOARD_LCD_CONTROLLER      ST7701
#define ESP_PANEL_BOARD_LCD_BUS_TYPE        (ESP_PANEL_BUS_TYPE_RGB)

    // ST7701 is set up over a bit-banged 3-wire SPI before RGB streaming starts.
    #define ESP_PANEL_BOARD_LCD_RGB_USE_CONTROL_PANEL       (1)
    #define ESP_PANEL_BOARD_LCD_RGB_SPI_IO_CS               (42)
    #define ESP_PANEL_BOARD_LCD_RGB_SPI_IO_SCK              (2)
    #define ESP_PANEL_BOARD_LCD_RGB_SPI_IO_SDA              (1)
    #define ESP_PANEL_BOARD_LCD_RGB_SPI_CS_USE_EXPNADER     (0)
    #define ESP_PANEL_BOARD_LCD_RGB_SPI_SCL_USE_EXPNADER    (0)
    #define ESP_PANEL_BOARD_LCD_RGB_SPI_SDA_USE_EXPNADER    (0)
    #define ESP_PANEL_BOARD_LCD_RGB_SPI_MODE                (0)
    #define ESP_PANEL_BOARD_LCD_RGB_SPI_CMD_BYTES           (1)
    #define ESP_PANEL_BOARD_LCD_RGB_SPI_PARAM_BYTES         (1)
    #define ESP_PANEL_BOARD_LCD_RGB_SPI_USE_DC_BIT          (1)

    // Waveshare runs 16 MHz (60 Hz). 12 MHz, as on the 7", leaves PSRAM
    // headroom for WiFi and still refreshes at ~45 Hz.
    #define ESP_PANEL_BOARD_LCD_RGB_CLK_HZ          (12 * 1000 * 1000)
    #define ESP_PANEL_BOARD_LCD_RGB_HPW             (10)
    #define ESP_PANEL_BOARD_LCD_RGB_HBP             (10)
    #define ESP_PANEL_BOARD_LCD_RGB_HFP             (20)
    #define ESP_PANEL_BOARD_LCD_RGB_VPW             (10)
    #define ESP_PANEL_BOARD_LCD_RGB_VBP             (10)
    #define ESP_PANEL_BOARD_LCD_RGB_VFP             (10)
    #define ESP_PANEL_BOARD_LCD_RGB_PCLK_ACTIVE_NEG (0)
    #define ESP_PANEL_BOARD_LCD_RGB_DATA_WIDTH      (16)
    #define ESP_PANEL_BOARD_LCD_RGB_PIXEL_BITS      (ESP_PANEL_LCD_COLOR_BITS_RGB565)
    // Must satisfy size * N = 480 * 480 with N even: 480 * 20 gives N = 24.
    #define ESP_PANEL_BOARD_LCD_RGB_BOUNCE_BUF_SIZE (ESP_PANEL_BOARD_WIDTH * 20)
    #define ESP_PANEL_BOARD_LCD_RGB_IO_HSYNC        (38)
    #define ESP_PANEL_BOARD_LCD_RGB_IO_VSYNC        (39)
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DE           (40)
    #define ESP_PANEL_BOARD_LCD_RGB_IO_PCLK         (41)
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DISP         (-1)
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DATA0        (5)     // B0
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DATA1        (45)    // B1
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DATA2        (48)    // B2
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DATA3        (47)    // B3
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DATA4        (21)    // B4
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DATA5        (14)    // G0
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DATA6        (13)    // G1
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DATA7        (12)    // G2
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DATA8        (11)    // G3
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DATA9        (10)    // G4
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DATA10       (9)     // G5
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DATA11       (46)    // R0
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DATA12       (3)     // R1
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DATA13       (8)     // R2
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DATA14       (18)    // R3
    #define ESP_PANEL_BOARD_LCD_RGB_IO_DATA15       (17)    // R4

#define ESP_PANEL_BOARD_LCD_FLAGS_ENABLE_IO_MULTIPLEX       (0)
#define ESP_PANEL_BOARD_LCD_FLAGS_MIRROR_BY_CMD             (1)

// Waveshare's Rev4 sequence (esp32_s3_touch_lcd_4.c, lcd_init_cmds[]).
#define ESP_PANEL_BOARD_LCD_VENDOR_INIT_CMD()                       \
    {                                                               \
        ESP_PANEL_LCD_CMD_WITH_NONE_PARAM(120, 0x11), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xFF, {0x77, 0x01, 0x00, 0x00, 0x10}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xC0, {0x3B, 0x00}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xC1, {0x0D, 0x02}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xC2, {0x21, 0x08}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xCD, {0x08}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xB0, {0x00, 0x11, 0x18, 0x0E, 0x11, 0x06, 0x07, 0x08, 0x07, 0x22, 0x04, 0x12, 0x0F, 0xAA, 0x31, 0x18}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xB1, {0x00, 0x11, 0x19, 0x0E, 0x12, 0x07, 0x08, 0x08, 0x08, 0x22, 0x04, 0x11, 0x11, 0xA9, 0x32, 0x18}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xFF, {0x77, 0x01, 0x00, 0x00, 0x11}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xB0, {0x60}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xB1, {0x30}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xB2, {0x87}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xB3, {0x80}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xB5, {0x49}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xB7, {0x85}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xB8, {0x21}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xC1, {0x78}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(20, 0xC2, {0x78}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xE0, {0x00, 0x1B, 0x02}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xE1, {0x08, 0xA0, 0x00, 0x00, 0x07, 0xA0, 0x00, 0x00, 0x00, 0x44, 0x44}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xE2, {0x11, 0x11, 0x44, 0x44, 0xED, 0xA0, 0x00, 0x00, 0xEC, 0xA0, 0x00, 0x00}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xE3, {0x00, 0x00, 0x11, 0x11}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xE4, {0x44, 0x44}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xE5, {0x0A, 0xE9, 0xD8, 0xA0, 0x0C, 0xEB, 0xD8, 0xA0, 0x0E, 0xED, 0xD8, 0xA0, 0x10, 0xEF, 0xD8, 0xA0}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xE6, {0x00, 0x00, 0x11, 0x11}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xE7, {0x44, 0x44}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xE8, {0x09, 0xE8, 0xD8, 0xA0, 0x0B, 0xEA, 0xD8, 0xA0, 0x0D, 0xEC, 0xD8, 0xA0, 0x0F, 0xEE, 0xD8, 0xA0}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xEB, {0x02, 0x00, 0xE4, 0xE4, 0x88, 0x00, 0x40}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xEC, {0x3C, 0x00}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xED, {0xAB, 0x89, 0x76, 0x54, 0x02, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x20, 0x45, 0x67, 0x98, 0xBA}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0xFF, {0x77, 0x01, 0x00, 0x00, 0x00}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0x36, {0x00}), \
        ESP_PANEL_LCD_CMD_WITH_8BIT_PARAM(0, 0x3A, {0x66}), \
        ESP_PANEL_LCD_CMD_WITH_NONE_PARAM(120, 0x21), \
        ESP_PANEL_LCD_CMD_WITH_NONE_PARAM(0, 0x29), \
    }

#define ESP_PANEL_BOARD_LCD_COLOR_BITS          (ESP_PANEL_LCD_COLOR_BITS_RGB666)
#define ESP_PANEL_BOARD_LCD_COLOR_BGR_ORDER     (0)
// Waveshare's sequence turns inversion on (0x21), but on this panel that
// shows dark pages as white. The board applies this flag after init, so 0
// switches inversion back off.
#define ESP_PANEL_BOARD_LCD_COLOR_INEVRT_BIT    (0)
#define ESP_PANEL_BOARD_LCD_SWAP_XY             (0)
// Mirroring both axes turns the image 180 degrees; unmirrored it's upside
// down (Waveshare's own Arduino demos use rotation 2 for the same reason).
#define ESP_PANEL_BOARD_LCD_MIRROR_X            (1)
#define ESP_PANEL_BOARD_LCD_MIRROR_Y            (1)
#define ESP_PANEL_BOARD_LCD_GAP_X               (0)
#define ESP_PANEL_BOARD_LCD_GAP_Y               (0)
#define ESP_PANEL_BOARD_LCD_RST_IO              (-1)    // on the CH32 expander, handled by ch32PowerOn()
#define ESP_PANEL_BOARD_LCD_RST_LEVEL           (0)

/* -------------------------------------------------------------- Touch ---- */
#define ESP_PANEL_BOARD_USE_TOUCH               (1)
#define ESP_PANEL_BOARD_TOUCH_CONTROLLER        GT911
#define ESP_PANEL_BOARD_TOUCH_BUS_TYPE          (ESP_PANEL_BUS_TYPE_I2C)
#define ESP_PANEL_BOARD_TOUCH_BUS_SKIP_INIT_HOST        (0)
    #define ESP_PANEL_BOARD_TOUCH_I2C_HOST_ID           (0)
    #define ESP_PANEL_BOARD_TOUCH_I2C_CLK_HZ            (400 * 1000)
    #define ESP_PANEL_BOARD_TOUCH_I2C_SCL_PULLUP        (1)
    #define ESP_PANEL_BOARD_TOUCH_I2C_SDA_PULLUP        (1)
    #define ESP_PANEL_BOARD_TOUCH_I2C_IO_SCL            (7)
    #define ESP_PANEL_BOARD_TOUCH_I2C_IO_SDA            (15)
    #define ESP_PANEL_BOARD_TOUCH_I2C_ADDRESS           (0)
#define ESP_PANEL_BOARD_TOUCH_SWAP_XY           (0)
#define ESP_PANEL_BOARD_TOUCH_MIRROR_X          (1)     // match the 180 degree panel rotation
#define ESP_PANEL_BOARD_TOUCH_MIRROR_Y          (1)
#define ESP_PANEL_BOARD_TOUCH_RST_IO            (-1)    // on the CH32 expander, handled by ch32PowerOn()
#define ESP_PANEL_BOARD_TOUCH_RST_LEVEL         (0)
#define ESP_PANEL_BOARD_TOUCH_INT_IO            (-1)    // not wired on Rev4
#define ESP_PANEL_BOARD_TOUCH_INT_LEVEL         (0)

/* ---------------------------------------------- Backlight / expander ---- */
// The backlight is driven by the CH32 expander's PWM, which powers up on.
#define ESP_PANEL_BOARD_USE_BACKLIGHT           (0)
#define ESP_PANEL_BOARD_USE_EXPANDER            (0)

#define ESP_PANEL_BOARD_CUSTOM_FILE_VERSION_MAJOR 1
#define ESP_PANEL_BOARD_CUSTOM_FILE_VERSION_MINOR 0
#define ESP_PANEL_BOARD_CUSTOM_FILE_VERSION_PATCH 0

#endif // ESP_PANEL_BOARD_DEFAULT_USE_CUSTOM
// *INDENT-ON*
