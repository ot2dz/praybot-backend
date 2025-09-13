
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

// --- ENHANCED NOTIFICATION SYSTEM ---
const sentNotifications = new Map(); // تتبع الإشعارات المرسلة
const NOTIFICATION_COOLDOWN = 60000; // منع التكرار لمدة دقيقة

// نظام الكاش المحسن
let prayerTimesCache = null;
let subscribersCache = null;
let prayerCacheTimestamp = 0;
let subscribersCacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 دقائق

const PRAYER_NAMES = { 
  'fajr': 'الفجر', 
  'dhuhr': 'الظهر', 
  'asr': 'العصر', 
  'maghrib': 'المغرب', 
  'isha': 'العشاء' 
};

const PRAYER_TIMES_PATH = path.join(DATA_PATH, 'prayer_times.json');
const SUBSCRIBERS_PATH = path.join(DATA_PATH, 'subscribers.json');

// Ensure the data directory exists
if (!fs.existsSync(DATA_PATH)) {
  fs.mkdirSync(DATA_PATH, { recursive: true });
  console.log(`Created data directory at: ${DATA_PATH}`);
}

// --- ENHANCED CACHE SYSTEM ---
async function loadPrayerTimesCache() {
  const now = Date.now();
  if (prayerTimesCache && (now - prayerCacheTimestamp < CACHE_TTL)) {
    return prayerTimesCache;
  }

  try {
    const prayerData = await fsp.readFile(PRAYER_TIMES_PATH, 'utf8');
    prayerTimesCache = JSON.parse(prayerData);
    prayerCacheTimestamp = now;
    console.log(`📋 Prayer times cache refreshed: ${prayerTimesCache.length} entries`);
    return prayerTimesCache;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('📋 No prayer times file found');
      return [];
    }
    console.error('❌ Error loading prayer times:', error);
    throw error;
  }
}

async function loadSubscribersCache() {
  const now = Date.now();
  if (subscribersCache && (now - subscribersCacheTimestamp < CACHE_TTL)) {
    return subscribersCache;
  }

  try {
    const subsData = await fsp.readFile(SUBSCRIBERS_PATH, 'utf8');
    subscribersCache = JSON.parse(subsData);
    subscribersCacheTimestamp = now;
    console.log(`👥 Subscribers cache refreshed: ${subscribersCache.length} users`);
    return subscribersCache;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('👥 No subscribers file found');
      return [];
    }
    console.error('❌ Error loading subscribers:', error);
    throw error;
  }
}

// تنظيف الذاكرة من الإشعارات القديمة
function cleanupOldNotifications() {
  const now = Date.now();
  const oneDayAgo = now - (24 * 60 * 60 * 1000);
  let cleaned = 0;
  
  for (const [key, timestamp] of sentNotifications.entries()) {
    if (timestamp < oneDayAgo) {
      sentNotifications.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} old notification records`);
  }
}

// --- ENHANCED NOTIFICATION SYSTEM ---
async function sendPrayerNotification(prayerKey, prayerName, prayerTime, currentDate) {
  try {
    const notificationKey = `${currentDate}-${prayerKey}`;
    
    // التحقق من عدم إرسال الإشعار مسبقاً
    if (sentNotifications.has(notificationKey)) {
      const sentTime = sentNotifications.get(notificationKey);
      if (Date.now() - sentTime < NOTIFICATION_COOLDOWN) {
        console.log(`⏭️ Notification for ${prayerName} already sent recently`);
        return false;
      }
    }

    const subscribers = await loadSubscribersCache();
    if (subscribers.length === 0) {
      console.log('📭 No subscribers to notify');
      return true;
    }

    const message = `🕌 حان الآن موعد أذان ${prayerName} حسب توقيت مدينة عين صالح وضواحيها  (${prayerTime})`;
    
    console.log(`📢 Sending ${prayerName} notification to ${subscribers.length} subscribers...`);
    
    // إرسال الإشعارات مع معالجة محسنة للأخطاء
    const sendPromises = subscribers.map(async (chatId) => {
      try {
        await bot.sendMessage(chatId, message);
        return { chatId, success: true };
      } catch (error) {
        console.error(`❌ Failed to send to ${chatId}:`, error.message);
        return { chatId, success: false, error: error.message };
      }
    });

    const results = await Promise.allSettled(sendPromises);
    const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    const failed = results.length - successful;

    // حفظ سجل الإشعار كمُرسل
    sentNotifications.set(notificationKey, Date.now());
    
    // تسجيل النتائج
    console.log(`📊 ${prayerName} notification results: ✅ ${successful} successful, ❌ ${failed} failed`);
    
    // إضافة للوج المفصل
    logNotificationEvent({
      prayerKey,
      prayerName,
      prayerTime,
      currentDate,
      totalSubscribers: subscribers.length,
      successful,
      failed,
      timestamp: new Date().toISOString()
    });

    return successful > 0;
  } catch (error) {
    console.error('❌ Error in sendPrayerNotification:', error);
    return false;
  }
}

// نظام لوجينج محسن
function logNotificationEvent(eventData) {
  const logEntry = {
    type: 'PRAYER_NOTIFICATION',
    ...eventData,
    serverTimestamp: new Date().toISOString(),
    timezone: 'Africa/Algiers'
  };
  
  console.log('📝 Notification Event:', JSON.stringify(logEntry, null, 2));
  
  // يمكن إضافة حفظ في ملف لوج مستقبلاً إذا احتجت
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
  const username = msg.from.username || 'Unknown';
  
  try {
    let subscribers = [];
    try {
      const data = await fsp.readFile(SUBSCRIBERS_PATH, 'utf8');
      subscribers = JSON.parse(data);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      console.log('📄 subscribers.json not found, creating a new one.');
    }

    if (!subscribers.includes(chatId)) {
      subscribers.push(chatId);
      await fsp.writeFile(SUBSCRIBERS_PATH, JSON.stringify(subscribers, null, 2));
      
      // تحديث الكاش
      subscribersCache = subscribers;
      subscribersCacheTimestamp = Date.now();
      
      bot.sendMessage(chatId, '🕌 أهلاً بك! تم اشتراكك في خدمة إشعارات الأذان.\n\n✅ ستصلك رسالة عند كل وقت صلاة حسب توقيت مدينة الصالح، الجزائر.\n\n📱 يمكنك إيقاف الإشعارات في أي وقت بحذف المحادثة.');
      
      console.log(`👤 New subscriber added: ${chatId} (@${username})`);
      console.log(`👥 Total subscribers: ${subscribers.length}`);
    } else {
      bot.sendMessage(chatId, '✅ أنت مشترك بالفعل في خدمة الإشعارات.\n\n🔔 ستصلك التنبيهات عند كل وقت صلاة.');
      console.log(`🔄 Existing subscriber: ${chatId} (@${username})`);
    }
  } catch (error) {
    console.error(`❌ Error handling /start command for ${chatId}:`, error);
    bot.sendMessage(chatId, '❌ حدث خطأ ما أثناء محاولة تسجيل اشتراكك. يرجى المحاولة مرة أخرى.');
  }
});

console.log('Telegram bot is running and listening for commands...');

// --- ENHANCED SCHEDULER (CRON JOB) ---
// تشغيل كل 30 ثانية للحصول على دقة أفضل
cron.schedule('*/30 * * * * *', async () => {
  try {
    const now = new Date();
    
    // تحسين دقة التوقيت باستخدام Intl API
    const algeriaTime = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Algiers',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(now);

    const currentDate = `${algeriaTime.find(p => p.type === 'year').value}-${algeriaTime.find(p => p.type === 'month').value}-${algeriaTime.find(p => p.type === 'day').value}`;
    const currentTime = `${algeriaTime.find(p => p.type === 'hour').value}:${algeriaTime.find(p => p.type === 'minute').value}`;
    
    // استخدام الكاش المحسن
    const prayerTimes = await loadPrayerTimesCache();
    if (prayerTimes.length === 0) return;

    const todaysPrayers = prayerTimes.find(p => p.date === currentDate);
    if (!todaysPrayers) return;

    // البحث عن أوقات الصلاة المطابقة
    for (const [prayerKey, prayerTime] of Object.entries(todaysPrayers)) {
      if (prayerKey !== 'date' && prayerTime === currentTime) {
        const prayerName = PRAYER_NAMES[prayerKey];
        if (prayerName) {
          console.log(`⏰ Time match detected: ${prayerName} at ${currentTime}`);
          
          const success = await sendPrayerNotification(prayerKey, prayerName, prayerTime, currentDate);
          
          if (success) {
            console.log(`✅ Successfully handled ${prayerName} notification`);
          } else {
            console.log(`⚠️ ${prayerName} notification handling completed with issues`);
          }
        }
      }
    }

    // تنظيف الذاكرة كل 10 دقائق
    if (now.getMinutes() % 10 === 0 && now.getSeconds() < 30) {
      cleanupOldNotifications();
    }
    
  } catch (error) {
    console.error('❌ Error in enhanced prayer notification system:', error);
  }
});

// Health check - تشغيل كل ساعة
cron.schedule('0 * * * *', () => {
  const timestamp = new Date().toISOString();
  console.log(`💗 Prayer notification system health check - ${timestamp}`);
  console.log(`📊 System status:`);
  console.log(`   📋 Prayer cache: ${prayerTimesCache ? `${prayerTimesCache.length} entries` : 'Empty'}`);
  console.log(`   👥 Subscribers cache: ${subscribersCache ? `${subscribersCache.length} users` : 'Empty'}`);
  console.log(`   🔔 Sent notifications tracked: ${sentNotifications.size}`);
  console.log(`   🕒 Timezone: Africa/Algiers`);
});

console.log('✅ Enhanced prayer notification system initialized');
console.log('⚡ Cron job scheduled to run every 30 seconds');
console.log('💾 Caching system active with 5-minute TTL');
console.log('🔄 Duplicate notification prevention enabled');
console.log('💗 Health checks scheduled every hour');

// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});