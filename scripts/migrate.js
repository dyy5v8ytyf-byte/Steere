'use strict';
const db = require('../lib/db');
(async () => { await db.migrate(); await db.pool.end(); })()
  .catch((e) => { console.error(e); process.exit(1); });
