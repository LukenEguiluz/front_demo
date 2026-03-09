const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'maletas.db');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
require('./init-db.js');
const db = new Database(dbPath);

app.use(cors());
app.use(express.json());

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/x/g, () =>
    ((Math.random() * 16) | 0).toString(16)
  );
}

// --- Maletas ---

app.get('/api/maletas', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, nombre, master_rfid, parent_maleta_id, created_at
      FROM maletas ORDER BY created_at DESC
    `).all();
    const maletas = rows.map((r) => {
      const productIds = db.prepare('SELECT producto_id FROM maleta_productos WHERE maleta_id = ?')
        .all(r.id).map((x) => x.producto_id);
      const productRfids = productIds.length
        ? db.prepare(
            'SELECT rfid FROM productos WHERE id IN (' + productIds.map(() => '?').join(',') + ')'
          ).all(...productIds).map((p) => p.rfid)
        : [];
      return {
        id: r.id,
        nombre: r.nombre,
        masterRfid: r.master_rfid || '',
        parentMaletaId: r.parent_maleta_id || null,
        createdAt: r.created_at,
        productRfids,
      };
    });
    console.log('[DB READ] GET /api/maletas ->', maletas.length, 'maleta(s):', maletas.map((m) => ({ id: m.id, nombre: m.nombre, masterRfid: m.masterRfid, productos: m.productRfids?.length ?? 0 })));
    res.json(maletas);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/maletas/:id', (req, res) => {
  try {
    const row = db.prepare(
      'SELECT id, nombre, master_rfid, parent_maleta_id, created_at FROM maletas WHERE id = ?'
    ).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Maleta no encontrada' });
    const productIds = db.prepare(
      'SELECT producto_id FROM maleta_productos WHERE maleta_id = ?'
    ).all(req.params.id).map((r) => r.producto_id);
    const productos = productIds.length
      ? db.prepare(
          'SELECT id, rfid, referencia, descripcion, lote, caducidad, created_at FROM productos WHERE id IN (' +
            productIds.map(() => '?').join(',') +
            ')'
        ).all(...productIds)
      : [];
    const productRfids = productos.map((p) => p.rfid);
    const payload = {
      id: row.id,
      nombre: row.nombre,
      masterRfid: row.master_rfid || '',
      parentMaletaId: row.parent_maleta_id || null,
      createdAt: row.created_at,
      productRfids,
      productos: productos.map((p) => ({
        id: p.id,
        rfid: p.rfid,
        referencia: p.referencia,
        descripcion: p.descripcion,
        lote: p.lote,
        caducidad: p.caducidad,
        createdAt: p.created_at,
      })),
    };
    console.log('[DB READ] GET /api/maletas/' + req.params.id, '-> maleta', row.nombre, '|', productos.length, 'producto(s):', productRfids);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/maletas', (req, res) => {
  try {
    const { nombre, masterRfid, parentMaletaId } = req.body;
    const id = uuid();
    const created_at = new Date().toISOString();
    db.prepare(
      'INSERT INTO maletas (id, nombre, master_rfid, parent_maleta_id, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, nombre || 'Sin nombre', masterRfid || null, parentMaletaId || null, created_at);
    console.log('[DB WRITE] POST /api/maletas -> maleta guardada:', { id, nombre: nombre || 'Sin nombre', masterRfid: masterRfid || '' });
    res.status(201).json({
      id,
      nombre: nombre || 'Sin nombre',
      masterRfid: masterRfid || '',
      parentMaletaId: parentMaletaId || null,
      createdAt: created_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/maletas/:id', (req, res) => {
  try {
    const { nombre, masterRfid, parentMaletaId } = req.body;
    const id = req.params.id;
    db.prepare(
      'UPDATE maletas SET nombre = ?, master_rfid = ?, parent_maleta_id = ? WHERE id = ?'
    ).run(nombre ?? '', masterRfid ?? null, parentMaletaId ?? null, id);
    const row = db.prepare('SELECT id, nombre, master_rfid, parent_maleta_id, created_at FROM maletas WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Maleta no encontrada' });
    res.json({
      id: row.id,
      nombre: row.nombre,
      masterRfid: row.master_rfid || '',
      parentMaletaId: row.parent_maleta_id || null,
      createdAt: row.created_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/maletas/:id', (req, res) => {
  try {
    const r = db.prepare('DELETE FROM maletas WHERE id = ?').run(req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Maleta no encontrada' });
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Productos de una maleta (orden dentro de la maleta no se guarda; se devuelve por orden de creación)
app.get('/api/maletas/:id/productos', (req, res) => {
  try {
    const ids = db.prepare('SELECT producto_id FROM maleta_productos WHERE maleta_id = ?')
      .all(req.params.id).map((r) => r.producto_id);
    if (ids.length === 0) return res.json([]);
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, rfid, referencia, descripcion, lote, caducidad, created_at FROM productos WHERE id IN (${placeholders})`
    ).all(...ids);
    res.json(rows.map((p) => ({
      id: p.id,
      rfid: p.rfid,
      referencia: p.referencia,
      descripcion: p.descripcion,
      lote: p.lote,
      caducidad: p.caducidad,
      createdAt: p.created_at,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/maletas/:id/productos', (req, res) => {
  try {
    const maletaId = req.params.id;
    const { productoId } = req.body;
    if (!productoId) return res.status(400).json({ error: 'productoId requerido' });
    db.prepare('INSERT OR IGNORE INTO maleta_productos (maleta_id, producto_id) VALUES (?, ?)').run(maletaId, productoId);
    res.status(201).json({ maletaId, productoId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/maletas/:maletaId/productos/:productoId', (req, res) => {
  try {
    const r = db.prepare('DELETE FROM maleta_productos WHERE maleta_id = ? AND producto_id = ?')
      .run(req.params.maletaId, req.params.productoId);
    if (r.changes === 0) return res.status(404).json({ error: 'Relación no encontrada' });
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Productos (RFID: referencia, descripcion, lote, caducidad) ---

app.get('/api/productos', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, rfid, referencia, descripcion, lote, caducidad, created_at
      FROM productos ORDER BY created_at DESC
    `).all();
    res.json(rows.map((p) => ({
      id: p.id,
      rfid: p.rfid,
      referencia: p.referencia,
      descripcion: p.descripcion,
      lote: p.lote,
      caducidad: p.caducidad,
      createdAt: p.created_at,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/productos/:id', (req, res) => {
  try {
    const row = db.prepare(
      'SELECT id, rfid, referencia, descripcion, lote, caducidad, created_at FROM productos WHERE id = ?'
    ).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({
      id: row.id,
      rfid: row.rfid,
      referencia: row.referencia,
      descripcion: row.descripcion,
      lote: row.lote,
      caducidad: row.caducidad,
      createdAt: row.created_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/productos/by-rfid/:rfid', (req, res) => {
  try {
    const row = db.prepare(
      'SELECT id, rfid, referencia, descripcion, lote, caducidad, created_at FROM productos WHERE rfid = ?'
    ).get(req.params.rfid);
    if (!row) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({
      id: row.id,
      rfid: row.rfid,
      referencia: row.referencia,
      descripcion: row.descripcion,
      lote: row.lote,
      caducidad: row.caducidad,
      createdAt: row.created_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/productos', (req, res) => {
  try {
    const { rfid, referencia, descripcion, lote, caducidad } = req.body;
    if (!rfid || !String(rfid).trim()) return res.status(400).json({ error: 'rfid requerido' });
    const id = uuid();
    const created_at = new Date().toISOString();
    db.prepare(
      'INSERT INTO productos (id, rfid, referencia, descripcion, lote, caducidad, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, String(rfid).trim(), referencia || null, descripcion || null, lote || null, caducidad || null, created_at);
    res.status(201).json({
      id,
      rfid: String(rfid).trim(),
      referencia: referencia || null,
      descripcion: descripcion || null,
      lote: lote || null,
      caducidad: caducidad || null,
      createdAt: created_at,
    });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Ya existe un producto con ese RFID' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/productos/:id', (req, res) => {
  try {
    const { rfid, referencia, descripcion, lote, caducidad } = req.body;
    const id = req.params.id;
    db.prepare(
      'UPDATE productos SET rfid = ?, referencia = ?, descripcion = ?, lote = ?, caducidad = ? WHERE id = ?'
    ).run(rfid ?? '', referencia ?? null, descripcion ?? null, lote ?? null, caducidad ?? null, id);
    const row = db.prepare('SELECT id, rfid, referencia, descripcion, lote, caducidad, created_at FROM productos WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({
      id: row.id,
      rfid: row.rfid,
      referencia: row.referencia,
      descripcion: row.descripcion,
      lote: row.lote,
      caducidad: row.caducidad,
      createdAt: row.created_at,
    });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Ya existe un producto con ese RFID' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/productos/:id', (req, res) => {
  try {
    const r = db.prepare('DELETE FROM productos WHERE id = ?').run(req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Crear producto y asociarlo a maleta en una sola llamada (útil para el front)
app.post('/api/maletas/:id/productos/nuevo', (req, res) => {
  try {
    const maletaId = req.params.id;
    const { rfid, referencia, descripcion, lote, caducidad } = req.body;
    if (!rfid || !String(rfid).trim()) return res.status(400).json({ error: 'rfid requerido' });
    let row = db.prepare('SELECT id FROM productos WHERE rfid = ?').get(String(rfid).trim());
    let productoId;
    if (row) {
      productoId = row.id;
    } else {
      productoId = uuid();
      const created_at = new Date().toISOString();
      db.prepare(
        'INSERT INTO productos (id, rfid, referencia, descripcion, lote, caducidad, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(productoId, String(rfid).trim(), referencia || null, descripcion || null, lote || null, caducidad || null, created_at);
    }
    db.prepare('INSERT OR IGNORE INTO maleta_productos (maleta_id, producto_id) VALUES (?, ?)').run(maletaId, productoId);
    row = db.prepare('SELECT id, rfid, referencia, descripcion, lote, caducidad, created_at FROM productos WHERE id = ?').get(productoId);
    console.log('[DB WRITE] POST /api/maletas/' + maletaId + '/productos/nuevo -> producto guardado/asociado:', { productoId: row.id, rfid: row.rfid, referencia: row.referencia, lote: row.lote, caducidad: row.caducidad });
    res.status(201).json({
      id: row.id,
      rfid: row.rfid,
      referencia: row.referencia,
      descripcion: row.descripcion,
      lote: row.lote,
      caducidad: row.caducidad,
      createdAt: row.created_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health
app.get('/api/health', (req, res) => res.json({ ok: true }));

// 404: responder con JSON para no usar el handler por defecto de Express que añade
// Content-Security-Policy: default-src 'none' (bloquea fuentes y DevTools)
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Backend maletas escuchando en http://localhost:${PORT}`);
});
