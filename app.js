/*************************************************
 * IMMUNIZATION DATA QUALITY DASHBOARD (Plain JS)
 * ------------------------------------------------
 * What this file does:
 * 1) Loads immunization_data.json
 * 2) Initializes date pickers (Flatpickr) + quick range
 * 3) Runs a “report” (filters by date + missing element)
 * 4) Renders:
 *    - Table (plain HTML table)
 *    - AI explainable summary
 *    - Bar chart (Chart.js)
 * 5) Opens a provider-facing “Record Guidance” modal on Patient click
 * 6) Tracks “Reviewed” per Doc ID in localStorage + timestamp
 * 7) Shows confirmation toasts
 *
 * Notes:
 * - Row highlight is automatic by risk category (high / medium / low)
 * - “Highlight by” feature is intentionally removed/disabled
 * - Race/Ethnicity are included in:
 *    - CSV export
 *    - Record Guidance panel
 *   (Table headers in your current HTML do not include Race/Ethnicity,
 *    so we do NOT render extra table columns here to avoid header mismatch.)
 *************************************************/

/* =========================
   Globals
========================= */
let allRecords = [];
let filteredRecords = [];
let missingChart = null;
let displayRecords = []; // what the table is currently showing (after toggles)
let fromPicker = null;
let toPicker = null;
let lastVisibleCount = 0;
let countAnimFrame = null;
let isInitialLoad = true;
let isStartupComplete = false;
let activeSeverityFilter = null; // "high" | "medium" | "low" | "clean" | null
let suppressQuickRangeReset = false;

/* =========================
   Guidance + Scoring
========================= */
const HAS_SEEN_START_SCREEN = "hasSeenStartScreen";
const FIELD_GUIDANCE = {
  ndc: {
    label: "NDC",
    severity: "Medium",
    impact:
      "Product identification can fail for registry acceptance and inventory reconciliation.",
    fix: "Select the correct NDC from your vaccine master or barcode scan, aligned to the administered product.",
  },
  lot_number: {
    label: "Lot Number",
    severity: "High",
    impact:
      "Lot decrement and inventory reconciliation at the registry can fail, increasing audit risk.",
    fix: "Enter the lot from vial/carton. If unavailable, confirm via inventory log for that administration date.",
  },
  expiration_date: {
    label: "Exp Date",
    severity: "High",
    impact:
      "Missing or invalid expiration can trigger registry validation errors.",
    fix: "Enter expiration from vial/carton. Ensure expiration is after the administration date.",
  },
  vfc_status: {
    label: "VFC Eligibility",
    severity: "High",
    impact:
      "VFC accountability and public program reporting can be incomplete.",
    fix: "Confirm eligibility at time of administration and record the correct VFC code.",
  },
  funding_source: {
    label: "Funding Source",
    severity: "High",
    impact:
      "Funding attribution impacts reporting, reimbursements, and public program compliance.",
    fix: "Select the funding source aligned to eligibility and clinic program configuration.",
  },
  race: {
    label: "Race",
    severity: "Medium",
    impact:
      "Missing race can reduce registry data completeness and downstream reporting accuracy.",
    fix: "Update patient demographics in the EHR. If patient declines, record the appropriate refusal/unknown option per your workflow.",
  },
  ethnicity: {
    label: "Ethnicity",
    severity: "Medium",
    impact:
      "Missing ethnicity can reduce registry data completeness and downstream reporting accuracy.",
    fix: "Update patient demographics in the EHR. If patient declines, record the appropriate refusal/unknown option per your workflow.",
  },

  mobile: {
    label: "Mobile",
    severity: "Low",
    impact: "Patient reminders and series completion outreach are impacted.",
    fix: "Verify phone during check-in or via patient portal.",
  },
  email: {
    label: "Email",
    severity: "Low",
    impact: "Electronic reminders and follow-up may not reach the patient.",
    fix: "Verify email during check-in or via patient portal.",
  },
};

/*************************************************
 * SEVERITY RULES (Feature 1)
 *************************************************/

const SEVERITY = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
};

const READINESS_WEIGHTS = [
  { field: "lot_number", weight: 25 },
  { field: "ndc", weight: 25 },
  { field: "expiration_date", weight: 10 },
  { field: "vfc_status", weight: 15 },
  { field: "funding_source", weight: 15 },
  { field: "mobile", weight: 5 },
  { field: "email", weight: 5 },
];

function computeReadiness(r) {
  let score = 100;

  for (const w of READINESS_WEIGHTS) {
    const val = r[w.field];
    if (!val) score -= w.weight;
  }

  // Basic date sanity check
  if (r.administered_date && r.expiration_date) {
    if (String(r.expiration_date) < String(r.administered_date)) {
      score = Math.max(0, score - 15);
    }
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Row category highlight:
 * - High: missing VFC or Funding (priority compliance/registry)
 * - Medium: missing Lot or NDC (inventory + reconciliation)
 * - Low: missing contact details (outreach)
 */
function isEmpty(val) {
  return val === undefined || val === null || String(val).trim() === "";
}

/**
 * Row category highlight aligned to your JSON contract:
 * - High: missing required vaccine/order fields (must not be empty)
 * - Medium: missing VFC/funding OR missing race/ethnicity (your requirement)
 * - Low: missing contact details (mobile/email)
 */
function riskClassFromRecord(r) {
  // HIGH: required for a usable immunization order record
  const highMissing =
    isEmpty(r.vaccine_name) ||
    isEmpty(r.quantity) ||
    isEmpty(r.units) ||
    isEmpty(r.ndc) ||
    isEmpty(r.lot_number) ||
    isEmpty(r.expiration_date);

  if (highMissing) return "high";

  // MEDIUM: allowed to be empty, but operationally important
  const mediumMissing =
    isEmpty(r.vfc_status) ||
    isEmpty(r.funding_source) ||
    isEmpty(r.race) ||
    isEmpty(r.ethnicity);

  if (mediumMissing) return "medium";

  // LOW: optional outreach fields
  const lowMissing = isEmpty(r.mobile) || isEmpty(r.email);
  if (lowMissing) return "low";

  return "";
}

/* =========================
   Reviewed (Resolved) tracking
========================= */
function reviewedKey(docId) {
  return `resolved:${docId}`;
}
function reviewedTsKey(docId) {
  return `resolved:${docId}:ts`;
}
function isReviewed(docId) {
  return localStorage.getItem(reviewedKey(docId)) === "1";
}
function setReviewed(docId, val) {
  localStorage.setItem(reviewedKey(docId), val ? "1" : "0");
  if (val) {
    localStorage.setItem(reviewedTsKey(docId), new Date().toISOString());
  } else {
    localStorage.removeItem(reviewedTsKey(docId));
  }
}
function getReviewedTimestamp(docId) {
  return localStorage.getItem(reviewedTsKey(docId));
}

/* =========================
   DOM helpers
========================= */
function $(sel) {
  return document.querySelector(sel);
}
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}
function showStartScreenModal() {
  const modal = document.getElementById("startScreenModal");
  if (!modal) return;

  modal.classList.add("open");
  document.body.classList.add("modalOpen");

  console.log("[StartScreen] opened via class");
}

function hideStartScreenModal() {
  const modal = document.getElementById("startScreenModal");
  if (!modal) return;

  modal.classList.remove("open");
  document.body.classList.remove("modalOpen");
}

function isChild(age) {
  return age !== null && age !== undefined && Number(age) < 19;
}

function isVfcEligible(vfcStatus) {
  return vfcStatus && vfcStatus.startsWith("V0") && vfcStatus !== "V01";
}

function isPublicFunding(funding) {
  return ["VXC50", "VXC51", "VXC52"].includes(funding);
}

function wireRealtimeFilters() {
  // Filter by missing MUST restart pipeline
  const missingFilter = document.getElementById("filterMissing");
  if (missingFilter) {
    missingFilter.addEventListener("change", () => {
      applyDateFilters();
    });
  }

  // Hide Reviewed is view-only
  const reviewedToggle = document.getElementById("toggleCompletedRows");
  if (reviewedToggle) {
    reviewedToggle.addEventListener("change", () => {
      applyAllFiltersRealtime();
    });
  }

  // Date-driven filters
  ["fromDate", "toDate", "quickRange"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("change", () => {
        applyDateFilters();
      });
    }
  });
}
function wireViewOptionsDropdown() {
  const dropdown = document.querySelector(".viewDropdown");
  const toggle = document.querySelector(".viewToggle");

  if (!dropdown || !toggle) return;

  toggle.addEventListener("click", () => {
    const open = dropdown.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open);
  });

  // Close when clicking outside
  document.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target)) {
      dropdown.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    }
  });
}
function applyRelativeDateRange(daysBackStart, daysBackEnd = 0, quickValue) {
  const today = clampToToday(new Date());

  const start = new Date(today);
  start.setDate(today.getDate() - daysBackStart);

  const end = new Date(today);
  end.setDate(today.getDate() - daysBackEnd);

  suppressQuickRangeReset = true;

  if (fromPicker) fromPicker.setDate(start, true);
  if (toPicker) toPicker.setDate(end, true);

  const quickRange = document.getElementById("quickRange");
  if (quickRange && quickValue) {
    quickRange.value = quickValue;
  }

  setTimeout(() => {
    suppressQuickRangeReset = false;
  }, 0);
}

function applyLast7DaysRange() {
  applyRelativeDateRange(6, 0, "last7");
}
function applyTodayRange() {
  applyRelativeDateRange(0, 0, "today");
}

function applyYesterdayRange() {
  applyRelativeDateRange(1, 1, "yesterday");
}

function applyLast14DaysRange() {
  applyRelativeDateRange(13, 0, "last14");
}

function applyLast30DaysRange() {
  applyRelativeDateRange(29, 0, "last30");
}

function applyRelativeDateRange(daysBackStart, daysBackEnd = 0, quickValue) {
  const today = clampToToday(new Date());

  const start = new Date(today);
  start.setDate(today.getDate() - daysBackStart);

  const end = new Date(today);
  end.setDate(today.getDate() - daysBackEnd);

  suppressQuickRangeReset = true;

  if (fromPicker) fromPicker.setDate(start, true);
  if (toPicker) toPicker.setDate(end, true);

  const quickRange = document.getElementById("quickRange");
  if (quickRange && quickValue) {
    quickRange.value = quickValue;
  }

  setTimeout(() => {
    suppressQuickRangeReset = false;
  }, 0);
}

function forceSelectValue(selectEl, value) {
  if (!selectEl) return;

  Array.from(selectEl.options).forEach((opt) => {
    opt.selected = opt.value === value;
  });

  // Force repaint
  selectEl.blur();
  selectEl.focus();
}

/* =========================
   Welcome Modal: close + focus trap
========================= */
// Bug fix: removed duplicate openWelcomeModal() definition. The implementation below is the single source of truth.

function isWelcomeModalOpen() {
  const modal = document.getElementById("welcomeModal");
  return !!(modal && modal.style.display !== "none");
}

function openWelcomeModal() {
  const modal = document.getElementById("welcomeModal");
  if (!modal) return;

  modal.style.display = "flex";

  requestAnimationFrame(() => {
    modal.classList.remove("isClosing");
    modal.classList.add("isOpen");
    modal.setAttribute("aria-hidden", "false");
  });

  focusWelcomeModal();
}

function closeWelcomeModal() {
  const modal = document.getElementById("welcomeModal");
  if (!modal) return;

  modal.classList.remove("isOpen");
  modal.classList.add("isClosing");

  setTimeout(() => {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    modal.classList.remove("isClosing");
    releaseWelcomeModalFocusTrap();
  }, 250);
}

let welcomeTrapHandler = null;

function releaseWelcomeModalFocusTrap() {
  // Bug fix: ensure focus trap listener is always removed when the modal closes.
  // This prevents keyboard navigation from remaining trapped after the modal is dismissed.
  if (!welcomeTrapHandler) return;
  document.removeEventListener("keydown", welcomeTrapHandler, true);
  welcomeTrapHandler = null;
}

function focusWelcomeModal() {
  const modal = document.getElementById("welcomeModal");
  if (!modal) return;

  // Ensure modal is focusable
  modal.setAttribute("tabindex", "-1");
  modal.focus();

  // Trap focus inside the modal
  const focusable = modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  function onKeyDown(e) {
    // Enter or Escape closes the modal
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeWelcomeModal();
      document.removeEventListener("keydown", onKeyDown, true);
      return;
    }

    // Tab trap
    if (e.key === "Tab" && focusable.length) {
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  welcomeTrapHandler = onKeyDown;
  document.addEventListener("keydown", welcomeTrapHandler, true);
}

function openStartScreenModal() {
  const modal = document.getElementById("startScreenModal");
  if (!modal) return;

  modal.style.display = "flex";

  requestAnimationFrame(() => {
    modal.classList.remove("isClosing");
    modal.classList.add("isOpen");
    modal.setAttribute("aria-hidden", "false");
  });
}

function closeStartScreenModal() {
  const modal = document.getElementById("startScreenModal");
  if (!modal) return;

  modal.classList.remove("isOpen");
  modal.classList.add("isClosing");

  setTimeout(() => {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    modal.classList.remove("isClosing");
  }, 250);
}

function dismissWelcomeModalOnRun() {}

/* Close button in modal */
(function wireWelcomeModalClose() {
  document.addEventListener("click", function (e) {
    if (e.target && e.target.id === "closeModalBtn") {
      closeWelcomeModal();
    }
  });
})();
function isCompleteRecord(r) {
  // Define "complete" using the same fields you score for readiness
  for (const w of READINESS_WEIGHTS) {
    if (!r[w.field]) return false;
  }
  return true;
}
function getSeverity(record) {
  // HIGH: VFC + Funding missing
  if (!record.vfc_status && !record.funding_source) {
    return "high";
  }

  // MEDIUM: Race or Ethnicity missing
  if (!record.race || !record.ethnicity) {
    return "medium";
  }

  // LOW: Contact details incomplete
  if (!record.mobile || !record.email) {
    return "low";
  }

  // CLEAN
  return "clean";
}

function applyCompletedRowsToggle() {
  let rows = displayRecords.slice();

  const hideReviewed = document.getElementById("toggleCompletedRows")?.checked;

  if (hideReviewed) {
    rows = rows.filter((r) => !isReviewed(r.doc_id));
  }

  displayRecords = rows;
  renderTable(displayRecords);
  updateSeverityStrip();
  updateCounts();
}

/* =========================
   Disable “Highlight by” feature (removed)
========================= */
function disableHighlightByUI() {
  const el = document.getElementById("highlightMode");
  if (!el) return;
  el.value = "none";
  el.disabled = true;
  el.title =
    "Highlight-by mode is disabled. Rows are automatically highlighted by risk category.";
}

function applyAllFiltersRealtime() {
  showUpdatingLoader();

  let rows = filteredRecords.slice();

  const missing = document.getElementById("filterMissing")?.value || "all";

  if (missing !== "all") {
    rows = rows.filter((r) => {
      if (missing === "incomplete") return getSeverity(r) !== "clean";
      if (missing === "complete") return getSeverity(r) === "clean";
      if (missing === "vfc") return !r.vfc_status;
      if (missing === "funding") return !r.funding_source;
      if (filter === "race") return !r.race;
      if (filter === "ethnicity") return !r.ethnicity;
      if (missing === "contact") return !r.email || !r.mobile;
      return true;
    });
    // Apply severity filter (if active)
    if (activeSeverityFilter) {
      rows = rows.filter((r) => getSeverity(r) === activeSeverityFilter);
    }
  }

  displayRecords = rows;
  applyCompletedRowsToggle();
  autoRunAI();
}
function resetAllFiltersAndRefresh() {
  console.log("[StartScreen] resetAllFiltersAndRefresh called");
  showStartScreenModal();
  showLoader("Resetting view. Preparing immunization documentation review…");

  applyLast7DaysRange();

  // Reset other filters
  const missingFilter = document.getElementById("filterMissing");
  if (missingFilter) missingFilter.value = "all";

  const hideReviewed = document.getElementById("toggleCompletedRows");
  if (hideReviewed) hideReviewed.checked = false;

  const hideDemographics = document.getElementById("toggleDemographics");
  if (hideDemographics) hideDemographics.checked = false;

  setTimeout(() => {
    applyAllFiltersRealtime();
    hideLoader();
    // Show StartScreen again after reset
    openStartScreenModal();
  }, 300);
}

let realtimeLoaderTimer = null;

function showUpdatingLoader() {
  if (!isStartupComplete) return;

  showLoader("Refreshing…");

  if (realtimeLoaderTimer) {
    clearTimeout(realtimeLoaderTimer);
  }

  realtimeLoaderTimer = setTimeout(() => {
    hideLoader();
    realtimeLoaderTimer = null;
  }, 500); // informational only
}

function applyDateFilters() {
  const quickRange = document.getElementById("quickRange");
  showUpdatingLoader();

  const from = document.getElementById("fromDate")?.value || "";
  const to = document.getElementById("toDate")?.value || "";

  if (!from || !to) {
    filteredRecords = [];
    displayRecords = [];
    renderTable([]);
    updateCounts();
    showAIPlaceholder();
    return;
  }

  filteredRecords = allRecords.filter(
    (r) => r.administered_date >= from && r.administered_date <= to
  );

  applyAllFiltersRealtime();
  autoRunAI();
  // 🔹 Ensure Quick Range reflects Last 7 Days when applicable
  (function syncQuickRangeLabel() {
    const quickRange = document.getElementById("quickRange");
    const fromInput = document.getElementById("fromDate");
    const toInput = document.getElementById("toDate");

    if (!quickRange || !fromInput || !toInput) return;

    const from = fromInput.value;
    const to = toInput.value;

    if (!from || !to) return;

    const today = clampToToday(new Date());
    const start = new Date(today);
    start.setDate(today.getDate() - 6);

    const format = (d) => d.toISOString().slice(0, 10);

    if (from === format(start) && to === format(today)) {
      forceSelectValue(quickRange, "last7");
    }
  })();
}
function getSeverity(record) {
  // HIGH: VFC + Funding missing
  if (!record.vfc_status && !record.funding_source) {
    return "high";
  }

  // MEDIUM: Race or Ethnicity missing
  if (!record.race || !record.ethnicity) {
    return "medium";
  }

  // LOW: Contact details incomplete
  if (!record.mobile || !record.email) {
    return "low";
  }

  // CLEAN
  return "clean";
}
function updateSeverityStrip() {
  const counts = {
    high: 0,
    medium: 0,
    low: 0,
    clean: 0,
  };

  displayRecords.forEach((r) => {
    counts[getSeverity(r)]++;
  });

  const total = counts.high + counts.medium + counts.low + counts.clean;

  const strip = document.getElementById("severityStrip");
  if (!strip) return;

  if (total === 0) {
    strip.classList.add("empty");
    return;
  } else {
    strip.classList.remove("empty");
  }

  // Update counts
  const map = [
    ["high", counts.high],
    ["medium", counts.medium],
    ["low", counts.low],
    ["clean", counts.clean],
  ];

  map.forEach(([key, value]) => {
    const seg = document.querySelector(`.severity-segment.${key}`);
    const countEl = document.getElementById(
      `sev${key.charAt(0).toUpperCase() + key.slice(1)}Count`
    );

    if (!seg || !countEl) return;

    const prev = Number(countEl.textContent) || 0;
    countEl.textContent = value;

    if (prev !== value) {
      seg.classList.remove("animating");
      void seg.offsetWidth; // force reflow
      seg.classList.add("animating");
    }
  });

  // Proportional widths
  strip.querySelector(".high").style.flexGrow = counts.high || 0.5;
  strip.querySelector(".medium").style.flexGrow = counts.medium || 0.5;
  strip.querySelector(".low").style.flexGrow = counts.low || 0.5;
  strip.querySelector(".clean").style.flexGrow = counts.clean || 0.5;
}

/* =========================
   Loader + Run button state
========================= */
function setFiltersEnabled(enabled) {
  const ids = ["fromDate", "toDate", "filterMissing", "quickRange"];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  }
}

function showLoader(text) {
  const overlay = document.getElementById("tableLoader");
  const label = document.getElementById("loaderText");
  if (label) label.textContent = text || "";
  if (overlay) overlay.classList.add("active");
}

function hideLoader() {
  const overlay = document.getElementById("tableLoader");
  if (overlay) overlay.classList.remove("active");
}

function setRunButtonState(disabled, label) {
  const runBtn = document.getElementById("runBtn");
  if (!runBtn) return;

  if (label != null) runBtn.textContent = label;
  runBtn.disabled = !!disabled;
}

function updateRunButtonState() {
  const from = document.getElementById("fromDate")?.value || "";
  const to = document.getElementById("toDate")?.value || "";
  const ok = Boolean(from && to);
  setRunButtonState(!ok, "Run report");
}

function updateCounts() {
  const pill = document.getElementById("countPill");
  if (!pill) return;

  const target = displayRecords.length;
  const start = lastVisibleCount;

  if (start === target) {
    pill.textContent = target === 1 ? "1 record" : `${target} records`;
    return;
  }

  if (countAnimFrame) {
    cancelAnimationFrame(countAnimFrame);
  }

  const duration = 250;
  const startTime = performance.now();

  function animate(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);

    // Ease-out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(start + (target - start) * eased);

    pill.textContent = current === 1 ? "1 record" : `${current} records`;

    if (progress < 1) {
      pill.classList.add("animating");
      countAnimFrame = requestAnimationFrame(animate);
    } else {
      lastVisibleCount = target;
      countAnimFrame = null;
      pill.classList.remove("animating");
    }
  }

  countAnimFrame = requestAnimationFrame(animate);
}

/* =========================
   Toasts (5 seconds + pause on hover)
========================= */
function showToast(message, type) {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type || "info"}`;
  toast.textContent = message;

  container.appendChild(toast);

  let remaining = 5000;
  let start = Date.now();
  let timer = null;

  function schedule() {
    timer = window.setTimeout(() => {
      toast.classList.add("hide");
      window.setTimeout(() => toast.remove(), 200);
    }, remaining);
  }

  function pause() {
    if (!timer) return;
    window.clearTimeout(timer);
    timer = null;
    remaining -= Date.now() - start;
  }

  function resume() {
    if (timer) return;
    start = Date.now();
    schedule();
  }

  toast.addEventListener("mouseenter", pause);
  toast.addEventListener("mouseleave", resume);

  // Start
  schedule();
}

function evaluateRecordSeverity(record) {
  const issues = [];

  // HIGH priority: VFC + Funding gaps
  if (!record.vfc_status) {
    issues.push({ field: "vfc_status", severity: SEVERITY.HIGH });
  }
  if (!record.funding_source) {
    issues.push({ field: "funding_source", severity: SEVERITY.HIGH });
  }

  // MEDIUM priority: Demographics gaps
  if (!record.race) {
    issues.push({ field: "race", severity: SEVERITY.MEDIUM });
  }
  if (!record.ethnicity) {
    issues.push({ field: "ethnicity", severity: SEVERITY.MEDIUM });
  }

  // LOW priority: Contact gaps
  if (!record.mobile) {
    issues.push({ field: "mobile", severity: SEVERITY.LOW });
  }
  if (!record.email) {
    issues.push({ field: "email", severity: SEVERITY.LOW });
  }

  return issues;
}

/* =========================
   Table rendering (Plain JS)
   - Keeps cells blank when value is missing
   - Keeps header order aligned with current index.html
========================= */
function renderTable(rows) {
  const tbody = document.querySelector("#tbl tbody");
  if (!tbody) return;

  tbody.innerHTML = "";

  const fragment = document.createDocumentFragment();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tr = document.createElement("tr");
    const severity = getSeverity(r);

    if (severity !== "clean") {
      tr.classList.add(severity);
    }

    const risk = riskClassFromRecord(r);
    if (risk) tr.classList.add(risk);

    // Reviewed state
    if (isReviewed(r.doc_id)) tr.classList.add("resolved");

    tr.innerHTML = `
      <td>
  <a href="#" class="docLink" data-doc="${escapeHtml(r.doc_id)}">${escapeHtml(
      r.doc_id
    )}</a>
</td>
<td>${escapeHtml(r.patient_id)}</td>

      <td>${escapeHtml(r.administered_date)}</td>
      <td>${escapeHtml(r.vaccine_name)}</td>

      <td>${escapeHtml(r.vfc_status || "-")}</td>
      <td>${escapeHtml(r.funding_source || "-")}</td>

      <td>${escapeHtml(r.quantity)}</td>
      <td>${escapeHtml(r.units)}</td>

      <td>${escapeHtml(r.ndc || "")}</td>
      <td>${escapeHtml(r.lot_number || "")}</td>
      <td>${escapeHtml(r.expiration_date || "")}</td>

      <td>${escapeHtml(r.status)}</td>
      <td>${r.race || '<span class="missing">-</span>'}</td>
<td>${r.ethnicity || '<span class="missing">-</span>'}</td>
      <td class="demographics">${escapeHtml(r.age || "")}</td>
      <td class="demographics">${escapeHtml(r.mobile || "-")}</td>
      <td class="demographics">${escapeHtml(r.email || "-")}</td>

      <td style="text-align:center;">
        <input
          type="checkbox"
          class="resolvedToggle"
          data-doc="${escapeHtml(r.doc_id)}"
          ${isReviewed(r.doc_id) ? "checked" : ""}
        />
      </td>
    `;

    fragment.appendChild(tr);
  }

  tbody.appendChild(fragment);

  // Re-apply demographics visibility after render
  applyDemographicsVisibility();
}

/* =========================
   Demographics toggle (Hide demographics)
========================= */
function applyDemographicsVisibility() {
  const toggle = document.getElementById("toggleDemographics");
  const hide = toggle ? toggle.checked : false;

  const demoCells = document.querySelectorAll("#tbl .demographics");
  for (const cell of demoCells) {
    cell.style.display = hide ? "none" : "";
  }
}

/* =========================
   AI Placeholder + Results display
========================= */
function showAIPlaceholder() {
  const report = document.getElementById("aiReport");
  const content = document.getElementById("aiReportContent");

  if (!report || !content) return;

  report.classList.remove("is-hidden");
  report.classList.add("is-visible");

  content.innerHTML = `
    <h3>Ready to review immunization data?</h3>
    <p style="font-size:12px;color:#555;">
      Select administration date range to generate the summary.
    </p>
  `;

  updateSeverityStrip();
}

/* =========================
   Explainable AI (summary + chart)
   - Bar values on bars (Chart.js datalabels plugin if present)
   - Dynamic bar colors for high values
========================= */
function runExplainableAI(records, from, to) {
  const report = document.getElementById("aiReport");
  const content = document.getElementById("aiReportContent");
  const strip = document.getElementById("severityStrip");

  if (!report || !content || !strip) {
    console.error("AI report DOM not ready", {
      report: !!report,
      content: !!content,
      strip: !!strip,
    });
    return;
  }

  report.classList.remove("is-hidden");
  report.classList.add("is-visible");

  const total = records.length;
  const miss = (f) => records.filter((r) => !r[f]).length;

  const lotMissing = miss("lot_number");
  const ndcMissing = miss("ndc");
  const vfcMissing = miss("vfc_status");
  const fundingMissing = miss("funding_source");
  const emailMissing = miss("email");
  const mobileMissing = miss("mobile");

  content.innerHTML = `
    <div class="reportInner">
      <p><b>Date range:</b> ${escapeHtml(from)} to ${escapeHtml(to)}</p>
      <p><b>Records identified:</b> ${total}</p>

      <p>
        Summary of records that may need correction or follow-up
      </p>

      <ul>
        <li>Records missing a lot number: ${lotMissing}</li>
        <li>Records missing an NDC: ${ndcMissing}</li>
        <li>Records missing VFC eligibility: ${vfcMissing}</li>
        <li>Records missing funding source: ${fundingMissing}</li>
        <li>Records missing patient email: ${emailMissing}</li>
        <li>Records missing patient phone number: ${mobileMissing}</li>
      </ul>

      <p style="font-size:12px;color:#555;">
        Tip: Click a Document ID to see why a missing field matters and what to fix in the EHR.
      </p>
    </div>
  `;

  updateSeverityStrip();
}

/* =========================
   Record Guidance panel (modal)
   - Includes Race/Ethnicity here (no header mismatch)
========================= */
function openRecordPanel(rec) {
  const summaryTable = `
  <table class="recordSummaryTable">
    <tbody>
      <tr>
        <th>Patient ID</th>
        <td>${escapeHtml(rec.patient_id)}</td>
      </tr>
      <tr>
        <th>Age</th>
        <td>${escapeHtml(rec.age)}</td>
      </tr>
      <tr>
        <th>Vaccine</th>
        <td>${escapeHtml(rec.vaccine_name)}</td>
      </tr>
      <tr>
        <th>Administration date</th>
        <td>${escapeHtml(rec.administered_date)}</td>
      </tr>
      <tr>
        <th>Dose</th>
        <td>${escapeHtml(rec.quantity)} ${escapeHtml(rec.units)}</td>
      </tr>
      <tr>
        <th>VFC Eligibility Source</th>
        <td>${escapeHtml(rec.vfc_status || "—")}</td>
      </tr>
      <tr>
        <th>Funding Source</th>
        <td>${escapeHtml(rec.funding_source || "—")}</td>
      </tr>
    </tbody>
  </table>
`;

  const panel = document.getElementById("recordPanel");
  if (!panel) return;

  // ---- Feature 1: Severity-driven record issues ----
  const issues = evaluateRecordSeverity(rec);

  const reviewed = isReviewed(rec.doc_id);
  const reviewedTs = getReviewedTimestamp(rec.doc_id);

  const missingList = issues.length
    ? issues
        .map((issue) => {
          const g = FIELD_GUIDANCE[issue.field];
          const label = g ? g.label : issue.field;

          const severityLabel =
            issue.severity === SEVERITY.HIGH
              ? "High impact"
              : issue.severity === SEVERITY.MEDIUM
              ? "Medium impact"
              : "Low impact";

          return `
          <li>
              ${escapeHtml(label)}
          </li>
        `;
        })
        .join("")
    : "<li>No documentation gaps detected for this record.</li>";

  const guidanceItems = issues.length
    ? issues
        .map((issue) => {
          const g = FIELD_GUIDANCE[issue.field];
          if (!g) return "";

          const severityLabel =
            issue.severity === SEVERITY.HIGH
              ? "High impact"
              : issue.severity === SEVERITY.MEDIUM
              ? "Medium impact"
              : "Low impact";

          return `
          <li class="guidanceItem">
            <div class="guidanceHead">
              ${escapeHtml(g.label)}
              <span class="sevTag sev${escapeHtml(issue.severity)}">
                ${severityLabel}
              </span>
            </div>
            <div class="guidanceBody">
              <div>${escapeHtml(g.impact)}</div>
              <div><b>What to do:</b> ${escapeHtml(g.fix)}</div>
            </div>
          </li>
        `;
        })
        .join("")
    : "<li>No recommendations. This record is complete for the selected checks.</li>";

  // Provider-friendly reviewed text
  const reviewedLine = reviewedTs
    ? `Reviewed on ${escapeHtml(new Date(reviewedTs).toLocaleString())}`
    : "";

  panel.innerHTML = `
  <div class="rgModal">
    <div class="rgHeader">
      <div class="rgIcon" aria-hidden="true">
        <svg viewBox="0 0 24 24" class="infoIcon">
          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
          <line x1="12" y1="10" x2="12" y2="16" stroke="currentColor" stroke-width="2"/>
          <circle cx="12" cy="7" r="1.2" fill="currentColor"/>
        </svg>
      </div>

      <div class="rgTitleGroup">
        <h3>Record Guidance</h3>
        <p class="rgSubtitle">
          Review documentation gaps that may affect immunization reporting or registry acceptance.
        </p>
      </div>

      <button
        class="rgCloseBtn rgCloseX"
        id="closePanelBtn"
        type="button"
        aria-label="Close record guidance"
      >
        <svg viewBox="0 0 24 24" class="rgCloseIcon" aria-hidden="true">
          <line x1="6" y1="6" x2="18" y2="18"/>
          <line x1="18" y1="6" x2="6" y2="18"/>
        </svg>
      </button>
    </div>

    <div class="rgBody">
      <div class="sectionTitle blueInfo">Patient & Visit Summary</div>
      <div class="kv"><b>Order ID:</b> ${escapeHtml(rec.doc_id)}</div>
<div class="reviewRow">
        <b>Review status:</b>
        <span class="reviewStatus ${reviewed ? "isReviewed" : "needsReview"}">
          ${reviewed ? "Reviewed" : "Needs review"}
        </span>
        ${reviewedLine ? `<span class="hintText">(${reviewedLine})</span>` : ""}
      </div>
      ${summaryTable}

      

      <div class="sectionTitle blueInfo reportWarningLegend">
        <div class="legendTitle">⚠ Missing or risky elements</div>
        <ul class="list">${missingList}</ul>
      </div>

      <div class="sectionTitle blueInfo">Why this matters</div>
      <ul class="list">
        ${
          guidanceItems ||
          "<li>No recommendations. This record is complete for the selected checks.</li>"
        }
      </ul>
    </div>

    <div class="rgActions reviewActionRow">
      <button
        class="btn reviewBtn ${reviewed ? "reviewed" : "needsReview"}"
        id="toggleResolvedBtn"
        type="button"
      >
        ${reviewed ? "Reviewed" : "Mark as reviewed"}
      </button>

      <span class="reviewHint">
        <span class="infoIcon" aria-hidden="true">
          <svg viewBox="0 0 24 24" class="infoIcon">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
            <line x1="12" y1="10" x2="12" y2="16" stroke="currentColor" stroke-width="2"/>
            <circle cx="12" cy="7" r="1.2" fill="currentColor"/>
          </svg>
        </span>
        ${
          reviewed
            ? "Reviewed means this record has been verified and corrected in the EHR."
            : "Mark as reviewed after correcting this record in the EHR."
        }
      </span>
    </div>
  </div>
`;

  // Show and focus
  panel.style.display = "flex";

  requestAnimationFrame(() => {
    panel.classList.remove("isClosing");
    panel.classList.add("isOpen");
    panel.setAttribute("aria-hidden", "false");
    panel.setAttribute("tabindex", "-1");
    panel.focus();
  });

  const closeBtn = document.getElementById("closePanelBtn");
  if (closeBtn) {
    closeBtn.addEventListener("click", closeRecordPanel);
  }

  const toggleBtn = document.getElementById("toggleResolvedBtn");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", function () {
      const next = !isReviewed(rec.doc_id);
      setReviewed(rec.doc_id, next);

      // 🔑 Update table row directly
      const row = document
        .querySelector(
          `#tbl .resolvedToggle[data-doc="${CSS.escape(rec.doc_id)}"]`
        )
        ?.closest("tr");

      if (row) {
        row.classList.toggle("resolved", next);
        const chk = row.querySelector(".resolvedToggle");
        if (chk) chk.checked = next;
      }

      updateCounts();
      closeRecordPanel();

      // Toast feedback
      if (next) {
        showToast(`Reviewed: ${rec.doc_id}`, "success");
      } else {
        showToast(`Need to review: ${rec.doc_id}`, "info");
      }
    });
  }
}

function closeRecordPanel() {
  const panel = document.getElementById("recordPanel");
  if (!panel) return;

  panel.classList.remove("isOpen");
  panel.classList.add("isClosing");

  setTimeout(() => {
    panel.style.display = "none";
    panel.setAttribute("aria-hidden", "true");
    panel.classList.remove("isClosing");
  }, 250);
}

/* =========================
   CSV export
   - Includes Race/Ethnicity in export
========================= */
function downloadCSV() {
  const rows = filteredRecords || [];
  if (!rows.length) {
    alert("No rows to export");
    return;
  }

  const headers = [
    "doc_id",
    "patient_id",
    "status",
    "age",
    "race",
    "ethnicity",
    "mobile",
    "email",
    "administered_date",
    "vaccine_name",
    "vfc_status",
    "funding_source",
    "quantity",
    "units",
    "ndc",
    "lot_number",
    "expiration_date",
    "readiness_score",
    "reviewed",
    "reviewed_timestamp",
  ];

  const lines = [];
  lines.push(headers.join(","));

  for (const r of rows) {
    const score = computeReadiness(r);
    const reviewed = isReviewed(r.doc_id) ? "1" : "0";
    const ts = getReviewedTimestamp(r.doc_id) || "";

    const vals = [
      r.doc_id,
      r.patient_id,
      r.status,
      r.age,
      r.race,
      r.ethnicity,
      r.mobile,
      r.email,
      r.administered_date,
      r.vaccine_name,
      r.vfc_status,
      r.funding_source,
      r.quantity,
      r.units,
      r.ndc,
      r.lot_number,
      r.expiration_date,
      score,
      reviewed,
      ts,
    ].map(csvEscape);

    lines.push(vals.join(","));
  }

  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "immunization_data_quality_export.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
}

/* =========================
   Date pickers (Flatpickr)
   - Default: last 7 days
   - Prevent future dates
   - Auto-correct From > To
   - “T” shortcut sets today
========================= */
function clampToToday(d) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const x = new Date(d);
  x.setHours(0, 0, 0, 0);

  if (x > today) return today;
  return x;
}

function formatYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function handleTodayShortcut(inputId, picker) {
  const el = document.getElementById(inputId);
  if (!el || !picker) return;

  el.addEventListener("keydown", function (e) {
    if (e.key === "t" || e.key === "T") {
      e.preventDefault();
      const today = clampToToday(new Date());
      picker.setDate(today, true);
      updateRunButtonState();
    }
  });
}

function ensureFromToOrder() {
  const fromVal = document.getElementById("fromDate")?.value || "";
  const toVal = document.getElementById("toDate")?.value || "";
  if (!fromVal || !toVal) return;

  if (fromVal > toVal) {
    // Auto-correct: set To = From
    const fromDate = fromPicker
      ? fromPicker.selectedDates[0]
      : new Date(fromVal);
    if (toPicker) toPicker.setDate(fromDate, true);
  }
}

function applyQuickRange(days) {
  const today = clampToToday(new Date());
  const from = new Date(today);
  from.setDate(from.getDate() - (days - 1)); // inclusive range

  if (fromPicker) fromPicker.setDate(from, true);
  if (toPicker) toPicker.setDate(today, true);

  ensureFromToOrder();
  updateRunButtonState();
}

function initDatePickers() {
  if (typeof flatpickr !== "function") {
    // If Flatpickr is not loaded, fallback to native values
    updateRunButtonState();
    return;
  }

  const maxDate = clampToToday(new Date());

  fromPicker = flatpickr("#fromDate", {
    dateFormat: "Y-m-d",
    allowInput: true,
    maxDate,
    onChange: () => {
      ensureFromToOrder();
      updateRunButtonState();
      applyDateFilters();
    },
  });

  toPicker = flatpickr("#toDate", {
    dateFormat: "Y-m-d",
    allowInput: true,
    maxDate,
    onChange: () => {
      ensureFromToOrder();
      updateRunButtonState();
      applyDateFilters();
    },
  });

  handleTodayShortcut("fromDate", fromPicker);
  handleTodayShortcut("toDate", toPicker);

  const quick = document.getElementById("quickRange");

  if (quick) {
    quick.addEventListener("change", function () {
      const v = quick.value;

      switch (v) {
        case "today":
          applyTodayRange();
          break;

        case "yesterday":
          applyYesterdayRange();
          break;

        case "last7":
          applyLast7DaysRange();
          break;

        case "last14":
          applyLast14DaysRange();
          break;

        case "last30":
          applyLast30DaysRange();
          break;

        case "custom":
        default:
          // manual date editing will handle this
          return;
      }

      applyDateFilters();
    });
  }
}
let aiTimer = null;

function autoRunAI() {
  if (aiTimer) {
    clearTimeout(aiTimer);
  }

  aiTimer = setTimeout(() => {
    if (!displayRecords.length) {
      showAIPlaceholder();
      return;
    }

    runExplainableAI(
      displayRecords,
      document.getElementById("fromDate").value,
      document.getElementById("toDate").value
    );
  }, 300);
}

/* =========================
   UI Wiring
========================= */
function wireUI() {
  console.log(
    "[StartScreen] DOM check:",
    document.getElementById("startScreenModal")
  );

  // Buttons
  const csvBtn = document.getElementById("csvBtn");
  if (csvBtn) csvBtn.addEventListener("click", downloadCSV);

  // Help link opens the welcome modal on demand
  const helpLink = document.getElementById("helpLink");
  if (helpLink) {
    helpLink.addEventListener("click", function () {
      openWelcomeModal();
    });
  }
  // Start screen modal wiring
  const startBeginBtn = document.getElementById("startBeginBtn");
  if (startBeginBtn) {
    startBeginBtn.addEventListener("click", function () {
      closeStartScreenModal();
    });
  }

  const startHowToBtn = document.getElementById("startHowToBtn");
  if (startHowToBtn) {
    startHowToBtn.addEventListener("click", function () {
      closeStartScreenModal();
      openWelcomeModal();
    });
  }

  const closeStartScreenBtn = document.getElementById("closeStartScreenBtn");
  if (closeStartScreenBtn) {
    closeStartScreenBtn.addEventListener("click", function () {
      closeStartScreenModal();
    });
  }

  // Start Screen modal actions
  const closeStartBtn = document.getElementById("closeStartScreenBtn");
  if (closeStartBtn) {
    closeStartBtn.addEventListener("click", hideStartScreenModal);
  }

  const continueBtn = document.getElementById("continueToDashboardBtn");
  if (continueBtn) {
    continueBtn.addEventListener("click", hideStartScreenModal);
  }

  const openHelpFromStart = document.getElementById("openHelpFromStartBtn");
  if (openHelpFromStart) {
    openHelpFromStart.addEventListener("click", () => {
      hideStartScreenModal();
      openWelcomeModal();
    });
  }

  // Close How-to modal via X
  const closeWelcomeBtn = document.getElementById("closeWelcomeBtn");
  if (closeWelcomeBtn) {
    closeWelcomeBtn.addEventListener("click", function () {
      const modal = document.getElementById("welcomeModal");
      if (!modal) return;

      modal.classList.add("isClosing");

      setTimeout(() => {
        modal.style.display = "none";
        modal.setAttribute("aria-hidden", "true");
        modal.classList.remove("isClosing");
      }, 250); // match CSS transition
    });
  }

  // Table click: patient link opens guidance panel
  const tbody = document.querySelector("#tbl tbody");
  if (tbody) {
    tbody.addEventListener("click", function (e) {
      const a = e.target.closest("a.docLink");
      if (!a) return;

      e.preventDefault();
      const doc = a.getAttribute("data-doc");
      const rec =
        filteredRecords.find((r) => r.doc_id === doc) ||
        allRecords.find((r) => r.doc_id === doc);
      if (rec) openRecordPanel(rec);
    });

    // Reviewed checkbox toggle
    tbody.addEventListener("change", function (e) {
      const chk = e.target.closest(".resolvedToggle");
      if (!chk) return;

      const doc = chk.getAttribute("data-doc");
      const val = chk.checked;
      setReviewed(doc, val);

      // Re-render to apply gray-out
      applyCompletedRowsToggle();
      updateCounts();

      if (val) {
        showToast(`Reviewed: ${doc}`, "success");
      } else {
        showToast(`Need to review: ${doc}`, "info");
      }
    });
  }

  const completedToggle = document.getElementById("toggleCompletedRows");
  if (completedToggle) {
    completedToggle.addEventListener("change", applyCompletedRowsToggle);
  }
  // Demographics hide
  const demoToggle = document.getElementById("toggleDemographics");
  if (demoToggle) {
    demoToggle.addEventListener("change", applyDemographicsVisibility);
  }

  // Date inputs changes (native typing path)
  const fromEl = document.getElementById("fromDate");
  const toEl = document.getElementById("toDate");
  if (fromEl) fromEl.addEventListener("input", updateRunButtonState);
  if (toEl) toEl.addEventListener("input", updateRunButtonState);

  // Remove/disable highlight-by UI
  disableHighlightByUI();

  // Ensure welcome modal is hidden on load (help opens it)
  const wm = document.getElementById("welcomeModal");
  if (wm) {
    wm.style.display = "none";
    wm.setAttribute("aria-hidden", "true");
  }

  // Initial placeholder
  showAIPlaceholder();

  // Initialize run button state on load
  updateRunButtonState();
}
// Help link toggles the welcome modal
const helpLink = document.getElementById("helpLink");
if (helpLink) {
  helpLink.addEventListener("click", function () {
    if (isWelcomeModalOpen()) closeWelcomeModal();
    else openWelcomeModal();
  });
}

// Click outside dialog closes the modal
const welcomeModal = document.getElementById("welcomeModal");
if (welcomeModal) {
  welcomeModal.addEventListener("mousedown", function (e) {
    const dialog = welcomeModal.querySelector(".welcomeDialog");
    if (dialog && !dialog.contains(e.target)) {
      closeWelcomeModal();
    }
  });
}

/* =========================
   Load data + init
========================= */
const MIN_WELCOME_DURATION = 600;
let welcomeStartTime = performance.now();
welcomeStartTime = performance.now();
showLoader("Preparing immunization review workspace…");
function hideWelcomeLoaderSafely() {
  const elapsed = performance.now() - welcomeStartTime;
  const remaining = Math.max(0, MIN_WELCOME_DURATION - elapsed);

  setTimeout(() => {
    isInitialLoad = false;
    isStartupComplete = true;
    hideLoader();

    // Show StartScreen after initial loader is done
    openStartScreenModal();
  }, remaining);
}

fetch("immunization_data.json")
  .then((res) => res.json())
  .then((data) => {
    const quickRangeEl = document.getElementById("quickRange");
    allRecords = Array.isArray(data) ? data : [];
    filteredRecords = allRecords.slice();

    // Date picker init (sets default last 7 days)
    initDatePickers();

    // Render initial table (optional: show all or keep empty)
    applyCompletedRowsToggle();
    updateCounts();

    // Wire handlers
    wireUI();
    wireRealtimeFilters();
    wireViewOptionsDropdown();
    applyLast7DaysRange();
    hideWelcomeLoaderSafely();
    // Show Start Screen on first load
    if (!localStorage.getItem(HAS_SEEN_START_SCREEN)) {
      showStartScreenModal();
      localStorage.setItem(HAS_SEEN_START_SCREEN, "true");
    }

    // 🔒 Duplicate ID guard (must run once after DOM is ready)
    [
      "toggleCompletedRows",
      "toggleDemographics",
      "csvBtn",
      "countPill",
    ].forEach((id) => {
      const count = document.querySelectorAll(`#${id}`).length;
      if (count !== 1) {
        console.warn(`ID "${id}" count = ${count}`);
      }
    });
    // 🔒 Guard against inline style regressions
    const aiReport = document.getElementById("aiReport");
    if (aiReport) {
      console.assert(
        !aiReport.hasAttribute("style"),
        "aiReport must not use inline styles"
      );
    }

    const csvBtn = document.getElementById("csvBtn");
    if (csvBtn) {
      csvBtn.addEventListener("click", (e) => {
        e.preventDefault(); // 🔑 important for <a>
        downloadCSV();
      });
    }
    const refreshBtn = document.getElementById("refreshBtn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", (e) => {
        e.preventDefault();
        resetAllFiltersAndRefresh();
      });
    }

    // ✅ SHOW RIGHT PANE PLACEHOLDER IMMEDIATELY
    showAIPlaceholder();
  })
  .catch((err) => {
    console.error("JSON load failed:", err);
  });

const startScreenEl = document.getElementById("startScreenModal");
if (startScreenEl) {
  const observer = new MutationObserver(() => {
    console.log("[StartScreen] MUTATION hidden=", startScreenEl.hidden);
  });

  observer.observe(startScreenEl, {
    attributes: true,
    attributeFilter: ["hidden", "style", "aria-hidden"],
  });
}
