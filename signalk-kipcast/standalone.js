'use strict';
// Run KIPCast outside Signal K while developing:
//   node standalone.js
//   KIPCAST_URL=http://openplotter.local:3000/@mxtommy/kip/ node standalone.js
const { KIPCast } = require('./lib/kipcast');

const cast = new KIPCast({
  url: process.env.KIPCAST_URL,
  jpegQuality: process.env.KIPCAST_QUALITY && +process.env.KIPCAST_QUALITY,
  maxFps: process.env.KIPCAST_FPS && +process.env.KIPCAST_FPS,
  inputMode: process.env.KIPCAST_INPUT,
  chromiumPath: process.env.KIPCAST_CHROMIUM,
  status: (s) => console.log(`status: ${s}`),
});

cast.start().catch((e) => { console.error(e.message); process.exit(1); });

const shutdown = async () => { await cast.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
