export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================================================
    // HEALTH
    // =========================================================
    if (url.pathname === "/api/health") {
      const bybitConnected = await checkBybit();

      return json({
        success: true,
        engine: "CyberFX",
        version: "4.1.0-m15-close",
        status: "online",
        market_data: "Bybit Public API",
        bybit_connected: bybitConnected,
        telegram_connected: !!env.TELEGRAM_BOT_TOKEN,
        paystack_connected: !!env.PAYSTACK_SECRET_KEY,
        database_connected: !!env.DB,
        strategy: "Unified signal engine",
        instruments: ["XAUUSD"],
        scan_interval_minutes: 15,
        trading_sessions: ["Asian", "London", "New York"],
        session_timezone: "America/New_York",
        risk_reward: "1:8",
        trial_days: 21
      });
    }

    // =========================================================
    // ECONOMIC NEWS DASHBOARD
    // =========================================================
    if (url.pathname === "/api/news/today" && request.method === "GET") {
      try {
        const events = await fetchCyberFXEconomicCalendar();
        const todayWAT = getDateInTimeZone(new Date(), "Africa/Lagos");
        const today = events.filter(event => {
          const at = getEconomicEventTime(event);
          return at && getDateInTimeZone(at, "Africa/Lagos") === todayWAT;
        });
        return json({
          success: true,
          source: "Finance Calendar",
          source_url: "https://www.financecalendar.com",
          timezone: "Africa/Lagos",
          date: todayWAT,
          events: today.map(formatEconomicEventForApi)
        });
      } catch (error) {
        return json({ success: false, error: "Economic calendar temporarily unavailable. Please retry shortly." }, 502);
      }
    }

    // =========================================================
    // START 21-DAY TRIAL
    // =========================================================
    if (
      url.pathname === "/api/trial/start" &&
      request.method === "POST"
    ) {
      try {
        const body = await request.json();

        const email = String(body.email || "")
          .trim()
          .toLowerCase();

        if (!email || !email.includes("@")) {
          return json({
            success: false,
            error: "A valid email address is required"
          }, 400);
        }

        const result = await startTrial(email, env);

        return json(result);
      } catch (error) {
        console.error("Trial error:", error);

        return json({
          success: false,
          error: error?.message || String(error)
        }, 500);
      }
    }

    // =========================================================
    // SUBSCRIPTION CHECK
    // =========================================================
    if (
      url.pathname === "/api/subscription" &&
      request.method === "GET"
    ) {
      try {
        const email = String(
          url.searchParams.get("email") || ""
        )
          .trim()
          .toLowerCase();

        if (!email) {
          return json({
            success: false,
            error: "Email is required"
          }, 400);
        }

        // Automatically create the trial if the user
        // exists but has never received one.
        await ensureTrialForUser(email, env);

        const subscription =
          await getActiveSubscriptionByEmail(email, env);

        if (!subscription) {
          return json({
            success: true,
            subscribed: false,
            active: false,
            trial: false
          });
        }

        return json({
          success: true,
          subscribed: true,
          active: true,
          trial: subscription.plan === "trial",
          plan: subscription.plan,
          plan_name: subscription.plan_name,
          email: subscription.email,
          starts_at: subscription.starts_at,
          expires_at: subscription.expires_at
        });

      } catch (error) {
        console.error("Subscription check error:", error);

        return json({
          success: false,
          error: error?.message || String(error)
        }, 500);
      }
    }

    // =========================================================
    // PAYSTACK INITIALIZE
    // =========================================================
    if (
      url.pathname === "/api/payment/initialize" &&
      request.method === "POST"
    ) {
      try {
        if (!env.PAYSTACK_SECRET_KEY) {
          return json({
            success: false,
            error: "PAYSTACK_SECRET_KEY is missing"
          }, 500);
        }

        if (!env.DB) {
          return json({
            success: false,
            error: "D1 database binding DB is missing"
          }, 500);
        }

        const body = await request.json();

        const email = String(body.email || "")
          .trim()
          .toLowerCase();

        const plan = String(body.plan || "")
          .trim()
          .toLowerCase();

        if (!email || !email.includes("@")) {
          return json({
            success: false,
            error: "A valid email address is required"
          }, 400);
        }

        if (!PLANS[plan]) {
          return json({
            success: false,
            error: "Invalid subscription plan"
          }, 400);
        }

        const selectedPlan = PLANS[plan];

        const reference =
          `CYBERFX-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

        const callbackUrl =
          `${url.origin}/api/payment/callback`;

        const response = await fetch(
          "https://api.paystack.co/transaction/initialize",
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${env.PAYSTACK_SECRET_KEY}`,
              "Content-Type":
                "application/json"
            },
            body: JSON.stringify({
              email,
              amount: selectedPlan.amount,
              currency: "NGN",
              reference,
              callback_url: callbackUrl,
              metadata: {
                cyberfx_plan: plan,
                duration_months: selectedPlan.months
              }
            })
          }
        );

        const result = await response.json();

        if (
          !response.ok ||
          !result.status ||
          !result.data
        ) {
          return json({
            success: false,
            error:
              result.message ||
              "Unable to initialize payment"
          }, 500);
        }

        await env.DB.prepare(`
          INSERT INTO payments (
            reference,
            amount,
            plan,
            status,
            email
          )
          VALUES (?, ?, ?, ?, ?)
        `)
          .bind(
            reference,
            selectedPlan.amount / 100,
            plan,
            "pending",
            email
          )
          .run();

        return json({
          success: true,
          engine: "CyberFX",
          authorization_url:
            result.data.authorization_url,
          access_code:
            result.data.access_code,
          reference,
          plan: selectedPlan.name,
          amount:
            selectedPlan.amount / 100
        });

      } catch (error) {
        console.error(
          "Payment initialization error:",
          error
        );

        return json({
          success: false,
          error: error?.message || String(error)
        }, 500);
      }
    }

    // =========================================================
    // PAYSTACK VERIFY
    // =========================================================
    if (
      url.pathname === "/api/payment/verify" &&
      request.method === "GET"
    ) {
      try {
        const reference =
          url.searchParams.get("reference");

        if (!reference) {
          return json({
            success: false,
            error: "Payment reference is required"
          }, 400);
        }

        return json(
          await verifyPaystackPayment(reference, env)
        );

      } catch (error) {
        console.error(
          "Payment verification error:",
          error
        );

        return json({
          success: false,
          error: error?.message || String(error)
        }, 500);
      }
    }

    // =========================================================
    // PAYSTACK CALLBACK
    // =========================================================
    if (
      url.pathname === "/api/payment/callback" &&
      request.method === "GET"
    ) {
      const reference =
        url.searchParams.get("reference");

      if (!reference) {
        return new Response(
          "Missing payment reference.",
          {
            status: 400,
            headers: {
              "content-type": "text/plain"
            }
          }
        );
      }

      try {
        const result =
          await verifyPaystackPayment(
            reference,
            env
          );

        if (
          result.success &&
          result.payment_status === "success"
        ) {
          return Response.redirect(
            `${url.origin}/?payment=success&reference=${encodeURIComponent(reference)}`,
            302
          );
        }

        return Response.redirect(
          `${url.origin}/?payment=failed&reference=${encodeURIComponent(reference)}`,
          302
        );

      } catch {
        return Response.redirect(
          `${url.origin}/?payment=failed`,
          302
        );
      }
    }

    // =========================================================
    // MARKET SYMBOLS
    // =========================================================
    if (
      url.pathname === "/api/symbols" &&
      request.method === "GET"
    ) {
      try {
        const symbols =
          await discoverSymbols();

        return json({
          success: true,
          engine: "CyberFX",
          source: "Bybit Public API",
          count: symbols.length,
          symbols
        });

      } catch (error) {
        return json({
          success: false,
          error: error?.message || String(error)
        }, 500);
      }
    }

    // =========================================================
    // MARKET DATA
    // =========================================================
    if (url.pathname === "/api/signals") {
      try {
        const symbols =
          await discoverSymbols();

        const data =
          await loadAllMarkets(symbols);

        return json({
          success: true,
          engine: "CyberFX",
          source: "Bybit Public API",
          strategy: "Unified signal engine",
          risk_reward: "1:8",
          markets: symbols,
          timeframes: TIMEFRAMES.map(
            x => x.name
          ),
          data
        });

      } catch (error) {
        console.error(
          "Market data error:",
          error
        );

        return json({
          success: false,
          error: error?.message || String(error)
        }, 500);
      }
    }

    // =========================================================
    // GENERATE SIGNALS
    // =========================================================
    if (
      url.pathname === "/api/generate-signals"
    ) {
      try {
        const result =
          await generateSignals();

        return json({
          success: true,
          engine: "CyberFX",
          source: "Bybit Public API",
          strategy: "Unified signal engine",
          instruments: ["XAUUSD"],
          risk_reward: "1:8",
          signal_levels: ["CONFIRMED"],
          signals: result
        });

      } catch (error) {
        console.error(
          "Signal engine error:",
          error
        );

        return json({
          success: false,
          error: error?.message || String(error)
        }, 500);
      }
    }

    // =========================================================
    // TELEGRAM WEBHOOK
    // =========================================================
    if (
      url.pathname === "/telegram/webhook" &&
      request.method === "POST"
    ) {
      try {
        const update =
          await request.json();

        if (update.message) {
          await handleTelegramMessage(
            update.message,
            env,
            url.origin
          );
        }
        if (update.callback_query) {
          await handleTelegramCallback(update.callback_query, env);
        }

        return json({
          ok: true
        });

      } catch (error) {
        console.error(
          "Telegram webhook error:",
          error
        );

        return json({
          ok: true
        });
      }
    }

    // =========================================================
    // WEBSITE
    // =========================================================
    return env.ASSETS.fetch(request);
  },

  // =========================================================
  // CRON
  // =========================================================
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runAutomaticScan(env)
    );
  }
};


// ============================================================
// OWNER
// ============================================================

const OWNER_TELEGRAM_ID = "8368477940";


// ============================================================
// WEBSITE
// ============================================================

const WEBSITE_URL =
  "https://cyberfx-website.cybertradingsignal.workers.dev/";


// ============================================================
// PAYMENTS
// ============================================================

const PLANS = {
  "1-month": {
    name: "1 Month",
    months: 1,
    amount: 1000000
  },

  "3-months": {
    name: "3 Months",
    months: 3,
    amount: 3000000
  },

  "6-months": {
    name: "6 Months",
    months: 6,
    amount: 6000000
  },

  "12-months": {
    name: "12 Months",
    months: 12,
    amount: 12000000
  }
};


// ============================================================
// TRIAL
// ============================================================

const TRIAL_DAYS = 21;


// ============================================================
// TIMEFRAMES
// ============================================================

const TIMEFRAMES = [
  { name: "1min", interval: "1m" },
  { name: "5min", interval: "5m" },
  { name: "15min", interval: "15m" },
  { name: "30min", interval: "30m" },
  { name: "1h", interval: "1h" },
  { name: "4h", interval: "4h" },
  { name: "1d", interval: "1d" }
];

// Signal decisions are evaluated only on a fully closed M15 candle.
// M30, H1 and H4 remain available as higher-timeframe market context.
const ENTRY_TIMEFRAMES = [
  "15min"
];

const CONFIRMED_SCORE = 13;


// ============================================================
// SIGNAL PRIORITY
// ============================================================

const SIGNAL_PRIORITY = {
  "REJECTION": 1,
  "VALID SETUP": 2,
  "CONFIRMED": 3
};


// ============================================================
// BYBIT PUBLIC API HEALTH
// ============================================================

async function checkBybit() {
  // Public market-data endpoints require no API key.
  // Health is true only when both configured instruments return candles.
  try {
    const gold = await getCandles("XAUUSD", "1m");
    return !!(gold && gold.status === "success" &&
      Array.isArray(gold.candles) && gold.candles.length > 0);
  } catch {
    return false;
  }
}

// ============================================================
// DYNAMIC SYMBOL DISCOVERY
// ============================================================

async function discoverSymbols() {
  // The current CyberFX signal engine trades Gold only.
  return [{
    symbol: "XAUUSD",
    name: "XAUUSD",
    category: "COMMODITY",
    description: "Gold versus US Dollar",
    source: "Bybit Public API",
    apiSymbol: "XAUUSDT",
    apiCategory: "linear"
  }];
}

// ============================================================
// BYBIT V5 PUBLIC CANDLE DATA
// ============================================================

const BYBIT_BASE_URL = "https://api.bybit.com";

const BYBIT_INTERVALS = {
  "1m": { api: "1", ms: 60_000 },
  "5m": { api: "5", ms: 5 * 60_000 },
  "15m": { api: "15", ms: 15 * 60_000 },
  "30m": { api: "30", ms: 30 * 60_000 },
  "1h": { api: "60", ms: 60 * 60_000 },
  "4h": { api: "240", ms: 4 * 60 * 60_000 },
  "1d": { api: "D", ms: 24 * 60 * 60_000 }
};

function bybitInstrumentFor(symbol) {
  if (symbol === "XAUUSD") {
    // XAUUSDT is the Bybit gold/USDT TradFi market if listed for this account/API region.
    // Do not silently substitute XAUTUSDT (a tokenized-gold product).
    return { symbol: "XAUUSDT", category: "linear" };
  }
  if (symbol === "BTCUSD") {
    return { symbol: "BTCUSD", category: "inverse" };
  }
  throw new Error(`Unsupported CyberFX instrument: ${symbol}`);
}

async function getCandles(symbol, interval) {
  const instrument = bybitInstrumentFor(symbol);
  const tf = BYBIT_INTERVALS[interval] || BYBIT_INTERVALS[
    TIMEFRAMES.find(item => item.name === interval)?.interval
  ];
  if (!tf) {
    return { status: "error", symbol, interval, message: `Unsupported Bybit interval: ${interval}` };
  }

  const apiUrl = new URL(`${BYBIT_BASE_URL}/v5/market/kline`);
  apiUrl.searchParams.set("category", instrument.category);
  apiUrl.searchParams.set("symbol", instrument.symbol);
  apiUrl.searchParams.set("interval", tf.api);
  apiUrl.searchParams.set("limit", "200");

  try {
    const response = await fetch(apiUrl.toString(), {
      headers: { "Accept": "application/json" }
    });
    let result;
    try {
      result = await response.json();
    } catch {
      result = {};
    }

    const rows = result?.result?.list;
    if (!response.ok || result?.retCode !== 0 || !Array.isArray(rows)) {
      return {
        status: "error",
        symbol,
        interval,
        api_symbol: instrument.symbol,
        api_category: instrument.category,
        message: result?.retMsg || result?.message || result?.error || `Bybit request failed (HTTP ${response.status})`
      };
    }

    const now = Date.now();
    const candles = rows.map(row => {
      const startMs = Number(row?.[0]);
      const isOpen = Number.isFinite(startMs) && (startMs + tf.ms > now);
      return {
        openTime: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
        timestamp: Number.isFinite(startMs) ? startMs : null,
        open: Number(row?.[1]),
        high: Number(row?.[2]),
        low: Number(row?.[3]),
        close: Number(row?.[4]),
        volume: Number(row?.[5] || 0),
        isOpen
      };
    }).filter(c =>
      c.openTime && Number.isFinite(c.open) && Number.isFinite(c.high) &&
      Number.isFinite(c.low) && Number.isFinite(c.close)
    );

    if (!candles.length) {
      return {
        status: "error", symbol, interval,
        api_symbol: instrument.symbol,
        api_category: instrument.category,
        message: `Bybit returned no valid candles for ${instrument.symbol}`
      };
    }

    return {
      status: "success",
      symbol,
      interval,
      api_symbol: instrument.symbol,
      api_category: instrument.category,
      source: "Bybit Public API",
      candles
    };
  } catch (error) {
    return {
      status: "error",
      symbol,
      interval,
      api_symbol: instrument.symbol,
      api_category: instrument.category,
      message: error?.message || String(error)
    };
  }
}

// ============================================================
// LOAD MARKET
// ============================================================

async function loadAllMarkets(symbols) {
  const data = {};

  // Keep requests controlled.
  // Bybit V5 public Kline endpoint supports these mapped intervals.
  for (
    const item of symbols
  ) {
    data[item.symbol] = {
      metadata: item
    };

    for (
      const tf of TIMEFRAMES
    ) {
      data[item.symbol][tf.name] =
        await getCandles(
          item.symbol,
          tf.interval
        );
    }
  }

  return data;
}


// ============================================================
// SIGNAL ENGINE
// ============================================================

async function generateSignals() {
  // Scan XAUUSD in every session. Each setup family is evaluated independently;
  // overlapping detections are merged into one alert for the same opportunity.
  const now = new Date();
  const symbols = await discoverSymbols();
  const marketData = await loadAllMarkets(symbols);
  const results = [];

  for (const item of symbols) {
    const market = marketData[item.symbol];
    if (!market) continue;
    const candidates = [];

    for (const entryTF of ENTRY_TIMEFRAMES) {
      // Existing confirmed structure/CRT engine and the independent flexible checks.
      const legacy = analyzeInstrument(item, market, entryTF);
      if (legacy && isTradeableSignal(legacy)) {
        const prepared = prepareSignalForExecution(legacy, market, entryTF, now);
        if (prepared) candidates.push(prepared);
      }

      const alchemist = analyzeAlchemistInstrument(item, market, entryTF, now);
      if (alchemist && isTradeableSignal(alchemist)) {
        const prepared = prepareSignalForExecution(alchemist, market, entryTF, now);
        if (prepared) candidates.push(prepared);
      }

      for (const signal of detectIndependentSetups(item, market, entryTF, now)) {
        if (!isTradeableSignal(signal)) continue;
        const prepared = prepareSignalForExecution(signal, market, entryTF, now);
        if (prepared) candidates.push(prepared);
      }
    }

    results.push(...mergeSameOpportunities(candidates));
  }

  return results.filter(signal => signal && signal.status === "CONFIRMED");
}

// Decide whether a confirmed setup is executable now or needs a pullback.
// BUY LIMIT must be strictly below CMP; SELL LIMIT must be strictly above CMP.
function prepareSignalForExecution(signal, market, entryTF, now = new Date()) {
  const candlesData = market?.[entryTF];
  const rawCandles = candlesData?.candles;
  if (!Array.isArray(rawCandles) || !rawCandles.length) return null;
  const candles = normalizeCandles(rawCandles);
  const latest = [...candles].reverse().find(c => Number.isFinite(c.close) && c.close > 0);
  if (!latest) return null;

  const cmp = Number(latest.close);
  const proposedEntry = Number(signal.entry);
  if (!Number.isFinite(proposedEntry) || proposedEntry <= 0) return null;

  // Treat an entry very near the latest market price as an immediate market entry.
  const proximity = Math.max(Math.abs(cmp) * 0.00015, Math.abs(cmp) * 0.00001);
  let orderType;
  let entry;
  if (Math.abs(proposedEntry - cmp) <= proximity) {
    entry = cmp;
    orderType = signal.direction === "BUY" ? "BUY AT CMP" : "SELL AT CMP";
  } else if (signal.direction === "BUY" && proposedEntry < cmp) {
    entry = proposedEntry;
    orderType = "BUY LIMIT";
  } else if (signal.direction === "SELL" && proposedEntry > cmp) {
    entry = proposedEntry;
    orderType = "SELL LIMIT";
  } else {
    // Do not publish a limit order on the wrong side of current price.
    return null;
  }

  const stop = Number(signal.stopLoss);
  if (!Number.isFinite(stop)) return null;
  if (signal.direction === "BUY" && stop >= entry) return null;
  if (signal.direction === "SELL" && stop <= entry) return null;

  // Calculate RR from the exact displayed entry and stop values so the published
  // levels preserve 1:8 after price precision is applied.
  entry = roundPrice(entry);
  const displayedStop = roundPrice(stop);
  const risk = Math.abs(entry - displayedStop);
  if (!(risk > 0)) return null;
  const takeProfit = signal.direction === "BUY" ? entry + risk * 8 : entry - risk * 8;
  return {
    ...signal,
    instrument: "XAUUSD",
    symbol: "XAUUSD",
    orderType,
    entry,
    stopLoss: displayedStop,
    takeProfit: roundPrice(takeProfit),
    riskReward: "1:8",
    status: "CONFIRMED",
    session: getTradingSession(now).name,
    signalTime: signal.signalTime || now.toISOString(),
    managementNote: "BE when necessary"
  };
}

function isTradeableSignal(signal) {
  const allowedStatus = signal && ["CONFIRMED", "VALID SETUP"].includes(String(signal.status || "").toUpperCase());
  return !!signal && allowedStatus && ["BUY", "SELL"].includes(signal.direction) &&
    Number.isFinite(Number(signal.entry)) && Number.isFinite(Number(signal.stopLoss)) &&
    Number(signal.entry) > 0 && Number(signal.stopLoss) > 0 &&
    (signal.direction === "BUY" ? Number(signal.stopLoss) < Number(signal.entry) : Number(signal.stopLoss) > Number(signal.entry));
}

function fixSignalRiskReward(signal, now = new Date()) {
  const entry = Number(signal.entry);
  const stop = Number(signal.stopLoss);
  const risk = Math.abs(entry - stop);
  if (!risk || !Number.isFinite(risk)) return null;
  const target = signal.direction === "BUY" ? entry + risk * 8 : entry - risk * 8;
  return {
    ...signal,
    instrument: "XAUUSD",
    symbol: "XAUUSD",
    takeProfit: roundPrice(target),
    riskReward: "1:8",
    status: "CONFIRMED",
    session: getTradingSession(now).name,
    signalTime: signal.signalTime || now.toISOString(),
    managementNote: "Consider moving Stop Loss to Break-Even only when price has moved sufficiently in your favour and market structure supports protecting capital."
  };
}

function detectIndependentSetups(item, market, entryTF, now = new Date()) {
  const data = market[entryTF];
  if (!data || data.status !== "success" || !Array.isArray(data.candles)) return [];
  const candles = normalizeCandles(data.candles).filter(c => !c.isOpen);
  if (candles.length < 40) return [];
  const current = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const atr = ATR(candles);
  if (!atr || !current || !previous) return [];

  const recent = candles.slice(-8, -1);
  const priorHigh = Math.max(...candles.slice(-21, -1).map(c => c.high));
  const priorLow = Math.min(...candles.slice(-21, -1).map(c => c.low));
  const recentLow = Math.min(...recent.map(c => c.low));
  const recentHigh = Math.max(...recent.map(c => c.high));
  const body = Math.abs(current.close - current.open);
  const results = [];
  const add = (direction, entry, stop, family) => {
    if (!Number.isFinite(entry) || !Number.isFinite(stop)) return;
    if (direction === "BUY" && stop >= entry) return;
    if (direction === "SELL" && stop <= entry) return;
    results.push({
      instrument: "XAUUSD", symbol: "XAUUSD", category: "COMMODITY", direction,
      orderType: direction === "BUY" ? "BUY" : "SELL",
      entryTF: formatTF(entryTF), entryTFRaw: entryTF,
      entry: roundPrice(entry), stopLoss: roundPrice(stop),
      takeProfit: roundPrice(direction === "BUY" ? entry + (entry - stop) * 8 : entry - (stop - entry) * 8),
      riskReward: "1:8", status: "CONFIRMED", setupType: family,
      signalTime: current.time || now.toISOString(), session: getTradingSession(now).name,
      managementNote: "Consider moving Stop Loss to Break-Even only when price has moved sufficiently in your favour and market structure supports protecting capital."
    });
  };

  // CRT: sweep a recent candle-range extreme and close back inside the range.
  if (current.low < priorLow && current.close > priorLow && current.close > current.open) {
    add("BUY", current.close, Math.min(current.low, recentLow) - atr * 0.12, "CRT");
  }
  if (current.high > priorHigh && current.close < priorHigh && current.close < current.open) {
    add("SELL", current.close, Math.max(current.high, recentHigh) + atr * 0.12, "CRT");
  }

  // APA / pure price action proxy: strong engulfing close after a recent swing test.
  const bullishEngulf = current.close > current.open && previous.close < previous.open && current.close >= previous.open && current.open <= previous.close;
  const bearishEngulf = current.close < current.open && previous.close > previous.open && current.close <= previous.open && current.open >= previous.close;
  if (bullishEngulf && body >= atr * 0.45 && current.low <= recentLow + atr * 0.25) {
    add("BUY", current.close, Math.min(current.low, recentLow) - atr * 0.12, "APA/price-action");
  }
  if (bearishEngulf && body >= atr * 0.45 && current.high >= recentHigh - atr * 0.25) {
    add("SELL", current.close, Math.max(current.high, recentHigh) + atr * 0.12, "APA/price-action");
  }

  // MSNR proxy: a recent higher-timeframe swing level is retested and rejected.
  const levels = getHigherTimeframeLevels(market, timeframeMinutes(entryTF), now);
  const tolerance = Math.max(atr * 0.25, Math.abs(current.close) * 0.0001);
  const level = levels.find(x => Math.abs(current.low - x.price) <= tolerance || Math.abs(current.high - x.price) <= tolerance || (current.low <= x.price + tolerance && current.high >= x.price - tolerance));
  if (level && current.close > current.open && current.close > level.price && current.low <= level.price + tolerance) {
    add("BUY", current.close, Math.min(current.low, recentLow) - atr * 0.12, "MSNR");
  }
  if (level && current.close < current.open && current.close < level.price && current.high >= level.price - tolerance) {
    add("SELL", current.close, Math.max(current.high, recentHigh) + atr * 0.12, "MSNR");
  }
  return results;
}

function mergeSameOpportunities(candidates) {
  const merged = [];
  const sorted = candidates.filter(Boolean).sort((a, b) => tfPriority(b.entryTFRaw) - tfPriority(a.entryTFRaw));
  for (const signal of sorted) {
    const entry = Number(signal.entry);
    const existing = merged.find(x => x.direction === signal.direction &&
      Math.abs(Number(x.entry) - entry) <= Math.max(Math.abs(entry) * 0.00035, Math.abs(Number(x.entry) - Number(x.stopLoss)) * 0.35));
    if (!existing) {
      merged.push({ ...signal, takeProfit: Number(signal.takeProfit), riskReward: "1:8" });
      continue;
    }
    // One alert for overlapping strategy detections; keep the clearer existing entry/TF.
    existing.confirmations = (existing.confirmations || 1) + 1;
  }
  return merged;
}


// ============================================================
// ALCHEMIST STRATEGY ENGINE
// Operational rules are based on the strategy description supplied
// by the user: HTF MSNR level interaction plus one of four triggers.
// ============================================================

function analyzeAlchemistInstrument(item, market, entryTF, now = new Date()) {
  const entryData = market[entryTF];
  if (!entryData || entryData.status !== "success" || !Array.isArray(entryData.candles)) return null;

  const candles = normalizeCandles(entryData.candles).filter(c => !c.isOpen);
  if (candles.length < 40) return null;

  const current = candles[candles.length - 1];
  const atr = ATR(candles);
  if (!atr || !Number.isFinite(current.close)) return null;

  const entryMinutes = timeframeMinutes(entryTF);
  const htfLevels = getHigherTimeframeLevels(market, entryMinutes);
  const touchTolerance = Math.max(atr * 0.45, Math.abs(current.close) * 0.00015);
  const touchedLevel = findRecentHigherTimeframeTouch(candles, htfLevels, touchTolerance, 5);
  if (!touchedLevel) return null;

  const setup = detectAlchemistTrigger(candles, touchedLevel, atr);
  if (!setup) return null;

  const direction = setup.direction;
  const entry = Number.isFinite(setup.entry) ? setup.entry : current.close;
  const recent = candles.slice(-35);
  const stopSwing = direction === "BUY"
    ? Math.min(...recent.map(c => c.low))
    : Math.max(...recent.map(c => c.high));
  const stopLoss = direction === "BUY"
    ? stopSwing - atr * 0.15
    : stopSwing + atr * 0.15;

  if (!Number.isFinite(entry) || !Number.isFinite(stopLoss)) return null;
  if ((direction === "BUY" && stopLoss >= entry) || (direction === "SELL" && stopLoss <= entry)) return null;

  const target = findSwingTarget(candles, direction, entry, htfLevels);
  if (!Number.isFinite(target)) return null;
  if ((direction === "BUY" && target <= entry) || (direction === "SELL" && target >= entry)) return null;

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? `1:${(reward / risk).toFixed(2)}` : "N/A";
  const nySession = getTradingSession(now).name;

  return {
    instrument: item.name,
    symbol: item.symbol,
    category: item.category,
    direction,
    orderType: "MARKET / LEVEL RETEST",
    entryTF: formatTF(entryTF),
    entryTFRaw: entryTF,
    entry: roundPrice(entry),
    stopLoss: roundPrice(stopLoss),
    takeProfit: roundPrice(target),
    riskReward: rr,
    status: "CONFIRMED",
    setupType: setup.name,
    modulePriority: setup.priority,
    htfLevel: roundPrice(touchedLevel.price),
    components: ["Higher-timeframe MSNR level interaction", setup.name],
    signalTime: current.time || now.toISOString(),
    session: nySession,
    managementNote: "Consider moving Stop Loss to Break-Even only when price has moved sufficiently in your favour and market structure supports protecting capital."
  };
}

function detectAlchemistTrigger(candles, touchedLevel, atr) {
  const modules = [
    detectQuasimodo(candles, atr),
    detectStructuralFlip(candles, atr),
    detectOrderBlockFVG(candles, atr),
    detectThirdTouchTrendline(candles, touchedLevel, atr)
  ].filter(Boolean);

  if (!modules.length) return null;
  // Prefer the clearest available module. All modules still require the HTF touch.
  modules.sort((a, b) => b.priority - a.priority);
  return modules[0];
}

function findSwingPoints(candles, left = 2, right = 2, lookback = 100) {
  const highs = [];
  const lows = [];
  const start = Math.max(left, candles.length - lookback);
  for (let i = start; i < candles.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high, time: candles[i].time });
    if (isLow) lows.push({ index: i, price: candles[i].low, time: candles[i].time });
  }
  return { highs, lows };
}

function timeframeMinutes(tf) {
  return ({ "1min": 1, "5min": 5, "15min": 15, "30min": 30, "1h": 60, "4h": 240, "1d": 1440 })[tf] || 15;
}

function getHigherTimeframeLevels(market, entryMinutes, now = new Date()) {
  const levels = getAsianRangeLevels(market, now);
  for (const tf of TIMEFRAMES) {
    if (timeframeMinutes(tf.name) <= entryMinutes) continue;
    if (!["5min", "15min", "30min", "1h", "4h", "1d"].includes(tf.name)) continue;
    const data = market[tf.name];
    if (!data || data.status !== "success" || !Array.isArray(data.candles)) continue;
    const candles = normalizeCandles(data.candles).filter(c => !c.isOpen);
    if (candles.length < 12) continue;
    const swings = findSwingPoints(candles, 2, 2, 80);
    for (const x of swings.highs.slice(-8)) levels.push({ price: x.price, type: "resistance", timeframe: tf.name });
    for (const x of swings.lows.slice(-8)) levels.push({ price: x.price, type: "support", timeframe: tf.name });
    const recent = candles.slice(-30);
    if (recent.length) {
      levels.push({ price: Math.max(...recent.map(c => c.high)), type: "range high", timeframe: tf.name });
      levels.push({ price: Math.min(...recent.map(c => c.low)), type: "range low", timeframe: tf.name });
    }
  }
  const unique = new Map();
  for (const level of levels) {
    if (Number.isFinite(level.price)) unique.set(`${level.timeframe}:${level.type}:${level.price.toFixed(5)}`, level);
  }
  return [...unique.values()];
}

function findRecentHigherTimeframeTouch(candles, levels, tolerance, barsBack = 5) {
  if (!levels.length) return null;
  const start = Math.max(0, candles.length - barsBack);
  for (let i = candles.length - 1; i >= start; i--) {
    const candle = candles[i];
    const touched = levels
      .filter(level => candle.low <= level.price + tolerance && candle.high >= level.price - tolerance)
      .sort((a, b) => Math.abs(candle.close - a.price) - Math.abs(candle.close - b.price));
    if (touched.length) return { ...touched[0], candleIndex: i };
  }
  return null;
}

function detectQuasimodo(candles, atr) {
  const n = candles.length;
  if (n < 15) return null;
  const recentStart = n - 5;
  const prior = candles.slice(0, n - 5);
  const swings = findSwingPoints(prior, 2, 2, 80);
  const recent = candles.slice(recentStart);
  const internal = findSwingPoints(candles.slice(-18, -2), 1, 1, 18);
  const last = candles[n - 1];

  const lowSweep = swings.lows.slice(-8).find(s => recent.some(c => c.low < s.price - atr * 0.05 && c.close > s.price));
  const internalHigh = internal.highs.filter(s => s.index >= 0).slice(-1)[0];
  if (lowSweep && internalHigh && last.close > internalHigh.price) {
    return { name: "Quasimodo (QM) — bullish sweep + MSS", direction: "BUY", entry: lowSweep.price, priority: 4 };
  }

  const highSweep = swings.highs.slice(-8).find(s => recent.some(c => c.high > s.price + atr * 0.05 && c.close < s.price));
  const internalLow = internal.lows.slice(-1)[0];
  if (highSweep && internalLow && last.close < internalLow.price) {
    return { name: "Quasimodo (QM) — bearish sweep + MSS", direction: "SELL", entry: highSweep.price, priority: 4 };
  }
  return null;
}

function detectStructuralFlip(candles, atr) {
  const n = candles.length;
  if (n < 15) return null;
  const last = candles[n - 1];
  const prev = candles[n - 2];
  const swings = findSwingPoints(candles.slice(0, n - 3), 2, 2, 80);
  const tolerance = Math.max(atr * 0.25, Math.abs(last.close) * 0.0001);

  for (const swing of swings.highs.slice(-10).reverse()) {
    const broke = candles.slice(Math.max(0, swing.index + 1), n - 1).some(c => c.close > swing.price + tolerance * 0.15);
    const retested = last.low <= swing.price + tolerance && last.close > swing.price && (prev.low <= swing.price + tolerance || last.low <= swing.price);
    if (broke && retested) return { name: "Structural Flip — RBS retest", direction: "BUY", entry: swing.price, priority: 3 };
  }

  for (const swing of swings.lows.slice(-10).reverse()) {
    const broke = candles.slice(Math.max(0, swing.index + 1), n - 1).some(c => c.close < swing.price - tolerance * 0.15);
    const retested = last.high >= swing.price - tolerance && last.close < swing.price && (prev.high >= swing.price - tolerance || last.high >= swing.price);
    if (broke && retested) return { name: "Structural Flip — SBR retest", direction: "SELL", entry: swing.price, priority: 3 };
  }
  return null;
}

function detectOrderBlockFVG(candles, atr) {
  const n = candles.length;
  if (n < 12) return null;
  const last = candles[n - 1];
  const tolerance = Math.max(atr * 0.3, Math.abs(last.close) * 0.0001);
  const from = Math.max(2, n - 12);

  for (let i = n - 3; i >= from; i--) {
    // Bullish FVG: candle i high is below candle i+2 low.
    if (candles[i].high < candles[i + 2].low) {
      const fvgLow = candles[i].high;
      const fvgHigh = candles[i + 2].low;
      let ob = null;
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (candles[j].close < candles[j].open) { ob = candles[j]; break; }
      }
      if (ob) {
        const overlapLow = Math.max(fvgLow, ob.low);
        const overlapHigh = Math.min(fvgHigh, ob.high);
        if (overlapLow <= overlapHigh && last.low <= overlapHigh + tolerance && last.high >= overlapLow - tolerance && last.close >= overlapLow) {
          return { name: "Order Block + FVG overlap (bullish)", direction: "BUY", entry: (overlapLow + overlapHigh) / 2, priority: 2 };
        }
      }
    }

    // Bearish FVG: candle i low is above candle i+2 high.
    if (candles[i].low > candles[i + 2].high) {
      const fvgLow = candles[i + 2].high;
      const fvgHigh = candles[i].low;
      let ob = null;
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (candles[j].close > candles[j].open) { ob = candles[j]; break; }
      }
      if (ob) {
        const overlapLow = Math.max(fvgLow, ob.low);
        const overlapHigh = Math.min(fvgHigh, ob.high);
        if (overlapLow <= overlapHigh && last.high >= overlapLow - tolerance && last.low <= overlapHigh + tolerance && last.close <= overlapHigh) {
          return { name: "Order Block + FVG overlap (bearish)", direction: "SELL", entry: (overlapLow + overlapHigh) / 2, priority: 2 };
        }
      }
    }
  }
  return null;
}

function detectThirdTouchTrendline(candles, htfLevel, atr) {
  const n = candles.length;
  if (n < 25) return null;
  const swings = findSwingPoints(candles, 2, 2, 60);
  const last = candles[n - 1];
  const tolerance = Math.max(atr * 0.35, Math.abs(last.close) * 0.0001);

  // Approximate three-touch rising support using swing lows.
  const lows = swings.lows.slice(-12);
  for (let a = 0; a < lows.length - 2; a++) {
    for (let b = a + 1; b < lows.length - 1; b++) {
      const first = lows[a], second = lows[b];
      if (second.price <= first.price || second.index <= first.index) continue;
      const slope = (second.price - first.price) / (second.index - first.index);
      const third = lows.slice(b + 1).find(point => {
        const projected = first.price + slope * (point.index - first.index);
        return Math.abs(point.price - projected) <= tolerance && Math.abs(point.price - htfLevel.price) <= tolerance * 2;
      });
      if (third && Math.abs(last.low - htfLevel.price) <= tolerance * 2 && last.close > last.open) {
        return { name: "Third-touch trendline + MSNR alignment (bullish)", direction: "BUY", entry: htfLevel.price, priority: 1 };
      }
    }
  }

  // Approximate three-touch falling resistance using swing highs.
  const highs = swings.highs.slice(-12);
  for (let a = 0; a < highs.length - 2; a++) {
    for (let b = a + 1; b < highs.length - 1; b++) {
      const first = highs[a], second = highs[b];
      if (second.price >= first.price || second.index <= first.index) continue;
      const slope = (second.price - first.price) / (second.index - first.index);
      const third = highs.slice(b + 1).find(point => {
        const projected = first.price + slope * (point.index - first.index);
        return Math.abs(point.price - projected) <= tolerance && Math.abs(point.price - htfLevel.price) <= tolerance * 2;
      });
      if (third && Math.abs(last.high - htfLevel.price) <= tolerance * 2 && last.close < last.open) {
        return { name: "Third-touch trendline + MSNR alignment (bearish)", direction: "SELL", entry: htfLevel.price, priority: 1 };
      }
    }
  }
  return null;
}

function findSwingTarget(candles, direction, entry, htfLevels = []) {
  const swings = findSwingPoints(candles, 2, 2, 100);
  if (direction === "BUY") {
    const targets = [
      ...swings.highs.map(s => s.price),
      ...htfLevels.map(level => level.price)
    ].filter(p => Number.isFinite(p) && p > entry).sort((a, b) => a - b);
    if (targets.length) return targets[0];
    const high = Math.max(...candles.slice(-60).map(c => c.high));
    return high > entry ? high : null;
  }
  const targets = [
    ...swings.lows.map(s => s.price),
    ...htfLevels.map(level => level.price)
  ].filter(p => Number.isFinite(p) && p < entry).sort((a, b) => b - a);
  if (targets.length) return targets[0];
  const low = Math.min(...candles.slice(-60).map(c => c.low));
  return low < entry ? low : null;
}

function getAsianRangeLevels(market, now = new Date()) {
  // Prefer M5 data, but fall back to M15 if the M5 feed failed.
  const data = [market["5min"], market["15min"]].find(
    candidate => candidate && candidate.status === "success" && Array.isArray(candidate.candles)
  );
  if (!data) return [];
  const candles = normalizeCandles(data.candles).filter(c => !c.isOpen);
  const p = nyTimeParts(now);
  const previousDate = new Date(Date.UTC(p.year, p.month - 1, p.day - 1));
  const previousKey = `${previousDate.getUTCFullYear()}-${String(previousDate.getUTCMonth() + 1).padStart(2, "0")}-${String(previousDate.getUTCDate()).padStart(2, "0")}`;
  const asianCandles = candles.filter(c => {
    if (!c.time) return false;
    const local = nyTimeParts(new Date(c.time));
    const key = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
    return key === previousKey && local.hour >= 20;
  });
  if (!asianCandles.length) return [];
  return [
    { price: Math.max(...asianCandles.map(c => c.high)), type: "Asian High", timeframe: "Asian Range" },
    { price: Math.min(...asianCandles.map(c => c.low)), type: "Asian Low", timeframe: "Asian Range" }
  ];
}

function nyTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const out = {};
  for (const part of parts) if (part.type !== "literal") out[part.type] = part.value;
  return { year: Number(out.year), month: Number(out.month), day: Number(out.day), hour: Number(out.hour), minute: Number(out.minute), second: Number(out.second) };
}

function newYorkZoneAbbr(date = new Date()) {
  const label = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "short" }).format(date);
  return label.includes("EDT") ? "EDT" : "EST";
}

function isAlchemistTradingWindow(date = new Date()) {
  const p = nyTimeParts(date);
  const minuteOfDay = p.hour * 60 + p.minute;
  // London Killzone: 02:00–05:00 NY time.
  // New York AM Killzone: 08:30–11:00 NY time.
  return (minuteOfDay >= 120 && minuteOfDay < 300) || (minuteOfDay >= 510 && minuteOfDay < 660);
}

function formatWatTime(nyMinuteOfDay, date = new Date()) {
  const offsetHours = newYorkZoneAbbr(date) === "EDT" ? 5 : 6;
  const total = (nyMinuteOfDay + offsetHours * 60) % (24 * 60);
  const hour24 = Math.floor(total / 60);
  const minute = total % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function formatNYTime(minuteOfDay) {
  const hour24 = Math.floor(minuteOfDay / 60) % 24;
  const minute = minuteOfDay % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function getSessionAlert(now = new Date()) {
  const p = nyTimeParts(now);
  const minuteOfDay = p.hour * 60 + p.minute;
  const dateKey = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;

  if (minuteOfDay >= 120 && minuteOfDay < 140) {
    return {
      key: `${dateKey}:london`,
      name: "London",
      flag: "🇬🇧",
      start: 120,
      end: 300,
      text: `🔔 CYBERFX SESSION ALERT

🇬🇧 LONDON SESSION IS OPENING!

Traders, get ready! The London trading session is beginning.

⏰ Session Time: 2:00 AM – 5:00 AM (New York Time)
🇳🇬 Nigeria Time: ${formatWatTime(120, now)} – ${formatWatTime(300, now)} (WAT)

📊 Trading Pair: XAUUSD

⚠️ The session opening does not guarantee an immediate signal. CyberFX will wait for valid entry conditions before generating a signal.

🎯 Traders, stay ready! Keep an eye on the market and wait for confirmed signals before entering any trade.

Stay alert. Trade smart.

God Over Man`
    };
  }

  if (minuteOfDay >= 510 && minuteOfDay < 530) {
    return {
      key: `${dateKey}:newyork`,
      name: "New York",
      flag: "🇺🇸",
      start: 510,
      end: 660,
      text: `🔔 CYBERFX SESSION ALERT

🇺🇸 NEW YORK SESSION IS OPENING!

Traders, get ready! The New York AM trading session is beginning.

⏰ Session Time: 8:30 AM – 11:00 AM (New York Time)
🇳🇬 Nigeria Time: ${formatWatTime(510, now)} – ${formatWatTime(660, now)} (WAT)

📊 Trading Pair: XAUUSD

⚠️ The session opening does not guarantee an immediate signal. CyberFX will wait for valid entry conditions before generating a signal.

🎯 Traders, stay ready! Keep an eye on the market and wait for confirmed signals before entering any trade.

Stay alert. Trade smart.

God Over Man`
    };
  }
  return null;
}

function getTradingSession(time) {
  const p = nyTimeParts(new Date(time));
  const minuteOfDay = p.hour * 60 + p.minute;
  if (minuteOfDay >= 120 && minuteOfDay < 300) return { name: "London" };
  if (minuteOfDay >= 510 && minuteOfDay < 660) return { name: "New York" };
  if (minuteOfDay >= 1200 || minuteOfDay < 0) return { name: "Asian" };
  if (minuteOfDay >= 0 && minuteOfDay < 120) return { name: "Asian" };
  if (minuteOfDay >= 300 && minuteOfDay < 510) return { name: "London / Pre-New York" };
  return { name: "New York / Other" };
}

// ============================================================
// ANALYZE
// ============================================================

function analyzeInstrument(
  item,
  market,
  entryTF
) {
  const entryData =
    market[entryTF];

  if (
    !entryData ||
    entryData.status !== "success" ||
    !Array.isArray(entryData.candles)
  ) {
    return null;
  }

  const candles =
    normalizeCandles(
      entryData.candles
    ).filter(
      c => !c.isOpen
    );

  if (candles.length < 40) {
    return null;
  }

  const current =
    candles[
      candles.length - 1
    ];

  const htfBias =
    determineHTFBias(
      market
    );

  const structure =
    detectStructure(
      candles
    );

  const rejection =
    detectRejection(
      candles,
      structure
    );

  let bestResult = null;

  if (
    rejection &&
    (
      htfBias === "neutral" ||
      rejection.direction === htfBias
    )
  ) {
    bestResult =
      buildRejectionSignal(
        item,
        entryTF,
        rejection,
        htfBias,
        current
      );
  }

  const accumulation =
    detectAccumulation(
      candles
    );

  const crt =
    detectCRT(
      candles,
      accumulation
    );

  const sweep =
    detectLiquiditySweep(
      candles,
      crt,
      structure
    );

  const direction =
    determineDevelopingDirection(
      htfBias,
      rejection,
      sweep,
      structure
    );

  if (!direction) {
    return bestResult;
  }

  const displacement =
    detectDisplacement(
      candles,
      sweep
    );

  const structureBreak =
    detectBOSMSS(
      candles,
      structure,
      displacement
    );

  const validSetup =
    detectValidSetup(
      direction,
      htfBias,
      rejection,
      crt,
      sweep,
      displacement,
      structureBreak,
      structure
    );

  if (validSetup) {
    const setup =
      buildValidSetupSignal(
        item,
        entryTF,
        direction,
        candles,
        sweep,
        structure,
        crt,
        displacement,
        structureBreak,
        rejection,
        htfBias
      );

    if (
      setup &&
      (
        !bestResult ||
        SIGNAL_PRIORITY[setup.status] >
        SIGNAL_PRIORITY[bestResult.status]
      )
    ) {
      bestResult = setup;
    }
  }

  if (
    !crt ||
    !sweep ||
    !displacement ||
    !structureBreak
  ) {
    return bestResult;
  }

  if (
    htfBias !== "neutral" &&
    direction !== htfBias
  ) {
    return bestResult;
  }

  const impulse =
    getImpulseLeg(
      candles,
      structureBreak,
      sweep
    );

  if (!impulse) {
    return bestResult;
  }

  const fib =
    calculateFib(
      impulse,
      structureBreak.direction
    );

  const orderBlock =
    findOrderBlock(
      candles,
      displacement,
      structureBreak
    );

  const fvg =
    findFVG(
      candles,
      displacement
    );

  const pullback =
    validatePullback(
      candles,
      impulse,
      fib,
      orderBlock,
      fvg,
      structureBreak.direction
    );

  if (!pullback.valid) {
    return bestResult;
  }

  const entry =
    determineEntry(
      current.close,
      fib,
      orderBlock,
      fvg,
      structureBreak.direction
    );

  if (!entry) {
    return bestResult;
  }

  const stopLoss =
    determineStopLoss(
      entry,
      structureBreak.direction,
      sweep,
      orderBlock,
      candles
    );

  if (!stopLoss) {
    return bestResult;
  }

  const risk =
    structureBreak.direction === "bullish"
      ? entry - stopLoss
      : stopLoss - entry;

  if (risk <= 0) {
    return bestResult;
  }

  // ========================================================
  // FINAL RR = 1:10
  // ========================================================

  const takeProfit =
    structureBreak.direction === "bullish"
      ? entry + risk * 10
      : entry - risk * 10;

  const score =
    calculateScore({
      htfBias,
      crt,
      sweep,
      structureBreak,
      displacement,
      orderBlock,
      fvg,
      fib,
      accumulation,
      pullback
    });

  if (score < CONFIRMED_SCORE) {
    return bestResult;
  }

  const session =
    getTradingSession(
      current.time
    );

  return {
    instrument: item.name || item.symbol,
    symbol: item.symbol,
    category: item.category,

    direction:
      structureBreak.direction === "bullish"
        ? "BUY"
        : "SELL",

    orderType:
      structureBreak.direction === "bullish"
        ? "BUY LIMIT"
        : "SELL LIMIT",

    entryTF:
      formatTF(entryTF),

    entryTFRaw:
      entryTF,

    entry:
      roundPrice(entry),

    stopLoss:
      roundPrice(stopLoss),

    takeProfit:
      roundPrice(takeProfit),

    riskReward: "1:10",

    status: "CONFIRMED",

    label:
      structureBreak.direction === "bullish"
        ? "🟢 CYBERFX A+ BUY"
        : "🟢 CYBERFX A+ SELL",

    session:

      session.name,

    signalTime:
      current.time,

    message:
      "GOD OVER MAN",

    internal: {
      score,
      htfBias,
      accumulation,
      crt,
      sweep,
      structureBreak,
      displacement,
      orderBlock,
      fvg,
      fib,
      pullback,
      signalCandleTime:
        current.time
    }
  };
}


// ============================================================
// REJECTION
// ============================================================

function detectRejection(
  candles,
  structure
) {
  const current =
    candles[
      candles.length - 1
    ];

  if (!current) {
    return null;
  }

  const range =
    current.high -
    current.low;

  if (range <= 0) {
    return null;
  }

  const body =
    Math.abs(
      current.close -
      current.open
    );

  const upperWick =
    current.high -
    Math.max(
      current.open,
      current.close
    );

  const lowerWick =
    Math.min(
      current.open,
      current.close
    ) -
    current.low;

  const closeLocation =
    (
      current.close -
      current.low
    ) / range;

  const atr =
    ATR(candles);

  if (
    atr &&
    range < atr * 0.35
  ) {
    return null;
  }

  if (
    lowerWick >=
      Math.max(
        body * 1.25,
        range * 0.30
      ) &&
    closeLocation >= 0.60
  ) {
    const level =
      current.low;

    const nearSwingLow =
      structure?.lows?.some(
        swing =>
          Math.abs(
            swing.price -
            level
          ) <=
          range * 0.50
      );

    if (
      nearSwingLow ||
      lowerWick >=
        range * 0.40
    ) {
      return {
        direction: "bullish",
        type: "BUY REJECTION",
        level,
        candle: current,
        reason:
          nearSwingLow
            ? "Swing low rejection"
            : "Strong lower-wick rejection"
      };
    }
  }

  if (
    upperWick >=
      Math.max(
        body * 1.25,
        range * 0.30
      ) &&
    closeLocation <= 0.40
  ) {
    const level =
      current.high;

    const nearSwingHigh =
      structure?.highs?.some(
        swing =>
          Math.abs(
            swing.price -
            level
          ) <=
          range * 0.50
      );

    if (
      nearSwingHigh ||
      upperWick >=
        range * 0.40
    ) {
      return {
        direction: "bearish",
        type: "SELL REJECTION",
        level,
        candle: current,
        reason:
          nearSwingHigh
            ? "Swing high rejection"
            : "Strong upper-wick rejection"
      };
    }
  }

  return null;
}


// ============================================================
// DIRECTION
// ============================================================

function determineDevelopingDirection(
  htfBias,
  rejection,
  sweep,
  structure
) {
  if (sweep?.direction) {
    if (
      htfBias === "neutral" ||
      sweep.direction === htfBias
    ) {
      return sweep.direction;
    }
  }

  if (rejection?.direction) {
    if (
      htfBias === "neutral" ||
      rejection.direction === htfBias
    ) {
      return rejection.direction;
    }
  }

  if (
    structure?.direction &&
    structure.direction !== "neutral"
  ) {
    if (
      htfBias === "neutral" ||
      structure.direction === htfBias
    ) {
      return structure.direction;
    }
  }

  return null;
}


// ============================================================
// VALID SETUP
// ============================================================

function detectValidSetup(
  direction,
  htfBias,
  rejection,
  crt,
  sweep,
  displacement,
  structureBreak,
  structure
) {
  let score = 0;

  if (htfBias === direction) {
    score += 2;
  }

  if (
    rejection &&
    rejection.direction === direction
  ) {
    score += 2;
  }

  if (crt) {
    score += 1;
  }

  if (
    sweep &&
    sweep.direction === direction
  ) {
    score += 3;
  }

  if (
    displacement &&
    displacement.direction === direction
  ) {
    score += 2;
  }

  if (
    structureBreak &&
    structureBreak.direction === direction
  ) {
    score += 3;
  }

  if (
    structure &&
    structure.direction === direction
  ) {
    score += 1;
  }

  return score >= 5;
}


// ============================================================
// VALID SETUP OUTPUT
// ============================================================

function buildValidSetupSignal(
  item,
  entryTF,
  direction,
  candles,
  sweep,
  structure,
  crt,
  displacement,
  structureBreak,
  rejection,
  htfBias
) {
  const current =
    candles[
      candles.length - 1
    ];

  const atr =
    ATR(candles);

  if (!atr) {
    return null;
  }

  let entry =
    current.close;

  if (sweep?.level) {
    entry = sweep.level;
  } else if (rejection?.level) {
    entry = rejection.level;
  }

  let stopLoss;

  if (direction === "bullish") {
    stopLoss =
      (
        sweep?.level ||
        rejection?.level ||
        current.low
      ) -
      atr * 0.25;
  } else {
    stopLoss =
      (
        sweep?.level ||
        rejection?.level ||
        current.high
      ) +
      atr * 0.25;
  }

  const risk =
    direction === "bullish"
      ? entry - stopLoss
      : stopLoss - entry;

  if (risk <= 0) {
    return null;
  }

  const takeProfit =
    direction === "bullish"
      ? entry + risk * 10
      : entry - risk * 10;

  const components = [];

  if (htfBias === direction) {
    components.push("HTF Bias");
  }

  if (structure?.direction === direction) {
    components.push("Structure");
  }

  if (rejection) {
    components.push("Rejection");
  }

  if (sweep) {
    components.push("Liquidity Sweep");
  }

  if (displacement) {
    components.push("Displacement");
  }

  if (structureBreak) {
    components.push(
      structureBreak.type
    );
  }

  if (crt) {
    components.push("CRT");
  }

  return {
    instrument:
      item.name || item.symbol,

    symbol:
      item.symbol,

    category:
      item.category,

    direction:
      direction === "bullish"
        ? "BUY"
        : "SELL",

    orderType:
      direction === "bullish"
        ? "BUY LIMIT"
        : "SELL LIMIT",

    entryTF:
      formatTF(entryTF),

    entryTFRaw:
      entryTF,

    entry:
      roundPrice(entry),

    stopLoss:
      roundPrice(stopLoss),

    takeProfit:
      roundPrice(takeProfit),

    riskReward: "1:10",

    status: "VALID SETUP",

    label:
      direction === "bullish"
        ? "🟡 CYBERFX VALID BUY SETUP"
        : "🟡 CYBERFX VALID SELL SETUP",

    components,

    signalTime:
      current.time,

    session:
      getTradingSession(
        current.time
      ).name
  };
}


// ============================================================
// STRUCTURE
// ============================================================

function detectStructure(
  candles
) {
  const highs = [];
  const lows = [];

  for (
    let i = 2;
    i < candles.length - 2;
    i++
  ) {
    if (
      candles[i].high >
        candles[i - 1].high &&
      candles[i].high >
        candles[i - 2].high &&
      candles[i].high >
        candles[i + 1].high &&
      candles[i].high >
        candles[i + 2].high
    ) {
      highs.push({
        index: i,
        price: candles[i].high
      });
    }

    if (
      candles[i].low <
        candles[i - 1].low &&
      candles[i].low <
        candles[i - 2].low &&
      candles[i].low <
        candles[i + 1].low &&
      candles[i].low <
        candles[i + 2].low
    ) {
      lows.push({
        index: i,
        price: candles[i].low
      });
    }
  }

  if (
    highs.length < 2 ||
    lows.length < 2
  ) {
    return {
      direction: "neutral",
      highs,
      lows
    };
  }

  const h1 =
    highs[highs.length - 2];

  const h2 =
    highs[highs.length - 1];

  const l1 =
    lows[lows.length - 2];

  const l2 =
    lows[lows.length - 1];

  if (
    h2.price > h1.price &&
    l2.price > l1.price
  ) {
    return {
      direction: "bullish",
      highs,
      lows
    };
  }

  if (
    h2.price < h1.price &&
    l2.price < l1.price
  ) {
    return {
      direction: "bearish",
      highs,
      lows
    };
  }

  return {
    direction: "neutral",
    highs,
    lows
  };
}


// ============================================================
// HTF BIAS
// 4H + 1H
// D1 ONLY FOR FRIDAY/WEEKEND CONTEXT
// ============================================================

function determineHTFBias(
  market
) {
  let bullish = 0;
  let bearish = 0;

  for (
    const tf of ["4h", "1h"]
  ) {
    const data =
      market[tf];

    if (
      !data ||
      data.status !== "success"
    ) {
      continue;
    }

    const candles =
      normalizeCandles(
        data.candles
      ).filter(
        c => !c.isOpen
      );

    if (candles.length < 30) {
      continue;
    }

    const structure =
      detectStructure(
        candles
      );

    if (
      structure.direction ===
      "bullish"
    ) {
      bullish++;
    }

    if (
      structure.direction ===
      "bearish"
    ) {
      bearish++;
    }
  }

  if (bullish >= 2) {
    return "bullish";
  }

  if (bearish >= 2) {
    return "bearish";
  }

  if (bullish > bearish) {
    return "bullish";
  }

  if (bearish > bullish) {
    return "bearish";
  }

  return "neutral";
}


// ============================================================
// ACCUMULATION
// ============================================================

function detectAccumulation(
  candles
) {
  const lookback = 12;

  if (
    candles.length < lookback
  ) {
    return null;
  }

  const recent =
    candles.slice(-lookback);

  const high =
    Math.max(
      ...recent.map(
        c => c.high
      )
    );

  const low =
    Math.min(
      ...recent.map(
        c => c.low
      )
    );

  const range =
    high - low;

  const atr =
    ATR(candles);

  if (
    !atr ||
    range > atr * 2
  ) {
    return null;
  }

  return {
    high,
    low,
    range,
    candles: lookback
  };
}


// ============================================================
// CRT
// ============================================================

function detectCRT(
  candles,
  accumulation
) {
  const reference =
    candles[
      candles.length - 1
    ];

  if (!reference) {
    return null;
  }

  const range =
    reference.high -
    reference.low;

  const atr =
    ATR(candles);

  if (
    !range ||
    (
      atr &&
      range < atr * 0.15
    )
  ) {
    return null;
  }

  return {
    high:
      reference.high,

    low:
      reference.low,

    time:
      reference.time
  };
}


// ============================================================
// LIQUIDITY SWEEP
// ============================================================

function detectLiquiditySweep(
  candles,
  crt,
  structure
) {
  if (!crt) {
    return null;
  }

  const current =
    candles[
      candles.length - 1
    ];

  if (!current) {
    return null;
  }

  if (
    current.low < crt.low &&
    current.close > crt.low
  ) {
    return {
      direction: "bullish",
      level: crt.low,
      candle: current
    };
  }

  if (
    current.high > crt.high &&
    current.close < crt.high
  ) {
    return {
      direction: "bearish",
      level: crt.high,
      candle: current
    };
  }

  if (structure?.lows?.length) {
    const swingLow =
      structure.lows[
        structure.lows.length - 1
      ];

    if (
      current.low <
        swingLow.price &&
      current.close >
        swingLow.price
    ) {
      return {
        direction: "bullish",
        level: swingLow.price,
        candle: current
      };
    }
  }

  if (structure?.highs?.length) {
    const swingHigh =
      structure.highs[
        structure.highs.length - 1
      ];

    if (
      current.high >
        swingHigh.price &&
      current.close <
        swingHigh.price
    ) {
      return {
        direction: "bearish",
        level: swingHigh.price,
        candle: current
      };
    }
  }

  return null;
}


// ============================================================
// DISPLACEMENT
// ============================================================

function detectDisplacement(
  candles,
  sweep
) {
  if (!sweep) {
    return null;
  }

  const current =
    candles[
      candles.length - 1
    ];

  const previous10 =
    candles.slice(-11, -1);

  if (
    previous10.length < 10
  ) {
    return null;
  }

  const averageBody =
    average(
      previous10.map(
        c =>
          Math.abs(
            c.close -
            c.open
          )
      )
    );

  const body =
    Math.abs(
      current.close -
      current.open
    );

  const range =
    current.high -
    current.low;

  if (!range) {
    return null;
  }

  const bodyRatio =
    body / range;

  const closeLocation =
    (
      current.close -
      current.low
    ) / range;

  if (
    sweep.direction === "bullish" &&
    current.close > current.open &&
    closeLocation >= 0.75 &&
    body >= averageBody * 1.5 &&
    bodyRatio >= 0.60
  ) {
    return {
      direction: "bullish",
      candle: current,
      body,
      range
    };
  }

  if (
    sweep.direction === "bearish" &&
    current.close < current.open &&
    closeLocation <= 0.25 &&
    body >= averageBody * 1.5 &&
    bodyRatio >= 0.60
  ) {
    return {
      direction: "bearish",
      candle: current,
      body,
      range
    };
  }

  return null;
}


// ============================================================
// BOS / MSS
// ============================================================

function detectBOSMSS(
  candles,
  structure,
  displacement
) {
  if (
    !structure ||
    !displacement
  ) {
    return null;
  }

  const current =
    candles[
      candles.length - 1
    ];

  if (
    displacement.direction ===
    "bullish"
  ) {
    const previousHigh =
      structure.highs[
        structure.highs.length - 1
      ];

    if (
      previousHigh &&
      current.close >
        previousHigh.price
    ) {
      return {
        direction: "bullish",
        type:
          structure.direction ===
          "bearish"
            ? "MSS"
            : "BOS",
        level:
          previousHigh.price
      };
    }
  }

  if (
    displacement.direction ===
    "bearish"
  ) {
    const previousLow =
      structure.lows[
        structure.lows.length - 1
      ];

    if (
      previousLow &&
      current.close <
        previousLow.price
    ) {
      return {
        direction: "bearish",
        type:
          structure.direction ===
          "bullish"
            ? "MSS"
            : "BOS",
        level:
          previousLow.price
      };
    }
  }

  return null;
}


// ============================================================
// IMPULSE
// ============================================================

function getImpulseLeg(
  candles,
  structureBreak,
  sweep
) {
  if (
    !structureBreak ||
    !sweep
  ) {
    return null;
  }

  if (
    structureBreak.direction ===
    "bullish"
  ) {
    return {
      direction: "bullish",
      low: sweep.level,
      high:
        structureBreak.level
    };
  }

  return {
    direction: "bearish",
    high: sweep.level,
    low:
      structureBreak.level
  };
}


// ============================================================
// FIB
// ============================================================

function calculateFib(
  impulse,
  direction
) {
  if (!impulse) {
    return null;
  }

  const range =
    impulse.high -
    impulse.low;

  if (
    !Number.isFinite(range) ||
    range <= 0
  ) {
    return null;
  }

  if (
    direction === "bullish"
  ) {
    return {
      "38.2":
        impulse.high -
        range * 0.382,

      "50":
        impulse.high -
        range * 0.50,

      "61.8":
        impulse.high -
        range * 0.618
    };
  }

  return {
    "38.2":
      impulse.low +
      range * 0.382,

    "50":
      impulse.low +
      range * 0.50,

    "61.8":
      impulse.low +
      range * 0.618
  };
}


// ============================================================
// ORDER BLOCK
// ============================================================

function findOrderBlock(
  candles,
  displacement,
  structureBreak
) {
  if (
    !displacement ||
    !structureBreak
  ) {
    return null;
  }

  const index =
    candles.findIndex(
      c =>
        c.time ===
        displacement.candle.time
    );

  if (index <= 0) {
    return null;
  }

  for (
    let i = index - 1;
    i >= Math.max(0, index - 5);
    i--
  ) {
    const candle =
      candles[i];

    if (
      structureBreak.direction ===
      "bullish" &&
      candle.close <
        candle.open
    ) {
      return {
        direction: "bullish",
        high: candle.high,
        low: candle.low,
        time: candle.time
      };
    }

    if (
      structureBreak.direction ===
      "bearish" &&
      candle.close >
        candle.open
    ) {
      return {
        direction: "bearish",
        high: candle.high,
        low: candle.low,
        time: candle.time
      };
    }
  }

  return null;
}


// ============================================================
// FVG
// ============================================================

function findFVG(
  candles,
  displacement
) {
  if (!displacement) {
    return null;
  }

  const i =
    candles.findIndex(
      c =>
        c.time ===
        displacement.candle.time
    );

  if (i < 2) {
    return null;
  }

  const c1 =
    candles[i - 2];

  const c3 =
    candles[i];

  if (
    displacement.direction ===
    "bullish" &&
    c1.high < c3.low
  ) {
    return {
      direction: "bullish",
      low: c1.high,
      high: c3.low
    };
  }

  if (
    displacement.direction ===
    "bearish" &&
    c1.low > c3.high
  ) {
    return {
      direction: "bearish",
      low: c3.high,
      high: c1.low
    };
  }

  return null;
}


// ============================================================
// PULLBACK
// ============================================================

function validatePullback(
  candles,
  impulse,
  fib,
  orderBlock,
  fvg,
  direction
) {
  if (
    !fib ||
    !impulse
  ) {
    return {
      valid: false
    };
  }

  const current =
    candles[
      candles.length - 1
    ];

  const price =
    current.close;

  let fibZone = false;

  if (
    direction === "bullish"
  ) {
    fibZone =
      price <= fib["38.2"] &&
      price >= fib["61.8"];
  } else {
    fibZone =
      price >= fib["38.2"] &&
      price <= fib["61.8"];
  }

  const zoneOverlap =
    fibZone ||
    priceInside(
      price,
      orderBlock
    ) ||
    priceInside(
      price,
      fvg
    );

  if (!zoneOverlap) {
    return {
      valid: false
    };
  }

  const recent =
    candles.slice(-5);

  const oppositeCount =
    recent.filter(
      c =>
        direction === "bullish"
          ? c.close < c.open
          : c.close > c.open
    ).length;

  return {
    valid:
      oppositeCount >= 2 ||
      fibZone,

    fibZone,

    oppositeCount
  };
}


// ============================================================
// ENTRY
// ============================================================

function determineEntry(
  currentPrice,
  fib,
  orderBlock,
  fvg,
  direction
) {
  const candidates = [];

  if (orderBlock) {
    candidates.push(
      midpoint(
        orderBlock.low,
        orderBlock.high
      )
    );
  }

  if (fvg) {
    candidates.push(
      midpoint(
        fvg.low,
        fvg.high
      )
    );
  }

  if (fib) {
    candidates.push(
      fib["50"]
    );
  }

  if (!candidates.length) {
    return currentPrice;
  }

  candidates.sort(
    (a, b) =>
      Math.abs(
        a - currentPrice
      ) -
      Math.abs(
        b - currentPrice
      )
  );

  return candidates[0];
}


// ============================================================
// STOP LOSS
// ============================================================

function determineStopLoss(
  entry,
  direction,
  sweep,
  orderBlock,
  candles
) {
  const atr =
    ATR(candles);

  if (!atr) {
    return null;
  }

  let sl;

  if (
    direction === "bullish"
  ) {
    sl =
      sweep
        ? sweep.level - atr * 0.10
        : entry - atr;

    if (
      orderBlock &&
      orderBlock.low < sl
    ) {
      sl =
        orderBlock.low -
        atr * 0.05;
    }

    if (sl >= entry) {
      return null;
    }
  } else {
    sl =
      sweep
        ? sweep.level + atr * 0.10
        : entry + atr;

    if (
      orderBlock &&
      orderBlock.high > sl
    ) {
      sl =
        orderBlock.high +
        atr * 0.05;
    }

    if (sl <= entry) {
      return null;
    }
  }

  return sl;
}


// ============================================================
// SCORE
// ============================================================

function calculateScore(x) {
  let score = 0;

  if (
    x.htfBias &&
    x.structureBreak
  ) {
    score += 2;
  }

  if (x.crt) {
    score += 2;
  }

  if (x.sweep) {
    score += 2;
  }

  if (x.structureBreak) {
    score += 2;
  }

  if (x.displacement) {
    score += 2;
  }

  if (x.orderBlock) {
    score += 1;
  }

  if (x.fvg) {
    score += 1;
  }

  if (
    x.fib &&
    x.pullback &&
    x.pullback.fibZone
  ) {
    score += 1;
  }

  if (x.accumulation) {
    score += 1;
  }

  if (
    x.pullback &&
    x.pullback.valid
  ) {
    score += 2;
  }

  return score;
}


// ============================================================
// ATR
// ============================================================

function ATR(
  candles,
  period = 14
) {
  if (
    candles.length <
    period + 1
  ) {
    return 0;
  }

  const ranges = [];

  for (
    let i =
      candles.length - period;
    i < candles.length;
    i++
  ) {
    const current =
      candles[i];

    const previous =
      candles[i - 1];

    if (!previous) {
      continue;
    }

    ranges.push(
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
            previous.close
        ),

        Math.abs(
          current.low -
            previous.close
        )
      )
    );
  }

  return average(ranges);
}


// ============================================================
// CANDLE NORMALIZATION
// ============================================================

function normalizeCandles(
  values
) {
  return values
    .map(c => ({
      time:
        c.openTime ||
        c.timestamp ||
        c.time,

      open:
        Number(c.open),

      high:
        Number(c.high),

      low:
        Number(c.low),

      close:
        Number(c.close),

      volume:
        Number(c.volume || 0),

      tickVolume:
        Number(c.tickVolume || 0),

      isOpen:
        Boolean(c.isOpen)
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .sort(
      (a, b) =>
        new Date(a.time) -
        new Date(b.time)
    );
}


// ============================================================
// TRIAL SYSTEM
// ============================================================

async function startTrial(
  email,
  env
) {
  if (!env.DB) {
    return {
      success: false,
      error:
        "D1 database binding DB is missing"
    };
  }

  const user =
    await env.DB.prepare(`
      SELECT id, email
      FROM users
      WHERE email = ?
      LIMIT 1
    `)
      .bind(email)
      .first();

  if (!user) {
    return {
      success: false,
      error:
        "User account not found. Register first."
    };
  }

  const existing =
    await env.DB.prepare(`
      SELECT id, plan, starts_at, expires_at, status
      FROM subscriptions
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 1
    `)
      .bind(user.id)
      .first();

  if (existing) {
    return {
      success: true,
      already_started: true,
      plan: existing.plan,
      starts_at: existing.starts_at,
      expires_at: existing.expires_at,
      status: existing.status
    };
  }

  const start =
    new Date();

  const expiry =
    new Date(
      start.getTime() +
      TRIAL_DAYS *
      24 *
      60 *
      60 *
      1000
    );

  await env.DB.prepare(`
    INSERT INTO subscriptions (
      user_id,
      plan,
      paystack_reference,
      status,
      starts_at,
      expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `)
    .bind(
      user.id,
      "trial",
      null,
      "active",
      start.toISOString(),
      expiry.toISOString()
    )
    .run();

  return {
    success: true,
    trial: true,
    plan: "trial",
    plan_name: "21-Day Free Trial",
    starts_at:
      start.toISOString(),
    expires_at:
      expiry.toISOString(),
    trial_days:
      TRIAL_DAYS
  };
}


async function ensureTrialForUser(
  email,
  env
) {
  if (!env.DB) {
    return;
  }

  const user =
    await env.DB.prepare(`
      SELECT id
      FROM users
      WHERE email = ?
      LIMIT 1
    `)
      .bind(email)
      .first();

  if (!user) {
    return;
  }

  const existing =
    await env.DB.prepare(`
      SELECT id
      FROM subscriptions
      WHERE user_id = ?
      LIMIT 1
    `)
      .bind(user.id)
      .first();

  if (!existing) {
    await startTrial(
      email,
      env
    );
  }
}


// ============================================================
// PAYSTACK VERIFICATION
// ============================================================

async function verifyPaystackPayment(
  reference,
  env
) {
  if (!env.PAYSTACK_SECRET_KEY) {
    throw new Error(
      "PAYSTACK_SECRET_KEY is missing"
    );
  }

  if (!env.DB) {
    throw new Error(
      "D1 database binding DB is missing"
    );
  }

  const response =
    await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization:
            `Bearer ${env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

  const result =
    await response.json();

  if (
    !response.ok ||
    !result.status ||
    !result.data
  ) {
    return {
      success: false,
      payment_status: "failed",
      error:
        result.message ||
        "Unable to verify payment"
    };
  }

  const transaction =
    result.data;

  if (
    transaction.status !==
    "success"
  ) {
    await env.DB.prepare(`
      UPDATE payments
      SET status = ?
      WHERE reference = ?
    `)
      .bind(
        transaction.status ||
          "failed",
        reference
      )
      .run();

    return {
      success: false,
      payment_status:
        transaction.status ||
        "failed",
      reference
    };
  }

  const payment =
    await env.DB.prepare(`
      SELECT
        reference,
        amount,
        plan,
        status,
        email
      FROM payments
      WHERE reference = ?
      LIMIT 1
    `)
      .bind(reference)
      .first();

  if (!payment) {
    return {
      success: false,
      payment_status: "failed",
      error:
        "Payment record not found"
    };
  }

  if (!PLANS[payment.plan]) {
    return {
      success: false,
      payment_status: "failed",
      error:
        "Invalid CyberFX plan"
    };
  }

  const selectedPlan =
    PLANS[payment.plan];

  if (
    Number(transaction.amount) !==
    Number(selectedPlan.amount)
  ) {
    return {
      success: false,
      payment_status:
        "amount_mismatch",
      error:
        "Payment amount does not match the selected plan"
    };
  }

  const email =
    String(
      transaction.customer?.email ||
      payment.email ||
      ""
    )
      .trim()
      .toLowerCase();

  const user =
    await env.DB.prepare(`
      SELECT id, email
      FROM users
      WHERE email = ?
      LIMIT 1
    `)
      .bind(email)
      .first();

  if (!user) {
    return {
      success: false,
      payment_status: "failed",
      error:
        "User account not found. Register on CyberFX before paying."
    };
  }

  const now =
    new Date();

  const existing =
    await env.DB.prepare(`
      SELECT
        id,
        plan,
        starts_at,
        expires_at,
        status
      FROM subscriptions
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 1
    `)
      .bind(user.id)
      .first();

  // Paid subscription starts immediately unless
  // the user already has a currently active subscription.
  let startDate = now;

  if (
    existing?.expires_at &&
    existing.status === "active"
  ) {
    const expiry =
      new Date(
        existing.expires_at
      );

    if (
      Number.isFinite(
        expiry.getTime()
      ) &&
      expiry > now
    ) {
      startDate =
        expiry;
    }
  }

  const expires =
    addMonths(
      startDate,
      selectedPlan.months
    );

  await env.DB.prepare(`
    UPDATE payments
    SET
      status = ?,
      paid_at = ?
    WHERE reference = ?
  `)
    .bind(
      "success",
      now.toISOString(),
      reference
    )
    .run();

  if (existing?.id) {
    await env.DB.prepare(`
      UPDATE subscriptions
      SET
        plan = ?,
        paystack_reference = ?,
        status = ?,
        starts_at = ?,
        expires_at = ?
      WHERE id = ?
    `)
      .bind(
        payment.plan,
        reference,
        "active",
        startDate.toISOString(),
        expires.toISOString(),
        existing.id
      )
      .run();
  } else {
    await env.DB.prepare(`
      INSERT INTO subscriptions (
        user_id,
        plan,
        paystack_reference,
        status,
        starts_at,
        expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .bind(
        user.id,
        payment.plan,
        reference,
        "active",
        startDate.toISOString(),
        expires.toISOString()
      )
      .run();
  }

  return {
    success: true,
    payment_status: "success",
    reference,
    email,
    plan: payment.plan,
    plan_name:
      selectedPlan.name,
    starts_at:
      startDate.toISOString(),
    expires_at:
      expires.toISOString()
  };
}


// ============================================================
// ACTIVE SUBSCRIPTION
// ============================================================

async function getActiveSubscriptionByEmail(
  email,
  env
) {
  if (!env.DB) {
    return null;
  }

  const row =
    await env.DB.prepare(`
      SELECT
        u.email,
        s.plan,
        s.starts_at,
        s.expires_at,
        s.status
      FROM users u
      INNER JOIN subscriptions s
        ON s.user_id = u.id
      WHERE u.email = ?
      ORDER BY s.id DESC
      LIMIT 1
    `)
      .bind(email)
      .first();

  if (!row) {
    return null;
  }

  const expiry =
    new Date(
      row.expires_at
    );

  if (
    row.status !== "active" ||
    !Number.isFinite(
      expiry.getTime()
    ) ||
    expiry <= new Date()
  ) {
    await env.DB.prepare(`
      UPDATE subscriptions
      SET status = ?
      WHERE user_id = (
        SELECT id
        FROM users
        WHERE email = ?
        LIMIT 1
      )
      AND status = 'active'
    `)
      .bind(
        "expired",
        email
      )
      .run();

    return null;
  }

  return {
    email: row.email,
    plan: row.plan,
    plan_name:
      row.plan === "trial"
        ? "21-Day Free Trial"
        : PLANS[row.plan]?.name ||
          row.plan,
    starts_at:
      row.starts_at,
    expires_at:
      row.expires_at
  };
}


// ============================================================
// TELEGRAM AUTH
// ============================================================

async function isTelegramAuthorized(
  telegramId,
  env
) {
  const id =
    String(telegramId);

  if (
    id === OWNER_TELEGRAM_ID
  ) {
    return {
      authorized: true,
      owner: true
    };
  }

  if (!env.DB) {
    return {
      authorized: false,
      owner: false
    };
  }

  const link =
    await env.DB.prepare(`
      SELECT
        tl.user_id,
        u.email
      FROM telegram_links tl
      INNER JOIN users u
        ON u.id = tl.user_id
      WHERE tl.telegram_id = ?
      LIMIT 1
    `)
      .bind(id)
      .first();

  if (!link) {
    return {
      authorized: false,
      owner: false
    };
  }

  const subscription =
    await getActiveSubscriptionByEmail(
      link.email,
      env
    );

  if (!subscription) {
    return {
      authorized: false,
      owner: false
    };
  }

  return {
    authorized: true,
    owner: false,
    email: link.email,
    plan:
      subscription.plan
  };
}


// ============================================================
// AUTHORIZED TELEGRAM USERS
// ============================================================

async function getAuthorizedTelegramIds(
  env
) {
  const ids =
    new Set();

  ids.add(
    OWNER_TELEGRAM_ID
  );

  if (!env.DB) {
    return [
      ...ids
    ];
  }

  const rows =
    await env.DB.prepare(`
      SELECT DISTINCT
        tl.telegram_id
      FROM telegram_links tl
      INNER JOIN users u
        ON u.id = tl.user_id
      INNER JOIN subscriptions s
        ON s.user_id = u.id
      WHERE
        s.status = 'active'
        AND datetime(s.expires_at) > datetime('now')
    `)
      .all();

  for (
    const row of
    rows.results || []
  ) {
    if (
      row.telegram_id
    ) {
      ids.add(
        String(
          row.telegram_id
        )
      );
    }
  }

  return [
    ...ids
  ];
}


// ============================================================
// TELEGRAM HANDLER
// ============================================================

async function handleTelegramMessage(
  message,
  env,
  origin
) {
  const chatId =
    message.chat?.id;

  const telegramId =
    message.from?.id ||
    chatId;

  const text =
    String(
      message.text || ""
    )
      .trim()
      .toLowerCase();

  if (!chatId) {
    return;
  }

  // ========================================================
  // START
  // ========================================================

  if (text === "/start") {
    await registerCyberFXTelegramCommands(env.TELEGRAM_BOT_TOKEN);
    const access =
      await isTelegramAuthorized(
        telegramId,
        env
      );

    if (access.owner) {
      await sendTelegramMessage(
        chatId,
        `👑 CYBERFX OWNER

Owner access is active.

📡 Automatic scanning is enabled.

Use /signals for a manual scan.`,
        env.TELEGRAM_BOT_TOKEN
      );

      return;
    }

    if (access.authorized) {
      await sendTelegramMessage(
        chatId,
        `🔥 CYBERFX

Your access is active.

📡 Automatic signals are enabled.

Use /signals for the current scan.`,
        env.TELEGRAM_BOT_TOKEN
      );

      return;
    }

    await sendTelegramMessage(
      chatId,
      `🔒 CYBERFX

Access denied.

You need an active CyberFX trial or paid subscription linked to this Telegram account.

Subscribe/register:

${WEBSITE_URL}`,
      env.TELEGRAM_BOT_TOKEN
    );

    return;
  }

  // ========================================================
  // NEWS CENTER — permanent command, available to all users
  // ========================================================
  if (text === "/news" || text.startsWith("/news@")) {
    await sendTelegramMessageWithMarkup(
      chatId,
      `🌍 WELCOME TO THE CYBERFX NEWS CENTER!

Stay informed. Stay prepared. Stay ahead of the market.

Choose what you want to view below. You can return here any time with /news, including to catch up on available updates after joining.

🥇 XAUUSD | ₿ BTCUSD

God Over Man`,
      { inline_keyboard: [
        [{ text: "📅 Economic Calendar", callback_data: "news_calendar" }],
        [{ text: "🇺🇸 Forex News", callback_data: "news_forex" }, { text: "₿ Crypto News", callback_data: "news_crypto" }],
        [{ text: "🚨 High-Impact News", callback_data: "news_high" }],
        [{ text: "📊 News Results", callback_data: "news_results" }],
        [{ text: "🗂️ Recent News / Archive", callback_data: "news_archive" }],
        [{ text: "🔄 Refresh News", callback_data: "news_calendar" }]
      ]},
      env.TELEGRAM_BOT_TOKEN
    );
    return;
  }

  // ========================================================
  // SUBSCRIBE
  // ========================================================

  if (text === "/subscribe") {
    await sendTelegramMessage(
      chatId,
      `🔥 CYBERFX

Register and subscribe here:

${WEBSITE_URL}

New users receive a 21-day free trial.

After the trial expires, access automatically stops unless a paid subscription is active.`,
      env.TELEGRAM_BOT_TOKEN
    );

    return;
  }

  // ========================================================
  // SIGNAL
  // ========================================================

  if (
    text === "/signal" ||
    text === "/signals"
  ) {
    const access =
      await isTelegramAuthorized(
        telegramId,
        env
      );

    if (!access.authorized) {
      await sendTelegramMessage(
        chatId,
        `🔒 CYBERFX

Your access is inactive.

Register or subscribe here:

${WEBSITE_URL}`,
        env.TELEGRAM_BOT_TOKEN
      );

      return;
    }

    try {
      const signals =
        await generateSignals();

      const active =
        signals.filter(
          signal =>
            signal.status !==
            "NO SIGNAL"
        );

      if (!active.length) {
        await sendTelegramMessage(
          chatId,
          `CYBERFX ALCHEMIST

No confirmed Alchemist setup is available right now. Signals are generated only during the London Killzone (2:00–5:00 AM New York time) and New York AM Killzone (8:30–11:00 AM New York time).`,
          env.TELEGRAM_BOT_TOKEN
        );

        return;
      }

      for (
        const signal of active
      ) {
        await sendTelegramMessage(
          chatId,
          formatTelegramSignal(
            signal
          ),
          env.TELEGRAM_BOT_TOKEN
        );
      }

    } catch (error) {
      console.error(
        "Telegram signal error:",
        error
      );

      await sendTelegramMessage(
        chatId,
        `CYBERFX

Signal engine temporarily unavailable.`,
        env.TELEGRAM_BOT_TOKEN
      );
    }

    return;
  }

  // ========================================================
  // HELP
  // ========================================================

  if (text === "/help") {
    await sendTelegramMessage(
      chatId,
      `🔥 CYBERFX

Commands:

/start — Check access
/signals — Manual signal scan
/subscribe — Subscription/trial
/help — Show commands

📡 Active users receive new signals automatically.`,
      env.TELEGRAM_BOT_TOKEN
    );
  }
}


// ============================================================
// NEWS CENTER CALLBACKS + RECENT NEWS ARCHIVE
// ============================================================
async function handleTelegramCallback(query, env) {
  const chatId = query.message?.chat?.id;
  const data = String(query.data || "");
  if (!chatId) return;
  await answerTelegramCallback(query.id, env.TELEGRAM_BOT_TOKEN);

  if (data === "news_home") {
    await sendTelegramMessageWithMarkup(chatId,
      `🌍 CYBERFX NEWS CENTER\n\nChoose a category to view the latest available information and recent stored updates.\n\nGod Over Man`,
      { inline_keyboard: [
        [{ text: "📅 Economic Calendar", callback_data: "news_calendar" }],
        [{ text: "🇺🇸 Forex News", callback_data: "news_forex" }, { text: "₿ Crypto News", callback_data: "news_crypto" }],
        [{ text: "🚨 High-Impact News", callback_data: "news_high" }],
        [{ text: "📊 News Results", callback_data: "news_results" }],
        [{ text: "🗂️ Recent News / Archive", callback_data: "news_archive" }]
      ]}, env.TELEGRAM_BOT_TOKEN);
    return;
  }

  if (["news_calendar", "news_forex", "news_high", "news_results", "news_archive"].includes(data)) {
    try {
      const events = await fetchCyberFXEconomicCalendar();
      await storeNewsArchive(env, events);
      const now = Date.now();
      let chosen = events;
      let heading = "📅 CYBERFX ECONOMIC CALENDAR";
      if (data === "news_forex") {
        heading = "🇺🇸 CYBERFX FOREX NEWS / ECONOMIC DRIVERS";
        chosen = events;
      } else if (data === "news_high") {
        heading = "🚨 HIGH-IMPACT NEWS";
        chosen = events.filter(e => String(e.impact || "high").toLowerCase().includes("high"));
      } else if (data === "news_results") {
        heading = "📊 RELEASED NEWS RESULTS";
        chosen = events.filter(e => (e.actual !== null && e.actual !== undefined && e.actual !== "") || String(e.status || "").toLowerCase().includes("release"));
      } else if (data === "news_archive") {
        heading = "🗂️ RECENT NEWS ARCHIVE";
        chosen = await readNewsArchive(env);
      }
      const items = chosen.filter(e => {
        if (data === "news_archive" || data === "news_results") return true;
        const at = getEconomicEventTime(e);
        return !at || at.getTime() >= now - 24 * 60 * 60 * 1000;
      }).slice(0, 10);
      let body = `${heading}\n\n`;
      if (!items.length) {
        body += data === "news_results"
          ? "No released figures are available in the current calendar response yet. Check again after the release.\n"
          : data === "news_archive"
            ? "No saved news updates are available yet. The archive will populate as the bot retrieves calendar updates.\n"
            : "No matching events were returned by the calendar provider. Please refresh later.\n";
      } else {
        body += items.map((e, i) => {
          const name = e.series_name || e.title || e.name || "US economic release";
          const at = getEconomicEventTime(e);
          const time = at ? new Intl.DateTimeFormat("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short", hour12: true }).format(at) + " WAT" : (e.time_local || "Time not confirmed");
          return `${i + 1}. ${name}\n🕒 ${time}\nImpact: ${e.impact || "Not provided"}\nPrevious: ${formatNewsNumber(e.prior ?? e.previous)} | Forecast: ${formatNewsNumber(e.consensus ?? e.forecast)} | Actual: ${formatNewsNumber(e.actual)}${e.url ? `\nSource: ${e.url}` : ""}`;
        }).join("\n\n");
      }
      body += `\n\nCalendar source: ${CYBERFX_NEWS_SOURCE}\n\nFigures may be revised by the provider. Verify high-impact data against the official release.\n\nGod Over Man`;
      await sendTelegramMessageWithMarkup(chatId, body, { inline_keyboard: [[{ text: "🔙 News Center", callback_data: "news_home" }], [{ text: "🔄 Refresh", callback_data: data }]] }, env.TELEGRAM_BOT_TOKEN);
    } catch (error) {
      console.error("News Center callback error:", error?.message || error);
      await sendTelegramMessageWithMarkup(chatId,
        `⚠️ The News Center could not retrieve fresh calendar data right now. Please try again shortly.\n\nGod Over Man`,
        { inline_keyboard: [[{ text: "🔙 News Center", callback_data: "news_home" }, { text: "🔄 Retry", callback_data: data }]] }, env.TELEGRAM_BOT_TOKEN);
    }
    return;
  }

  if (data === "news_crypto") {
    await sendTelegramMessageWithMarkup(chatId,
      `₿ CYBERFX CRYPTO NEWS\n\nLive crypto headlines are not configured with a verified news-feed provider in this Worker yet, so this section will not invent headlines. You can check current Bitcoin market coverage here:\nhttps://www.coindesk.com/\nhttps://cointelegraph.com/\n\nWhen a verified feed is configured, this button can display headlines and timestamps directly in Telegram.\n\nGod Over Man`,
      { inline_keyboard: [[{ text: "🔙 News Center", callback_data: "news_home" }]] }, env.TELEGRAM_BOT_TOKEN);
  }
}

async function storeNewsArchive(env, events) {
  if (!env.DB || !Array.isArray(events)) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS news_archive (
    event_key TEXT PRIMARY KEY,
    event_json TEXT NOT NULL,
    captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  for (const event of events.slice(0, 100)) {
    const key = String(event.id || event.series_code || event.title || event.name || getEconomicEventTime(event)?.toISOString() || "").slice(0, 250);
    if (!key) continue;
    await env.DB.prepare(`INSERT INTO news_archive (event_key, event_json, captured_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(event_key) DO UPDATE SET event_json = excluded.event_json, captured_at = CURRENT_TIMESTAMP`)
      .bind(key, JSON.stringify(event)).run();
  }
}

async function readNewsArchive(env) {
  if (!env.DB) return [];
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS news_archive (
    event_key TEXT PRIMARY KEY,
    event_json TEXT NOT NULL,
    captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  const result = await env.DB.prepare(`SELECT event_json FROM news_archive ORDER BY captured_at DESC LIMIT 10`).all();
  return (result.results || []).flatMap(row => { try { return [JSON.parse(row.event_json)]; } catch { return []; } });
}

async function registerCyberFXTelegramCommands(token) {
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands: [
        { command: "start", description: "Open CyberFX and check access" },
        { command: "help", description: "View available commands" },
        { command: "signals", description: "Run a manual signal scan" },
        { command: "news", description: "Open the CyberFX News Center" },
        { command: "subscribe", description: "Register or manage trial access" }
      ] })
    });
  } catch (error) {
    console.error("Unable to register Telegram commands:", error?.message || error);
  }
}

async function answerTelegramCallback(callbackId, token) {
  if (!token || !callbackId) return;
  try { await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId })
  }); } catch (error) { console.error("Telegram callback acknowledgement failed", error?.message || error); }
}

// ============================================================
// AUTOMATIC SCAN
// ============================================================

async function runAutomaticScan(env) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN is missing");
    return;
  }

  try {
    // Cron is configured for every 15 minutes. This extra guard ensures a
    // given closed M15 candle is processed only once, even if Cloudflare
    // retries or the schedule is accidentally duplicated.
    const scanGate = await claimClosedM15Scan(env);
    if (!scanGate.shouldRun) {
      console.log(`CYBERFX: M15 candle ${scanGate.key || "not ready"} already scanned or unavailable; skipping duplicate run.`);
      return;
    }

    const recipients = await getAuthorizedTelegramIds(env);
    await sendSessionOpeningAlerts(env, recipients);
    await runEconomicNewsAlerts(env, recipients);

    const signals = await generateSignals();
    const active = signals.filter(signal => signal.status === "CONFIRMED");
    if (!active.length) {
      console.log("CYBERFX: no confirmed XAUUSD setups in this scan.");
      return;
    }

    for (const signal of active) {
      const signature = createSignalSignature(signal);
      if (await wasSignalSent(signature, env)) continue;

      let delivered = false;
      for (const chatId of recipients) {
        const result = await sendTelegramMessage(chatId, formatTelegramSignal(signal), env.TELEGRAM_BOT_TOKEN);
        if (result?.ok) delivered = true;
      }
      if (delivered) await markSignalSent(signature, signal, env);
    }
  } catch (error) {
    console.error("Automatic scan error:", error);
  }
}


// Claim one scheduled scan per newly closed M15 candle. If D1 is not bound,
// scanning continues but duplicate protection cannot be guaranteed.
async function claimClosedM15Scan(env) {
  const data = await getCandles("XAUUSD", "15m");
  if (!data || data.status !== "success" || !Array.isArray(data.candles)) {
    console.error("CYBERFX: cannot verify the latest closed M15 candle; scheduled scan skipped.");
    return { shouldRun: false, key: null };
  }

  const closed = normalizeCandles(data.candles).filter(c => !c.isOpen && c.time);
  const latest = closed[closed.length - 1];
  if (!latest) {
    console.error("CYBERFX: no fully closed M15 candle is available; scheduled scan skipped.");
    return { shouldRun: false, key: null };
  }

  const key = `xauusd-m15:${new Date(latest.time).getTime()}`;
  if (!env.DB) {
    console.warn("CYBERFX: D1 binding is missing; continuing M15 scan without duplicate protection.");
    return { shouldRun: true, key };
  }

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS scan_runs (
    scan_key TEXT PRIMARY KEY,
    scanned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();

  const existing = await env.DB.prepare(
    "SELECT scan_key FROM scan_runs WHERE scan_key = ? LIMIT 1"
  ).bind(key).first();
  if (existing) return { shouldRun: false, key };

  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO scan_runs (scan_key) VALUES (?)"
  ).bind(key).run();
  if (Number(claim?.meta?.changes || 0) < 1) return { shouldRun: false, key };

  await env.DB.prepare(`DELETE FROM scan_runs WHERE scanned_at < datetime('now', '-14 days')`).run();
  return { shouldRun: true, key };
}

async function sendSessionOpeningAlerts(env, recipients) {
  const alert = getSessionAlert(new Date());
  if (!alert) return;

  // Use D1 to prevent duplicate alerts during repeated cron executions.
  if (!env.DB) {
    console.error("Session alert skipped: D1 is required for duplicate prevention.");
    return;
  }

  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS session_alerts (
        alert_key TEXT PRIMARY KEY,
        session_name TEXT NOT NULL,
        sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    const alreadySent = await env.DB.prepare(
      "SELECT alert_key FROM session_alerts WHERE alert_key = ? LIMIT 1"
    ).bind(alert.key).first();
    if (alreadySent) return;

    let delivered = false;
    for (const chatId of recipients) {
      const result = await sendTelegramMessage(chatId, alert.text, env.TELEGRAM_BOT_TOKEN);
      if (result?.ok) delivered = true;
    }

    if (delivered) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO session_alerts (alert_key, session_name) VALUES (?, ?)"
      ).bind(alert.key, alert.name).run();
      await env.DB.prepare(`
        DELETE FROM session_alerts
        WHERE alert_key NOT IN (
          SELECT alert_key FROM session_alerts ORDER BY sent_at DESC LIMIT 120
        )
      `).run();
    }
  } catch (error) {
    console.error("Session notification error:", error);
  }
}


// ============================================================
// ECONOMIC NEWS ALERTS (US HIGH-IMPACT EVENTS)
// Source: Finance Calendar API; attribution included in messages.
// ============================================================

const CYBERFX_NEWS_SOURCE = "https://www.financecalendar.com";

async function fetchCyberFXEconomicCalendar() {
  const now = new Date();
  const from = getDateInTimeZone(now, "UTC");
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const to = getDateInTimeZone(end, "UTC");
  const url = new URL("https://www.financecalendar.com/wp-json/fc/v1/calendar");
  url.searchParams.set("country", "US");
  url.searchParams.set("impact", "high");
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("tz", "Africa/Lagos");
  url.searchParams.set("limit", "100");

  const response = await fetch(url.toString(), {
    headers: { "accept": "application/json" },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Economic calendar returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.events)) throw new Error("Unexpected economic calendar response");
  return payload.events;
}

function getEconomicEventTime(event) {
  const value = event.release_at_utc || event.time_utc || event.time_local || event.date;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getDateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatEconomicEventForApi(event) {
  return {
    id: event.id || event.series_code || event.title || event.name,
    name: event.series_name || event.title || event.name || "US economic release",
    impact: event.impact || "high",
    time_nigeria: event.time_local || null,
    time_new_york: event.time_et || null,
    release_at: event.release_at_utc || event.time_utc || null,
    previous: event.prior ?? null,
    forecast: event.consensus ?? null,
    actual: event.actual ?? null,
    status: event.status || "scheduled",
    official_source: event.source_url || null,
    calendar_source: event.url || CYBERFX_NEWS_SOURCE
  };
}

function formatNewsNumber(value) {
  return value === null || value === undefined || value === "" ? "Not available yet" : String(value);
}

function formatEconomicEventReport(event, mode) {
  const name = event.series_name || event.title || event.name || "US economic release";
  const at = getEconomicEventTime(event);
  const nigeriaTime = at ? new Intl.DateTimeFormat("en-NG", {
    timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short", hour12: true
  }).format(at) : (event.time_local || "Time not confirmed");
  const previous = event.prior ?? event.previous;
  const forecast = event.consensus ?? event.forecast;
  const actual = event.actual;
  const header = mode === "pre" ? "🚨 CYBERFX HIGH-IMPACT NEWS WARNING" : "📊 CYBERFX ECONOMIC NEWS UPDATE";
  let text = `${header}

🇺🇸 ${name}
🕒 Nigeria time: ${nigeriaTime}

`;
  text += `📌 Previous: ${formatNewsNumber(previous)}
🔮 Forecast: ${formatNewsNumber(forecast)}
`;
  if (mode === "actual") {
    text += `✅ Actual: ${formatNewsNumber(actual)}
`;
    if (actual !== null && actual !== undefined && actual !== "" && forecast !== null && forecast !== undefined && forecast !== "") {
      text += `📉 Actual vs forecast: ${String(actual) === String(forecast) ? "In line by displayed value" : "Compare the actual figure with the forecast; units and revisions matter"}
`;
    }
  } else {
    text += `⏳ Actual: Not released yet
`;
  }
  text += `
🥇 XAUUSD (Gold)  |  ₿ BTCUSD (Bitcoin)
`;
  text += mode === "pre"
    ? `⚠️ Volatility, spreads and slippage may rise around the release. Avoid blind entries and wait for confirmed Alchemist price action.\n`
    : `⚠️ The data does not determine market direction by itself. Wait for price-action confirmation; do not assume a BUY or SELL outcome.\n`;
  if (event.source_url) text += `
Official source: ${event.source_url}
`;
  text += `Calendar data: ${CYBERFX_NEWS_SOURCE}

God Over Man`;
  return text;
}

async function runEconomicNewsAlerts(env, recipients) {
  if (!env.DB || !recipients.length) {
    if (!env.DB) console.error("Economic news alerts require D1 for duplicate prevention.");
    return;
  }
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS news_alerts (
      alert_key TEXT PRIMARY KEY,
      sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`).run();

    const events = await fetchCyberFXEconomicCalendar();
    await storeNewsArchive(env, events);
    const now = new Date();
    const todayWAT = getDateInTimeZone(now, "Africa/Lagos");
    const todayEvents = events.filter(event => {
      const at = getEconomicEventTime(event);
      return at && getDateInTimeZone(at, "Africa/Lagos") === todayWAT;
    });

    // One complete daily briefing, including previous/forecast/actual values.
    const dailyKey = `news-briefing:${todayWAT}`;
    const dailySent = await env.DB.prepare("SELECT alert_key FROM news_alerts WHERE alert_key = ? LIMIT 1").bind(dailyKey).first();
    if (!dailySent) {
      let message = `🗓️ CYBERFX DAILY ECONOMIC NEWS BRIEFING

🇺🇸 US high-impact events for ${todayWAT} (Nigeria time)

`;
      if (!todayEvents.length) {
        message += `No high-impact US release is listed for today in the calendar currently. This is not a guarantee that markets will be quiet.\n\n`;
      } else {
        message += todayEvents.slice(0, 12).map((event, index) => {
          const name = event.series_name || event.title || event.name || "US economic release";
          const at = getEconomicEventTime(event);
          const time = at ? new Intl.DateTimeFormat("en-NG", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hour12: true }).format(at) : "Time TBC";
          return `${index + 1}. ${name}
🕒 ${time} WAT
Previous: ${formatNewsNumber(event.prior)} | Forecast: ${formatNewsNumber(event.consensus)} | Actual: ${formatNewsNumber(event.actual)}`;
        }).join("\n\n");
        message += "\n\n";
      }
      message += `🥇 XAUUSD | ₿ BTCUSD\n⚠️ Expect possible volatility around releases. Wait for confirmation and manage risk.\n\nCalendar data: ${CYBERFX_NEWS_SOURCE}\n\nGod Over Man`;
      let delivered = false;
      for (const chatId of recipients) {
        const result = await sendTelegramMessage(chatId, message, env.TELEGRAM_BOT_TOKEN);
        if (result?.ok) delivered = true;
      }
      if (delivered) await env.DB.prepare("INSERT OR IGNORE INTO news_alerts (alert_key) VALUES (?)").bind(dailyKey).run();
    }

    for (const event of events) {
      const at = getEconomicEventTime(event);
      if (!at) continue;
      const deltaMinutes = (at.getTime() - now.getTime()) / 60000;
      const eventId = String(event.id || event.series_code || event.title || event.name || `${at.toISOString()}`);
      let alertKey = null;
      let message = null;

      if (deltaMinutes >= 0 && deltaMinutes <= 30) {
        alertKey = `news-pre:${eventId}`;
        message = formatEconomicEventReport(event, "pre");
      } else if ((event.status === "released" || (event.actual !== null && event.actual !== undefined && event.actual !== "")) && deltaMinutes < 0 && deltaMinutes >= -180) {
        alertKey = `news-actual:${eventId}`;
        message = formatEconomicEventReport(event, "actual");
      }
      if (!alertKey) continue;
      const sent = await env.DB.prepare("SELECT alert_key FROM news_alerts WHERE alert_key = ? LIMIT 1").bind(alertKey).first();
      if (sent) continue;
      let delivered = false;
      for (const chatId of recipients) {
        const result = await sendTelegramMessage(chatId, message, env.TELEGRAM_BOT_TOKEN);
        if (result?.ok) delivered = true;
      }
      if (delivered) await env.DB.prepare("INSERT OR IGNORE INTO news_alerts (alert_key) VALUES (?)").bind(alertKey).run();
    }

    await env.DB.prepare(`DELETE FROM news_alerts WHERE sent_at < datetime('now', '-45 days')`).run();
  } catch (error) {
    console.error("CyberFX economic news alert error:", error?.message || error);
  }
}

// ============================================================
// SIGNAL SIGNATURE
// ============================================================

function createSignalSignature(
  signal
) {
  return [
    signal.symbol ||
      signal.instrument,

    signal.status,

    signal.direction,

    signal.entryTFRaw ||
      signal.entryTF,

    signal.signalTime ||
      "unknown"
  ]
    .map(
      value =>
        String(value)
          .replace(
            /\s+/g,
            "_"
          )
    )
    .join("|");
}


// ============================================================
// SENT SIGNAL TABLE
// ============================================================

async function ensureSentSignalsTable(
  env
) {
  if (!env.DB) {
    return;
  }

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS sent_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signature TEXT NOT NULL UNIQUE,
      instrument TEXT NOT NULL,
      status TEXT NOT NULL,
      direction TEXT,
      entry_tf TEXT,
      signal_time TEXT,
      sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
    .run();
}


async function wasSignalSent(
  signature,
  env
) {
  if (!env.DB) {
    return false;
  }

  try {
    await ensureSentSignalsTable(
      env
    );

    const row =
      await env.DB.prepare(`
        SELECT id
        FROM sent_signals
        WHERE signature = ?
        LIMIT 1
      `)
        .bind(signature)
        .first();

    return !!row;

  } catch {
    return false;
  }
}


async function markSignalSent(
  signature,
  signal,
  env
) {
  if (!env.DB) {
    return;
  }

  try {
    await ensureSentSignalsTable(
      env
    );

    await env.DB.prepare(`
      INSERT OR IGNORE INTO sent_signals (
        signature,
        instrument,
        status,
        direction,
        entry_tf,
        signal_time
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .bind(
        signature,
        signal.instrument ||
          signal.symbol,
        signal.status,
        signal.direction || "",
        signal.entryTF || "",
        signal.signalTime || ""
      )
      .run();

    await env.DB.prepare(`
      DELETE FROM sent_signals
      WHERE id NOT IN (
        SELECT id
        FROM sent_signals
        ORDER BY id DESC
        LIMIT 500
      )
    `)
      .run();

  } catch (error) {
    console.error(
      "Signal history error:",
      error
    );
  }
}


// ============================================================
// TELEGRAM FORMAT
// ============================================================

function formatTelegramSignal(signal) {
  const orderType = signal.orderType || (signal.direction === "BUY" ? "BUY AT CMP" : "SELL AT CMP");
  const entryLabel = orderType === "BUY AT CMP" || orderType === "SELL AT CMP"
    ? `${orderType}!!`
    : `${orderType}!!`;
  return `🔥 CYBERFX ${signal.direction} SIGNAL — XAUUSD

${entryLabel}

* Entry: ${signal.entry}${orderType.includes("CMP") ? " (Current Market Price)" : ""}
* Stop Loss: ${signal.stopLoss}
* Take Profit: ${signal.takeProfit}
* Risk-to-Reward: 1:8
* Entry Timeframe: ${signal.entryTF}
* Session: ${signal.session}

📌 Trade Management Note: BE when necessary

⚠️ Trade responsibly and manage risk.

GOD OVER MAN.`;
}

// ============================================================
// TELEGRAM API
// ============================================================

async function sendTelegramMessage(
  chatId,
  text,
  token
) {
  if (!token) {
    return null;
  }

  try {
    const response =
      await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: {
            "content-type":
              "application/json"
          },
          body:
            JSON.stringify({
              chat_id:
                String(chatId),
              text
            })
        }
      );

    return await response.json();

  } catch (error) {
    return {
      ok: false,
      error:
        error?.message ||
        String(error)
    };
  }
}


async function sendTelegramMessageWithMarkup(chatId, text, replyMarkup, token) {
  if (!token) return null;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: String(chatId), text, reply_markup: replyMarkup })
    });
    return await response.json();
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

// ============================================================
// HELPERS
// ============================================================

function average(values) {
  if (!values.length) {
    return 0;
  }

  return (
    values.reduce(
      (a, b) => a + b,
      0
    ) /
    values.length
  );
}


function midpoint(a, b) {
  return (a + b) / 2;
}


function priceInside(
  price,
  zone
) {
  if (!zone) {
    return false;
  }

  return (
    price >= zone.low &&
    price <= zone.high
  );
}


function roundPrice(price) {
  if (
    !Number.isFinite(price)
  ) {
    return null;
  }

  return Number(
    price.toFixed(2)
  );
}


function formatTF(tf) {
  const names = {
    "1min": "M1 (1 Minute)",
    "5min": "M5 (5 Minutes)",
    "15min": "M15 (15 Minutes)",
    "30min": "M30 (30 Minutes)",
    "1h": "H1",
    "4h": "H4",
    "1d": "D1"
  };

  return names[tf] || tf;
}


function tfPriority(tf) {
  const priority = {
    "1min": 1,
    "5min": 2,
    "15min": 3,
    "30min": 4
  };

  return priority[tf] || 0;
}


function addMonths(
  date,
  months
) {
  const result =
    new Date(date);

  const originalDay =
    result.getUTCDate();

  result.setUTCDate(1);

  result.setUTCMonth(
    result.getUTCMonth() +
    months
  );

  const lastDay =
    new Date(
      Date.UTC(
        result.getUTCFullYear(),
        result.getUTCMonth() + 1,
        0
      )
    ).getUTCDate();

  result.setUTCDate(
    Math.min(
      originalDay,
      lastDay
    )
  );

  return result;
}


// ============================================================
// JSON
// ============================================================

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "content-type":
          "application/json",
        "cache-control":
          "no-store"
      }
    }
  );
}
