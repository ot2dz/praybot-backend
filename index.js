
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

// --- SUBSCRIBER & SETTINGS MANAGEMENT ---
const DEFAULT_SETTINGS = {
  globalReminderMinutes: 5,
};

async function saveSubscribers(subscribers) {
  try {
    // Ensure subscribers is an array of objects before saving
    const validSubscribers = subscribers.filter(s => s && typeof s.chatId !== 'undefined');
    await fsp.writeFile(SUBSCRIBERS_PATH, JSON.stringify(validSubscribers, null, 2));
    subscribersCache = validSubscribers; // Update cache immediately
    subscribersCacheTimestamp = Date.now();
  } catch (error) {
    console.error('❌ Error saving subscribers file:', error);
  }
}

async function removeSubscriber(chatId) {
  let subscribers = await loadSubscribersCache();
  const initialCount = subscribers.length;
  const updatedSubscribers = subscribers.filter(s => s.chatId !== chatId);
  
  if (updatedSubscribers.length < initialCount) {
    await saveSubscribers(updatedSubscribers);
    console.log(`🗑️ Subscriber ${chatId} removed. Total subscribers: ${updatedSubscribers.length}`);
    return true;
  }
  return false;
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
    let subscribers;
    try {
      const subsData = await fsp.readFile(SUBSCRIBERS_PATH, 'utf8');
      subscribers = JSON.parse(subsData);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('👥 No subscribers file found, creating a new one.');
        await saveSubscribers([]);
        return [];
      }
      if (error instanceof SyntaxError) {
        console.error('Corrupt subscribers.json, initializing as empty array.');
        await saveSubscribers([]);
        return [];
      }
      throw error;
    }
    
    // Migrate-on-read: Check if the structure needs updating
    let needsSave = false;
    if (subscribers.length > 0 && typeof subscribers[0] === 'number') {
      console.log('🔄 Migrating subscribers to new object format...');
      subscribers = subscribers.map(chatId => ({
        chatId: chatId,
        settings: { ...DEFAULT_SETTINGS }
      }));
      needsSave = true;
    }

    // Data integrity check: ensure all items are objects with chatId and settings
    const cleanSubscribers = subscribers
      .filter(s => s && typeof s.chatId !== 'undefined')
      .map(s => {
        if (!s.settings) {
          s.settings = { ...DEFAULT_SETTINGS };
          needsSave = true;
        }
        return s;
      });

    if(cleanSubscribers.length !== subscribers.length) {
        console.warn('⚠️ Found and removed invalid entries from subscribers list.');
        needsSave = true;
    }
    
    if (needsSave) {
        await saveSubscribers(cleanSubscribers);
        if (subscribers.length > 0 && typeof subscribers[0] === 'number') {
            console.log('✅ Migration complete. Subscribers are now in the new format.');
        }
    }

    subscribersCache = cleanSubscribers;
    subscribersCacheTimestamp = now;
    console.log(`👥 Subscribers cache refreshed: ${subscribersCache.length} users`);
    return subscribersCache;
  } catch (error) {
    console.error('❌ Error loading subscribers:', error);
    throw error;
  }
}

// --- NOTIFICATION SCHEDULER & QUEUE ---
let notificationQueue = [];
const prayerOrder = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

// Function to parse HH:mm time and subtract minutes
function subtractMinutes(time, minutes) {
    const [hours, mins] = time.split(':').map(Number);
    const date = new Date();
    // Use a fixed date to avoid issues with DST or month-end changes
    date.setHours(hours, mins - minutes, 0, 0);
    const newHours = String(date.getHours()).padStart(2, '0');
    const newMins = String(date.getMinutes()).padStart(2, '0');
    return `${newHours}:${newMins}`;
}

async function buildDailyQueue() {
    console.log('🛠️ Building daily notification queue...');
    const newQueue = [];
    
    const now = new Date();
    const algeriaTime = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Algiers',
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const currentDate = `${algeriaTime.find(p => p.type === 'year').value}-${algeriaTime.find(p => p.type === 'month').value}-${algeriaTime.find(p => p.type === 'day').value}`;

    const prayerTimes = await loadPrayerTimesCache();
    const todaysPrayers = prayerTimes.find(p => p.date === currentDate);

    if (!todaysPrayers) {
        console.error(`🔥 Cannot build queue: No prayer times found for ${currentDate}`);
        notificationQueue = [];
        return;
    }

    const subscribers = await loadSubscribersCache();

    for (const subscriber of subscribers) {
        const { chatId, settings } = subscriber;
        const reminderMinutes = (settings && settings.globalReminderMinutes) ? settings.globalReminderMinutes : DEFAULT_SETTINGS.globalReminderMinutes;

        for (const prayerKey of prayerOrder) {
            const prayerTime = todaysPrayers[prayerKey];
            const prayerName = PRAYER_NAMES[prayerKey];

            // 1. Adhan (at-prayer) notification
            newQueue.push({
                chatId,
                sendAt: prayerTime,
                message: `🕌 حان الآن موعد أذان ${prayerName} حسب توقيت مدينة عين صالح وضواحيها (${prayerTime})`,
                dedupKey: `${currentDate}:${prayerKey}:${chatId}:0`
            });

            // 2. Pre-prayer reminder
            if (reminderMinutes > 0) {
                const reminderTime = subtractMinutes(prayerTime, reminderMinutes);
                newQueue.push({
                    chatId,
                    sendAt: reminderTime,
                    message: `⏰ تذكير: أذان ${prayerName} بعد ${reminderMinutes} دقيقة (${prayerTime})`,
                    dedupKey: `${currentDate}:${prayerKey}:${chatId}:${reminderMinutes}`
                });
            }
        }
    }

    notificationQueue = newQueue;
    console.log(`✅ Daily notification queue built. ${notificationQueue.length} notifications scheduled.`);
}

async function rescheduleUserNotifications(chatId) {
    console.log(`🔄 Rescheduling reminders for user ${chatId}.`);
    
    const subscribers = await loadSubscribersCache();
    const user = subscribers.find(s => s.chatId === chatId);
    if (!user) {
        console.warn(`Cannot reschedule for ${chatId}, user not found.`);
        return;
    }
    const newReminderMinutes = user.settings.globalReminderMinutes;

    const now = new Date();
    const algeriaTimeParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Algiers',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(now);
    
    const currentDate = `${algeriaTimeParts.find(p => p.type === 'year').value}-${algeriaTimeParts.find(p => p.type === 'month').value}-${algeriaTimeParts.find(p => p.type === 'day').value}`;
    const currentTime = `${algeriaTimeParts.find(p => p.type === 'hour').value}:${algeriaTimeParts.find(p => p.type === 'minute').value}`;

    // 1. Remove existing upcoming reminders for this user
    notificationQueue = notificationQueue.filter(item => {
        const isUserItem = item.chatId === chatId;
        const isReminder = !item.dedupKey.endsWith(':0');
        const isUpcoming = item.sendAt > currentTime;
        return !(isUserItem && isReminder && isUpcoming);
    });

    // 2. Add new reminders for the rest of the day
    const prayerTimes = await loadPrayerTimesCache();
    const todaysPrayers = prayerTimes.find(p => p.date === currentDate);

    if (!todaysPrayers) {
        console.error(`🔥 Cannot reschedule for ${chatId}: No prayer times found for ${currentDate}`);
        return;
    }

    for (const prayerKey of prayerOrder) {
        const prayerTime = todaysPrayers[prayerKey];
        if (prayerTime > currentTime) {
            const prayerName = PRAYER_NAMES[prayerKey];
            if (newReminderMinutes > 0) {
                const reminderTime = subtractMinutes(prayerTime, newReminderMinutes);
                if (reminderTime > currentTime) {
                    notificationQueue.push({
                        chatId,
                        sendAt: reminderTime,
                        message: `⏰ تذكير: أذان ${prayerName} بعد ${newReminderMinutes} دقيقة (${prayerTime})`,
                        dedupKey: `${currentDate}:${prayerKey}:${chatId}:${newReminderMinutes}`
                    });
                }
            }
        }
    }
    console.log(`✅ Rescheduling complete for ${chatId}. Queue size: ${notificationQueue.length}`);
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
    let subscribers = await loadSubscribersCache();
    const isSubscribed = subscribers.some(s => s.chatId === chatId);

    const welcomeOptions = {
      reply_markup: {
        keyboard: [
          [{ text: '🗓️ مواقيت اليوم' }, { text: '⚙️ إعداد التذكير' }]
        ],
        resize_keyboard: true
      }
    };

    if (!isSubscribed) {
      const newSubscriber = {
        chatId: chatId,
        settings: { ...DEFAULT_SETTINGS }
      };
      subscribers.push(newSubscriber);
      await saveSubscribers(subscribers);
      
      bot.sendMessage(chatId, '🕌 أهلاً بك! تم اشتراكك في خدمة إشعارات الأذان.\n\n✅ ستصلك رسالة عند كل وقت صلاة حسب توقيت مدينة عين صالح وضواحيها .\n\n⚙️ يمكنك الآن تخصيص التذكيرات أو عرض مواقيت الصلاة باستخدام الأزرار أدناه.', welcomeOptions);
      
      console.log(`👤 New subscriber added: ${chatId} (@${username})`);
      console.log(`👥 Total subscribers: ${subscribers.length}`);
    } else {
      bot.sendMessage(chatId, '✅ أنت مشترك بالفعل في خدمة الإشعارات.\n\n🔔 ستصلك التنبيهات عند كل وقت صلاة.', welcomeOptions);
      console.log(`🔄 Existing subscriber: ${chatId} (@${username})`);
    }
  } catch (error) {
    console.error(`❌ Error handling /start command for ${chatId}:`, error);
    bot.sendMessage(chatId, '❌ حدث خطأ ما أثناء محاولة تسجيل اشتراكك. يرجى المحاولة مرة أخرى.');
  }
});

bot.onText(/\/stop/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const removed = await removeSubscriber(chatId);
        if (removed) {
            bot.sendMessage(chatId, '✅ تم إلغاء اشتراكك. لن تتلقى أي إشعارات بعد الآن.', {
                reply_markup: {
                    remove_keyboard: true
                }
            });
        } else {
            bot.sendMessage(chatId, '🤔 أنت لست مشتركًا بالفعل.');
        }
    } catch (error) {
        console.error(`❌ Error handling /stop command for ${chatId}:`, error);
        bot.sendMessage(chatId, '❌ حدث خطأ ما أثناء محاولة إلغاء اشتراكك.');
    }
});

console.log('Telegram bot is running and listening for commands...');


// --- Today's Prayer Times ---
async function getTodayPrayersString() {
    const now = new Date();
    const algeriaTime = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Algiers',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now);
    const currentDate = `${algeriaTime.find(p => p.type === 'year').value}-${algeriaTime.find(p => p.type === 'month').value}-${algeriaTime.find(p => p.type === 'day').value}`;

    const prayerTimes = await loadPrayerTimesCache();
    if (prayerTimes.length === 0) {
        return '⚠️ لا توجد مواقيت صلاة متاحة حاليًا.';
    }

    const todaysPrayers = prayerTimes.find(p => p.date === currentDate);
    if (!todaysPrayers) {
        return `⚠️ لم يتم العثور على مواقيت الصلاة لتاريخ اليوم (${currentDate}).`;
    }

    const currentTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Algiers', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    let nextPrayer = null;
    const prayerOrder = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
    for (const prayerKey of prayerOrder) {
        if (todaysPrayers[prayerKey] > currentTime) {
            nextPrayer = prayerKey;
            break;
        }
    }

    let message = `🗓️ **مواقيت الصلاة لليوم** (عين صالح)\n*${currentDate}*\n\n`;
    prayerOrder.forEach(prayerKey => {
        const prayerName = PRAYER_NAMES[prayerKey];
        const prayerTime = todaysPrayers[prayerKey];
        if (prayerKey === nextPrayer) {
            message += `**${prayerName}: ${prayerTime}** ⬅️ (الصلاة القادمة)\n`;
        } else {
            message += `${prayerName}: ${prayerTime}\n`;
        }
    });
    return message;
}

bot.onText(/🗓️ مواقيت اليوم|\/today/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const message = await getTodayPrayersString();
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(`❌ Error handling /today command for ${chatId}:`, error);
        bot.sendMessage(chatId, '❌ حدث خطأ أثناء جلب مواقيت الصلاة.');
    }
});


// --- Reminder Settings ---
const expectingReminderValue = new Set();

function getReminderMessageAndKeyboard(reminderMinutes) {
    const message = `⏰ **إعدادات التذكير قبل الأذان**\n\nالتذكير الحالي: **${reminderMinutes}** دقيقة قبل كل صلاة.\n\nيمكنك تعديل القيمة باستخدام الأزرار أو إرسال رقم مباشرة (بين 1 و 60).`;
    const keyboard = [
        [{ text: '+10', callback_data: 'reminder_adjust_10' }, { text: '+5', callback_data: 'reminder_adjust_5' }, { text: '+1', callback_data: 'reminder_adjust_1' }],
        [{ text: '-10', callback_data: 'reminder_adjust_-10' }, { text: '-5', callback_data: 'reminder_adjust_-5' }, { text: '-1', callback_data: 'reminder_adjust_-1' }],
        [{ text: '✍️ إدخال قيمة يدوياً', callback_data: 'reminder_set_manual' }]
    ];
    return { message, keyboard };
}

bot.onText(/⚙️ إعداد التذكير|\/reminder/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const subscribers = await loadSubscribersCache();
        const user = subscribers.find(s => s.chatId === chatId);
        if (!user) {
            bot.sendMessage(chatId, '⚠️ أنت لست مشتركًا بعد. الرجاء إرسال /start للاشتراك أولاً.');
            return;
        }
        const reminderMinutes = user.settings.globalReminderMinutes || DEFAULT_SETTINGS.globalReminderMinutes;
        const { message, keyboard } = getReminderMessageAndKeyboard(reminderMinutes);
        bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    } catch (error) {
        console.error(`❌ Error handling /reminder command for ${chatId}:`, error);
        bot.sendMessage(chatId, '❌ حدث خطأ أثناء عرض إعدادات التذكير.');
    }
});

bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;

    if (data.startsWith('reminder_adjust_')) {
        const adjustment = parseInt(data.replace('reminder_adjust_', ''), 10);
        let subscribers = await loadSubscribersCache();
        const userIndex = subscribers.findIndex(s => s.chatId === chatId);
        if (userIndex === -1) {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'خطأ: لم يتم العثور على اشتراكك.' });
            return;
        }
        let currentMinutes = subscribers[userIndex].settings.globalReminderMinutes || DEFAULT_SETTINGS.globalReminderMinutes;
        let newMinutes = Math.max(1, Math.min(60, currentMinutes + adjustment));
        if (newMinutes !== currentMinutes) {
            subscribers[userIndex].settings.globalReminderMinutes = newMinutes;
      await saveSubscribers(subscribers);
      await rescheduleUserNotifications(chatId);
            const { message, keyboard } = getReminderMessageAndKeyboard(newMinutes);
            try {
                await bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: msg.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
                bot.answerCallbackQuery(callbackQuery.id, { text: `✅ تم التحديث إلى ${newMinutes} دقيقة` });
            } catch (e) {
                if (!e.message.includes('message is not modified')) console.error("Error editing message:", e);
                bot.answerCallbackQuery(callbackQuery.id);
            }
        } else {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'ℹ️ وصلت إلى الحد الأقصى/الأدنى (1-60 دقيقة).' });
        }
    } else if (data === 'reminder_set_manual') {
        expectingReminderValue.add(chatId);
        bot.sendMessage(chatId, '✍️ يرجى إرسال عدد الدقائق (رقم بين 1 و 60) للتذكير قبل الأذان.');
        bot.answerCallbackQuery(callbackQuery.id);
    }
});

// This handler must be after all bot.onText handlers
bot.on('message', async (msg) => {
    // Ignore messages that don't have text
    if (!msg.text) {
        return;
    }
    
    const chatId = msg.chat.id;
    
    // Ignore messages that are commands
    if (msg.text.startsWith('/')) {
        expectingReminderValue.delete(chatId);
        return;
    }

    if (expectingReminderValue.has(chatId)) {
        expectingReminderValue.delete(chatId);
        const newMinutes = parseInt(msg.text, 10);

        if (isNaN(newMinutes) || newMinutes < 1 || newMinutes > 60) {
            bot.sendMessage(chatId, '⚠️ قيمة غير صالحة. الرجاء إدخال رقم بين 1 و 60.');
            return;
        }

        let subscribers = await loadSubscribersCache();
        const userIndex = subscribers.findIndex(s => s.chatId === chatId);
        if (userIndex === -1) {
            bot.sendMessage(chatId, 'خطأ: لم يتم العثور على اشتراكك.');
            return;
        }
        subscribers[userIndex].settings.globalReminderMinutes = newMinutes;
    await saveSubscribers(subscribers);
    await rescheduleUserNotifications(chatId);
        bot.sendMessage(chatId, `✅ تم ضبط التذكير على **${newMinutes}** دقيقة.`, { parse_mode: 'Markdown' });
        
        // Show the main reminder menu again for clarity
        const { message, keyboard } = getReminderMessageAndKeyboard(newMinutes);
        bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    }
});






// --- NOTIFICATION PROCESSOR (CRON JOB) ---
// Schedule the queue builder to run daily at 00:05 Algeria time
cron.schedule('5 0 * * *', buildDailyQueue, {
    timezone: "Africa/Algiers"
});

// Build the queue on startup
setTimeout(buildDailyQueue, 2000); // Delay slightly to ensure other modules are ready

// تشغيل كل 30 ثانية للحصول على دقة أفضل
cron.schedule('*/30 * * * * *', async () => {
  try {
    const now = new Date();
    const currentTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Algiers',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(now);

    const dueNotifications = notificationQueue.filter(item => item.sendAt === currentTime);

    if (dueNotifications.length > 0) {
        console.log(`📬 Found ${dueNotifications.length} due notifications at ${currentTime}.`);
    }

    for (const item of dueNotifications) {
        if (sentNotifications.has(item.dedupKey)) {
            console.log(`⏭️ Skipping already sent notification: ${item.dedupKey}`);
            continue;
        }

        try {
            await bot.sendMessage(item.chatId, item.message);
            console.log(`✅ Sent: "${item.message}" to ${item.chatId}`);
            sentNotifications.set(item.dedupKey, Date.now());
        } catch (error) {
            console.error(`❌ Failed to send to ${item.chatId}:`, error.message);
            if (error.response && (error.response.statusCode === 403 || error.response.statusCode === 400)) {
                console.log(`🚫 User ${item.chatId} blocked the bot. Removing from subscribers.`);
                await removeSubscriber(item.chatId);
                notificationQueue = notificationQueue.filter(q => q.chatId !== item.chatId);
            }
        }
    }

    // Clean up sent items from the queue
    if (dueNotifications.length > 0) {
        notificationQueue = notificationQueue.filter(item => item.sendAt !== currentTime);
    }

    // Cleanup old sent notification keys (runs every 10 mins)
    if (now.getMinutes() % 10 === 0 && now.getSeconds() < 30) {
        cleanupOldNotifications();
    }
    
  } catch (error) {
    console.error('❌ Error in notification processing tick:', error);
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