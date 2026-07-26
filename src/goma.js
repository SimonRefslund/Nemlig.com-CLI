import { withRetry } from "./retry.js";
import { USER_AGENT } from "./version.js";

const GOMA_ORIGIN = "https://api.goma.gg";

/**
 * goma.gg runs a Supabase backend. This is the publishable (row-level-security
 * protected) key its own public web client ships with — it grants no more than
 * anonymous browsing of goma.gg does. Override with GOMA_API_KEY if it rotates.
 */
const GOMA_PUBLIC_KEY = "sb_publishable_5oBbD8YuxtVjYKBx4pNJzg_hOe593yN";

const SEARCH_RPC = "search_products_public_v1";
const HISTORY_RPC = "get_product_price_history_v1";
const DEFAULT_TIMEOUT_MS = 20_000;

/** Store names accepted by --store, as goma.gg spells them. */
export const GOMA_STORES = [
  "REMA 1000",
  "Netto",
  "365discount",
  "Lidl",
  "Wolt Market",
  "Føtex",
  "SuperBrugsen",
  "MENY",
  "Bilka",
  "Kvickly",
  "Brugsen",
  "Spar",
  "Løvbjerg",
  "Nemlig",
  "ABC Lavpris",
  "Min Købmand",
];

export const NEMLIG_STORE = "Nemlig";

export const GOMA_SORTS = {
  relevance: "similarity DESC",
  "price-asc": "current_price ASC NULLS LAST",
  "price-desc": "current_price DESC NULLS LAST",
  discount: "is_on_sale DESC, discount_percentage DESC NULLS LAST, similarity DESC",
  "name-asc": "product_name ASC NULLS LAST",
  "name-desc": "product_name DESC NULLS LAST",
};

export class GomaApiError extends Error {
  /** `usage: true` marks a bad argument rather than a goma.gg failure. */
  constructor(message, { status, cause, usage = false } = {}) {
    super(message, { cause });
    this.name = "GomaApiError";
    this.status = status;
    this.usage = usage;
  }
}

/** Resolves a user-supplied store name to goma.gg's spelling. */
export function resolveStore(input) {
  const normalized = String(input ?? "").toLowerCase().replace(/[^a-z0-9æøå]/g, "");
  const match = GOMA_STORES.find(
    (store) => store.toLowerCase().replace(/[^a-z0-9æøå]/g, "") === normalized,
  );
  if (!match) {
    throw new GomaApiError(
      `Unknown store "${input}". Known stores: ${GOMA_STORES.join(", ")}`,
      { usage: true },
    );
  }
  return match;
}

export class GomaApi {
  constructor({
    fetchImpl = globalThis.fetch,
    origin = process.env.GOMA_API_ORIGIN || GOMA_ORIGIN,
    apiKey = process.env.GOMA_API_KEY || GOMA_PUBLIC_KEY,
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required");
    }
    this.fetchImpl = fetchImpl;
    this.origin = origin;
    this.apiKey = apiKey;
  }

  get timeoutMs() {
    const configured = Number(process.env.NEMLIG_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_TIMEOUT_MS;
  }

  async search(query, {
    stores = null,
    saleOnly = false,
    sort = "relevance",
    limit = 20,
    offset = 0,
  } = {}) {
    const orderBy = GOMA_SORTS[sort];
    if (!orderBy) {
      throw new GomaApiError(
        `Unknown sort "${sort}". Use one of: ${Object.keys(GOMA_SORTS).join(", ")}`,
        { usage: true },
      );
    }

    const body = {
      p_search_term: String(query ?? "").trim(),
      p_on_sale_only: saleOnly,
      p_category_filter: null,
      p_department_filter: null,
      p_store_filter: stores?.length ? stores.map(resolveStore) : null,
      p_food_departments: null,
      p_is_available_only: true,
      p_my_products_only: false,
      p_previously_bought_only: false,
      p_labels_filter: null,
      p_order_by_clause: orderBy,
      p_limit_val: limit,
      p_offset_val: offset,
      // Anonymous, and opted out of goma.gg's search analytics.
      p_session_id: null,
      p_log_search: false,
      p_source: null,
    };

    const payload = await this.rpc(SEARCH_RPC, body);
    return {
      products: payload?.products ?? [],
      total: payload?.total_count ?? 0,
      onSale: payload?.total_on_sale_count ?? 0,
      departments: payload?.departments ?? [],
      categories: payload?.categories ?? [],
    };
  }

  /**
   * A year of daily prices for one goma.gg product, so a "cheaper" price can
   * be judged against what the product normally costs rather than taken at
   * face value.
   */
  async priceHistory(productId, { days = 365 } = {}) {
    if (!productId) throw new GomaApiError("A goma.gg product id is required");
    const payload = await this.rpc(HISTORY_RPC, {
      p_product_id: String(productId),
      p_days: days,
      p_limit: days,
    });
    return {
      productId: String(productId),
      days,
      points: (payload?.points ?? [])
        .filter((point) => point?.price != null)
        .map((point) => ({
          date: String(point.validFrom ?? point.createdAt ?? "").slice(0, 10),
          price: Number(point.price),
          normalPrice: point.normalPrice == null ? null : Number(point.normalPrice),
          onSale: point.isOnSale === true,
        }))
        .filter((point) => point.date && Number.isFinite(point.price)),
      currentPrice: payload?.currentPrice ?? null,
      lowestPrice: payload?.lowestPrice ?? payload?.minPrice ?? null,
      highestPrice: payload?.highestPrice ?? payload?.maxPrice ?? null,
      averagePrice: payload?.averagePrice ?? null,
    };
  }

  async rpc(name, body) {
    const url = `${this.origin}/rest/v1/rpc/${name}`;
    const timeoutMs = this.timeoutMs;
    let response;
    try {
      // A read-only RPC despite the POST verb, so retrying is safe.
      response = await withRetry(() =>
        this.fetchImpl(url, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            apikey: this.apiKey,
            authorization: `Bearer ${this.apiKey}`,
            "user-agent": USER_AGENT,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      );
    } catch (cause) {
      if (cause?.name === "TimeoutError" || cause?.name === "AbortError") {
        throw new GomaApiError(
          `goma.gg did not respond within ${Math.round(timeoutMs / 1000)}s`,
          { cause },
        );
      }
      throw new GomaApiError(`Could not reach goma.gg: ${cause.message}`, { cause });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const hint = response.status === 401 || response.status === 403
        ? " The public goma.gg key may have rotated; set GOMA_API_KEY."
        : "";
      throw new GomaApiError(
        `goma.gg returned HTTP ${response.status}.${hint}${
          detail ? ` ${detail.slice(0, 200)}` : ""
        }`,
        { status: response.status },
      );
    }

    try {
      return await response.json();
    } catch (cause) {
      throw new GomaApiError("goma.gg returned invalid JSON", { cause });
    }
  }
}

/** Runs tasks with a concurrency cap so a large basket stays polite. */
export async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
