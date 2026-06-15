/**
 * Miko Rental Calendar - Storefront Widget
 * Handles date selection, availability checking, pricing calculation,
 * and adding to cart with rental metadata.
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
    console.warn("[Miko Rentals] App URL not configured. Edit the theme block settings.");
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
  const variantIdInput = document.getElementById("miko-variant-id");

  // Set min date to today
  const today = new Date().toISOString().split("T")[0];
  startInput.min = today;
  endInput.min = today;

  let unavailableDates = [];
  let checkTimeout = null;
  let currentPricing = null;

  // Fetch unavailable dates on load
  fetchUnavailableDates();

  startInput.addEventListener("change", onDateChange);
  endInput.addEventListener("change", onDateChange);
  addBtn.addEventListener("click", onAddToCart);

  function onDateChange() {
    const start = startInput.value;
    const end = endInput.value;

    // Enforce end >= start + 1 day
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
      const from = today;
      const to = new Date(new Date().setMonth(new Date().getMonth() + 4))
        .toISOString()
        .split("T")[0];
      const res = await fetch(
        `${appUrl}/api/availability?shop=${encodeURIComponent(shop)}&productId=${encodeURIComponent(productId)}&from=${from}&to=${to}`
      );
      const data = await res.json();
      unavailableDates = data.unavailableDates || [];

      // Mark unavailable dates by disabling them in the date picker
      // (Native date inputs don't support per-day disabling, so we validate on change)
    } catch {
      // Silently fail - availability check happens at pricing time too
    }
  }

  async function checkPricing(startDate, endDate) {
    showMsg("Checking availability…", "loading");
    disableBtn();

    try {
      const res = await fetch(
        `${appUrl}/api/pricing?shop=${encodeURIComponent(shop)}&productId=${encodeURIComponent(productId)}&startDate=${startDate}&endDate=${endDate}`
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
    const variantId = variantIdInput ? variantIdInput.value : "";

    if (!variantId) {
      showMsg("No variant found for this product. Please refresh and try again.", "error");
      return;
    }

    addBtn.textContent = "Creating your checkout…";
    addBtn.classList.add("miko-btn--loading");
    addBtn.disabled = true;

    try {
      const res = await fetch(`${appUrl}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop, productId, variantId, startDate, endDate }),
      });

      let data = {};
      try { data = await res.json(); } catch { /* non-JSON response */ }

      if (!res.ok || !data.checkoutUrl) {
        showMsg(data.error || "Could not create your checkout. Please try again.", "error");
        enableBtn(`Book now - ${formatCurrency(currentPricing.totalDue, currentPricing.currency || currency)}`);
        return;
      }

      window.location.href = data.checkoutUrl;
    } catch {
      showMsg("Could not reach the booking server. Please try again in a moment.", "error");
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
      const d = new Date(isoDate + "T00:00:00");
      return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
    } catch {
      return isoDate;
    }
  }
})();
