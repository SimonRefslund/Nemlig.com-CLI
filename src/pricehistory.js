/**
 * Judges a price against what the product has actually cost over the past year.
 *
 * A price being lower than another shop's says nothing about whether it is a
 * good price: a coffee at 66 kr can look like the cheapest option today and
 * still be one the shop discounts to 39 kr every few weeks. What matters is
 * where today sits in its own distribution, so the verdict is driven by the
 * share of days it was available for less.
 */

export const VERDICTS = [
  { max: 5, key: "lowest", label: "at its lowest this year" },
  { max: 20, key: "great", label: "near its lowest" },
  { max: 40, key: "good", label: "below its usual price" },
  { max: 60, key: "normal", label: "about its usual price" },
  { max: 85, key: "poor", label: "above its usual price" },
  { max: Infinity, key: "bad", label: "near its highest" },
];

function verdictFor(percentCheaper) {
  return VERDICTS.find((verdict) => percentCheaper <= verdict.max);
}

const round = (value, places = 2) =>
  value == null || !Number.isFinite(value) ? null : Number(value.toFixed(places));

/**
 * @param price the price being judged. Defaults to the history's own current
 *   price, but `compare` passes a rival shop's price to ask the same question
 *   about it.
 */
export function summarizePriceHistory(history, { price = null } = {}) {
  const points = (history?.points ?? []).filter((point) =>
    Number.isFinite(point.price)
  );
  const subject = price ?? history?.currentPrice ?? null;

  if (!points.length || subject == null) {
    return {
      productId: history?.productId ?? null,
      days: 0,
      price: subject,
      insufficientData: true,
    };
  }

  const prices = points.map((point) => point.price);
  const cheaperDays = prices.filter((value) => value < subject).length;
  const equalDays = prices.filter((value) => value === subject).length;
  const percentCheaper = Math.round((cheaperDays / prices.length) * 100);

  // Ranking on strictly-cheaper days alone misreads a shelf price that holds
  // steady: a product sitting at its yearly high for 239 of 365 days has only
  // 35% of days cheaper, which would score as a bargain. Splitting the ties
  // (the midrank convention) puts it where it belongs, near the top.
  const percentile = Math.round(
    ((cheaperDays + equalDays / 2) / prices.length) * 100,
  );
  const lowest = Math.min(...prices);
  const highest = Math.max(...prices);
  const average = prices.reduce((sum, value) => sum + value, 0) / prices.length;

  // The most recent day it cost strictly less. "At or below" would answer
  // "was it this price yesterday?", which is never the question.
  const lastCheaper = [...points].reverse().find((point) => point.price < subject);

  const lowestPoint = points.find((point) => point.price === lowest);

  return {
    productId: history.productId,
    days: prices.length,
    price: round(subject),
    lowest: round(lowest),
    highest: round(highest),
    average: round(average),
    lowestOn: lowestPoint?.date ?? null,
    percentCheaper,
    percentile,
    cheaperDays,
    equalDays,
    daysOnSale: points.filter((point) => point.onSale).length,
    aboveLowest: round(subject - lowest),
    lastCheaper: lastCheaper?.date ?? null,
    lastCheaperPrice: round(lastCheaper?.price ?? null),
    verdict: verdictFor(percentile).key,
    verdictLabel: verdictFor(percentile).label,
    insufficientData: false,
  };
}
