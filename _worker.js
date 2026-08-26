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
        api_key_connected: !!env.TWELVE_DATA_API_KEY,
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
        if (!env.PAYSTACK_SECRET_KEY) {
          return json({
            success: false,
            error: "PAYSTACK_SECRET_KEY is missing"
          }, 500);
        }

        const reference =
          url.searchParams.get("reference");

        if (!reference) {
          return json({
            success: false,
            error: "Payment reference is required"
          }, 400);
        }

        const verification =
          await verifyPaystackPayment(
            reference,
            env
          );

        return json(verification);

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
          result.payment_status ===
            "success"
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
        if (!env.TWELVE_DATA_API_KEY) {
          return json({
            success: false,
            error: "TWELVE_DATA_API_KEY is missing"
          }, 500);
        }

        const data =
          await loadAllMarkets(env);

        return json({
          success: true,
          source: "Twelve Data",
          engine: "CyberFX",
          timeframes:
            TIMEFRAMES.map(
              tf => tf.name
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
          engine: "CyberFX",
          error:
            error?.message ||
            String(error)
        }, 500);
      }
    }

    // =========================================================
    // GENERATE CURRENT SIGNALS
    // =========================================================
    if (
      url.pathname ===
      "/api/generate-signals"
    ) {
      try {
        const result =
          await generateSignals(env);

        return json({
          success: true,
          engine: "CyberFX",
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
// CYBERFX PLANS
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

  if (
    paymentStatus !== "success"
  ) {
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

  if (
    !plan ||
    !PLANS[plan]
  ) {
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

  if (
    !plan ||
    !PLANS[plan]
  ) {
    return {
      success: false,
      payment_status: "failed",
      error:
        "Unable to determine CyberFX subscription plan"
    };
  }

  const selectedPlan =
    PLANS[plan];

  // ----------------------------------------------------------
  // IMPORTANT:
  // Verify the amount received is exactly the plan amount.
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // Prevent duplicate subscription extension.
  // ----------------------------------------------------------

  if (
    existingPayment?.status ===
    "success"
  ) {
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
      plan_name:
        selectedPlan.name,
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

  // If the customer already has
  // active time remaining, extend
  // from the current expiry.
  if (
    activeSubscription?.expires_at
  ) {
    const currentExpiry =
      new Date(
        activeSubscription.expires_at
      );

    if (
      currentExpiry > now
    ) {
      startDate =
        currentExpiry;
    }
  }

  const expires =
    addMonths(
      startDate,
      selectedPlan.months
    );

  // ----------------------------------------------------------
  // Mark payment successful.
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // Create/update subscription.
  // ----------------------------------------------------------

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
      payment_reference =
        excluded.payment_reference,
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
    subscription.status !==
      "active" ||
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
// CONFIGURATION
// ============================================================

const INSTRUMENTS = {
  "XAU/USD": "XAU/USD",
  "BTC/USD": "BTC/USD",
  "NASDAQ": "NDX",
  "US OIL": "WTI"
};

const TIMEFRAMES = [
  {
    name: "1day",
    interval: "1day"
  },
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
    interval: "30min"
  },
  {
    name: "15min",
    interval: "15min"
  }
];

const ENTRY_TIMEFRAMES = [
  "15min",
  "30min",
  "1h",
  "4h"
];

const CONFIRMED_SCORE = 13;


// ============================================================
// LOAD MARKET DATA
// ============================================================

async function loadAllMarkets(env) {
  if (!env.TWELVE_DATA_API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

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
          tf.interval,
          env.TWELVE_DATA_API_KEY
        );
    }
  }

  return data;
}


// ============================================================
// TWELVE DATA
// ============================================================

async function getCandles(
  symbol,
  interval,
  apiKey
) {
  const apiUrl =
    new URL(
      "https://api.twelvedata.com/time_series"
    );

  apiUrl.searchParams.set(
    "symbol",
    symbol
  );

  apiUrl.searchParams.set(
    "interval",
    interval
  );

  apiUrl.searchParams.set(
    "outputsize",
    "100"
  );

  apiUrl.searchParams.set(
    "apikey",
    apiKey
  );

  try {
    const response =
      await fetch(apiUrl);

    const result =
      await response.json();

    if (
      !response.ok ||
      result.status === "error"
    ) {
      return {
        status: "error",
        code:
          result.code ||
          response.status,
        message:
          result.message ||
          "Twelve Data request failed"
      };
    }

    return {
      status: "success",
      symbol:
        result.meta?.symbol ||
        symbol,
      interval,
      candles:
        result.values || []
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

async function generateSignals(env) {
  const marketData =
    await loadAllMarkets(env);

  const results = [];

  for (
    const instrument
    of Object.keys(
      INSTRUMENTS
    )
  ) {
    const market =
      marketData[instrument];

    if (!market) {
      continue;
    }

    let confirmed = null;

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

      if (
        result &&
        result.status ===
          "CONFIRMED"
      ) {
        confirmed = result;
        break;
      }
    }

    if (confirmed) {
      results.push(
        confirmed
      );
    } else {
      results.push({
        instrument,
        status: "NO SIGNAL"
      });
    }
  }

  return results;
}


// ============================================================
// ANALYSIS
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
    candles.slice(0, -1);

  if (closed.length < 30) {
    return null;
  }

  const htfBias =
    determineHTFBias(market);

  if (
    htfBias === "neutral"
  ) {
    return null;
  }

  const structure =
    detectStructure(closed);

  if (
    structure.direction !==
    htfBias
  ) {
    return null;
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

  if (!crt) {
    return null;
  }

  const sweep =
    detectLiquiditySweep(
      closed,
      crt,
      structure
    );

  if (!sweep) {
    return null;
  }

  if (
    sweep.direction !==
    htfBias
  ) {
    return null;
  }

  const displacement =
    detectDisplacement(
      closed,
      sweep
    );

  if (!displacement) {
    return null;
  }

  const structureBreak =
    detectBOSMSS(
      closed,
      structure,
      displacement
    );

  if (!structureBreak) {
    return null;
  }

  const impulse =
    getImpulseLeg(
      closed,
      structureBreak,
      sweep
    );

  if (!impulse) {
    return null;
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

  const currentPrice =
    closed[
      closed.length - 1
    ].close;

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
    return null;
  }

  const entry =
    determineEntry(
      currentPrice,
      fib,
      orderBlock,
      fvg,
      structureBreak.direction
    );

  if (!entry) {
    return null;
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
    return null;
  }

  const risk =
    structureBreak.direction ===
    "bullish"
      ? entry - stopLoss
      : stopLoss - entry;

  if (risk <= 0) {
    return null;
  }

  const reward =
    risk * 3;

  const takeProfit =
    structureBreak.direction ===
    "bullish"
      ? entry + reward
      : entry - reward;

  if (
    blockedByOpposingLiquidity(
      closed,
      structureBreak.direction,
      takeProfit
    )
  ) {
    return null;
  }

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

  const mandatoryPassed =
    !!structure &&
    !!sweep &&
    !!structureBreak &&
    !!displacement &&
    !!pullback.valid &&
    risk > 0;

  if (!mandatoryPassed) {
    return null;
  }

  if (
    score < CONFIRMED_SCORE
  ) {
    return null;
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

    entry:
      roundPrice(entry),

    stopLoss:
      roundPrice(stopLoss),

    takeProfit:
      roundPrice(takeProfit),

    riskReward: "2:6",

    status: "CONFIRMED",

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
      pullback
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
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
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
// HIGHER TIMEFRAME BIAS
// ============================================================

function determineHTFBias(
  market
) {
  const frames = [
    "1day",
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
      ).slice(0, -1);

    if (
      candles.length < 30
    ) {
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
    (atr &&
      range < atr * 0.15)
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
    structure &&
    structure.lows.length
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
    structure &&
    structure.highs.length
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
    previous10.length <
    10
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

  const bullishExtreme =
    closeLocation >=
    0.75;

  const bearishExtreme =
    closeLocation <=
    0.25;

  const validBody =
    body >=
    averageBody * 1.5;

  const validRange =
    bodyRatio >= 0.60;

  if (
    sweep.direction ===
      "bullish" &&
    bullish &&
    bullishExtreme &&
    validBody &&
    validRange
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
    bearishExtreme &&
    validBody &&
    validRange
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
// IMPULSE LEG
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
// FIBONACCI
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

  const displacementIndex =
    candles.findIndex(
      c =>
        c.time ===
        displacement.candle.time
    );

  if (
    displacementIndex <= 0
  ) {
    return null;
  }

  for (
    let i =
      displacementIndex - 1;

    i >=
      Math.max(
        0,
        displacementIndex - 5
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
    recent.filter(c =>
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

  if (
    !candidates.length
  ) {
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
// OPPOSING LIQUIDITY
// ============================================================

function blockedByOpposingLiquidity(
  candles,
  direction,
  takeProfit
) {
  const structure =
    detectStructure(
      candles
    );

  const currentPrice =
    candles[
      candles.length - 1
    ].close;

  if (
    direction === "bullish"
  ) {
    for (
      const swing of
      structure.highs.slice(-5)
    ) {
      if (
        swing.price >
          currentPrice &&
        swing.price <
          takeProfit
      ) {
        return true;
      }
    }
  }

  if (
    direction === "bearish"
  ) {
    for (
      const swing of
      structure.lows.slice(-5)
    ) {
      if (
        swing.price <
          currentPrice &&
        swing.price >
          takeProfit
      ) {
        return true;
      }
    }
  }

  return false;
}


// ============================================================
// CONFIRMATION SCORE
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
// AUTOMATIC TELEGRAM SCANNER
// ============================================================

async function runAutomaticScan(
  env
) {
  if (
    !env.TELEGRAM_BOT_TOKEN
  ) {
    console.error(
      "TELEGRAM_BOT_TOKEN is missing"
    );

    return;
  }

  try {
    const signals =
      await generateSignals(
        env
      );

    for (
      const signal of signals
    ) {
      if (
        signal.status !==
        "CONFIRMED"
      ) {
        continue;
      }

      const message =
        formatTelegramSignal(
          signal
        );

      if (
        env.TELEGRAM_CHAT_ID
      ) {
        await sendTelegramMessage(
          env.TELEGRAM_CHAT_ID,
          message,
          env.TELEGRAM_BOT_TOKEN
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
// TELEGRAM MESSAGE HANDLER
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

Your Telegram is now connected to CyberFX.

You will receive confirmed trading signals here when available.`;

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
        await generateSignals(
          env
        );

      const confirmed =
        signals.filter(
          s =>
            s.status ===
            "CONFIRMED"
        );

      if (
        !confirmed.length
      ) {
        await sendTelegramMessage(
          chatId,
          "CYBERFX\n\nNo confirmed signal at the moment.",
          env.TELEGRAM_BOT_TOKEN
        );

        return;
      }

      for (
        const signal of
        confirmed
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
  return `🔥 CYBERFX SIGNAL

${signal.instrument} — ${signal.direction}

Entry TF: ${signal.entryTF}

Entry: ${signal.entry}

Stop Loss: ${signal.stopLoss}

Take Profit: ${signal.takeProfit}

Risk/Reward: 2:6

✅ CONFIRMED`;
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


function formatTF(
  tf
) {
  const names = {
    "15min": "15M",
    "30min": "30M",
    "1h": "1H",
    "4h": "4H",
    "1day": "1D"
  };

  return names[tf] || tf;
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
