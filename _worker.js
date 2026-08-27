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
        status: "online",
        market_data: "Biquote",
        biquote_connected: biquoteConnected,
        telegram_connected: !!env.TELEGRAM_BOT_TOKEN,
        paystack_connected: !!env.PAYSTACK_SECRET_KEY,
        database_connected: !!env.DB
      });
    }

    // =========================================================
    // PAYSTACK - INITIALIZE PAYMENT
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
                duration_months:
                  selectedPlan.months
              }
            })
          }
        );

        const result =
          await paystackResponse.json();

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
    // PAYSTACK - VERIFY
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
    // SUBSCRIPTION CHECK
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

        const subscription =
          await getActiveSubscriptionByEmail(
            email,
            env
          );

        if (!subscription) {
          return json({
            success: true,
            subscribed: false,
            active: false
          });
        }

        return json({
          success: true,
          subscribed: true,
          active: true,
          plan: subscription.plan,
          plan_name:
            subscription.plan_name,
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
    // BIQUOTE MARKET DATA
    // =========================================================
    if (url.pathname === "/api/signals") {
      try {
        const data =
          await loadAllMarkets();

        return json({
          success: true,
          engine: "CyberFX",
          source: "Biquote",
          markets:
            Object.keys(INSTRUMENTS),
          timeframes:
            TIMEFRAMES.map(
              tf => tf.name
            ),
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
      url.pathname ===
      "/api/generate-signals"
    ) {
      try {
        const result =
          await generateSignals();

        return json({
          success: true,
          engine: "CyberFX",
          source: "Biquote",
          risk_reward: "1:3",
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
      url.pathname ===
        "/telegram/webhook" &&
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
  // AUTOMATIC 15-MINUTE SCAN
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

const OWNER_TELEGRAM_ID =
  "8368477940";


// ============================================================
// WEBSITE
// ============================================================

const WEBSITE_URL =
  "https://cyberfx-website.cybertradingsignal.workers.dev/";


// ============================================================
// PLANS
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
// MARKETS
// ============================================================

const INSTRUMENTS = {
  "XAU/USD": "XAUUSD",
  "BTC/USD": "BTCUSD",
  "NASDAQ": "USTEC",
  "US OIL": "USOIL"
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


const CONFIRMED_SCORE = 13;


const SIGNAL_PRIORITY = {
  "REJECTION": 1,
  "VALID SETUP": 2,
  "CONFIRMED": 3
};


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
// BIQUOTE OHLC
// ============================================================

async function getCandles(
  symbol,
  interval
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
}


// ============================================================
// LOAD ALL MARKETS
// ============================================================

async function loadAllMarkets() {
  const data = {};

  for (
    const [name, symbol]
    of Object.entries(
      INSTRUMENTS
    )
  ) {
    data[name] = {};

    for (
      const tf of TIMEFRAMES
    ) {
      data[name][tf.name] =
        await getCandles(
          symbol,
          tf.interval
        );
    }
  }

  return data;
}


// ============================================================
// GENERATE SIGNALS
// ============================================================

async function generateSignals() {
  const marketData =
    await loadAllMarkets();

  const results = [];

  for (
    const instrument
    of Object.keys(INSTRUMENTS)
  ) {
    const market =
      marketData[instrument];

    if (!market) {
      results.push({
        instrument,
        status: "NO SIGNAL"
      });

      continue;
    }

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
        candidates.push(result);
      }
    }

    if (!candidates.length) {
      results.push({
        instrument,
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
    market[entryTF];

  if (
    !entryData ||
    entryData.status !==
      "success" ||
    !entryData.candles ||
    entryData.candles.length <
      30
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

  const htfBias =
    determineHTFBias(
      market
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

  if (
    rejection &&
    (
      htfBias === "neutral" ||
      rejection.direction ===
        htfBias
    )
  ) {
    bestResult =
      buildRejectionSignal(
        instrument,
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
    structureBreak.direction ===
      "bullish"
      ? entry - stopLoss
      : stopLoss - entry;

  if (risk <= 0) {
    return bestResult;
  }

  const takeProfit =
    structureBreak.direction ===
      "bullish"
      ? entry + risk * 3
      : entry - risk * 3;

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

  return {
    instrument,

    direction:
      structureBreak.direction ===
        "bullish"
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

    riskReward: "1:3",

    status: "CONFIRMED",

    label:
      structureBreak.direction ===
        "bullish"
        ? "🔥 CONFIRMED BUY"
        : "🔥 CONFIRMED SELL",

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
        type:
          "BUY REJECTION",
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
        type:
          "SELL REJECTION",
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
      sweep.direction ===
        htfBias
    ) {
      return sweep.direction;
    }
  }

  if (rejection?.direction) {
    if (
      htfBias === "neutral" ||
      rejection.direction ===
        htfBias
    ) {
      return rejection.direction;
    }
  }

  if (
    structure?.direction &&
    structure.direction !==
      "neutral"
  ) {
    if (
      htfBias === "neutral" ||
      structure.direction ===
        htfBias
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
    rejection.direction ===
      direction
  ) {
    score += 2;
  }

  if (crt) {
    score += 1;
  }

  if (
    sweep &&
    sweep.direction ===
      direction
  ) {
    score += 3;
  }

  if (
    displacement &&
    displacement.direction ===
      direction
  ) {
    score += 2;
  }

  if (
    structureBreak &&
    structureBreak.direction ===
      direction
  ) {
    score += 3;
  }

  if (
    structure &&
    structure.direction ===
      direction
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
  entryTF,
  rejection,
  htfBias,
  current
) {
  const direction =
    rejection.direction ===
      "bullish"
      ? "BUY"
      : "SELL";

  return {
    instrument,

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

  if (
    direction === "bullish"
  ) {
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
      ? entry + risk * 3
      : entry - risk * 3;

  const components = [];

  if (htfBias === direction) {
    components.push(
      "HTF Bias"
    );
  }

  if (
    structure?.direction ===
      direction
  ) {
    components.push(
      "Structure"
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
    components.push("CRT");
  }

  return {
    instrument,

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
      roundPrice(
        takeProfit
      ),

    riskReward: "1:3",

    status:
      "VALID SETUP",

    label:
      direction === "bullish"
        ? "🟡 VALID BUY SETUP"
        : "🟡 VALID SELL SETUP",

    components,

    signalTime:
      current.time,

    internal: {
      htfBias,
      crt,
      sweep,
      displacement,
      structureBreak,
      rejection,
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
      Number.isFinite(
        c.open
      ) &&
      Number.isFinite(
        c.high
      ) &&
      Number.isFinite(
        c.low
      ) &&
      Number.isFinite(
        c.close
      )
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
// STRUCTURE
// ============================================================

function detectStructure(
  candles
) {
  const highs = [];
  const lows = [];

  for (
    let i = 2;
    i <
      candles.length - 2;
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
// HIGHER TIMEFRAME BIAS
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
      data.status !==
        "success"
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
    sweep.direction ===
      "bullish" &&
    bullish &&
    closeLocation >= 0.75 &&
    body >=
      averageBody * 1.5 &&
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
    sweep.direction ===
      "bearish" &&
    bearish &&
    closeLocation <= 0.25 &&
    body >=
      averageBody * 1.5 &&
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
    let i =
      index - 1;

    i >=
      Math.max(
        0,
        index - 5
      );

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
        high:
          candle.high,
        low:
          candle.low,
        time:
          candle.time
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
        direction ===
          "bullish"
          ? c.close <
            c.open
          : c.close >
            c.open
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
    (a, b)
