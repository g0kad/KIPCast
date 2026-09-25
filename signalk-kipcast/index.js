'use strict';
const path = require('path');
const { KIPCast, DEFAULTS, FIRMWARE_INSTALLER } = require('./lib/kipcast');

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
      width: { type: 'number', title: 'Default width (px), for displays that don\'t report their size', default: DEFAULTS.width },
      height: { type: 'number', title: 'Default height (px), for displays that don\'t report their size', default: DEFAULTS.height },
      jpegQuality: { type: 'number', title: 'JPEG quality (10-95)', default: DEFAULTS.jpegQuality },
      maxFps: { type: 'number', title: 'Max frames per second per display', default: DEFAULTS.maxFps },
      tcpPort: { type: 'number', title: 'Display (ESP32) TCP port', default: DEFAULTS.tcpPort },
      httpPort: { type: 'number', title: 'Browser viewer port', default: DEFAULTS.httpPort },
      inputMode: { type: 'string', title: 'Input mode', enum: ['touch', 'mouse'], default: DEFAULTS.inputMode },
      chromiumPath: { type: 'string', title: 'Chromium path (blank = auto-detect)', default: '' },
      viewerAuth: {
        type: 'boolean',
        title: 'Browser viewer needs a Signal K login (open it from Webapps → KIPCast)',
        default: true,
      },
    },
  };

  plugin.start = (options) => {
    cast = new KIPCast({
      ...options,
      viewerAuth: options.viewerAuth !== false,  // on unless turned off
      profilesDir: path.join(app.getDataDirPath(), 'chrome-profiles'),
      seedProfileDir: path.join(app.getDataDirPath(), 'chrome-profile'),
      displaysFile: path.join(app.getDataDirPath(), 'displays.json'),
      log: (m) => app.debug(m),
      status: (s) => app.setPluginStatus(s),
      error: (m) => app.setPluginError(m),
    });
    cast.start().catch((e) => app.setPluginError(e.message));
  };

  // Backs the KIPCast webapp (public/index.html), at /plugins/signalk-kipcast/.
  // Behind Signal K's own login; the viewer port gets in with a pass from here.
  plugin.registerWithRouter = (router) => {
    const running = (res) => cast || (res.status(503).json({ error: 'KIPCast is not running' }), null);

    router.get('/displays', (req, res) => {
      if (!running(res)) return;
      res.json({
        viewerPort: cast.opts.httpPort,
        defaultSize: { width: cast.opts.width, height: cast.opts.height },
        latestFirmware: cast.opts.latestFirmware,
        firmwareInstaller: FIRMWARE_INSTALLER,
        displays: cast.listDisplays(),
      });
    });

    router.post('/displays', async (req, res) => {
      if (!running(res)) return;
      try {
        const body = req.body && Object.keys(req.body).length ? req.body : await readJson(req);
        const id = cast.addDisplay(body.id, +body.width, +body.height);
        res.json({ id });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    // A one-time pass that lets this browser into the viewer port. Only
    // reachable with a Signal K login, so the viewer inherits it.
    router.post('/viewer-pass', (req, res) => {
      if (!running(res)) return;
      res.json({ pass: cast.opts.viewerAuth ? cast.issueViewerPass() : null });
    });

    router.delete('/displays/:id', (req, res) => {
      if (!running(res)) return;
      cast.forgetDisplay(req.params.id);
      res.json({ ok: true });
    });
  };

  plugin.stop = async () => {
    if (cast) await cast.stop();
    cast = null;
  };

  return plugin;
};

// For when Signal K hasn't already parsed the JSON body.
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
