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
//
// Официальный алгоритм формирования подписи (документация Prodamus):
// 1. Взять содержимое запроса и привести ВСЕ значения к строкам
//    (включая значения внутри вложенных объектов и массивов)
// 2. Отсортировать всё содержимое по ключам в алфавитном порядке,
//    в том числе вглубь (рекурсивно)
// 3. Перевести в JSON-строку
// 4. Экранировать "/" в JSON-строке
// 5. Подписать получившуюся строку через HMAC-SHA256 секретным ключом
//
// ВАЖНО: шаг 1 (приведение всех значений к строкам) обязателен.
// Без него число или булево значение в теле запроса (например,
// JSON number 0 вместо строки "0") даёт другую JSON-сериализацию
// и, соответственно, другой хэш — из-за этого подпись не совпадает
// с тем, что прислал Prodamus ("Invalid signature").
// ---------------------------------------------------------

// Каноническое представление данных для подписи:
// рекурсивно сортирует ключи объектов и приводит все скалярные
// значения к строкам (null/undefined -> "", true -> "1", false -> "")
function canonicalizeForSignature(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForSignature);
  }
  if (value !== null && typeof value === 'object') {
    var sorted = {};
    Object.keys(value).sort().forEach(function (key) {
      sorted[key] = canonicalizeForSignature(value[key]);
    });
    return sorted;
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '';
  }
  return String(value);
}

// Генерация подписи для исходящего запроса (создание ссылки на оплату)
// Prodamus использует PHP json_encode (без JSON_UNESCAPED_SLASHES), поэтому
// экранируем слеши "/" -> "\/" как это делает PHP по умолчанию
function signData(data, secretKey) {
  var canonical = canonicalizeForSignature(data);
  var json = JSON.stringify(canonical).replace(/\//g, '\\/');
  return crypto.createHmac('sha256', secretKey).update(json).digest('hex');
}

// Проверка подписи входящего webhook
function verifyProdamusSignature(body, signature, secretKey) {
  var bodyCopy = Object.assign({}, body);
  delete bodyCopy.sign;
  delete bodyCopy.signature;
  var canonical = canonicalizeForSignature(bodyCopy);
  var json = JSON.stringify(canonical).replace(/\//g, '\\/');
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

if (secretKey) {
if (!signature) {
console.warn('Webhook rejected: no signature provided');
return res.status(403).json({ error: 'Signature required' });
}
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
//
// Подтверждено протестировано вручную: формат с параметрами
// do, order_id, sys=bothelp, subscription, customer_extra и
// подписью (HMAC-SHA256 от JSON отсортированных параметров с
// экранированием слешей) открывается без ошибки подписи, выдаёт
// новый номер заказа, тип "Подписка с автосписанием каждые 30
// дней", сумму 390р, и НЕ подставляет чужие данные получателя -
// покупатель сам вводит свой телефон/email на странице оплаты.
// customer_extra передаёт telegram_id для сопоставления в webhook.
// ---------------------------------------------------------
router.post('/payment/create', express.json(), async function (req, res) {
var telegramId = req.body.telegramId;
var phone = req.body.phone;

if (!telegramId) {
return res.status(400).json({ error: 'telegramId is required' });
}

var secretKey = process.env.PRODAMUS_SECRET_KEY;
var subscriptionId = process.env.PRODAMUS_SUBSCRIPTION_ID || '2724580';

// Если телефон не передан явно - пробуем взять из базы
// (сохранён ранее через tg.requestContact)
if (!phone) {
try {
var phoneResult = await pool.query(
'SELECT phone FROM users WHERE telegram_id = $1',
[telegramId]
);
if (phoneResult.rows.length > 0 && phoneResult.rows[0].phone) {
phone = phoneResult.rows[0].phone;
}
} catch (e) {
console.error('Failed to fetch phone from DB:', e.message);
}
}

// Базовый URL платёжной страницы (без пути к конкретному товару -
// subscription определяет тариф)
var formUrl = process.env.PRODAMUS_BASE_URL || 'https://colibri13.payform.ru/';

var params = {
do: 'pay',
order_id: 'tg_' + telegramId + '_' + Date.now(),
sys: process.env.PRODAMUS_SYS || 'bothelp',
subscription: subscriptionId,
customer_extra: String(telegramId),
};

if (phone) {
params.customer_phone = String(phone).replace(/[^0-9]/g, '');
}

if (secretKey) {
params.signature = signData(params, secretKey);
}

var query = Object.keys(params)
.map(function (key) {
return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
})
.join('&');

var paymentUrl = formUrl + (formUrl.indexOf('?') === -1 ? '?' : '&') + query;

console.log('Payment link generated for telegram_id=' + telegramId + ', phone=' + (phone || 'none') + ':');
console.log(paymentUrl);

res.json({ url: paymentUrl });
});

module.exports = router;
