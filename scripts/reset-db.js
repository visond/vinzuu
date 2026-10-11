'use strict';
// Deletes the local database so the next start re-creates it (with demo data unless SEED_DEMO=false).
const fs = require('fs');
const { DEFAULT_DB_PATH } = require('../db');

const file = process.env.DB_PATH || DEFAULT_DB_PATH;
for (const f of [file, `${file}-wal`, `${file}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
console.log(`Removed ${file}. Run "npm start" to create a fresh database.`);
