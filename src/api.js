import { withRetry } from "./retry.js";
import { CookieJar, SessionStore } from "./session.js";
import { USER_AGENT } from "./version.js";

const SITE_ORIGIN = "https://www.nemlig.com";
const SEARCH_ORIGIN = "https://webapi.prod.knl.nemlig.it";
const CLIENT_VERSION = "11.235.1";
const DEFAULT_TIMEOUT_MS = 20_000;

export class NemligApiError extends Error {
  constructor(message, { status, url, cause } = {}) {
    super(message, { cause });
    this.name = "NemligApiError";
    this.status = status;
    this.url = url;
  }
}

function publicHeaders() {
  return {
    accept: "application/json",
    "device-size": "desktop",
    platform: "web",
    version: CLIENT_VERSION,
    "user-agent": USER_AGENT,
  };
}

function requestTimeout() {
  const configured = Number(process.env.NEMLIG_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TIMEOUT_MS;
}

function transportError(cause, url, timeoutMs) {
  if (cause?.name === "TimeoutError" || cause?.name === "AbortError") {
    return new NemligApiError(
      `nemlig.com did not respond within ${Math.round(timeoutMs / 1000)}s`,
      { url: String(url), cause },
    );
  }
  return new NemligApiError(`Could not reach nemlig.com: ${cause.message}`, {
    url: String(url),
    cause,
  });
}

export function todayIso() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function correlationId() {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function fetchJson(fetchImpl, url, options = {}) {
  let response;
  const timeoutMs = requestTimeout();

  try {
    response = await withRetry(() =>
      fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        ...options,
      })
    );
  } catch (cause) {
    throw transportError(cause, url, timeoutMs);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const suffix = detail ? `: ${detail.slice(0, 200)}` : "";
    throw new NemligApiError(
      `nemlig.com returned HTTP ${response.status}${suffix}`,
      { status: response.status, url: String(url) },
    );
  }

  try {
    return await response.json();
  } catch (cause) {
    throw new NemligApiError("nemlig.com returned invalid JSON", {
      status: response.status,
      url: String(url),
      cause,
    });
  }
}

/**
 * Product IDs printed by `search` are the trailing digits of the slug, and the
 * detail page is only addressable by the full slug.
 */
function productIdFromSlug(value) {
  const match = /(?:^|-)(\d{4,})$/.exec(String(value ?? "").trim());
  return match ? match[1] : null;
}

function normalizeProductPath(input) {
  const value = String(input).trim();
  if (!value) {
    throw new NemligApiError("A product slug or nemlig.com URL is required");
  }

  let path = value;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (!["nemlig.com", "www.nemlig.com"].includes(url.hostname)) {
      throw new NemligApiError("Product URLs must point to nemlig.com");
    }
    path = url.pathname;
  }

  path = path.replace(/^\/+|\/+$/g, "");
  if (!path || path.includes("..") || path.includes("?") || path.includes("#")) {
    throw new NemligApiError("Invalid product slug");
  }

  return path.split("/").map(encodeURIComponent).join("/");
}

export class NemligApi {
  constructor({
    fetchImpl = globalThis.fetch,
    sessionStore = new SessionStore(),
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required");
    }
    this.fetchImpl = fetchImpl;
    this.sessionStore = sessionStore;
    this.session = null;
    this.accountToken = null;
    this.accountLoaded = false;
    this.jar = new CookieJar();
    this.antiForgery = null;
  }

  async getSession() {
    if (this.session && this.session.expiresAt > Date.now() + 5_000) {
      return this.session;
    }

    const headers = publicHeaders();
    const [bootstrap, token] = await Promise.all([
      fetchJson(this.fetchImpl, `${SITE_ORIGIN}/?GetAsJson=1`, { headers }),
      fetchJson(this.fetchImpl, `${SITE_ORIGIN}/webapi/Token`, {
        headers: { ...headers, referer: `${SITE_ORIGIN}/` },
      }),
    ]);

    if (!bootstrap?.Settings || !token?.access_token) {
      throw new NemligApiError("nemlig.com session response is incomplete");
    }

    const expiresIn = Number(token.expires_in) || 300;
    this.session = {
      settings: bootstrap.Settings,
      accessToken: token.access_token,
      expiresAt: Date.now() + expiresIn * 1_000,
    };
    return this.session;
  }

  async search(query, { limit = 20, offset = 0 } = {}) {
    const session = await this.getSession();
    const settings = session.settings;
    const url = new URL("/searchgateway/api/search", SEARCH_ORIGIN);
    const params = {
      query,
      take: limit,
      skip: offset,
      recipeCount: 0,
      timestamp: settings.CombinedProductsAndSitecoreTimestamp,
      timeslotUtc: settings.TimeslotUtc,
      deliveryZoneId: settings.DeliveryZoneId,
      includeFavorites: 0,
      TimeSlotId: 0,
    };

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    return fetchJson(this.fetchImpl, url, {
      headers: this.authHeaders(session.accessToken),
    });
  }

  async suggest(query) {
    const session = await this.getSession();
    const url = new URL("/searchgateway/api/quick", SEARCH_ORIGIN);
    url.searchParams.set("query", query);
    url.searchParams.set(
      "correlationId",
      session.settings.SitecorePublishedStamp,
    );

    return fetchJson(this.fetchImpl, url, {
      headers: this.authHeaders(session.accessToken),
    });
  }

  /** Resolves a bare product ID to its slug via search. */
  async resolveProductSlug(productId) {
    const result = await this.search(String(productId), { limit: 5 });
    const products = result?.Products?.Products ?? [];
    const match = products.find((item) => String(item.Id) === String(productId));
    if (!match?.Url) {
      throw new NemligApiError(
        `No product found with ID ${productId}`,
      );
    }
    return match.Url;
  }

  async product(slugOrUrl) {
    const value = String(slugOrUrl ?? "").trim();
    if (/^\d+$/.test(value)) {
      return this.product(await this.resolveProductSlug(value));
    }
    const path = normalizeProductPath(slugOrUrl);
    const url = new URL(`/${path}`, SITE_ORIGIN);
    url.searchParams.set("GetAsJson", "1");
    const page = await fetchJson(this.fetchImpl, url, {
      headers: publicHeaders(),
    });
    const product = page?.content?.find(
      (item) => item?.TemplateName === "productdetailspot",
    );

    if (!product) {
      throw new NemligApiError(`No product found for "${slugOrUrl}"`, {
        url: String(url),
      });
    }
    return product;
  }

  async websiteSettings() {
    const page = await fetchJson(
      this.fetchImpl,
      `${SITE_ORIGIN}/webapi/v2/AppSettings/Website`,
      { headers: publicHeaders() },
    );
    if (!page?.BasketPageUrl) {
      throw new NemligApiError("nemlig.com settings response is incomplete");
    }
    return page;
  }

  async loadAccountSession() {
    if (this.accountLoaded) return;
    this.jar = new CookieJar(await this.sessionStore.load());
    this.accountLoaded = true;
  }

  async saveAccountSession() {
    await this.sessionStore.save(this.jar.toJSON());
  }

  async accountFetch(path, {
    method = "GET",
    body,
    requireLogin = true,
    useCsrf = method !== "GET" && method !== "HEAD",
  } = {}) {
    await this.loadAccountSession();
    if (requireLogin && this.jar.size === 0) {
      throw new NemligApiError(
        "Not logged in. Run: nemlig account login <email>",
        { status: 401 },
      );
    }

    if (useCsrf && !this.antiForgery) {
      await this.refreshAntiForgery();
    }
    if (!this.accountToken || this.accountToken.expiresAt <= Date.now() + 5_000) {
      await this.refreshAccountToken();
    }

    const headers = {
      ...publicHeaders(),
      authorization: `Bearer ${this.accountToken.accessToken}`,
      origin: SITE_ORIGIN,
      referer: `${SITE_ORIGIN}/`,
      "x-correlation-id": correlationId(),
    };
    const cookie = this.jar.header();
    if (cookie) headers.cookie = cookie;
    if (useCsrf && this.antiForgery) {
      headers[this.antiForgery.header] = this.antiForgery.value;
    }
    if (body !== undefined) headers["content-type"] = "application/json";

    const url = new URL(path, SITE_ORIGIN);
    const timeoutMs = requestTimeout();
    const send = () =>
      this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

    let response;
    try {
      // Writes are never retried: a retried AddToBasket could double a line.
      response = method === "GET" || method === "HEAD"
        ? await withRetry(send)
        : await send();
    } catch (cause) {
      throw transportError(cause, url, timeoutMs);
    }

    const cookiesChanged = this.jar.absorb(response.headers);
    if (cookiesChanged) await this.saveAccountSession();
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const sessionHint = response.status === 401
        ? " Session expired; run account login again."
        : "";
      throw new NemligApiError(
        `nemlig.com returned HTTP ${response.status}.${sessionHint}${
          detail ? ` ${detail.slice(0, 200)}` : ""
        }`,
        { status: response.status, url: String(url) },
      );
    }
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new NemligApiError("nemlig.com returned invalid JSON", {
        status: response.status,
        url: String(url),
        cause,
      });
    }
  }

  async refreshAntiForgery() {
    await this.loadAccountSession();
    const headers = { ...publicHeaders() };
    const cookie = this.jar.header();
    if (cookie) headers.cookie = cookie;
    const response = await this.fetchImpl(
      `${SITE_ORIGIN}/webapi/AntiForgery`,
      { headers },
    );
    this.jar.absorb(response.headers);
    if (!response.ok) {
      throw new NemligApiError(
        `Could not initialize anti-forgery protection (HTTP ${response.status})`,
        { status: response.status, url: response.url },
      );
    }
    const value = await response.json();
    if (!value?.Header || !value?.Value) {
      throw new NemligApiError("Anti-forgery response is incomplete");
    }
    this.antiForgery = { header: value.Header, value: value.Value };
  }

  async refreshAccountToken() {
    await this.loadAccountSession();
    const headers = { ...publicHeaders(), referer: `${SITE_ORIGIN}/` };
    const cookie = this.jar.header();
    if (cookie) headers.cookie = cookie;
    const response = await this.fetchImpl(
      `${SITE_ORIGIN}/webapi/Token`,
      { headers },
    );
    this.jar.absorb(response.headers);
    if (!response.ok) {
      throw new NemligApiError(
        `Could not obtain a nemlig.com access token (HTTP ${response.status})`,
        { status: response.status, url: response.url },
      );
    }
    const token = await response.json();
    if (!token?.access_token) {
      throw new NemligApiError("Token response is incomplete");
    }
    this.accountToken = {
      accessToken: token.access_token,
      expiresAt: Date.now() + (Number(token.expires_in) || 300) * 1_000,
    };
  }

  async login(email, password) {
    if (!email || !password) {
      throw new NemligApiError("Email and password are required");
    }
    this.jar = new CookieJar();
    this.accountLoaded = true;
    this.accountToken = null;
    this.antiForgery = null;

    try {
      await this.refreshAntiForgery();
      await this.refreshAccountToken();
      await this.accountFetch("/webapi/login", {
        method: "POST",
        requireLogin: false,
        body: {
          Username: email,
          Password: password,
          CheckForExistingProducts: true,
          DoMerge: true,
          AppInstalled: false,
          SaveExistingBasket: false,
        },
      });
      this.accountToken = null;
      await this.refreshAccountToken();
      const user = await this.currentUser();
      await this.saveAccountSession();
      return user;
    } catch (error) {
      this.jar.clear();
      this.accountToken = null;
      this.antiForgery = null;
      await this.sessionStore.clear();
      throw error;
    }
  }

  async logout() {
    await this.loadAccountSession();
    try {
      if (this.jar.size) {
        await this.accountFetch("/webapi/logout", {
          method: "POST",
          requireLogin: false,
          body: null,
        });
      }
    } finally {
      this.jar.clear();
      this.accountToken = null;
      this.antiForgery = null;
      await this.sessionStore.clear();
    }
  }

  async currentUser() {
    const user = await this.accountFetch("/webapi/user/GetCurrentUser");
    if (!user || user.IsLoggedIn === false) {
      throw new NemligApiError(
        "The saved nemlig.com session is no longer signed in; run account login again.",
        { status: 401 },
      );
    }
    return user;
  }

  getBasket() {
    return this.accountFetch("/webapi/basket/GetBasket");
  }

  setBasketItem(productId, quantity) {
    return this.accountFetch("/webapi/basket/AddToBasket", {
      method: "POST",
      body: {
        ProductId: productId,
        quantity,
        OriginalProductId: null,
        AffectPartialQuantity: quantity === 0,
        RecipeId: null,
        disableQuantityValidation: false,
      },
    });
  }

  clearBasket() {
    return this.accountFetch("/webapi/basket/ClearBasket", {
      method: "POST",
      body: null,
    });
  }

  getOrders({ limit = 10, offset = 0 } = {}) {
    const url = new URL("/webapi/order/GetBasicOrderHistory", SITE_ORIGIN);
    url.searchParams.set("skip", String(offset));
    url.searchParams.set("take", String(limit));
    return this.accountFetch(url);
  }

  getOrder(orderNumber, { includeCanceled = false } = {}) {
    const url = new URL(
      "/webapi/order/GetOrderHistoryByOrderNumber",
      SITE_ORIGIN,
    );
    url.searchParams.set("orderNumber", String(orderNumber));
    url.searchParams.set("includeCanceled", String(includeCanceled));
    return this.accountFetch(url);
  }

  getDeliveryDays({ days = 7, startDate = todayIso(), subscriptions = false } = {}) {
    const url = new URL("/webapi/v2/Delivery/GetDeliveryDays", SITE_ORIGIN);
    url.searchParams.set("startDate", startDate);
    url.searchParams.set("showForSubscriptions", String(subscriptions));
    url.searchParams.set("days", String(days));
    return this.accountFetch(url);
  }

  selectDeliveryTime(timeslotId) {
    const url = new URL(
      "/webapi/Delivery/TryUpdateDeliveryTime",
      SITE_ORIGIN,
    );
    url.searchParams.set("timeslotId", String(timeslotId));
    return this.accountFetch(url, { method: "POST", body: null });
  }

  async checkoutStatus() {
    const basket = await this.getBasket();
    const [terms, ageRestrictions, settings] = await Promise.all([
      this.accountFetch("/webapi/Checkout/GetTermsAndAgreements"),
      this.accountFetch("/webapi/Checkout/GetAgeRestrictions"),
      this.websiteSettings(),
    ]);
    const lines = [
      ...(basket?.Lines ?? []),
      ...(basket?.MealBoxes ?? []),
      ...(basket?.Recipes ?? []),
    ];
    return {
      checkoutUrl: new URL(settings.BasketPageUrl || "/", SITE_ORIGIN).href,
      readiness: {
        hasItems: lines.length > 0,
        minimumTotalValid: basket?.IsMinTotalValid !== false,
        maximumTotalValid: basket?.IsMaxTotalValid !== false,
        hasDeliveryAddress: basket?.DeliveryAddress?.IsEmptyAddress === false,
        hasReservedTimeslot: basket?.DeliveryTimeSlot?.Reserved === true,
        validationFailures: basket?.ValidationFailures ?? [],
      },
      basket,
      terms,
      ageRestrictions,
    };
  }

  authHeaders(accessToken) {
    return {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      origin: SITE_ORIGIN,
      referer: `${SITE_ORIGIN}/`,
      "user-agent": USER_AGENT,
      "x-correlation-id": correlationId(),
    };
  }
}

export const internals = {
  SITE_ORIGIN,
  SEARCH_ORIGIN,
  normalizeProductPath,
  productIdFromSlug,
  publicHeaders,
};
