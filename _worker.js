export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================================================
    // HEALTH
    // =========================================================
    if (url.pathname === "/api/health") {
      const biquoteConnected = await checkBiquote();

      return json({
        success: true,
        engine: "CyberFX",
        version: "2.0.0",
        status: "online",
        market_data: "Biquote",
        biquote_connected: biquoteConnected,
        telegram_connected: !!env.TELEGRAM_BOT_TOKEN,
        paystack_connected: !!env.PAYSTACK_SECRET_KEY,
        database_connected: !!env.DB,
        risk_reward: "1:10",
        trial_days: 21
      });
    }

    // =========================================================
    // DIAGNOSTICS
    // =========================================================
    if (url.pathname === "/api/diagnostics") {
      try {
        const startedAt = new Date().toISOString();
        const biquoteConnected = await checkBiquote();
        const catalogResponse = await fetch(
          "https://biquote.io/api/symbols?quotedWithinDays=7"
        );
        const catalogResult = catalogResponse.ok
          ? await catalogResponse.json()
          : [];
        const catalog = Array.isArray(catalogResult)
          ? catalogResult
          : catalogResult.symbols || [];
        const discovered = await discoverSymbols();
        const synthetic = discoverSyntheticSymbols(catalog);

        return json({
          success: true,
          engine: "CyberFX",
          source: "Biquote",
          scanner_ran: true,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          biquote_connected: biquoteConnected,
          main_instruments_configured: MAIN_MARKET_SYMBOLS.length,
          main_instruments_discovered: discovered.length,
          synthetic_targets: Object.keys(SYNTHETIC_ALIASES),
          synthetic_discovered: Object.fromEntries(
            Object.entries(synthetic).map(([k, v]) => [k, v.symbol])
          ),
          normal_market_requests_per_scan: discovered.length * TIMEFRAMES.length,
          synthetic_market_requests_per_scan: Object.keys(synthetic).length,
          total_market_requests_planned:
            discovered.length * TIMEFRAMES.length + Object.keys(synthetic).length,
          risk_reward: "1:10",
          entry_timeframes: ENTRY_TIMEFRAMES.map(formatTF),
          UKOIL_removed: true
        });
      } catch (error) {
        return json({
          success: false,
          engine: "CyberFX",
          error: error?.message || String(error)
        }, 500);
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
          source: "Biquote",
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
          source: "Biquote",
          risk_reward: "1:10",
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
          source: "Biquote",
          risk_reward: "1:10",
          signal_levels: [
            "REJECTION",
            "VALID SETUP",
            "CONFIRMED"
          ],
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
  {
    name: "15min",
    interval: "15m"
  },

  {
    name: "30min",
    interval: "30m"
  },

  {
    name: "1h",
    interval: "1h"
  },

  {
    name: "4h",
    interval: "4h"
  },

  {
    name: "1d",
    interval: "1d"
  }
];

const ENTRY_TIMEFRAMES = [
  "15min",
  "30min",
  "1h"
];

// ============================================================
// CYBERFX SCAN SCOPE
// ============================================================
// Keep the normal market scan small so one Worker invocation
// does not hit Cloudflare's subrequest limit.
const MAIN_MARKET_SYMBOLS = [
  "XAUUSD",
  "BTCUSD",
  "USTEC",
  "USOIL",
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "EURJPY",
  "GBPJPY"
];

// Synthetics are handled separately with lightweight statistics.
const SYNTHETIC_ALIASES = {
  V75: ["V75", "VOLATILITY75", "VOLATILITY 75", "R_75", "R75"],
  V25: ["V25", "VOLATILITY25", "VOLATILITY 25", "R_25", "R25"],
  BOOM1000: ["BOOM1000", "BOOM 1000", "BOOM_1000"],
  STEPINDEX: ["STEPINDEX", "STEP INDEX", "STEP_INDEX", "STP" ]
};

const SYNTHETIC_SCAN_INTERVAL = "1m";
const SYNTHETIC_LOOKBACK = 200;
const BOOM_TICK_WINDOW = 1000;

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
// Biquote HEALTH
// ============================================================

async function checkBiquote() {
  try {
    const response =
      await fetch(
        "https://biquote.io/health"
      );

    return response.ok;
  } catch {
    return false;
  }
}


// ============================================================
// DYNAMIC SYMBOL DISCOVERY
// ============================================================

async function discoverSymbols() {
  const response =
    await fetch(
      "https://biquote.io/api/symbols?quotedWithinDays=7"
    );

  if (!response.ok) {
    throw new Error(
      "Unable to load Biquote symbol catalogue"
    );
  }

  const result = await response.json();
  const symbols =
    Array.isArray(result)
      ? result
      : result.symbols || [];

  const normalized = symbols
    .map(item => ({
      raw: item,
      symbol: String(item.name || item.symbol || "").toUpperCase(),
      type: String(item.type || "").toLowerCase(),
      description: String(item.description || "").toLowerCase()
    }))
    .filter(x => x.symbol);

  const wanted = [];

  // Only the main CyberFX market list is scanned. This prevents the
  // previous 300+ instrument catalogue from creating 1,600+ requests.
  for (const target of MAIN_MARKET_SYMBOLS) {
    const found = normalized.find(x => x.symbol === target);
    if (!found) continue;

    let category = "FOREX";
    if (target === "BTCUSD") category = "CRYPTO";
    if (["XAUUSD", "USOIL"].includes(target)) category = "COMMODITY";
    if (target === "USTEC") category = "INDEX";

    wanted.push({
      symbol: found.symbol,
      name: found.symbol,
      category,
      description: found.raw.description || found.symbol,
      source: found.raw.source || null
    });
  }

  return wanted;
}

function discoverSyntheticSymbols(catalog) {
  const found = {};

  for (const item of catalog) {
    const symbol = String(item.name || item.symbol || "").toUpperCase();
    const description = String(item.description || "").toUpperCase();
    const haystack = `${symbol} ${description}`;

    for (const [kind, aliases] of Object.entries(SYNTHETIC_ALIASES)) {
      if (found[kind]) continue;
      if (aliases.some(alias => haystack.includes(alias))) {
        found[kind] = {
          symbol,
          name: symbol,
          category: "SYNTHETIC",
          syntheticType: kind
        };
      }
    }
  }

  return found;
}


// ============================================================
// CANDLES
// ============================================================

async function getCandles(
  symbol,
  interval,
  limit = 200
) {
  const apiUrl =
    new URL(
      `https://biquote.io/api/${encodeURIComponent(symbol)}/ohlc`
    );

  apiUrl.searchParams.set(
    "interval",
    interval
  );

  apiUrl.searchParams.set(
    "limit",
    String(limit)
  );

  const response =
    await fetch(apiUrl);

  const result =
    await response.json();

  if (
    !response.ok ||
    !Array.isArray(result.bars)
  ) {
    return {
      status: "error",
      symbol,
      interval,
      message:
        result.message ||
        result.error ||
        "Biquote request failed"
    };
  }

  return {
    status: "success",
    symbol,
    interval,
    candles:
      result.bars
  };
}


// ============================================================
// LOAD MARKET
// ============================================================

async function loadAllMarkets(symbols) {
  const data = {};

  // Keep requests controlled.
  // Biquote supports these OHLC intervals directly.
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
  const catalogResponse =
    await fetch(
      "https://biquote.io/api/symbols?quotedWithinDays=7"
    );

  if (!catalogResponse.ok) {
    throw new Error("Unable to load Biquote symbol catalogue");
  }

  const catalogResult = await catalogResponse.json();
  const catalog = Array.isArray(catalogResult)
    ? catalogResult
    : catalogResult.symbols || [];

  const symbols = await discoverSymbols();
  const marketData = await loadAllMarkets(symbols);
  const results = [];

  for (const item of symbols) {
    const market = marketData[item.symbol];
    if (!market) continue;

    const candidates = [];

    for (const entryTF of ENTRY_TIMEFRAMES) {
      const result = analyzeInstrument(item, market, entryTF);
      if (result) candidates.push(result);
    }

    if (candidates.length) {
      candidates.sort((a, b) => {
        const quality = SIGNAL_PRIORITY[b.status] - SIGNAL_PRIORITY[a.status];
        if (quality !== 0) return quality;
        return tfPriority(b.entryTFRaw) - tfPriority(a.entryTFRaw);
      });
      results.push(candidates[0]);
    }
  }

  // Synthetic scan is deliberately separate and uses one lightweight
  // 1-minute request per synthetic instead of 5 requests per symbol.
  const syntheticSymbols = discoverSyntheticSymbols(catalog);

  for (const synthetic of Object.values(syntheticSymbols)) {
    try {
      const data = await getCandles(
        synthetic.symbol,
        SYNTHETIC_SCAN_INTERVAL,
        SYNTHETIC_LOOKBACK
      );

      if (data.status !== "success") continue;

      const signal = analyzeSynthetic(synthetic, data.candles);
      if (signal) results.push(signal);
    } catch (error) {
      console.error("Synthetic scan error:", synthetic.symbol, error);
    }
  }

  return results;
}


// ============================================================
// SYNTHETIC STATISTICAL ENGINE
// ============================================================
// This is intentionally NOT treated like Forex/CFD structure logic.
// It uses recent bar statistics only. It does not claim to predict a
// synthetic spike with certainty. A signal is emitted only when the
// statistical conditions are present.

function analyzeSynthetic(item, values) {
  const candles = normalizeCandles(values);
  if (candles.length < 60) return null;

  const current = candles[candles.length - 1];
  const recent = candles.slice(-50);
  const ranges = recent.map(c => c.high - c.low).filter(x => x > 0);
  const avgRange = average(ranges);
  if (!avgRange) return null;

  const directionStats = syntheticDirectionStats(recent);
  const rejection = detectRejection(candles, detectStructure(candles));
  const volatilityRatio = (current.high - current.low) / avgRange;

  if (item.syntheticType === "BOOM1000") {
    const tickStats = calculateTickWindowStats(candles, BOOM_TICK_WINDOW);
    if (!tickStats.valid) return null;

    // Boom 1000: statistical setup around the 1,000-tick window.
    // We require evidence from recent ranges and tick activity; we do
    // not assume that a spike must occur at an exact tick.
    if (tickStats.progress < 0.75 || volatilityRatio < 0.8) return null;

    const bearish = rejection?.direction === "bearish" || directionStats.bearish > directionStats.bullish;
    const direction = bearish ? "SELL" : "BUY";
    return buildSyntheticStatSignal(item, current, direction, "1M", {
      model: "1000-tick statistical window",
      tickWindow: tickStats
    });
  }

  if (item.syntheticType === "V75" || item.syntheticType === "V25") {
    // Volatility 75/25: use range expansion/contraction statistics.
    // Avoid a signal when the current bar is abnormally thin or chaotic.
    if (volatilityRatio < 0.65 || volatilityRatio > 2.5) return null;

    const direction =
      rejection?.direction === "bullish"
        ? "BUY"
        : rejection?.direction === "bearish"
          ? "SELL"
          : directionStats.bullish >= directionStats.bearish
            ? "BUY"
            : "SELL";

    const score =
      (rejection ? 2 : 0) +
      (volatilityRatio >= 0.9 && volatilityRatio <= 1.8 ? 2 : 0) +
      (directionStats.bullish !== directionStats.bearish ? 1 : 0);

    if (score < 3) return null;

    return buildSyntheticStatSignal(item, current, direction, "1M", {
      model: item.syntheticType === "V75" ? "Volatility 75 statistics" : "Volatility 25 statistics",
      volatilityRatio: Number(volatilityRatio.toFixed(3)),
      score
    });
  }

  if (item.syntheticType === "STEPINDEX") {
    const consistency = directionStats.consistency;
    if (consistency < 0.55 || volatilityRatio < 0.50 || volatilityRatio > 2.0) return null;

    const direction =
      directionStats.bullish > directionStats.bearish ? "BUY" : "SELL";

    return buildSyntheticStatSignal(item, current, direction, "1M", {
      model: "Step Index statistical consistency",
      consistency: Number(consistency.toFixed(3)),
      volatilityRatio: Number(volatilityRatio.toFixed(3))
    });
  }

  return null;
}

function syntheticDirectionStats(candles) {
  let bullish = 0;
  let bearish = 0;
  let consistent = 0;

  for (const candle of candles) {
    if (candle.close > candle.open) bullish++;
    if (candle.close < candle.open) bearish++;
  }

  const total = bullish + bearish;
  const consistency = total ? Math.max(bullish, bearish) / total : 0;

  if (total >= 3) {
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1];
      const cur = candles[i];
      if (
        (cur.close > cur.open && prev.close > prev.open) ||
        (cur.close < cur.open && prev.close < prev.open)
      ) {
        consistent++;
      }
    }
  }

  return { bullish, bearish, consistency };
}

function calculateTickWindowStats(candles, targetTicks) {
  const tickVolumes = candles
    .map(c => Number(c.tickVolume || c.volume || 0))
    .filter(x => Number.isFinite(x) && x > 0);

  if (!tickVolumes.length) {
    return { valid: false, reason: "No tick-volume data" };
  }

  let accumulated = 0;
  for (let i = tickVolumes.length - 1; i >= 0; i--) {
    accumulated += tickVolumes[i];
    if (accumulated >= targetTicks) break;
  }

  return {
    valid: accumulated > 0,
    ticksObserved: accumulated,
    targetTicks,
    progress: Math.min(accumulated / targetTicks, 1)
  };
}

function buildSyntheticStatSignal(item, current, direction, entryTF, stats) {
  const range = current.high - current.low;
  if (!range || !Number.isFinite(range)) return null;

  const entry = current.close;
  const stopLoss =
    direction === "BUY"
      ? current.low - range * 0.25
      : current.high + range * 0.25;

  const risk =
    direction === "BUY"
      ? entry - stopLoss
      : stopLoss - entry;

  if (risk <= 0) return null;

  const takeProfit =
    direction === "BUY"
      ? entry + risk * 10
      : entry - risk * 10;

  return {
    instrument: item.name || item.symbol,
    symbol: item.symbol,
    category: "SYNTHETIC",
    syntheticType: item.syntheticType,
    direction,
    orderType: direction === "BUY" ? "BUY LIMIT" : "SELL LIMIT",
    entryTF,
    entryTFRaw: "1min",
    entry: roundPrice(entry),
    stopLoss: roundPrice(stopLoss),
    takeProfit: roundPrice(takeProfit),
    riskReward: "1:10",
    status: "VALID SETUP",
    label: direction === "BUY"
      ? "CYBERFX VALID BUY SETUP"
      : "CYBERFX VALID SELL SETUP",
    components: ["Synthetic Statistics"],
    signalTime: current.time,
    session: getTradingSession(current.time).name,
    message: "Statistical synthetic setup; not a guaranteed spike prediction.",
    internal: stats
  };
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
        ? "CYBERFX A+ BUY"
        : "CYBERFX A+ SELL",

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
// REJECTION SIGNAL OUTPUT
// ============================================================

function buildRejectionSignal(
  item,
  entryTF,
  rejection,
  htfBias,
  current
) {
  if (!item || !rejection || !current) return null;

  const direction =
    rejection.direction === "bullish" ? "BUY" : "SELL";
  const level = Number(rejection.level);
  const price = Number(current.close);

  if (!Number.isFinite(level) || !Number.isFinite(price)) {
    return null;
  }

  return {
    instrument: item.name || item.symbol,
    symbol: item.symbol,
    category: item.category,
    direction,
    orderType: direction === "BUY" ? "BUY REJECTION" : "SELL REJECTION",
    entryTF: formatTF(entryTF),
    entryTFRaw: entryTF,
    rejectionLevel: roundPrice(level),
    price: roundPrice(price),
    status: "REJECTION",
    label: direction === "BUY"
      ? "CYBERFX BUY REJECTION"
      : "CYBERFX SELL REJECTION",
    session: getTradingSession(current.time).name,
    signalTime: current.time,
    message: rejection.reason || (
      direction === "BUY"
        ? "Price rejected the level and closed back above it."
        : "Price rejected the level and closed back below it."
    ),
    internal: {
      htfBias,
      rejectionType: rejection.type,
      rejectionReason: rejection.reason,
      rejectionLevel: level,
      signalCandleTime: current.time
    }
  };
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
        ? "CYBERFX VALID BUY SETUP"
        : "CYBERFX VALID SELL SETUP",

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
// TRADING SESSIONS
// UTC
// ============================================================

function getTradingSession(
  time
) {
  const date =
    new Date(time);

  const hour =
    date.getUTCHours();

  if (
    hour >= 21 ||
    hour < 6
  ) {
    return {
      name: "Sydney"
    };
  }

  if (
    hour >= 0 &&
    hour < 9
  ) {
    return {
      name: "Asia"
    };
  }

  if (
    hour >= 7 &&
    hour < 16
  ) {
    return {
      name: "London"
    };
  }

  if (
    hour >= 12 &&
    hour < 21
  ) {
    return {
      name: "New York"
    };
  }

  return {
    name: "Global"
  };
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
    const access =
      await isTelegramAuthorized(
        telegramId,
        env
      );

    if (access.owner) {
      await sendTelegramMessage(
        chatId,
        `CYBERFX OWNER

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
        `CYBERFX

Your access is active.

📡 Automatic signals are enabled.

Use /signals for the current scan.`,
        env.TELEGRAM_BOT_TOKEN
      );

      return;
    }

    await sendTelegramMessage(
      chatId,
      `CYBERFX

Access denied.

You need an active CyberFX trial or paid subscription linked to this Telegram account.

Subscribe/register:

${WEBSITE_URL}`,
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
      `CYBERFX

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
        `CYBERFX

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
          `CYBERFX

No active rejection, valid setup, or confirmed setup at the moment.`,
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
      `CYBERFX

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
// AUTOMATIC SCAN
// ============================================================

async function runAutomaticScan(
  env
) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error(
      "TELEGRAM_BOT_TOKEN is missing"
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
      console.log(
        "CYBERFX: No active signals."
      );

      return;
    }

    const recipients =
      await getAuthorizedTelegramIds(
        env
      );

    for (
      const signal of active
    ) {
      const signature =
        createSignalSignature(
          signal
        );

      if (
        await wasSignalSent(
          signature,
          env
        )
      ) {
        continue;
      }

      let delivered = false;

      for (
        const chatId of recipients
      ) {
        const result =
          await sendTelegramMessage(
            chatId,
            formatTelegramSignal(
              signal
            ),
            env.TELEGRAM_BOT_TOKEN
          );

        if (result?.ok) {
          delivered = true;
        }
      }

      if (delivered) {
        await markSignalSent(
          signature,
          signal,
          env
        );
      }
    }

  } catch (error) {
    console.error(
      "Automatic scan error:",
      error
    );
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

function formatTelegramSignal(
  signal
) {
  if (
    signal.status ===
    "REJECTION"
  ) {
    return `CYBERFX ${signal.direction} REJECTION

${signal.instrument}

Entry TF: ${signal.entryTF}

Rejection Level: ${signal.rejectionLevel}

Current Price: ${signal.price}

${signal.message}

DEVELOPING OPPORTUNITY`;
  }

  if (
    signal.status ===
    "VALID SETUP"
  ) {
    return `CYBERFX VALID SETUP

${signal.instrument} — ${signal.direction}

Order: ${signal.orderType}

Entry TF: ${signal.entryTF}

Entry: ${signal.entry}

Stop Loss: ${signal.stopLoss}

Take Profit: ${signal.takeProfit}

Risk/Reward: 1:10

Session: ${signal.session}

Setup:
${
  signal.components?.length
    ? signal.components
        .map(
          x => `• ${x}`
        )
        .join("\n")
    : "• Developing structure"
}

VALID SETUP — AWAITING FULL CONFIRMATION`;
  }

  if (
    signal.status ===
    "CONFIRMED"
  ) {
    return `CYBERFX A+ CONFIRMED

${signal.instrument} — ${signal.direction}

Order: ${signal.orderType}

Entry TF: ${signal.entryTF}

Entry: ${signal.entry}

Stop Loss: ${signal.stopLoss}

Take Profit: ${signal.takeProfit}

Risk/Reward: 1:10

Session: ${signal.session}

A+ CONFIRMED

GOD OVER MAN`;
  }

  return `CYBERFX

${signal.instrument}

Status: ${signal.status}`;
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
    "15min": "15M",
    "30min": "30M",
    "1h": "1H",
    "4h": "4H",
    "1d": "1D"
  };

  return names[tf] || tf;
}


function tfPriority(tf) {
  const priority = {
    "4h": 4,
    "1h": 3,
    "30min": 2,
    "15min": 1
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
