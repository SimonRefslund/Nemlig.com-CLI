import assert from "node:assert/strict";
import test from "node:test";

import { NemligApi, NemligApiError, internals } from "../src/api.js";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const settings = {
  CombinedProductsAndSitecoreTimestamp: "products-content",
  TimeslotUtc: "2026072612-120-240",
  DeliveryZoneId: 1,
  SitecorePublishedStamp: "content",
};

test("search bootstraps a session and calls the captured search endpoint", async () => {
  const calls = [];
  const api = new NemligApi({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("GetAsJson")) {
        return jsonResponse({ Settings: settings });
      }
      if (String(url).endsWith("/webapi/Token")) {
        return jsonResponse({ access_token: "anonymous-token", expires_in: 300 });
      }
      return jsonResponse({
        SearchQuery: "kaffe",
        Products: { Products: [], Start: 10, NumFound: 234 },
      });
    },
  });

  const result = await api.search("kaffe", { limit: 5, offset: 10 });
  const searchCall = calls.find((call) => call.url.includes("/searchgateway/api/search"));
  const url = new URL(searchCall.url);

  assert.equal(result.Products.NumFound, 234);
  assert.equal(url.searchParams.get("query"), "kaffe");
  assert.equal(url.searchParams.get("take"), "5");
  assert.equal(url.searchParams.get("skip"), "10");
  assert.equal(url.searchParams.get("timestamp"), "products-content");
  assert.equal(searchCall.options.headers.authorization, "Bearer anonymous-token");
});

test("session is reused while its token remains valid", async () => {
  let calls = 0;
  const api = new NemligApi({
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).includes("GetAsJson")) return jsonResponse({ Settings: settings });
      if (String(url).endsWith("/webapi/Token")) {
        return jsonResponse({ access_token: "token", expires_in: 300 });
      }
      return jsonResponse({ Suggestions: [] });
    },
  });

  await api.suggest("ka");
  await api.suggest("kaf");
  assert.equal(calls, 4);
});

test("product accepts a nemlig.com URL and extracts productdetailspot", async () => {
  let requestedUrl;
  const api = new NemligApi({
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return jsonResponse({
        content: [{ TemplateName: "productdetailspot", Id: "5035178" }],
      });
    },
  });

  const product = await api.product("https://www.nemlig.com/kaffe-oeko-5035178");
  assert.equal(product.Id, "5035178");
  assert.equal(
    requestedUrl,
    "https://www.nemlig.com/kaffe-oeko-5035178?GetAsJson=1",
  );
});

test("product resolves a bare ID via search, since only slugs are addressable", async () => {
  const requested = [];
  const api = new NemligApi({
    fetchImpl: async (url) => {
      const href = String(url);
      requested.push(href);
      if (href.includes("GetAsJson") && href.includes("kaffe-oeko")) {
        return jsonResponse({
          content: [{ TemplateName: "productdetailspot", Id: "5035178" }],
        });
      }
      if (href.includes("GetAsJson")) return jsonResponse({ Settings: settings });
      if (href.endsWith("/webapi/Token")) {
        return jsonResponse({ access_token: "token", expires_in: 300 });
      }
      return jsonResponse({
        Products: {
          Products: [
            { Id: "9999999", Url: "wrong-9999999" },
            { Id: "5035178", Url: "kaffe-oeko-5035178" },
          ],
        },
      });
    },
  });

  const product = await api.product("5035178");
  assert.equal(product.Id, "5035178");
  assert.ok(
    requested.some((href) =>
      href === "https://www.nemlig.com/kaffe-oeko-5035178?GetAsJson=1"
    ),
  );
});

test("an unknown product ID reports the ID rather than a slug error", async () => {
  const api = new NemligApi({
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("GetAsJson")) return jsonResponse({ Settings: settings });
      if (href.endsWith("/webapi/Token")) {
        return jsonResponse({ access_token: "token", expires_in: 300 });
      }
      return jsonResponse({ Products: { Products: [] } });
    },
  });
  await assert.rejects(() => api.product("1234567"), /No product found with ID 1234567/);
});

test("stalled requests fail with a timeout message instead of hanging", async () => {
  const api = new NemligApi({
    fetchImpl: async (url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason));
      }),
  });

  process.env.NEMLIG_TIMEOUT_MS = "50";
  try {
    await assert.rejects(
      () => api.websiteSettings(),
      (error) => error instanceof NemligApiError && /did not respond within/.test(error.message),
    );
  } finally {
    delete process.env.NEMLIG_TIMEOUT_MS;
  }
});

test("product rejects external URLs", async () => {
  const api = new NemligApi({ fetchImpl: async () => jsonResponse({}) });
  await assert.rejects(
    () => api.product("https://example.com/item"),
    /must point to nemlig\.com/,
  );
});

test("HTTP failures become useful API errors", async () => {
  const api = new NemligApi({
    fetchImpl: async () => new Response("blocked", { status: 403 }),
  });
  await assert.rejects(
    () => api.product("coffee-1"),
    (error) => error instanceof NemligApiError && error.status === 403,
  );
});

test("normalizes safe product paths", () => {
  assert.equal(
    internals.normalizeProductPath("/kaffe-oeko-5035178/"),
    "kaffe-oeko-5035178",
  );
  assert.throws(() => internals.normalizeProductPath("../secret"), /Invalid/);
});

test("authenticated basket writes include cookies, bearer token, and CSRF", async () => {
  const calls = [];
  const sessionStore = {
    async load() {
      return { Session: "signed-in-cookie" };
    },
    async save() {},
    async clear() {},
  };
  const api = new NemligApi({
    sessionStore,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/webapi/AntiForgery")) {
        return jsonResponse({ Header: "X-XSRF-TOKEN", Value: "csrf-value" });
      }
      if (String(url).endsWith("/webapi/Token")) {
        return jsonResponse({ access_token: "account-token", expires_in: 300 });
      }
      return jsonResponse({ Lines: [], ValidationFailures: [] });
    },
  });

  await api.setBasketItem("5035178", 2);
  const call = calls.find((item) => item.url.endsWith("/webapi/basket/AddToBasket"));
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers.cookie, "Session=signed-in-cookie");
  assert.equal(call.options.headers.authorization, "Bearer account-token");
  assert.equal(call.options.headers["X-XSRF-TOKEN"], "csrf-value");
  assert.deepEqual(JSON.parse(call.options.body), {
    ProductId: "5035178",
    quantity: 2,
    OriginalProductId: null,
    AffectPartialQuantity: false,
    RecipeId: null,
    disableQuantityValidation: false,
  });
});

test("account calls fail locally when there is no saved session", async () => {
  const api = new NemligApi({
    sessionStore: {
      async load() {
        return {};
      },
    },
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
  });
  await assert.rejects(() => api.getBasket(), /Not logged in/);
});

test("website settings use the captured app-settings endpoint", async () => {
  let requestedUrl;
  const api = new NemligApi({
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return jsonResponse({ BasketPageUrl: "/basket" });
    },
  });
  const result = await api.websiteSettings();
  assert.equal(result.BasketPageUrl, "/basket");
  assert.equal(
    requestedUrl,
    "https://www.nemlig.com/webapi/v2/AppSettings/Website",
  );
});

test("an anonymous current-user response is not reported as logged in", async () => {
  const api = new NemligApi({
    sessionStore: {
      async load() {
        return { Session: "expired" };
      },
      async save() {},
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/webapi/Token")) {
        return jsonResponse({ access_token: "anonymous", expires_in: 300 });
      }
      return jsonResponse({ IsLoggedIn: false });
    },
  });
  await assert.rejects(() => api.currentUser(), /no longer signed in/);
});
