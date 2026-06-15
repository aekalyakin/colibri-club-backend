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
 
app.use(express.json());
 
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
