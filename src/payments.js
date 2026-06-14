const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const dayjs = require('dayjs');
const pool = require('./db');
const { notifyPaymentSuccess } = require('./bot');
require('dotenv').config();
 
// ---------------------------------------------------------
// Подпись Prodamus (алгоритм HMAC-SHA256 по их документации)
// https://help.prodamus.ru/payform/integracii/api/podpis-zaprosa
// ---------------------------------------------------------
 
// Рекурсивная сортировка ключей объекта (нужна для подписи)
function sortObject(obj) {
  if (Array.isArray(obj)) {
    return obj.map(sortObject);
  }
  if (obj !== null && typeof obj === 'object') {
    var sorted = {};
    Object.keys(obj).sort().forEach(function (key) {
      sorted[key] = sortObject(obj[key]);
    });
    return sorted;
  }
  return obj;
}
 
// Генерация подписи для исходящего запроса (создание ссылки на оплату)
// Prodamus использует PHP json_encode (без JSON_UNESCAPED_SLASHES), поэтому
// экранируем слеши "/" -> "\/" как это делает PHP по умолчанию
function signData(data, secretKey) {
  var sorted = sortObject(data);
  var json = JSON.stringify(sorted).replace(/\//g, '\\/');
  return crypto.createHmac('sha256', secretKey).update(json).digest('hex');
}
 
// Проверка подписи входящего webhook
function verifyProdamusSignature(body, signature, secretKey) {
  var bodyCopy = Object.assign({}, body);
  delete bodyCopy.sign;
  delete bodyCopy.signature;
  var sorted = sortObject(bodyCopy);
  var json = JSON.stringify(sorted).replace(/\//g, '\\/');
  var hash = crypto.createHmac('sha256', secretKey).update(json).digest('hex');
  return hash === signature;
}
 
// ---------------------------------------------------------
// Webhook от Prodamus — вызывается после оплаты
// ---------------------------------------------------------
router.post('/prodamus/webhook', express.json(), async function (req, res) {
  try {
    var signature = req.headers['sign'] || req.headers['Sign'] || req.headers['x-prodamus-signature'] || req.body.signature || req.body.sign;
    var secretKey = process.env.PRODAMUS_SECRET_KEY;
 
    if (secretKey && signature) {
      var valid = verifyProdamusSignature(req.body, signature, secretKey);
      if (!valid) {
        console.warn('Invalid Prodamus signature');
        return res.status(403).json({ error: 'Invalid signature' });
      }
    } else {
      console.warn('PRODAMUS_SECRET_KEY not set - skipping signature check (DEV ONLY)');
    }
 
    var body = req.body;
    var orderId = body.order_id || body.order_num || (body.subscription && body.subscription_id) || ('sub_' + Date.now());
    var status = body.payment_status || body.status;
    var telegramId = body.tg_user_id || body.customer_extra || body.order_extra;
    var amount = body.sum || body.amount || process.env.MEMBERSHIP_PRICE || 390;
 
    if (!telegramId) {
      console.warn('No telegramId (tg_user_id/customer_extra) in webhook body');
      return res.json({ ok: true, message: 'No telegram id, skipping' });
    }
 
    // Принимаем оплату только в статусе success / paid
    if (status !== 'success' && status !== 'paid') {
      return res.json({ ok: true, message: 'Status is not success, skipping' });
    }
 
    // Ищем или создаём пользователя
    var userResult = await pool.query(
      'SELECT id FROM users WHERE telegram_id = $1',
      [telegramId]
    );
 
    var userId;
    if (userResult.rows.length === 0) {
      var newUser = await pool.query(
        'INSERT INTO users (telegram_id) VALUES ($1) RETURNING id',
        [telegramId]
      );
      userId = newUser.rows[0].id;
    } else {
      userId = userResult.rows[0].id;
    }
 
    // Срок членства
    var expiresAt = dayjs().add(process.env.MEMBERSHIP_DAYS || 30, 'day').toDate();
 
    // Создаём членство
    var membership = await pool.query(
      "INSERT INTO memberships (user_id, status, expires_at) VALUES ($1, 'active', $2) RETURNING id",
      [userId, expiresAt]
    );
 
    // Записываем платёж (ON CONFLICT - чтобы вебхук можно было безопасно повторить)
    await pool.query(
      "INSERT INTO payments (user_id, prodamus_order_id, amount, status, membership_id, paid_at) " +
      "VALUES ($1, $2, $3, 'paid', $4, NOW()) " +
      "ON CONFLICT (prodamus_order_id) DO UPDATE SET status = 'paid', paid_at = NOW()",
      [userId, orderId, amount, membership.rows[0].id]
    );
 
    // Уведомляем пользователя в Telegram
    try {
      await notifyPaymentSuccess(telegramId, expiresAt);
    } catch (e) {
      console.error('Failed to send Telegram notification:', e.message);
    }
 
    console.log('Membership activated: telegram_id=' + telegramId + ', until ' + expiresAt);
    res.json({ ok: true });
 
  } catch (err) {
    console.error('Prodamus webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
 
// ---------------------------------------------------------
// Создание ссылки на оплату подписки Prodamus
// Формат соответствует ссылкам, генерируемым BotHelp:
// https://colibri13.payform.ru/?do=pay&subscription=ID&tg_user_id=...&signature=...
// ---------------------------------------------------------
router.post('/payment/create', express.json(), async function (req, res) {
  var telegramId = req.body.telegramId;
  var phone = req.body.phone;
 
  if (!telegramId) {
    return res.status(400).json({ error: 'telegramId is required' });
  }
 
  var secretKey = process.env.PRODAMUS_SECRET_KEY;
  var subscriptionId = process.env.PRODAMUS_SUBSCRIPTION_ID || '2724580';
 
  // Если передан телефон - сохраняем его в базе для пользователя
  if (phone) {
    try {
      await pool.query(
        'UPDATE users SET phone = $1 WHERE telegram_id = $2',
        [phone, telegramId]
      );
    } catch (e) {
      console.error('Failed to save phone:', e.message);
    }
  }
 
  // Базовый URL формы оплаты
  var formUrl = process.env.PRODAMUS_FORM_URL || 'https://colibri13.payform.ru/';
 
  var params = {
    do: 'pay',
    subscription: subscriptionId,
    tg_user_id: String(telegramId),
  };
 
  if (phone) {
    // Prodamus ожидает номер без + и без пробелов, формат 79991234567
    params.customer_phone = String(phone).replace(/[^0-9]/g, '');
  }
 
  // Подпись по алгоритму Prodamus (официальный): HMAC-SHA256 от JSON
  // отсортированных параметров
  if (secretKey) {
    params.signature = signData(params, secretKey);
  }
 
  var query = Object.keys(params)
    .map(function (key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    })
    .join('&');
 
  var paymentUrl = formUrl + (formUrl.indexOf('?') === -1 ? '?' : '&') + query;
 
  res.json({ url: paymentUrl });
});
 
module.exports = router;
 
