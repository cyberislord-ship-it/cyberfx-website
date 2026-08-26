export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
        api_key_connected: !!env.TWELVE_DATA_API_KEY
      });
    }

    // =========================
    // WEBSITE
    // =========================

    return env.ASSETS.fetch(request);
  }
};


// ========================================
// GET CANDLE DATA FROM TWELVE DATA
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
