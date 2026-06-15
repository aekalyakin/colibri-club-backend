// ============================================================
// Скрипт импорта подписчиков из CSV (Prodamus) в БД Колибри-клуба
//
// Использование:
//   1. Положите файл subscribers.csv рядом с этим скриптом
//   2. Подставьте OWNER_TELEGRAM_ID ниже
//   3. Запустите: node import.js
// ============================================================

const fs = require('fs');
const path = require('path');

// --- НАСТРОЙКИ ---
const API_URL = 'https://colibri-club-backend-production.up.railway.app/admin/import-subscribers-raw';
const OWNER_TELEGRAM_ID = 'ВАШ_TELEGRAM_ID'; // <-- замените на свой telegram_id владельца
const CSV_PATH = path.join(__dirname, 'subscribers.csv');

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`Файл не найден: ${CSV_PATH}`);
    console.error('Положите subscribers.csv в ту же папку, что и import.js');
    process.exit(1);
  }

  if (OWNER_TELEGRAM_ID === 'ВАШ_TELEGRAM_ID') {
    console.error('Укажите свой OWNER_TELEGRAM_ID в начале файла import.js');
    process.exit(1);
  }

  const csvContent = fs.readFileSync(CSV_PATH, 'utf-8');
  console.log(`Прочитан файл: ${CSV_PATH} (${csvContent.length} символов)`);

  console.log('Отправляю запрос на:', API_URL);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Id': OWNER_TELEGRAM_ID,
      },
      body: JSON.stringify({ csv: csvContent }),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error('Сервер вернул не-JSON ответ:');
      console.error(text);
      process.exit(1);
    }

    if (!response.ok) {
      console.error(`Ошибка ${response.status}:`, data);
      process.exit(1);
    }

    console.log('\n=== Импорт завершён ===');
    console.log('Всего строк:', data.total);
    console.log('Обновлено:', data.updated);
    console.log('Создано:', data.created);
    console.log('Пропущено:', data.skipped);

    if (data.errors && data.errors.length > 0) {
      console.log('\nОшибки по строкам (первые 20):');
      data.errors.forEach(e => console.log(`  Строка ${e.row}: ${e.error}`));
    }
  } catch (err) {
    console.error('Ошибка запроса:', err.message);
    process.exit(1);
  }
}

main();
