const pool = require('./db');
const { notifyExpirationSoon, notifyExpired } = require('./bot');

// Запускать раз в день — проверяем истекающие и истёкшие членства
async function checkMemberships() {
  console.log('🔄 Проверка членств...');

  try {
    // 1. Членства, истекающие через 3 дня — шлём напоминание
    const expiringSoon = await pool.query(`
      SELECT u.telegram_id, m.expires_at
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.status = 'active'
        AND m.expires_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'
        AND u.telegram_id IS NOT NULL
    `);

    for (const row of expiringSoon.rows) {
      try {
        await notifyExpirationSoon(row.telegram_id, row.expires_at);
        console.log(`⏰ Напоминание отправлено: ${row.telegram_id}`);
      } catch (e) {
        console.error(`Ошибка уведомления ${row.telegram_id}:`, e.message);
      }
    }

    // 2. Истёкшие членства — меняем статус и уведомляем
    const expired = await pool.query(`
      UPDATE memberships
      SET status = 'expired'
      WHERE status = 'active' AND expires_at < NOW()
      RETURNING user_id
    `);

    for (const row of expired.rows) {
      const userResult = await pool.query(
        'SELECT telegram_id FROM users WHERE id = $1',
        [row.user_id]
      );
      if (userResult.rows[0]?.telegram_id) {
        try {
          await notifyExpired(userResult.rows[0].telegram_id);
          console.log(`😔 Членство истекло: ${userResult.rows[0].telegram_id}`);
        } catch (e) {
          console.error(`Ошибка уведомления об истечении:`, e.message);
        }
      }
    }

    console.log(`✅ Проверка завершена. Напоминаний: ${expiringSoon.rows.length}, истекло: ${expired.rows.length}`);

  } catch (err) {
    console.error('❌ Ошибка проверки членств:', err);
  }
}

// Запускаем каждые 24 часа
function startCron() {
  checkMemberships(); // сразу при старте
  setInterval(checkMemberships, 24 * 60 * 60 * 1000);
  console.log('⏱ Cron запущен — проверка членств каждые 24ч');
}

module.exports = { startCron };
