export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/test-key") {
      return new Response(
        JSON.stringify({
          secret_exists: !!env.TWELVE_DATA_API_KEY,
          secret_length: env.TWELVE_DATA_API_KEY
            ? env.TWELVE_DATA_API_KEY.length
            : 0
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
