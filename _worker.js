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
        version: "2.0",
        status: "online",
        market_data: "Biquote",
        biquote_connected: biquoteConnected,
        telegram_connected: !!env.TELEGRAM_BOT_TOKEN,
        paystack_connected: !!env.PAYSTACK_SECRET_KEY,
        database_connected: !!env.DB,
        risk_reward: "1:10",
        trial_days: TRIAL_DAYS
      });
    }

    // =========================================================
    // START 21-DAY TRIAL
    // =========================================================
    if (
      url.pathname === "/api/trial/start" &&
      request.method === "POST"
    ) {
      try {
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

        if (!email || !email.includes("@")) {
          return json({
            success: false,
            error: "A valid email address is required"
          }, 400);
        }

        const result = await startTrial(email, env);

        return json(result);

      } catch (error) {
        console.error("Trial start error:", error);

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

        const paystackResponse = await fetch(
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

        const result = await paystackResponse.json();

        if (
          !paystackResponse.ok ||
          !result.status ||
          !result.data
        ) {
          console.error(
            "Paystack initialize error:",
            result
          );

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
          error:
            error?.message ||
            String(error)
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
            error:
              "Payment reference is required"
          }, 400);
        }

        const result =
          await verifyPaystackPayment(
            reference,
            env
          );

        return json(result);

      } catch (error) {
        console.error(
          "Payment verification error:",
          error
        );

        return json({
          success: false,
          error:
            error?.message ||
            String(error)
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
              "content-type":
                "text/plain"
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

      } catch (error) {
        console.error(
          "Payment callback error:",
          error
        );

        return Response.redirect(
          `${url.origin}/?payment=failed`,
          302
        );
      }
    }

    // =========================================================
    // SUBSCRIPTION / TRIAL CHECK
    // =========================================================
    if (
      url.pathname === "/api/subscription" &&
      request.method === "GET"
    ) {
      try {
        if (!env.DB) {
          return json({
            success: false,
            error:
              "D1 database binding DB is missing"
          }, 500);
        }

        const email =
          String(
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

        /*
         * If the account has no subscription,
         * automatically create the 21-day trial.
         */
        await ensureTrialForUser(
          email,
          env
        );

        const subscription =
          await getLatestSubscriptionByEmail(
            email,
            env
          );

        if (!subscription) {
          return json({
            success: true,
            subscribed: false,
            active: false,
            trial_available: true
          });
        }

        const expiry =
          new Date(subscription.expires_at);

        if (
          subscription.status !== "active" ||
          !Number.isFinite(expiry.getTime()) ||
          expiry <= new Date()
        ) {
          await expireUserSubscription(
            subscription.user_id,
            env
          );

          return json({
            success: true,
            subscribed: false,
            active: false,
            expired: true,
            status: "expired"
          });
        }

        const isTrial =
          subscription.plan === "trial";

        return json({
          success: true,
          subscribed: true,
          active: true,
          trial: isTrial,
          plan: subscription.plan,
          plan_name:
            isTrial
              ? "21-Day Free Trial"
              : (
                  PLANS[subscription.plan]?.name ||
                  subscription.plan
                ),
          email:
            subscription.email,
          starts_at:
            subscription.starts_at,
          expires_at:
            subscription.expires_at
        });

      } catch (error) {
        console.error(
          "Subscription check error:",
          error
        );

        return json({
          success: false,
          error:
            error?.message ||
            String(error)
        }, 500);
      }
    }

    // =========================================================
    // MARKET DATA
    // =========================================================
    if (url.pathname === "/api/signals") {
      try {
        const data =
          await loadAllMarkets();

        return json({
          success: true,
          engine: "CyberFX",
          version: "2.0",
          source: "Biquote",
          markets:
            Object.keys(data),
          timeframes:
            TIMEFRAMES.map(
              tf => tf.name
            ),
          sessions:
            Object.keys(SESSIONS),
          data
        });

      } catch (error) {
        console.error(
          "Biquote market data error:",
          error
        );

        return json({
          success: false,
          engine: "CyberFX",
          error:
            error?.message ||
            String(error)
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
          sessions: SESSIONS,
          signals: result
        });

      } catch (error) {
        console.error(
          "Signal engine error:",
          error
        );

        return json({
          success: false,
          engine: "CyberFX",
          error:
            error?.message ||
            String(error)
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
  // AUTOMATIC 15-MINUTE ENGINE
  // =========================================================
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runAutomaticScan(env)
    );
  }
};


// ============================================================
// CYBERFX CONFIGURATION
// ============================================================

const OWNER_TELEGRAM_ID = "8368477940";

const WEBSITE_URL =
  "https://cyberfx-website.cybertradingsignal.workers.dev/";

const TRIAL_DAYS = 21;

const RISK_REWARD = 10;

const CONFIRMED_SCORE = 13;


// ============================================================
// SUBSCRIPTION PLANS
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
  }
];

const ENTRY_TIMEFRAMES = [
  "15min",
  "30min",
  "1h",
  "4h"
];


// ============================================================
// SIGNAL PRIORITY
// ============================================================

const SIGNAL_PRIORITY = {
  "REJECTION": 1,
  "VALID SETUP": 2,
  "CONFIRMED": 3
};


// ============================================================
// TRADING SESSIONS
// UTC WINDOWS
// ============================================================

const SESSIONS = {
  SYDNEY: {
    start: 21,
    end: 6
  },

  ASIA: {
    start: 0,
    end: 9
  },

  LONDON: {
    start: 7,
    end: 16
  },

  NEW_YORK: {
    start: 13,
    end: 22
  }
};


// ============================================================
// BIAS / MARKET CATEGORIES
// ============================================================

const CATEGORY_NAMES = [
  "forex",
  "crypto",
  "index",
  "indices",
  "commodity",
  "commodities",
  "stock",
  "stocks",
  "synthetic",
  "synthetics"
];


// ============================================================
// BIQUOTE HEALTH
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
// BIQUOTE SYMBOL DISCOVERY
// ============================================================

async function discoverSymbols() {
  try {
    const response =
      await fetch(
        "https://biquote.io/api/symbols"
      );

    if (!response.ok) {
      console.error(
        "Biquote symbols request failed:",
        response.status
      );

      return [];
    }

    const result =
      await response.json();

    let raw = [];

    if (Array.isArray(result)) {
      raw = result;
    } else if (
      Array.isArray(result.symbols)
    ) {
      raw = result.symbols;
    } else if (
      Array.isArray(result.data)
    ) {
      raw = result.data;
    } else if (
      Array.isArray(result.results)
    ) {
      raw = result.results;
    }

    return raw
      .map(normalizeSymbolMetadata)
      .filter(Boolean);

  } catch (error) {
    console.error(
      "Symbol discovery error:",
      error
    );

    return [];
  }
}


// ============================================================
// SYMBOL METADATA NORMALIZER
// ============================================================

function normalizeSymbolMetadata(item) {
  if (!item) {
    return null;
  }

  if (typeof item === "string") {
    return {
      symbol: item,
      name: item,
      category: "unknown",
      type: "unknown",
      synthetic: false
    };
  }

  const symbol =
    String(
      item.symbol ||
      item.ticker ||
      item.code ||
      item.name ||
      ""
    ).trim();

  if (!symbol) {
    return null;
  }

  const category =
    String(
      item.category ||
      item.asset_class ||
      item.assetClass ||
      item.market ||
      item.group ||
      ""
    ).toLowerCase();

  const type =
    String(
      item.type ||
      item.instrument_type ||
      item.instrumentType ||
      ""
    ).toLowerCase();

  const name =
    String(
      item.name ||
      item.description ||
      symbol
    );

  const combined =
    `${symbol} ${name} ${category} ${type}`
      .toLowerCase();

  const synthetic =
    category.includes("synthetic") ||
    type.includes("synthetic") ||
    combined.includes("synthetic") ||
    combined.includes("volatility") ||
    combined.includes("boom") ||
    combined.includes("crash") ||
    combined.includes("step index") ||
    combined.includes("jump index") ||
    combined.includes("range break") ||
    combined.includes("drift switch");

  return {
    symbol,
    name,
    category,
    type,
    synthetic
  };
}


// ============================================================
// MARKET FILTER
// ============================================================

function shouldTradeSymbol(metadata) {
  if (!metadata) {
    return false;
  }

  const combined =
    `${metadata.symbol} ${metadata.name} ${metadata.category} ${metadata.type}`
      .toLowerCase();

  /*
   * Exclude obvious non-trading catalogue entries.
   */
  if (
    combined.includes("test") ||
    combined.includes("demo") ||
    combined.includes("deprecated")
  ) {
    return false;
  }

  /*
   * Accept known market categories.
   */
  if (
    CATEGORY_NAMES.some(
      category =>
        combined.includes(category)
    )
  ) {
    return true;
  }

  /*
   * Accept common FX symbols even when
   * the provider doesn't provide category metadata.
   */
  if (
    /^[A-Z]{6}$/.test(
      metadata.symbol.replace("/", "")
    )
  ) {
    return true;
  }

  return false;
}


// ============================================================
// NORMALIZE SYMBOL FOR OHLC
// ============================================================

function providerSymbol(metadata) {
  return String(
    metadata?.symbol || ""
  ).trim();
}


// ============================================================
// BIQUOTE OHLC
// ============================================================

async function getCandles(
  symbol,
  interval
) {
  try {
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
      "200"
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

  } catch (error) {
    return {
      status: "error",
      symbol,
      interval,
      message:
        error?.message ||
        String(error)
    };
  }
}


// ============================================================
// LOAD MARKETS DYNAMICALLY
// ============================================================

async function loadAllMarkets() {
  const discovered =
    await discoverSymbols();

  const usable =
    discovered.filter(
      shouldTradeSymbol
    );

  const markets = {};

  /*
   * Fallback core markets.
   * These are only used if the provider exposes
   * these symbols directly through its OHLC endpoint.
   */
  const fallback = [
    {
      symbol: "EURUSD",
      name: "EUR/USD",
      category: "forex",
      type: "forex",
      synthetic: false
    },

    {
      symbol: "GBPUSD",
      name: "GBP/USD",
      category: "forex",
      type: "forex",
      synthetic: false
    },

    {
      symbol: "USDJPY",
      name: "USD/JPY",
      category: "forex",
      type: "forex",
      synthetic: false
    },

    {
      symbol: "XAUUSD",
      name: "XAU/USD",
      category: "commodity",
      type: "commodity",
      synthetic: false
    },

    {
      symbol: "BTCUSD",
      name: "BTC/USD",
      category: "crypto",
      type: "crypto",
      synthetic: false
    },

    {
      symbol: "USTEC",
      name: "NASDAQ",
      category: "index",
      type: "index",
      synthetic: false
    },

    {
      symbol: "USOIL",
      name: "US OIL",
      category: "commodity",
      type: "commodity",
      synthetic: false
    }
  ];

  const merged =
    mergeUniqueSymbols(
      [...fallback, ...usable]
    );

  for (
    const metadata of merged
  ) {
    if (
      !shouldTradeSymbol(metadata)
    ) {
      continue;
    }

    const displayName =
      metadata.name ||
      metadata.symbol;

    markets[displayName] = {
      metadata,
      symbol:
        providerSymbol(metadata),
      timeframes: {}
    };

    for (
      const tf of TIMEFRAMES
    ) {
      markets[displayName]
        .timeframes[tf.name] =
        await getCandles(
          providerSymbol(metadata),
          tf.interval
        );
    }
  }

  return markets;
}


// ============================================================
// MERGE SYMBOLS
// ============================================================

function mergeUniqueSymbols(
  list
) {
  const map =
    new Map();

  for (
    const item of list
  ) {
    const normalized =
      normalizeSymbolMetadata(
        item
      );

    if (!normalized) {
      continue;
    }

    const key =
      normalized.symbol
        .replace(
          /[^A-Za-z0-9]/g,
          ""
        )
        .toUpperCase();

    if (!map.has(key)) {
      map.set(
        key,
        normalized
      );
    }
  }

  return [
    ...map.values()
  ];
}


// ============================================================
// GENERATE SIGNALS
// ============================================================

async function generateSignals() {
  const markets =
    await loadAllMarkets();

  const results = [];

  for (
    const [instrument, market]
    of Object.entries(markets)
  ) {
    const candidates = [];

    for (
      const entryTF
      of ENTRY_TIMEFRAMES
    ) {
      const result =
        analyzeInstrument(
          instrument,
          market,
          entryTF
        );

      if (result) {
        candidates.push(
          result
        );
      }
    }

    if (!candidates.length) {
      results.push({
        instrument,
        symbol:
          market.symbol,
        market_type:
          market.metadata?.category ||
          "unknown",
        synthetic:
          !!market.metadata?.synthetic,
        status: "NO SIGNAL"
      });

      continue;
    }

    candidates.sort(
      (a, b) => {
        const quality =
          SIGNAL_PRIORITY[
            b.status
          ] -
          SIGNAL_PRIORITY[
            a.status
          ];

        if (quality !== 0) {
          return quality;
        }

        return (
          tfPriority(
            b.entryTFRaw
          ) -
          tfPriority(
            a.entryTFRaw
          )
        );
      }
    );

    results.push(
      candidates[0]
    );
  }

  return results;
}


// ============================================================
// TIMEFRAME PRIORITY
// ============================================================

function tfPriority(tf) {
  const priority = {
    "4h": 4,
    "1h": 3,
    "30min": 2,
    "15min": 1
  };

  return priority[tf] || 0;
}


// ============================================================
// ANALYZE INSTRUMENT
// ============================================================

function analyzeInstrument(
  instrument,
  market,
  entryTF
) {
  const entryData =
    market.timeframes?.[entryTF];

  if (
    !entryData ||
    entryData.status !== "success" ||
    !Array.isArray(
      entryData.candles
    ) ||
    entryData.candles.length < 30
  ) {
    return null;
  }

  const candles =
    normalizeCandles(
      entryData.candles
    );

  const closed =
    candles.filter(
      c => !c.isOpen
    );

  if (closed.length < 30) {
    return null;
  }

  const current =
    closed[
      closed.length - 1
    ];

  /*
   * 4H + 1H establish the normal HTF bias.
   */
  const htfBias =
    determineHTFBias(
      market.timeframes
    );

  const structure =
    detectStructure(
      closed
    );

  const rejection =
    detectRejection(
      closed,
      structure
    );

  let bestResult = null;

  /*
   * Rejection is an early/developing signal.
   */
  if (
    rejection &&
    (
      htfBias === "neutral" ||
      rejection.direction === htfBias
    )
  ) {
    bestResult =
      buildRejectionSignal(
        instrument,
        market,
        entryTF,
        rejection,
        htfBias,
        current
      );
  }

  const accumulation =
    detectAccumulation(
      closed
    );

  const crt =
    detectCRT(
      closed,
      accumulation
    );

  const sweep =
    detectLiquiditySweep(
      closed,
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
      closed,
      sweep
    );

  const structureBreak =
    detectBOSMSS(
      closed,
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
    const setupSignal =
      buildValidSetupSignal(
        instrument,
        market,
        entryTF,
        direction,
        closed,
        sweep,
        structure,
        crt,
        displacement,
        structureBreak,
        rejection,
        htfBias
      );

    if (
      setupSignal &&
      (
        !bestResult ||
        SIGNAL_PRIORITY[
          setupSignal.status
        ] >
        SIGNAL_PRIORITY[
          bestResult.status
        ]
      )
    ) {
      bestResult =
        setupSignal;
    }
  }

  /*
   * Full confirmation requirements.
   */
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
      closed,
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
      closed,
      displacement,
      structureBreak
    );

  const fvg =
    findFVG(
      closed,
      displacement
    );

  const pullback =
    validatePullback(
      closed,
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
      closed
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

  /*
   * FINAL RR = 1:10
   */
  const takeProfit =
    structureBreak.direction === "bullish"
      ? entry + risk * RISK_REWARD
      : entry - risk * RISK_REWARD;

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
    instrument,

    symbol:
      market.symbol,

    marketType:
      market.metadata?.category ||
      "unknown",

    synthetic:
      !!market.metadata?.synthetic,

    direction:
      structureBreak.direction === "bullish"
        ? "BUY"
        : "SELL",

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
        ? "🟢 A+ CONFIRMED BUY"
        : "🟢 A+ CONFIRMED SELL",

    session:

      session.name,

    sessionStatus:
      session.status,

    signalTime:
      current.time,

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
      session,
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
    (current.close -
      current.low) /
    range;

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
// DEVELOPING DIRECTION
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
// REJECTION SIGNAL
// ============================================================

function buildRejectionSignal(
  instrument,
  market,
  entryTF,
  rejection,
  htfBias,
  current
) {
  const direction =
    rejection.direction === "bullish"
      ? "BUY"
      : "SELL";

  const session =
    getTradingSession(
      current.time
    );

  return {
    instrument,

    symbol:
      market.symbol,

    marketType:
      market.metadata?.category ||
      "unknown",

    synthetic:
      !!market.metadata?.synthetic,

    direction,

    entryTF:
      formatTF(entryTF),

    entryTFRaw:
      entryTF,

    status: "REJECTION",

    label:
      direction === "BUY"
        ? "🟢 BUY REJECTION"
        : "🔴 SELL REJECTION",

    rejectionLevel:
      roundPrice(
        rejection.level
      ),

    price:
      roundPrice(
        current.close
      ),

    session:
      session.name,

    sessionStatus:
      session.status,

    signalTime:
      current.time,

    rejectionReason:
      rejection.reason,

    message:
      direction === "BUY"
        ? "Price rejected the level and closed back above it."
        : "Price rejected the level and closed back below it.",

    internal: {
      htfBias,
      rejection,
      session,
      signalCandleTime:
        current.time
    }
  };
}


// ============================================================
// VALID SETUP SIGNAL
// ============================================================

function buildValidSetupSignal(
  instrument,
  market,
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

  let entry =
    current.close;

  if (rejection?.level) {
    entry =
      rejection.level;
  }

  if (sweep?.level) {
    entry =
      sweep.level;
  }

  const atr =
    ATR(candles);

  if (!atr) {
    return null;
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
      ? entry + risk * RISK_REWARD
      : entry - risk * RISK_REWARD;

  const components = [];

  if (htfBias === direction) {
    components.push(
      "HTF Bias"
    );
  }

  if (
    structure?.direction === direction
  ) {
    components.push(
      "Market Structure"
    );
  }

  if (rejection) {
    components.push(
      "Rejection"
    );
  }

  if (sweep) {
    components.push(
      "Liquidity Sweep"
    );
  }

  if (displacement) {
    components.push(
      "Displacement"
    );
  }

  if (structureBreak) {
    components.push(
      structureBreak.type
    );
  }

  if (crt) {
    components.push(
      "CRT"
    );
  }

  const session =
    getTradingSession(
      current.time
    );

  return {
    instrument,

    symbol:
      market.symbol,

    marketType:
      market.metadata?.category ||
      "unknown",

    synthetic:
      !!market.metadata?.synthetic,

    direction:
      direction === "bullish"
        ? "BUY"
        : "SELL",

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

    riskReward:
      "1:10",

    status:
      "VALID SETUP",

    label:
      direction === "bullish"
        ? "🟡 VALID BUY SETUP"
        : "🟡 VALID SELL SETUP",

    components,

    session:
      session.name,

    sessionStatus:
      session.status,

    signalTime:
      current.time,

    internal: {
      htfBias,
      crt,
      sweep,
      displacement,
      structureBreak,
      rejection,
      session,
      signalCandleTime:
        current.time
    }
  };
}


// ============================================================
// NORMALIZE CANDLES
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
        Number(
          c.tickVolume || 0
        ),

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

    const tr =
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
      );

    ranges.push(tr);
  }

  return average(ranges);
}


// ============================================================
// MARKET STRUCTURE
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
        price:
          candles[i].high
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
        price:
          candles[i].low
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
    highs[
      highs.length - 2
    ];

  const h2 =
    highs[
      highs.length - 1
    ];

  const l1 =
    lows[
      lows.length - 2
    ];

  const l2 =
    lows[
      lows.length - 1
    ];

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
// ============================================================

function determineHTFBias(
  market
) {
  const frames = [
    "4h",
    "1h"
  ];

  let bullish = 0;
  let bearish = 0;

  for (
    const tf of frames
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
      structure.direction === "bullish"
    ) {
      bullish++;
    }

    if (
      structure.direction === "bearish"
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
    candles.length <
    lookback
  ) {
    return null;
  }

  const recent =
    candles.slice(
      -lookback
    );

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

  let upperTouches = 0;
  let lowerTouches = 0;

  const tolerance =
    range * 0.15;

  for (
    const candle of recent
  ) {
    if (
      Math.abs(
        candle.high -
        high
      ) <= tolerance
    ) {
      upperTouches++;
    }

    if (
      Math.abs(
        candle.low -
        low
      ) <= tolerance
    ) {
      lowerTouches++;
    }
  }

  if (
    upperTouches < 2 &&
    lowerTouches < 2
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
      reference.time,

    accumulation:
      !!accumulation
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

  if (
    structure?.lows?.length
  ) {
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
        level:
          swingLow.price,
        candle: current
      };
    }
  }

  if (
    structure?.highs?.length
  ) {
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
        level:
          swingHigh.price,
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
    candles.slice(
      -11,
      -1
    );

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
    (current.close -
      current.low) /
    range;

  const bullish =
    current.close >
    current.open;

  const bearish =
    current.close <
    current.open;

  if (
    sweep.direction === "bullish" &&
    bullish &&
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
    bearish &&
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
    displacement.direction === "bullish"
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
          structure.direction === "bearish"
            ? "MSS"
            : "BOS",

        level:
          previousHigh.price
      };
    }
  }

  if (
    displacement.direction === "bearish"
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
          structure.direction === "bullish"
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
    structureBreak.direction === "bullish"
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
      structureBreak.direction === "bullish" &&
      candle.close <
        candle.open
    ) {
      return {
        direction: "bullish",
        high:
          candle.high,
        low:
          candle.low,
        time:
          candle.time
      };
    }

    if (
      structureBreak.direction === "bearish" &&
      candle.close >
        candle.open
    ) {
      return {
        direction: "bearish",
        high:
          candle.high,
        low:
          candle.low,
        time:
          candle.time
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
    displacement.direction === "bullish" &&
    c1.high < c3.low
  ) {
    return {
      direction: "bullish",
      low: c1.high,
      high: c3.low
    };
  }

  if (
    displacement.direction === "bearish" &&
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
// HEALTHY PULLBACK
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
        a -
        currentPrice
      ) -
      Math.abs(
        b -
        currentPrice
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
        ? sweep.level -
          atr * 0.10
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
        ? sweep.level +
          atr * 0.10
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
// SESSION ENGINE
// ============================================================

function getTradingSession(
  time
) {
  const date =
    new Date(time);

  if (
    !Number.isFinite(
      date.getTime()
    )
  ) {
    return {
      name: "UNKNOWN",
      status: "UNKNOWN"
    };
  }

  const hour =
    date.getUTCHours();

  const matches = [];

  for (
    const [name, session]
    of Object.entries(SESSIONS)
  ) {
    let active = false;

    if (
      session.start <
      session.end
    ) {
      active =
        hour >= session.start &&
        hour < session.end;
    } else {
      active =
        hour >= session.start ||
        hour < session.end;
    }

    if (active) {
      matches.push(
        name
      );
    }
  }

  if (!matches.length) {
    return {
      name: "OFF SESSION",
      status: "CLOSED",
      hourUTC: hour
    };
  }

  /*
   * When London/New York overlap,
   * New York gets priority.
   */
  if (
    matches.includes("NEW_YORK") &&
    matches.includes("LONDON")
  ) {
    return {
      name: "NEW YORK / LONDON OVERLAP",
      status: "ACTIVE",
      hourUTC: hour
    };
  }

  return {
    name: matches[0],
    status: "ACTIVE",
    hourUTC: hour
  };
}


// ============================================================
// SESSION OPENING NOTIFICATION
// ============================================================

function getSessionOpeningMessage(
  date = new Date()
) {
  const hour =
    date.getUTCHours();

  const minute =
    date.getUTCMinutes();

  const currentMinutes =
    hour * 60 +
    minute;

  const sessions = [
    {
      name: "SYDNEY",
      open: 21 * 60
    },

    {
      name: "ASIA",
      open: 0
    },

    {
      name: "LONDON",
      open: 7 * 60
    },

    {
      name: "NEW YORK",
      open: 13 * 60
    }
  ];

  for (
    const session of sessions
  ) {
    const difference =
      (
        session.open -
        currentMinutes +
        1440
      ) %
      1440;

    if (
      difference <= 15
    ) {
      return {
        session:
          session.name,
        minutesUntilOpen:
          difference
      };
    }
  }

  return null;
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
      payment_status:
        "failed",
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
      payment_status:
        "failed",
      error:
        "Payment record not found"
    };
  }

  const plan =
    payment.plan;

  if (!PLANS[plan]) {
    return {
      success: false,
      payment_status:
        "failed",
      error:
        "Invalid CyberFX plan"
    };
  }

  const selectedPlan =
    PLANS[plan];

  if (
    Number(transaction.amount) !==
    Number(selectedPlan.amount)
  ) {
    await env.DB.prepare(`
      UPDATE payments
      SET status = ?
      WHERE reference = ?
    `)
      .bind(
        "amount_mismatch",
        reference
      )
      .run();

    return {
      success: false,
      payment_status:
        "amount_mismatch",
      error:
        "Payment amount does not match selected plan"
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

  if (!email) {
    return {
      success: false,
      payment_status:
        "failed",
      error:
        "Customer email not found"
    };
  }

  const now =
    new Date();

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
      payment_status:
        "failed",
      error:
        "User account not found. Register on CyberFX before paying."
    };
  }

  /*
   * Find current subscription.
   */
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

  let startDate =
    now;

  /*
   * If a paid subscription is still active,
   * extend from its expiry.
   */
  if (
    existing?.status === "active" &&
    existing?.expires_at
  ) {
    const expiry =
      new Date(
        existing.expires_at
      );

    if (
      Number.isFinite(
        expiry.getTime()
      ) &&
      expiry > now &&
      existing.plan !== "trial"
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

  /*
   * Convert the trial into paid access
   * rather than leaving the trial active.
   */
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
        plan,
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
        plan,
        reference,
        "active",
        startDate.toISOString(),
        expires.toISOString()
      )
      .run();
  }

  return {
    success: true,
    payment_status:
      "success",
    reference,
    email,
    plan,
    plan_name:
      selectedPlan.name,
    starts_at:
      startDate.toISOString(),
    expires_at:
      expires.toISOString()
  };
}


// ============================================================
// TRIAL START
// ============================================================

async function startTrial(
  email,
  env
) {
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

  /*
   * Check whether the account has EVER used a trial.
   */
  const previousTrial =
    await env.DB.prepare(`
      SELECT id
      FROM subscriptions
      WHERE user_id = ?
        AND plan = 'trial'
      LIMIT 1
    `)
      .bind(user.id)
      .first();

  if (previousTrial) {
    return {
      success: false,
      trial_started: false,
      error:
        "This account has already used its free trial."
    };
  }

  /*
   * Don't create a trial if a paid subscription
   * already exists.
   */
  const paid =
    await env.DB.prepare(`
      SELECT id
      FROM subscriptions
      WHERE user_id = ?
        AND plan != 'trial'
        AND status = 'active'
        AND datetime(expires_at) > datetime('now')
      LIMIT 1
    `)
      .bind(user.id)
      .first();

  if (paid) {
    return {
      success: true,
      trial_started: false,
      message:
        "User already has an active paid subscription."
    };
  }

  const now =
    new Date();

  const expires =
    new Date(
      now.getTime() +
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
      now.toISOString(),
      expires.toISOString()
    )
    .run();

  return {
    success: true,
    trial_started: true,
    trial_days: TRIAL_DAYS,
    plan: "trial",
    plan_name:
      "21-Day Free Trial",
    starts_at:
      now.toISOString(),
    expires_at:
      expires.toISOString()
  };
}


// ============================================================
// AUTOMATIC TRIAL CREATION
// ============================================================

async function ensureTrialForUser(
  email,
  env
) {
  if (!env.DB) {
    return null;
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
    return null;
  }

  const anySubscription =
    await env.DB.prepare(`
      SELECT
        id,
        plan,
        status,
        expires_at
      FROM subscriptions
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 1
    `)
      .bind(user.id)
      .first();

  if (anySubscription) {
    return anySubscription;
  }

  return startTrial(
    email,
    env
  );
}


// ============================================================
// GET LATEST SUBSCRIPTION
// ============================================================

async function getLatestSubscriptionByEmail(
  email,
  env
) {
  if (!env.DB) {
    return null;
  }

  const row =
    await env.DB.prepare(`
      SELECT
        u.id AS user_id,
        u.email,
        s.id AS subscription_id,
        s.plan,
        s.starts_at,
        s.expires_at,
        s.status,
        s.paystack_reference
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
    await expireUserSubscription(
      row.user_id,
      env
    );

    return null;
  }

  return row;
}


// ============================================================
// EXPIRE USER ACCESS
// ============================================================

async function expireUserSubscription(
  userId,
  env
) {
  if (!env.DB) {
    return;
  }

  await env.DB.prepare(`
    UPDATE subscriptions
    SET status = 'expired'
    WHERE user_id = ?
      AND status = 'active'
      AND datetime(expires_at) <= datetime('now')
  `)
    .bind(userId)
    .run();
}


// ============================================================
// EXPIRE ALL OLD SUBSCRIPTIONS
// ============================================================

async function expireOldSubscriptions(
  env
) {
  if (!env.DB) {
    return;
  }

  await env.DB.prepare(`
    UPDATE subscriptions
    SET status = 'expired'
    WHERE status = 'active'
      AND datetime(expires_at) <= datetime('now')
  `)
    .run();
}


// ============================================================
// TELEGRAM AUTHORIZATION
// ============================================================

async function isTelegramAuthorized(
  telegramId,
  env
) {
  const id =
    String(telegramId);

  /*
   * OWNER ALWAYS HAS ACCESS.
   */
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
    await getLatestSubscriptionByEmail(
      link.email,
      env
    );

  if (!subscription) {
    return {
      authorized: false,
      owner: false,
      expired: true,
      email:
        link.email
    };
  }

  return {
    authorized: true,
    owner: false,
    email:
      link.email,
    plan:
      subscription.plan,
    trial:
      subscription.plan === "trial",
    expires_at:
      subscription.expires_at
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

  /*
   * OWNER
   */
  ids.add(
    OWNER_TELEGRAM_ID
  );

  if (!env.DB) {
    return [
      ...ids
    ];
  }

  /*
   * Expire old subscriptions before
   * calculating recipients.
   */
  await expireOldSubscriptions(
    env
  );

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
// TELEGRAM MESSAGE HANDLER
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

  // ==========================================================
  // START
  // ==========================================================

  if (
    text === "/start"
  ) {
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

You do NOT need:
• Subscription
• Trial
• Payment

📡 Automatic signals are enabled.

Use /signals for a manual scan.`,
        env.TELEGRAM_BOT_TOKEN
      );

      return;
    }

    if (access.authorized) {
      const planText =
        access.trial
          ? "21-Day Free Trial"
          : (
              PLANS[access.plan]?.name ||
              access.plan
            );

      await sendTelegramMessage(
        chatId,
        `🔥 CYBERFX

Access: ACTIVE

Plan: ${planText}

Expires:
${access.expires_at}

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

Your CyberFX subscription or free trial is not active.

Register and subscribe through:

${WEBSITE_URL}`,
      env.TELEGRAM_BOT_TOKEN
    );

    return;
  }

  // ==========================================================
  // SUBSCRIBE
  // ==========================================================

  if (
    text === "/subscribe"
  ) {
    await sendTelegramMessage(
      chatId,
      `🔥 CYBERFX

Register through:

${WEBSITE_URL}

New users receive a 21-DAY FREE TRIAL.

After the trial expires, an active paid subscription is required for signal access.`,
      env.TELEGRAM_BOT_TOKEN
    );

    return;
  }

  // ==========================================================
  // SIGNALS
  // ==========================================================

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

Access denied.

Your free trial or paid subscription is not active.

Subscribe here:

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

No active rejection, valid setup, or confirmed signal at the moment.`,
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

  // ==========================================================
  // HELP
  // ==========================================================

  if (
    text === "/help"
  ) {
    await sendTelegramMessage(
      chatId,
      `🔥 CYBERFX

Commands:

/start — Check access
/signals — Manual signal scan
/subscribe — Subscription website
/help — Show commands

📡 Active users receive new CyberFX setups automatically.`,
      env.TELEGRAM_BOT_TOKEN
    );

    return;
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
    /*
     * Expire old trials/subscriptions first.
     */
    await expireOldSubscriptions(
      env
    );

    const signals =
      await generateSignals();

    const active =
      signals.filter(
        signal =>
          signal.status !==
          "NO SIGNAL"
      );

    const recipients =
      await getAuthorizedTelegramIds(
        env
      );

    /*
     * Session opening notice.
     */
    const sessionOpening =
      getSessionOpeningMessage();

    if (
      sessionOpening &&
      sessionOpening.minutesUntilOpen <= 15
    ) {
      const notice =
        `⏰ CYBERFX SESSION

${sessionOpening.session} session is opening/approaching.

📡 CyberFX engine is monitoring for setups.

Risk/Reward: 1:10`;

      for (
        const chatId of recipients
      ) {
        await sendTelegramMessage(
          chatId,
          notice,
          env.TELEGRAM_BOT_TOKEN
        );
      }
    }

    if (!active.length) {
      console.log(
        "CYBERFX: No active signals."
      );

      return;
    }

    console.log(
      `CYBERFX: ${active.length} active signal(s). ${recipients.length} Telegram recipient(s).`
    );

    for (
      const signal of active
    ) {
      const signature =
        createSignalSignature(
          signal
        );

      const alreadySent =
        await wasSignalSent(
          signature,
          env
        );

      if (alreadySent) {
        continue;
      }

      let successfulDelivery =
        false;

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
          successfulDelivery =
            true;
        }
      }

      if (successfulDelivery) {
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
  const candleTime =
    signal.signalTime ||
    signal.internal?.signalCandleTime ||
    "unknown";

  return [
    signal.instrument,
    signal.status,
    signal.direction,
    signal.entryTFRaw ||
      signal.entryTF,
    candleTime
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


// ============================================================
// CHECK SENT SIGNAL
// ============================================================

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

  } catch (error) {
    console.error(
      "Signal history check error:",
      error
    );

    return false;
  }
}


// ============================================================
// MARK SIGNAL SENT
// ============================================================

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
        signal.instrument,
        signal.status,
        signal.direction || "",
        signal.entryTF || "",
        signal.signalTime || ""
      )
      .run();

    /*
     * Keep only the newest 500 records.
     */
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
      "Signal history save error:",
      error
    );
  }
}


// ============================================================
// TELEGRAM OUTPUT
// ============================================================

function formatTelegramSignal(
  signal
) {
  const marketType =
    signal.synthetic
      ? "SYNTHETIC"
      : (
          signal.marketType ||
          "MARKET"
        ).toUpperCase();

  // ==========================================================
  // REJECTION
  // ==========================================================

  if (
    signal.status === "REJECTION"
  ) {
    const icon =
      signal.direction === "BUY"
        ? "🟢"
        : "🔴";

    return `${icon} CYBERFX ${signal.direction} REJECTION

${signal.instrument}

Market: ${marketType}

Entry TF: ${signal.entryTF}

Session: ${signal.session}

Rejection Level: ${signal.rejectionLevel}

Current Price: ${signal.price}

${signal.message}

⚠️ DEVELOPING OPPORTUNITY`;
  }

  // ==========================================================
  // VALID SETUP
  // ==========================================================

  if (
    signal.status === "VALID SETUP"
  ) {
    return `🟡 CYBERFX VALID SETUP

${signal.instrument} — ${signal.direction}

Market: ${marketType}

Entry TF: ${signal.entryTF}

Session: ${signal.session}

Entry: ${signal.entry}

Stop Loss: ${signal.stopLoss}

Take Profit: ${signal.takeProfit}

Risk/Reward: 1:10

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

⚠️ VALID SETUP — AWAITING FULL CONFIRMATION`;
  }

  // ==========================================================
  // CONFIRMED
  // ==========================================================

  if (
    signal.status === "CONFIRMED"
  ) {
    return `🟢 CYBERFX A+ SIGNAL

${signal.instrument} — ${signal.direction}

Market: ${marketType}

Entry TF: ${signal.entryTF}

Session: ${signal.session}

Entry: ${signal.entry}

Stop Loss: ${signal.stopLoss}

Take Profit: ${signal.takeProfit}

Risk/Reward: 1:10

✅ A+ CONFIRMED

GOD OVER MAN

📡 CyberFX automated signal engine`;
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

    const result =
      await response.json();

    if (!result.ok) {
      console.error(
        "Telegram sendMessage failed:",
        result
      );
    }

    return result;

  } catch (error) {
    console.error(
      "Telegram request failed:",
      error
    );

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

function average(
  values
) {
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


function midpoint(
  a,
  b
) {
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


function roundPrice(
  price
) {
  if (
    !Number.isFinite(price)
  ) {
    return null;
  }

  return Number(
    price.toFixed(2)
  );
}


function formatTF(
  tf
) {
  const names = {
    "15min": "15M",
    "30min": "30M",
    "1h": "1H",
    "4h": "4H"
  };

  return (
    names[tf] ||
    tf
  );
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
// JSON RESPONSE
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
