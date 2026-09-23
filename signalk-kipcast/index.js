'use strict';
const path = require('path');
const { KIPCast, DEFAULTS } = require('./lib/kipcast');

module.exports = function (app) {
  let cast = null;

  const plugin = {
    id: 'signalk-kipcast',
    name: 'KIPCast',
    description: 'Cast live KIP dashboards to ESP32 touchscreens',
  };

  plugin.schema = {
    type: 'object',
    properties: {
      url: { type: 'string', title: 'Dashboard URL', default: DEFAULTS.url },
      width: { type: 'number', title: 'Display width (px)', default: DEFAULTS.width },
      height: { type: 'number', title: 'Display height (px)', default: DEFAULTS.height },
      jpegQuality: { type: 'number', title: 'JPEG quality (10-95)', default: DEFAULTS.jpegQuality },
      maxFps: { type: 'number', title: 'Max frames per second per display', default: DEFAULTS.maxFps },
      tcpPort: { type: 'number', title: 'Display (ESP32) TCP port', default: DEFAULTS.tcpPort },
      httpPort: { type: 'number', title: 'Browser viewer port', default: DEFAULTS.httpPort },
      inputMode: { type: 'string', title: 'Input mode', enum: ['touch', 'mouse'], default: DEFAULTS.inputMode },
      chromiumPath: { type: 'string', title: 'Chromium path (blank = auto-detect)', default: '' },
    },
  };

  plugin.start = (options) => {
    cast = new KIPCast({
      ...options,
      userDataDir: path.join(app.getDataDirPath(), 'chrome-profile'),
      log: (m) => app.debug(m),
      status: (s) => app.setPluginStatus(s),
      error: (m) => app.setPluginError(m),
    });
    cast.start().catch((e) => app.setPluginError(e.message));
  };

  plugin.stop = async () => {
    if (cast) await cast.stop();
    cast = null;
  };

  return plugin;
};
