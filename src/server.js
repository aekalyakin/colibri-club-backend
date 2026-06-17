const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS — разрешаем запросы с сайта
app.use(cors({
  origin: [
    'https://colibri-beauty.ru',
    'https://t.me',
    'https://colibriclub13.netlify.app',
    /\.netlify\.app$/,
    'null' // локальные HTML-файлы (file://), например админ-инструмент импорта
  ],
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Telegram-Id'],
}));

// Лимит тела запроса увеличен с дефолтных 100kb до 15mb — нужно для
// административных эндпоинтов импорта CSV (история платежей,
// полная база подписчиков), где тело запроса может быть существенно
// больше стандартного лимита Express.
app.use(express.json({ limit: '15mb' }));

// Роуты
const apiRoutes = require('./api');
const paymentRoutes = require('./payments');
const adminRoutes = require('./admin');

app.use('/api', apiRoutes);
app.use('/api', paymentRoutes);
app.use('/api', adminRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Обработчик ошибок body-parser (например, превышение лимита размера
// тела запроса) — возвращаем JSON вместо HTML-страницы по умолчанию,
// чтобы клиентский код не падал на парсинге ответа
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    console.warn('Request body too large:', err.message);
    return res.status(413).json({ error: 'Тело запроса превышает допустимый размер' });
  }
  if (err && err.type === 'entity.parse.failed') {
    console.warn('Invalid JSON in request body:', err.message);
    return res.status(400).json({ error: 'Некорректный JSON в теле запроса' });
  }
  next(err);
});

// Запуск сервера
app.listen(PORT, async () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📍 BASE_URL: ${process.env.BASE_URL}`);

  // Создаём таблицы в базе данных, если их ещё нет
  const { runMigrations } = require('./migrate');
  await runMigrations();

  // Запускаем бота
  const { bot } = require('./bot');
  bot.startPolling();
  console.log('🤖 Telegram бот запущен');

  // Запускаем крон
  const { startCron } = require('./cron');
  startCron();
});
