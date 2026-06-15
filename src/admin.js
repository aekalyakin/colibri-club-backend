const express = require('express');
const router = express.Router();
const pool = require('./db');
require('dotenv').config();
 
// ---------------------------------------------------------
// Иерархия ролей: owner > manager > admin
// ---------------------------------------------------------
var ROLE_LEVEL = { admin: 1, manager: 2, owner: 3 };
 
function roleAtLeast(role, required) {
  return (ROLE_LEVEL[role] || 0) >= (ROLE_LEVEL[required] || 99);
}
 
// ---------------------------------------------------------
// Нормализация телефона к единому формату 7XXXXXXXXXX
// Принимает: +79998887766, 89998887766, 79998887766, 9998887766
// ---------------------------------------------------------
function normalizePhone(raw) {
  if (!raw) return null;
  var digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
 
  if (digits.length === 11 && digits[0] === '8') {
    return '7' + digits.slice(1);
  }
  if (digits.length === 11 && digits[0] === '7') {
    return digits;
  }
  if (digits.length === 10) {
    return '7' + digits;
  }
  return digits;
}
 
// ---------------------------------------------------------
// Парсер одной строки CSV с учётом кавычек, разделитель ';'
// ---------------------------------------------------------
function parseCsvLine(line, delimiter) {
  delimiter = delimiter || ';';
  var result = [];
  var current = '';
  var inQuotes = false;
 
  for (var i = 0; i < line.length; i++) {
    var char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}
 
// ---------------------------------------------------------
// Парсер даты "ДД.ММ.ГГГГ ЧЧ:мм" (формат экспорта Prodamus)
// ---------------------------------------------------------
function parseRuDateTime(str) {
  if (!str) return null;
  var trimmed = String(str).trim();
  if (!trimmed) return null;
 
  var match = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!match) return null;
 
  var day = match[1], month = match[2], year = match[3];
  var hour = match[4] || '0', minute = match[5] || '0';
 
  return new Date(
    parseInt(year, 10),
    parseInt(month, 10) - 1,
    parseInt(day, 10),
    parseInt(hour, 10),
    parseInt(minute, 10)
  );
}
 
// ---------------------------------------------------------
// Парсер всего CSV (с заголовками) в массив объектов-строк.
// Авто-определяет разделитель: Prodamus экспортирует с
// табуляцией (\t), но поддерживаем и ';' на случай других форматов.
// ---------------------------------------------------------
function parseSubscribersCsv(csvText) {
  var text = csvText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  var lines = text.split('\n').filter(function (l) { return l.trim().length > 0; });
  if (lines.length === 0) return { headers: [], rows: [] };
 
  // Определяем разделитель по первой строке: чей символ встречается чаще
  var firstLine = lines[0];
  var tabCount = (firstLine.match(/\t/g) || []).length;
  var semiCount = (firstLine.match(/;/g) || []).length;
  var delimiter = tabCount >= semiCount ? '\t' : ';';
 
  var headers = parseCsvLine(lines[0], delimiter).map(function (h) { return h.trim(); });
  var rows = [];
 
  for (var i = 1; i < lines.length; i++) {
    var cells = parseCsvLine(lines[i], delimiter);
    var row = {};
    headers.forEach(function (h, idx) {
      row[h] = cells[idx] !== undefined ? cells[idx] : '';
    });
    rows.push(row);
  }
 
  return { headers: headers, rows: rows };
}
 
// Получить роль пользователя по telegram_id (null если не админ)
async function getRole(telegramId) {
  var result = await pool.query(
    'SELECT role FROM admins WHERE telegram_id = $1',
    [telegramId]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].role;
}
 
// Middleware: требует роль не ниже указанной.
// Telegram ID берётся из заголовка X-Telegram-Id (передаётся фронтендом).
function requireRole(minRole) {
  return async function (req, res, next) {
    var telegramId = req.headers['x-telegram-id'] || req.body.telegramId || req.query.telegramId;
 
    if (!telegramId) {
      return res.status(401).json({ error: 'telegramId is required' });
    }
 
    try {
      var role = await getRole(telegramId);
      if (!role || !roleAtLeast(role, minRole)) {
        return res.status(403).json({ error: 'Недостаточно прав доступа' });
      }
      req.adminRole = role;
      req.adminTelegramId = telegramId;
      next();
    } catch (err) {
      console.error('requireRole error:', err);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  };
}
 
// ---------------------------------------------------------
// Проверка роли текущего пользователя (для фронтенда)
// ---------------------------------------------------------
router.get('/admin/role/:telegramId', async function (req, res) {
  try {
    var role = await getRole(req.params.telegramId);
    res.json({ role: role, isAdmin: !!role });
  } catch (err) {
    console.error('GET /admin/role error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// ---------------------------------------------------------
// АДМИНИСТРАТОР: проверка статуса подписки по номеру телефона
// ---------------------------------------------------------
router.get('/admin/check-subscription', requireRole('admin'), async function (req, res) {
  var phone = normalizePhone(req.query.phone);
 
  if (!phone) {
    return res.status(400).json({ error: 'phone обязателен' });
  }
 
  try {
    var result = await pool.query(`
      SELECT u.full_name, u.phone, u.telegram_id,
             m.status, m.expires_at
      FROM users u
      LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
      WHERE u.phone = $1
      ORDER BY m.expires_at DESC
      LIMIT 1
    `, [phone]);
 
    if (result.rows.length === 0) {
      return res.json({ found: false });
    }
 
    var row = result.rows[0];
    var isActive = row.status === 'active' && new Date(row.expires_at) > new Date();
 
    res.json({
      found: true,
      fullName: row.full_name,
      phone: row.phone,
      active: isActive,
      expiresAt: row.expires_at || null,
    });
  } catch (err) {
    console.error('GET /admin/check-subscription error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// ---------------------------------------------------------
// АДМИНИСТРАТОР: оплаты за сегодня
// ---------------------------------------------------------
router.get('/admin/payments/today', requireRole('admin'), async function (req, res) {
  try {
    var result = await pool.query(`
      SELECT p.amount, p.status, p.paid_at, p.created_at,
             u.full_name, u.phone, u.telegram_id
      FROM payments p
      JOIN users u ON u.id = p.user_id
      WHERE p.paid_at >= CURRENT_DATE AND p.paid_at < CURRENT_DATE + INTERVAL '1 day'
      ORDER BY p.paid_at DESC
    `);
 
    res.json({ payments: result.rows });
  } catch (err) {
    console.error('GET /admin/payments/today error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// ---------------------------------------------------------
// УПРАВЛЯЮЩИЙ: оплаты и подписчики за последние 3 дня
// ---------------------------------------------------------
router.get('/admin/payments/recent', requireRole('manager'), async function (req, res) {
  try {
    var result = await pool.query(`
      SELECT p.amount, p.status, p.paid_at, p.created_at,
             u.full_name, u.phone, u.telegram_id
      FROM payments p
      JOIN users u ON u.id = p.user_id
      WHERE p.created_at >= NOW() - INTERVAL '3 days'
      ORDER BY p.created_at DESC
    `);
 
    res.json({ payments: result.rows });
  } catch (err) {
    console.error('GET /admin/payments/recent error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
router.get('/admin/subscribers/recent', requireRole('manager'), async function (req, res) {
  try {
    var result = await pool.query(`
      SELECT u.full_name, u.phone, u.telegram_id, u.email,
             m.status, m.expires_at, m.started_at
      FROM users u
      LEFT JOIN memberships m ON m.user_id = u.id
      WHERE m.started_at >= NOW() - INTERVAL '3 days'
      ORDER BY m.started_at DESC
    `);
 
    res.json({ subscribers: result.rows });
  } catch (err) {
    console.error('GET /admin/subscribers/recent error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// ---------------------------------------------------------
// УПРАВЛЯЮЩИЙ: назначение администраторов
// ---------------------------------------------------------
router.post('/admin/admins', requireRole('manager'), async function (req, res) {
  var targetTelegramId = req.body.telegramId;
  var targetPhone = req.body.phone;
  var role = req.body.role || 'admin';
 
  // Только owner может назначать manager/owner; manager может назначать только admin
  if (role !== 'admin' && req.adminRole !== 'owner') {
    return res.status(403).json({ error: 'Только владелец может назначать эту роль' });
  }
 
  if (!['admin', 'manager', 'owner'].includes(role)) {
    return res.status(400).json({ error: 'Некорректная роль' });
  }
 
  try {
    var resolvedTelegramId = targetTelegramId;
 
    // Если передан телефон вместо telegram_id - ищем пользователя по телефону
    if (!resolvedTelegramId && targetPhone) {
      var phone = normalizePhone(targetPhone);
      var userResult = await pool.query(
        'SELECT telegram_id FROM users WHERE phone = $1',
        [phone]
      );
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь с таким телефоном не найден. Пользователь должен хотя бы раз открыть Mini App.' });
      }
      resolvedTelegramId = userResult.rows[0].telegram_id;
    }
 
    if (!resolvedTelegramId) {
      return res.status(400).json({ error: 'Укажите telegramId или phone' });
    }
 
    await pool.query(`
      INSERT INTO admins (telegram_id, role, added_by)
      VALUES ($1, $2, $3)
      ON CONFLICT (telegram_id) DO UPDATE SET role = $2
    `, [resolvedTelegramId, role, req.adminTelegramId]);
 
    res.json({ ok: true, telegramId: resolvedTelegramId, role: role });
  } catch (err) {
    console.error('POST /admin/admins error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// Список администраторов (для управления)
router.get('/admin/admins', requireRole('manager'), async function (req, res) {
  try {
    var result = await pool.query(`
      SELECT a.telegram_id, a.role, a.created_at,
             u.full_name, u.phone
      FROM admins a
      LEFT JOIN users u ON u.telegram_id = a.telegram_id
      ORDER BY a.created_at DESC
    `);
    res.json({ admins: result.rows });
  } catch (err) {
    console.error('GET /admin/admins error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// Удалить администратора (только owner, либо manager удаляет admin)
router.delete('/admin/admins/:telegramId', requireRole('manager'), async function (req, res) {
  var targetTelegramId = req.params.telegramId;
 
  try {
    var targetRole = await getRole(targetTelegramId);
 
    if (targetRole && targetRole !== 'admin' && req.adminRole !== 'owner') {
      return res.status(403).json({ error: 'Только владелец может удалять менеджеров/владельцев' });
    }
 
    await pool.query('DELETE FROM admins WHERE telegram_id = $1', [targetTelegramId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /admin/admins error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// ---------------------------------------------------------
// ВЛАДЕЛЕЦ: полная аналитика
// ---------------------------------------------------------
router.get('/admin/analytics/overview', requireRole('owner'), async function (req, res) {
  try {
    var totalUsers = await pool.query('SELECT COUNT(*) FROM users');
 
    var activeMemberships = await pool.query(`
      SELECT COUNT(*) FROM memberships
      WHERE status = 'active' AND expires_at > NOW()
    `);
 
    var expiredMemberships = await pool.query(`
      SELECT COUNT(*) FROM memberships
      WHERE status = 'expired' OR (status = 'active' AND expires_at <= NOW())
    `);
 
    var totalRevenue = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'paid'
    `);
 
    var revenueThisMonth = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total FROM payments
      WHERE status = 'paid' AND paid_at >= DATE_TRUNC('month', NOW())
    `);
 
    var newUsersThisMonth = await pool.query(`
      SELECT COUNT(*) FROM users WHERE created_at >= DATE_TRUNC('month', NOW())
    `);
 
    res.json({
      totalUsers: parseInt(totalUsers.rows[0].count, 10),
      activeMemberships: parseInt(activeMemberships.rows[0].count, 10),
      expiredMemberships: parseInt(expiredMemberships.rows[0].count, 10),
      totalRevenue: parseFloat(totalRevenue.rows[0].total),
      revenueThisMonth: parseFloat(revenueThisMonth.rows[0].total),
      newUsersThisMonth: parseInt(newUsersThisMonth.rows[0].count, 10),
    });
  } catch (err) {
    console.error('GET /admin/analytics/overview error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// Выручка по дням за последние N дней (для графиков)
router.get('/admin/analytics/revenue-by-day', requireRole('owner'), async function (req, res) {
  var days = parseInt(req.query.days, 10) || 30;
 
  try {
    var result = await pool.query(`
      SELECT TO_CHAR(paid_at, 'YYYY-MM-DD') as date, SUM(amount) as total, COUNT(*) as count
      FROM payments
      WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '${days} days'
      GROUP BY TO_CHAR(paid_at, 'YYYY-MM-DD')
      ORDER BY date ASC
    `);
 
    res.json({ data: result.rows.map(function (r) {
      return { date: r.date, total: parseFloat(r.total), count: parseInt(r.count, 10) };
    }) });
  } catch (err) {
    console.error('GET /admin/analytics/revenue-by-day error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// Выручка по месяцам (для графиков)
router.get('/admin/analytics/revenue-by-month', requireRole('owner'), async function (req, res) {
  var months = parseInt(req.query.months, 10) || 12;
 
  try {
    var result = await pool.query(`
      SELECT TO_CHAR(paid_at, 'YYYY-MM') as month, SUM(amount) as total, COUNT(*) as count
      FROM payments
      WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '${months} months'
      GROUP BY TO_CHAR(paid_at, 'YYYY-MM')
      ORDER BY month ASC
    `);
 
    res.json({ data: result.rows.map(function (r) {
      return { month: r.month, total: parseFloat(r.total), count: parseInt(r.count, 10) };
    }) });
  } catch (err) {
    console.error('GET /admin/analytics/revenue-by-month error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// Полный список пользователей (с фильтрами и пагинацией)
router.get('/admin/users', requireRole('owner'), async function (req, res) {
  var limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  var offset = parseInt(req.query.offset, 10) || 0;
  var statusFilter = req.query.status; // active | expired | all
 
  try {
    var whereClause = '';
    if (statusFilter === 'active') {
      whereClause = "WHERE m.status = 'active' AND m.expires_at > NOW()";
    } else if (statusFilter === 'expired') {
      whereClause = "WHERE m.status = 'expired' OR (m.status = 'active' AND m.expires_at <= NOW())";
    }
 
    var result = await pool.query(`
      SELECT u.id, u.telegram_id, u.full_name, u.phone, u.email, u.created_at,
             m.status, m.expires_at, m.started_at
      FROM users u
      LEFT JOIN memberships m ON m.user_id = u.id AND m.id = (
        SELECT id FROM memberships WHERE user_id = u.id ORDER BY expires_at DESC LIMIT 1
      )
      ${whereClause}
      ORDER BY u.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
 
    var countResult = await pool.query('SELECT COUNT(*) FROM users');
 
    res.json({
      users: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
      limit: limit,
      offset: offset,
    });
  } catch (err) {
    console.error('GET /admin/users error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// Все платежи (с пагинацией) - для CSV-экспорта
router.get('/admin/payments/all', requireRole('owner'), async function (req, res) {
  var limit = Math.min(parseInt(req.query.limit, 10) || 100, 5000);
  var offset = parseInt(req.query.offset, 10) || 0;
 
  try {
    var result = await pool.query(`
      SELECT p.id, p.amount, p.status, p.prodamus_order_id, p.paid_at, p.created_at,
             u.full_name, u.phone, u.telegram_id, u.email
      FROM payments p
      JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
 
    var countResult = await pool.query('SELECT COUNT(*) FROM payments');
 
    res.json({
      payments: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
      limit: limit,
      offset: offset,
    });
  } catch (err) {
    console.error('GET /admin/payments/all error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// CSV экспорт пользователей
router.get('/admin/export/users.csv', requireRole('owner'), async function (req, res) {
  try {
    var result = await pool.query(`
      SELECT u.telegram_id, u.full_name, u.phone, u.email, u.created_at,
             m.status, m.expires_at
      FROM users u
      LEFT JOIN memberships m ON m.user_id = u.id AND m.id = (
        SELECT id FROM memberships WHERE user_id = u.id ORDER BY expires_at DESC LIMIT 1
      )
      ORDER BY u.created_at DESC
    `);
 
    var header = 'telegram_id,full_name,phone,email,registered_at,membership_status,expires_at\n';
    var rows = result.rows.map(function (r) {
      return [
        r.telegram_id,
        '"' + (r.full_name || '').replace(/"/g, '""') + '"',
        r.phone || '',
        r.email || '',
        r.created_at ? new Date(r.created_at).toISOString() : '',
        r.status || '',
        r.expires_at ? new Date(r.expires_at).toISOString() : ''
      ].join(',');
    }).join('\n');
 
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="colibri-users.csv"');
    res.send('\uFEFF' + header + rows); // BOM для корректного открытия в Excel с кириллицей
  } catch (err) {
    console.error('GET /admin/export/users.csv error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// CSV экспорт платежей
router.get('/admin/export/payments.csv', requireRole('owner'), async function (req, res) {
  try {
    var result = await pool.query(`
      SELECT p.id, p.amount, p.status, p.prodamus_order_id, p.paid_at, p.created_at,
             u.full_name, u.phone, u.telegram_id
      FROM payments p
      JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC
    `);
 
    var header = 'id,telegram_id,full_name,phone,amount,status,order_id,paid_at,created_at\n';
    var rows = result.rows.map(function (r) {
      return [
        r.id,
        r.telegram_id,
        '"' + (r.full_name || '').replace(/"/g, '""') + '"',
        r.phone || '',
        r.amount,
        r.status,
        r.prodamus_order_id || '',
        r.paid_at ? new Date(r.paid_at).toISOString() : '',
        r.created_at ? new Date(r.created_at).toISOString() : ''
      ].join(',');
    }).join('\n');
 
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="colibri-payments.csv"');
    res.send('\uFEFF' + header + rows);
  } catch (err) {
    console.error('GET /admin/export/payments.csv error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
 
// ---------------------------------------------------------
// ВЛАДЕЛЕЦ: импорт подписчиков из CSV Prodamus (raw текст в JSON)
// Ожидает: { csv: "Телефон;TG ID;Дата подписки;Будущий платеж;Активность (пользователь)\n..." }
// ---------------------------------------------------------
router.post('/admin/import-subscribers-raw', requireRole('owner'), async function (req, res) {
  var csv = req.body.csv;
 
  if (!csv || typeof csv !== 'string' || !csv.trim()) {
    return res.status(400).json({ error: 'Поле "csv" обязательно и должно быть непустой строкой' });
  }
 
  var parsed = parseSubscribersCsv(csv);
  var headers = parsed.headers;
  var rows = parsed.rows;
 
  if (rows.length === 0) {
    return res.status(400).json({ error: 'CSV не содержит строк данных' });
  }
 
  // Определяем нужные колонки по заголовкам (регистронезависимо)
  var COL_PHONE = headers.find(function (h) { return /телефон/i.test(h); });
  var COL_TG_ID = headers.find(function (h) { return /tg\s*id/i.test(h); });
  var COL_NEXT_PAYMENT = headers.find(function (h) { return /будущий\s*платеж/i.test(h); });
  var COL_SUBSCRIPTION_DATE = headers.find(function (h) { return /дата\s*подписки/i.test(h); });
  var COL_ACTIVITY = headers.find(function (h) { return /активность/i.test(h); });
  var COL_FULL_NAME = headers.find(function (h) { return /(имя|фио|full.?name)/i.test(h); });
 
  if (!COL_PHONE && !COL_TG_ID) {
    return res.status(400).json({
      error: 'Не найдены колонки "Телефон" / "TG ID" в заголовках CSV',
      headers: headers,
    });
  }
 
  var updated = 0;
  var created = 0;
  var skipped = 0;
  var errors = [];
 
  var client = await pool.connect();
 
  try {
    await client.query('BEGIN');
 
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
 
      try {
        await client.query('SAVEPOINT row_' + i);
 
        var rawPhone = COL_PHONE ? row[COL_PHONE] : null;
        var rawTgId = COL_TG_ID ? row[COL_TG_ID] : null;
        var rawNextPayment = COL_NEXT_PAYMENT ? row[COL_NEXT_PAYMENT] : null;
        var rawSubscriptionDate = COL_SUBSCRIPTION_DATE ? row[COL_SUBSCRIPTION_DATE] : null;
        var rawActivity = COL_ACTIVITY ? row[COL_ACTIVITY] : null;
        var rawFullName = COL_FULL_NAME ? row[COL_FULL_NAME] : null;
 
        var phone = normalizePhone(rawPhone);
        var telegramId = (rawTgId && String(rawTgId).trim()) ? String(rawTgId).trim() : null;
 
        if (!phone && !telegramId) {
          skipped++;
          continue;
        }
 
        // "Будущий платеж" - дата следующего списания. Если пуст, значит
        // подписка отменена в течение 30 дней с момента оплаты, и
        // действует до "Дата подписки" + 30 дней.
        var expiresAt = parseRuDateTime(rawNextPayment);
        if (!expiresAt) {
          var subscriptionDate = parseRuDateTime(rawSubscriptionDate);
          if (subscriptionDate) {
            expiresAt = new Date(subscriptionDate.getTime() + 30 * 24 * 60 * 60 * 1000);
          }
        }
        var activityStr = rawActivity || '';
        var isActive = /актив/i.test(activityStr) && !/неактив/i.test(activityStr);
        var status = isActive ? 'active' : 'expired';
 
        // --- Поиск существующего пользователя: сначала по telegram_id, потом по телефону ---
        var userRow = null;
 
        if (telegramId) {
          var byTg = await client.query(
            'SELECT id, telegram_id, phone FROM users WHERE telegram_id = $1 LIMIT 1',
            [telegramId]
          );
          if (byTg.rows.length > 0) userRow = byTg.rows[0];
        }
 
        if (!userRow && phone) {
          var byPhone = await client.query(
            'SELECT id, telegram_id, phone FROM users WHERE phone = $1 LIMIT 1',
            [phone]
          );
          if (byPhone.rows.length > 0) userRow = byPhone.rows[0];
        }
 
        var userId;
        var isNewUser;
 
        if (userRow) {
          userId = userRow.id;
          isNewUser = false;
 
          // Дозаполняем недостающие поля (телефон / telegram_id / имя)
          var setClauses = [];
          var params = [];
          var paramIdx = 1;
 
          if (!userRow.telegram_id && telegramId) {
            setClauses.push('telegram_id = $' + paramIdx);
            params.push(telegramId);
            paramIdx++;
          }
          if (!userRow.phone && phone) {
            setClauses.push('phone = $' + paramIdx);
            params.push(phone);
            paramIdx++;
          }
          if (rawFullName && rawFullName.trim()) {
            setClauses.push('full_name = COALESCE(full_name, $' + paramIdx + ')');
            params.push(rawFullName.trim());
            paramIdx++;
          }
 
          if (setClauses.length > 0) {
            params.push(userId);
            await client.query(
              'UPDATE users SET ' + setClauses.join(', ') + ' WHERE id = $' + paramIdx,
              params
            );
          }
        } else {
          var insertResult = await client.query(`
            INSERT INTO users (telegram_id, phone, full_name, created_at)
            VALUES ($1, $2, $3, NOW())
            RETURNING id
          `, [telegramId, phone, (rawFullName && rawFullName.trim()) || null]);
 
          userId = insertResult.rows[0].id;
          isNewUser = true;
        }
 
        // --- Membership: ищем самую свежую запись для пользователя ---
        var existingMembership = await client.query(
          'SELECT id FROM memberships WHERE user_id = $1 ORDER BY expires_at DESC NULLS LAST LIMIT 1',
          [userId]
        );
 
        if (existingMembership.rows.length > 0) {
          await client.query(
            'UPDATE memberships SET status = $1, expires_at = $2 WHERE id = $3',
            [status, expiresAt, existingMembership.rows[0].id]
          );
        } else {
          await client.query(`
            INSERT INTO memberships (user_id, status, expires_at, started_at)
            VALUES ($1, $2, $3, NOW())
          `, [userId, status, expiresAt]);
        }
 
        if (isNewUser) {
          created++;
        } else {
          updated++;
        }
 
        await client.query('RELEASE SAVEPOINT row_' + i);
      } catch (rowErr) {
        await client.query('ROLLBACK TO SAVEPOINT row_' + i);
        skipped++;
        if (errors.length < 20) {
          errors.push({ row: i + 2, error: rowErr.message }); // +2: заголовок + 1-индексация
        }
      }
    }
 
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /admin/import-subscribers-raw error:', err);
    return res.status(500).json({ error: 'Ошибка сервера при импорте', details: err.message });
  } finally {
    client.release();
  }
 
  res.json({
    message: 'Импорт завершён',
    total: rows.length,
    updated: updated,
    created: created,
    skipped: skipped,
    errors: errors,
  });
});
 
module.exports = router;
 
