const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

// Уведомление об успешной оплате
async function notifyPaymentSuccess(telegramId, expiresAt) {
  const date = new Date(expiresAt).toLocaleDateString('ru-RU');
  await bot.sendMessage(telegramId,
    `✅ *Оплата прошла успешно!*\n\n` +
    `Добро пожаловать в Клуб Колибри 🐦\n` +
    `Членство активно до *${date}*\n\n` +
    `Теперь вы получаете клубные цены на все услуги салона.\n` +
    `Записаться: https://colibri-beauty.ru`,
    { parse_mode: 'Markdown' }
  );
}

// Напоминание об истечении членства (за 3 дня)
async function notifyExpirationSoon(telegramId, expiresAt) {
  const date = new Date(expiresAt).toLocaleDateString('ru-RU');
  await bot.sendMessage(telegramId,
    `⏰ *Напоминание*\n\n` +
    `Ваше членство в Клубе Колибри истекает *${date}*\n\n` +
    `Продлите членство за 390 ₽ и сохраните клубные цены:\n` +
    `${process.env.BASE_URL}`,
    { parse_mode: 'Markdown' }
  );
}

// Уведомление об истечении членства
async function notifyExpired(telegramId) {
  await bot.sendMessage(telegramId,
    `😔 *Членство истекло*\n\n` +
    `Ваше членство в Клубе Колибри закончилось.\n\n` +
    `Продлите за 390 ₽ и снова получайте скидки до 50%:\n` +
    `${process.env.BASE_URL}`,
    { parse_mode: 'Markdown' }
  );
}

// Команда /start — приветствие
bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `👋 Добро пожаловать в *Клуб Колибри*!\n\n` +
    `Скидки до 50% на все услуги салона за 390 ₽/месяц.\n\n` +
    `Открыть клуб: ${process.env.BASE_URL}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🐦 Открыть Клуб Колибри', web_app: { url: process.env.BASE_URL } }
        ]]
      }
    }
  );
});

// Команда /status — проверить статус членства
bot.onText(/\/status/, async (msg) => {
  const pool = require('./db');
  const telegramId = msg.chat.id;

  try {
    const result = await pool.query(`
      SELECT m.status, m.expires_at
      FROM users u
      JOIN memberships m ON m.user_id = u.id
      WHERE u.telegram_id = $1 AND m.status = 'active'
      ORDER BY m.expires_at DESC LIMIT 1
    `, [telegramId]);

    if (result.rows.length === 0) {
      await bot.sendMessage(telegramId,
        `❌ Активного членства не найдено.\n\nВступить в клуб: ${process.env.BASE_URL}`
      );
    } else {
      const date = new Date(result.rows[0].expires_at).toLocaleDateString('ru-RU');
      await bot.sendMessage(telegramId,
        `✅ *Членство активно*\nДействует до: *${date}*`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (err) {
    console.error('Ошибка /status:', err);
  }
});

module.exports = { bot, notifyPaymentSuccess, notifyExpirationSoon, notifyExpired };
