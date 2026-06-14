const express = require('express');
const router = express.Router();
const pool = require('./db');
require('dotenv').config();
 
// Получить профиль и статус членства по telegram_id
router.get('/user/:telegramId', async (req, res) => {
  const { telegramId } = req.params;
 
  try {
    const result = await pool.query(`
      SELECT
        u.id, u.telegram_id, u.full_name, u.email, u.phone,
        m.status AS membership_status,
        m.expires_at,
        m.started_at
      FROM users u
      LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
      WHERE u.telegram_id = $1
      ORDER BY m.expires_at DESC
      LIMIT 1
    `, [telegramId]);
 
    if (result.rows.length === 0) {
      return res.json({ exists: false });
    }
 
    const user = result.rows[0];
    res.json({
      exists: true,
      fullName: user.full_name,
      email: user.email,
      phone: user.phone,
      membership: user.membership_status ? {
        status: user.membership_status,
        expiresAt: user.expires_at,
        startedAt: user.started_at,
      } : null
    });
 
  } catch (err) {
    console.error('Ошибка GET /user:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// Обновить email пользователя
router.patch('/user/:telegramId/email', express.json(), async (req, res) => {
  const { telegramId } = req.params;
  const { email } = req.body;
 
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Некорректный email' });
  }
 
  try {
    await pool.query(
      'UPDATE users SET email = $1 WHERE telegram_id = $2',
      [email, telegramId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка PATCH /email:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// Сохранить номер телефона пользователя (из Telegram requestContact)
router.post('/user/:telegramId/phone', express.json(), async (req, res) => {
  const { telegramId } = req.params;
  const { phone } = req.body;
 
  if (!phone) {
    return res.status(400).json({ error: 'phone обязателен' });
  }
 
  try {
    await pool.query(`
      INSERT INTO users (telegram_id, phone)
      VALUES ($1, $2)
      ON CONFLICT (telegram_id)
      DO UPDATE SET phone = EXCLUDED.phone
    `, [telegramId, phone]);
 
    res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка POST /phone:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// История платежей пользователя
router.get('/user/:telegramId/payments', async (req, res) => {
  const { telegramId } = req.params;
 
  try {
    const result = await pool.query(`
      SELECT p.prodamus_order_id, p.amount, p.status, p.paid_at, p.created_at
      FROM payments p
      JOIN users u ON u.id = p.user_id
      WHERE u.telegram_id = $1
      ORDER BY p.created_at DESC
      LIMIT 20
    `, [telegramId]);
 
    res.json({ payments: result.rows });
  } catch (err) {
    console.error('Ошибка GET /payments:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// Upsert пользователя при входе через Telegram
router.post('/user/auth', express.json(), async (req, res) => {
  const { telegramId, fullName } = req.body;
 
  if (!telegramId) {
    return res.status(400).json({ error: 'telegramId обязателен' });
  }
 
  try {
    await pool.query(`
      INSERT INTO users (telegram_id, full_name)
      VALUES ($1, $2)
      ON CONFLICT (telegram_id)
      DO UPDATE SET full_name = COALESCE(EXCLUDED.full_name, users.full_name)
    `, [telegramId, fullName || null]);
 
    res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка POST /auth:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
module.exports = router;
