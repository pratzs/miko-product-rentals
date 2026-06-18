/**
 * Miko Rental Calendar - Storefront Widget
 *
 * Adds the chosen dates and rental total to the standard Shopify cart as
 * line item properties. A Cart Transform Function (miko-cart-transform)
 * intercepts the checkout and sets the actual per-unit charge based on
 * what the merchant has configured. Cart line quantity = number of units
 * the customer is renting.
 */
(function () {
  "use strict";

  const widget = document.getElementById("miko-rental-widget");
  if (!widget) return;

  const shop = widget.dataset.shop;
  const productId = widget.dataset.productId;
  const appUrl = (widget.dataset.appUrl || "").replace(/\/$/, "");
  const currency = widget.dataset.currency || "USD";

  if (!appUrl) {
    console.warn("[Miko Rentals] App URL not configured.");
    return;
  }

  const startInput = document.getElementById("miko-start-date");
  const endInput = document.getElementById("miko-end-date");
  const msgEl = document.getElementById("miko-availability-msg");
  const pricingPanel = document.getElementById("miko-pricing-panel");
  const breakdownLabel = document.getElementById("miko-breakdown-label");
  const rentalPriceEl = document.getElementById("miko-rental-price");
  const depositRow = document.getElementById("miko-deposit-row");
  const depositPriceEl = document.getElementById("miko-deposit-price");
  const totalPriceEl = document.getElementById("miko-total-price");
  const notesEl = document.getElementById("miko-notes");
  const addBtn = document.getElementById("miko-add-to-cart");
  const cartForm = document.getElementById("miko-cart-form");
  const cartQuantityInput = document.getElementById("miko-cart-quantity");

  const unitRow = document.getElementById("miko-unit-row");
  const unitInput = document.getElementById("miko-units");
  const unitMinus = document.getElementById("miko-unit-minus");
  const unitPlus = document.getElementById("miko-unit-plus");
  const unitAvailableEl = document.getElementById("miko-unit-available");

  const today = new Date().toISOString().split("T")[0];
  startInput.min = today;
  endInput.min = today;

  let unavailableDates = [];
  let totalUnits = 1;
  let checkTimeout = null;
  let currentPricing = null;

  fetchUnavailableDates();

  startInput.addEventListener("change", onDateChange);
  endInput.addEventListener("change", onDateChange);
  addBtn.addEventListener("click", onAddToCart);

  unitMinus.addEventListener("click", () => changeUnits(-1));
  unitPlus.addEventListener("click", () => changeUnits(+1));
  unitInput.addEventListener("input", onUnitInput);
  unitInput.addEventListener("blur", onUnitInput);

  function getUnits() {
    const raw = parseInt(unitInput.value, 10);
    if (isNaN(raw) || raw < 1) return 1;
    return Math.min(raw, totalUnits);
  }

  function changeUnits(delta) {
    const current = getUnits();
    const next = Math.max(1, Math.min(totalUnits, current + delta));
    unitInput.value = String(next);
    refreshUnitButtonState();
    if (startInput.value && endInput.value) {
      clearTimeout(checkTimeout);
      checkTimeout = setTimeout(() => checkPricing(startInput.value, endInput.value), 250);
    }
  }

  function onUnitInput() {
    const next = getUnits();
    if (String(next) !== unitInput.value) unitInput.value = String(next);
    refreshUnitButtonState();
    if (startInput.value && endInput.value) {
      clearTimeout(checkTimeout);
      checkTimeout = setTimeout(() => checkPricing(startInput.value, endInput.value), 400);
    }
  }

  function refreshUnitButtonState() {
    const current = getUnits();
    unitMinus.disabled = current <= 1;
    unitPlus.disabled = current >= totalUnits;
  }

  function onDateChange() {
    const start = startInput.value;
    const end = endInput.value;

    if (start) {
      const minEnd = new Date(start);
      minEnd.setDate(minEnd.getDate() + 1);
      endInput.min = minEnd.toISOString().split("T")[0];
      if (end && end <= start) {
        endInput.value = minEnd.toISOString().split("T")[0];
      }
    }

    resetPricing();

    if (start && endInput.value) {
      clearTimeout(checkTimeout);
      checkTimeout = setTimeout(() => checkPricing(start, endInput.value), 400);
    }
  }

  async function fetchUnavailableDates() {
    try {
      const to = new Date(new Date().setMonth(new Date().getMonth() + 4))
        .toISOString()
        .split("T")[0];
      const res = await fetch(
        `${appUrl}/api/availability?shop=${encodeURIComponent(shop)}&productId=${encodeURIComponent(productId)}&from=${today}&to=${to}`
      );
      const data = await res.json();
      unavailableDates = data.unavailableDates || [];
      totalUnits = Math.max(1, data.totalUnits || 1);

      // Show the unit selector only when the merchant has more than one unit.
      if (totalUnits > 1) {
        unitRow.classList.remove("miko-msg--hidden");
        unitInput.max = String(totalUnits);
        refreshUnitButtonState();
      }

      // Hide the "Powered by Miko Rentals" credit if the merchant's plan
      // (or per-shop setting) doesn't include it.
      if (data.showBadge === false) {
        const poweredEl = widget.querySelector(".miko-powered");
        if (poweredEl) poweredEl.style.display = "none";
      }
    } catch {
      // Silently fail - availability is re-checked when dates are chosen
    }
  }

  async function checkPricing(startDate, endDate) {
    showMsg("Checking availability...", "loading");
    disableBtn();

    const units = getUnits();

    try {
      const res = await fetch(
        `${appUrl}/api/pricing?shop=${encodeURIComponent(shop)}&productId=${encodeURIComponent(productId)}&startDate=${startDate}&endDate=${endDate}&units=${units}`
      );
      const data = await res.json();

      if (!res.ok || data.error) {
        showMsg(data.error || "These dates are not available.", "error");
        resetPricing();
        return;
      }

      hideMsg();
      currentPricing = data;
      showPricing(data);
      enableBtn(`Book now - ${formatCurrency(data.totalDue, data.currency || currency)}`);

      // Show remaining inventory hint
      if (totalUnits > 1 && typeof data.unitsAvailable === "number") {
        unitAvailableEl.textContent = `${data.unitsAvailable} of ${totalUnits} available`;
      }

      if (data.rentalNotes) {
        notesEl.textContent = data.rentalNotes;
        notesEl.classList.remove("miko-msg--hidden");
      } else {
        notesEl.classList.add("miko-msg--hidden");
      }
    } catch {
      showMsg("Unable to check availability right now. Please try again.", "error");
      resetPricing();
    }
  }

  function showPricing(data) {
    breakdownLabel.textContent = data.breakdown || `Rental fee (${data.rentalDays} days)`;
    rentalPriceEl.textContent = formatCurrency(data.rentalPrice, data.currency || currency);
    totalPriceEl.textContent = formatCurrency(data.totalDue, data.currency || currency);

    if (data.depositAmount > 0) {
      depositPriceEl.textContent = formatCurrency(data.depositAmount, data.currency || currency);
      depositRow.classList.remove("miko-msg--hidden");
    } else {
      depositRow.classList.add("miko-msg--hidden");
    }

    pricingPanel.classList.remove("miko-msg--hidden");
  }

  function resetPricing() {
    pricingPanel.classList.add("miko-msg--hidden");
    notesEl.classList.add("miko-msg--hidden");
    currentPricing = null;
    disableBtn();
  }

  function showMsg(text, type) {
    msgEl.textContent = text;
    msgEl.className = `miko-msg miko-msg--${type}`;
  }

  function hideMsg() {
    msgEl.className = "miko-msg miko-msg--hidden";
    msgEl.textContent = "";
  }

  function enableBtn(label) {
    addBtn.textContent = label;
    addBtn.disabled = false;
    addBtn.classList.remove("miko-btn--disabled");
  }

  function disableBtn() {
    addBtn.textContent = "Select dates to continue";
    addBtn.disabled = true;
    addBtn.classList.add("miko-btn--disabled");
  }

  async function onAddToCart() {
    if (!currentPricing || addBtn.disabled) return;

    const startDate = startInput.value;
    const endDate = endInput.value;
    const units = currentPricing.units || getUnits();

    // Cart quantity mirrors units so the cart shows "3 × Product" and the
    // Cart Transform Function uses perUnitPrice as fixedPricePerUnit.
    cartQuantityInput.value = String(units);

    document.getElementById("miko-prop-start-display").value = formatDateDisplay(startDate);
    document.getElementById("miko-prop-end-display").value = formatDateDisplay(endDate);
    document.getElementById("miko-prop-duration").value =
      `${currentPricing.rentalDays} day${currentPricing.rentalDays !== 1 ? "s" : ""}`;
    document.getElementById("miko-prop-price").value =
      formatCurrency(currentPricing.rentalPrice, currentPricing.currency || currency);
    document.getElementById("miko-prop-deposit").value =
      currentPricing.depositAmount > 0
        ? formatCurrency(currentPricing.depositAmount, currentPricing.currency || currency)
        : "None";

    // Compact form keeps the admin order-line view tidy. Short keys map:
    //   p  = product numeric ID (gid:// stripped, prepended on read)
    //   s  = start date (ISO)
    //   e  = end date (ISO)
    //   u  = units rented
    //   r  = total rental fee
    //   d  = total deposit
    //   pu = per-unit price (rental + deposit per unit) - precomputed for
    //        the Cart Transform Function so it never has to divide.
    const numericProductId = String(productId).split("/").pop() || productId;
    document.getElementById("miko-prop-data").value = JSON.stringify({
      p: numericProductId,
      s: startDate,
      e: endDate,
      u: units,
      r: currentPricing.rentalPrice.toFixed(2),
      d: currentPricing.depositAmount.toFixed(2),
      pu: currentPricing.perUnitPrice.toFixed(2),
    });

    addBtn.textContent = "Adding to cart...";
    addBtn.classList.add("miko-btn--loading");
    addBtn.disabled = true;

    try {
      const formData = new FormData(cartForm);
      const res = await fetch("/cart/add.js", {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        document.dispatchEvent(new CustomEvent("cart:refresh", { bubbles: true }));
        window.location.href = "/cart";
      } else {
        const err = await res.json().catch(() => ({}));
        showMsg(err.description || "Could not add to cart. Please try again.", "error");
        enableBtn(`Book now - ${formatCurrency(currentPricing.totalDue, currentPricing.currency || currency)}`);
      }
    } catch {
      showMsg("Something went wrong. Please try again.", "error");
      enableBtn(`Book now - ${formatCurrency(currentPricing.totalDue, currentPricing.currency || currency)}`);
    }
  }

  function formatCurrency(amount, currencyCode) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currencyCode || "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${currencyCode} ${amount.toFixed(2)}`;
    }
  }

  function formatDateDisplay(isoDate) {
    try {
      return new Date(isoDate + "T00:00:00").toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    } catch {
      return isoDate;
    }
  }
})();
