export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/test-twelve") {
      const testUrl = new URL("https://api.twelvedata.com/price");
      testUrl.searchParams.set("symbol", "XAU/USD");
      testUrl.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);

      const response = await fetch(testUrl);
      const data = await response.json();

      return new Response(
        JSON.stringify({
          http_status: response.status,
          twelve_data_status: data.status || null,
          code: data.code || null,
          message: data.message || null,
          has_price: !!data.price
        }),
        {
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    return env.ASSETS.fetch(request);
  }
};
