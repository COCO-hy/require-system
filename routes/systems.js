const express = require('express');
const router = express.Router();
const { db, now } = require('../db');

// GET /api/systems - List all systems
router.get('/', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM systems ORDER BY name ASC').all();
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/systems/:id - Get single system
router.get('/:id', (req, res) => {
  try {
    const sys = db.prepare('SELECT * FROM systems WHERE id = ?').get(req.params.id);
    if (!sys) return res.status(404).json({ success: false, error: '系统不存在' });
    // Count requirements under this system
    const count = db.prepare('SELECT COUNT(*) as c FROM requirements WHERE system_id = ?').get(req.params.id);
    res.json({ success: true, data: { ...sys, requirement_count: count.c } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/systems - Create a system
router.post('/', (req, res) => {
  try {
    const { name, gitee_repo, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: '系统名称不能为空' });
    }
    const stmt = db.prepare('INSERT INTO systems (name, gitee_repo, description) VALUES (?, ?, ?)');
    const result = stmt.run(name.trim(), gitee_repo || '', description || '');
    res.json({ success: true, data: { id: result.lastInsertRowid } });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ success: false, error: '系统名称已存在' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/systems/:id - Update a system
router.put('/:id', (req, res) => {
  try {
    const { name, gitee_repo, description } = req.body;
    const existing = db.prepare('SELECT * FROM systems WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: '系统不存在' });

    db.prepare(
      'UPDATE systems SET name = ?, gitee_repo = ?, description = ?, updated_at = ? WHERE id = ?'
    ).run(
      name || existing.name,
      gitee_repo !== undefined ? gitee_repo : existing.gitee_repo,
      description !== undefined ? description : existing.description,
      now(),
      req.params.id
    );
    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ success: false, error: '系统名称已存在' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/systems/:id - Delete a system
router.delete('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM systems WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: '系统不存在' });

    // Unlink requirements that belong to this system
    db.prepare('UPDATE requirements SET system_id = NULL WHERE system_id = ?').run(req.params.id);
    db.prepare('DELETE FROM systems WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
