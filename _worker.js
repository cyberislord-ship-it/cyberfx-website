export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ==============================
    // CYBERFX SIGNAL API
    // ==============================
    if (url.pathname === "/api/signals") {
      try {
        const symbols = [
          { name: "XAU/USD", symbol: "XAU/USD" },
          { name: "BTC/USD", symbol: "BTC/USD" },
          { name: "NASDAQ", symbol: "NDX" },
          { name: "US OIL", symbol: "WTI/USD" }
        ];

        const intervals = [
          "1day",
          "4h",
          "1h",
          "30min",
          "15min"
        ];

        const results = {};

        for (const asset of symbols) {
          results[asset.name] = {};

          for (const interval of intervals) {

            const apiUrl =
              `https://api.twelvedata.com/time_series` +
              `?symbol=${encodeURIComponent(asset.symbol)}` +
              `&interval=${interval}` +
              `&outputsize=50` +
              `&apikey=${encodeURIComponent(
                env.TWELVE_DATA_API_KEY
              )}`;

            const response =
              await fetch(apiUrl);

            const data =
              await response.json();

            results[asset.name][interval] = data;
          }
        }

        return new Response(
          JSON.stringify({
            success: true,
            source: "Twelve Data",
            engine: "CyberFX",
            timeframes: intervals,
            data: results
          }),
          {
            headers: {
              "content-type":
                "application/json",
              "cache-control":
                "no-store"
            }
          }
        );

      } catch (error) {

        return new Response(
          JSON.stringify({
            success: false,
            error: error.message
          }),
          {
            status: 500,
            headers: {
              "content-type":
                "application/json"
            }
          }
        );
      }
    }


    // ==============================
    // WEBSITE ROUTES
    // ==============================

    if (
      url.pathname === "/login" ||
      url.pathname === "/login.html"
    ) {
      return env.ASSETS.fetch(
        new Request(
          new URL(
            "/login.html",
            request.url
          ),
          request
        )
      );
    }


    if (
      url.pathname === "/register" ||
      url.pathname === "/register.html"
    ) {
      return env.ASSETS.fetch(
        new Request(
          new URL(
            "/register.html",
            request.url
          ),
          request
        )
      );
    }


    if (
      url.pathname === "/dashboard" ||
      url.pathname === "/dashboard.html"
    ) {
      return env.ASSETS.fetch(
        new Request(
          new URL(
            "/dashboard.html",
            request.url
          ),
          request
        )
      );
    }


    // ==============================
    // DEFAULT WEBSITE RESPONSE
    // ==============================

    return env.ASSETS.fetch(request);
  }
};
