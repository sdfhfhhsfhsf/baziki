const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');

const app = express();
app.use(express.json());

const BOT_TOKEN = "8507497335:AAGAAyTag5KuSFFGJpUijuOTgDzU6UeCHOg";
const TELEGRAM_API = "https://api.telegram.org/bot" + BOT_TOKEN;
const OWNER_ID = "8854073031";
const BOT_NAME = "ربات بازی سانت";
const BOT_USERNAME = "@" + (process.env.BOT_USERNAME || "GameBot");

const PORT = process.env.PORT || 3000;

// دیتابیس محلی برای ذخیره‌سازی روی Volume ریلوی
const DB_FILE = './database.json';
let dbData = { 
  users: {},         // اطلاعات کاربران (سانت، آخرین زمان دریافت)
  games: {},         // بازی‌های فعال گروه
  gift_codes: {},    // کدهای هدیه فعال
  pv_state: {}       // وضعیت انتظار ورودی در پیوی برای ساخت کد هدیه
};

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!dbData.users) dbData.users = {};
      if (!dbData.games) dbData.games = {};
      if (!dbData.gift_codes) dbData.gift_codes = {};
      if (!dbData.pv_state) dbData.pv_state = {};
    }
  } catch (e) {
    console.error("Load DB Error:", e);
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
  } catch (e) {
    console.error("Save DB Error:", e);
  }
}

loadDB();

app.get("/setWebhook", async (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const webhookUrl = `${protocol}://${host}/`;
  const response = await fetch(TELEGRAM_API + "/setWebhook?url=" + encodeURIComponent(webhookUrl));
  res.json(await response.json());
});

app.post("/", async (req, res) => {
  try {
    const update = req.body;
    handleUpdate(update).catch(err => console.error("Update Error:", err));
  } catch (e) {
    console.error("Body JSON Error:", e);
  }
  res.status(200).send("OK");
});

app.get("/", (req, res) => {
  res.send("Bot is active on Railway!");
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

async function tgCall(method, payload) {
  try {
    const res = await fetch(TELEGRAM_API + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (e) {
    return { ok: false };
  }
}

async function sendMessage(chat_id, text, reply_to_message_id = null, reply_markup = null) {
  const payload = { chat_id, text, parse_mode: "Markdown", disable_web_page_preview: true };
  if (reply_to_message_id) payload.reply_to_message_id = reply_to_message_id;
  if (reply_markup) payload.reply_markup = reply_markup;
  return await tgCall("sendMessage", payload);
}

async function answerCallbackQuery(id, text = "", alert = false) {
  return await tgCall("answerCallbackQuery", { callback_query_id: id, text, show_alert: alert });
}

async function editMessageText(chat_id, message_id, text, reply_markup = null) {
  const payload = { chat_id, message_id, text, parse_mode: "Markdown", disable_web_page_preview: true };
  if (reply_markup) payload.reply_markup = reply_markup;
  return await tgCall("editMessageText", payload);
}

// تابع کمکی برای گرفتن یا ساخت کاربر در دیتابیس
function getUser(userId) {
  const uId = String(userId);
  if (!dbData.users[uId]) {
    dbData.users[uId] = { balance: 0, last_kiro: 0 };
  }
  return dbData.users[uId];
}

async function handleUpdate(update) {
  try {
    // مدیریت کلیک روی دکمه‌های شیشه‌ای (لغو یا ورود به بازی)
    if (update.callback_query) {
      const cb = update.callback_query;
      const userId = String(cb.from.id);
      const data = cb.data;
      const chatId = cb.message.chat.id;
      const msgId = cb.message.message_id;

      if (data.startsWith("cancel_game_")) {
        const gameId = data.replace("cancel_game_", "");
        const game = dbData.games[gameId];
        if (!game) {
          return await answerCallbackQuery(cb.id, "این بازی منقضی یا پاک شده است.", true);
        }
        if (String(game.creator_id) !== userId) {
          return await answerCallbackQuery(cb.id, "فقط سازنده بازی می‌تواند آن را لغو کند!", true);
        }

        // برگرداندن سانت به سازنده
        const creator = getUser(game.creator_id);
        creator.balance += game.amount;
        saveDB();

        delete dbData.games[gameId];
        saveDB();

        await editMessageText(chatId, msgId, `❌ بازی با مبلغ **${game.amount} سانت** توسط سازنده لغو شد و موجودی به او برگشت داده شد.`);
        return await answerCallbackQuery(cb.id, "بازی لغو شد.");
      }

      if (data.startsWith("join_game_")) {
        const gameId = data.replace("join_game_", "");
        const game = dbData.games[gameId];
        if (!game) {
          return await answerCallbackQuery(cb.id, "این بازی دیگر وجود ندارد!", true);
        }
        if (String(game.creator_id) === userId) {
          return await answerCallbackQuery(cb.id, "سازنده بازی نمی‌تواند روی بازی خودش ورود بزند!", true);
        }

        // چک کردن موجودی شرکت‌کننده
        const joiner = getUser(userId);
        if (joiner.balance < game.amount) {
          return await answerCallbackQuery(cb.id, `موجودی شما ناکافی است! شما به ${game.amount} سانت نیاز دارید.`, true);
        }

        // کسر موجودی از شرکت‌کننده
        joiner.balance -= game.amount;

        // محاسبه جایزه برنده (دو برابر مبلغ بازی)
        const prize = game.amount * 2;
        const winnerUser = getUser(userId);
        winnerUser.balance += prize;

        delete dbData.games[gameId];
        saveDB();

        const winnerName = cb.from.first_name || "کاربر";
        const successText = `🏆 **بازی به اتمام رسید!**\n\n` +
          `👤 برنده: [${winnerName}](tg://user?id=${userId})\n` +
          `🎁 جایزه دریافتی: **${prize} سانت**`;

        await editMessageText(chatId, msgId, successText);
        return await answerCallbackQuery(cb.id, `تبریک! شما برنده ${prize} سانت شدید.`, true);
      }

      return;
    }

    if (!update.message) return;
    const msg = update.message;
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const text = msg.text ? msg.text.trim() : "";
    const isPrivate = msg.chat.type === "private";

    // ---------------- پیوی ربات ----------------
    if (isPrivate) {
      // ثبت نام کاربر در صورت نیاز
      getUser(userId);

      // بررسی وضعیت انتظار در پیوی (مخصوص مالک برای ساخت کد هدیه)
      if (userId === OWNER_ID && dbData.pv_state[userId]) {
        const state = dbData.pv_state[userId];

        if (state.step === "code") {
          state.codeName = text;
          state.step = "capacity";
          saveDB();
          return await sendMessage(chatId, "✅ کد هدیه ثبت شد.\n\nتعداد ظرفیت این کد هدیه را بفرستید (مثلا 3):");
        } else if (state.step === "capacity") {
          const cap = parseInt(text);
          if (isNaN(cap) || cap <= 0) {
            return await sendMessage(chatId, "⚠️ لطفاً یک عدد معتبر برای ظرفیت وارد کنید:");
          }
          state.capacity = cap;
          state.step = "amount";
          saveDB();
          return await sendMessage(chatId, "✅ ظرفیت ثبت شد.\n\nتعداد سانتی که به هر نفر می‌دهد را بفرستید (مثلا 50):");
        } else if (state.step === "amount") {
          const amt = parseInt(text);
          if (isNaN(amt) || amt <= 0) {
            return await sendMessage(chatId, "⚠️ لطفاً یک عدد معتبر برای مقدار سانت وارد کنید:");
          }

          // ذخیره نهایی کد هدیه
          dbData.gift_codes[state.codeName] = {
            capacity: state.capacity,
            used_count: 0,
            amount: amt,
            used_users: []
          };
          delete dbData.pv_state[userId];
          saveDB();

          return await sendMessage(chatId, `🎉 **کد هدیه با موفقیت ساخته شد!**\n\n` +
            `▫️ کد: \`${state.codeName}\`\n` +
            `▫️ ظرفیت: ${state.capacity} نفر\n` +
            `▫️ جایزه: ${amt} سانت\n\n` +
            `کاربران می‌توانند با دکمه یا دستور مربوطه آن را دریافت کنند.`);
        }
      }

      if (text === "/start") {
        const startText = `سلام! به ربات خوش آمدید. 🎮\n\n` +
          `برای افزودن ربات به گروه خود از دکمه زیر استفاده کنید:`;
        
        const inlineKb = {
          inline_keyboard: [
            [{ text: "➕ افزودن ربات به گروه خود", url: `https://t.me/${BOT_USERNAME.replace("@", "")}?startgroup=true` }],
            [{ text: "🎁 وارد کردن کد هدیه", callback_data: "enter_gift_prompt" }]
          ]
        };

        if (userId === OWNER_ID) {
          inlineKb.inline_keyboard.push([{ text: "⚙️ پنل مدیریت (مالک)", callback_data: "owner_panel" }]);
        }

        return await sendMessage(chatId, startText, msg.message_id, inlineKb);
      }

      // دستور پنل مالک در پیوی
      if (text === "/panel" && userId === OWNER_ID) {
        const panelKb = {
          inline_keyboard: [
            [{ text: "🎁 ساخت کد هدیه", callback_data: "create_gift_code" }],
            [{ text: "📊 آمار ربات", callback_data: "bot_stats" }]
          ]
        };
        return await sendMessage(chatId, "⚙️ **پنل مدیریت ربات:**\n\nیک گزینه را انتخاب کنید:", null, panelKb);
      }

      // مدیریت دکمه‌های پیوی مالک یا کاربران
      if (update.callback_query && update.callback_query.message.chat.type === "private") {
        // این بخش اگر callback_query در پیوی بیاید
        // در اینجا هندل می‌شود
      }

      // دکمه‌های شیشه‌ای پیوی
      if (update.callback_query) {
        const cb = update.callback_query;
        const cbData = cb.data;
        const cbUserId = String(cb.from.id);
        const cbChatId = cb.message.chat.id;
        const cbMsgId = cb.message.message_id;

        if (cbData === "owner_panel" && cbUserId === OWNER_ID) {
          const panelKb = {
            inline_keyboard: [
              [{ text: "🎁 ساخت کد هدیه", callback_data: "create_gift_code" }],
              [{ text: "📊 آمار ربات", callback_data: "bot_stats" }]
            ]
          };
          await editMessageText(cbChatId, cbMsgId, "⚙️ **پنل مدیریت ربات:**", panelKb);
          return await answerCallbackQuery(cb.id);
        }

        if (cbData === "create_gift_code" && cbUserId === OWNER_ID) {
          dbData.pv_state[cbUserId] = { step: "code" };
          saveDB();
          await editMessageText(cbChatId, cbMsgId, "🎁 **ساخت کد هدیه**\n\nلطفاً نام یا متن کد هدیه خود را بفرستید:");
          return await answerCallbackQuery(cb.id);
        }

        if (cbData === "bot_stats" && cbUserId === OWNER_ID) {
          const uCount = Object.keys(dbData.users).length;
          const gCount = Object.keys(dbData.gift_codes).length;
          await answerCallbackQuery(cb.id, `تعداد کاربران: ${uCount}\nکدهای هدیه فعال: ${gCount}`, true);
          return;
        }

        if (cbData === "enter_gift_prompt") {
          dbData.pv_state[cbUserId] = { step: "wait_gift_code" };
          saveDB();
          await editMessageText(cbChatId, cbMsgId, "🎁 **وارد کردن کد هدیه**\n\nلطفاً کد هدیه خود را ارسال کنید:");
          return await answerCallbackQuery(cb.id);
        }
      }

      // اگر کاربر در حال وارد کردن کد هدیه در پیوی بود
      if (dbData.pv_state[userId] && dbData.pv_state[userId].step === "wait_gift_code") {
        delete dbData.pv_state[userId];
        const codeInput = text;
        const gift = dbData.gift_codes[codeInput];

        if (!gift) {
          saveDB();
          return await sendMessage(chatId, "❌ این کد هدیه وجود ندارد یا اشتباه است.");
        }

        if (gift.used_users.includes(userId)) {
          saveDB();
          return await sendMessage(chatId, "⚠️ شما قبلاً از این کد هدیه استفاده کرده‌اید!");
        }

        if (gift.used_count >= gift.capacity) {
          saveDB();
          return await sendMessage(chatId, "❌ کد هدیه تمام شده است!");
        }

        // اعمال جایزه به کاربر
        gift.used_count += 1;
        gift.used_users.push(userId);
        const u = getUser(userId);
        u.balance += gift.amount;
        saveDB();

        return await sendMessage(chatId, `🎁 **تبریک! کد هدیه با موفقیت اعمال شد.**\n\n` +
          `✨ مقدار جایزه: **${gift.amount} سانت**\n` +
          `💰 موجودی جدید شما: **${u.balance} سانت**`);
      }

      return;
    }

    // ---------------- گروه های ربات ----------------
    if (!isPrivate) {
      const u = getUser(userId);

      // 1. دستور راهنما
      if (text === "راهنما") {
        const helpText = `📚 **راهنمای دستورات ربات بازی سانت:**\n\n` +
          `▫️ \`کیر\` : دریافت سانت شانسی (هر ۵ ساعت یک‌بار، احتمال گرفتن سانت کمتر بسیار بیشتر است)\n` +
          `▫️ \`سانت\` : مشاهده موجودی سانت خود\n` +
          `▫️ \`بازی [مبلغ]\` : ساخت بازی جدید با تعداد سانت دلخواه (مثلاً: \`بازی 20\`)\n` +
          `▫️ \`راهنما\` : نمایش همین لیست دستورات`;
        return await sendMessage(chatId, helpText, msg.message_id);
      }

      // 2. دستور سانت (مشاهده موجودی)
      if (text === "سانت") {
        return await sendMessage(chatId, `💰 کاربر [${msg.from.first_name}](tg://user?id=${userId})، موجودی شما: **${u.balance} سانت** است.`, msg.message_id);
      }

      // 3. دستور کیر (دریافت سانت هر ۵ ساعت یک‌بار)
      if (text === "کیر") {
        const now = Date.now();
        const cooldown = 5 * 60 * 60 * 1000; // ۵ ساعت به میلی‌ثانیه

        if (u.last_kiro && (now - u.last_kiro < cooldown)) {
          const remaining = cooldown - (now - u.last_kiro);
          const hours = Math.floor(remaining / (60 * 60 * 1000));
          const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
          return await sendMessage(chatId, `⏳ شما اخیراً از این دستور استفاده کرده‌اید!\nبرای استفاده مجدد باید **${hours} ساعت و ${minutes} دقیقه** صبر کنید.`, msg.message_id);
        }

        // شانس سانت از 1 تا 70 با احتمال بیشتر برای اعداد کمتر (1 تا 30)
        let randVal;
        const chance = Math.random();
        if (chance < 0.75) {
          // ۷۵ درصد احتمال برای اعداد بین 1 تا 30
          randVal = Math.floor(Math.random() * 30) + 1;
        } else {
          // ۲۵ درصد احتمال برای اعداد بین 31 تا 70
          randVal = Math.floor(Math.random() * 40) + 31;
        }

        u.balance += randVal;
        u.last_kiro = now;
        saveDB();

        return await sendMessage(chatId, `🎉 کاربر [${msg.from.first_name}](tg://user?id=${userId})، شانس شما چرخید و **${randVal} سانت** به دست آوردید!\n💰 موجودی کل: **${u.balance} سانت**`, msg.message_id);
      }

      // 4. دستور ساخت بازی (مثلاً: بازی 20)
      if (text.startsWith("بازی ")) {
        const amountStr = text.replace("بازی", "").trim();
        const betAmount = parseInt(amountStr);

        if (isNaN(betAmount) || betAmount <= 0) {
          return await sendMessage(chatId, "⚠️ لطفاً مقدار معتبری برای بازی وارد کنید (مثلا: `بازی 20`).", msg.message_id);
        }

        if (u.balance < betAmount) {
          return await sendMessage(chatId, "❌ موجودی ناکافی هست!", msg.message_id);
        }

        // کسر موجودی از سازنده
        u.balance -= betAmount;
        
        const gameId = "game_" + Date.now() + "_" + userId;
        dbData.games[gameId] = {
          creator_id: userId,
          creator_name: msg.from.first_name || "کاربر",
          amount: betAmount
        };
        saveDB();

        const prizePool = betAmount * 2;
        const gameMsgText = `🎮 **بازی جدید ساخته شد!**\n\n` +
          `👤 سازنده: [${msg.from.first_name}](tg://user?id=${userId})\n` +
          `💰 مبلغ بازی: **${betAmount} سانت**\n` +
          `🎁 جایزه برنده: **${prizePool} سانت**\n\n` +
          `برای ورود روی دکمه زیر بزنید:`;

        const gameKeyboard = {
          inline_keyboard: [
            [
              { text: "📥 ورود به بازی", callback_data: `join_game_${gameId}` },
              { text: "❌ لغو بازی", callback_data: `cancel_game_${gameId}` }
            ]
          ]
        };

        return await sendMessage(chatId, gameMsgText, msg.message_id, gameKeyboard);
      }
    }

  } catch (e) {
    console.error("HandleUpdate Error:", e);
  }
}
