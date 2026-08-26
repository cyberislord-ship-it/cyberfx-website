export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // =========================
    // TELEGRAM WEBHOOK
    // =========================
    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      const update = await request.json();
      if (update.message) {
        const chat = update.message.chat;
        const text = update.message.text || "";
        if (text === "/start" || text.startsWith("/start ")) {
          await env.CYBERFX_USERS.put(
            String(chat.id),
            JSON.stringify({
              chat_id: chat.id,
              username: chat.username || "",
              first_name: chat.first_name || "",
              registered_at: new Date().toISOString()
            })
          );
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN,
            chat.id,
            "✅ Welcome to CyberFX!\n\nYour Telegram is now connected to CyberFX.\n\nYou will receive confirmed trading signals here when available."
          );
        }
      }
      return json({ success: true });
    }
    // =========================
    // TELEGRAM WEBHOOK SETUP
    // =========================
    if (url.pathname === "/telegram/setup") {
      if (!env.TELEGRAM_BOT_TOKEN) {
        return json({
          success: false,
          error: "TELEGRAM_BOT_TOKEN is missing"
        }, 500);
      }
      const webhookUrl =
        "https://cyberfx-website.cybertradingsignal.workers.dev/telegram/webhook";
      const result = await telegramRequest(
        env.TELEGRAM_BOT_TOKEN,
        "setWebhook",
        {
          url: webhookUrl
        }
      );
      return json({
        success: true,
        webhook_url: webhookUrl,
        telegram: result
      });
    }
    // =========================
    // TELEGRAM TEST
    // =========================
    if (url.pathname === "/telegram/test") {
      if (!env.TELEGRAM_BOT_TOKEN) {
        return json({
          success: false,
          error: "TELEGRAM_BOT_TOKEN is missing"
        }, 500);
      }
      const result = await telegramRequest(
        env.TELEGRAM_BOT_TOKEN,
        "getMe"
      );
      return json({
        success: true,
        telegram: result
      });
    }
    // =========================
    // CYBERFX API
    // =========================
    if (url.pathname === "/api/signals") {
      const apiKey = env.TWELVE_DATA_API_KEY;
      if (!apiKey) {
        return json({
          success: false,
          error: "TWELVE_DATA_API_KEY is missing"
        }, 500);
      }
      const instruments = {
        "XAU/USD": "XAU/USD",
        "BTC/USD": "BTC/USD",
        "NASDAQ": "NDX",
        "US OIL": "WTI"
      };
      const timeframes = [
        { name: "1day", interval: "1day" },
        { name: "4h", interval: "4h" },
        { name: "1h", interval: "1h" },
        { name: "30min", interval: "30min" },
        { name: "15min", interval: "15min" }
      ];
      const data = {};
      for (const [name, symbol] of Object.entries(instruments)) {
        data[name] = {};
        for (const tf of timeframes) {
          data[name][tf.name] = await getCandles(
            symbol,
            tf.interval,
            apiKey
          );
        }
      }
      return json({
        success: true,
        source: "Twelve Data",
        engine: "CyberFX",
        timeframes: timeframes.map(tf => tf.name),
        data
      });
    }
    // =========================
    // HEALTH CHECK
    // =========================
    if (url.pathname === "/api/health") {
      return json({
        success: true,
        engine: "CyberFX",
        status: "online",
        api_key_connected: !!env.TWELVE_DATA_API_KEY,
        telegram_connected: !!env.TELEGRAM_BOT_TOKEN,
        user_storage_connected: !!env.CYBERFX_USERS
      });
    }
    // =========================
    // WEBSITE
    // =========================
    return env.ASSETS.fetch(request);
  }
};
// ========================================
// TWELVE DATA
// ========================================
async function getCandles(symbol, interval, apiKey) {
  const apiUrl = new URL(
    "https://api.twelvedata.com/time_series"
  );
  apiUrl.searchParams.set("symbol", symbol);
  apiUrl.searchParams.set("interval", interval);
  apiUrl.searchParams.set("outputsize", "100");
  apiUrl.searchParams.set("apikey", apiKey);
  try {
    const response = await fetch(apiUrl);
    const result = await response.json();
    if (!response.ok || result.status === "error") {
      return {
        status: "error",
        code: result.code || response.status,
        message: result.message || "Twelve Data request failed"
      };
    }
    return {
      status: "success",
      symbol: result.meta?.symbol || symbol,
      interval,
      candles: result.values || []
    };
  } catch (error) {
    return {
      status: "error",
      message: error.message
    };
  }
}
// ========================================
// TELEGRAM REQUEST
// ========================================
async function telegramRequest(token, method, body = null) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    body
      ? {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(body)
        }
      : {}
  );
  return await response.json();
}
// ========================================
// SEND TELEGRAM MESSAGE
// ========================================
async function sendTelegramMessage(token, chatId, text) {
  return await telegramRequest(
    token,
    "sendMessage",
    {
      chat_id: chatId,
      text
    }
  );
}
// ========================================
// JSON RESPONSE
// ========================================
function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store"
      }
    }
  );
}
