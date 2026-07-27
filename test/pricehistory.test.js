import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_HISTORY_DISTINCT_DATES,
  MIN_HISTORY_SPAN_DAYS,
  summarizePriceHistory,
} from "../src/pricehistory.js";

function history(prices, {
  productId = "netto-1-EA",
  onSale = () => false,
  dayOffset = (index) => index,
} = {}) {
  return {
    productId,
    currentPrice: prices.at(-1),
    points: prices.map((price, index) => ({
      date: new Date(Date.UTC(2025, 6, 14 + dayOffset(index))).toISOString().slice(0, 10),
      price,
      normalPrice: price,
      onSale: onSale(price),
    })),
  };
}

test("a price at the year's low is called out as such", () => {
  // A full year, because the subject's own day is one of the ties: over 365
  // points it moves the percentile by 0.1%, over five points by 10%.
  const summary = summarizePriceHistory(history([...Array(364).fill(20), 15]));
  assert.equal(summary.price, 15);
  assert.equal(summary.lowest, 15);
  assert.equal(summary.percentile, 0);
  assert.equal(summary.verdict, "lowest");
});

test("a price matching a low the product often sits at is good, not remarkable", () => {
  // At the year low, but it has been there 60 days — worth buying, not a rarity.
  const summary = summarizePriceHistory(
    history([...Array(305).fill(20), ...Array(60).fill(15)]),
  );
  assert.equal(summary.lowest, 15);
  assert.equal(summary.percentile, 8);
  assert.equal(summary.verdict, "great");
});

test("a price at the year's high is never reported as a good one", () => {
  // The real case that caught this: a shelf price holding steady at its high
  // for most of the year has few *strictly cheaper* days, so ranking on those
  // alone scored a year-high price as a bargain.
  const prices = [...Array(239).fill(8.29), ...Array(126).fill(6)];
  const summary = summarizePriceHistory({
    productId: "netto-2-EA",
    currentPrice: 8.29,
    points: prices.map((price, index) => ({
      date: new Date(Date.UTC(2025, 6, 14 + index)).toISOString().slice(0, 10),
      price,
      onSale: false,
    })),
  }, { price: 8.29 });

  assert.equal(summary.cheaperDays, 126);
  assert.equal(summary.equalDays, 239);
  assert.equal(summary.percentCheaper, 35, "only 35% of days were strictly cheaper");
  assert.equal(summary.percentile, 67, "but splitting the ties puts it near the top");
  assert.equal(summary.verdict, "poor");
  assert.match(summary.verdictLabel, /above its usual/);
});

test("the judged price can be someone else's, not just the current one", () => {
  // compare uses this to ask whether a rival shop's price is actually good.
  const past = history(Array(31).fill(50));
  assert.equal(summarizePriceHistory(past, { price: 30 }).verdict, "lowest");
  assert.equal(summarizePriceHistory(past, { price: 80 }).verdict, "bad");
});

test("the last strictly cheaper day is reported, not merely the last equal one", () => {
  const summary = summarizePriceHistory(history([20, 12, ...Array(29).fill(20)]));
  assert.equal(summary.lastCheaper, "2025-07-15");
  assert.equal(summary.lastCheaperPrice, 12);
});

test("min, max, average, and the date of the low are reported", () => {
  const summary = summarizePriceHistory(
    history([...Array(10).fill([10, 30, 20]).flat(), 20]),
  );
  assert.equal(summary.lowest, 10);
  assert.equal(summary.highest, 30);
  assert.equal(summary.average, 20);
  assert.equal(summary.lowestOn, "2025-07-14");
  assert.equal(summary.aboveLowest, 10);
});

test("days on offer are counted", () => {
  const summary = summarizePriceHistory(
    history([20, 12, ...Array(29).fill(20)], { onSale: (price) => price < 20 }),
  );
  assert.equal(summary.daysOnSale, 1);
});

test("five and twenty-nine distinct dates are insufficient for a verdict", () => {
  assert.equal(MIN_HISTORY_DISTINCT_DATES, 30);
  assert.equal(MIN_HISTORY_SPAN_DAYS, 30);
  for (const count of [5, 29]) {
    const summary = summarizePriceHistory(history(Array(count).fill(20)));
    assert.equal(summary.days, count);
    assert.equal(summary.spanDays, count - 1);
    assert.equal(summary.insufficientData, true);
    assert.equal(summary.verdict, undefined);
    assert.equal(summary.verdictLabel, undefined);
  }
});

test("thirty distinct dates spanning thirty days produce a verdict", () => {
  const summary = summarizePriceHistory(history(Array(30).fill(20), {
    dayOffset: (index) => index === 29 ? 30 : index,
  }));
  assert.equal(summary.days, 30);
  assert.equal(summary.spanDays, 30);
  assert.equal(summary.insufficientData, false);
  assert.equal(summary.verdict, "normal");
});

test("duplicate observations on one date do not satisfy the threshold", () => {
  const past = history(Array(30).fill(20), { dayOffset: () => 0 });
  const summary = summarizePriceHistory(past);
  assert.equal(summary.days, 1);
  assert.equal(summary.spanDays, 0);
  assert.equal(summary.insufficientData, true);
  assert.equal(summary.verdict, undefined);
});

test("descending input still reports the most recent cheaper calendar date", () => {
  const past = history([20, 12, ...Array(29).fill(20)]);
  past.points.reverse();
  const summary = summarizePriceHistory(past);
  assert.equal(summary.lastCheaper, "2025-07-15");
  assert.equal(summary.lastCheaperPrice, 12);
});

test("an empty history says so instead of inventing a verdict", () => {
  const summary = summarizePriceHistory({ productId: "x", points: [], currentPrice: null });
  assert.equal(summary.days, 0);
  assert.equal(summary.spanDays, 0);
  assert.equal(summary.insufficientData, true);
  assert.equal(summary.verdict, undefined);
});
