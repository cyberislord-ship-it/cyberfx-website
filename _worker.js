export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/login" || url.pathname === "/login.html") {
      return env.ASSETS.fetch(
        new Request(new URL("/login.html", request.url), request)
      );
    }

    if (url.pathname === "/register" || url.pathname === "/register.html") {
      return env.ASSETS.fetch(
        new Request(new URL("/register.html", request.url), request)
      );
    }

    if (url.pathname === "/dashboard" || url.pathname === "/dashboard.html") {
      return env.ASSETS.fetch(
        new Request(new URL("/dashboard.html", request.url), request)
      );
    }

    return env.ASSETS.fetch(request);
  }
};
