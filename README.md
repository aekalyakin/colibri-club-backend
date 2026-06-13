# Клуб Колибри — Деплой на VPS (Ubuntu)

## 1. Подключитесь к серверу
```bash
ssh root@ВАШ_IP_СЕРВЕРА
```

## 2. Установите Node.js 20
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v  # должно показать v20.x.x
```

## 3. Установите PostgreSQL
```bash
sudo apt install postgresql postgresql-contrib -y
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

## 4. Создайте базу данных
```bash
sudo -u postgres psql
```
В консоли PostgreSQL выполните:
```sql
CREATE USER colibri WITH PASSWORD 'ПРИДУМАЙТЕ_ПАРОЛЬ';
CREATE DATABASE colibri_club OWNER colibri;
GRANT ALL PRIVILEGES ON DATABASE colibri_club TO colibri;
\q
```

## 5. Залейте файлы проекта на сервер
```bash
# На вашем компьютере — скопируйте папку на сервер
scp -r ./colibri-club root@ВАШ_IP:/var/www/colibri-club
```
Или создайте вручную через FileZilla / любой FTP-клиент.

## 6. Настройте .env
```bash
cd /var/www/colibri-club
cp .env.example .env
nano .env   # заполните все значения
```

## 7. Инициализируйте базу данных
```bash
sudo -u postgres psql -d colibri_club -f config/db_init.sql
```

## 8. Установите зависимости
```bash
npm install
```

## 9. Установите PM2 (автозапуск)
```bash
npm install -g pm2
pm2 start src/server.js --name colibri-club
pm2 save
pm2 startup   # следуйте инструкции в терминале
```

## 10. Настройте Nginx
```bash
sudo apt install nginx -y
sudo nano /etc/nginx/sites-available/colibri-club
```
Вставьте конфиг:
```nginx
server {
    listen 80;
    server_name colibri-beauty.ru;

    location /club/api/ {
        proxy_pass http://localhost:3000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /club {
        root /var/www/colibri-club/public;
        try_files $uri $uri/ /index.html;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/colibri-club /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 11. SSL-сертификат (Let's Encrypt)
```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d colibri-beauty.ru
```

## 12. Зарегистрируйте Mini App в Telegram
1. Откройте @BotFather
2. Напишите `/newapp`
3. Выберите вашего бота
4. URL приложения: `https://colibri-beauty.ru/club`

## 13. Настройте Prodamus Webhook
В личном кабинете Prodamus укажите URL вебхука:
```
https://colibri-beauty.ru/club/api/prodamus/webhook
```

## Проверка работы
```bash
# Статус сервера
pm2 status

# Логи в реальном времени
pm2 logs colibri-club

# Health check
curl https://colibri-beauty.ru/club/api/health
```
