require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/store');

pool.query(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'))
  .then(() => { console.log('Database ready'); return pool.end(); })
  .catch(e => { console.error(e); process.exit(1); });
