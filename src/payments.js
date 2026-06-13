const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const dayjs = require('dayjs');
const pool = require('./db');
const { notifyPaymentSuccess } = require('./bot');
require('dotenv').config();

// Проверка подписи Prodamus
function verifyProdamusSignature(body, signature) {
  const secret = process.env.PRODAMUS_SECRET_KEY;
  const hash = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(body))
    .digest('hex');
  return hash === signature;
}

// Webhook от Prodamus — вызывается после успешной оплаты
router.post('/prodamus/webhook', express.json(), async (req, res) => {
  try {
    const signature = req.headers['x-prodamus-signature'];

    // Проверяем подпись (безопасность)
    if (!verifyProdamusSignature(req.body, signature)) {
      console.warn('⚠️ Неверная подпись Prodamus');
      return res.status(403).json({ error: 'Invalid signature' });
    }

    const { order_id, status, customer_extra, amount } = req.body;

    // customer_extra — это telegram_id, который мы передаём при создании платежа
    const telegramId = customer_extra;

    if (status !== 'paid') {
      return res.json({ ok: true, message: 'Статус не paid, пропускаем' });
    }

    // Ищем или создаём пользователя
    let userResult = await pool.query(
      'SELECT id FROM users WHERE telegram_id = $1',
      [telegramId]
    );

    let userId;
    if (userResult.rows.length === 0) {
      const newUser = await pool.query(
        'INSERT INTO users (telegram_id) VALUES ($1) RETURNING id',
        [telegramId]
      );
      userId = newUser.rows[0].id;
    } else {
      userId = userResult.rows[0].id;
    }

    // Вычисляем срок членства
    const expiresAt = dayjs().add(process.env.MEMBERSHIP_DAYS, 'day').toDate();

    // Создаём членство
    const membership = await pool.query(
      `INSERT INTO memberships (user_id, status, expires_at)
       VALUES ($1, 'active', $2) RETURNING id`,
      [userId, expiresAt]
    );

    // Записываем платёж
    await pool.query(
      `INSERT INTO payments (user_id, prodamus_order_id, amount, status, membership_id, paid_at)
       VALUES ($1, $2, $3, 'paid', $4, NOW())`,
      [userId, order_id, amount, membership.rows[0].id]
    );

    // Уведомляем пользователя в Telegram
    await notifyPaymentSuccess(telegramId, expiresAt);

    console.log(`✅ Членство активировано: telegram_id=${telegramId}, до ${expiresAt}`);
    res.json({ ok: true });

  } catch (err) {
    console.error('❌ Ошибка webhook Prodamus:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Генерация ссылки на оплату Prodamus
router.post('/payment/create', express.json(), async (req, res) => {
  const { telegramId } = req.body;

  if (!telegramId) {
    return res.status(400).json({ error: 'telegramId обязателен' });
  }

  // Формируем ссылку на оплату Prodamus
  // Замените YOUR_PRODAMUS_LINK на вашу ссылку из личного кабинета Prodamus
  const paymentUrl = `https://YOUR_PRODAMUS_LINK?` +
    `sum=${process.env.MEMBERSHIP_PRICE}` +
    `&order_id=${Date.now()}` +
    `&customer_extra=${telegramId}` +
    `&do=pay`;

  res.json({ url: paymentUrl });
});

module.exports = router;
