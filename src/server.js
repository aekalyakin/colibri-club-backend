const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS — разрешаем запросы с сайта
app.use(cors({
  origin: ['https://colibri-beauty.ru', 'https://t.me'],
  methods: ['GET', 'POST', 'PATCH'],
}));

app.use(express.json());

// Роуты
const apiRoutes = require('./api');
const paymentRoutes = require('./payments');

app.use('/api', apiRoutes);
app.use('/api', paymentRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📍 BASE_URL: ${process.env.BASE_URL}`);

  // Запускаем бота
  const { bot } = require('./bot');
  bot.startPolling();
  console.log('🤖 Telegram бот запущен');

  // Запускаем крон
  const { startCron } = require('./cron');
  startCron();
});
