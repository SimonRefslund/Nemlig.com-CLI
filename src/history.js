import { mapWithLimit } from "./goma.js";

/**
 * Turns past orders into a picture of what gets bought regularly and when it
 * is due again.
 *
 * The cadence here is deliberately measured in days between purchases rather
 * than in "every N orders": shopping trips are irregular, so counting orders
 * would make a weekly staple and a quarterly one look identical whenever they
 * happen to appear in the same baskets.
 */

const DAY_MS = 86_400_000;

/**
 * A product bought a couple of times and then dropped looks wildly "overdue"
 * under a naive cadence: two purchases a fortnight apart, then nothing for
 * four months, reads as 122 days late. Past this multiple of its own interval
 * the likelier explanation is that it stopped being bought at all, so it is
 * marked lapsed and kept out of reorder suggestions. The absolute floor stops
 * a genuinely short cadence from being written off after one missed week.
 */
const LAPSE_FACTOR = 2;
const LAPSE_FLOOR_DAYS = 45;

function toDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
  if (!match) return null;
  const [, year, month, day] = match;
  return Date.UTC(+year, +month - 1, +day);
}

export function daysBetween(from, to) {
  return Math.round((to - from) / DAY_MS);
}

/** Median, which shrugs off the one holiday gap that would skew a mean. */
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Normalises an order-detail response into the shape the analysis needs. */
export function normalizeOrder(order) {
  const day = toDay(order?.DeliveryTime?.Start) ?? toDay(order?.DeliveryDate);
  return {
    orderNumber: String(order?.OrderNumber ?? order?.Id ?? ""),
    day,
    lines: (order?.Lines ?? [])
      .filter((line) => line?.Id != null)
      .map((line) => ({
        id: String(line.Id),
        name: line.Name ?? "Product",
        quantity: Math.max(1, Number(line.Quantity) || 1),
        price: Number(line.ItemPrice ?? line.Price) || null,
      })),
  };
}

/**
 * @param asOf epoch ms for "today"; injected so the analysis is testable and
 *   so a --json run is reproducible.
 */
export function analyzePurchases(orders, { asOf = Date.now() } = {}) {
  const usable = orders.filter((order) => order && order.day != null)
    .sort((a, b) => a.day - b.day);
  const today = toDay(new Date(asOf).toISOString()) ?? asOf;

  const products = new Map();
  for (const order of usable) {
    // A product listed twice in one order is one purchase occasion.
    const seen = new Map();
    for (const line of order.lines) {
      const existing = seen.get(line.id);
      if (existing) existing.quantity += line.quantity;
      else seen.set(line.id, { ...line });
    }
    for (const line of seen.values()) {
      if (!products.has(line.id)) {
        products.set(line.id, {
          id: line.id,
          name: line.name,
          days: [],
          quantities: [],
          prices: [],
        });
      }
      const product = products.get(line.id);
      product.name = line.name;
      product.days.push(order.day);
      product.quantities.push(line.quantity);
      if (line.price != null) product.prices.push(line.price);
    }
  }

  const stats = [...products.values()].map((product) => {
    const intervals = product.days
      .slice(1)
      .map((day, index) => daysBetween(product.days[index], day));
    const typicalInterval = median(intervals);
    const lastDay = product.days[product.days.length - 1];
    const daysSince = daysBetween(lastDay, today);
    const dueInDays = typicalInterval == null ? null : typicalInterval - daysSince;

    return {
      id: product.id,
      name: product.name,
      orders: product.days.length,
      shareOfOrders: product.days.length / (usable.length || 1),
      typicalQuantity: Math.max(1, Math.round(median(product.quantities) ?? 1)),
      averagePrice: product.prices.length
        ? product.prices.reduce((sum, value) => sum + value, 0) / product.prices.length
        : null,
      firstBought: product.days[0],
      lastBought: lastDay,
      daysSince,
      typicalInterval,
      dueInDays,
      // Only a repeat purchase has a cadence worth predicting from.
      predictable: intervals.length >= 1,
      lapsed: typicalInterval > 0 &&
        daysSince > typicalInterval * LAPSE_FACTOR &&
        daysSince > LAPSE_FLOOR_DAYS,
    };
  });

  return {
    ordersAnalyzed: usable.length,
    from: usable[0]?.day ?? null,
    to: usable[usable.length - 1]?.day ?? null,
    products: stats.sort((a, b) => {
      if (b.orders !== a.orders) return b.orders - a.orders;
      return (a.dueInDays ?? Infinity) - (b.dueInDays ?? Infinity);
    }),
  };
}

/**
 * Products that look due. `tolerance` starts the window slightly before the
 * typical interval elapses, since a shop covers the days around it.
 */
export function dueNow(analysis, { minOrders = 2, tolerance = 0.85 } = {}) {
  return analysis.products
    .filter((product) =>
      product.predictable &&
      !product.lapsed &&
      product.orders >= minOrders &&
      product.typicalInterval > 0 &&
      product.daysSince >= product.typicalInterval * tolerance
    )
    .sort((a, b) => a.dueInDays - b.dueInDays);
}

/** Fetches the recent orders and their lines, then analyzes them. */
export async function loadHistory(api, {
  orders = 10,
  concurrency = 4,
  asOf = Date.now(),
  onProgress = null,
} = {}) {
  const list = await api.getOrders({ limit: orders });
  const summaries = Array.isArray(list) ? list : list?.Orders ?? [];
  const numbers = summaries
    .map((order) => order?.OrderNumber)
    .filter(Boolean);

  let done = 0;
  const details = await mapWithLimit(numbers, concurrency, async (number) => {
    try {
      return normalizeOrder(await api.getOrder(number));
    } catch {
      return null;
    } finally {
      onProgress?.(++done, numbers.length);
    }
  });

  const loaded = details.filter(Boolean);
  return {
    ...analyzePurchases(loaded, { asOf }),
    requested: numbers.length,
    failed: numbers.length - loaded.length,
  };
}

/**
 * Builds the set of basket writes for a reorder, skipping anything already in
 * the basket so running it twice is a no-op rather than a doubling.
 */
export function planReorder(candidates, basket) {
  const inBasket = new Map(
    (basket?.Lines ?? []).map((line) => [String(line.Id), Number(line.Quantity) || 0]),
  );
  const add = [];
  const skipped = [];
  for (const product of candidates) {
    if (inBasket.has(product.id)) {
      skipped.push({ ...product, alreadyInBasket: inBasket.get(product.id) });
    } else {
      add.push({ ...product, quantity: product.typicalQuantity });
    }
  }
  return { add, skipped };
}
