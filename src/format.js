const priceFormatter = new Intl.NumberFormat("da-DK", {
  style: "currency",
  currency: "DKK",
  minimumFractionDigits: 2,
});

export function formatPrice(value) {
  return Number.isFinite(Number(value))
    ? priceFormatter.format(Number(value))
    : "—";
}

function truncate(value, width) {
  const text = String(value ?? "");
  if (text.length <= width) return text;
  return width <= 1 ? "…".slice(0, width) : `${text.slice(0, width - 1)}…`;
}

function pad(value, width) {
  return truncate(value, width).padEnd(width);
}

function padStart(value, width) {
  return truncate(value, width).padStart(width);
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function effectiveNemligPrice(product, { quantity = 1 } = {}) {
  const campaign = product?.Campaign ?? {};
  const basePrice = finitePositive(product?.Price);
  const baseUnitPrice = finitePositive(product?.UnitPriceCalc);
  const campaignPrice = finitePositive(campaign.CampaignPrice);
  const campaignUnitPrice = finitePositive(campaign.CampaignUnitPrice);
  const minQuantity = finitePositive(campaign.MinQuantity);
  const totalPrice = finitePositive(campaign.TotalPrice);
  const quantityOffer = minQuantity > 1 && totalPrice != null
    ? { minQuantity, totalPrice }
    : null;
  const eligible = !quantityOffer || Number(quantity) >= minQuantity;
  const campaignApplied = eligible &&
    (campaignPrice != null || campaignUnitPrice != null);

  return {
    price: campaignApplied ? campaignPrice ?? basePrice : basePrice,
    unitPrice: campaignApplied ? campaignUnitPrice ?? baseUnitPrice : baseUnitPrice,
    basePrice,
    baseUnitPrice,
    campaignPrice,
    campaignUnitPrice,
    campaignApplied,
    quantityOffer,
  };
}

function formattedUnitPrice(value, label) {
  return value == null
    ? "—"
    : `${value.toLocaleString("da-DK")} ${label || ""}`.trim();
}

function unitPrice(product) {
  const effective = effectiveNemligPrice(product);
  const current = formattedUnitPrice(effective.unitPrice, product.UnitPriceLabel);
  if (!effective.campaignApplied || effective.baseUnitPrice == null ||
      effective.unitPrice === effective.baseUnitPrice) {
    return current;
  }
  return `${current} (base ${
    formattedUnitPrice(effective.baseUnitPrice, product.UnitPriceLabel)
  })`;
}

function productPrice(product) {
  const effective = effectiveNemligPrice(product);
  if (effective.quantityOffer) {
    return `${formatPrice(effective.basePrice)} (${
      effective.quantityOffer.minQuantity
    } for ${formatPrice(effective.quantityOffer.totalPrice)})`;
  }
  const current = formatPrice(effective.price);
  if (!effective.campaignApplied || effective.basePrice == null ||
      effective.price === effective.basePrice) {
    return current;
  }
  return `${current} (base ${formatPrice(effective.basePrice)})`;
}

// nemlig.com returns dates as "2026-07-26T00:00:00" with no zone. Reading the
// calendar fields out of the string avoids shifting the day in local time.
function parseApiDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(value ?? ""));
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00"] = match;
  return {
    date: new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute)),
    time: `${hour}:${minute}`,
  };
}

const dayFormatter = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatDay(value) {
  const parsed = parseApiDate(value);
  return parsed ? dayFormatter.format(parsed.date) : String(value ?? "—");
}

export function formatDateTime(value) {
  const parsed = parseApiDate(value);
  return parsed ? `${dayFormatter.format(parsed.date)} ${parsed.time}` : "—";
}

function formatWindow(start, end) {
  const from = parseApiDate(start);
  const to = parseApiDate(end);
  if (!from) return "—";
  return to ? `${from.time}–${to.time}` : from.time;
}

export function renderProducts(products, { total, offset = 0, columns = 100 } = {}) {
  if (!products.length) return "No products found.";

  const prices = products.map(productPrice);
  const unitPrices = products.map(unitPrice);
  let widths;
  if (columns < 80) {
    const available = Math.max(24, columns - 26);
    const priceWidth = Math.min(
      Math.max(12, ...prices.map((price) => price.length)),
      Math.max(12, available - 12),
    );
    widths = [8, Math.max(12, available - priceWidth), 12, priceWidth];
  } else {
    const available = Math.max(24, columns - 16);
    const maxPriceAndUnit = Math.max(27, available - 24);
    let priceWidth = Math.min(31, Math.max(13, ...prices.map((price) => price.length)));
    let unitPriceWidth = Math.min(
      32,
      Math.max(14, ...unitPrices.map((price) => price.length)),
    );
    while (priceWidth + unitPriceWidth > maxPriceAndUnit) {
      if (unitPriceWidth > 14 && unitPriceWidth >= priceWidth) unitPriceWidth -= 1;
      else if (priceWidth > 13) priceWidth -= 1;
      else break;
    }
    const textWidth = available - priceWidth - unitPriceWidth;
    const brandWidth = Math.min(18, Math.max(10, textWidth - 38));
    widths = [
      8,
      Math.max(14, Math.min(38, textWidth - brandWidth)),
      brandWidth,
      priceWidth,
      unitPriceWidth,
    ];
  }
  const compact = widths.length === 4;
  const headers = compact
    ? ["ID", "NAME", "BRAND", "PRICE"]
    : ["ID", "NAME", "BRAND", "PRICE", "UNIT PRICE"];

  const rows = products.map((product, index) => {
    const unavailable = product.Availability &&
      !(product.Availability.IsDeliveryAvailable &&
        product.Availability.IsAvailableInStock);
    const base = [
      product.Id,
      unavailable ? `${product.Name} (sold out)` : product.Name,
      product.Brand || "—",
      prices[index],
    ];
    if (!compact) base.push(unitPrices[index]);
    return base;
  });

  const lines = [
    headers.map((value, index) => pad(value, widths[index])).join("  ").trimEnd(),
    widths.map((width) => "─".repeat(width)).join("  "),
    ...rows.map((row) =>
      row.map((value, index) => pad(value, widths[index])).join("  ").trimEnd()
    ),
  ];

  if (Number.isFinite(total)) {
    const start = offset + 1;
    const end = offset + products.length;
    lines.push("", `Showing ${start}–${end} of ${total} products`);
  }
  return lines.join("\n");
}

export function renderSuggestions(result) {
  const lines = [];
  if (result.Suggestions?.length) {
    lines.push("Suggestions:", ...result.Suggestions.map((item) => `  ${item}`));
  }
  if (result.Categories?.length) {
    if (lines.length) lines.push("");
    lines.push(
      "Categories:",
      ...result.Categories.map((item) => `  ${item.Name}  https://www.nemlig.com${item.Url}`),
    );
  }
  return lines.length ? lines.join("\n") : "No suggestions found.";
}

export function renderProduct(product) {
  const effective = effectiveNemligPrice(product);
  const lines = [
    product.Name,
    `${product.Brand || "Unknown brand"} · ${product.Description || "No description"}`,
    "",
    `ID:          ${product.Id}`,
    `Price:       ${productPrice(product)}`,
    `Unit price:  ${unitPrice(product)}`,
    `Available:   ${
      product.Availability?.IsDeliveryAvailable &&
      product.Availability?.IsAvailableInStock
        ? "yes"
        : "no"
    }`,
    `Category:    ${[
      product.ProductMainGroupName,
      product.ProductCategoryGroupName,
      product.ProductSubGroupName,
    ].filter(Boolean).join(" › ")}`,
    `URL:         https://www.nemlig.com/${product.Url}`,
  ];

  if (product.Labels?.length) lines.push(`Labels:      ${product.Labels.join(", ")}`);
  if (product.Campaign) {
    const campaign = product.Campaign;
    lines.push(
      `Campaign:    ${product.CampaignAttribute || campaign.Type}${
        effective.quantityOffer
          ? ` (${effective.quantityOffer.minQuantity} for ${
            formatPrice(effective.quantityOffer.totalPrice)
          })`
          : ""
      }`,
    );
  }
  return lines.join("\n");
}

export function renderAccount(user) {
  const name = user?.Name || user?.FullName ||
    [user?.FirstName, user?.LastName].filter(Boolean).join(" ");
  return [
    "Logged in",
    name ? `Name:   ${name}` : null,
    user?.Email ? `Email:  ${user.Email}` : null,
    user?.Id ? `ID:     ${user.Id}` : null,
  ].filter(Boolean).join("\n");
}

function summaryRows(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${pad(`${label}:`, width + 1)}  ${value}`);
}

/**
 * The minimum-order check applies to the products subtotal, not to the grand
 * total, so a basket can exceed MinimumOrderTotal and still be invalid.
 */
export function minimumShortfall(basket) {
  if (!basket || basket.IsMinTotalValid !== false) return null;
  const minimum = Number(basket.MinimumOrderTotal);
  const products = Number(basket.TotalProductsPrice);
  if (!Number.isFinite(minimum) || !Number.isFinite(products)) return null;
  const missing = minimum - products;
  return missing > 0 ? missing : null;
}

export function renderBasket(basket) {
  const lines = basket?.Lines ?? [];
  const mealBoxes = basket?.MealBoxes ?? [];
  const recipes = basket?.Recipes ?? [];
  if (!lines.length && !mealBoxes.length && !recipes.length) {
    return "Basket is empty.";
  }

  const items = [
    ...lines.map((line) => ({
      quantity: Number(line.Quantity ?? 0),
      name: `${line.Name || line.ProductName || "Product"} (${line.Id})`,
      total: line.Price ?? line.TotalPrice ?? line.ItemPrice,
      saved: Number(line.DiscountSavings || 0),
    })),
    ...mealBoxes.map((box) => ({
      quantity: Number(box.Quantity ?? 1),
      name: box.Name || box.Title || "Meal box",
      total: box.Price ?? box.TotalPrice,
      saved: 0,
    })),
    ...recipes.map((recipe) => ({
      quantity: Number(recipe.Quantity ?? 1),
      name: recipe.Name || recipe.Title || "Recipe",
      total: recipe.Price ?? recipe.TotalPrice,
      saved: 0,
    })),
  ];

  const quantityWidth = Math.max(...items.map((item) => String(item.quantity).length));
  const nameWidth = Math.max(...items.map((item) => item.name.length));
  const output = items.map((item) =>
    `${padStart(item.quantity, quantityWidth)} × ${pad(item.name, nameWidth)}  ${
      padStart(formatPrice(item.total), 12)
    }${item.saved > 0 ? `  −${formatPrice(item.saved)}` : ""}`.trimEnd()
  );

  const products = basket?.NumberOfProducts;
  const rows = [[
    "Products",
    Number.isFinite(products)
      ? `${products} in ${items.length} line${items.length === 1 ? "" : "s"}`
      : `${items.length}`,
  ]];
  if (Number.isFinite(basket?.TotalProductsPrice)) {
    rows.push(["Subtotal", formatPrice(basket.TotalProductsPrice)]);
  }
  if (basket?.TotalBagsPrice) {
    rows.push(["Bags", `${formatPrice(basket.TotalBagsPrice)} (${basket.NumberOfBags ?? "?"})`]);
  }
  if (basket?.TotalDepositsPrice) {
    rows.push([
      "Deposit",
      `${formatPrice(basket.TotalDepositsPrice)} (${basket.NumberOfDeposits ?? "?"})`,
    ]);
  }
  if (Number.isFinite(basket?.DeliveryPrice)) {
    rows.push(["Delivery fee", formatPrice(basket.DeliveryPrice)]);
  }
  const saved = Number(basket?.TotalProductDiscountPrice || basket?.DiscountSavings || 0);
  if (saved > 0) rows.push(["Saved", formatPrice(saved)]);
  rows.push(["Total", formatPrice(basket?.TotalPrice)]);
  if (basket?.FormattedDeliveryTime) {
    rows.push(["Delivery time", basket.FormattedDeliveryTime]);
  }

  output.push("", ...summaryRows(rows));

  const shortfall = minimumShortfall(basket);
  if (shortfall != null) {
    output.push(
      `! ${formatPrice(shortfall)} below the ${
        formatPrice(basket.MinimumOrderTotal)
      } minimum order`,
    );
  }
  for (const failure of basket?.ValidationFailures ?? []) {
    output.push(`! ${failure?.Message || failure?.ErrorMessage || JSON.stringify(failure)}`);
  }
  return output.join("\n");
}

export function renderOrders(result) {
  const orders = Array.isArray(result)
    ? result
    : result?.Orders ?? result?.Items ?? [];
  if (!orders.length) return "No orders found.";

  const rows = orders.map((order) => {
    const window = order.DeliveryTime
      ? `${formatDay(order.DeliveryTime.Start)} ${
        formatWindow(order.DeliveryTime.Start, order.DeliveryTime.End)
      }`
      : order.OrderDate || order.DeliveryDate || "—";
    const flags = [
      order.IsDeliveryOnWay ? "on the way" : null,
      order.IsEditable ? "editable" : null,
      order.IsCancellable ? "cancellable" : null,
    ].filter(Boolean).join(", ");
    return [
      String(order.OrderNumber || order.Id || "—"),
      window,
      formatPrice(order.Total ?? order.TotalPrice ?? order.Price),
      flags,
    ];
  });

  const widths = [0, 1, 2].map((index) =>
    Math.max(...rows.map((row) => row[index].length))
  );
  const lines = rows.map(([id, window, total, flags]) =>
    `${pad(id, widths[0])}  ${pad(window, widths[1])}  ${padStart(total, widths[2])}${
      flags ? `  ${flags}` : ""
    }`.trimEnd()
  );

  if (Number.isFinite(result?.NumberOfPages) && result.NumberOfPages > 1) {
    lines.push("", `Page 1 of ${result.NumberOfPages}; use --offset to page back`);
  }
  return lines.join("\n");
}

export function renderOrder(order) {
  if (!order) return "Order not found.";

  const lines = order.Lines ?? [];
  const header = [
    `Order ${order.OrderNumber ?? order.Id ?? "—"}`,
    order.DeliveryTime
      ? `Delivered ${formatDay(order.DeliveryTime.Start)} ${
        formatWindow(order.DeliveryTime.Start, order.DeliveryTime.End)
      }`
      : order.OrderDate
      ? `Ordered ${order.OrderDate}`
      : null,
  ].filter(Boolean);

  const body = [];
  if (lines.length) {
    const quantityWidth = Math.max(
      ...lines.map((line) => String(line.Quantity ?? 0).length),
    );
    const nameWidth = Math.max(
      ...lines.map((line) => `${line.Name || "Product"} (${line.Id})`.length),
    );
    body.push(
      "",
      ...lines.map((line) => {
        const saved = Number(line.DiscountSavings || 0);
        return `${padStart(line.Quantity ?? 0, quantityWidth)} × ${
          pad(`${line.Name || "Product"} (${line.Id})`, nameWidth)
        }  ${padStart(formatPrice(line.Price ?? line.ItemPrice), 12)}${
          saved > 0 ? `  −${formatPrice(saved)}` : ""
        }`.trimEnd();
      }),
    );
  }

  const rows = [];
  if (Number.isFinite(order.NumberOfProducts)) {
    rows.push(["Products", `${order.NumberOfProducts} in ${lines.length} lines`]);
  }
  if (Number.isFinite(order.SubTotal)) rows.push(["Subtotal", formatPrice(order.SubTotal)]);
  if (order.PackagingPrice) rows.push(["Bags", formatPrice(order.PackagingPrice)]);
  if (order.DepositPrice) rows.push(["Deposit", formatPrice(order.DepositPrice)]);
  if (Number.isFinite(order.ShippingPrice)) {
    rows.push(["Delivery fee", formatPrice(order.ShippingPrice)]);
  }
  if (order.TransactionFee) rows.push(["Card fee", formatPrice(order.TransactionFee)]);
  const saved = Number(order.TotalProductDiscountPrice || order.TotalProductDiscount || 0);
  if (saved > 0) rows.push(["Saved", formatPrice(saved)]);
  if (order.CouponDiscount) rows.push(["Coupons", formatPrice(order.CouponDiscount)]);
  rows.push(["Total", formatPrice(order.Total ?? order.TotalPrice)]);
  if (Number.isFinite(order.TotalVatAmount)) {
    rows.push(["VAT included", formatPrice(order.TotalVatAmount)]);
  }

  return [...header, ...body, "", ...summaryRows(rows)].join("\n");
}

/**
 * GetDeliveryDays nests slots as DayRangeHours[].DayHours[]. Availability is 1
 * when the slot can still be booked; the slot the account already reserved
 * reports 0 with IsSelected true.
 */
export function collectDeliveryDays(result) {
  return (result?.DayRangeHours ?? []).map((day) => ({
    date: day.Date,
    slots: (day.DayHours ?? []).map((slot) => ({
      id: slot.Id,
      start: slot.StartHour,
      end: slot.EndHour,
      price: slot.DeliveryPrice,
      available: slot.Availability === 1,
      selected: slot.IsSelected === true,
      cheap: slot.IsCheapHour === true,
      free: slot.IsFreeHour === true,
      unattended: slot.Type === 1,
      deadline: slot.Deadline,
    })),
  }));
}

function hourRange(slot) {
  const hour = (value) => `${String(value).padStart(2, "0")}:00`;
  return `${hour(slot.start)}–${hour(slot.end)}`;
}

export function renderDeliveryDays(result, { all = false } = {}) {
  const days = collectDeliveryDays(result);
  if (!days.length) {
    return "No delivery days returned. Use --json to inspect the response.";
  }

  const sections = [];
  let shown = 0;
  let hidden = 0;

  for (const day of days) {
    const visible = day.slots.filter((slot) => all || slot.available || slot.selected);
    hidden += day.slots.length - visible.length;
    shown += visible.length;

    if (!visible.length) {
      sections.push(`${formatDay(day.date)} — sold out`);
      continue;
    }

    const idWidth = Math.max(...visible.map((slot) => String(slot.id).length));
    sections.push([
      formatDay(day.date),
      ...visible.map((slot) => {
        const notes = [
          slot.selected ? "reserved" : null,
          !slot.available && !slot.selected ? "sold out" : null,
          slot.free ? "free" : slot.cheap ? "cheap" : null,
          slot.unattended ? "unattended" : null,
        ].filter(Boolean);
        return `  ${padStart(slot.id, idWidth)}  ${hourRange(slot)}  ${
          padStart(slot.price === 0 ? "free" : formatPrice(slot.price), 10)
        }${notes.length ? `  ${notes.join(", ")}` : ""}`;
      }),
    ].join("\n"));
  }

  const footer = [`${shown} slot${shown === 1 ? "" : "s"} listed`];
  if (hidden) footer.push(`${hidden} sold out (use --all to show)`);
  if (result?.SelectedTimeSlotId) {
    footer.push(
      `reserved: ${result.SelectedTimeSlotId}${
        result.SelectedDeliveryTime ? ` (${formatDateTime(result.SelectedDeliveryTime)})` : ""
      }`,
    );
  }

  return [...sections, footer.join(" · ")].join("\n\n");
}

function packLabel(pack) {
  if (!pack) return "";
  if (pack.base === "stk") return `${pack.amount} stk`;
  if (pack.base === "g") {
    return pack.amount >= 1000
      ? `${(pack.amount / 1000).toLocaleString("da-DK")} kg`
      : `${pack.amount.toLocaleString("da-DK")} g`;
  }
  return pack.amount >= 1000
    ? `${(pack.amount / 1000).toLocaleString("da-DK")} l`
    : `${pack.amount.toLocaleString("da-DK")} ml`;
}

/** Price per kg / litre / piece, scaled up from the base unit. */
export function formatUnitPrice(unitPrice, base) {
  if (unitPrice == null || !base) return "—";
  const scale = base === "stk" ? 1 : 1000;
  const suffix = base === "stk" ? "kr./stk" : base === "g" ? "kr./kg" : "kr./l";
  return `${(unitPrice * scale).toLocaleString("da-DK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${suffix}`;
}

export function renderGomaProducts(result, { columns = 100 } = {}) {
  const products = result.products ?? [];
  if (!products.length) return "No offers found on goma.gg.";

  const nameWidth = Math.max(20, Math.min(40, columns - 60));
  const widths = [14, nameWidth, 11, 11, 12];
  const headers = ["STORE", "PRODUCT", "PRICE", "NORMAL", "SIZE"];

  const rows = products.map((product) => [
    product.store_name ?? "—",
    product.product_name ?? "—",
    formatPrice(product.current_price),
    product.is_on_sale && product.normal_price != null &&
      product.normal_price !== product.current_price
      ? formatPrice(product.normal_price)
      : "—",
    product.amount ? `${Number(product.amount).toLocaleString("da-DK")} ${product.unit ?? ""}`.trim() : "—",
  ]);

  const lines = [
    headers.map((value, index) => pad(value, widths[index])).join("  ").trimEnd(),
    widths.map((width) => "─".repeat(width)).join("  "),
    ...rows.map((row) =>
      row.map((value, index) => pad(value, widths[index])).join("  ").trimEnd()
    ),
  ];

  const onSale = products.filter((product) => product.is_on_sale);
  lines.push(
    "",
    `Showing ${products.length} of ${result.total} products · ${result.onSale} on sale`,
  );
  if (onSale.length) {
    const soonest = onSale
      .map((product) => product.sale_valid_to)
      .filter(Boolean)
      .sort()[0];
    if (soonest) lines.push(`Nearest offer ends ${formatDay(soonest)}`);
  }
  return lines.join("\n");
}

export function renderComparison(result, { columns = 100, history = false, links = false } = {}) {
  const { rows, summary } = result;
  if (!rows.length) return "Basket is empty; nothing to compare.";

  const cheaper = rows.filter((row) => row.cheaper)
    .sort((a, b) => b.saving - a.saving);

  const out = [];
  if (!cheaper.length) {
    out.push("No basket line was cheaper elsewhere on goma.gg.");
  } else {
    const nameWidth = Math.max(18, Math.min(32, columns - 68));
    const bestHeader = summary.truncated ? "BEST FOUND" : "BEST";
    out.push(
      ["PRODUCT", "NEMLIG", bestHeader, "STORE", "SAVE"]
        .map((value, index) => pad(value, [nameWidth, 15, 15, 12, 10][index]))
        .join("  ").trimEnd(),
      [nameWidth, 15, 15, 12, 10].map((width) => "─".repeat(width)).join("  "),
    );
    for (const row of cheaper) {
      const base = row.line.pack?.base;
      out.push([
        pad(row.line.name, nameWidth),
        pad(formatUnitPrice(row.line.unitPrice, base), 15),
        pad(formatUnitPrice(row.best.unitPrice, base), 15),
        pad(row.best.store, 12),
        pad(formatPrice(row.saving), 10),
      ].join("  ").trimEnd());
    }

    out.push("", "Matches:");
    for (const row of cheaper) {
      const marker = row.best.confidence === "high" ? " " : "?";
      const validity = row.best.onSale && row.best.saleValidTo
        ? `, offer ends ${formatDay(row.best.saleValidTo)}`
        : "";
      out.push(
        `${marker} ${row.line.name} (${packLabel(row.line.pack)})` +
          ` → ${row.best.store}: ${row.best.name} (${packLabel(row.best.pack)})${validity}`,
      );
      if (links && row.best.url) {
        out.push(`    ${row.best.url}`);
      }
      const past = row.best.history;
      if (history && past && !past.insufficientData) {
        out.push(
          `    over the past year: ${past.verdictLabel}` +
            ` (low ${formatPrice(past.lowest)}, avg ${formatPrice(past.average)},` +
            ` cheaper on ${past.percentCheaper}% of days)`,
        );
      } else if (history) {
        out.push("    over the past year: no price history");
      }
    }
  }

  const notes = [
    `${summary.highConfidence ?? summary.confidenceTiers?.high?.compared ?? 0} high confidence`,
    `${summary.mediumConfidence ?? summary.confidenceTiers?.medium?.compared ?? 0} medium confidence`,
    `${summary.unmatched ?? summary.uncomparable ?? 0} unmatched`,
    summary.failed ? `${summary.failed} lookup${summary.failed === 1 ? "" : "s"} failed` : null,
    summary.truncated ? `${summary.truncated} truncated` : null,
  ].filter(Boolean);

  out.push(
    "",
    ...summaryRows([
      ["Basket total", formatPrice(summary.basketTotal)],
      ["Estimated saving", formatPrice(summary.estimatedSavings)],
    ]),
    "",
    notes.join(" · "),
    "Prices are matched by name and pack size, so treat this as a guide;" +
      " lines marked ? are lower-confidence matches.",
  );
  if (summary.truncated) {
    out.push(
      "Candidate retrieval was truncated; “best found” is not a global cheapest claim.",
    );
  }
  return out.join("\n");
}

/** A coarse sparkline; enough to see the shape of a year without a chart. */
function sparkline(values, width = 48) {
  const blocks = "▁▂▃▄▅▆▇█";
  if (!values.length) return "";
  const step = Math.max(1, Math.ceil(values.length / width));
  const buckets = [];
  for (let index = 0; index < values.length; index += step) {
    const slice = values.slice(index, index + step);
    buckets.push(slice.reduce((sum, value) => sum + value, 0) / slice.length);
  }
  const low = Math.min(...buckets);
  const high = Math.max(...buckets);
  if (high === low) return blocks[0].repeat(buckets.length);
  return buckets
    .map((value) =>
      blocks[Math.round(((value - low) / (high - low)) * (blocks.length - 1))]
    )
    .join("");
}

export function renderPriceHistory(summary, { product = null, history = null } = {}) {
  if (summary.insufficientData) {
    return `No price history on goma.gg for ${product?.product_name ?? summary.productId}.`;
  }

  const header = product
    ? [
      `${product.product_name} — ${product.store_name}`,
      product.brand ? `${product.brand}` : null,
      "",
    ].filter((line) => line !== null)
    : [];

  const rows = [
    ["Price now", formatPrice(summary.price)],
    ["Year low", `${formatPrice(summary.lowest)}${
      summary.lowestOn ? ` on ${formatDay(summary.lowestOn)}` : ""
    }`],
    ["Year high", formatPrice(summary.highest)],
    ["Average", formatPrice(summary.average)],
    ["Cheaper on", `${summary.cheaperDays} of ${summary.days} days (${summary.percentCheaper}%)`],
    ["On offer", `${summary.daysOnSale} of ${summary.days} days`],
  ];
  if (summary.aboveLowest > 0) {
    rows.push(["Above the low", formatPrice(summary.aboveLowest)]);
  }
  if (summary.lastCheaper) {
    rows.push([
      "Last cheaper",
      `${formatPrice(summary.lastCheaperPrice)} on ${formatDay(summary.lastCheaper)}`,
    ]);
  }

  const lines = [...header, ...summaryRows(rows), ""];
  if (history?.points?.length) {
    lines.push(
      sparkline(history.points.map((point) => point.price)),
      `${formatDay(history.points[0].date)} → ${formatDay(history.points.at(-1).date)}`,
      "",
    );
  }
  lines.push(`Verdict: this price is ${summary.verdictLabel}.`);
  return lines.join("\n");
}

function dueLabel(product) {
  if (!product.predictable || product.typicalInterval == null) return "—";
  const due = product.dueInDays;
  if (due > 0) return `in ${due} d`;
  if (due === 0) return "today";
  return `${-due} d ago`;
}

export function renderHabits(analysis, { minOrders = 2, limit = 25, columns = 100 } = {}) {
  const products = analysis.products.filter((product) => product.orders >= minOrders);
  if (!products.length) {
    return `No product was bought more than ${minOrders - 1} time(s) in the ` +
      `last ${analysis.ordersAnalyzed} orders.`;
  }

  const active = products.filter((product) => product.predictable && !product.lapsed);
  const lapsed = products.filter((product) => product.predictable && product.lapsed);
  const overdue = [...active]
    .sort((a, b) => (a.dueInDays ?? Infinity) - (b.dueInDays ?? Infinity));
  const shown = overdue.slice(0, limit);

  const nameWidth = Math.max(18, Math.min(34, columns - 56));
  const widths = [nameWidth, 7, 10, 12, 11];
  const headers = ["PRODUCT", "ORDERS", "EVERY", "LAST BOUGHT", "DUE"];

  const lines = [
    headers.map((value, index) => pad(value, widths[index])).join("  ").trimEnd(),
    widths.map((width) => "─".repeat(width)).join("  "),
    ...shown.map((product) =>
      [
        pad(product.name, widths[0]),
        pad(`${product.orders}/${analysis.ordersAnalyzed}`, widths[1]),
        pad(
          product.typicalInterval == null ? "—" : `${product.typicalInterval} d`,
          widths[2],
        ),
        pad(`${product.daysSince} d ago`, widths[3]),
        pad(dueLabel(product), widths[4]),
      ].join("  ").trimEnd()
    ),
  ];

  const hidden = overdue.length - shown.length;
  lines.push(
    "",
    `${active.length} regular purchases across ${analysis.ordersAnalyzed} orders` +
      (hidden > 0 ? ` · ${hidden} more (use --limit)` : ""),
  );

  if (lapsed.length) {
    const examples = lapsed
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 3)
      .map((product) => product.name);
    lines.push(
      `${lapsed.length} look dropped rather than due (${examples.join(", ")}` +
        `${lapsed.length > examples.length ? ", …" : ""}) — excluded from reorder`,
    );
  }
  if (analysis.failed) {
    lines.push(`${analysis.failed} order(s) could not be loaded`);
  }
  lines.push(
    "Cadence is the median gap between purchases, so two purchases is a guess.",
  );
  return lines.join("\n");
}

export function renderReorderPlan(plan, { applied = false, columns = 100 } = {}) {
  const { add, skipped } = plan;
  if (!add.length && !skipped.length) {
    return "Nothing looks due yet. Try --orders to widen the history, or " +
      "nemlig habits to see the cadences.";
  }
  if (!add.length) {
    return `Everything due is already in the basket (${skipped.length} item(s)).`;
  }

  const nameWidth = Math.max(18, Math.min(34, columns - 46));
  const widths = [3, nameWidth, 9, 11, 11];
  const lines = [
    ["QTY", "PRODUCT", "ID", "LAST", "DUE"]
      .map((value, index) => pad(value, widths[index])).join("  ").trimEnd(),
    widths.map((width) => "─".repeat(width)).join("  "),
    ...add.map((product) =>
      [
        padStart(product.quantity, widths[0]),
        pad(product.name, widths[1]),
        pad(product.id, widths[2]),
        pad(`${product.daysSince} d ago`, widths[3]),
        pad(dueLabel(product), widths[4]),
      ].join("  ").trimEnd()
    ),
  ];

  const estimated = add.reduce(
    (sum, product) => sum + (product.averagePrice ?? 0) * product.quantity,
    0,
  );
  lines.push(
    "",
    ...summaryRows([
      [applied ? "Added" : "Would add", `${add.length} product(s)`],
      ["Estimated cost", formatPrice(estimated)],
    ]),
  );
  if (skipped.length) {
    lines.push(`${skipped.length} already in the basket, left alone`);
  }
  lines.push(
    applied
      ? "Run: nemlig basket — then nemlig checkout status"
      : "Nothing was changed. Repeat with --yes to add these to the basket.",
  );
  return lines.join("\n");
}

function shortAddress(address) {
  if (!address || address.IsEmptyAddress) return null;
  const street = [
    address.StreetName,
    address.HouseNumber,
    address.HouseNumberLetter,
    address.Floor,
    address.Side,
  ].filter(Boolean).join(" ");
  const city = [address.PostalCode, address.PostalDistrict].filter(Boolean).join(" ");
  return [street, city].filter(Boolean).join(", ") || null;
}

export function renderCheckoutStatus(status) {
  const ready = status.readiness;
  const basket = status.basket;
  const shortfall = minimumShortfall(basket);

  // Each check carries what to show when it passes and what to show when it
  // fails. Keeping those apart matters: clearing the basket drops the
  // reservation while FormattedDeliveryTime still holds the old window, and
  // printing it next to a ✗ would contradict the check itself.
  const checks = [
    { label: "Basket has items", ok: ready.hasItems },
    {
      label: "Minimum total",
      ok: ready.minimumTotalValid,
      whenFailed: shortfall == null ? null : `${formatPrice(shortfall)} short of ${
        formatPrice(basket?.MinimumOrderTotal)
      }`,
    },
    { label: "Maximum total", ok: ready.maximumTotalValid },
    {
      label: "Delivery address",
      ok: ready.hasDeliveryAddress,
      whenOk: shortAddress(basket?.DeliveryAddress),
      whenFailed: "no address on the basket",
    },
    {
      label: "Reserved timeslot",
      ok: ready.hasReservedTimeslot,
      whenOk: basket?.FormattedDeliveryTime ?? null,
      whenFailed: "no slot reserved; run: nemlig delivery slots",
    },
    {
      label: "No validation failures",
      ok: ready.validationFailures.length === 0,
      whenFailed: ready.validationFailures
        .map((failure) => failure?.Message || failure?.ErrorMessage || "see --json")
        .join("; ") || null,
    },
  ];

  const lines = checks.map(({ label, ok, whenOk, whenFailed }) => {
    const detail = ok ? whenOk : whenFailed;
    return `${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`;
  });

  const rows = [];
  if (Number.isFinite(basket?.DeliveryPrice)) {
    rows.push(["Delivery fee", formatPrice(basket.DeliveryPrice)]);
  }
  rows.push(["Total", formatPrice(basket?.TotalPrice)]);
  if (basket?.MinimumAgeRequired) {
    rows.push(["Age required", `${basket.MinimumAgeRequired}+`]);
  }

  return [
    ...lines,
    "",
    ...summaryRows(rows),
    "",
    `Continue securely in your browser: ${status.checkoutUrl}`,
  ].join("\n");
}
