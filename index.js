
require('dotenv').config(); // إضافة هذا السطر لتحميل .env
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3001;

// --- CONFIGURATION ---
// FIX: Hardcoded secrets are a security risk. Load from environment variables.
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

// Use persistent storage path if available (for Coolify), otherwise use a local 'data' folder.
const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, 'data');

const PRAYER_TIMES_PATH = path.join(DATA_PATH, 'prayer_times.json');
const SUBSCRIBERS_PATH = path.join(DATA_PATH, 'subscribers.json');

// Ensure the data directory exists
if (!fs.existsSync(DATA_PATH)) {
  fs.mkdirSync(DATA_PATH, { recursive: true });
  console.log(`Created data directory at: ${DATA_PATH}`);
}

// --- INITIALIZATION ---
// FIX: Ensure the application fails fast if critical configuration is missing.
if (!TELEGRAM_TOKEN) {
  console.error('FATAL ERROR: TELEGRAM_TOKEN environment variable is not set.');
  process.exit(1);
}
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- API ENDPOINTS ---
app.post('/api/update_times', async (req, res) => {
  try {
    const prayerData = req.body;
    if (!Array.isArray(prayerData)) {
      return res.status(400).json({ message: 'Invalid data format. Expected an array.' });
    }
    await fsp.writeFile(PRAYER_TIMES_PATH, JSON.stringify(prayerData, null, 2));
    const message = `Successfully updated prayer_times.json with ${prayerData.length} entries.`;
    console.log(message);
    res.status(200).json({ message });
  } catch (error) {
    console.error('Error updating prayer times:', error);
    res.status(500).json({ message: 'Failed to update prayer times.' });
  }
});

// --- TELEGRAM BOT LOGIC ---
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    let subscribers = [];
    try {
      const data = await fsp.readFile(SUBSCRIBERS_PATH, 'utf8');
      subscribers = JSON.parse(data);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      console.log('subscribers.json not found, creating a new one.');
    }

    if (!subscribers.includes(chatId)) {
      subscribers.push(chatId);
      await fsp.writeFile(SUBSCRIBERS_PATH, JSON.stringify(subscribers, null, 2));
      bot.sendMessage(chatId, 'أهلاً بك! تم اشتراكك في خدمة إشعارات الأذان. ستصلك رسالة عند كل وقت صلاة.');
      console.log(`New subscriber added: ${chatId}`);
    } else {
      bot.sendMessage(chatId, 'أنت مشترك بالفعل في خدمة الإشعارات.');
    }
  } catch (error) {
    console.error('Error handling /start command:', error);
    bot.sendMessage(chatId, 'حدث خطأ ما أثناء محاولة تسجيل اشتراكك. يرجى المحاولة مرة أخرى.');
  }
});

console.log('Telegram bot is running and listening for commands...');

// --- SCHEDULER (CRON JOB) ---
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const currentTime = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Algiers' });
    const currentDate = now.toLocaleDateString('en-CA', { timeZone: 'Africa/Algiers' }); // YYYY-MM-DD

    let prayerTimes = [];
    try {
      const prayerData = await fsp.readFile(PRAYER_TIMES_PATH, 'utf8');
      prayerTimes = JSON.parse(prayerData);
    } catch (error) {
      if (error.code === 'ENOENT') return; // No prayer times file yet, skip.
      throw error;
    }

    const todaysPrayers = prayerTimes.find(p => p.date === currentDate);
    if (!todaysPrayers) return;

    const prayerMap = { 'fajr': 'الفجر', 'dhuhr': 'الظهر', 'asr': 'العصر', 'maghrib': 'المغرب', 'isha': 'العشاء' };

    for (const [prayerKey, prayerTime] of Object.entries(todaysPrayers)) {
      if (prayerKey !== 'date' && prayerTime === currentTime) {
        const prayerName = prayerMap[prayerKey];
        const message = `🕌 حان الآن موعد أذان ${prayerName} حسب توقيت مدينة الصالح، الجزائر (${prayerTime})`;
        console.log(`Time match: ${prayerName} at ${currentTime}. Sending notifications...`);

        let subscribers = [];
        try {
          const subsData = await fsp.readFile(SUBSCRIBERS_PATH, 'utf8');
          subscribers = JSON.parse(subsData);
        } catch (error) {
          if (error.code === 'ENOENT') { console.log('No subscribers to notify.'); return; }
          throw error;
        }

        subscribers.forEach(chatId => {
          bot.sendMessage(chatId, message).catch(err => console.error(`Failed to send to ${chatId}:`, err.message));
        });
      }
    }
  } catch (error) {
    console.error('Error in cron job:', error);
  }
});

console.log('Cron job scheduled to run every minute.');

// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});