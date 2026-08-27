export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================================================
    // HEALTH
    // =========================================================
    if (url.pathname === "/api/health") {
      return json({
        success: true,
        engine: "CyberFX",
        status: "online",
        market_data: "Biquote",
        biquote_connected: true,
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
              "Authorization":
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
                custom_fields: [
                  {
                    display_name: "CyberFX Plan",
                    variable_name: "cyberfx_plan",
                    value: selectedPlan.name
                  }
                ],
                cyberfx_plan: plan,
                duration_months: selectedPlan.months
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
            email,
            plan,
            amount,
            status,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `)
          .bind(
            reference,
            email,
            plan,
            selectedPlan.amount / 100,
            "pending",
            new Date().toISOString()
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
    // PAYSTACK - VERIFY PAYMENT
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
    // CHECK SUBSCRIPTION
    // =========================================================
    if (
      url.pathname === "/api/subscription" &&
      request.method === "GET"
    ) {
      try {
        if (!env.DB) {
          return json({
            success: false,
            error: "D1 database binding DB is missing"
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
          await getActiveSubscription(
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
          plan_name: subscription.plan_name,
          email: subscription.email,
          starts_at: subscription.starts_at,
          expires_at: subscription.expires_at
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
    // RAW MARKET DATA
    // =========================================================
    if (url.pathname === "/api/signals") {
      try {
        const data =
          await loadAllMarkets();

        return json({
          success: true,
          source: "Biquote",
          engine: "CyberFX",
          markets: Object.keys(INSTRUMENTS),
          timeframes:
            TIMEFRAMES.map(tf => tf.name),
          data
        });

      } catch (error) {
        console.error(
          "Market data error:",
          error
        );

        return json({
          success: false,
          engine: "CyberFX",
          source: "Biquote",
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
      url.pathname === "/telegram/webhook" &&
      request.method === "POST"
    ) {
      try {
        const update =
          await request.json();

        if (update.message) {
          await handleTelegramMessage(
            update.message,
            env
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
// BIQUOTE MARKETS
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
    name: "4h",
    interval: "4h"
  },
  {
    name: "1h",
    interval: "1h"
  },
  {
    name: "30min",
    interval: "30m"
  },
  {
    name: "15min",
    interval: "15m"
  }
];


// ============================================================
// ENTRY TIMEFRAMES
// ============================================================

const ENTRY_TIMEFRAMES = [
  "15min",
  "30min",
  "1h",
  "4h"
];


// ============================================================
// CONFIRMED SCORE
// ============================================================

const CONFIRMED_SCORE = 10;


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
        method: "GET",
        headers: {
          "Authorization":
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

  const paymentStatus =
    transaction.status;

  if (paymentStatus !== "success") {
    await env.DB.prepare(`
      UPDATE payments
      SET status = ?
      WHERE reference = ?
    `)
      .bind(
        paymentStatus || "failed",
        reference
      )
      .run();

    return {
      success: false,
      payment_status:
        paymentStatus || "failed",
      reference
    };
  }

  const email =
    String(
      transaction.customer?.email || ""
    )
      .trim()
      .toLowerCase();

  if (!email) {
    return {
      success: false,
      payment_status: "failed",
      error:
        "No customer email returned by Paystack"
    };
  }

  let plan =
    transaction.metadata?.cyberfx_plan;

  if (!plan || !PLANS[plan]) {
    const existing =
      await env.DB.prepare(`
        SELECT plan
        FROM payments
        WHERE reference = ?
        LIMIT 1
      `)
        .bind(reference)
        .first();

    plan =
      existing?.plan;
  }

  if (!plan || !PLANS[plan]) {
    return {
      success: false,
      payment_status: "failed",
      error:
        "Unable to determine CyberFX subscription plan"
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
      payment_status: "amount_mismatch",
      error:
        "Payment amount does not match the selected plan"
    };
  }

  const existingPayment =
    await env.DB.prepare(`
      SELECT status
      FROM payments
      WHERE reference = ?
      LIMIT 1
    `)
      .bind(reference)
      .first();

  if (existingPayment?.status === "success") {
    const existingSubscription =
      await getActiveSubscription(
        email,
        env
      );

    return {
      success: true,
      payment_status: "success",
      reference,
      email,
      plan,
      plan_name: selectedPlan.name,
      starts_at:
        existingSubscription?.starts_at ||
        null,
      expires_at:
        existingSubscription?.expires_at ||
        null
    };
  }

  const now =
    new Date();

  const activeSubscription =
    await getActiveSubscription(
      email,
      env
    );

  let startDate =
    now;

  if (
    activeSubscription?.expires_at
  ) {
    const currentExpiry =
      new Date(
        activeSubscription.expires_at
      );

    if (currentExpiry > now) {
      startDate =
        currentExpiry;
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
      paid_at = ?,
      paystack_transaction_id = ?
    WHERE reference = ?
  `)
    .bind(
      "success",
      now.toISOString(),
      String(
        transaction.id || ""
      ),
      reference
    )
    .run();

  await env.DB.prepare(`
    INSERT INTO subscriptions (
      email,
      plan,
      plan_name,
      starts_at,
      expires_at,
      status,
      payment_reference,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email)
    DO UPDATE SET
      plan = excluded.plan,
      plan_name = excluded.plan_name,
      starts_at = excluded.starts_at,
      expires_at = excluded.expires_at,
      status = excluded.status,
      payment_reference = excluded.payment_reference,
      updated_at = excluded.updated_at
  `)
    .bind(
      email,
      plan,
      selectedPlan.name,
      startDate.toISOString(),
      expires.toISOString(),
      "active",
      reference,
      now.toISOString(),
      now.toISOString()
    )
    .run();

  return {
    success: true,
    payment_status: "success",
    reference,
    email,
    plan,
    plan_name: selectedPlan.name,
    starts_at:
      startDate.toISOString(),
    expires_at:
      expires.toISOString()
  };
}


// ============================================================
// ACTIVE SUBSCRIPTION
// ============================================================

async function getActiveSubscription(
  email,
  env
) {
  if (!env.DB) {
    return null;
  }

  const subscription =
    await env.DB.prepare(`
      SELECT
        email,
        plan,
        plan_name,
        starts_at,
        expires_at,
        status
      FROM subscriptions
      WHERE email = ?
      LIMIT 1
    `)
      .bind(email)
      .first();

  if (!subscription) {
    return null;
  }

  const expiry =
    new Date(
      subscription.expires_at
    );

  if (
    subscription.status !== "active" ||
    !Number.isFinite(
      expiry.getTime()
    ) ||
    expiry <= new Date()
  ) {
    await env.DB.prepare(`
      UPDATE subscriptions
      SET status = ?,
          updated_at = ?
      WHERE email = ?
    `)
      .bind(
        "expired",
        new Date().toISOString(),
        email
      )
      .run();

    return null;
  }

  return subscription;
}


// ============================================================
// ADD MONTHS
// ============================================================

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
    result.getUTCMonth() + months
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
// LOAD ALL BIQUOTE MARKETS
// ============================================================

async function loadAllMarkets() {
  const data = {};

  for (
    const [name, symbol]
    of Object.entries(INSTRUMENTS)
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

  try {
    const response =
      await fetch(apiUrl, {
        headers: {
          "Accept":
            "application/json"
        }
      });

    const result =
      await response.json();

    if (
      !response.ok ||
      !Array.isArray(result.bars)
    ) {
      return {
        status: "error",
        code: response.status,
        message:
          result?.message ||
          result?.error ||
          "Biquote request failed"
      };
    }

    return {
      status: "success",
      source: "Biquote",
      symbol:
        result.symbol ||
        symbol,
      interval,
      candles:
        result.bars
    };

  } catch (error) {
    return {
      status: "error",
      message:
        error?.message ||
        String(error)
    };
  }
}


// ============================================================
// MAIN SIGNAL ENGINE
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

    const tfPriority = {
      "4h": 4,
      "1h": 3,
      "30min": 2,
      "15min": 1
    };

    candidates.sort(
      (a, b) => {
        const quality =
          SIGNAL_PRIORITY[b.status] -
          SIGNAL_PRIORITY[a.status];

        if (quality !== 0) {
          return quality;
        }

        return (
          (tfPriority[b.entryTFRaw] || 0) -
          (tfPriority[a.entryTFRaw] || 0)
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
    entryData.status !== "success" ||
    !entryData.candles ||
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
    closed[closed.length - 1];

  const htfBias =
    determineHTFBias(market);

  const structure =
    detectStructure(closed);

  // ==========================================================
  // REJECTION
  // ==========================================================

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
      rejection.direction === htfBias
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

  // ==========================================================
  // CRT
  // ==========================================================

  const accumulation =
    detectAccumulation(
      closed
    );

  const crt =
    detectCRT(
      closed,
      accumulation
    );

  // ==========================================================
  // OPTIONAL LIQUIDITY SWEEP
  // ==========================================================

  const sweep =
    detectLiquiditySweep(
      closed,
      crt,
      structure
    );

  // ==========================================================
  // DIRECTION
  // ==========================================================

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

  // ==========================================================
  // STRUCTURE BREAK
  // ==========================================================

  const structureBreak =
    detectBOSMSS(
      closed,
      structure,
      direction
    );

  // ==========================================================
  // VALID SETUP
  // ==========================================================

  const validSetup =
    detectValidSetup(
      direction,
      htfBias,
      rejection,
      crt,
      sweep,
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
        structureBreak,
        rejection,
        htfBias
      );

    if (
      setupSignal &&
      (
        !bestResult ||
        SIGNAL_PRIORITY[setupSignal.status] >
          SIGNAL_PRIORITY[bestResult.status]
      )
    ) {
      bestResult =
        setupSignal;
    }
  }

  // ==========================================================
  // CONFIRMED
  // ==========================================================

  if (
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
      direction
    );

  const orderBlock =
    findOrderBlock(
      closed,
      direction,
      structureBreak
    );

  // ==========================================================
  // FIB + OB
  // ==========================================================

  if (!fib || !orderBlock) {
    return bestResult;
  }

  const fvg =
    findFVG(
      closed,
      direction
    );

  const pullback =
    validatePullback(
      closed,
      fib,
      orderBlock,
      fvg,
      direction
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
      direction
    );

  if (!entry) {
    return bestResult;
  }

  const stopLoss =
    determineStopLoss(
      entry,
      direction,
      sweep,
      orderBlock,
      closed
    );

  if (!stopLoss) {
    return bestResult;
  }

  const risk =
    direction === "bullish"
      ? entry - stopLoss
      : stopLoss - entry;

  if (risk <= 0) {
    return bestResult;
  }

  const takeProfit =
    direction === "bullish"
      ? entry + risk * 3
      : entry - risk * 3;

  const score =
    calculateScore({
      htfBias,
      crt,
      sweep,
      structureBreak,
      orderBlock,
      fvg,
      fib,
      pullback
    });

  const mandatoryPassed =
    !!structureBreak &&
    !!orderBlock &&
    !!pullback.valid &&
    risk > 0;

  if (!mandatoryPassed) {
    return bestResult;
  }

  if (score < CONFIRMED_SCORE) {
    return bestResult;
  }

  const reason =
    buildTradeReason({
      instrument,
      direction,
      currentPrice: current.close,
      entry,
      fib,
      orderBlock,
      sweep,
      structureBreak
    });

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
      roundPrice(takeProfit),

    riskReward: "1:3",

    status: "CONFIRMED",

    label:
      direction === "bullish"
        ? "🔥 CYBERFX CONFIRMED BUY"
        : "🔥 CYBERFX CONFIRMED SELL",

    reason,

    internal: {
      score,
      htfBias,
      crt,
      sweep,
      structureBreak,
      orderBlock,
      fvg,
      fib,
      pullback
    }
  };
}


// ============================================================
// REJECTION DETECTOR
// ============================================================

function detectRejection(
  candles,
  structure
) {
  const current =
    candles[candles.length - 1];

  if (!current) {
    return null;
  }

  const range =
    current.high -
    current.low;

  if (!range || range <= 0) {
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

  const meaningfulRange =
    atr
      ? range >= atr * 0.35
      : true;

  if (!meaningfulRange) {
    return null;
  }

  // BUY REJECTION
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
            swing.price - level
          ) <= range * 0.50
      );

    if (
      nearSwingLow ||
      lowerWick >= range * 0.40
    ) {
      return {
        direction: "bullish",
        type: "BUY REJECTION",
        level,
        candle: current,
        reason:
          nearSwingLow
            ? "Price rejected a recent swing low."
            : "Price showed strong lower-wick rejection."
      };
    }
  }

  // SELL REJECTION
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
            swing.price - level
          ) <= range * 0.50
      );

    if (
      nearSwingHigh ||
      upperWick >= range * 0.40
    ) {
      return {
        direction: "bearish",
        type: "SELL REJECTION",
        level,
        candle: current,
        reason:
          nearSwingHigh
            ? "Price rejected a recent swing high."
            : "Price showed strong upper-wick rejection."
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

  // Sweep is optional.
  if (
    sweep &&
    sweep.direction === direction
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

  return score >= 4;
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
    rejection.direction === "bullish"
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

    reason:
      rejection.reason,

    message:
      direction === "BUY"
        ? "Price is rejecting the level. Watch for a retracement before considering an entry."
        : "Price is rejecting the level. Watch for a retracement before considering an entry.",

    internal: {
      htfBias,
      rejection
    }
  };
}


// ============================================================
// VALID SETUP BUILDER
// ============================================================

function buildValidSetupSignal(
  instrument,
  entryTF,
  direction,
  candles,
  sweep,
  structure,
  crt,
  structureBreak,
  rejection,
  htfBias
) {
  const current =
    candles[candles.length - 1];

  const atr =
    ATR(candles);

  if (!atr) {
    return null;
  }

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

  let stopLoss;

  if (direction === "bullish") {
    stopLoss =
      (sweep?.level ||
        rejection?.level ||
        current.low) -
      atr * 0.25;
  } else {
    stopLoss =
      (sweep?.level ||
        rejection?.level ||
        current.high) +
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

  const reason =
    buildDevelopingReason({
      instrument,
      direction,
      currentPrice: current.close,
      entry,
      rejection,
      sweep,
      structureBreak,
      structure
    });

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
      roundPrice(takeProfit),

    riskReward: "1:3",

    status: "VALID SETUP",

    label:
      direction === "bullish"
        ? "🟡 CYBERFX VALID BUY"
        : "🟡 CYBERFX VALID SELL",

    reason,

    internal: {
      htfBias,
      crt,
      sweep,
      structureBreak,
      rejection
    }
  };
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
        c.datetime ||
        c.time,

      open:
        Number(c.open),

      high:
        Number(c.high),

      low:
        Number(c.low),

      close:
        Number(c.close),

      isOpen:
        !!c.isOpen
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
// HIGHER-TIMEFRAME BIAS
// 4H + 1H ONLY
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

  let upperTouches = 0;
  let lowerTouches = 0;

  const tolerance =
    range * 0.15;

  for (
    const candle of recent
  ) {
    if (
      Math.abs(
        candle.high - high
      ) <= tolerance
    ) {
      upperTouches++;
    }

    if (
      Math.abs(
        candle.low - low
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
// OPTIONAL LIQUIDITY SWEEP
// ============================================================

function detectLiquiditySweep(
  candles,
  crt,
  structure
) {
  const current =
    candles[
      candles.length - 1
    ];

  if (!current) {
    return null;
  }

  if (
    crt &&
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
    crt &&
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
// BOS / MSS
// ============================================================

function detectBOSMSS(
  candles,
  structure,
  direction
) {
  if (!structure) {
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
    direction === "bullish"
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
    direction === "bearish"
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
  if (!structureBreak) {
    return null;
  }

  if (
    structureBreak.direction ===
    "bullish"
  ) {
    const low =
      sweep?.level ||
      findRecentLow(candles);

    return {
      direction: "bullish",
      low,
      high:
        structureBreak.level
    };
  }

  const high =
    sweep?.level ||
    findRecentHigh(candles);

  return {
    direction: "bearish",
    high,
    low:
      structureBreak.level
  };
}


// ============================================================
// FIBONACCI RETRACEMENT
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
  direction,
  structureBreak
) {
  if (!structureBreak) {
    return null;
  }

  const breakIndex =
    candles.findIndex(
      c =>
        (
          direction === "bullish"
            ? c.close >
              structureBreak.level
            : c.close <
              structureBreak.level
        )
    );

  const start =
    breakIndex > 0
      ? breakIndex - 1
      : candles.length - 2;

  for (
    let i =
      start;

    i >=
      Math.max(
        0,
        start - 8
      );

    i--
  ) {
    const candle =
      candles[i];

    if (
      direction === "bullish" &&
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
      direction === "bearish" &&
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
  direction
) {
  if (
    candles.length < 3
  ) {
    return null;
  }

  const i =
    candles.length - 1;

  const c1 =
    candles[i - 2];

  const c3 =
    candles[i];

  if (
    direction === "bullish" &&
    c1.high < c3.low
  ) {
    return {
      direction: "bullish",
      low: c1.high,
      high: c3.low
    };
  }

  if (
    direction === "bearish" &&
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
  fib,
  orderBlock,
  fvg,
  direction
) {
  if (
    !fib ||
    !orderBlock
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

  let fibRetracement = false;

  if (
    direction === "bullish"
  ) {
    fibRetracement =
      price <= fib["38.2"] &&
      price >= fib["61.8"];
  } else {
    fibRetracement =
      price >= fib["38.2"] &&
      price <= fib["61.8"];
  }

  const obTouch =
    priceInside(
      price,
      orderBlock
    );

  const fvgTouch =
    priceInside(
      price,
      fvg
    );

  const recent =
    candles.slice(-5);

  const oppositeCount =
    recent.filter(c =>
      direction === "bullish"
        ? c.close < c.open
        : c.close > c.open
    ).length;

  return {
    valid:
      fibRetracement ||
      obTouch ||
      fvgTouch,

    fibRetracement,

    obTouch,

    fvgTouch,

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

  // Prefer OB.
  if (orderBlock) {
    candidates.push({
      value:
        midpoint(
          orderBlock.low,
          orderBlock.high
        ),
      priority: 1
    });
  }

  // Then FVG.
  if (fvg) {
    candidates.push({
      value:
        midpoint(
          fvg.low,
          fvg.high
        ),
      priority: 2
    });
  }

  // Then 50% Fib retracement.
  if (fib) {
    candidates.push({
      value:
        fib["50"],
      priority: 3
    });
  }

  if (!candidates.length) {
    return currentPrice;
  }

  candidates.sort(
    (a, b) => {
      const distance =
        Math.abs(
          a.value -
          currentPrice
        ) -
        Math.abs(
          b.value -
          currentPrice
        );

      if (distance !== 0) {
        return distance;
      }

      return (
        a.priority -
        b.priority
      );
    }
  );

  return candidates[0].value;
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
        : orderBlock.low -
          atr * 0.10;

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
        : orderBlock.high +
          atr * 0.10;

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
// CONFIRMATION SCORE
// ============================================================

function calculateScore(x) {
  let score = 0;

  if (
    x.htfBias &&
    x.htfBias !== "neutral"
  ) {
    score += 2;
  }

  if (x.crt) {
    score += 1;
  }

  // Optional.
  if (x.sweep) {
    score += 1;
  }

  if (x.structureBreak) {
    score += 3;
  }

  // Mandatory OB.
  if (x.orderBlock) {
    score += 3;
  }

  if (x.fvg) {
    score += 1;
  }

  if (
    x.fib &&
    x.pullback &&
    x.pullback.fibRetracement
  ) {
    score += 2;
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
// TRADE REASON
// ============================================================

function buildTradeReason({
  instrument,
  direction,
  currentPrice,
  entry,
  fib,
  orderBlock,
  sweep,
  structureBreak
}) {
  const side =
    direction === "bullish"
      ? "buy"
      : "sell";

  const obLow =
    roundPrice(
      orderBlock.low
    );

  const obHigh =
    roundPrice(
      orderBlock.high
    );

  const fib50 =
    roundPrice(
      fib["50"]
    );

  const mssText =
    structureBreak?.type ||
    "structure break";

  let reason =
    `Price is showing a ${side} structure with a valid ${mssText} and a valid order block around ${obLow}–${obHigh}. `;

  if (sweep) {
    reason +=
      `Liquidity was also swept around ${roundPrice(sweep.level)} before the move. `;
  }

  reason +=
    `I like the ${side} only on the retracement toward the ${fib50} Fibonacci level / order block around the planned entry — don't chase at the current price.`;

  return reason;
}


// ============================================================
// DEVELOPING REASON
// ============================================================

function buildDevelopingReason({
  instrument,
  direction,
  currentPrice,
  entry,
  rejection,
  sweep,
  structureBreak,
  structure
}) {
  const side =
    direction === "bullish"
      ? "buy"
      : "sell";

  let reason =
    `Price is developing a ${side} setup with market structure supporting the move. `;

  if (rejection) {
    reason +=
      `Price is rejecting the ${roundPrice(rejection.level)} level. `;
  }

  if (structureBreak) {
    reason +=
      `A ${structureBreak.type} is developing around ${roundPrice(structureBreak.level)}. `;
  }

  if (sweep) {
    reason +=
      `Liquidity was swept around ${roundPrice(sweep.level)}. `;
  }

  reason +=
    `I like the ${side} only on the retrace into the planned entry — don't chase at current price.`;

  return reason;
}


// ============================================================
// AUTOMATIC TELEGRAM SCANNER
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

  if (!env.TELEGRAM_CHAT_ID) {
    console.error(
      "TELEGRAM_CHAT_ID is missing"
    );

    return;
  }

  try {
    const signals =
      await generateSignals();

    for (
      const signal of signals
    ) {
      if (
        signal.status ===
        "NO SIGNAL"
      ) {
        continue;
      }

      const message =
        formatTelegramSignal(
          signal
        );

      await sendTelegramMessage(
        env.TELEGRAM_CHAT_ID,
        message,
        env.TELEGRAM_BOT_TOKEN
      );
    }

  } catch (error) {
    console.error(
      "Automatic scan error:",
      error
    );
  }
}


// ============================================================
// TELEGRAM HANDLER
// ============================================================

async function handleTelegramMessage(
  message,
  env
) {
  const chatId =
    message.chat?.id;

  const text =
    message.text || "";

  if (!chatId) {
    return;
  }

  if (
    text === "/start"
  ) {
    const welcome =
      `🔥 Welcome to CyberFX!

CyberFX is now connected.

Signal levels:

🟢 BUY REJECTION
🔴 SELL REJECTION
🟡 VALID BUY/SELL
🔥 CONFIRMED BUY/SELL

Markets:

XAU/USD
BTC/USD
NASDAQ
US OIL

Timeframes:

4H
1H
30M
15M

Target RR: 1:3`;

    await sendTelegramMessage(
      chatId,
      welcome,
      env.TELEGRAM_BOT_TOKEN
    );

    return;
  }

  if (
    text === "/signal" ||
    text === "/signals"
  ) {
    try {
      const signals =
        await generateSignals();

      const activeSignals =
        signals.filter(
          s =>
            s.status !==
            "NO SIGNAL"
        );

      if (!activeSignals.length) {
        await sendTelegramMessage(
          chatId,
          "CYBERFX\n\nNo active rejection, valid setup, or confirmed signal at the moment.",
          env.TELEGRAM_BOT_TOKEN
        );

        return;
      }

      for (
        const signal of
        activeSignals
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
        "CYBERFX\n\nSignal engine temporarily unavailable.",
        env.TELEGRAM_BOT_TOKEN
      );
    }
  }
}


// ============================================================
// TELEGRAM OUTPUT
// ============================================================

function formatTelegramSignal(
  signal
) {
  // ==========================================================
  // REJECTION
  // ==========================================================

  if (
    signal.status ===
    "REJECTION"
  ) {
    const icon =
      signal.direction === "BUY"
        ? "🟢"
        : "🔴";

    return `${icon} CYBERFX ${signal.direction} REJECTION

${signal.instrument}

Entry TF: ${signal.entryTF}

Rejection Level: ${signal.rejectionLevel}

Current Price: ${signal.price}

Reason:
${signal.reason}

⚠️ WATCH FOR RETRACEMENT`;
  }

  // ==========================================================
  // VALID SETUP
  // ==========================================================

  if (
    signal.status ===
    "VALID SETUP"
  ) {
    return `🟡 CYBERFX VALID ${signal.direction}

${signal.instrument}

Entry TF: ${signal.entryTF}

Entry: ${signal.entry}

SL: ${signal.stopLoss}

TP: ${signal.takeProfit}

RR: 1:3

Reason:
${signal.reason}

⚠️ VALID SETUP — DO NOT CHASE PRICE`;
  }

  // ==========================================================
  // CONFIRMED
  // ==========================================================

  if (
    signal.status ===
    "CONFIRMED"
  ) {
    return `🔥 CYBERFX CONFIRMED ${signal.direction}

${signal.instrument}

Entry TF: ${signal.entryTF}

Entry: ${signal.entry}

SL: ${signal.stopLoss}

TP: ${signal.takeProfit}

RR: 1:3

Reason:
${signal.reason}

✅ CONFIRMED`;
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
    return;
  }

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
            chat_id: chatId,
            text
          })
      }
    );

  return response.json();
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
    ) / values.length
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


function findRecentLow(
  candles
) {
  return Math.min(
    ...candles
      .slice(-10)
      .map(
        c => c.low
      )
  );
}


function findRecentHigh(
  candles
) {
  return Math.max(
    ...candles
      .slice(-10)
      .map(
        c => c.high
      )
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

  return names[tf] || tf;
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


// ============================================================
// SIGNAL PRIORITY
// ============================================================

const SIGNAL_PRIORITY = {
  "REJECTION": 1,
  "VALID SETUP": 2,
  "CONFIRMED": 3
};
