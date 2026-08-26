export export default {
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
        telegram_connected: !!env.TELEGRAM_BOT_TOKEN
      });
    }
    // =========================================================
    // RAW MARKET DATA
    // =========================================================
    if (url.pathname === "/api/signals") {
      if (!env.TWELVE_DATA_API_KEY) {
        return json({
          success: false,
          error: "TWELVE_DATA_API_KEY is missing"
        }, 500);
      }
      const data = await loadAllMarkets(env);
      return json({
        success: true,
        source: "Twelve Data",
        engine: "CyberFX",
        timeframes: ["1day", "4h", "1h", "30min", "15min"],
        data
      });
    }
    // =========================================================
    // GENERATE CURRENT SIGNALS
    // =========================================================
    if (url.pathname === "/api/generate-signals") {
      const result = await generateSignals(env);
      return json({
        success: true,
        engine: "CyberFX",
        signals: result
      });
    }
    // =========================================================
    // TELEGRAM WEBHOOK
    // =========================================================
    if (
      url.pathname === "/telegram/webhook" &&
      request.method === "POST"
    ) {
      try {
        const update = await request.json();
        if (update.message) {
          await handleTelegramMessage(update.message, env);
        }
        return json({ ok: true });
      } catch (error) {
        console.error("Telegram webhook error:", error);
        // Telegram expects a successful HTTP response.
        return json({ ok: true });
      }
    }
    // =========================================================
    // WEBSITE
    // =========================================================
    return env.ASSETS.fetch(request);
  },
  // ===========================================================
  // AUTOMATIC SCAN
  // ===========================================================
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutomaticScan(env));
  }
};
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
  { name: "1day", interval: "1day" },
  { name: "4h", interval: "4h" },
  { name: "1h", interval: "1h" },
  { name: "30min", interval: "30min" },
  { name: "15min", interval: "15min" }
];
const ENTRY_TIMEFRAMES = [
  "15min",
  "30min",
  "1h",
  "4h"
];
const MIN_SCORE = 10;
const CONFIRMED_SCORE = 13;
// ============================================================
// LOAD MARKET DATA
// ============================================================
async function loadAllMarkets(env) {
  const data = {};
  for (const [name, symbol] of Object.entries(INSTRUMENTS)) {
    data[name] = {};
    for (const tf of TIMEFRAMES) {
      data[name][tf.name] = await getCandles(
        symbol,
        tf.interval,
        env.TWELVE_DATA_API_KEY
      );
    }
  }
  return data;
}
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
// ============================================================
// MAIN SIGNAL ENGINE
// ============================================================
async function generateSignals(env) {
  const marketData = await loadAllMarkets(env);
  const results = [];
  for (const instrument of Object.keys(INSTRUMENTS)) {
    const market = marketData[instrument];
    if (!market) continue;
    let confirmed = null;
    for (const entryTF of ENTRY_TIMEFRAMES) {
      const result = analyzeInstrument(
        instrument,
        market,
        entryTF
      );
      if (
        result &&
        result.status === "CONFIRMED"
      ) {
        confirmed = result;
        break;
      }
    }
    if (confirmed) {
      results.push(confirmed);
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
  const entryData = market[entryTF];
  if (
    !entryData ||
    entryData.status !== "success" ||
    !entryData.candles ||
    entryData.candles.length < 30
  ) {
    return null;
  }
  const candles = normalizeCandles(
    entryData.candles
  );
  // Never use the currently forming candle.
  const closed = candles.slice(1);
  if (closed.length < 30) return null;
  // ----------------------------------------------------------
  // HIGHER TIMEFRAME BIAS
  // ----------------------------------------------------------
  const htfBias = determineHTFBias(market);
  if (htfBias === "neutral") {
    return null;
  }
  // ----------------------------------------------------------
  // STRUCTURE
  // ----------------------------------------------------------
  const structure = detectStructure(closed);
  if (
    structure.direction !== htfBias
  ) {
    return null;
  }
  // ----------------------------------------------------------
  // ACCUMULATION
  // ----------------------------------------------------------
  const accumulation = detectAccumulation(
    closed
  );
  // ----------------------------------------------------------
  // CRT
  // ----------------------------------------------------------
  const crt = detectCRT(
    closed,
    accumulation
  );
  // ----------------------------------------------------------
  // LIQUIDITY SWEEP
  // ----------------------------------------------------------
  const sweep = detectLiquiditySweep(
    closed,
    crt,
    structure
  );
  if (!sweep) {
    return null;
  }
  // ----------------------------------------------------------
  // DISPLACEMENT
  // ----------------------------------------------------------
  const displacement = detectDisplacement(
    closed,
    sweep
  );
  if (!displacement) {
    return null;
  }
  // ----------------------------------------------------------
  // BOS / MSS
  // ----------------------------------------------------------
  const structureBreak = detectBOSMSS(
    closed,
    structure,
    displacement
  );
  if (!structureBreak) {
    return null;
  }
  // ----------------------------------------------------------
  // IMPULSE + FIB
  // ----------------------------------------------------------
  const impulse = getImpulseLeg(
    closed,
    structureBreak,
    sweep
  );
  if (!impulse) {
    return null;
  }
  const fib = calculateFib(
    impulse,
    structureBreak.direction
  );
  // ----------------------------------------------------------
  // ORDER BLOCK
  // ----------------------------------------------------------
  const orderBlock = findOrderBlock(
    closed,
    displacement,
    structureBreak
  );
  // ----------------------------------------------------------
  // FVG
  // ----------------------------------------------------------
  const fvg = findFVG(
    closed,
    displacement
  );
  // ----------------------------------------------------------
  // HEALTHY PULLBACK
  // ----------------------------------------------------------
  const currentPrice =
    closed[closed.length - 1].close;
  const pullback = validatePullback(
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
  // ----------------------------------------------------------
  // ENTRY
  // ----------------------------------------------------------
  const entry = determineEntry(
    currentPrice,
    fib,
    orderBlock,
    fvg,
    structureBreak.direction
  );
  if (!entry) {
    return null;
  }
  // ----------------------------------------------------------
  // STRUCTURAL STOP
  // ----------------------------------------------------------
  const stopLoss = determineStopLoss(
    entry,
    structureBreak.direction,
    sweep,
    orderBlock,
    closed
  );
  if (!stopLoss) {
    return null;
  }
  // ----------------------------------------------------------
  // 2:6 TARGET
  //
  // 2:6 = 1:3 mathematically.
  // ----------------------------------------------------------
  const risk =
    structureBreak.direction === "bullish"
      ? entry - stopLoss
      : stopLoss - entry;
  if (risk <= 0) {
    return null;
  }
  const reward = risk * 3;
  const takeProfit =
    structureBreak.direction === "bullish"
      ? entry + reward
      : entry - reward;
  // ----------------------------------------------------------
  // MAJOR OPPOSING STRUCTURE CHECK
  // ----------------------------------------------------------
  if (
    blockedByOpposingLiquidity(
      closed,
      structureBreak.direction,
      takeProfit
    )
  ) {
    return null;
  }
  // ----------------------------------------------------------
  // SCORE
  // ----------------------------------------------------------
  const score = calculateScore({
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
  // Mandatory gate.
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
  if (score < CONFIRMED_SCORE) {
    return null;
  }
  return {
    instrument,
    direction:
      structureBreak.direction === "bullish"
        ? "BUY"
        : "SELL",
    entryTF: formatTF(entryTF),
    entry: roundPrice(entry),
    stopLoss: roundPrice(stopLoss),
    takeProfit: roundPrice(takeProfit),
    riskReward: "2:6",
    status: "CONFIRMED",
    // Internal fields.
    // These are NOT sent to subscribers.
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
function normalizeCandles(values) {
  return values
    .map(c => ({
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }))
    .sort(
      (a, b) =>
        new Date(a.time) -
        new Date(b.time)
    );
}
// ============================================================
// ATR
// ============================================================
function ATR(candles, period = 14) {
  if (candles.length < period + 1) {
    return 0;
  }
  const ranges = [];
  for (
    let i = candles.length - period;
    i < candles.length;
    i++
  ) {
    const current = candles[i];
    const previous = candles[i - 1];
    const tr = Math.max(
      current.high - current.low,
      Math.abs(
        current.high - previous.close
      ),
      Math.abs(
        current.low - previous.close
      )
    );
    ranges.push(tr);
  }
  return average(ranges);
}
// ============================================================
// MARKET STRUCTURE
// ============================================================
function detectStructure(candles) {
  const highs = [];
  const lows = [];
  for (let i = 2; i < candles.length - 2; i++) {
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
  if (highs.length < 2 || lows.length < 2) {
    return {
      direction: "neutral",
      highs,
      lows
    };
  }
  const h1 = highs[highs.length - 2];
  const h2 = highs[highs.length - 1];
  const l1 = lows[lows.length - 2];
  const l2 = lows[lows.length - 1];
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
function determineHTFBias(market) {
  const frames = [
    "1day",
    "4h",
    "1h"
  ];
  let bullish = 0;
  let bearish = 0;
  for (const tf of frames) {
    const data = market[tf];
    if (
      !data ||
      data.status !== "success"
    ) {
      continue;
    }
    const candles =
      normalizeCandles(data.candles)
        .slice(1);
    if (candles.length < 30) {
      continue;
    }
    const structure =
      detectStructure(candles);
    if (structure.direction === "bullish") {
      bullish++;
    }
    if (structure.direction === "bearish") {
      bearish++;
    }
  }
  if (bullish >= 2) return "bullish";
  if (bearish >= 2) return "bearish";
  return "neutral";
}
// ============================================================
// ACCUMULATION
// ============================================================
function detectAccumulation(candles) {
  const lookback = 12;
  if (candles.length < lookback) {
    return null;
  }
  const recent =
    candles.slice(-lookback);
  const high = Math.max(
    ...recent.map(c => c.high)
  );
  const low = Math.min(
    ...recent.map(c => c.low)
  );
  const range = high - low;
  const atr = ATR(candles);
  if (!atr || range > atr * 2) {
    return null;
  }
  let upperTouches = 0;
  let lowerTouches = 0;
  const tolerance =
    range * 0.15;
  for (const candle of recent) {
    if (
      Math.abs(candle.high - high) <=
      tolerance
    ) {
      upperTouches++;
    }
    if (
      Math.abs(candle.low - low) <=
      tolerance
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
    accumulation
      ? candles[candles.length - 2]
      : candles[candles.length - 2];
  if (!reference) {
    return null;
  }
  const range =
    reference.high -
    reference.low;
  const atr = ATR(candles);
  if (
    !range ||
    (atr && range < atr * 0.15)
  ) {
    return null;
  }
  return {
    high: reference.high,
    low: reference.low,
    time: reference.time
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
  if (!crt) return null;
  const current =
    candles[candles.length - 1];
  const previous =
    candles[candles.length - 2];
  // Bullish sweep:
  // price takes low then closes back above it.
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
  // Bearish sweep:
  // price takes high then closes back below it.
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
  // Structure liquidity sweep fallback.
  if (
    structure &&
    structure.lows.length
  ) {
    const swingLow =
      structure.lows[
        structure.lows.length - 1
      ];
    if (
      current.low < swingLow.price &&
      current.close > swingLow.price
    ) {
      return {
        direction: "bullish",
        level: swingLow.price,
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
      current.high > swingHigh.price &&
      current.close < swingHigh.price
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
  if (!sweep) return null;
  const current =
    candles[candles.length - 1];
  const previous10 =
    candles.slice(-11, -1);
  if (previous10.length < 10) {
    return null;
  }
  const averageBody =
    average(
      previous10.map(c =>
        Math.abs(c.close - c.open)
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
  if (!range) return null;
  const bodyRatio =
    body / range;
  const closeLocation =
    (current.close - current.low) /
    range;
  const bullish =
    current.close >
      current.open;
  const bearish =
    current.close <
      current.open;
  const bullishExtreme =
    closeLocation >= 0.75;
  const bearishExtreme =
    closeLocation <= 0.25;
  const validBody =
    body >= averageBody * 1.5;
  const validRange =
    bodyRatio >= 0.60;
  if (
    sweep.direction === "bullish" &&
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
    sweep.direction === "bearish" &&
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
    candles[candles.length - 1];
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
          structure.direction ===
          "bearish"
            ? "MSS"
            : "BOS",
        level: previousHigh.price
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
          structure.direction ===
          "bullish"
            ? "MSS"
            : "BOS",
        level: previousLow.price
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
// FIB
// ============================================================
function calculateFib(
  impulse,
  direction
) {
  if (!impulse) return null;
  if (direction === "bullish") {
    const range =
      impulse.high -
      impulse.low;
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
  const range =
    impulse.high -
    impulse.low;
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
  if (displacementIndex <= 0) {
    return null;
  }
  for (
    let i = displacementIndex - 1;
    i >= Math.max(0, displacementIndex - 5);
    i--
  ) {
    const candle = candles[i];
    if (
      structureBreak.direction ===
        "bullish" &&
      candle.close < candle.open
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
      candle.close > candle.open
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
  if (!displacement) return null;
  const i =
    candles.findIndex(
      c =>
        c.time ===
        displacement.candle.time
    );
  if (i < 2) {
    return null;
  }
  const c1 = candles[i - 2];
  const c3 = candles[i];
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
  if (!fib || !impulse) {
    return {
      valid: false
    };
  }
  const current =
    candles[candles.length - 1];
  const price =
    current.close;
  let fibZone = false;
  if (direction === "bullish") {
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
  if (!candidates.length) {
    return currentPrice;
  }
  // Use the candidate closest to current price.
  candidates.sort(
    (a, b) =>
      Math.abs(a - currentPrice) -
      Math.abs(b - currentPrice)
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
  if (!atr) return null;
  let sl;
  if (direction === "bullish") {
    sl = sweep
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
    sl = sweep
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
// OPPOSING LIQUIDITY
// ============================================================
function blockedByOpposingLiquidity(
  candles,
  direction,
  takeProfit
) {
  const structure =
    detectStructure(candles);
  if (direction === "bullish") {
    const highs =
      structure.highs;
    for (const swing of highs.slice(-5)) {
      if (
        swing.price > candles[candles.length - 1].close &&
        swing.price < takeProfit
      ) {
        return true;
      }
    }
  }
  if (direction === "bearish") {
    const lows =
      structure.lows;
    for (const swing of lows.slice(-5)) {
      if (
        swing.price < candles[candles.length - 1].close &&
        swing.price > takeProfit
      ) {
        return true;
      }
    }
  }
  return false;
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
  if (x.crt) score += 2;
  if (x.sweep) score += 2;
  if (x.structureBreak) score += 2;
  if (x.displacement) score += 2;
  if (x.orderBlock) score += 1;
  if (x.fvg) score += 1;
  if (
    x.fib &&
    x.pullback &&
    x.pullback.fibZone
  ) {
    score += 1;
  }
  if (
    x.accumulation
  ) {
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
async function runAutomaticScan(env) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error(
      "TELEGRAM_BOT_TOKEN is missing"
    );
    return;
  }
  const signals =
    await generateSignals(env);
  for (const signal of signals) {
    if (
      signal.status !== "CONFIRMED"
    ) {
      continue;
    }
    const message =
      formatTelegramSignal(signal);
    // Optional subscriber chat ID.
    // Only send automatically if TELEGRAM_CHAT_ID exists.
    if (env.TELEGRAM_CHAT_ID) {
      await sendTelegramMessage(
        env.TELEGRAM_CHAT_ID,
        message,
        env.TELEGRAM_BOT_TOKEN
      );
    }
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
  if (!chatId) return;
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
    const signals =
      await generateSignals(env);
    const confirmed =
      signals.filter(
        s =>
          s.status ===
          "CONFIRMED"
      );
    if (!confirmed.length) {
      await sendTelegramMessage(
        chatId,
        "CYBERFX\n\nNo confirmed signal at the moment.",
        env.TELEGRAM_BOT_TOKEN
      );
      return;
    }
    for (const signal of confirmed) {
      await sendTelegramMessage(
        chatId,
        formatTelegramSignal(signal),
        env.TELEGRAM_BOT_TOKEN
      );
    }
  }
}
// ============================================================
// CLEAN TELEGRAM OUTPUT
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
  if (!token) return;
  const response =
    await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json"
        },
        body: JSON.stringify({
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
function average(values) {
  if (!values.length) return 0;
  return (
    values.reduce(
      (a, b) => a + b,
      0
    ) / values.length
  );
}
function midpoint(a, b) {
  return (a + b) / 2;
}
function priceInside(
  price,
  zone
) {
  if (!zone) return false;
  return (
    price >= zone.low &&
    price <= zone.high
  );
}
function roundPrice(price) {
  if (!Number.isFinite(price)) {
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
    "1day": "1D"
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
