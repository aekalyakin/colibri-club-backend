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
// Парсер дат из CSV Prodamus. Поддерживает два формата:
// - "ДД.ММ.ГГГГ ЧЧ:мм" (например, "14.07.2026 18:13")
// - "ГГГГ-ММ-ДД ЧЧ:мм:сс" (например, "2026-06-15 10:08:57")
// ---------------------------------------------------------
function parseRuDateTime(str) {
  if (!str) return null;
  var trimmed = String(str).trim();
  if (!trimmed) return null;

  // Формат ДД.ММ.ГГГГ [ЧЧ:мм]
  var ruMatch = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (ruMatch) {
    var day = ruMatch[1], month = ruMatch[2], year = ruMatch[3];
    var hour = ruMatch[4] || '0', minute = ruMatch[5] || '0';
    return new Date(
      parseInt(year, 10),
      parseInt(month, 10) - 1,
      parseInt(day, 10),
      parseInt(hour, 10),
      parseInt(minute, 10)
    );
  }

  // Формат ГГГГ-ММ-ДД [ЧЧ:мм[:сс]]
  var isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (isoMatch) {
    var isoYear = isoMatch[1], isoMonth = isoMatch[2], isoDay = isoMatch[3];
    var isoHour = isoMatch[4] || '0', isoMinute = isoMatch[5] || '0', isoSecond = isoMatch[6] || '0';
    return new Date(
      parseInt(isoYear, 10),
      parseInt(isoMonth, 10) - 1,
      parseInt(isoDay, 10),
      parseInt(isoHour, 10),
      parseInt(isoMinute, 10),
      parseInt(isoSecond, 10)
    );
  }

  return null;
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

  return { headers: headers, rows: rows, delimiter: delimiter };
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

    var newUsersThisMonth = await pool.query(`
      SELECT COUNT(*) FROM users WHERE created_at >= DATE_TRUNC('month', NOW())
    `);

    // "Выручка за месяц" = расчётный месячный доход по активным подпискам
    // прямо сейчас (старые активные клиенты + новые в этом месяце,
    // за вычетом тех, кто перешёл в статус "неактивен"). По сути это
    // MRR: количество активных подписок × стоимость подписки (390₽).
    var SUBSCRIPTION_PRICE = 390;
    var activeCount = parseInt(activeMemberships.rows[0].count, 10);
    var revenueThisMonth = activeCount * SUBSCRIPTION_PRICE;

    res.json({
      totalUsers: parseInt(totalUsers.rows[0].count, 10),
      activeMemberships: activeCount,
      expiredMemberships: parseInt(expiredMemberships.rows[0].count, 10),
      totalRevenue: parseFloat(totalRevenue.rows[0].total),
      revenueThisMonth: revenueThisMonth,
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

// Ожидаемые оплаты в ближайшие N дней — по дате окончания активных подписок
// (приближается expires_at => скоро будет автосписание следующего платежа)
router.get('/admin/analytics/upcoming-payments', requireRole('owner'), async function (req, res) {
  var days = parseInt(req.query.days, 10) || 3;
  var SUBSCRIPTION_PRICE = 390;

  try {
    var result = await pool.query(`
      SELECT COUNT(*) as count
      FROM memberships
      WHERE status = 'active'
        AND expires_at > NOW()
        AND expires_at <= NOW() + INTERVAL '${days} days'
    `);

    var count = parseInt(result.rows[0].count, 10);

    res.json({
      count: count,
      total: count * SUBSCRIPTION_PRICE,
      days: days,
    });
  } catch (err) {
    console.error('GET /admin/analytics/upcoming-payments error:', err);
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

  // --- Режим диагностики: вернуть разобранную структуру без записи в БД ---
  if (req.body.debug) {
    return res.json({
      delimiter: parsed.delimiter === '\t' ? 'TAB' : parsed.delimiter,
      headers: headers,
      detectedColumns: {
        phone: COL_PHONE,
        tgId: COL_TG_ID,
        nextPayment: COL_NEXT_PAYMENT,
        subscriptionDate: COL_SUBSCRIPTION_DATE,
        activity: COL_ACTIVITY,
        fullName: COL_FULL_NAME,
      },
      totalRows: rows.length,
      sampleRows: rows.slice(0, 5),
    });
  }

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

// ---------------------------------------------------------
// Парсер CSV из Bitrix-таблицы истории платежей.
// Формат заголовков: Имя,ФИО,Ник тг,Телефон,Подписка
// Разделитель — запятая (','), даты в "Подписка" — "ГГГГ-ММ-ДД".
// Каждая строка = один платёж (390₽), "Подписка" = дата ОКОНЧАНИЯ
// подписки по этому платежу (т.е. expires_at = "Подписка",
// paid_at = "Подписка" - 30 дней).
// ---------------------------------------------------------

// Парсер даты "ГГГГ-ММ-ДД" в Date (без времени)
function parseSimpleDate(str) {
  if (!str) return null;
  var trimmed = String(str).trim();
  var m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

// ---------------------------------------------------------
// ВЛАДЕЛЕЦ: импорт истории платежей из Bitrix-таблицы (CSV)
// Ожидает: { csv: "Имя,ФИО,Ник тг,Телефон,Подписка\n...", debug: true|false }
//
// Сопоставление со users:
//   1) по нормализованному телефону (users.phone)
//   2) если телефона нет — по точному совпадению ФИО (или Имя,
//      если ФИО пусто) с users.full_name
//   3) если не найдено — строка попадает в unmatched, не импортируется
//
// Для каждой совпавшей строки создаётся запись в payments
// (amount=390, status='paid', paid_at = "Подписка" - 30 дней,
// prodamus_order_id = 'bx_import_<номер строки>').
//
// После обработки всех строк для каждого затронутого пользователя:
//   - users.created_at = MIN(текущий created_at, самый ранний paid_at)
//   - последняя по expires_at запись memberships:
//       started_at = MIN(текущий started_at, самый ранний paid_at)
// ---------------------------------------------------------
router.post('/admin/import-payments-history', requireRole('owner'), async function (req, res) {
  var csv = req.body.csv;

  if (!csv || typeof csv !== 'string' || !csv.trim()) {
    return res.status(400).json({ error: 'Поле "csv" обязательно и должно быть непустой строкой' });
  }

  // Эта таблица всегда с запятой как разделителем (экспорт Google Sheets)
  var text = csv.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  var lines = text.split('\n').filter(function (l) { return l.trim().length > 0; });
  if (lines.length === 0) {
    return res.status(400).json({ error: 'CSV не содержит строк данных' });
  }

  var headers = parseCsvLine(lines[0], ',').map(function (h) { return h.trim(); });
  var rows = [];
  for (var li = 1; li < lines.length; li++) {
    var cells = parseCsvLine(lines[li], ',');
    var row = {};
    headers.forEach(function (h, idx) {
      row[h] = cells[idx] !== undefined ? cells[idx] : '';
    });
    rows.push(row);
  }

  if (rows.length === 0) {
    return res.status(400).json({ error: 'CSV не содержит строк данных' });
  }

  var COL_NAME = headers.find(function (h) { return /^имя/i.test(h); });
  var COL_FULLNAME = headers.find(function (h) { return /фио/i.test(h); });
  var COL_TG_NICK = headers.find(function (h) { return /ник\s*тг/i.test(h); });
  var COL_PHONE = headers.find(function (h) { return /телефон/i.test(h); });
  var COL_EXPIRES = headers.find(function (h) { return /подписка/i.test(h); });

  if (!COL_PHONE || !COL_EXPIRES) {
    return res.status(400).json({
      error: 'Не найдены обязательные колонки "Телефон" / "Подписка" в заголовках CSV',
      headers: headers,
    });
  }

  // --- Режим диагностики: вернуть разобранную структуру без записи в БД ---
  if (req.body.debug) {
    return res.json({
      headers: headers,
      detectedColumns: {
        name: COL_NAME,
        fullName: COL_FULLNAME,
        tgNick: COL_TG_NICK,
        phone: COL_PHONE,
        expires: COL_EXPIRES,
      },
      totalRows: rows.length,
      sampleRows: rows.slice(0, 5),
    });
  }

  var imported = 0;
  var skipped = 0;
  var unmatched = [];
  var errors = [];

  // Кеш: затронутые пользователи -> самая ранняя дата платежа (для пост-обработки)
  var affectedUsers = {}; // userId -> earliest Date

  var client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];

      try {
        await client.query('SAVEPOINT row_' + i);

        var rawPhone = row[COL_PHONE];
        var rawFullName = COL_FULLNAME ? row[COL_FULLNAME] : null;
        var rawName = COL_NAME ? row[COL_NAME] : null;
        var rawExpires = row[COL_EXPIRES];

        var phone = normalizePhone(rawPhone);
        var expiresAt = parseSimpleDate(rawExpires);

        if (!expiresAt) {
          skipped++;
          await client.query('RELEASE SAVEPOINT row_' + i);
          continue;
        }

        // paid_at = expires_at - 30 дней
        var paidAt = new Date(expiresAt.getTime() - 30 * 24 * 60 * 60 * 1000);

        // --- Поиск пользователя ---
        var userRow = null;

        if (phone) {
          var byPhone = await client.query(
            'SELECT id, created_at FROM users WHERE phone = $1 LIMIT 1',
            [phone]
          );
          if (byPhone.rows.length > 0) userRow = byPhone.rows[0];
        }

        if (!userRow) {
          var nameCandidate = (rawFullName && rawFullName.trim()) || (rawName && rawName.trim());
          if (nameCandidate) {
            var byName = await client.query(
              'SELECT id, created_at FROM users WHERE full_name = $1 LIMIT 1',
              [nameCandidate]
            );
            if (byName.rows.length > 0) userRow = byName.rows[0];
          }
        }

        if (!userRow) {
          unmatched.push({
            row: i + 2, // +2: заголовок + 1-индексация
            name: rawName || '',
            fullName: rawFullName || '',
            tgNick: COL_TG_NICK ? row[COL_TG_NICK] : '',
            phone: rawPhone || '',
            expires: rawExpires || '',
          });
          await client.query('RELEASE SAVEPOINT row_' + i);
          continue;
        }

        var userId = userRow.id;

        // --- Создаём запись платежа ---
        var orderId = 'bx_import_' + (i + 2);

        await client.query(`
          INSERT INTO payments (user_id, prodamus_order_id, amount, status, paid_at)
          VALUES ($1, $2, 390, 'paid', $3)
          ON CONFLICT (prodamus_order_id) DO UPDATE SET paid_at = $3, amount = 390, status = 'paid'
        `, [userId, orderId, paidAt]);

        imported++;

        // Отслеживаем самую раннюю дату платежа на пользователя
        if (!affectedUsers[userId] || paidAt < affectedUsers[userId]) {
          affectedUsers[userId] = paidAt;
        }

        await client.query('RELEASE SAVEPOINT row_' + i);
      } catch (rowErr) {
        await client.query('ROLLBACK TO SAVEPOINT row_' + i);
        skipped++;
        if (errors.length < 20) {
          errors.push({ row: i + 2, error: rowErr.message });
        }
      }
    }

    // --- Пост-обработка: обновляем created_at и started_at по самой ранней дате платежа ---
    var userIds = Object.keys(affectedUsers);
    for (var u = 0; u < userIds.length; u++) {
      var uid = userIds[u];
      var earliest = affectedUsers[uid];

      // users.created_at = MIN(текущий, earliest)
      await client.query(
        'UPDATE users SET created_at = LEAST(created_at, $1) WHERE id = $2',
        [earliest, uid]
      );

      // Последняя по expires_at membership-запись пользователя:
      // started_at = MIN(текущий started_at, earliest)
      var membership = await client.query(
        'SELECT id, started_at FROM memberships WHERE user_id = $1 ORDER BY expires_at DESC NULLS LAST LIMIT 1',
        [uid]
      );
      if (membership.rows.length > 0) {
        await client.query(
          'UPDATE memberships SET started_at = LEAST(started_at, $1) WHERE id = $2',
          [earliest, membership.rows[0].id]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /admin/import-payments-history error:', err);
    return res.status(500).json({ error: 'Ошибка сервера при импорте', details: err.message });
  } finally {
    client.release();
  }

  res.json({
    message: 'Импорт истории платежей завершён',
    total: rows.length,
    imported: imported,
    skipped: skipped,
    usersUpdated: Object.keys(affectedUsers).length,
    unmatchedCount: unmatched.length,
    unmatched: unmatched,
  });
});

// ---------------------------------------------------------
// ВЛАДЕЛЕЦ: полный импорт базы подписчиков из двух CSV-файлов
// Prodamus:
//   - paylist: полная история платежей (paylist.csv), разделитель ';',
//     одна строка = один платёж. Колонки (среди прочих): "ID заказа",
//     "Дата", "Телефон", "E-mail", "Сумма", "Статус", "Тип платежа",
//     "Дополнительные данные", "Номер заказа", "tg_user_id".
//   - subscribers: текущий снимок статуса подписок (тот же формат,
//     что используется в /admin/import-subscribers-raw), разделитель
//     ';' или TAB. Содержит "Телефон", "Дата подписки",
//     "Будущий платеж", "Активность (пользователь)",
//     "Активность (менеджер)".
//
// Ожидает: { paylistCsv: "...", subscribersCsv: "...", debug: true|false }
//
// Логика:
//   1. Перед загрузкой удаляются ранее импортированные синтетические
//      записи платежей (prodamus_order_id LIKE 'bx_import_%'), которые
//      дублируют события из paylist.csv, чтобы не задвоить выручку.
//   2. Каждая строка paylist с успешным статусом ("Получен", "Обработан",
//      "Выплачен") создаёт запись в payments (status='paid'), строки со
//      статусом "Возвращен"/"Частично возвращен" - со status='refunded'
//      (не попадают в выручку благодаря фильтру status='paid' в аналитике).
//   3. Пользователь ищется по нормализованному телефону. Если не найден -
//      создаётся новая запись в users (телефон, e-mail; telegram_id -
//      если удалось определить из строки платежа, иначе NULL).
//   4. telegram_id для строки платежа определяется в порядке: колонка
//      tg_user_id -> колонка "Дополнительные данные" (если чисто
//      цифровая) -> парсинг "Номер заказа" по паттерну tg_<id>_<ts>.
//   5. После импорта платежей для каждого пользователя:
//      users.created_at = самая ранняя дата платежа (если она раньше
//      текущего значения).
//   6. Применяется снимок subscribers.csv: для каждого телефона
//      обновляется/создаётся последняя запись membership:
//      expires_at = "Будущий платеж" (если указан) иначе
//      "Дата подписки" + 30 дней; started_at = самая ранняя дата
//      платежа этого пользователя (из paylist), либо "Дата подписки"
//      - 30 дней, если платежей не найдено; status='active' всегда
//      (реальная активность определяется сравнением expires_at с
//      текущим моментом в запросах аналитики).
// ---------------------------------------------------------

// Парсер даты "ГГГГ-ММ-ДД ЧЧ:мм:сс" (используется в paylist "Дата" и
// subscribers "Дата подписки")
function parsePaylistDate(str) {
  if (!str) return null;
  var trimmed = String(str).trim();
  var m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    parseInt(m[4] || '0', 10),
    parseInt(m[5] || '0', 10),
    parseInt(m[6] || '0', 10)
  );
}

// Извлечение telegram_id из строки paylist.csv.
// Реальные Telegram ID состоят минимум из 5+ цифр (на практике 8-10) -
// это отсекает мусорные значения вроде "1" в "Дополнительные данные",
// которые иногда встречаются в выгрузке Prodamus и не являются
// telegram_id (вероятно, артефакт другого поля).
function extractTelegramIdFromPaylistRow(row) {
  var tgUserId = (row['tg_user_id'] || '').trim();
  if (tgUserId && /^\d{5,}$/.test(tgUserId)) return tgUserId;

  var extra = (row['Дополнительные данные'] || '').trim();
  if (extra && /^\d{5,}$/.test(extra)) return extra;

  var orderNum = (row['Номер заказа'] || '').trim();
  var m = orderNum.match(/^tg_(\d{5,})_/);
  if (m) return m[1];

  return null;
}

router.post('/admin/import-full-database', requireRole('owner'), async function (req, res) {
  var paylistCsv = req.body.paylistCsv;
  var subscribersCsv = req.body.subscribersCsv;

  if (!paylistCsv || typeof paylistCsv !== 'string' || !paylistCsv.trim()) {
    return res.status(400).json({ error: 'Поле "paylistCsv" обязательно и должно быть непустой строкой' });
  }
  if (!subscribersCsv || typeof subscribersCsv !== 'string' || !subscribersCsv.trim()) {
    return res.status(400).json({ error: 'Поле "subscribersCsv" обязательно и должно быть непустой строкой' });
  }

  var paylistParsed = parseSubscribersCsv(paylistCsv); // авто-определение разделителя
  var paylistRows = paylistParsed.rows;

  var subsParsed = parseSubscribersCsv(subscribersCsv);
  var subsRows = subsParsed.rows;

  if (paylistRows.length === 0) {
    return res.status(400).json({ error: 'paylistCsv не содержит строк данных' });
  }
  if (subsRows.length === 0) {
    return res.status(400).json({ error: 'subscribersCsv не содержит строк данных' });
  }

  var paylistHeaders = paylistParsed.headers;
  var COL_ORDER_ID = paylistHeaders.find(function (h) { return /id\s*заказа/i.test(h); });
  var COL_DATE = paylistHeaders.find(function (h) { return /^дата$/i.test(h); });
  var COL_PHONE = paylistHeaders.find(function (h) { return /телефон/i.test(h); });
  var COL_EMAIL = paylistHeaders.find(function (h) { return /e-?mail/i.test(h); });
  var COL_AMOUNT = paylistHeaders.find(function (h) { return /^сумма$/i.test(h); });
  var COL_STATUS = paylistHeaders.find(function (h) { return /^статус$/i.test(h); });

  if (!COL_ORDER_ID || !COL_DATE || !COL_PHONE || !COL_AMOUNT || !COL_STATUS) {
    return res.status(400).json({
      error: 'Не найдены обязательные колонки в paylistCsv ("ID заказа", "Дата", "Телефон", "Сумма", "Статус")',
      headers: paylistHeaders,
    });
  }

  var subsHeaders = subsParsed.headers;
  var SCOL_PHONE = subsHeaders.find(function (h) { return /телефон/i.test(h); });
  var SCOL_SUB_DATE = subsHeaders.find(function (h) { return /дата\s*подписки/i.test(h); });
  var SCOL_NEXT_PAYMENT = subsHeaders.find(function (h) { return /будущий\s*платеж/i.test(h); });

  if (!SCOL_PHONE || !SCOL_SUB_DATE) {
    return res.status(400).json({
      error: 'Не найдены обязательные колонки в subscribersCsv ("Телефон", "Дата подписки")',
      headers: subsHeaders,
    });
  }

  // --- Режим диагностики ---
  if (req.body.debug) {
    return res.json({
      paylist: {
        delimiter: paylistParsed.delimiter === '\t' ? 'TAB' : paylistParsed.delimiter,
        headers: paylistHeaders,
        detectedColumns: { orderId: COL_ORDER_ID, date: COL_DATE, phone: COL_PHONE, email: COL_EMAIL, amount: COL_AMOUNT, status: COL_STATUS },
        totalRows: paylistRows.length,
        sampleRows: paylistRows.slice(0, 3),
      },
      subscribers: {
        delimiter: subsParsed.delimiter === '\t' ? 'TAB' : subsParsed.delimiter,
        headers: subsHeaders,
        detectedColumns: { phone: SCOL_PHONE, subDate: SCOL_SUB_DATE, nextPayment: SCOL_NEXT_PAYMENT },
        totalRows: subsRows.length,
        sampleRows: subsRows.slice(0, 3),
      },
    });
  }

  var SUCCESS_STATUSES = ['получен', 'обработан', 'выплачен'];
  var REFUND_STATUSES = ['возвращен', 'частично возвращен'];

  var imported = 0;
  var refunded = 0;
  var skipped = 0;
  var usersCreated = 0;
  var errors = [];

  // userId -> самая ранняя дата платежа (для users.created_at / memberships.started_at)
  var earliestPaymentByUser = {};
  // phone -> userId (кеш для второго прохода по subscribers.csv)
  var userIdByPhone = {};

  var client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Шаг 1: удаляем старые синтетические записи из предыдущего импорта
    // (Bitrix-таблица), чтобы не задвоить выручку с данными из paylist.csv
    var deleted = await client.query("DELETE FROM payments WHERE prodamus_order_id LIKE 'bx_import_%'");
    var deletedCount = deleted.rowCount || 0;

    // Шаг 2: импорт платежей из paylist.csv
    for (var i = 0; i < paylistRows.length; i++) {
      var row = paylistRows[i];

      try {
        await client.query('SAVEPOINT row_' + i);

        var rawPhone = row[COL_PHONE];
        var rawEmail = COL_EMAIL ? row[COL_EMAIL] : null;
        var rawDate = row[COL_DATE];
        var rawAmount = row[COL_AMOUNT];
        var rawStatus = (row[COL_STATUS] || '').trim().toLowerCase();
        var orderId = (row[COL_ORDER_ID] || '').trim();

        var phone = normalizePhone(rawPhone);
        var paidAt = parsePaylistDate(rawDate);
        var amount = parseFloat(String(rawAmount).replace(',', '.')) || 390;

        if (!phone || !paidAt || !orderId) {
          skipped++;
          await client.query('RELEASE SAVEPOINT row_' + i);
          continue;
        }

        var isSuccess = SUCCESS_STATUSES.indexOf(rawStatus) !== -1;
        var isRefund = REFUND_STATUSES.indexOf(rawStatus) !== -1;

        if (!isSuccess && !isRefund) {
          skipped++;
          await client.query('RELEASE SAVEPOINT row_' + i);
          continue;
        }

        // --- Находим или создаём пользователя ---
        // Приоритет: сначала ищем по telegram_id из этой строки (если
        // удалось определить) - это подлинный идентификатор личности
        // в системе. Телефон у одного и того же человека может
        // отличаться между разными платежами (смена номера, оплата с
        // другой карты), поэтому матчинг только по телефону может
        // привести к попытке создать дубликат пользователя с уже
        // существующим telegram_id (нарушение UNIQUE-ограничения).
        // Если по telegram_id не нашли - ищем по телефону. Если и
        // так не нашли - создаём нового пользователя.
        var telegramIdForRow = extractTelegramIdFromPaylistRow(row);
        var emailForRow = (rawEmail && rawEmail.trim()) || null;

        var userId = userIdByPhone[phone];

        if (!userId && telegramIdForRow) {
          var byTg = await client.query('SELECT id FROM users WHERE telegram_id = $1 LIMIT 1', [telegramIdForRow]);
          if (byTg.rows.length > 0) userId = byTg.rows[0].id;
        }

        if (!userId) {
          var byPhone = await client.query('SELECT id FROM users WHERE phone = $1 LIMIT 1', [phone]);

          if (byPhone.rows.length > 0) {
            userId = byPhone.rows[0].id;
          } else {
            var inserted = await client.query(
              'INSERT INTO users (telegram_id, phone, email, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
              [telegramIdForRow, phone, emailForRow, paidAt]
            );
            userId = inserted.rows[0].id;
            usersCreated++;
          }
        }

        userIdByPhone[phone] = userId;

        // Дозаполняем недостающие telegram_id/email/phone у найденного
        // пользователя, если в этой строке платежа есть данные, а в
        // профиле они ещё не заполнены (никогда не перезатираем уже
        // имеющиеся значения)
        if (telegramIdForRow || emailForRow || phone) {
          var setClauses = [];
          var params = [];
          var idx = 1;
          if (telegramIdForRow) {
            setClauses.push('telegram_id = COALESCE(telegram_id, $' + idx + ')');
            params.push(telegramIdForRow);
            idx++;
          }
          if (emailForRow) {
            setClauses.push('email = COALESCE(email, $' + idx + ')');
            params.push(emailForRow);
            idx++;
          }
          if (phone) {
            setClauses.push('phone = COALESCE(phone, $' + idx + ')');
            params.push(phone);
            idx++;
          }
          params.push(userId);
          await client.query('UPDATE users SET ' + setClauses.join(', ') + ' WHERE id = $' + idx, params);
        }

        // --- Создаём запись платежа (идемпотентно по order_id) ---
        var paymentStatus = isSuccess ? 'paid' : 'refunded';

        await client.query(`
          INSERT INTO payments (user_id, prodamus_order_id, amount, status, paid_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (prodamus_order_id) DO UPDATE SET status = $4, paid_at = $5, amount = $3
        `, [userId, orderId, amount, paymentStatus, paidAt]);

        if (isSuccess) imported++;
        else refunded++;

        if (!earliestPaymentByUser[userId] || paidAt < earliestPaymentByUser[userId]) {
          earliestPaymentByUser[userId] = paidAt;
        }

        await client.query('RELEASE SAVEPOINT row_' + i);
      } catch (rowErr) {
        await client.query('ROLLBACK TO SAVEPOINT row_' + i);
        skipped++;
        if (errors.length < 30) {
          errors.push({ source: 'paylist', row: i + 2, error: rowErr.message });
        }
      }
    }

    // Шаг 3: применяем текущий снимок статусов из subscribers.csv
    var membershipsUpdated = 0;
    var membershipsCreated = 0;
    var subsSkipped = 0;

    for (var j = 0; j < subsRows.length; j++) {
      var srow = subsRows[j];

      try {
        await client.query('SAVEPOINT srow_' + j);

        var sRawPhone = srow[SCOL_PHONE];
        var sPhone = normalizePhone(sRawPhone);
        var subDate = parsePaylistDate(srow[SCOL_SUB_DATE]);
        var nextPaymentRaw = SCOL_NEXT_PAYMENT ? srow[SCOL_NEXT_PAYMENT] : null;
        var expiresAt = parseRuDateTime(nextPaymentRaw);

        if (!sPhone) {
          subsSkipped++;
          await client.query('RELEASE SAVEPOINT srow_' + j);
          continue;
        }

        if (!expiresAt && subDate) {
          expiresAt = new Date(subDate.getTime() + 30 * 24 * 60 * 60 * 1000);
        }
        if (!expiresAt) {
          subsSkipped++;
          await client.query('RELEASE SAVEPOINT srow_' + j);
          continue;
        }

        var sUserId = userIdByPhone[sPhone];
        if (!sUserId) {
          var byPhone2 = await client.query('SELECT id FROM users WHERE phone = $1 LIMIT 1', [sPhone]);
          if (byPhone2.rows.length > 0) {
            sUserId = byPhone2.rows[0].id;
            userIdByPhone[sPhone] = sUserId;
          }
        }

        if (!sUserId) {
          // телефон встретился только в снимке подписок, но не в истории
          // платежей и не в users - создаём пользователя по минимальным данным
          var insertedS = await client.query(
            'INSERT INTO users (phone, created_at) VALUES ($1, $2) RETURNING id',
            [sPhone, subDate || new Date()]
          );
          sUserId = insertedS.rows[0].id;
          userIdByPhone[sPhone] = sUserId;
          usersCreated++;
        }

        var startedAt = earliestPaymentByUser[sUserId] || (subDate ? new Date(subDate.getTime() - 30 * 24 * 60 * 60 * 1000) : new Date());

        var existingMembership = await client.query(
          'SELECT id FROM memberships WHERE user_id = $1 ORDER BY expires_at DESC NULLS LAST LIMIT 1',
          [sUserId]
        );

        if (existingMembership.rows.length > 0) {
          await client.query(
            "UPDATE memberships SET status = 'active', expires_at = $1, started_at = LEAST(started_at, $2) WHERE id = $3",
            [expiresAt, startedAt, existingMembership.rows[0].id]
          );
          membershipsUpdated++;
        } else {
          await client.query(
            "INSERT INTO memberships (user_id, status, expires_at, started_at) VALUES ($1, 'active', $2, $3)",
            [sUserId, expiresAt, startedAt]
          );
          membershipsCreated++;
        }

        // Подчищаем created_at пользователя, если есть более ранняя дата
        await client.query('UPDATE users SET created_at = LEAST(created_at, $1) WHERE id = $2', [startedAt, sUserId]);

        await client.query('RELEASE SAVEPOINT srow_' + j);
      } catch (sErr) {
        await client.query('ROLLBACK TO SAVEPOINT srow_' + j);
        subsSkipped++;
        if (errors.length < 30) {
          errors.push({ source: 'subscribers', row: j + 2, error: sErr.message });
        }
      }
    }

    await client.query('COMMIT');

    res.json({
      message: 'Полный импорт базы подписчиков завершён',
      deletedOldBitrixPayments: deletedCount,
      payments: {
        totalRows: paylistRows.length,
        imported: imported,
        refunded: refunded,
        skipped: skipped,
      },
      subscribers: {
        totalRows: subsRows.length,
        membershipsUpdated: membershipsUpdated,
        membershipsCreated: membershipsCreated,
        skipped: subsSkipped,
      },
      usersCreated: usersCreated,
      errors: errors,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /admin/import-full-database error:', err);
    return res.status(500).json({ error: 'Ошибка сервера при импорте', details: err.message });
  } finally {
    client.release();
  }
});


module.exports = router;
