const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'maletas.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS maletas (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    master_rfid TEXT,
    parent_maleta_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (parent_maleta_id) REFERENCES maletas(id)
  );

  CREATE TABLE IF NOT EXISTS productos (
    id TEXT PRIMARY KEY,
    rfid TEXT NOT NULL UNIQUE,
    referencia TEXT,
    descripcion TEXT,
    lote TEXT,
    caducidad TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS maleta_productos (
    maleta_id TEXT NOT NULL,
    producto_id TEXT NOT NULL,
    PRIMARY KEY (maleta_id, producto_id),
    FOREIGN KEY (maleta_id) REFERENCES maletas(id) ON DELETE CASCADE,
    FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_maletas_parent ON maletas(parent_maleta_id);
  CREATE INDEX IF NOT EXISTS idx_productos_rfid ON productos(rfid);
  CREATE INDEX IF NOT EXISTS idx_maleta_productos_maleta ON maleta_productos(maleta_id);
  CREATE INDEX IF NOT EXISTS idx_maleta_productos_producto ON maleta_productos(producto_id);
`);

db.close();
console.log('Base de datos inicializada en', dbPath);
