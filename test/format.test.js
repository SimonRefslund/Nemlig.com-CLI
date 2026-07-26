import assert from "node:assert/strict";
import test from "node:test";

import {
  minimumShortfall,
  renderBasket,
  renderCheckoutStatus,
  renderDeliveryDays,
  renderOrders,
} from "../src/format.js";

// Field names below mirror live GetBasket / GetBasicOrderHistory /
// GetDeliveryDays responses.

const basket = {
  Lines: [
    { Id: "5058497", Name: "Brooklyn Pulp Art Hazy IPA", Quantity: 5, Price: 100 },
    { Id: "5602284", Name: "Entrecote", Quantity: 1, Price: 49, DiscountSavings: 12 },
  ],
  MealBoxes: [],
  Recipes: [],
  NumberOfProducts: 24,
  NumberOfBags: 4,
  NumberOfDeposits: 5,
  TotalProductsPrice: 498.67,
  TotalBagsPrice: 23.8,
  TotalDepositsPrice: 5,
  DeliveryPrice: 20,
  TotalProductDiscountPrice: 201.85,
  TotalPrice: 547.47,
  IsMinTotalValid: false,
  MinimumOrderTotal: 500,
  IsMaxTotalValid: true,
  FormattedDeliveryTime: "søn. 26/07 kl. 14-18",
  ValidationFailures: [],
};

test("basket reports the product count, not the line count", () => {
  const output = renderBasket(basket);
  assert.match(output, /Products:\s+24 in 2 lines/);
});

test("basket surfaces discounts and the fee breakdown", () => {
  const output = renderBasket(basket);
  assert.match(output, /Saved:\s+201,85/);
  assert.match(output, /Bags:\s+23,80\skr\. \(4\)/);
  assert.match(output, /Deposit:\s+5,00\skr\. \(5\)/);
  assert.match(output, /Delivery fee:\s+20,00/);
  assert.match(output, /Total:\s+547,47/);
  assert.match(output, /−12,00\skr\./);
});

test("the minimum-order check is measured against the products subtotal", () => {
  // TotalPrice (547,47) clears 500, but the products subtotal (498,67) does not.
  assert.equal(minimumShortfall(basket).toFixed(2), "1.33");
  assert.match(renderBasket(basket), /1,33\skr\. below the 500,00\skr\. minimum order/);
  assert.equal(minimumShortfall({ ...basket, IsMinTotalValid: true }), null);
});

test("order history shows totals and delivery windows", () => {
  const output = renderOrders({
    Orders: [{
      OrderNumber: "1063490166",
      Total: 691.13,
      Status: 3,
      DeliveryTime: { Start: "2026-07-18T17:00:00", End: "2026-07-18T19:00:00" },
      IsEditable: false,
      IsCancellable: false,
    }],
    NumberOfPages: 4,
  });

  assert.match(output, /1063490166/);
  assert.match(output, /Sat, 18 Jul 2026 17:00–19:00/);
  assert.match(output, /691,13/);
  // The numeric Status enum is undocumented, so it must not be shown as a label.
  assert.doesNotMatch(output, /\b3\b\s*$/m);
  assert.match(output, /Page 1 of 4/);
});

const deliveryDays = {
  SelectedTimeSlotId: 2341121,
  SelectedDeliveryTime: "2026-07-26T14:00:00",
  DayRangeHours: [
    {
      Date: "2026-07-26T00:00:00",
      DayHours: [
        {
          Id: 2340979, StartHour: 6, EndHour: 8, DeliveryPrice: 22, Availability: 1,
          IsSelected: false, IsCheapHour: false, IsFreeHour: false, Type: 0,
        },
        {
          Id: 2341132, StartHour: 7, EndHour: 11, DeliveryPrice: 0, Availability: 1,
          IsSelected: false, IsCheapHour: true, IsFreeHour: true, Type: 0,
        },
        {
          Id: 2341121, StartHour: 14, EndHour: 18, DeliveryPrice: 20, Availability: 0,
          IsSelected: true, IsCheapHour: false, IsFreeHour: false, Type: 0,
        },
        {
          Id: 2341005, StartHour: 19, EndHour: 22, DeliveryPrice: 19, Availability: 0,
          IsSelected: false, IsCheapHour: false, IsFreeHour: false, Type: 0,
        },
      ],
    },
    { Date: "2026-07-27T00:00:00", DayHours: [
      {
        Id: 2341300, StartHour: 8, EndHour: 12, DeliveryPrice: 25, Availability: 0,
        IsSelected: false, IsCheapHour: false, IsFreeHour: false, Type: 0,
      },
    ] },
  ],
};

test("delivery slots are read out of DayRangeHours[].DayHours[]", () => {
  const output = renderDeliveryDays(deliveryDays);
  assert.match(output, /Sun, 26 Jul 2026/);
  assert.match(output, /2340979\s+06:00–08:00\s+22,00\skr\./);
  assert.match(output, /2341132\s+07:00–11:00\s+free\s+free/);
});

test("sold-out slots are hidden unless --all is given", () => {
  const filtered = renderDeliveryDays(deliveryDays);
  assert.doesNotMatch(filtered, /2341005/);
  assert.match(filtered, /Mon, 27 Jul 2026 — sold out/);
  assert.match(filtered, /2 sold out \(use --all to show\)/);

  const all = renderDeliveryDays(deliveryDays, { all: true });
  assert.match(all, /2341005/);
  assert.match(all, /2341300/);
});

test("the already-reserved slot stays visible even though it is unbookable", () => {
  const output = renderDeliveryDays(deliveryDays);
  assert.match(output, /2341121\s+14:00–18:00\s+20,00\skr\.\s+reserved/);
  assert.match(output, /reserved: 2341121 \(Sun, 26 Jul 2026 14:00\)/);
});

test("empty delivery responses say so rather than looking like a parse failure", () => {
  assert.match(renderDeliveryDays({ DayRangeHours: [] }), /No delivery days returned/);
});

test("checkout status explains why a check failed", () => {
  const output = renderCheckoutStatus({
    checkoutUrl: "https://www.nemlig.com/basket",
    readiness: {
      hasItems: true,
      minimumTotalValid: false,
      maximumTotalValid: true,
      hasDeliveryAddress: true,
      hasReservedTimeslot: true,
      validationFailures: [],
    },
    basket,
  });

  assert.match(output, /✗ Minimum total — 1,33\skr\. short of 500,00\skr\./);
  assert.match(output, /✓ Reserved timeslot — søn\. 26\/07 kl\. 14-18/);
  assert.match(output, /Delivery fee:\s+20,00/);
});
