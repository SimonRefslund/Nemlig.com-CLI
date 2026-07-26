import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzePurchases,
  dueNow,
  loadHistory,
  median,
  normalizeOrder,
  planReorder,
} from "../src/history.js";

const TODAY = Date.UTC(2026, 6, 26); // 2026-07-26, fixed so cadences are stable.

function order(number, date, lines) {
  return normalizeOrder({
    OrderNumber: number,
    DeliveryTime: { Start: `${date}T17:00:00` },
    Lines: lines.map(([id, name, quantity, price]) => ({
      Id: id,
      Name: name,
      Quantity: quantity,
      ItemPrice: price ?? 10,
    })),
  });
}

test("median ignores a single outlying gap", () => {
  assert.equal(median([30, 32, 200]), 32);
  assert.equal(median([10, 20]), 15);
  assert.equal(median([]), null);
});

test("an order is normalised to id, quantity, and delivery day", () => {
  const normalized = order("1", "2026-07-18", [["5001", "Mælk", 2, 12.95]]);
  assert.equal(normalized.orderNumber, "1");
  assert.equal(normalized.day, Date.UTC(2026, 6, 18));
  assert.deepEqual(normalized.lines, [
    { id: "5001", name: "Mælk", quantity: 2, price: 12.95 },
  ]);
});

test("purchase cadence is measured in days, not in orders", () => {
  // Bought every ~35 days across three shops of very uneven spacing.
  const analysis = analyzePurchases([
    order("1", "2026-05-16", [["5001", "Mælk", 3]]),
    order("2", "2026-06-20", [["5001", "Mælk", 3]]),
    order("3", "2026-07-18", [["5002", "Kaffe", 1]]),
  ], { asOf: TODAY });

  const milk = analysis.products.find((product) => product.id === "5001");
  assert.equal(milk.orders, 2);
  assert.equal(milk.typicalInterval, 35);
  assert.equal(milk.daysSince, 36);
  assert.equal(milk.dueInDays, -1);
  assert.equal(milk.typicalQuantity, 3);

  // One purchase gives no interval at all, so nothing is predicted from it.
  const coffee = analysis.products.find((product) => product.id === "5002");
  assert.equal(coffee.predictable, false);
  assert.equal(coffee.dueInDays, null);
});

test("the same product twice in one order counts as one purchase occasion", () => {
  const analysis = analyzePurchases([
    order("1", "2026-06-20", [["5001", "Mælk", 1], ["5001", "Mælk", 2]]),
    order("2", "2026-07-18", [["5001", "Mælk", 3]]),
  ], { asOf: TODAY });

  const milk = analysis.products[0];
  assert.equal(milk.orders, 2, "two orders, not three lines");
  assert.equal(milk.typicalInterval, 28);
  assert.equal(milk.typicalQuantity, 3);
});

test("a product bought twice and then dropped is lapsed, not overdue", () => {
  // Taken from real history: two purchases a fortnight apart in March, then
  // nothing. A naive cadence calls this 122 days overdue.
  const analysis = analyzePurchases([
    order("1", "2026-02-26", [["5100", "Flåede tomater øko.", 4]]),
    order("2", "2026-03-12", [["5100", "Flåede tomater øko.", 4]]),
    order("3", "2026-07-18", [["5001", "Mælk", 1]]),
  ], { asOf: TODAY });

  const tomatoes = analysis.products.find((product) => product.id === "5100");
  assert.equal(tomatoes.typicalInterval, 14);
  assert.equal(tomatoes.daysSince, 136);
  assert.equal(tomatoes.lapsed, true);
  assert.deepEqual(dueNow(analysis, { minOrders: 2 }), []);
});

test("a staple one interval past its last purchase is due", () => {
  const analysis = analyzePurchases([
    order("1", "2026-04-26", [["5001", "Mælk", 3]]),
    order("2", "2026-05-16", [["5001", "Mælk", 3]]),
    order("3", "2026-06-20", [["5001", "Mælk", 3]]),
  ], { asOf: TODAY });

  const due = dueNow(analysis, { minOrders: 2 });
  assert.equal(due.length, 1);
  assert.equal(due[0].id, "5001");
  assert.equal(due[0].lapsed, false);
});

test("minOrders keeps one-off purchases out of suggestions", () => {
  const analysis = analyzePurchases([
    order("1", "2026-05-16", [["5001", "Mælk", 1], ["5300", "Impulskøb", 1]]),
    order("2", "2026-06-20", [["5001", "Mælk", 1]]),
  ], { asOf: TODAY });

  assert.deepEqual(dueNow(analysis, { minOrders: 2 }).map((p) => p.id), ["5001"]);
  assert.deepEqual(dueNow(analysis, { minOrders: 3 }), []);
});

test("a reorder never touches what is already in the basket", () => {
  const candidates = [
    { id: "5001", name: "Mælk", typicalQuantity: 3 },
    { id: "5002", name: "Kaffe", typicalQuantity: 1 },
  ];
  const plan = planReorder(candidates, { Lines: [{ Id: "5002", Quantity: 5 }] });

  assert.deepEqual(plan.add.map((p) => [p.id, p.quantity]), [["5001", 3]]);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].alreadyInBasket, 5);
});

test("loadHistory pulls each order's lines and survives one that fails", async () => {
  const api = {
    async getOrders({ limit }) {
      assert.equal(limit, 3);
      return {
        Orders: [
          { OrderNumber: "1" },
          { OrderNumber: "2" },
          { OrderNumber: "broken" },
        ],
      };
    },
    async getOrder(number) {
      if (number === "broken") throw new Error("HTTP 500");
      return {
        OrderNumber: number,
        DeliveryTime: { Start: number === "1" ? "2026-06-20T17:00:00" : "2026-07-18T17:00:00" },
        Lines: [{ Id: "5001", Name: "Mælk", Quantity: 2, ItemPrice: 12.95 }],
      };
    },
  };

  const analysis = await loadHistory(api, { orders: 3, asOf: TODAY });
  assert.equal(analysis.ordersAnalyzed, 2);
  assert.equal(analysis.failed, 1);
  assert.equal(analysis.products[0].orders, 2);
  assert.equal(analysis.products[0].averagePrice, 12.95);
});
