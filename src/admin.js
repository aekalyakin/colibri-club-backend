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
 
// Получить роль пользователя по telegram_id (null если не админ)
async function getRole(telegramId) {
  var result = await pool.query(
    'SELECT role FROM admins WHERE telegram_id = $1',
    [telegramId]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].role;
}
 
// Количество владельцев в системе
async function countOwners() {
  var result = await pool.query("SELECT COUNT(*) FROM admins WHERE role = 'owner'");
  return parseInt(result.rows[0].count, 10);
}
 
// Нормализация телефона к виду 7XXXXXXXXXX (11 цифр, без +, начиная с 7)
// Принимает форматы: +79998887766, 89998887766, 79998887766, с пробелами/скобками/тире
function normalizePhone(phone) {
  if (!phone) return null;
  var digits = String(phone).replace(/[^0-9]/g, '');
  if (digits.length === 11 && digits[0] === '8') {
    digits = '7' + digits.slice(1);
  }
  if (digits.length === 10) {
    digits = '7' + digits;
  }
  if (digits.length !== 11 || digits[0] !== '7') {
    return null;
  }
  return digits;
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
  var normalizedPhone = normalizePhone(req.query.phone);
 
  if (!normalizedPhone) {
    return res.status(400).json({ error: 'Некорректный или отсутствующий номер телефона' });
  }
 
  try {
    var result = await pool.query(`
      SELECT u.full_name, u.phone, u.telegram_id,
             m.status, m.expires_at
      FROM users u
      LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
      WHERE u.phone = $1 OR u.phone = $2
      ORDER BY m.expires_at DESC
      LIMIT 1
    `, [normalizedPhone, '8' + normalizedPhone.slice(1)]); // на случай разных форматов (8.. / 7..)
 
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
      var normalizedPhone = normalizePhone(targetPhone);
      if (!normalizedPhone) {
        return res.status(400).json({ error: 'Некорректный формат телефона' });
      }
      var userResult = await pool.query(
        'SELECT telegram_id FROM users WHERE phone = $1 OR phone = $2',
        [normalizedPhone, '8' + normalizedPhone.slice(1)]
      );
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь с таким телефоном не найден. Пользователь должен хотя бы раз открыть Mini App.' });
      }
      resolvedTelegramId = userResult.rows[0].telegram_id;
    }
 
    if (!resolvedTelegramId) {
      return res.status(400).json({ error: 'Укажите telegramId или phone' });
    }
 
    // Защита: нельзя понизить роль последнего владельца -
    // система всегда должна иметь хотя бы одного владельца
    var currentTargetRole = await getRole(resolvedTelegramId);
    if (currentTargetRole === 'owner' && role !== 'owner') {
      var ownersCount = await countOwners();
      if (ownersCount <= 1) {
        return res.status(403).json({ error: 'Нельзя понизить последнего владельца. Сначала назначьте другого владельца.' });
      }
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
 
    // Защита: нельзя удалить последнего владельца -
    // система всегда должна иметь хотя бы одного владельца
    if (targetRole === 'owner') {
      var ownersCount = await countOwners();
      if (ownersCount <= 1) {
        return res.status(403).json({ error: 'Нельзя удалить последнего владельца. Сначала назначьте другого владельца.' });
      }
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
// ВЛАДЕЛЕЦ: импорт подписчиков из CSV-выгрузки Prodamus
// (https://colibri13.payform.ru/subscribers/csv?charset=utf-8)
//
// Принимает JSON-массив строк (парсинг CSV выполняется на
// фронтенде), каждая строка содержит поля из выгрузки Prodamus:
// phone, tgId, expiresAt ("ДД.ММ.ГГГГ ЧЧ:мм"), active (булево)
//
// Для каждой строки:
// - ищем пользователя по telegram_id (если указан) или по телефону
// - если найден - обновляем телефон/telegram_id (дозаполняем) и
//   создаём/обновляем активное членство с датой expires_at
// - если не найден - создаём нового пользователя
// ---------------------------------------------------------
router.post('/admin/import-subscribers', requireRole('owner'), express.json({ limit: '5mb' }), async function (req, res) {
  var rows = req.body.rows;
 
  if (!Array.isArray(rows)) {
    return res.status(400).json({ error: 'rows должен быть массивом' });
  }
 
  var stats = { total: rows.length, updated: 0, created: 0, skipped: 0, errors: 0 };
 
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    try {
      var normalizedPhone = normalizePhone(row.phone);
      var telegramId = row.tgId ? String(row.tgId).trim() : null;
 
      if (!normalizedPhone && !telegramId) {
        stats.skipped++;
        continue;
      }
 
      // Парсим дату "ДД.ММ.ГГГГ ЧЧ:мм" в expires_at
      var expiresAt = parseRuDateTime(row.expiresAt);
      if (!expiresAt) {
        stats.skipped++;
        continue;
      }
 
      var isActive = !!row.active;
 
      // Ищем пользователя: сначала по telegram_id, затем по телефону
      var userRow = null;
 
      if (telegramId) {
        var byTg = await pool.query('SELECT id, phone FROM users WHERE telegram_id = $1', [telegramId]);
        if (byTg.rows.length > 0) userRow = byTg.rows[0];
      }
 
      if (!userRow && normalizedPhone) {
        var byPhone = await pool.query(
          'SELECT id, telegram_id FROM users WHERE phone = $1 OR phone = $2',
          [normalizedPhone, '8' + normalizedPhone.slice(1)]
        );
        if (byPhone.rows.length > 0) userRow = byPhone.rows[0];
      }
 
      var userId;
 
      if (userRow) {
        userId = userRow.id;
        // Дозаполняем недостающие поля (телефон/telegram_id), не перетирая существующие
        var setClauses = [];
        var setValues = [];
        var paramIdx = 1;
 
        if (normalizedPhone && !userRow.phone) {
          setClauses.push('phone = $' + (paramIdx++));
          setValues.push(normalizedPhone);
        }
        if (telegramId && !userRow.telegram_id) {
          setClauses.push('telegram_id = $' + (paramIdx++));
          setValues.push(telegramId);
        }
        if (setClauses.length > 0) {
          setValues.push(userId);
          await pool.query('UPDATE users SET ' + setClauses.join(', ') + ' WHERE id = $' + paramIdx, setValues);
        }
        stats.updated++;
      } else {
        var insertResult = await pool.query(
          'INSERT INTO users (telegram_id, phone) VALUES ($1, $2) RETURNING id',
          [telegramId || null, normalizedPhone || null]
        );
        userId = insertResult.rows[0].id;
        stats.created++;
      }
 
      // Обновляем/создаём членство
      var existingMembership = await pool.query(
        "SELECT id FROM memberships WHERE user_id = $1 ORDER BY expires_at DESC LIMIT 1",
        [userId]
      );
 
      var status = isActive ? 'active' : 'expired';
 
      if (existingMembership.rows.length > 0) {
        await pool.query(
          'UPDATE memberships SET status = $1, expires_at = $2 WHERE id = $3',
          [status, expiresAt, existingMembership.rows[0].id]
        );
      } else {
        await pool.query(
          'INSERT INTO memberships (user_id, status, expires_at) VALUES ($1, $2, $3)',
          [userId, status, expiresAt]
        );
      }
    } catch (err) {
      console.error('Import row error:', err.message, row);
      stats.errors++;
    }
  }
 
  res.json({ ok: true, stats: stats });
});
 
// Парсинг даты формата "ДД.ММ.ГГГГ ЧЧ:мм" (как в выгрузке Prodamus)
function parseRuDateTime(str) {
  if (!str) return null;
  var match = String(str).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  var day = parseInt(match[1], 10);
  var month = parseInt(match[2], 10) - 1;
  var year = parseInt(match[3], 10);
  var hour = parseInt(match[4], 10);
  var minute = parseInt(match[5], 10);
  return new Date(year, month, day, hour, minute);
}
 
module.exports = router;
 
