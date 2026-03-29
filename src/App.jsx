import { useState, useEffect, useRef } from "react";
// ─── DESIGN TOKENS ───────────────────────────────────────────────────────────────
// Single source of truth for colors, spacing, radius. Edit here = updates everywhere.
const C = {
  // Brand
  sky:      "#0EA5E9",  skyLight:  "#38BDF8",
  indigo:   "#6366F1",
  amber:    "#F59E0B",  amberDark: "#78350F",
  emerald:  "#10B981",  emeraldDark: "#065F46",
  red:      "#EF4444",  redLight:  "#FCA5A5",
  purple:   "#8B5CF6",
  teal:     "#06B6D4",
  whatsapp: "#25D366",
  // Neutrals (dark theme)
  bg:       "#060A14",  surface:  "#0D1526",
  border:   "rgba(255,255,255,0.08)",  borderSubtle: "rgba(255,255,255,0.05)",
  text:     "#F1F5F9",  textSub:  "#94A3B8",  textMuted: "#475569",  textFaint: "#334155",
  // Opacity helpers
  o04: "rgba(255,255,255,0.04)",  o07: "rgba(255,255,255,0.07)",  o12: "rgba(255,255,255,0.12)",
};
const R = { sm: 9, md: 12, lg: 16, pill: 20 }; // border-radius scale
const F = { xs: 10, sm: 11, md: 13, lg: 15, xl: 18, h2: 22, h1: 28 }; // font-size scale



// ─── SUPABASE STORE ──────────────────────────────────────────────────────────────
// Live database — data persists across all devices and users.
// Project: GuyGoddard's Project (eu-west-1, Ireland)
const SUPABASE_URL = "https://qyqyjavjusxsvlkkvftg.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5cXlqYXZqdXN4c3Zsa2t2ZnRnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MjQwMjYsImV4cCI6MjA5MDMwMDAyNn0.ttAQxloQ0MPIv1RI-5-qXwuooj1B5AtqbpNmQqKaYrg";

// Minimal Supabase REST client — no npm package needed
const supa = {
  async from(table) {
    const base = `${SUPABASE_URL}/rest/v1/${table}`;
    const headers = {
      "apikey":        SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type":  "application/json",
      "Prefer":        "return=representation",
    };
    return {
      async select(col = "*") {
        this._col = col; return this;
      },
      async eq(field, val) {
        this._eq = `${field}=eq.${encodeURIComponent(val)}`; return this;
      },
      async maybeSingle() {
        const res = await fetch(`${base}?${this._eq}&select=${this._col || "*"}&limit=1`, { headers });
        const data = await res.json();
        return { data: Array.isArray(data) && data.length > 0 ? data[0] : null };
      },
      async upsert(body) {
        await fetch(base, {
          method: "POST",
          headers: { ...headers, "Prefer": "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(body),
        });
      },
      async delete() { this._delete = true; return this; },
      async _exec() {
        if (this._delete) {
          await fetch(`${base}?${this._eq}`, { method: "DELETE", headers });
        }
      },
    };
  }
};

// Thin async helpers that mirror the old localStorage API exactly
const _supaGet = async (key) => {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/kv_store?key=eq.${encodeURIComponent(key)}&select=value&limit=1`,
      { headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await res.json();
    return data?.[0]?.value ?? null;
  } catch { return null; }
};

const _supaSet = async (key, value) => {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/kv_store`, {
      method:  "POST",
      headers: {
        "apikey":        SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
    });
  } catch {}
};

const _supaDel = async (key) => {
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/kv_store?key=eq.${encodeURIComponent(key)}`,
      { method: "DELETE", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } }
    );
  } catch {}
};

// The store object — same interface as before, now backed by Supabase
const store = {
  get: async (key) => {
    const val = await _supaGet(key);
    if (val === null) return null;
    // Supabase returns jsonb already parsed — re-stringify so existing
    // JSON.parse(raw.value) calls throughout the app still work
    return { value: typeof val === "string" ? val : JSON.stringify(val) };
  },
  set: async (key, val) => {
    // Parse to object so Supabase stores it as proper jsonb (queryable later)
    const value = typeof val === "string" ? (() => { try { return JSON.parse(val); } catch { return val; } })() : val;
    await _supaSet(key, value);
  },
  del: async (key) => { await _supaDel(key); },
};

// ─── REFERRAL TRACKER ───────────────────────────────────────────────────────────
// Writes a lead event to storage and increments the provider's referral count.
// providerId is null for AI-generated (mock) providers — we still log the event
// under a "untracked" bucket so admin can see total platform activity.
const trackEvent = async ({ providerId, providerName, type, serviceType, searchArea, searchQuery, plan }) => {
  const now = new Date();
  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    providerId:   providerId || null,
    providerName: providerName || "Unknown",
    type,          // "call" | "whatsapp" | "view"
    serviceType,
    searchArea:   searchArea  || "",
    searchQuery:  searchQuery || "",
    plan:         plan        || "basic",
    ts:           now.toISOString(),
    // Human-readable helpers stored alongside for quick display
    timeLabel:    now.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }),
    dateLabel:    now.toLocaleDateString("en-ZA", { day: "numeric", month: "short" }),
    dayLabel:     ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][now.getDay()],
  };

  // 1. Append to global events log (capped at 500)
  try {
    const raw = await store.get("events");
    const events = raw ? JSON.parse(raw.value) : [];
    events.unshift(event);
    if (events.length > 500) events.length = 500;
    await store.set("events", events);
  } catch {}

  // 2. Increment provider referral count + append to per-provider lead list
  if (providerId) {
    try {
      const raw = await store.get("providers");
      const providers = raw ? JSON.parse(raw.value) : [];
      const updated = providers.map(p => {
        if (p.id !== providerId) return p;
        const leads = p.leads ? [event, ...p.leads].slice(0, 200) : [event];
        const referralTypes = ["call","whatsapp"];
        const referrals = (p.referrals || 0) + (referralTypes.includes(type) ? 1 : 0);
        return { ...p, leads, referrals };
      });
      await store.set("providers", updated);
    } catch {}
  }

  return event;
};

// ─── CONSTANTS ──────────────────────────────────────────────────────────────────
const SERVICES = [
  { id: "plumber",     label: "Plumber",      icon: "🔧", color: "#0EA5E9", emergency: true,  desc: "Burst pipes, leaks, drains" },
  { id: "electrician", label: "Electrician",  icon: "⚡", color: "#F59E0B", emergency: true,  desc: "Power failures, wiring" },
  { id: "handyman",    label: "Handyman",     icon: "🛠️", color: "#10B981", emergency: false, desc: "General repairs & maintenance" },
  { id: "security",    label: "Security",     icon: "🔒", color: "#8B5CF6", emergency: true,  desc: "Alarms, CCTV, access control" },
  { id: "gate_repair", label: "Gate Repair",  icon: "🚪", color: "#EF4444", emergency: true,  desc: "Gate motors, intercoms" },
  { id: "technology",  label: "Technology",   icon: "📺", color: "#06B6D4", emergency: false, desc: "TVs, sound systems, smart home" },
];

const PLANS = [
  { id: "basic",    label: "Basic",    price: 299,  priceLabel: "R299/mo",   color: "#64748B", features: ["Listed in search results","1 service category","Standard placement","Email support"] },
  { id: "featured", label: "Featured", price: 699,  priceLabel: "R699/mo",   color: "#0EA5E9", features: ["Priority placement","2 service categories","24hr emergency badge","Analytics dashboard","R15 per referral tracked"] },
  { id: "premium",  label: "Premium",  price: 1299, priceLabel: "R1 299/mo", color: "#F59E0B", features: ["Top of results","All service categories","Dedicated profile page","R10 per referral tracked","WhatsApp integration","Monthly performance report"] },
];

// ─── BOOKING HELPERS ────────────────────────────────────────────────────────────
const JOB_STATUS = {
  pending:    { label: "Pending",     color: "#F59E0B", desc: "Waiting for provider to respond" },
  accepted:   { label: "Accepted",    color: "#0EA5E9", desc: "Provider has accepted your job" },
  onroute:    { label: "On the Way",  color: "#8B5CF6", desc: "Provider is on their way to you" },
  inprogress: { label: "In Progress", color: "#06B6D4", desc: "Work is underway" },
  completed:  { label: "Completed",   color: "#10B981", desc: "Job marked as complete" },
  declined:   { label: "Declined",    color: "#EF4444", desc: "Provider couldn't take this job" },
};

const JOB_PROGRESS_STEPS = ["pending", "accepted", "onroute", "inprogress", "completed"];

const PLATFORM_FEE_PCT = 0.08; // 8% booking commission

const saveJob = async (job) => {
  try {
    const raw = await store.get("jobs");
    const jobs = raw ? JSON.parse(raw.value) : [];
    jobs.unshift(job);
    await store.set("jobs", jobs);
    // Also write job onto provider's jobs array for dashboard
    if (job.providerId) {
      const pRaw = await store.get("providers");
      const providers = pRaw ? JSON.parse(pRaw.value) : [];
      const updated = providers.map(p => {
        if (p.id !== job.providerId) return p;
        const pJobs = p.jobs ? [job, ...p.jobs].slice(0, 100) : [job];
        return { ...p, jobs: pJobs };
      });
      await store.set("providers", updated);
    }
  } catch {}
};

const updateJobStatus = async (jobId, status, note = "") => {
  try {
    const raw = await store.get("jobs");
    const jobs = raw ? JSON.parse(raw.value) : [];
    const updated = jobs.map(j => j.id === jobId ? { ...j, status, statusNote: note, updatedAt: new Date().toISOString() } : j);
    await store.set("jobs", updated);
    // Sync onto provider record too
    const pRaw = await store.get("providers");
    const providers = pRaw ? JSON.parse(pRaw.value) : [];
    const syncedProviders = providers.map(p => ({
      ...p,
      jobs: (p.jobs || []).map(j => j.id === jobId ? { ...j, status, statusNote: note, updatedAt: new Date().toISOString() } : j),
    }));
    await store.set("providers", syncedProviders);
    return updated;
  } catch { return []; }
};

// ─── SMS / NOTIFICATION HELPERS ─────────────────────────────────────────────────
// Clickatell API — replace with your API key from portal.clickatell.com
const CLICKATELL_API_KEY = "YOUR_CLICKATELL_API_KEY";

const sendSMS = async (phone, message) => {
  try {
    // Format SA number: strip spaces/dashes, ensure starts with 27
    const cleaned = phone.replace(/[\s\-()+]/g, "");
    const formatted = cleaned.startsWith("0") ? "27" + cleaned.slice(1) : cleaned.startsWith("27") ? cleaned : "27" + cleaned;
    await fetch("https://platform.clickatell.com/messages/http/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": CLICKATELL_API_KEY },
      body: JSON.stringify({ messages: [{ channel: "sms", to: formatted, content: message }] }),
    });
  } catch {}
};

// Send notification via SMS or WhatsApp based on user preference
const sendNotification = async (user, message, jobId = null) => {
  if (!user) return;
  const pref = user.notifPreference || "whatsapp";
  if (pref === "sms" && user.phone) {
    await sendSMS(user.phone, message);
  } else if (user.phone) {
    // WhatsApp deep link — opens WhatsApp with pre-filled message
    // (In a real app this would be sent server-side via WhatsApp Business API)
    // For now we log it; provider-side WA is already handled via buttons
  }
  // Always push in-app notification too
  if (user.email) {
    await pushNotif(user.email, {
      title: message.split(".")[0],
      body: message,
      type: jobId ? "booking" : "default",
      jobId,
    });
  }
};

// ─── ADDRESS BOOK HELPERS ────────────────────────────────────────────────────────
const saveAddress = async (customerId, address) => {
  try {
    const key = `addresses:${customerId}`;
    const raw = await store.get(key);
    const addresses = raw ? JSON.parse(raw.value) : [];
    // Deduplicate by label
    const filtered = addresses.filter(a => a.label !== address.label);
    filtered.unshift({ ...address, id: `addr-${Date.now()}` });
    await store.set(key, filtered.slice(0, 10));
  } catch {}
};

const getAddresses = async (customerId) => {
  try {
    const raw = await store.get(`addresses:${customerId}`);
    return raw ? JSON.parse(raw.value) : [];
  } catch { return []; }
};

// ─── CHAT HELPERS ────────────────────────────────────────────────────────────────
const sendChatMessage = async (jobId, senderId, senderName, senderRole, message) => {
  try {
    const key = `chat:${jobId}`;
    const raw = await store.get(key);
    const messages = raw ? JSON.parse(raw.value) : [];
    messages.push({
      id:         `msg-${Date.now()}`,
      senderId, senderName, senderRole, message,
      ts:         new Date().toISOString(),
      timeLabel:  new Date().toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }),
    });
    await store.set(key, messages.slice(-100)); // keep last 100 messages
  } catch {}
};

const getChatMessages = async (jobId) => {
  try {
    const raw = await store.get(`chat:${jobId}`);
    return raw ? JSON.parse(raw.value) : [];
  } catch { return []; }
};

// ─── QUOTE HELPERS ───────────────────────────────────────────────────────────────
const saveQuoteRequest = async (request) => {
  try {
    const raw = await store.get("quote_requests");
    const requests = raw ? JSON.parse(raw.value) : [];
    requests.unshift(request);
    await store.set("quote_requests", requests.slice(0, 200));
  } catch {}
};

const getQuoteRequests = async (providerId) => {
  try {
    const raw = await store.get("quote_requests");
    const all = raw ? JSON.parse(raw.value) : [];
    return all.filter(r => !r.assignedProviders || r.assignedProviders.includes(providerId));
  } catch { return []; }
};

const submitQuote = async (requestId, providerId, providerName, amount, note) => {
  try {
    const raw = await store.get("quote_requests");
    const requests = raw ? JSON.parse(raw.value) : [];
    const updated = requests.map(r => {
      if (r.id !== requestId) return r;
      const quotes = r.quotes || [];
      quotes.push({ providerId, providerName, amount, note, ts: new Date().toISOString() });
      return { ...r, quotes };
    });
    await store.set("quote_requests", updated);
  } catch {}
};

// ─── GPS LOCATION HELPERS ────────────────────────────────────────────────────────
const updateProviderLocation = async (providerId, lat, lng) => {
  try {
    await store.set(`location:${providerId}`, { lat, lng, ts: new Date().toISOString() });
  } catch {}
};

const getProviderLocation = async (providerId) => {
  try {
    const raw = await store.get(`location:${providerId}`);
    return raw ? JSON.parse(raw.value) : null;
  } catch { return null; }
};

// ─── VERIFICATION BADGE HELPERS ──────────────────────────────────────────────────
const submitVerification = async (providerId, docType, docNumber) => {
  try {
    const raw = await store.get("providers");
    const providers = raw ? JSON.parse(raw.value) : [];
    const updated = providers.map(p => p.id !== providerId ? p : {
      ...p,
      verification: {
        docType, docNumber,
        status: "pending",
        submittedAt: new Date().toISOString(),
      }
    });
    await store.set("providers", updated);
  } catch {}
};


// Calculates average hours between job created → accepted from a provider's job log
const getResponseSpeed = (providerJobs = []) => {
  const accepted = providerJobs.filter(j =>
    ["accepted","inprogress","completed"].includes(j.status) && j.createdAt && j.updatedAt
  );
  if (!accepted.length) return null;
  const avgMins = accepted.reduce((sum, j) => {
    const mins = (new Date(j.updatedAt) - new Date(j.createdAt)) / 60000;
    return sum + Math.max(0, mins);
  }, 0) / accepted.length;
  return avgMins; // now returns MINUTES, not hours
};

// Human-readable label for response time in minutes
const formatResponseTime = (avgMins) => {
  if (avgMins === null) return null;
  if (avgMins < 60)   return `${Math.round(avgMins)}min`;
  if (avgMins < 1440) return `${(avgMins / 60).toFixed(1)}hr`;
  return `${Math.round(avgMins / 1440)}d`;
};

const SPEED_TIERS = [
  { maxMins: 60,    label: "Under 1 hour",  short: "<1hr",   color: "#10B981", score: 4 },
  { maxMins: 240,   label: "Under 4 hours", short: "<4hrs",  color: "#0EA5E9", score: 3 },
  { maxMins: 1440,  label: "Under 24 hrs",  short: "<24hrs", color: "#F59E0B", score: 2 },
  { maxMins: 99999, label: "Over 24 hrs",   short: ">24hrs", color: "#64748B", score: 1 },
];

const getSpeedTier = (avgMins) => {
  if (avgMins === null) return null;
  return SPEED_TIERS.find(t => avgMins <= t.maxMins) || SPEED_TIERS[SPEED_TIERS.length - 1];
};

// ─── RANKING SCORE ────────────────────────────────────────────────────────────────
// Returns a composite score 0-100 for sorting. Weights:
//   Rating        40% (0-5 → 0-40)
//   Response speed 25% (tier 1-4 → 0-25)
//   Review count  15% (capped at 50 reviews → 0-15)
//   Plan tier     15% (basic=5, featured=10, premium=15)
//   Emergency      5% (boolean → 0-5)
const rankScore = (p) => {
  const rating    = (p.liveRating || p.rating || 0);
  const reviews   = Math.min(p.liveReviewCount || p.reviewCount || 0, 50);
  const speedTier = getSpeedTier(p.avgResponseMins ?? p.avgResponseHrs * 60 ?? null); // support both old and new
  const planScore = p.plan === "premium" ? 15 : p.plan === "featured" ? 10 : 5;
  return (
    (rating / 5) * 40 +
    ((speedTier?.score || 0) / 4) * 25 +
    (reviews / 50) * 15 +
    planScore +
    (p.emergency ? 5 : 0)
  );
};
// ─── AVAILABILITY & DEALS HELPERS ───────────────────────────────────────────────

const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// Save provider's available days for the current week
const saveAvailability = async (providerId, days, slotsLeft) => {
  try {
    await store.set(`avail:${providerId}`, {
      days,        // e.g. ["Mon","Tue","Wed"]
      slotsLeft,   // number: 0-10
      updatedAt: new Date().toISOString(),
    });
  } catch {}
};

const getAvailability = async (providerId) => {
  try {
    const raw = await store.get(`avail:${providerId}`);
    return raw ? JSON.parse(raw.value) : null;
  } catch { return null; }
};

// Check if provider is available today
const isAvailableToday = (avail) => {
  if (!avail) return true; // no data = assume available
  if (avail.slotsLeft === 0) return false;
  const today = DAY_NAMES[new Date().getDay()];
  return avail.days?.includes(today) ?? true;
};

// Save a provider's weekly deal
const saveDeal = async (providerId, deal) => {
  try {
    const raw = await store.get("deals");
    const deals = raw ? JSON.parse(raw.value) : [];
    const filtered = deals.filter(d => d.providerId !== providerId); // replace existing
    filtered.unshift({ ...deal, providerId, id: `deal-${Date.now()}`, ts: new Date().toISOString() });
    await store.set("deals", filtered.slice(0, 100));
  } catch {}
};

const getDeals = async () => {
  try {
    const raw = await store.get("deals");
    return raw ? JSON.parse(raw.value) : [];
  } catch { return []; }
};

const deleteDeal = async (providerId) => {
  try {
    const raw = await store.get("deals");
    const deals = raw ? JSON.parse(raw.value) : [];
    await store.set("deals", deals.filter(d => d.providerId !== providerId));
  } catch {}
};


const MAX_STRIKES      = 3;
const STRIKE_THRESHOLD = 2; // ratings at or below this trigger a strike

// ─── DISCOUNT HELPERS ────────────────────────────────────────────────────────────
const saveDiscount = async ({ customerId, providerId, providerName, bizName, discountPct, jobId }) => {
  try {
    const key = `discounts:${customerId}`;
    const raw = await store.get(key);
    const discounts = raw ? JSON.parse(raw.value) : [];
    const discount = {
      id: `disc-${Date.now()}`,
      customerId, providerId, providerName, bizName,
      discountPct, jobId,
      redeemed:  false,
      ts:        new Date().toISOString(),
      dateLabel: new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" }),
    };
    // Replace any existing unredeemed discount from same provider
    const filtered = discounts.filter(d => !(d.providerId === providerId && !d.redeemed));
    filtered.unshift(discount);
    await store.set(key, filtered.slice(0, 30));
    return discount;
  } catch { return null; }
};

const getDiscounts = async (customerId) => {
  try {
    const raw = await store.get(`discounts:${customerId}`);
    return raw ? JSON.parse(raw.value) : [];
  } catch { return []; }
};

const redeemDiscount = async (customerId, discountId) => {
  try {
    const raw = await store.get(`discounts:${customerId}`);
    const discounts = raw ? JSON.parse(raw.value) : [];
    await store.set(`discounts:${customerId}`, discounts.map(d =>
      d.id === discountId ? { ...d, redeemed: true, redeemedAt: new Date().toISOString() } : d
    ));
  } catch {}
};

// ─── REFERRAL SYSTEM ─────────────────────────────────────────────────────────────
const makeRefCode = (email) => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  let n = email.split("").reduce((a, c, i) => a + c.charCodeAt(0) * (i + 1), 0);
  for (let i = 0; i < 6; i++) { code += chars[n % chars.length]; n = Math.floor(n / chars.length) + 31; }
  return code;
};

const REFERRAL_CREDIT_AMOUNT = 50; // R50 credited to referrer on friend's first completed job
const REFERRAL_FRIEND_DISCOUNT = 10; // 10% off friend's first job

const saveReferralCredit = async (customerId, amount, fromName) => {
  try {
    const key = `credits:${customerId}`;
    const raw = await store.get(key);
    const credits = raw ? JSON.parse(raw.value) : [];
    credits.unshift({
      id: `cr-${Date.now()}`,
      amount, fromName,
      redeemed: false,
      ts: new Date().toISOString(),
      dateLabel: new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" }),
    });
    await store.set(key, credits.slice(0, 50));
  } catch {}
};

const getCredits = async (customerId) => {
  try {
    const raw = await store.get(`credits:${customerId}`);
    return raw ? JSON.parse(raw.value) : [];
  } catch { return []; }
};

const getTotalCredit = (credits) =>
  credits.filter(c => !c.redeemed).reduce((sum, c) => sum + c.amount, 0);

// Called when a job is completed — checks if referrer should be rewarded
const processReferralReward = async (customerEmail, customerName) => {
  try {
    const cusRaw = await store.get("customers");
    const customers = cusRaw ? JSON.parse(cusRaw.value) : [];
    const customer = customers.find(c => c.email === customerEmail);
    if (!customer?.referredBy) return;
    // Only reward on first ever completed job
    const jobsRaw = await store.get("jobs");
    const jobs = jobsRaw ? JSON.parse(jobsRaw.value) : [];
    const completedCount = jobs.filter(j => j.customerId === customerEmail && j.status === "completed").length;
    if (completedCount !== 1) return;
    // Give referrer R50 credit
    await saveReferralCredit(customer.referredBy, REFERRAL_CREDIT_AMOUNT, customerName);
    await pushNotif(customer.referredBy, {
      title: `You earned R${REFERRAL_CREDIT_AMOUNT} credit!`,
      body:  `${customerName} completed their first booking via your referral link. R${REFERRAL_CREDIT_AMOUNT} added to your credit wallet.`,
      type:  "completed",
    });
  } catch {}
};

const saveReview = async ({ jobId, providerId, providerName, customerId, customerName, rating, comment, serviceType }) => {
  const now = new Date();
  const review = {
    id: `rev-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    jobId, providerId, providerName, customerId, customerName,
    rating, comment, serviceType,
    isStrike: providerId ? rating <= STRIKE_THRESHOLD : false,
    ts:        now.toISOString(),
    dateLabel: now.toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" }),
  };

  // 1. Global reviews log
  try {
    const raw = await store.get("reviews");
    const reviews = raw ? JSON.parse(raw.value) : [];
    reviews.unshift(review);
    await store.set("reviews", reviews);
  } catch {}

  // 2. Provider record — update rating, attach review, apply strike logic
  if (providerId) {
    try {
      const raw = await store.get("providers");
      const providers = raw ? JSON.parse(raw.value) : [];
      let strikeResult = null;   // { newCount, wasAutoSuspended }

      const updated = providers.map(p => {
        if (p.id !== providerId) return p;

        const provReviews = [review, ...(p.reviews || [])].slice(0, 200);
        const avg = provReviews.reduce((s, r) => s + r.rating, 0) / provReviews.length;

        let strikes    = p.strikes || 0;
        let strikeLog  = p.strikeLog  || [];
        let status     = p.status;
        let autoSuspendedAt = p.autoSuspendedAt || null;

        if (rating <= STRIKE_THRESHOLD) {
          strikes += 1;
          strikeLog = [
            { strikNum: strikes, reviewId: review.id, rating, comment, customerName, ts: now.toISOString(), dateLabel: now.toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" }), cleared: false },
            ...strikeLog,
          ].slice(0, 20);

          if (strikes >= MAX_STRIKES && status === "approved") {
            status = "suspended";
            autoSuspendedAt = now.toISOString();
          }

          strikeResult = { newCount: strikes, wasAutoSuspended: strikes >= MAX_STRIKES };
        }

        return {
          ...p,
          reviews: provReviews,
          liveRating: Math.round(avg * 10) / 10,
          liveReviewCount: provReviews.length,
          strikes,
          strikeLog,
          status,
          autoSuspendedAt,
        };
      });

      await store.set("providers", updated);

      // 3. Notify provider of strike
      if (strikeResult) {
        const { newCount, wasAutoSuspended } = strikeResult;
        if (wasAutoSuspended) {
          await pushNotif(providerId, {
            title: "⛔ Account suspended",
            body:  `You have received ${MAX_STRIKES} negative reviews. Your account has been suspended pending admin review. Please contact support.`,
            type:  "strike",
          });
        } else {
          const remaining = MAX_STRIKES - newCount;
          await pushNotif(providerId, {
            title: `⚠️ Strike ${newCount} of ${MAX_STRIKES}`,
            body:  `You received a ${rating}★ review. ${remaining} more strike${remaining !== 1 ? "s" : ""} will result in account suspension. Please ensure quality service.`,
            type:  "strike",
          });
        }
      }
    } catch {}
  }

  // 4. Mark job as reviewed
  try {
    const raw = await store.get("jobs");
    const jobs = raw ? JSON.parse(raw.value) : [];
    await store.set("jobs", jobs.map(j => j.id === jobId ? { ...j, reviewed: true } : j));
  } catch {}

  return review;
};

// Admin helper — clear a specific strike from a provider
const clearStrike = async (providerId, strikeIndex) => {
  try {
    const raw = await store.get("providers");
    const providers = raw ? JSON.parse(raw.value) : [];
    const updated = providers.map(p => {
      if (p.id !== providerId) return p;
      const strikeLog = (p.strikeLog || []).map((s, i) => i === strikeIndex ? { ...s, cleared: true } : s);
      const activeStrikes = strikeLog.filter(s => !s.cleared).length;
      // Restore to approved if strikes cleared below threshold
      const status = p.status === "suspended" && activeStrikes < MAX_STRIKES ? "approved" : p.status;
      return { ...p, strikeLog, strikes: activeStrikes, status };
    });
    await store.set("providers", updated);
    return updated;
  } catch { return []; }
};

// ─── NOTIFICATION HELPERS ────────────────────────────────────────────────────────
const pushNotif = async (userId, { title, body, type, jobId }) => {
  try {
    const key = `notifs:${userId}`;
    const raw = await store.get(key);
    const notifs = raw ? JSON.parse(raw.value) : [];
    notifs.unshift({ id: `n-${Date.now()}`, title, body, type, jobId, ts: new Date().toISOString(), read: false });
    await store.set(key, notifs.slice(0, 50));
  } catch {}
};
const getNotifs = async (userId) => {
  try { const r = await store.get(`notifs:${userId}`); return r ? JSON.parse(r.value) : []; } catch { return []; }
};
const markNotifsRead = async (userId) => {
  try {
    const r = await store.get(`notifs:${userId}`);
    const n = r ? JSON.parse(r.value) : [];
    await store.set(`notifs:${userId}`, n.map(x => ({ ...x, read: true })));
  } catch {}
};

// ─── SEARCH HISTORY HELPERS ──────────────────────────────────────────────────────
const saveSearch = async (userId, { serviceId, location }) => {
  try {
    const key = `searches:${userId}`;
    const raw = await store.get(key);
    const searches = raw ? JSON.parse(raw.value) : [];
    const entry = { serviceId, location, ts: new Date().toISOString() };
    const deduped = searches.filter(s => !(s.serviceId === serviceId && s.location === location));
    await store.set(key, [entry, ...deduped].slice(0, 6));
  } catch {}
};
const getSearchHistory = async (userId) => {
  try { const r = await store.get(`searches:${userId}`); return r ? JSON.parse(r.value) : []; } catch { return []; }
};

const KZN_AREAS = [
  "Amanzimtoti", "Ballito", "Berea", "Bluff", "Chatsworth", "Clairwood",
  "Cato Ridge", "Durban CBD", "Durban North", "Escourt", "Gillitts",
  "Glen Anil", "Glenwood", "Hillcrest", "Howick", "Isipingo", "La Lucia",
  "Ladysmith", "Malvern", "Margate", "Montclair", "Morningside", "Musgrave",
  "New Germany", "Overport", "Parkhill", "Phoenix", "Pinetown", "Port Shepstone",
  "Queensburgh", "Richards Bay", "Rosettenville", "Scottsville", "Springfield",
  "Stanger", "Tongaat", "Umhlanga", "Umlazi", "Westville", "Windermere",
];

// Areas relevant per service type (subset shown first, rest available)
const SERVICE_AREA_HINTS = {
  plumber:     ["Berea", "Morningside", "Musgrave", "Glenwood", "Westville", "Pinetown", "Umhlanga", "Durban North", "Hillcrest", "Ballito"],
  electrician: ["Berea", "Morningside", "Umhlanga", "Westville", "Pinetown", "Hillcrest", "Durban CBD", "La Lucia", "Durban North", "Phoenix"],
  handyman:    ["Berea", "Morningside", "Musgrave", "Glenwood", "Westville", "Umhlanga", "Durban North", "Hillcrest", "La Lucia", "Pinetown"],
  security:    ["Umhlanga", "La Lucia", "Morningside", "Hillcrest", "Westville", "Durban North", "Ballito", "Musgrave", "Berea", "Glen Anil"],
  gate_repair: ["Umhlanga", "La Lucia", "Morningside", "Hillcrest", "Westville", "Durban North", "Ballito", "Musgrave", "Berea", "Pinetown"],
};

// ─── HOME MARK LOGO ─────────────────────────────────────────────────────────────
function Logo({ size = 36 }) {
  const s = size;
  // Scale factor relative to our 80×72 viewBox
  const iconW = Math.round(s * 0.72);
  const iconH = Math.round(s * 0.65);
  const badgeR = Math.max(6, Math.round(s * 0.19));
  const badgeOffset = Math.round(s * 0.06);
  const borderW = Math.max(1.5, Math.round(s * 0.045));

  return (
    <div style={{ position: "relative", width: s, height: s, flexShrink: 0 }}>
      {/* Gradient rounded-rect background */}
      <div style={{
        width: s, height: s,
        borderRadius: Math.round(s * 0.25),
        background: "linear-gradient(135deg,#0EA5E9,#6366F1)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <svg width={iconW} height={iconH} viewBox="0 0 80 72" fill="none">
          {/* House body */}
          <rect x="12" y="34" width="56" height="34" rx="5" fill="white" opacity="0.15"/>
          <rect x="12" y="34" width="56" height="34" rx="5" fill="none" stroke="white" strokeWidth="2.5"/>
          {/* Roof */}
          <path d="M6 36 L40 6 L74 36" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          {/* Checkmark */}
          <path d="M24 51 L33 60 L56 42" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        </svg>
      </div>
      {/* Amber star badge */}
      <div style={{
        position: "absolute", top: -badgeOffset, right: -badgeOffset,
        width: badgeR * 2, height: badgeR * 2,
        borderRadius: "50%", background: "#F59E0B",
        border: `${borderW}px solid #060A14`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <svg width={badgeR * 1.1} height={badgeR * 1.1} viewBox="0 0 12 12" fill="none">
          <path d="M6 1 L7.4 4.2 L11 4.6 L8.5 7 L9.1 10.5 L6 8.8 L2.9 10.5 L3.5 7 L1 4.6 L4.6 4.2 Z" fill="white"/>
        </svg>
      </div>
    </div>
  );
}

// ─── WORDMARK ───────────────────────────────────────────────────────────────────
function Wordmark({ size = 20, showTagline = false }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{
        fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700,
        fontSize: size, letterSpacing: "-0.04em", lineHeight: 1,
        color: "white",
      }}>
        fix<span style={{ color: "#38BDF8" }}>it</span>
        <span style={{ color: "rgba(255,255,255,0.18)", fontWeight: 400 }}> · </span>
        <span style={{ color: "#F59E0B" }}>now</span>
      </span>
      {showTagline && (
        <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: "#334155", letterSpacing: "0.16em" }}>
          TRUSTED HOME SERVICES
        </span>
      )}
    </div>
  );
}

// ─── SHARED UI ──────────────────────────────────────────────────────────────────
function Input({ label, value, onChange, placeholder, type = "text", icon }) {
  return (
    <div style={{ marginBottom: 14 }}>
      {label && <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 6, fontFamily: "'DM Sans',sans-serif" }}>{label}</label>}
      <div style={{ position: "relative" }}>
        {icon && <span style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", display: "flex", alignItems: "center" }}>{icon}</span>}
        <input
          type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
          style={{
            width: "100%", background: "rgba(255,255,255,0.04)", border: "1.5px solid rgba(255,255,255,0.08)",
            borderRadius: 11, padding: `12px ${icon ? "12px 12px 38px" : "14px"}`,
            paddingLeft: icon ? 40 : 14,
            color: "#E2E8F0", fontSize: 14, fontFamily: "'DM Sans',sans-serif", outline: "none",
          }}
        />
      </div>
    </div>
  );
}

function Btn({ children, onClick, variant = "primary", disabled, full, small, style: extraStyle }) {
  const styles = {
    primary: { background: "linear-gradient(135deg,#0EA5E9,#6366F1)", color: "white", border: "none", boxShadow: "0 6px 24px rgba(14,165,233,0.25)" },
    danger:  { background: "linear-gradient(135deg,#EF4444,#DC2626)", color: "white", border: "none" },
    ghost:   { background: "rgba(255,255,255,0.05)", color: "#94A3B8", border: "1.5px solid rgba(255,255,255,0.08)" },
    green:   { background: "linear-gradient(135deg,#10B981,#059669)", color: "white", border: "none" },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      ...styles[variant], borderRadius: 11,
      padding: small ? "8px 16px" : "13px 20px",
      fontSize: small ? 12 : 14, fontWeight: 600,
      fontFamily: "'DM Sans',sans-serif", cursor: disabled ? "default" : "pointer",
      width: full ? "100%" : "auto", opacity: disabled ? 0.5 : 1,
      display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
      transition: "all 0.2s", ...extraStyle,
    }}>{children}</button>
  );
}

function StarRating({ rating }) {
  const filled = Math.round(rating);
  return (
    <span style={{ display: "inline-flex", gap: 2 }}>
      {[1,2,3,4,5].map(i => (
        <svg key={i} width="11" height="11" viewBox="0 0 12 12" fill="none">
          <path d="M6 1 L7.3 4.3 L11 4.8 L8.5 7.2 L9.1 11 L6 9.3 L2.9 11 L3.5 7.2 L1 4.8 L4.7 4.3 Z"
            fill={i <= filled ? "#F59E0B" : "none"}
            stroke={i <= filled ? "#F59E0B" : "#374151"}
            strokeWidth="0.8" strokeLinejoin="round" />
        </svg>
      ))}
    </span>
  );
}

function Badge({ children, color = "#0EA5E9" }) {
  return (
    <span style={{
      background: `${color}22`, border: `1px solid ${color}44`, color, borderRadius: 20,
      padding: "2px 8px", fontSize: 10, fontWeight: 700, letterSpacing: "0.07em",
      fontFamily: "'DM Sans',sans-serif", textTransform: "uppercase",
      display: "inline-flex", alignItems: "center", gap: 4,
    }}>{children}</span>
  );
}

// ─── BRAND ICON SYSTEM ───────────────────────────────────────────────────────────
// All icons are pure SVG paths — brand colours, consistent 16px grid.
// Usage: <Icon name="phone" size={14} color="#10B981" />
const ICON_PATHS = {
  // Services
  plumber:    "M9 2C9 1.4 8.6 1 8 1H4C3.4 1 3 1.4 3 2V4C3 5.1 3.5 6 4 6.5V10H3V11H9V10H8V6.5C8.5 6 9 5.1 9 4V2Z M5 3H7V4.5C7 5.3 6.6 5.9 6 6.2 5.4 5.9 5 5.3 5 4.5V3Z",
  electrician:"M7 1L2 7H6L5 11L10 5H6L7 1Z",
  handyman:   "M10.5 2.5L9 1L7.5 2.5L9 4L7 6H5C4.4 6 4 6.4 4 7V9L2 11L3 12L5 10H7C7.6 10 8 9.6 8 9V7L10 5L11.5 6.5L13 5L10.5 2.5Z",
  security:   "M6 1L1 3V7C1 9.8 3.2 12.3 6 13 8.8 12.3 11 9.8 11 7V3L6 1Z M4.5 6.5L5.5 7.5L7.5 5.5",
  gate_repair:"M2 2H4V10H2V2Z M8 2H10V10H8V10Z M4 5H8 M4 3H5 M7 3H8 M4 7H5 M7 7H8",
  technology: "M1 2H13V10H1V2Z M4 10V12 M10 10V12 M3 12H11 M5 5H9 M5 7H8",
  // Actions
  phone:      "M4.5 1C3.7 1 3 1.7 3 2.5C3 7.2 6.8 11 11.5 11C12.3 11 13 10.3 13 9.5V8C13 7.3 12.5 6.7 11.8 6.5L10.2 6.1C9.6 5.9 9 6.2 8.7 6.7L8.3 7.4C7.2 6.9 6.1 5.8 5.6 4.7L6.3 4.3C6.8 4 7.1 3.4 6.9 2.8L6.5 1.2C6.3 0.5 5.7 0 5 0L4.5 1Z",
  whatsapp:   "M7 1C3.7 1 1 3.7 1 7C1 8.1 1.3 9.2 1.9 10.1L1 13L4 12.1C4.9 12.7 5.9 13 7 13C10.3 13 13 10.3 13 7S10.3 1 7 1Z M5 5.5C5.2 5.5 5.4 5.5 5.5 5.5L6 6.8L5.5 7.3C5.7 7.8 6.2 8.4 6.7 8.7L7.2 8.2L8.5 8.7C8.5 8.8 8.5 9.1 8.4 9.3C8.1 9.6 7.3 9.8 6.8 9.5C6 9.1 4.9 8 4.5 7.2C4.2 6.7 4.4 5.8 5 5.5Z",
  directions: "M7 1L13 7L7 13L5.6 11.6L9.2 8H1V6H9.2L5.6 2.4L7 1Z",
  star:       "M7 1L8.8 5.2L13 5.7L10 8.6L10.9 13L7 10.8L3.1 13L4 8.6L1 5.7L5.2 5.2Z",
  location:   "M7 1C4.8 1 3 2.8 3 5C3 8 7 13 7 13C7 13 11 8 11 5C11 2.8 9.2 1 7 1Z M7 6.5C6.2 6.5 5.5 5.8 5.5 5S6.2 3.5 7 3.5 8.5 4.2 8.5 5 7.8 6.5 7 6.5Z",
  bell:       "M7 1C7 1 3 3 3 7V9L2 10V11H12V10L11 9V7C11 3 7 1 7 1Z M6 11C6 11.6 6.4 12 7 12S8 11.6 8 11H6Z",
  // Status / system
  check:      "M2 7L5 10L12 3",
  cross:      "M3 3L11 11 M11 3L3 11",
  pending:    "M7 1C3.7 1 1 3.7 1 7S3.7 13 7 13 13 10.3 13 7 10.3 1 7 1Z M7 4V7.5L9.5 10",
  warning:    "M7 1L13 12H1L7 1Z M7 5V8 M7 10V10.5",
  suspend:    "M3 3L11 11 M7 1C3.7 1 1 3.7 1 7S3.7 13 7 13 13 10.3 13 7 10.3 1 7 1Z",
  // Speed
  lightning:  "M9 1L4 8H7L5 13L12 6H8L9 1Z",
  clock:      "M7 1C3.7 1 1 3.7 1 7S3.7 13 7 13 13 10.3 13 7 10.3 1 7 1Z M7 4V7L9 9",
  calendar:   "M2 3H12V12H2V3Z M2 6H12 M5 1V4 M9 1V4",
  slow:       "M1 7C1 7 3 5 7 5S13 7 13 7 M7 5V3 M4 4L5 5.5 M10 4L9 5.5",
  // Reviews
  review:     "M7 1L8.8 5.2L13 5.7L10 8.6L10.9 13L7 10.8L3.1 13L4 8.6L1 5.7L5.2 5.2Z",
  // Navigation
  search:     "M6 1C3.2 1 1 3.2 1 6S3.2 11 6 11C7.1 11 8.2 10.6 9 10L12 13L13 12L10 9C10.6 8.2 11 7.1 11 6C11 3.2 8.8 1 6 1Z M6 3C7.7 3 9 4.3 9 6S7.7 9 6 9 3 7.7 3 6 4.3 3 6 3Z",
  jobs:       "M2 2H9L12 5V12H2V2Z M9 2V5H12 M4 7H10 M4 9H8",
  profile:    "M7 1C5.3 1 4 2.3 4 4S5.3 7 7 7 10 5.7 10 4 8.7 1 7 1Z M1 13C1 10.2 3.7 8 7 8S13 10.2 13 13",
  overview:   "M1 8H5V12H1V8Z M5 5H9V12H5V5Z M9 2H13V12H9V2Z",
  settings:   "M7 5C5.9 5 5 5.9 5 7S5.9 9 7 9 9 8.1 9 7 8.1 5 7 5Z M7 1L8.2 3.2C8.7 3.3 9.2 3.6 9.6 3.9L12 3.2L13 5.2L11.2 6.8C11.3 7.2 11.3 7.8 11.2 8.2L13 9.8L12 11.8L9.6 11.1C9.2 11.4 8.7 11.7 8.2 11.8L7 14L5.8 11.8C5.3 11.7 4.8 11.4 4.4 11.1L2 11.8L1 9.8L2.8 8.2C2.7 7.8 2.7 7.2 2.8 6.8L1 5.2L2 3.2L4.4 3.9C4.8 3.6 5.3 3.3 5.8 3.2L7 1Z",
  // Emergency
  emergency:  "M7 1L13 4V7C13 10.3 10.4 13.3 7 14C3.6 13.3 1 10.3 1 7V4L7 1Z M7 5V8 M7 10V10.5",
  // Globe (All KZN)
  globe:      "M7 1C3.7 1 1 3.7 1 7S3.7 13 7 13 13 10.3 13 7 10.3 1 7 1Z M1 7H13 M7 1C5.3 3 4.3 4.9 4 7S5.3 11 7 13C8.7 11 9.7 9.1 10 7S8.7 3 7 1Z",
  // Provider / home
  home:       "M1 7L7 1L13 7V13H9V9H5V13H1V7Z",
  // Booking
  booking:    "M2 1H12V13H2V1Z M4 4H10 M4 6H10 M4 8H7",
  // WhatsApp send
  send:       "M1 1L13 7L1 13V8.5L9 7L1 5.5V1Z",
  // Rating / verified
  verified:   "M7 1L8.8 5.2L13 5.7L10 8.6L10.9 13L7 10.8L3.1 13L4 8.6L1 5.7L5.2 5.2Z",
  // Leads / chart
  chart:      "M1 12V9L4 6L7 8L10 4L13 6V12H1Z",
  // Strike
  strike:     "M7 1C3.7 1 1 3.7 1 7S3.7 13 7 13 13 10.3 13 7 10.3 1 7 1Z M4.5 4.5L9.5 9.5 M9.5 4.5L4.5 9.5",
  // Message bubble
  message:    "M1 1H13V9H8L6 12L4 9H1V1Z M4 4H10 M4 6H8",
  // GPS pin
  pin:        "M7 1C4.8 1 3 2.8 3 5C3 8 7 13 7 13C7 13 11 8 11 5C11 2.8 9.2 1 7 1Z M7 6.5C6.2 6.5 5.5 5.8 5.5 5S6.2 3.5 7 3.5 8.5 4.2 8.5 5 7.8 6.5 7 6.5Z",
};

function Icon({ name, size = 14, color = "currentColor", strokeWidth = 1.5 }) {
  const path = ICON_PATHS[name];
  if (!path) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none"
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}>
      <path d={path} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

// Service icons — custom geometric SVG matching each trade
function ServiceIcon({ serviceId, size = 20, color = "#0EA5E9" }) {
  const iconName = serviceId === "gate_repair" ? "gate_repair" : serviceId;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none"
      style={{ display: "inline-block", flexShrink: 0 }}>
      <path d={ICON_PATHS[iconName] || ICON_PATHS.handyman}
        stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

// Speed badge — brand-coloured pill with inline SVG icon, no emoji
function SpeedBadge({ avgResponseMins }) {
  const tier = getSpeedTier(avgResponseMins ?? null);
  if (!tier) return null;
  const iconName = tier.maxHrs <= 1 ? "lightning" : tier.maxHrs <= 4 ? "clock" : tier.maxHrs <= 24 ? "calendar" : "slow";
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, borderRadius: 20, padding: "2px 8px",
      background: `${tier.color}18`, border: `1px solid ${tier.color}40`, color: tier.color,
      display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "'DM Sans',sans-serif",
      letterSpacing: "0.04em",
    }}>
      <Icon name={iconName} size={10} color={tier.color} strokeWidth={2} />
      {tier.short}
    </span>
  );
}

// Status badge for job lifecycle
function StatusBadge({ status }) {
  const st = JOB_STATUS[status] || JOB_STATUS.pending;
  const iconName = status === "completed" ? "check" : status === "declined" ? "cross" : status === "inprogress" ? "lightning" : status === "accepted" ? "check" : status === "onroute" ? "location" : "pending";
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, borderRadius: 20, padding: "3px 10px",
      background: `${st.color}20`, border: `1px solid ${st.color}44`, color: st.color,
      display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "'DM Sans',sans-serif",
      letterSpacing: "0.04em", flexShrink: 0,
    }}>
      <Icon name={iconName} size={10} color={st.color} strokeWidth={2} />
      {st.label}
    </span>
  );
}

// Notification type icon — small coloured dot with SVG
function NotifIcon({ type }) {
  const map = {
    booking:    { name: "booking",   color: "#F59E0B" },
    accepted:   { name: "check",     color: "#10B981" },
    declined:   { name: "cross",     color: "#EF4444" },
    inprogress: { name: "lightning", color: "#8B5CF6" },
    completed:  { name: "check",     color: "#10B981" },
    review:     { name: "star",      color: "#F59E0B" },
    strike:     { name: "warning",   color: "#EF4444" },
    default:    { name: "bell",      color: "#0EA5E9" },
  };
  const { name, color } = map[type] || map.default;
  return (
    <div style={{ width: 28, height: 28, borderRadius: 8, background: `${color}15`, border: `1px solid ${color}30`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <Icon name={name} size={13} color={color} strokeWidth={1.8} />
    </div>
  );
}

// ─── AUTH SCREEN ────────────────────────────────────────────────────────────────
function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState("welcome");
  const [form, setForm] = useState({ name: "", email: "", password: "", phone: "", address: "", suburb: "", city: "", province: "" });
  const [locating, setLocating] = useState(false);
  const [adminCode, setAdminCode] = useState("");
  const [adminError, setAdminError] = useState("");
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const ADMIN_PASSWORD = "1234";

  const tryAdminLogin = () => {
    if (adminCode === ADMIN_PASSWORD) {
      onLogin({ name: "Admin", email: "admin@fixitnow.co.za", role: "admin" });
    } else {
      setAdminError("Incorrect access code. Please try again.");
      setAdminCode("");
    }
  };

  const gps = () => {
    setLocating(true);
    navigator.geolocation?.getCurrentPosition(pos => {
      fetch(`https://nominatim.openstreetmap.org/reverse?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}&format=json`)
        .then(r => r.json()).then(d => {
          set("suburb", d.address?.suburb || d.address?.neighbourhood || "");
          set("city", d.address?.city || d.address?.town || "");
          set("province", d.address?.state || "");
          setLocating(false);
        }).catch(() => setLocating(false));
    }, () => setLocating(false));
  };

  const doSignup = async () => {
    if (!form.name.trim()) { return alert("Please enter your name."); }
    if (!form.email.trim()) { return alert("Please enter your email."); }
    if (!form.password || form.password.length < 6) { return alert("Password must be at least 6 characters."); }
    const raw = await store.get("customers");
    const customers = raw ? JSON.parse(raw.value) : [];
    if (customers.find(c => c.email.toLowerCase() === form.email.toLowerCase())) {
      return alert("An account with this email already exists. Please sign in.");
    }
    // Detect referral code from URL (?ref=XXXXX)
    const urlRef = new URLSearchParams(window.location.search).get("ref");
    let referredBy = null;
    if (urlRef) {
      const referrer = customers.find(c => makeRefCode(c.email) === urlRef.toUpperCase());
      if (referrer) referredBy = referrer.email;
    }
    const refCode = makeRefCode(form.email);
    const newCustomer = {
      name: form.name, email: form.email, password: form.password,
      phone: form.phone, address: form.address, suburb: form.suburb,
      city: form.city, province: form.province,
      role: "customer",
      notifPreference: form.notifPreference || "whatsapp",
      refCode,
      referredBy,
      joinDate: new Date().toISOString(),
    };
    customers.push(newCustomer);
    await store.set("customers", customers);
    // If referred, give friend their 10% first-booking discount immediately
    if (referredBy) {
      await saveReferralCredit(form.email, 0, ""); // placeholder — discount applied at booking
      await pushNotif(form.email, {
        title: "Welcome! You have a referral bonus 🎁",
        body:  `You were referred by a friend — enjoy ${REFERRAL_FRIEND_DISCOUNT}% off your first completed booking. It's already in your wallet!`,
        type:  "completed",
      });
    }
    onLogin(newCustomer);
  };

  const doLogin = async () => {
    if (!form.email.trim() || !form.password.trim()) { return alert("Please enter your email and password."); }
    const raw = await store.get("customers");
    const customers = raw ? JSON.parse(raw.value) : [];
    const match = customers.find(c => c.email.toLowerCase() === form.email.toLowerCase());
    if (!match) { return alert("No account found with that email. Please sign up first."); }
    if (match.password !== form.password) { return alert("Incorrect password. Please try again."); }
    onLogin(match);
  };

  const doProviderLogin = async () => {
    if (!form.email.trim() || !form.password.trim()) { return alert("Please enter your email and password."); }
    const raw = await store.get("providers");
    const providers = raw ? JSON.parse(raw.value) : [];
    const match = providers.find(p => p.email.toLowerCase() === form.email.toLowerCase());
    if (!match) { return alert("No provider account found with that email. Please register your business first."); }
    if (match.password !== form.password) { return alert("Incorrect password. Please try again."); }
    onLogin({ ...match, role: "provider" });
  };

  if (mode === "welcome") return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 24px", background: "#060A14" }}>
      {/* Ambient glows */}
      <div style={{ position: "fixed", top: -150, right: -150, width: 500, height: 500, borderRadius: "50%", background: "radial-gradient(circle,rgba(14,165,233,0.07) 0%,transparent 70%)", pointerEvents: "none" }} />
      <div style={{ position: "fixed", bottom: -100, left: -100, width: 400, height: 400, borderRadius: "50%", background: "radial-gradient(circle,rgba(99,102,241,0.06) 0%,transparent 70%)", pointerEvents: "none" }} />

      <div style={{ maxWidth: 360, width: "100%", textAlign: "center" }}>
        {/* Logo hero */}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
          <Logo size={80} />
        </div>
        <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 36, letterSpacing: "-1.5px", color: "white", marginBottom: 4, lineHeight: 1 }}>
          fix<span style={{ color: "#38BDF8" }}>it</span>
          <span style={{ color: "rgba(255,255,255,0.15)", fontWeight: 400 }}> · </span>
          <span style={{ color: "#F59E0B" }}>now</span>
        </div>
        <p style={{ color: "#64748B", fontSize: 14, lineHeight: "1.6", marginBottom: 8 }}>Trusted pros. Fixed fast.</p>
        <p style={{ color: "#334155", fontSize: 12, lineHeight: "1.6", marginBottom: 36 }}>Plumbers · Electricians · Security · Handymen · 24/7</p>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Customer lane */}
          <div style={{ background: "rgba(14,165,233,0.06)", border: "1px solid rgba(14,165,233,0.15)", borderRadius: 16, padding: "16px 16px 12px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#0EA5E9", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>I need a service</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Btn full onClick={() => setMode("signup")}>Sign up — find pros near me</Btn>
              <Btn full variant="ghost" onClick={() => setMode("login")}>Sign in to my account</Btn>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0" }}>
            <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.06)" }} />
            <span style={{ color: "#334155", fontSize: 11 }}>or</span>
            <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.06)" }} />
          </div>

          {/* Provider lane */}
          <div style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.15)", borderRadius: 16, padding: "16px 16px 12px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#F59E0B", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>I'm a service provider</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Btn full onClick={() => setMode("provider")} style={{ background: "linear-gradient(135deg,#F59E0B,#D97706)" }}>Register my business</Btn>
              <Btn full variant="ghost" onClick={() => setMode("providerLogin")}>Business dashboard</Btn>
            </div>
          </div>

          <button onClick={() => { setAdminCode(""); setAdminError(""); setMode("adminLogin"); }} style={{ background: "none", border: "none", color: "#1E293B", fontSize: 10, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", textAlign: "center", padding: "8px 0 0" }}>Admin</button>
        </div>
      </div>
    </div>
  );

  if (mode === "adminLogin") return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", padding: "48px 24px 32px", background: "#060A14", maxWidth: 420, margin: "0 auto" }}>
      <button onClick={() => setMode("welcome")} style={{ background: "none", border: "none", color: "#64748B", fontSize: 13, cursor: "pointer", marginBottom: 32, textAlign: "left", fontFamily: "'DM Sans',sans-serif" }}>← Back</button>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
        <Logo size={36} />
        <Wordmark size={20} showTagline />
      </div>
      <h2 style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 24, color: "#F1F5F9", marginBottom: 6 }}>Admin Portal</h2>
      <p style={{ color: "#64748B", fontSize: 13, marginBottom: 28 }}>Enter your access code to continue.</p>

      <div style={{ marginBottom: 14 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 6, fontFamily: "'DM Sans',sans-serif" }}>Access Code</label>
        <input
          type="password"
          value={adminCode}
          onChange={e => { setAdminCode(e.target.value); setAdminError(""); }}
          onKeyDown={e => e.key === "Enter" && tryAdminLogin()}
          placeholder="Enter access code"
          style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: `1.5px solid ${adminError ? "#EF4444" : "rgba(255,255,255,0.08)"}`, borderRadius: 11, padding: "12px 14px", color: "#E2E8F0", fontSize: 14, fontFamily: "'DM Sans',sans-serif", outline: "none" }}
        />
        {adminError && <div style={{ color: "#EF4444", fontSize: 12, marginTop: 6, fontFamily: "'DM Sans',sans-serif" }}>{adminError}</div>}
      </div>

      <Btn full onClick={tryAdminLogin} style={{ marginTop: 8 }}>Access Admin Portal →</Btn>
    </div>
  );

  if (mode === "login") return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", padding: "48px 24px 32px", background: "#060A14", maxWidth: 420, margin: "0 auto" }}>
      <button onClick={() => setMode("welcome")} style={{ background: "none", border: "none", color: "#64748B", fontSize: 13, cursor: "pointer", marginBottom: 32, textAlign: "left", fontFamily: "'DM Sans',sans-serif" }}>← Back</button>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
        <Logo size={36} />
        <Wordmark size={20} showTagline />
      </div>
      <h2 style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 24, color: "#F1F5F9", marginBottom: 6 }}>Welcome back</h2>
      <p style={{ color: "#64748B", fontSize: 13, marginBottom: 28 }}>Sign in to find home service pros near you.</p>
      <Input label="Email" value={form.email} onChange={v => set("email", v)} placeholder="you@email.com" type="email" />
      <Input label="Password" value={form.password} onChange={v => set("password", v)} placeholder="••••••••" type="password" />
      <Btn full onClick={doLogin} style={{ marginTop: 8 }}>Sign In →</Btn>
      <p style={{ color: "#475569", fontSize: 12, textAlign: "center", marginTop: 20 }}>Don't have an account? <span onClick={() => setMode("signup")} style={{ color: "#0EA5E9", cursor: "pointer" }}>Sign up free</span></p>
    </div>
  );

  if (mode === "signup") return (
    <div style={{ minHeight: "100vh", padding: "48px 24px 48px", background: "#060A14", maxWidth: 420, margin: "0 auto" }}>
      <button onClick={() => setMode("welcome")} style={{ background: "none", border: "none", color: "#64748B", fontSize: 13, cursor: "pointer", marginBottom: 28, fontFamily: "'DM Sans',sans-serif" }}>← Back</button>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
        <Logo size={32} />
        <Wordmark size={18} />
      </div>
      <p style={{ color: "#64748B", fontSize: 13, marginBottom: 24 }}>Your home address helps us instantly find the best pros in your area.</p>
      <Input label="Full Name" value={form.name} onChange={v => set("name", v)} placeholder="Jane Smith" />
      <Input label="Email" value={form.email} onChange={v => set("email", v)} placeholder="you@email.com" type="email" />
      <Input label="Phone" value={form.phone} onChange={v => set("phone", v)} placeholder="+27 82 000 0000" />
      <Input label="Password" value={form.password} onChange={v => set("password", v)} placeholder="••••••••" type="password" />

      {/* Notification preference */}
      <div style={{ marginBottom: 14 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 8, fontFamily: "'DM Sans',sans-serif" }}>How should we notify you?</label>
        <div style={{ display: "flex", gap: 8 }}>
          {[["whatsapp","WhatsApp"],["sms","SMS"]].map(([id, label]) => (
            <button key={id} onClick={() => set("notifPreference", id)}
              style={{ flex: 1, padding: "9px 8px", borderRadius: 9, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", transition: "all 0.15s", background: (form.notifPreference||"whatsapp") === id ? "rgba(14,165,233,0.15)" : "rgba(255,255,255,0.04)", border: `1.5px solid ${(form.notifPreference||"whatsapp") === id ? "#0EA5E9" : "rgba(255,255,255,0.08)"}`, color: (form.notifPreference||"whatsapp") === id ? "#38BDF8" : "#64748B" }}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ background: "rgba(14,165,233,0.06)", border: "1px solid rgba(14,165,233,0.15)", borderRadius: 12, padding: 16, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#0EA5E9", fontFamily: "'DM Sans',sans-serif" }}>Your Home Address</span>
          <button onClick={gps} style={{ background: "rgba(14,165,233,0.15)", border: "1px solid rgba(14,165,233,0.25)", borderRadius: 8, padding: "5px 10px", color: "#0EA5E9", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
            {locating ? "Locating…" : "Use GPS"}
          </button>
        </div>
        <Input label="Street Address" value={form.address} onChange={v => set("address", v)} placeholder="123 Oak Street" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Input label="Suburb" value={form.suburb} onChange={v => set("suburb", v)} placeholder="Berea" />
          <Input label="City" value={form.city} onChange={v => set("city", v)} placeholder="Durban" />
        </div>
        <Input label="Province" value={form.province} onChange={v => set("province", v)} placeholder="KwaZulu-Natal" />
      </div>
      <Btn full onClick={doSignup}>Create Account & Find Pros →</Btn>
      <p style={{ color: "#475569", fontSize: 12, textAlign: "center", marginTop: 16 }}>Already have an account? <span onClick={() => setMode("login")} style={{ color: "#0EA5E9", cursor: "pointer" }}>Sign in</span></p>
    </div>
  );

  if (mode === "provider") return <ProviderRegistration onBack={() => setMode("welcome")} onDone={() => setMode("welcome")} />;

  if (mode === "providerLogin") return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", padding: "48px 24px 32px", background: "#060A14", maxWidth: 420, margin: "0 auto" }}>
      <button onClick={() => setMode("welcome")} style={{ background: "none", border: "none", color: "#64748B", fontSize: 13, cursor: "pointer", marginBottom: 32, textAlign: "left", fontFamily: "'DM Sans',sans-serif" }}>← Back</button>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
        <Logo size={36} />
        <div>
          <Wordmark size={20} />
          <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.14em", marginTop: 2 }}>PROVIDER PORTAL</div>
        </div>
      </div>
      <h2 style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 24, color: "#F1F5F9", marginBottom: 6 }}>Provider sign in</h2>
      <p style={{ color: "#64748B", fontSize: 13, marginBottom: 28 }}>Sign in with the email you used to register your business.</p>
      <Input label="Business Email" value={form.email} onChange={v => set("email", v)} placeholder="you@business.co.za" type="email" />
      <Input label="Password" value={form.password} onChange={v => set("password", v)} placeholder="••••••••" type="password" />
      <Btn full onClick={doProviderLogin} style={{ marginTop: 8 }}>Sign In to Dashboard →</Btn>
      <p style={{ color: "#475569", fontSize: 12, textAlign: "center", marginTop: 20 }}>Not registered yet? <span onClick={() => setMode("provider")} style={{ color: "#0EA5E9", cursor: "pointer" }}>Register your business</span></p>
    </div>
  );
}

// ─── PROVIDER REGISTRATION ──────────────────────────────────────────────────────
function ProviderRegistration({ onBack, onDone }) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    bizName: "", contactName: "", email: "", phone: "", password: "",
    address: "", suburb: "", city: "", province: "",
    services: [], serviceAreas: {}, emergency: false, plan: "featured",
    regNum: "", description: "",
    // Brand & trust fields
    tagline: "",          // e.g. "KZN's most trusted plumber since 2008"
    yearsInBusiness: "",  // e.g. "15"
    priceRangeMin: "",    // e.g. "350"
    priceRangeMax: "",    // e.g. "1200"
    certifications: "",   // e.g. "Licensed electrician, ECSA registered"
    logoUrl: "",          // URL to their logo image
    whatsappNumber: "",   // separate WhatsApp if different from phone
    website: "",          // optional website
    insuranceConfirmed: false,  // self-declared insurance
    backgroundCheckConsent: false,
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const [expandedService, setExpandedService] = useState(null);
  const [showAllAreas, setShowAllAreas] = useState({});
  const [submitted, setSubmitted] = useState(false);

  const toggleService = (id) => {
    const isSelected = form.services.includes(id);
    if (isSelected) {
      set("services", form.services.filter(s => s !== id));
      // Remove areas for this service
      const newAreas = { ...form.serviceAreas };
      delete newAreas[id];
      set("serviceAreas", newAreas);
      if (expandedService === id) setExpandedService(null);
    } else {
      set("services", [...form.services, id]);
      setExpandedService(id);
    }
  };

  const toggleArea = (serviceId, area) => {
    const current = form.serviceAreas[serviceId] || {};
    if (current.allKZN) return; // all KZN overrides individual
    const areas = current.areas || [];
    const next = areas.includes(area) ? areas.filter(a => a !== area) : [...areas, area];
    set("serviceAreas", { ...form.serviceAreas, [serviceId]: { allKZN: false, areas: next } });
  };

  const toggleAllKZN = (serviceId) => {
    const current = form.serviceAreas[serviceId] || {};
    const isAll = current.allKZN;
    set("serviceAreas", { ...form.serviceAreas, [serviceId]: { allKZN: !isAll, areas: [] } });
  };

  const getAreaSummary = (serviceId) => {
    const sa = form.serviceAreas[serviceId];
    if (!sa) return null;
    if (sa.allKZN) return { label: "All KZN", color: "#10B981" };
    if (sa.areas?.length > 0) return { label: `${sa.areas.length} area${sa.areas.length > 1 ? "s" : ""}`, color: "#0EA5E9" };
    return null;
  };

  const allAreasForService = (serviceId) => {
    const hints = SERVICE_AREA_HINTS[serviceId] || [];
    const showing = showAllAreas[serviceId];
    return showing ? KZN_AREAS : hints;
  };

  const submit = async () => {
    const existing = await store.get("providers");
    const providers = existing ? JSON.parse(existing.value) : [];
    providers.push({ ...form, id: Date.now().toString(), status: "pending", joinDate: new Date().toISOString(), referrals: 0, revenue: 0 });
    await store.set("providers", providers);
    setSubmitted(true);
  };

  if (submitted) return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 24px", background: "#060A14", textAlign: "center" }}>
      <Logo size={64} />
      <div style={{ marginTop: 24, marginBottom: 8 }}><Icon name="check" size={40} color="#10B981" strokeWidth={1.4} /></div>
      <h2 style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 24, color: "#F1F5F9", marginBottom: 8 }}>Application Submitted!</h2>
      <p style={{ color: "#64748B", fontSize: 14, maxWidth: 300, lineHeight: "1.6", marginBottom: 28 }}>
        Your business registration is under review. We'll contact you at <span style={{ color: "#0EA5E9" }}>{form.email}</span> within 24 hours.
      </p>
      <Btn onClick={onDone}>Back to Home</Btn>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", padding: "40px 24px 60px", background: "#060A14", maxWidth: 480, margin: "0 auto" }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: "#64748B", fontSize: 13, cursor: "pointer", marginBottom: 24, fontFamily: "'DM Sans',sans-serif" }}>← Back</button>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <Logo size={32} />
        <Wordmark size={18} />
      </div>
      <p style={{ color: "#64748B", fontSize: 13, marginBottom: 24 }}>Join the FixIt Now network and get qualified leads sent directly to you.</p>

      <div style={{ display: "flex", gap: 6, marginBottom: 28 }}>
        {[1,2,3].map(s => (
          <div key={s} style={{ flex: 1, height: 4, borderRadius: 4, background: s <= step ? "linear-gradient(90deg,#0EA5E9,#6366F1)" : "rgba(255,255,255,0.07)", transition: "all 0.3s" }} />
        ))}
      </div>
      <div style={{ color: "#475569", fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 20 }}>
        Step {step} of 3 — {["Business Details","Services & Coverage","Choose Your Plan"][step-1]}
      </div>

      {step === 1 && (
        <>
          <Input label="Business Name" value={form.bizName} onChange={v => set("bizName", v)} placeholder="Joe's Plumbing Services" />
          <Input label="Contact Person" value={form.contactName} onChange={v => set("contactName", v)} placeholder="Joe Dlamini" />
          <Input label="Business Email" value={form.email} onChange={v => set("email", v)} placeholder="joe@bizname.co.za" type="email" />
          <Input label="WhatsApp / Phone" value={form.phone} onChange={v => set("phone", v)} placeholder="+27 82 000 0000" />
          <Input label="Password" value={form.password} onChange={v => set("password", v)} placeholder="Min. 6 characters" type="password" />

          {/* Tagline */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 6, fontFamily: "'DM Sans',sans-serif" }}>Tagline <span style={{ color: "#334155", fontWeight: 400 }}>(optional)</span></label>
            <input value={form.tagline} onChange={e => set("tagline", e.target.value)} placeholder="e.g. Durban's most trusted plumber since 2008"
              style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1.5px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "11px 13px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
          </div>

          {/* About */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 6, fontFamily: "'DM Sans',sans-serif" }}>About your business</label>
            <textarea value={form.description} onChange={e => set("description", e.target.value)}
              placeholder="Tell customers what makes you different. What do you specialise in? Why should they choose you over anyone else?"
              rows={4}
              style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1.5px solid rgba(255,255,255,0.08)", borderRadius: 11, padding: "12px 14px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none", resize: "vertical" }} />
          </div>

          {/* Trust & credentials */}
          <div style={{ background: "rgba(14,165,233,0.05)", border: "1px solid rgba(14,165,233,0.15)", borderRadius: 12, padding: 14, marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#38BDF8", marginBottom: 12, fontFamily: "'Syne',sans-serif" }}>Credentials & trust signals</div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.07em", textTransform: "uppercase", display: "block", marginBottom: 5, fontFamily: "'DM Sans',sans-serif" }}>Years in business</label>
                <input type="number" value={form.yearsInBusiness} onChange={e => set("yearsInBusiness", e.target.value)} placeholder="e.g. 12"
                  style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1.5px solid rgba(255,255,255,0.08)", borderRadius: 9, padding: "9px 11px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.07em", textTransform: "uppercase", display: "block", marginBottom: 5, fontFamily: "'DM Sans',sans-serif" }}>Call-out fee from (R)</label>
                <input type="number" value={form.priceRangeMin} onChange={e => set("priceRangeMin", e.target.value)} placeholder="e.g. 350"
                  style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1.5px solid rgba(255,255,255,0.08)", borderRadius: 9, padding: "9px 11px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
              </div>
            </div>

            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.07em", textTransform: "uppercase", display: "block", marginBottom: 5, fontFamily: "'DM Sans',sans-serif" }}>Certifications & licences</label>
              <input value={form.certifications} onChange={e => set("certifications", e.target.value)}
                placeholder="e.g. Licensed electrician, ECSA registered, COC certified"
                style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1.5px solid rgba(255,255,255,0.08)", borderRadius: 9, padding: "9px 11px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
            </div>

            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.07em", textTransform: "uppercase", display: "block", marginBottom: 5, fontFamily: "'DM Sans',sans-serif" }}>Logo URL <span style={{ color: "#334155", fontWeight: 400, textTransform: "none" }}>(paste a link to your logo image)</span></label>
              <input value={form.logoUrl} onChange={e => set("logoUrl", e.target.value)}
                placeholder="https://imgur.com/your-logo.png"
                style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1.5px solid rgba(255,255,255,0.08)", borderRadius: 9, padding: "9px 11px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
              <div style={{ fontSize: 10, color: "#334155", marginTop: 3 }}>Free upload: imgur.com · Free image host for business logos</div>
            </div>

            {/* Trust checkboxes */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                ["insuranceConfirmed", "I have public liability insurance"],
                ["backgroundCheckConsent", "I consent to identity verification"],
              ].map(([key, label]) => (
                <div key={key} onClick={() => set(key, !form[key])}
                  style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <div style={{ width: 18, height: 18, borderRadius: 5, border: `2px solid ${form[key] ? "#10B981" : "rgba(255,255,255,0.2)"}`, background: form[key] ? "#10B981" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all 0.15s" }}>
                    {form[key] && <Icon name="check" size={10} color="white" strokeWidth={2.5} />}
                  </div>
                  <span style={{ fontSize: 12, color: "#94A3B8", fontFamily: "'DM Sans',sans-serif" }}>{label}</span>
                </div>
              ))}
            </div>
          </div>

          <Input label="Business Registration No." value={form.regNum} onChange={v => set("regNum", v)} placeholder="Optional" />

          <Btn full onClick={() => {
            if (!form.bizName || !form.email || !form.phone) return alert("Please fill in all required fields.");
            if (!form.password || form.password.length < 6) return alert("Please set a password of at least 6 characters.");
            setStep(2);
          }}>Continue →</Btn>
        </>
      )}

      {step === 2 && (
        <>
          <p style={{ color: "#94A3B8", fontSize: 13, marginBottom: 16 }}>
            Select your services, then pick the areas you cover. Choose <span style={{ color: "#10B981", fontWeight: 600 }}>All KZN</span> if you service the whole province.
          </p>

          {SERVICES.map(s => {
            const selected = form.services.includes(s.id);
            const expanded = expandedService === s.id;
            const summary = getAreaSummary(s.id);
            const hints = SERVICE_AREA_HINTS[s.id] || [];
            const showingAll = showAllAreas[s.id];
            const displayAreas = showingAll ? KZN_AREAS : hints;
            const currentAreas = form.serviceAreas[s.id]?.areas || [];
            const isAllKZN = form.serviceAreas[s.id]?.allKZN;
            const needsAreas = selected && !summary;

            return (
              <div key={s.id} style={{
                background: selected ? `${s.color}08` : "rgba(255,255,255,0.02)",
                border: `1.5px solid ${selected ? (needsAreas ? "#F59E0B55" : s.color+"33") : "rgba(255,255,255,0.07)"}`,
                borderRadius: 13, marginBottom: 8, overflow: "hidden",
                transition: "all 0.2s",
              }}>
                {/* Service row header */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", cursor: "pointer" }}
                  onClick={() => {
                    if (!selected) { toggleService(s.id); }
                    else { setExpandedService(expanded ? null : s.id); }
                  }}>
                  <div style={{ width: 36, height: 36, borderRadius: 9, background: selected ? `${s.color}20` : "rgba(255,255,255,0.05)", border: `1.5px solid ${selected ? s.color+"44" : "rgba(255,255,255,0.08)"}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <ServiceIcon serviceId={s.id} size={18} color={selected ? s.color : "#475569"} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: selected ? "#F1F5F9" : "#64748B", fontFamily: "'Syne',sans-serif" }}>{s.label}</div>
                    {selected && summary ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 20, padding: "2px 8px", background: `${summary.color}20`, border: `1px solid ${summary.color}40`, color: summary.color }}>
                          {summary.label}
                        </span>
                        {!isAllKZN && currentAreas.slice(0, 3).map(a => (
                          <span key={a} style={{ fontSize: 10, fontWeight: 600, borderRadius: 20, padding: "2px 8px", background: "rgba(14,165,233,0.12)", border: "1px solid rgba(14,165,233,0.25)", color: "#38BDF8" }}>{a}</span>
                        ))}
                        {!isAllKZN && currentAreas.length > 3 && (
                          <span style={{ fontSize: 10, color: "#475569" }}>+{currentAreas.length - 3} more</span>
                        )}
                      </div>
                    ) : selected ? (
                      <div style={{ fontSize: 11, color: "#F59E0B", marginTop: 2 }}>⚠ Select areas below</div>
                    ) : (
                      <div style={{ fontSize: 11, color: "#334155" }}>{s.desc}</div>
                    )}
                  </div>
                  {/* Toggle button */}
                  {selected ? (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <div style={{ fontSize: 11, color: s.color, cursor: "pointer" }}>{expanded ? "▲" : "▼"}</div>
                      <div onClick={e => { e.stopPropagation(); toggleService(s.id); }}
                        style={{ fontSize: 10, color: "#475569", cursor: "pointer", padding: "2px 6px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.04)" }}>remove</div>
                    </div>
                  ) : (
                    <div style={{ width: 22, height: 22, borderRadius: "50%", border: "1.5px solid rgba(255,255,255,0.15)", display: "flex", alignItems: "center", justifyContent: "center", color: "#475569", fontSize: 16, flexShrink: 0 }}>+</div>
                  )}
                </div>

                {/* Expanded area picker */}
                {selected && expanded && (
                  <div style={{ padding: "0 14px 14px", borderTop: `1px solid ${s.color}22` }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", margin: "12px 0 8px" }}>Service areas</div>

                    {/* All KZN pill */}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                      <div onClick={() => toggleAllKZN(s.id)} style={{
                        fontSize: 11, fontWeight: 700, borderRadius: 20, padding: "5px 12px", cursor: "pointer", transition: "all 0.15s",
                        background: isAllKZN ? "rgba(16,185,129,0.25)" : "rgba(16,185,129,0.08)",
                        border: `1.5px solid ${isAllKZN ? "#10B98188" : "rgba(16,185,129,0.25)"}`,
                        color: isAllKZN ? "#34D399" : "#10B981",
                      }}>
                        {isAllKZN ? "✓ " : ""}All KZN
                      </div>
                    </div>

                    {/* Individual area pills */}
                    {!isAllKZN && (
                      <>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                          {displayAreas.map(area => {
                            const sel = currentAreas.includes(area);
                            return (
                              <div key={area} onClick={() => toggleArea(s.id, area)} style={{
                                fontSize: 11, fontWeight: 600, borderRadius: 20, padding: "4px 10px", cursor: "pointer", transition: "all 0.15s",
                                background: sel ? `${s.color}22` : "rgba(255,255,255,0.04)",
                                border: `1px solid ${sel ? s.color+"55" : "rgba(255,255,255,0.1)"}`,
                                color: sel ? s.color : "#64748B",
                              }}>
                                {sel ? "✓ " : ""}{area}
                              </div>
                            );
                          })}
                        </div>
                        <button onClick={() => setShowAllAreas(p => ({ ...p, [s.id]: !showingAll }))}
                          style={{ background: "none", border: "none", color: "#0EA5E9", fontSize: 11, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "'DM Sans',sans-serif" }}>
                          {showingAll ? "▲ Show less" : `▼ Show all ${KZN_AREAS.length} areas`}
                        </button>
                      </>
                    )}

                    {isAllKZN && (
                      <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>
                        You'll appear in searches for all KwaZulu-Natal areas.
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Emergency toggle */}
          <div style={{ background: "rgba(239,68,68,0.07)", border: "1px solid rgba(239,68,68,0.18)", borderRadius: 12, padding: 14, marginBottom: 20, marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#FCA5A5" }}>Available 24/7 for emergencies?</div>
              <div style={{ fontSize: 11, color: "#7F1D1D", marginTop: 2 }}>Increases your ranking significantly</div>
            </div>
            <div onClick={() => set("emergency", !form.emergency)} style={{ width: 44, height: 24, borderRadius: 12, background: form.emergency ? "#EF4444" : "rgba(255,255,255,0.1)", position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0 }}>
              <div style={{ position: "absolute", top: 3, left: form.emergency ? 23 : 3, width: 18, height: 18, borderRadius: "50%", background: "white", transition: "left 0.2s" }} />
            </div>
          </div>

          {/* Validation hint */}
          {form.services.length > 0 && form.services.some(id => !getAreaSummary(id)) && (
            <div style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 9, padding: "10px 14px", marginBottom: 12, color: "#FCD34D", fontSize: 12 }}>
              ⚠ Please select service areas for each of your services before continuing.
            </div>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <Btn variant="ghost" onClick={() => setStep(1)}>← Back</Btn>
            <Btn full onClick={() => setStep(3)} disabled={form.services.length === 0 || form.services.some(id => !getAreaSummary(id))}>Continue →</Btn>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <p style={{ color: "#94A3B8", fontSize: 13, marginBottom: 18 }}>Choose a plan that fits your business. All plans include a 14-day free trial.</p>
          {PLANS.map(p => (
            <div key={p.id} onClick={() => set("plan", p.id)}
              style={{ background: form.plan === p.id ? `${p.color}12` : "rgba(255,255,255,0.03)", border: `1.5px solid ${form.plan === p.id ? p.color+"55" : "rgba(255,255,255,0.07)"}`, borderRadius: 14, padding: 16, marginBottom: 10, cursor: "pointer", transition: "all 0.2s", position: "relative" }}>
              {p.id === "featured" && <span style={{ position: "absolute", top: -1, right: 14, background: p.color, color: "white", fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: "0 0 6px 6px", letterSpacing: "0.08em" }}>POPULAR</span>}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 16, color: form.plan === p.id ? "#F1F5F9" : "#94A3B8" }}>{p.label}</div>
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 18, color: p.color }}>{p.priceLabel}</div>
              </div>
              {p.features.map((f, i) => (
                <div key={i} style={{ display: "flex", gap: 7, fontSize: 12, color: "#64748B", marginBottom: 4 }}>
                  <span style={{ color: p.color }}>✓</span>{f}
                </div>
              ))}
            </div>
          ))}
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <Btn variant="ghost" onClick={() => setStep(2)}>← Back</Btn>
            <Btn full variant="green" onClick={submit}>Submit Application ✓</Btn>
          </div>
        </>
      )}
    </div>
  );
}

// ─── REVIEW MODAL ────────────────────────────────────────────────────────────────
// Accepts either:
//   job  – a booking job object (has job.id, job.providerId, job.providerName, job.serviceName)
//   provider + serviceType – a provider card object (direct rating, no booking required)
function ReviewModal({ job, provider: providerProp, serviceType: serviceTypeProp, user, onClose, onDone }) {
  const [rating, setRating]   = useState(0);
  const [hover, setHover]     = useState(0);
  const [comment, setComment] = useState("");
  const [saving, setSaving]   = useState(false);
  const [done, setDone]       = useState(false);

  // Normalise source — works whether triggered from My Jobs or a provider card
  const providerId   = job?.providerId   ?? providerProp?.providerId ?? null;
  const providerName = job?.providerName ?? providerProp?.name       ?? "Provider";
  const serviceType  = job?.serviceType  ?? serviceTypeProp          ?? null;
  const serviceName  = job?.serviceName  ?? SERVICES.find(s => s.id === serviceType)?.label ?? "Service";
  const jobId        = job?.id           ?? `direct-${Date.now()}`;
  const svc          = SERVICES.find(s => s.id === serviceType);

  const labelMap = { 1: "Poor", 2: "Below average", 3: "Average", 4: "Good", 5: "Excellent!" };

  const submit = async () => {
    if (!rating) return;
    setSaving(true);
    await saveReview({ jobId, providerId, providerName, customerId: user.email, customerName: user.name, rating, comment, serviceType });
    if (providerId) {
      await pushNotif(providerId, {
        title: "New review received ⭐",
        body:  `${user.name} left a ${rating}★ review for your ${serviceName} service.`,
        type:  "review", jobId,
      });
    }
    setSaving(false);
    setDone(true);
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#0D1526", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 500, padding: "24px 20px 44px" }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", margin: "0 auto 20px" }} />

        {done ? (
          <div style={{ textAlign: "center", padding: "16px 0 8px" }}>
            <div style={{ marginBottom: 12 }}><Icon name="star" size={44} color="#F59E0B" strokeWidth={1.4} /></div>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 18, color: "#F1F5F9", marginBottom: 8 }}>Review submitted!</div>
            <div style={{ fontSize: 12, color: "#64748B", lineHeight: 1.7, marginBottom: 24 }}>
              Thanks for rating {providerName}. Your review helps other customers find great pros.
            </div>
            <Btn full onClick={() => { onDone && onDone(); onClose(); }}>Done</Btn>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 20 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: `${svc?.color || "#0EA5E9"}18`, border: `1.5px solid ${svc?.color || "#0EA5E9"}33`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <ServiceIcon serviceId={serviceType || "handyman"} size={20} color={svc?.color || "#0EA5E9"} />
              </div>
              <div>
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 15, color: "#F1F5F9" }}>Rate your experience</div>
                <div style={{ fontSize: 12, color: "#475569" }}>{providerName} · {serviceName}</div>
              </div>
            </div>

            {/* Star picker */}
            <div style={{ display: "flex", justifyContent: "center", gap: 12, marginBottom: 12 }}>
              {[1,2,3,4,5].map(i => (
                <div key={i}
                  onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(0)}
                  onClick={() => setRating(i)}
                  style={{ fontSize: 40, cursor: "pointer", color: i <= (hover || rating) ? "#F59E0B" : "#1E293B", transition: "color 0.1s, transform 0.15s", transform: i <= (hover || rating) ? "scale(1.25)" : "scale(1)", userSelect: "none" }}>★</div>
              ))}
            </div>
            {rating > 0 && (
              <div style={{ textAlign: "center", fontSize: 13, fontWeight: 600, color: "#F59E0B", marginBottom: 16 }}>
                {labelMap[rating]}
              </div>
            )}

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Comments (optional)</label>
              <textarea value={comment} onChange={e => setComment(e.target.value)}
                placeholder="Quality of work, punctuality, professionalism…" rows={3}
                style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1.5px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "11px 13px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none", resize: "none" }} />
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
              <Btn full variant="green" onClick={submit} disabled={!rating || saving}>{saving ? "Saving…" : "Submit Review ★"}</Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── NOTIFICATION BELL ────────────────────────────────────────────────────────────
function NotificationBell({ userId, onOpen }) {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const check = async () => {
      const notifs = await getNotifs(userId);
      setUnread(notifs.filter(n => !n.read).length);
    };
    check();
    const interval = setInterval(check, 15000);
    return () => clearInterval(interval);
  }, [userId]);

  return (
    <div onClick={onOpen} style={{ position: "relative", width: 34, height: 34, borderRadius: "50%", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
      <Icon name="bell" size={16} color="currentColor" strokeWidth={1.8} />
      {unread > 0 && (
        <div style={{ position: "absolute", top: -2, right: -2, width: 16, height: 16, borderRadius: "50%", background: "#EF4444", fontSize: 9, fontWeight: 800, color: "white", display: "flex", alignItems: "center", justifyContent: "center", border: "2px solid #060A14" }}>{unread > 9 ? "9+" : unread}</div>
      )}
    </div>
  );
}

// ─── NOTIFICATIONS PANEL ─────────────────────────────────────────────────────────
function NotificationsPanel({ userId, onClose }) {
  const [notifs, setNotifs] = useState([]);

  useEffect(() => {
    getNotifs(userId).then(setNotifs);
    markNotifsRead(userId);
  }, [userId]);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100, display: "flex", alignItems: "flex-start", justifyContent: "flex-end", paddingTop: 56 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#0D1526", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, width: "calc(100% - 32px)", maxWidth: 340, margin: "0 16px", maxHeight: "70vh", overflowY: "auto", padding: "16px 0" }}>
        <div style={{ padding: "0 16px 12px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 14, color: "#F1F5F9" }}>Notifications</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#475569", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        {notifs.length === 0 ? (
          <div style={{ textAlign: "center", padding: "32px 16px", color: "#334155", fontSize: 13 }}>No notifications yet</div>
        ) : notifs.map(n => (
          <div key={n.id} style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.05)", background: n.read ? "transparent" : "rgba(14,165,233,0.05)" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <NotifIcon type={n.type} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#E2E8F0", lineHeight: 1.3 }}>{n.title}</div>
                <div style={{ fontSize: 11, color: "#64748B", marginTop: 3, lineHeight: 1.5 }}>{n.body}</div>
                <div style={{ fontSize: 10, color: "#334155", marginTop: 4 }}>{new Date(n.ts).toLocaleDateString("en-ZA", { day: "numeric", month: "short" })} · {new Date(n.ts).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── SALES MOMENT MODAL ──────────────────────────────────────────────────────────
// Provider sees this when tapping "Mark Complete" — they can set a discount offer
// and personalise a thank-you note before completing the job.
function SalesMomentModal({ job, provider, onCancel, onConfirm }) {
  const [discountPct, setDiscountPct] = useState(provider.defaultDiscount || 10);
  const [customNote, setCustomNote]   = useState("");
  const [offerDiscount, setOfferDiscount] = useState(true);
  const svc = SERVICES.find(s => s.id === job.serviceType);

  const confirm = () => onConfirm({ discountPct: offerDiscount ? discountPct : 0, customNote, offerDiscount });

  const sliderStyle = { width: "100%", accentColor: "#0EA5E9" };

  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#0D1526", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 500, padding: "24px 20px 44px", maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", margin: "0 auto 20px" }} />

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: "#10B98118", border: "1.5px solid #10B98133", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="check" size={20} color="#10B981" strokeWidth={2} />
          </div>
          <div>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 15, color: "#F1F5F9" }}>Complete job & make a sale</div>
            <div style={{ fontSize: 12, color: "#475569" }}>{job.customerName} · {svc?.label}</div>
          </div>
        </div>

        {/* What happens */}
        <div style={{ background: "rgba(14,165,233,0.07)", border: "1px solid rgba(14,165,233,0.18)", borderRadius: 11, padding: "12px 14px", marginBottom: 18, fontSize: 11, color: "#7DD3FC", lineHeight: 1.7 }}>
          When you complete this job, {job.customerName} will get an in-app popup asking them to rate you, plus your discount offer — encouraging them to rebook and refer friends.
        </div>

        {/* Thank-you note */}
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Personal thank-you note (optional)</label>
          <textarea value={customNote} onChange={e => setCustomNote(e.target.value)}
            placeholder={`Hi ${job.customerName}, thanks for choosing ${provider.bizName}! It was a pleasure working on your home.`}
            rows={3}
            style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1.5px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "11px 13px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none", resize: "none" }} />
        </div>

        {/* Discount offer toggle */}
        <div style={{ background: "rgba(245,158,11,0.07)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 13, padding: 16, marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: offerDiscount ? 14 : 0 }}>
            <div>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 14, color: "#FCD34D" }}>Offer a loyalty discount</div>
              <div style={{ fontSize: 11, color: "#78350F", marginTop: 2 }}>Customer gets % off their next booking with you</div>
            </div>
            <div onClick={() => setOfferDiscount(v => !v)} style={{ width: 42, height: 23, borderRadius: 12, background: offerDiscount ? "#F59E0B" : "rgba(255,255,255,0.1)", position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0 }}>
              <div style={{ position: "absolute", top: 3, left: offerDiscount ? 22 : 3, width: 17, height: 17, borderRadius: "50%", background: "white", transition: "left 0.2s" }} />
            </div>
          </div>

          {offerDiscount && (
            <>
              {/* Discount slider */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                <input type="range" min={5} max={50} step={5} value={discountPct} onChange={e => setDiscountPct(Number(e.target.value))} style={sliderStyle} />
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 24, color: "#F59E0B", minWidth: 52, textAlign: "right" }}>{discountPct}%</div>
              </div>

              {/* Preset chips */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[5, 10, 15, 20, 25].map(v => (
                  <div key={v} onClick={() => setDiscountPct(v)} style={{ fontSize: 11, fontWeight: 700, borderRadius: 20, padding: "4px 10px", cursor: "pointer", transition: "all 0.15s", background: discountPct === v ? "rgba(245,158,11,0.3)" : "rgba(255,255,255,0.06)", border: `1.5px solid ${discountPct === v ? "#F59E0B88" : "rgba(255,255,255,0.1)"}`, color: discountPct === v ? "#F59E0B" : "#64748B" }}>
                    {v}%
                  </div>
                ))}
              </div>

              {/* Preview of what customer sees */}
              <div style={{ marginTop: 14, background: "rgba(0,0,0,0.2)", borderRadius: 9, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#475569", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Customer will see</div>
                <div style={{ fontSize: 12, color: "#FCD34D", fontWeight: 600 }}>{discountPct}% off your next {svc?.label?.toLowerCase()} booking with {provider.bizName}</div>
                <div style={{ fontSize: 11, color: "#78350F", marginTop: 3 }}>Valid for 90 days · Share with a friend for the same deal</div>
              </div>
            </>
          )}
        </div>

        {/* Set as default */}
        <div style={{ fontSize: 11, color: "#334155", marginBottom: 18, textAlign: "center", cursor: "pointer" }}
          onClick={async () => {
            const raw = await store.get("providers");
            const providers = raw ? JSON.parse(raw.value) : [];
            await store.set("providers", providers.map(p => p.id === provider.id ? { ...p, defaultDiscount: discountPct } : p));
          }}>
          Save {discountPct}% as my default discount rate
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
          <Btn full variant="green" onClick={confirm}>Complete Job & Send Offer</Btn>
        </div>
      </div>
    </div>
  );
}

// ─── COMPLETION POPUP ─────────────────────────────────────────────────────────────
// Customer sees this after provider marks job complete — rating prompt + discount card
function CompletionPopup({ notification, user, onClose }) {
  const [step, setStep]     = useState("offer");  // offer | rate | done
  const [rating, setRating] = useState(0);
  const [hover, setHover]   = useState(0);
  const [comment, setComment] = useState("");
  const [saving, setSaving]   = useState(false);
  const [discount, setDiscount] = useState(null);

  useEffect(() => {
    // Load the discount that was just stored for this customer
    getDiscounts(user.email).then(ds => {
      const d = ds.find(d => d.jobId === notification.jobId && !d.redeemed);
      if (d) setDiscount(d);
    });
  }, []);

  const referralMsg = discount
    ? `Hi! I just used ${discount.bizName} for home services and they were great. Use my link and get ${discount.discountPct}% off your first booking! Book via FixIt Now and mention ${user.name}.`
    : "";

  const submitRating = async () => {
    if (!rating) return;
    setSaving(true);
    await saveReview({
      jobId: notification.jobId, providerId: notification.providerId,
      providerName: notification.providerName, customerId: user.email,
      customerName: user.name, rating, comment, serviceType: notification.serviceType,
    });
    if (notification.providerId) {
      await pushNotif(notification.providerId, {
        title: "New review received",
        body: `${user.name} left a ${rating} star review.`,
        type: "review", jobId: notification.jobId,
      });
    }
    setSaving(false);
    setStep("done");
  };

  const inputStyle = { width: "100%", background: "rgba(255,255,255,0.05)", border: "1.5px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "11px 13px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none", resize: "none" };
  const labelMap   = { 1: "Poor", 2: "Below average", 3: "Average", 4: "Good", 5: "Excellent!" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div style={{ background: "#0D1526", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 500, padding: "24px 20px 48px", maxHeight: "92vh", overflowY: "auto" }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", margin: "0 auto 20px" }} />

        {step === "offer" && (
          <>
            {/* Job complete celebration */}
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ marginBottom: 12 }}>
                <Icon name="check" size={48} color="#10B981" strokeWidth={1.4} />
              </div>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 20, color: "#F1F5F9", marginBottom: 6 }}>Job complete!</div>
              <div style={{ fontSize: 13, color: "#64748B", lineHeight: 1.6 }}>
                {notification.customNote || `${notification.providerName} has completed your ${notification.serviceName} job. We hope everything looks great!`}
              </div>
            </div>

            {/* Discount card — only if provider offered one */}
            {discount && (
              <div style={{ background: "linear-gradient(135deg, #0EA5E905, #F59E0B08)", border: "1.5px solid rgba(245,158,11,0.35)", borderRadius: 14, padding: 18, marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 9, background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Icon name="star" size={18} color="#F59E0B" strokeWidth={1.8} />
                  </div>
                  <div>
                    <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 22, color: "#F59E0B" }}>{discount.discountPct}% off</div>
                    <div style={{ fontSize: 11, color: "#78350F" }}>your next booking with {discount.bizName}</div>
                  </div>
                  <div style={{ marginLeft: "auto", fontFamily: "'Syne',sans-serif", fontSize: 10, fontWeight: 700, color: "#475569", textAlign: "right" }}>
                    Valid<br />90 days
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "#64748B", lineHeight: 1.6, marginBottom: 12 }}>
                  Book {discount.bizName} again via FixIt Now and this discount applies automatically at checkout.
                </div>
                {/* Referral section */}
                <div style={{ background: "rgba(14,165,233,0.08)", border: "1px solid rgba(14,165,233,0.2)", borderRadius: 10, padding: "12px 13px" }}>
                  <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 13, color: "#38BDF8", marginBottom: 6 }}>Share with a friend — they get it too</div>
                  <div style={{ fontSize: 11, color: "#475569", lineHeight: 1.6, marginBottom: 10 }}>
                    If a friend books {discount.bizName} through your referral, they also get {discount.discountPct}% off their first job.
                  </div>
                  <button
                    onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(referralMsg)}`)}
                    style={{ width: "100%", background: "linear-gradient(135deg,#25D366,#128C7E)", color: "white", border: "none", borderRadius: 9, padding: "10px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'Syne',sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                    <Icon name="whatsapp" size={14} color="white" strokeWidth={1.8} />
                    Share via WhatsApp
                  </button>
                </div>
              </div>
            )}

            <Btn full onClick={() => setStep("rate")} style={{ marginBottom: 10 }}>Rate your experience →</Btn>
            <Btn full variant="ghost" onClick={onClose}>Close</Btn>
          </>
        )}

        {step === "rate" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: "rgba(245,158,11,0.12)", border: "1.5px solid rgba(245,158,11,0.25)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Icon name="star" size={20} color="#F59E0B" strokeWidth={1.8} />
              </div>
              <div>
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 15, color: "#F1F5F9" }}>Rate {notification.providerName}</div>
                <div style={{ fontSize: 12, color: "#475569" }}>{notification.serviceName} · Your review helps others</div>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "center", gap: 12, marginBottom: 12 }}>
              {[1,2,3,4,5].map(i => (
                <div key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(0)} onClick={() => setRating(i)}
                  style={{ cursor: "pointer", transition: "transform 0.15s", transform: i <= (hover || rating) ? "scale(1.25)" : "scale(1)", userSelect: "none" }}>
                  <svg width="36" height="36" viewBox="0 0 12 12" fill="none">
                    <path d="M6 1L7.3 4.3L11 4.8L8.5 7.2L9.1 11L6 9.3L2.9 11L3.5 7.2L1 4.8L4.7 4.3Z"
                      fill={i <= (hover || rating) ? "#F59E0B" : "none"}
                      stroke={i <= (hover || rating) ? "#F59E0B" : "#374151"}
                      strokeWidth="0.8" strokeLinejoin="round" />
                  </svg>
                </div>
              ))}
            </div>
            {rating > 0 && <div style={{ textAlign: "center", fontSize: 13, fontWeight: 600, color: "#F59E0B", marginBottom: 14 }}>{labelMap[rating]}</div>}

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Comments (optional)</label>
              <textarea value={comment} onChange={e => setComment(e.target.value)} placeholder="Quality of work, punctuality, professionalism…" rows={3} style={inputStyle} />
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <Btn variant="ghost" onClick={() => setStep("offer")}>← Back</Btn>
              <Btn full variant="green" onClick={submitRating} disabled={!rating || saving}>{saving ? "Saving…" : "Submit Review"}</Btn>
            </div>
          </>
        )}

        {step === "done" && (
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <div style={{ marginBottom: 16 }}><Icon name="check" size={48} color="#10B981" strokeWidth={1.4} /></div>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 18, color: "#F1F5F9", marginBottom: 8 }}>All done!</div>
            <div style={{ fontSize: 12, color: "#64748B", lineHeight: 1.7, marginBottom: 24 }}>
              Review submitted.{discount ? ` Your ${discount.discountPct}% discount is saved in your wallet for next time.` : ""}
            </div>
            <Btn full onClick={onClose}>Close</Btn>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DISCOUNT WALLET ─────────────────────────────────────────────────────────────
// ─── CREDIT WALLET ───────────────────────────────────────────────────────────────
function CreditWallet({ user }) {
  const [credits, setCredits] = useState([]);
  const [open, setOpen]       = useState(false);
  const refCode  = user.refCode || makeRefCode(user.email);
  const appUrl   = window.location.origin;
  const refLink  = `${appUrl}?ref=${refCode}`;
  const total    = getTotalCredit(credits);

  useEffect(() => { getCredits(user.email).then(setCredits); }, []);

  const shareMsg = `Hi! I use FixIt Now to find trusted home service pros in KZN — plumbers, electricians, handymen and more. Sign up with my link and get ${REFERRAL_FRIEND_DISCOUNT}% off your first booking! 🏠 ${refLink}`;

  return (
    <div style={{ marginBottom: 12 }}>
      {/* Header card */}
      <div style={{ background: "linear-gradient(135deg, rgba(99,102,241,0.15), rgba(14,165,233,0.1))", border: "1px solid rgba(99,102,241,0.25)", borderRadius: 16, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 13, color: "#A5B4FC" }}>Referral Credits</div>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 28, color: "#F1F5F9", marginTop: 2 }}>
              R{total}<span style={{ fontSize: 13, color: "#64748B", fontWeight: 600 }}> available</span>
            </div>
          </div>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: "rgba(99,102,241,0.2)", border: "1.5px solid rgba(99,102,241,0.3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="send" size={22} color="#A5B4FC" strokeWidth={1.8} />
          </div>
        </div>

        {/* How it works */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
          {[
            { icon: "send",    color: "#A5B4FC", text: `Share your link — friend signs up` },
            { icon: "booking", color: "#34D399", text: `Friend completes their first booking` },
            { icon: "chart",   color: "#F59E0B", text: `You earn R${REFERRAL_CREDIT_AMOUNT} · Friend gets ${REFERRAL_FRIEND_DISCOUNT}% off` },
          ].map(({ icon, color, text }) => (
            <div key={text} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: `${color}18`, border: `1px solid ${color}30`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon name={icon} size={13} color={color} strokeWidth={2} />
              </div>
              <span style={{ fontSize: 12, color: "#94A3B8" }}>{text}</span>
            </div>
          ))}
        </div>

        {/* Your ref code */}
        <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: 10, padding: "10px 12px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 10, color: "#475569", marginBottom: 2 }}>Your referral code</div>
            <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 20, color: "#A5B4FC", letterSpacing: "0.15em" }}>{refCode}</div>
          </div>
          <button onClick={() => { navigator.clipboard?.writeText(refLink); }}
            style={{ background: "rgba(99,102,241,0.2)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 8, padding: "7px 12px", fontSize: 11, fontWeight: 600, color: "#A5B4FC", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
            Copy link
          </button>
        </div>

        {/* Share button */}
        <button onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(shareMsg)}`)}
          style={{ width: "100%", background: "linear-gradient(135deg,#25D366,#128C7E)", border: "none", borderRadius: 11, padding: "12px", fontSize: 13, fontWeight: 700, color: "white", cursor: "pointer", fontFamily: "'Syne',sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <Icon name="whatsapp" size={16} color="white" strokeWidth={1.8} />
          Share via WhatsApp
        </button>
      </div>

      {/* Credit history */}
      {credits.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button onClick={() => setOpen(v => !v)}
            style={{ background: "none", border: "none", color: "#475569", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", display: "flex", alignItems: "center", gap: 4, padding: "4px 0" }}>
            {open ? "Hide" : "Show"} credit history ({credits.length})
          </button>
          {open && credits.map(c => (
            <div key={c.id} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "10px 14px", marginBottom: 6, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 12, color: "#E2E8F0", fontWeight: 600 }}>{c.fromName} joined via your link</div>
                <div style={{ fontSize: 10, color: "#334155", marginTop: 2 }}>{c.dateLabel}</div>
              </div>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 16, color: c.redeemed ? "#475569" : "#34D399" }}>
                {c.redeemed ? "Used" : `+R${c.amount}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── DISCOUNT WALLET ──────────────────────────────────────────────────────────────
function DiscountWallet({ customerId }) {
  const [discounts, setDiscounts] = useState([]);

  useEffect(() => {
    getDiscounts(customerId).then(ds => setDiscounts(ds.filter(d => !d.redeemed)));
  }, [customerId]);

  if (!discounts.length) return null;

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#F59E0B", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
        <Icon name="star" size={12} color="#F59E0B" strokeWidth={2} />
        Your discounts ({discounts.length})
      </div>
      {discounts.map(d => {
        const daysLeft = Math.max(0, Math.round((new Date(d.ts).getTime() + 90 * 86400000 - Date.now()) / 86400000));
        return (
          <div key={d.id} style={{ background: "linear-gradient(135deg, rgba(14,165,233,0.06), rgba(245,158,11,0.06))", border: "1.5px solid rgba(245,158,11,0.3)", borderRadius: 13, padding: "14px 16px", marginBottom: 8, display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 44, height: 44, borderRadius: 11, background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <span style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 14, color: "#F59E0B" }}>{d.discountPct}%</span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 13, color: "#F1F5F9" }}>{d.discountPct}% off with {d.bizName}</div>
              <div style={{ fontSize: 11, color: "#64748B", marginTop: 2 }}>Earned {d.dateLabel} · {daysLeft > 0 ? `${daysLeft} days left` : "Expires today"}</div>
            </div>
            <div style={{ fontSize: 10, fontWeight: 700, borderRadius: 20, padding: "3px 9px", background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)", color: "#34D399", flexShrink: 0 }}>Active</div>
          </div>
        );
      })}
      <div style={{ fontSize: 11, color: "#334155", textAlign: "center", marginTop: 6 }}>Discounts apply automatically when you rebook via FixIt Now</div>
    </div>
  );
}

// ─── CHAT MODAL ──────────────────────────────────────────────────────────────────
function ChatModal({ job, user, userRole, onClose }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState("");
  const [sending, setSending]   = useState(false);
  const bottomRef = useRef(null);

  const load = async () => {
    const msgs = await getChatMessages(job.id);
    setMessages(msgs);
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, [job.id]);

  const send = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    const name = userRole === "provider" ? (user.bizName || user.contactName) : user.name;
    await sendChatMessage(job.id, user.email || user.id, name, userRole, input.trim());
    setInput("");
    await load();
    setSending(false);
  };

  const otherName = userRole === "provider" ? job.customerName : job.providerName;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#0D1526", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 500, height: "75vh", display: "flex", flexDirection: "column" }}>
        {/* Header */}
        <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg,#0EA5E9,#6366F1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="message" size={16} color="white" strokeWidth={1.8} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 14, color: "#F1F5F9" }}>{otherName}</div>
            <div style={{ fontSize: 11, color: "#475569" }}>{job.serviceName}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#475569", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          {messages.length === 0 && (
            <div style={{ textAlign: "center", color: "#334155", fontSize: 12, marginTop: 24 }}>No messages yet. Say hi!</div>
          )}
          {messages.map(m => {
            const isMe = m.senderRole === userRole;
            return (
              <div key={m.id} style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start" }}>
                <div style={{ maxWidth: "78%", background: isMe ? "linear-gradient(135deg,#0EA5E9,#6366F1)" : "rgba(255,255,255,0.07)", borderRadius: isMe ? "14px 14px 4px 14px" : "14px 14px 14px 4px", padding: "9px 13px" }}>
                  <div style={{ fontSize: 13, color: "#F1F5F9", lineHeight: 1.5 }}>{m.message}</div>
                </div>
                <div style={{ fontSize: 9, color: "#334155", marginTop: 3 }}>{m.timeLabel}</div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div style={{ padding: "12px 16px 32px", borderTop: "1px solid rgba(255,255,255,0.07)", display: "flex", gap: 8 }}>
          <input value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && send()}
            placeholder="Type a message…"
            style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1.5px solid rgba(255,255,255,0.1)", borderRadius: 11, padding: "10px 14px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
          <button onClick={send} disabled={!input.trim() || sending}
            style={{ width: 42, height: 42, borderRadius: 11, background: "linear-gradient(135deg,#0EA5E9,#6366F1)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", opacity: !input.trim() ? 0.4 : 1 }}>
            <Icon name="send" size={16} color="white" strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── QUOTE REQUEST MODAL ─────────────────────────────────────────────────────────
function QuoteRequestModal({ user, onClose, onDone }) {
  const [step, setStep]           = useState(1);
  const [serviceId, setServiceId] = useState(null);
  const [location, setLocation]   = useState(user.suburb ? `${user.suburb}, ${user.city}` : "");
  const [description, setDescription] = useState("");
  const [urgency, setUrgency]     = useState("normal");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const svc = SERVICES.find(s => s.id === serviceId);

  const submit = async () => {
    setSubmitting(true);
    // AI match: find best 3 providers for this job
    const storedRaw = await store.get("providers");
    const allProviders = storedRaw ? JSON.parse(storedRaw.value) : [];
    const eligible = allProviders.filter(p => p.status === "approved" && p.services?.includes(serviceId));

    // Score and pick top 3
    const scored = eligible.map(p => ({ ...p, _score: rankScore(p) })).sort((a,b) => b._score - a._score).slice(0, 3);

    const request = {
      id:                `qr-${Date.now()}`,
      customerId:        user.email,
      customerName:      user.name,
      customerPhone:     user.phone,
      serviceId, location, description, urgency,
      assignedProviders: scored.map(p => p.id),
      quotes:            [],
      ts:                new Date().toISOString(),
      dateLabel:         new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "short" }),
      status:            "open",
    };

    await saveQuoteRequest(request);

    // Notify each matched provider
    for (const p of scored) {
      await pushNotif(p.id, {
        title:  "New quote request",
        body:   `${user.name} needs a ${svc?.label} in ${location}. Tap to submit your quote.`,
        type:   "booking",
        jobId:  request.id,
      });
    }

    setSubmitting(false);
    setSubmitted(true);
  };

  if (submitted) return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#0D1526", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 500, padding: "32px 20px 48px", textAlign: "center" }}>
        <div style={{ marginBottom: 16 }}><Icon name="check" size={48} color="#10B981" strokeWidth={1.4} /></div>
        <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 20, color: "#F1F5F9", marginBottom: 8 }}>Quote request sent!</div>
        <div style={{ fontSize: 13, color: "#64748B", lineHeight: 1.7, marginBottom: 24 }}>
          We've matched you with the top {svc?.label?.toLowerCase()} providers near {location}. You'll get quotes within the hour.
        </div>
        <Btn full onClick={() => { onDone && onDone(); onClose(); }}>View in My Jobs</Btn>
      </div>
    </div>
  );

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#0D1526", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 500, padding: "24px 20px 44px", maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", margin: "0 auto 20px" }} />
        <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 17, color: "#F1F5F9", marginBottom: 4 }}>Get quotes from pros</div>
        <div style={{ fontSize: 12, color: "#475569", marginBottom: 20 }}>We'll match you with the top 3 providers and they'll send you their best price.</div>

        {step === 1 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>What do you need?</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 20 }}>
              {SERVICES.map(s => (
                <div key={s.id} onClick={() => setServiceId(s.id)}
                  style={{ background: serviceId === s.id ? `${s.color}18` : "rgba(255,255,255,0.04)", border: `1.5px solid ${serviceId === s.id ? s.color+"55" : "rgba(255,255,255,0.08)"}`, borderRadius: 12, padding: "12px 10px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, transition: "all 0.15s" }}>
                  <ServiceIcon serviceId={s.id} size={22} color={serviceId === s.id ? s.color : "#475569"} />
                  <div style={{ fontSize: 11, fontWeight: 600, color: serviceId === s.id ? "#F1F5F9" : "#64748B", textAlign: "center" }}>{s.label}</div>
                </div>
              ))}
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Describe the problem</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)}
                placeholder="e.g. My geyser burst, water leaking in kitchen ceiling…"
                rows={3}
                style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1.5px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "11px 13px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none", resize: "none" }} />
            </div>

            <Input label="Your location" value={location} onChange={setLocation} placeholder="Suburb, Durban" />

            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>Urgency</div>
              <div style={{ display: "flex", gap: 8 }}>
                {[["normal","Normal","I can wait a day or two"],["urgent","Urgent","Today if possible"],["emergency","Emergency","Right now!"]].map(([id, label, sub]) => (
                  <div key={id} onClick={() => setUrgency(id)}
                    style={{ flex: 1, background: urgency === id ? "rgba(14,165,233,0.15)" : "rgba(255,255,255,0.04)", border: `1.5px solid ${urgency === id ? "#0EA5E9" : "rgba(255,255,255,0.08)"}`, borderRadius: 10, padding: "10px 8px", cursor: "pointer", textAlign: "center" }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: urgency === id ? "#38BDF8" : "#64748B" }}>{label}</div>
                    <div style={{ fontSize: 10, color: "#334155", marginTop: 2 }}>{sub}</div>
                  </div>
                ))}
              </div>
            </div>

            <Btn full onClick={submit} disabled={!serviceId || !description.trim() || !location.trim() || submitting}>
              {submitting ? "Matching providers…" : "Get Quotes from Top Pros →"}
            </Btn>
          </>
        )}
      </div>
    </div>
  );
}

// ─── ADDRESS BOOK MODAL ──────────────────────────────────────────────────────────
function AddressBookModal({ user, onSelect, onClose }) {
  const [addresses, setAddresses] = useState([]);
  const [adding, setAdding]       = useState(false);
  const [newAddr, setNewAddr]     = useState({ label: "", street: "", suburb: "", city: "" });

  useEffect(() => {
    getAddresses(user.email).then(setAddresses);
    // Pre-populate with home address if no saved addresses
  }, []);

  const save = async () => {
    if (!newAddr.label || !newAddr.suburb) return;
    await saveAddress(user.email, newAddr);
    const updated = await getAddresses(user.email);
    setAddresses(updated);
    setAdding(false);
    setNewAddr({ label: "", street: "", suburb: "", city: "" });
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 110, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#0D1526", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 500, padding: "24px 20px 44px", maxHeight: "80vh", overflowY: "auto" }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", margin: "0 auto 20px" }} />
        <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 16, color: "#F1F5F9", marginBottom: 16 }}>Saved addresses</div>

        {/* Home address always first */}
        {user.suburb && (
          <div onClick={() => onSelect(`${user.address || ""} ${user.suburb}, ${user.city}`.trim())}
            style={{ background: "rgba(14,165,233,0.07)", border: "1px solid rgba(14,165,233,0.2)", borderRadius: 12, padding: "12px 14px", marginBottom: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
            <Icon name="home" size={16} color="#0EA5E9" strokeWidth={1.8} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#F1F5F9" }}>Home</div>
              <div style={{ fontSize: 11, color: "#475569" }}>{user.suburb}, {user.city}</div>
            </div>
          </div>
        )}

        {addresses.map(a => (
          <div key={a.id} onClick={() => onSelect(`${a.street ? a.street + ", " : ""}${a.suburb}, ${a.city}`)}
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "12px 14px", marginBottom: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
            <Icon name="pin" size={16} color="#64748B" strokeWidth={1.8} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#F1F5F9" }}>{a.label}</div>
              <div style={{ fontSize: 11, color: "#475569" }}>{a.suburb}, {a.city}</div>
            </div>
          </div>
        ))}

        {adding ? (
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 14, marginBottom: 12 }}>
            <Input label="Label (e.g. Work, Rental)" value={newAddr.label} onChange={v => setNewAddr(a => ({...a, label:v}))} placeholder="Work" />
            <Input label="Street (optional)" value={newAddr.street} onChange={v => setNewAddr(a => ({...a, street:v}))} placeholder="123 Smith St" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Input label="Suburb" value={newAddr.suburb} onChange={v => setNewAddr(a => ({...a, suburb:v}))} placeholder="Umhlanga" />
              <Input label="City" value={newAddr.city} onChange={v => setNewAddr(a => ({...a, city:v}))} placeholder="Durban" />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="ghost" small onClick={() => setAdding(false)}>Cancel</Btn>
              <Btn full small onClick={save}>Save Address</Btn>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)}
            style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1.5px dashed rgba(255,255,255,0.12)", borderRadius: 12, padding: "12px 14px", color: "#64748B", fontSize: 13, fontFamily: "'DM Sans',sans-serif", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            + Add new address
          </button>
        )}
      </div>
    </div>
  );
}

// ─── GPS TRACKER (Customer view) ─────────────────────────────────────────────────
function GPSTrackerModal({ job, onClose }) {
  const [location, setLocation] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);

  useEffect(() => {
    const fetch = async () => {
      const loc = await getProviderLocation(job.providerId);
      if (loc) { setLocation(loc); setLastUpdate(new Date(loc.ts)); }
    };
    fetch();
    const interval = setInterval(fetch, 10000);
    return () => clearInterval(interval);
  }, [job.providerId]);

  const mapsUrl = location
    ? `https://www.google.com/maps?q=${location.lat},${location.lng}`
    : `https://www.google.com/maps/search/${encodeURIComponent(job.providerName + " " + (job.providerSuburb || "Durban"))}`;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#0D1526", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 500, padding: "24px 20px 48px" }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", margin: "0 auto 20px" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: "rgba(16,185,129,0.15)", border: "1.5px solid rgba(16,185,129,0.3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="location" size={20} color="#10B981" strokeWidth={1.8} />
          </div>
          <div>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 15, color: "#F1F5F9" }}>Track {job.providerName}</div>
            <div style={{ fontSize: 12, color: "#475569" }}>{job.status === "inprogress" ? "On the way to you" : "Provider location"}</div>
          </div>
        </div>

        {/* Map placeholder — links to Google Maps */}
        <div onClick={() => window.open(mapsUrl, "_blank")}
          style={{ background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 14, padding: 24, marginBottom: 16, textAlign: "center", cursor: "pointer" }}>
          <div style={{ marginBottom: 10 }}><Icon name="location" size={36} color="#10B981" strokeWidth={1.4} /></div>
          <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 14, color: "#34D399", marginBottom: 4 }}>
            {location ? "Live location available" : "View on Google Maps"}
          </div>
          {lastUpdate && <div style={{ fontSize: 11, color: "#065F46" }}>Updated {lastUpdate.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}</div>}
          {!location && <div style={{ fontSize: 11, color: "#334155", marginTop: 4 }}>Provider hasn't shared location yet</div>}
          <div style={{ marginTop: 12, fontSize: 12, color: "#10B981", fontWeight: 600 }}>Tap to open in Maps →</div>
        </div>

        <Btn full variant="ghost" onClick={onClose}>Close</Btn>
      </div>
    </div>
  );
}

// ─── VERIFICATION BADGE COMPONENT ────────────────────────────────────────────────
function VerificationBadge({ verification, compact = false }) {
  if (!verification) return null;
  const { status } = verification;
  const color = status === "verified" ? "#10B981" : status === "pending" ? "#F59E0B" : "#64748B";
  const label = status === "verified" ? "Verified" : status === "pending" ? "Pending" : "Unverified";
  if (compact) return (
    <span style={{ fontSize: 9, fontWeight: 700, borderRadius: 20, padding: "2px 7px", background: `${color}20`, border: `1px solid ${color}44`, color, display: "inline-flex", alignItems: "center", gap: 3 }}>
      <Icon name="check" size={8} color={color} strokeWidth={2.5} />{label}
    </span>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, background: `${color}10`, border: `1px solid ${color}30`, borderRadius: 8, padding: "6px 10px" }}>
      <Icon name="check" size={12} color={color} strokeWidth={2} />
      <span style={{ fontSize: 11, fontWeight: 600, color }}>{label} ID</span>
    </div>
  );
}

// ─── PROVIDER PROFILE PAGE ───────────────────────────────────────────────────────
// Full-screen modal shown when customer taps "View Profile"
// Designed to build confidence and trust before booking
function ProviderProfilePage({ provider, user, onClose, onBook, onRate }) {
  const [reviews, setReviews]   = useState([]);
  const [showAllReviews, setShowAllReviews] = useState(false);
  const [showBooking, setShowBooking]       = useState(false);
  const [showReview, setShowReview]         = useState(false);
  const svc = SERVICES.find(s => s.id === provider.serviceType) || SERVICES[0];
  const avgMins = provider.avgResponseMins ?? null;
  const speedTier = getSpeedTier(avgMins);

  useEffect(() => {
    if (provider.providerId) {
      store.get("reviews").then(raw => {
        const all = raw ? JSON.parse(raw.value) : [];
        setReviews(all.filter(r => r.providerId === provider.providerId));
      });
    }
  }, [provider.providerId]);

  const rating      = provider.liveRating || provider.rating || 0;
  const reviewCount = provider.liveReviewCount || provider.reviewCount || 0;
  const displayedReviews = showAllReviews ? reviews : reviews.slice(0, 3);

  // Trust signals
  const trustSignals = [
    provider.yearsInBusiness && { icon: "check", label: `${provider.yearsInBusiness} years in business`, color: "#10B981" },
    provider.insuranceConfirmed && { icon: "check", label: "Public liability insurance", color: "#10B981" },
    provider.verification?.status === "verified" && { icon: "check", label: "Identity verified", color: "#10B981" },
    provider.backgroundCheckConsent && { icon: "check", label: "Background check consented", color: "#10B981" },
    provider.emergency && { icon: "emergency", label: "24/7 emergency available", color: "#EF4444" },
    provider.certifications && { icon: "check", label: provider.certifications, color: "#0EA5E9" },
  ].filter(Boolean);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#060A14", zIndex: 200, overflowY: "auto", maxWidth: 500, margin: "0 auto" }}>

      {/* Header bar */}
      <div style={{ position: "sticky", top: 0, background: "rgba(6,10,20,0.95)", backdropFilter: "blur(20px)", borderBottom: "1px solid rgba(255,255,255,0.07)", padding: "14px 20px", display: "flex", alignItems: "center", gap: 12, zIndex: 10 }}>
        <button onClick={onClose} style={{ background: "rgba(255,255,255,0.07)", border: "none", borderRadius: 9, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
          <Icon name="cross" size={14} color="#94A3B8" strokeWidth={2} />
        </button>
        <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 15, color: "#F1F5F9", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{provider.name}</div>
        {user && (
          <button onClick={() => setShowBooking(true)}
            style={{ background: "linear-gradient(135deg,#0EA5E9,#6366F1)", border: "none", borderRadius: 9, padding: "8px 14px", fontSize: 12, fontWeight: 700, color: "white", cursor: "pointer", fontFamily: "'Syne',sans-serif", flexShrink: 0 }}>
            Book Now
          </button>
        )}
      </div>

      <div style={{ padding: "0 0 100px" }}>

        {/* Hero — logo + name + rating */}
        <div style={{ background: `linear-gradient(180deg, ${svc.color}12 0%, transparent 100%)`, padding: "28px 20px 20px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 16 }}>
            {/* Logo or initials */}
            <div style={{ width: 72, height: 72, borderRadius: 16, overflow: "hidden", flexShrink: 0, background: `${svc.color}20`, border: `2px solid ${svc.color}40`, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {provider.logoUrl ? (
                <img src={provider.logoUrl} alt={provider.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display="none"; }} />
              ) : (
                <span style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 26, color: svc.color }}>
                  {provider.name?.split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase()}
                </span>
              )}
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 20, color: "#F1F5F9", lineHeight: 1.2, marginBottom: 4 }}>{provider.name}</div>
              {provider.tagline && (
                <div style={{ fontSize: 12, color: "#64748B", lineHeight: 1.5, marginBottom: 6, fontStyle: "italic", letterSpacing: "0.01em" }}>"{provider.tagline}"</div>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                <Badge color={svc.color}>{svc.label}</Badge>
                {provider.emergency && <Badge color="#EF4444">24hr</Badge>}
                {provider.plan === "premium" && <Badge color="#F59E0B">Premium</Badge>}
                {provider.plan === "featured" && <Badge color="#0EA5E9">Featured</Badge>}
                {provider.verification?.status === "verified" && <VerificationBadge verification={provider.verification} compact />}
              </div>
            </div>
          </div>

          {/* Key stats row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[
              { val: rating > 0 ? rating.toFixed(1) : "New", sub: `${reviewCount} review${reviewCount !== 1 ? "s" : ""}`, color: "#F59E0B" },
              { val: speedTier ? (avgMins !== null ? formatResponseTime(avgMins) : speedTier.short) : "—", sub: "Avg response", color: speedTier?.color || "#64748B" },
              { val: provider.yearsInBusiness ? `${provider.yearsInBusiness}yr${provider.yearsInBusiness > 1 ? "s" : ""}` : "—", sub: "Experience", color: "#10B981" },
            ].map(({ val, sub, color }) => (
              <div key={sub} style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${color}22`, borderRadius: 11, padding: "10px 8px", textAlign: "center" }}>
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 18, color }}>{val}</div>
                <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>{sub}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Pricing */}
        {provider.priceRangeMin && (
          <div style={{ margin: "0 20px", marginTop: 16 }}>
            <div style={{ background: "rgba(16,185,129,0.07)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
              <Icon name="chart" size={18} color="#10B981" strokeWidth={1.8} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#34D399" }}>From R{provider.priceRangeMin} call-out</div>
                <div style={{ fontSize: 11, color: "#065F46", marginTop: 1 }}>Final price depends on job scope · Get a quote first</div>
              </div>
            </div>
          </div>
        )}

        {/* About */}
        {provider.description && (
          <div style={{ margin: "16px 20px 0" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>About</div>
            <div style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.8, background: "rgba(255,255,255,0.03)", borderRadius: 12, padding: "14px 16px" }}>
              {provider.description}
            </div>
          </div>
        )}

        {/* Trust signals */}
        {trustSignals.length > 0 && (
          <div style={{ margin: "16px 20px 0" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Why trust us</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {trustSignals.map((signal, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, background: `${signal.color}08`, border: `1px solid ${signal.color}20`, borderRadius: 10, padding: "10px 14px" }}>
                  <div style={{ width: 24, height: 24, borderRadius: 8, background: `${signal.color}20`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon name={signal.icon} size={12} color={signal.color} strokeWidth={2.2} />
                  </div>
                  <span style={{ fontSize: 12, color: "#94A3B8", lineHeight: 1.4 }}>{signal.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Location & contact */}
        <div style={{ margin: "16px 20px 0" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Contact & location</div>
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, overflow: "hidden" }}>
            {[
              provider.vicinity  && { icon: "pin",      label: "Based in",  val: provider.vicinity },
              provider.phone     && { icon: "phone",    label: "Phone",     val: provider.phone },
            ].filter(Boolean).map((row, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <Icon name={row.icon} size={14} color="#475569" strokeWidth={1.8} />
                <span style={{ fontSize: 11, color: "#475569", minWidth: 60 }}>{row.label}</span>
                <span style={{ fontSize: 12, color: "#94A3B8" }}>{row.val}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Reviews */}
        <div style={{ margin: "16px 20px 0" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase" }}>
              Reviews {reviewCount > 0 && `(${reviewCount})`}
            </div>
            {rating > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <StarRating rating={rating} />
                <span style={{ fontSize: 12, fontWeight: 700, color: "#F59E0B", marginLeft: 2 }}>{rating.toFixed(1)}</span>
              </div>
            )}
          </div>

          {reviews.length === 0 ? (
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "24px 16px", textAlign: "center" }}>
              <div style={{ marginBottom: 8 }}><Icon name="star" size={28} color="#334155" strokeWidth={1.4} /></div>
              <div style={{ fontSize: 13, color: "#475569" }}>No reviews yet</div>
              {user && <div style={{ fontSize: 11, color: "#334155", marginTop: 4 }}>Be the first to leave a review after your job</div>}
            </div>
          ) : (
            <>
              {displayedReviews.map(r => (
                <div key={r.id} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "14px 16px", marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#E2E8F0" }}>{r.customerName}</div>
                      <div style={{ fontSize: 10, color: "#334155", marginTop: 1 }}>{r.dateLabel}</div>
                    </div>
                    <StarRating rating={r.rating} />
                  </div>
                  {r.comment && <div style={{ fontSize: 12, color: "#64748B", lineHeight: 1.7, fontStyle: "italic" }}>"{r.comment}"</div>}
                </div>
              ))}
              {reviews.length > 3 && (
                <button onClick={() => setShowAllReviews(v => !v)}
                  style={{ width: "100%", background: "none", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "10px", fontSize: 12, fontWeight: 600, color: "#64748B", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
                  {showAllReviews ? "Show fewer reviews" : `See all ${reviews.length} reviews`}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Sticky action bar */}
      {user && (
        <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 500, background: "rgba(6,10,20,0.97)", borderTop: "1px solid rgba(255,255,255,0.08)", padding: "14px 20px 32px", display: "flex", gap: 10, backdropFilter: "blur(20px)" }}>
          <button onClick={() => setShowReview(true)}
            style={{ flex: 1, background: "rgba(245,158,11,0.12)", border: "1.5px solid rgba(245,158,11,0.3)", borderRadius: 11, padding: "12px", fontSize: 12, fontWeight: 700, color: "#F59E0B", cursor: "pointer", fontFamily: "'Syne',sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <Icon name="star" size={14} color="#F59E0B" strokeWidth={2} />Rate
          </button>
          {provider.phone && (
            <button onClick={() => window.open(`https://wa.me/${provider.phone.replace(/[\s-()+]/g,"")}?text=Hi ${provider.name}, I found you on FixIt Now and I need a ${svc.label}.`)}
              style={{ flex: 1, background: "linear-gradient(135deg,#25D366,#128C7E)", border: "none", borderRadius: 11, padding: "12px", fontSize: 12, fontWeight: 700, color: "white", cursor: "pointer", fontFamily: "'Syne',sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <Icon name="whatsapp" size={14} color="white" strokeWidth={1.8} />WhatsApp
            </button>
          )}
          <button onClick={() => setShowBooking(true)}
            style={{ flex: 2, background: "linear-gradient(135deg,#0EA5E9,#6366F1)", border: "none", borderRadius: 11, padding: "12px", fontSize: 13, fontWeight: 700, color: "white", cursor: "pointer", fontFamily: "'Syne',sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <Icon name="booking" size={14} color="white" strokeWidth={1.8} />Request a Job
          </button>
        </div>
      )}

      {showBooking && (
        <BookingModal provider={provider} user={user} serviceType={provider.serviceType}
          onClose={() => setShowBooking(false)}
          onBooked={job => { setShowBooking(false); onBook && onBook(job); }} />
      )}
      {showReview && (
        <ReviewModal provider={provider} serviceType={provider.serviceType} user={user}
          onClose={() => setShowReview(false)}
          onDone={() => {
            store.get("reviews").then(raw => {
              const all = raw ? JSON.parse(raw.value) : [];
              setReviews(all.filter(r => r.providerId === provider.providerId));
            });
          }} />
      )}
    </div>
  );
}

// ─── BOOKING MODAL ───────────────────────────────────────────────────────────────
function BookingModal({ provider, user, serviceType, onClose, onBooked }) {
  const svc = SERVICES.find(s => s.id === serviceType) || SERVICES[0];
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const fmtDate = (d) => d.toISOString().slice(0, 10);

  const [form, setForm] = useState({
    description:    "",
    date:           fmtDate(tomorrow),
    time:           "09:00",
    address:        user.address ? `${user.address}, ${user.suburb}, ${user.city}` : "",
    isEmergency:    provider.emergency && false,
    estimatedValue: "",
    recurring:      "once",
  });
  const [step, setStep]             = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [showAddrBook, setShowAddrBook] = useState(false);
  const [activeDiscount, setActiveDiscount] = useState(null); // discount from wallet for this provider
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // On mount, check if customer has an active discount for this provider
  useEffect(() => {
    if (user?.email && provider?.providerId) {
      getDiscounts(user.email).then(discounts => {
        const match = discounts.find(d => d.providerId === provider.providerId && !d.redeemed);
        if (match) setActiveDiscount(match);
      });
    }
  }, []);

  const baseValue  = form.estimatedValue ? parseFloat(form.estimatedValue) : 0;
  const discounted = activeDiscount && baseValue > 0
    ? baseValue * (1 - activeDiscount.discountPct / 100)
    : baseValue;
  const fee        = discounted > 0 ? Math.round(discounted * PLATFORM_FEE_PCT) : 0;
  const saving     = activeDiscount && baseValue > 0 ? baseValue - discounted : 0;
  const canSubmit  = form.description.trim().length > 5 && form.address.trim().length > 5;

  // Quick problem description starters per service
  const quickDesc = {
    plumber:     ["My geyser burst", "Pipe is leaking", "Blocked drain", "No hot water", "Toilet won't flush"],
    electrician: ["Power trip / no electricity", "Lights not working", "Need new plug points", "DB board issue", "Outdoor lighting"],
    handyman:    ["Door won't close/lock", "Shelves need fitting", "Tile is cracked", "Ceiling needs repair", "General maintenance"],
    security:    ["Alarm keeps triggering", "Need CCTV installed", "Electric fence issue", "Access control not working"],
    gate_repair: ["Gate motor not working", "Gate won't open/close", "Intercom broken", "Remote not working"],
    technology:  ["TV needs wall mounting", "Sound system setup", "Smart home device install", "DSTV installation", "WiFi / networking"],
  }[serviceType] || [];

  const submit = async () => {
    setSubmitting(true);
    const job = {
      id:              `job-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      providerId:      provider.providerId || null,
      providerName:    provider.name,
      providerPhone:   provider.phone || "",
      providerSuburb:  provider.vicinity || "",
      customerId:      user.email,
      customerName:    user.name,
      customerPhone:   user.phone || "",
      serviceType,
      serviceName:     svc.label,
      description:     form.description,
      address:         form.address,
      preferredDate:   form.date,
      preferredTime:   form.time,
      isEmergency:     form.isEmergency,
      recurring:       form.recurring,
      estimatedValue:  baseValue || null,
      discountApplied: activeDiscount ? activeDiscount.discountPct : 0,
      discountedValue: discounted || null,
      platformFee:     fee,
      status:          "pending",
      statusNote:      "",
      createdAt:       new Date().toISOString(),
      updatedAt:       new Date().toISOString(),
      dateLabel:       new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "short" }),
      timeLabel:       new Date().toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }),
    };
    await saveJob(job);

    // Mark discount as redeemed in customer wallet
    if (activeDiscount) {
      await redeemDiscount(user.email, activeDiscount.id);
    }

    await trackEvent({ providerId: provider.providerId || null, providerName: provider.name, type: "booking", serviceType, searchArea: form.address, searchQuery: form.description, plan: provider.plan });

    if (provider.providerId) {
      const discountNote = activeDiscount ? ` ⚡ ${activeDiscount.discountPct}% loyalty discount applied — customer is a returning client.` : "";
      await pushNotif(provider.providerId, {
        title: "New job request!",
        body:  `${user.name} needs a ${svc.label}: "${form.description.slice(0,50)}"${discountNote}`,
        type:  "booking", jobId: job.id,
      });
    }
    await pushNotif(user.email, {
      title: "Job request sent",
      body:  `Your ${svc.label} request was sent to ${provider.name}. Waiting for confirmation.${activeDiscount ? ` Your ${activeDiscount.discountPct}% discount has been applied.` : ""}`,
      type:  "booking", jobId: job.id,
    });
    setSubmitting(false);
    setStep(3);
    if (onBooked) onBooked(job);
  };

  const inputStyle = { width: "100%", background: "rgba(255,255,255,0.05)", border: "1.5px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "11px 13px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#0D1526", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 500, maxHeight: "92vh", overflowY: "auto", padding: "24px 20px 40px" }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", margin: "0 auto 20px" }} />

        {step === 1 && (
          <>
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 20 }}>
              <div style={{ width: 44, height: 44, borderRadius: 11, background: `${svc.color}18`, border: `1.5px solid ${svc.color}33`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <ServiceIcon serviceId={svc.id} size={22} color={svc.color} />
              </div>
              <div>
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 15, color: "#F1F5F9" }}>Request a job</div>
                <div style={{ fontSize: 12, color: "#475569" }}>{provider.name} · {svc.label}</div>
              </div>
            </div>

            {/* Quick problem picks */}
            {quickDesc.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>What's the problem?</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {quickDesc.map(q => (
                    <button key={q} onClick={() => set("description", q)}
                      style={{ fontSize: 11, fontWeight: 600, borderRadius: 20, padding: "5px 11px", cursor: "pointer", transition: "all 0.15s", background: form.description === q ? `${svc.color}20` : "rgba(255,255,255,0.05)", border: `1.5px solid ${form.description === q ? svc.color+"55" : "rgba(255,255,255,0.08)"}`, color: form.description === q ? svc.color : "#64748B", fontFamily: "'DM Sans',sans-serif" }}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Description */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 6 }}>
                {quickDesc.length > 0 ? "Add more detail (optional)" : "Describe the problem"}
              </label>
              <textarea value={form.description} onChange={e => set("description", e.target.value)}
                placeholder={`e.g. My geyser burst overnight, water is leaking from the ceiling…`} rows={3}
                style={{ ...inputStyle, resize: "none" }} />
            </div>

            {/* Date + time row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Preferred date</label>
                <input type="date" value={form.date} min={fmtDate(tomorrow)} onChange={e => set("date", e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Preferred time</label>
                <select value={form.time} onChange={e => set("time", e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
                  {["07:00","08:00","09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"].map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Recurring */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 8 }}>How often?</label>
              <div style={{ display: "flex", gap: 6 }}>
                {[["once","Once off"],["weekly","Weekly"],["monthly","Monthly"]].map(([id, label]) => (
                  <button key={id} onClick={() => set("recurring", id)}
                    style={{ flex: 1, padding: "8px 4px", borderRadius: 9, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", transition: "all 0.15s", background: form.recurring === id ? "rgba(14,165,233,0.18)" : "rgba(255,255,255,0.04)", border: `1.5px solid ${form.recurring === id ? "#0EA5E9" : "rgba(255,255,255,0.08)"}`, color: form.recurring === id ? "#38BDF8" : "#64748B" }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Address with address book */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase" }}>Job address</label>
                <button onClick={() => setShowAddrBook(true)}
                  style={{ fontSize: 10, fontWeight: 600, color: "#0EA5E9", background: "none", border: "none", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", display: "flex", alignItems: "center", gap: 4 }}>
                  <Icon name="home" size={11} color="#0EA5E9" strokeWidth={2} />Saved addresses
                </button>
              </div>
              <input value={form.address} onChange={e => set("address", e.target.value)} placeholder="123 Oak St, Berea, Durban" style={inputStyle} />
            </div>

            {/* Active discount banner */}
            {activeDiscount && (
              <div style={{ background: "linear-gradient(135deg,rgba(16,185,129,0.12),rgba(14,165,233,0.08))", border: "1.5px solid rgba(16,185,129,0.35)", borderRadius: 12, padding: "12px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(16,185,129,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Icon name="star" size={18} color="#10B981" strokeWidth={1.8} />
                </div>
                <div>
                  <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 14, color: "#34D399" }}>{activeDiscount.discountPct}% loyalty discount applied!</div>
                  <div style={{ fontSize: 11, color: "#065F46", marginTop: 2 }}>Earned from your previous booking with {provider.name}. Applied automatically.</div>
                </div>
              </div>
            )}

            {/* Estimated value */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Estimated job value (optional)</label>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: "#475569", fontWeight: 600 }}>R</span>
                <input type="number" value={form.estimatedValue} onChange={e => set("estimatedValue", e.target.value)} placeholder="e.g. 800" style={{ ...inputStyle, paddingLeft: 26 }} />
              </div>
              {baseValue > 0 && activeDiscount && (
                <div style={{ marginTop: 6, background: "rgba(16,185,129,0.08)", borderRadius: 8, padding: "6px 10px" }}>
                  <div style={{ fontSize: 10, color: "#34D399" }}>Original: R{baseValue.toLocaleString()} → After {activeDiscount.discountPct}% discount: <strong>R{discounted.toLocaleString("en-ZA", {maximumFractionDigits:0})}</strong></div>
                  <div style={{ fontSize: 10, color: "#065F46", marginTop: 2 }}>You save R{saving.toLocaleString("en-ZA", {maximumFractionDigits:0})} · Platform fee: R{fee}</div>
                </div>
              )}
              {baseValue > 0 && !activeDiscount && <div style={{ fontSize: 10, color: "#0EA5E9", marginTop: 4 }}>Platform fee: R{fee} (8%)</div>}
            </div>

            {/* Emergency toggle */}
            {provider.emergency && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.15)", borderRadius: 11, padding: "11px 14px", marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#FCA5A5" }}>Emergency priority</div>
                  <div style={{ fontSize: 10, color: "#7F1D1D", marginTop: 2 }}>Provider will prioritise your job</div>
                </div>
                <div onClick={() => set("isEmergency", !form.isEmergency)} style={{ width: 40, height: 22, borderRadius: 11, background: form.isEmergency ? "#EF4444" : "rgba(255,255,255,0.1)", position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0 }}>
                  <div style={{ position: "absolute", top: 3, left: form.isEmergency ? 21 : 3, width: 16, height: 16, borderRadius: "50%", background: "white", transition: "left 0.2s" }} />
                </div>
              </div>
            )}

            <Btn full onClick={() => setStep(2)} disabled={!canSubmit}>Review & Send Request →</Btn>

            {showAddrBook && (
              <AddressBookModal
                user={user}
                onSelect={addr => { set("address", addr); setShowAddrBook(false); }}
                onClose={() => setShowAddrBook(false)}
              />
            )}
          </>
        )}

        {step === 2 && (
          <>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 16, color: "#F1F5F9", marginBottom: 4 }}>Confirm your request</div>
            <div style={{ fontSize: 12, color: "#475569", marginBottom: 20 }}>Review the details before sending to {provider.name}.</div>

            {/* Discount confirmation banner */}
            {activeDiscount && (
              <div style={{ background: "linear-gradient(135deg,rgba(16,185,129,0.15),rgba(16,185,129,0.06))", border: "1.5px solid rgba(16,185,129,0.4)", borderRadius: 12, padding: "12px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
                <Icon name="star" size={20} color="#10B981" strokeWidth={1.8} />
                <div>
                  <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 13, color: "#34D399" }}>{activeDiscount.discountPct}% loyalty discount applied</div>
                  <div style={{ fontSize: 11, color: "#065F46", marginTop: 1 }}>This discount is included in your request. {provider.name} will see it on their end.</div>
                </div>
              </div>
            )}

            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 13, padding: 16, marginBottom: 16 }}>
              {[
                ["Service",  svc.label],
                ["Provider", provider.name],
                ["Date",     `${form.date} at ${form.time}`],
                ["Recurring", form.recurring === "once" ? "Once off" : form.recurring === "weekly" ? "Weekly" : "Monthly"],
                ["Address",  form.address],
                ["Job",      form.description],
                ...(baseValue > 0 && activeDiscount ? [
                  ["Original",  `R${baseValue.toLocaleString()}`],
                  ["Discount",  `${activeDiscount.discountPct}% off = R${saving.toLocaleString("en-ZA",{maximumFractionDigits:0})} saving`],
                  ["You pay",   `R${discounted.toLocaleString("en-ZA",{maximumFractionDigits:0})}`],
                  ["Platform fee", `R${fee} (8%)`],
                ] : baseValue > 0 ? [
                  ["Est. value", `R${baseValue.toLocaleString()}`],
                  ["Platform fee", `R${fee} (8%)`],
                ] : []),
                ...(form.isEmergency ? [["Priority", "Emergency"]] : []),
              ].map(([k, v]) => (
                <div key={k} style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                  <span style={{ fontSize: 11, color: k === "You pay" ? "#34D399" : "#475569", minWidth: 80, flexShrink: 0, fontWeight: k === "You pay" ? 700 : 400 }}>{k}</span>
                  <span style={{ fontSize: 12, color: k === "You pay" ? "#34D399" : k === "Discount" ? "#10B981" : "#C4CDD8", lineHeight: 1.5, wordBreak: "break-word", fontWeight: k === "You pay" ? 700 : 400 }}>{v}</span>
                </div>
              ))}
            </div>

            <div style={{ background: "rgba(14,165,233,0.07)", border: "1px solid rgba(14,165,233,0.18)", borderRadius: 10, padding: "11px 14px", marginBottom: 16, fontSize: 11, color: "#7DD3FC", lineHeight: 1.6 }}>
              Your request will be sent to {provider.name}. They'll accept or decline within a few hours. You'll see the status update in your My Jobs tab.
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <Btn variant="ghost" onClick={() => setStep(1)}>← Edit</Btn>
              <Btn full variant="green" onClick={submit} disabled={submitting}>{submitting ? "Sending…" : "Send Job Request ✓"}</Btn>
            </div>
          </>
        )}

        {step === 3 && (
          <div style={{ textAlign: "center", padding: "20px 0 8px" }}>
            <div style={{ marginBottom: 16 }}><Icon name="check" size={48} color="#10B981" strokeWidth={1.3} /></div>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 20, color: "#F1F5F9", marginBottom: 8 }}>Request sent!</div>
            <div style={{ fontSize: 13, color: "#64748B", lineHeight: 1.7, maxWidth: 280, margin: "0 auto 24px" }}>
              {provider.name} will review your job and respond shortly. Track it in <span style={{ color: "#0EA5E9", fontWeight: 600 }}>My Jobs</span>.
            </div>
            <Btn full onClick={onClose}>Done</Btn>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── PROVIDER CARD ───────────────────────────────────────────────────────────────
function ProviderCard({ provider, searchArea, searchQuery, user, onBooked }) {
  const [open, setOpen]             = useState(false);
  const [tracked, setTracked]       = useState(false);
  const [showBooking, setShowBooking]   = useState(false);
  const [showReview, setShowReview]     = useState(false);
  const [showProfile, setShowProfile]   = useState(false);
  const [cardReviews, setCardReviews]   = useState([]);
  const [reviewsLoaded, setReviewsLoaded] = useState(false);
  const svc = SERVICES.find(s => s.id === provider.serviceType) || SERVICES[0];

  // Fire a view event the first time the card is expanded
  const handleExpand = async () => {
    const next = !open;
    setOpen(next);
    if (next && !tracked) {
      setTracked(true);
      await trackEvent({
        providerId:  provider.providerId || null,
        providerName: provider.name,
        type:        "view",
        serviceType: provider.serviceType,
        searchArea,
        searchQuery,
        plan:        provider.plan,
      });
    }
    // Load reviews for this provider when card opens
    if (next && !reviewsLoaded && provider.providerId) {
      try {
        const raw = await store.get("reviews");
        const all = raw ? JSON.parse(raw.value) : [];
        setCardReviews(all.filter(r => r.providerId === provider.providerId).slice(0, 3));
      } catch {}
      setReviewsLoaded(true);
    }
  };

  const call = async () => {
    if (!provider.phone) return;
    await trackEvent({
      providerId:   provider.providerId || null,
      providerName: provider.name,
      type:         "call",
      serviceType:  provider.serviceType,
      searchArea,
      searchQuery,
      plan:         provider.plan,
    });
    window.open(`tel:${provider.phone.replace(/\s/g,"")}`);
  };

  const whatsapp = async () => {
    await trackEvent({
      providerId:   provider.providerId || null,
      providerName: provider.name,
      type:         "whatsapp",
      serviceType:  provider.serviceType,
      searchArea,
      searchQuery,
      plan:         provider.plan,
    });
    const n = provider.phone?.replace(/[\s-()+]/g,"");
    window.open(`https://wa.me/${n}?text=Hi, I found you on FixIt Now and need ${svc.label} help. Are you available?`);
  };

  const maps = () => window.open(`https://www.google.com/maps/search/${encodeURIComponent(provider.name+" "+provider.vicinity)}`);

  // Build list of services with their areas for display
  const serviceAreaEntries = provider.serviceAreas
    ? Object.entries(provider.serviceAreas).map(([id, areaData]) => {
        const s = SERVICES.find(sv => sv.id === id);
        if (!s) return null;
        return { svc: s, allKZN: areaData.allKZN, areas: areaData.areas || [] };
      }).filter(Boolean)
    : [];

  return (
    <div onClick={handleExpand}
      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: "18px 20px", cursor: "pointer", marginBottom: 10, position: "relative", overflow: "hidden", transition: "background 0.2s" }}
      onMouseEnter={e => e.currentTarget.style.background="rgba(255,255,255,0.07)"}
      onMouseLeave={e => e.currentTarget.style.background="rgba(255,255,255,0.04)"}
    >
      {provider.openNow && <div style={{ position: "absolute", top: 0, right: 0, background: "linear-gradient(135deg,#10B981,#059669)", fontSize: 9, fontWeight: 700, color: "white", padding: "4px 10px", borderRadius: "0 16px 0 10px", letterSpacing: "0.1em" }}>OPEN NOW</div>}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div style={{ width: 44, height: 44, borderRadius: 11, background: `${svc.color}18`, border: `1.5px solid ${svc.color}33`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><ServiceIcon serviceId={svc.id} size={22} color={svc.color} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <span style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 14, color: "#F1F5F9" }}>{provider.name}</span>
            {provider.emergency && <Badge color="#EF4444">24hr</Badge>}
            {provider.plan === "premium"  && <Badge color="#F59E0B">Premium</Badge>}
            {provider.plan === "featured" && <Badge color="#0EA5E9">Featured</Badge>}
            {provider.verification?.status === "verified" && <VerificationBadge verification={provider.verification} compact />}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
            <StarRating rating={provider.liveRating || provider.rating} />
            <span style={{ color: "#94A3B8", fontSize: 11 }}>
              {(provider.liveRating || provider.rating)?.toFixed(1)} ({provider.liveReviewCount || provider.reviewCount} review{(provider.liveReviewCount || provider.reviewCount) !== 1 ? "s" : ""})
              {provider.liveReviewCount > 0 && <span style={{ color: "#10B981" }}> ✓ verified</span>}
            </span>
            {/* Response speed badge */}
            <SpeedBadge avgResponseMins={provider.avgResponseMins ?? null} />
          </div>
          <div style={{ color: "#475569", fontSize: 11, marginTop: 3 }}><Icon name="pin" size={11} color="#475569" strokeWidth={1.6} /> {provider.vicinity}</div>

          {/* Per-service area summary (registered providers only) */}
          {serviceAreaEntries.length > 0 && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
              {serviceAreaEntries.map(({ svc: sv, allKZN, areas }) => (
                <div key={sv.id} style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 76 }}>
                    <ServiceIcon serviceId={sv.id} size={11} color="#475569" />
                    <span style={{ fontSize: 11, color: "#475569" }}>{sv.label}</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                    {allKZN ? (
                      <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 20, padding: "2px 8px", background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)", color: "#34D399" }}>All KZN</span>
                    ) : (
                      areas.slice(0, 4).map(a => (
                        <span key={a} style={{ fontSize: 10, fontWeight: 600, borderRadius: 20, padding: "2px 7px", background: `${sv.color}15`, border: `1px solid ${sv.color}35`, color: sv.color }}>{a}</span>
                      ))
                    )}
                    {!allKZN && areas.length > 4 && (
                      <span style={{ fontSize: 10, color: "#475569" }}>+{areas.length - 4}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ color: "#475569", fontSize: 16 }}>{open ? "▲" : "▼"}</div>
      </div>

      {open && (
        <div onClick={e => e.stopPropagation()} style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.07)" }}>
          {provider.description && <p style={{ color: "#64748B", fontSize: 12, marginBottom: 12, lineHeight: "1.5" }}>{provider.description}</p>}
          {provider.phone && <div style={{ color: "#94A3B8", fontSize: 12, marginBottom: 10 }}><Icon name="phone" size={11} color="#94A3B8" strokeWidth={1.8} /> {provider.phone}</div>}

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {provider.phone && <button onClick={call}     style={{ flex: 1, minWidth: 80, background: "linear-gradient(135deg,#10B981,#059669)", color: "white", border: "none", borderRadius: 9, padding: "9px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><Icon name="phone" size={12} color="white" strokeWidth={1.8} />Call</button>}
            {provider.phone && <button onClick={whatsapp} style={{ flex: 1, minWidth: 80, background: "linear-gradient(135deg,#25D366,#128C7E)", color: "white", border: "none", borderRadius: 9, padding: "9px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><Icon name="whatsapp" size={12} color="white" strokeWidth={1.8} />WhatsApp</button>}
            <button onClick={maps}                        style={{ flex: 1, minWidth: 80, background: "rgba(255,255,255,0.07)", color: "#CBD5E1", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 9, padding: "9px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><Icon name="directions" size={12} color="#CBD5E1" strokeWidth={1.8} />Directions</button>
          </div>

          {/* Book + Rate row */}
          {user && (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button onClick={() => setShowBooking(true)}
                style={{ flex: 2, background: "linear-gradient(135deg,#0EA5E9,#6366F1)", color: "white", border: "none", borderRadius: 9, padding: "11px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'Syne',sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                <Icon name="booking" size={12} color="white" strokeWidth={1.8} />Request a Job
              </button>
              <button onClick={() => setShowReview(true)}
                style={{ flex: 1, background: "rgba(245,158,11,0.12)", color: "#F59E0B", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 9, padding: "11px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'Syne',sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
                <Icon name="star" size={12} color="#F59E0B" strokeWidth={1.8} />Rate
              </button>
            </div>
          )}

          {/* View Full Profile */}
          <button onClick={() => setShowProfile(true)}
            style={{ width: "100%", marginTop: 8, background: "none", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 9, padding: "9px 12px", fontSize: 11, fontWeight: 600, color: "#475569", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, transition: "all 0.15s" }}>
            View full profile & all reviews →
          </button>

          {/* Inline reviews */}
          {cardReviews.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#334155", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>
                Customer reviews
              </div>
              {cardReviews.map(r => (
                <div key={r.id} style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: "#94A3B8" }}>{r.customerName}</span>
                    <div style={{ display: "flex", gap: 1 }}>
                      {[1,2,3,4,5].map(i => <span key={i} style={{ color: i <= r.rating ? "#F59E0B" : "#1E293B", fontSize: 11 }}>★</span>)}
                    </div>
                  </div>
                  {r.comment && <div style={{ fontSize: 11, color: "#475569", lineHeight: 1.5 }}>"{r.comment}"</div>}
                  <div style={{ fontSize: 10, color: "#334155", marginTop: 2 }}>{r.dateLabel}</div>
                </div>
              ))}
            </div>
          )}

          {/* No reviews nudge for registered providers with no reviews yet */}
          {reviewsLoaded && cardReviews.length === 0 && provider.providerId && (
            <div style={{ marginTop: 12, fontSize: 11, color: "#334155", textAlign: "center" }}>
              No reviews yet — be the first to rate this provider
            </div>
          )}
        </div>
      )}

      {showBooking && user && (
        <BookingModal
          provider={provider}
          user={user}
          serviceType={provider.serviceType}
          onClose={() => setShowBooking(false)}
          onBooked={(job) => { setShowBooking(false); if (onBooked) onBooked(job); }}
        />
      )}

      {showReview && user && (
        <ReviewModal
          provider={provider}
          serviceType={provider.serviceType}
          user={user}
          onClose={() => setShowReview(false)}
          onDone={() => {
            // Refresh inline reviews after submitting
            store.get("reviews").then(raw => {
              const all = raw ? JSON.parse(raw.value) : [];
              setCardReviews(all.filter(r => r.providerId === provider.providerId).slice(0, 3));
            });
          }}
        />
      )}

      {showProfile && (
        <ProviderProfilePage
          provider={provider}
          user={user}
          onClose={() => setShowProfile(false)}
          onBook={(job) => { setShowProfile(false); if (onBooked) onBooked(job); }}
        />
      )}
    </div>
  );
}

// ─── CUSTOMER HOME ───────────────────────────────────────────────────────────────
function CustomerHome({ user, onLogout }) {
  const [tab, setTab] = useState("find");
  const [selectedService, setSelectedService] = useState(null);
  const [location, setLocation] = useState(user.suburb ? `${user.suburb}, ${user.city}` : "");
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [emergencyOnly, setEmergencyOnly] = useState(false);
  const [sortBy, setSortBy] = useState("best");   // best | rating | speed | reviews | available
  const [deals, setDeals]         = useState([]);
  const [searchDone, setSearchDone] = useState(false);
  const [error, setError] = useState("");
  const [myJobs, setMyJobs]       = useState([]);
  const [jobsBadge, setJobsBadge] = useState(0);
  const [searchHistory, setSearchHistory] = useState([]);
  const [showNotifs, setShowNotifs]       = useState(false);
  const [reviewJob, setReviewJob]         = useState(null);
  const [chatJob, setChatJob]             = useState(null);
  const [gpsJob, setGpsJob]              = useState(null);
  const [showQuoteModal, setShowQuoteModal] = useState(false);
  const [completionNotif, setCompletionNotif] = useState(null); // sales moment popup
  const resultsRef = useRef(null);

  // Poll for completion/sales notifications every 10s
  useEffect(() => {
    const checkSalesNotifs = async () => {
      const notifs = await getNotifs(user.email);
      const salesNotif = notifs.find(n => n.isSalesNotif && !n.salesSeen);
      if (salesNotif) {
        // Mark as seen so it doesn't re-show
        const key = `notifs:${user.email}`;
        const raw = await store.get(key);
        const all = raw ? JSON.parse(raw.value) : [];
        await store.set(key, all.map(n => n.id === salesNotif.id ? { ...n, salesSeen: true } : n));
        setCompletionNotif(salesNotif);
      }
    };
    checkSalesNotifs();
    const interval = setInterval(checkSalesNotifs, 15000);
    return () => clearInterval(interval);
  }, [user.email]);

  const loadMyJobs = async () => {
    try {
      const raw = await store.get("jobs");
      const all = raw ? JSON.parse(raw.value) : [];
      const mine = all.filter(j => j.customerId === user.email);
      setMyJobs(mine);
    } catch {}
  };

  useEffect(() => {
    loadMyJobs();
    getSearchHistory(user.email).then(setSearchHistory);
  }, []);
  useEffect(() => { if (tab === "jobs") { loadMyJobs(); setJobsBadge(0); } }, [tab]);

  const search = async () => {
    if (!selectedService || !location.trim()) { setError(!selectedService ? "Select a service type." : "Enter your location."); return; }
    setError(""); setLoading(true); setProviders([]); setSearchDone(false);
    const svc = SERVICES.find(s => s.id === selectedService);

    await saveSearch(user.email, { serviceId: selectedService, location });
    getSearchHistory(user.email).then(setSearchHistory);

    // Load deals for this service
    getDeals().then(all => setDeals(all.filter(d => !d.serviceId || d.serviceId === selectedService)));

    // ── Step 1: Load registered providers immediately (never fails) ──────────
    const storedRaw = await store.get("providers");
    const allApproved = storedRaw ? JSON.parse(storedRaw.value).filter(p => p.status === "approved") : [];
    const searchLower = location.toLowerCase();
    const searchSuburb = searchLower.split(",")[0].trim();

    const registeredProviders = allApproved.filter(p => {
      if (!p.services?.includes(selectedService)) return false;
      const sa = p.serviceAreas?.[selectedService];
      if (!sa) return true;             // no restriction = shows everywhere
      if (sa.allKZN) return true;       // covers all KZN
      return (sa.areas || []).some(area =>
        searchLower.includes(area.toLowerCase()) ||
        area.toLowerCase().includes(searchSuburb)
      );
    });

    // Load availability for all providers in parallel
    const registeredProviders = await Promise.all(eligible.map(async p => {
      const avgMins = getResponseSpeed(p.jobs || []);
      const avail   = await getAvailability(p.id);
      return {
        name: p.bizName,
        rating: p.liveRating || 4.5,
        reviewCount: p.liveReviewCount || 0,
        vicinity: `${p.suburb}, ${p.city}`,
        phone: p.phone,
        emergency: p.emergency,
        openNow: true,
        serviceType: selectedService,
        plan: p.plan,
        description: p.description,
        tagline: p.tagline,
        yearsInBusiness: p.yearsInBusiness,
        priceRangeMin: p.priceRangeMin,
        certifications: p.certifications,
        logoUrl: p.logoUrl,
        insuranceConfirmed: p.insuranceConfirmed,
        verification: p.verification,
        serviceAreas: p.serviceAreas || {},
        providerId: p.id,
        liveRating: p.liveRating,
        liveReviewCount: p.liveReviewCount,
        avgResponseMins: avgMins,
        joinDate: p.joinDate,
        avail,
      };
    }));

    // Show registered providers right away — don't wait for AI
    if (registeredProviders.length > 0) {
      setProviders(registeredProviders);
      setSearchDone(true);
      setLoading(false);
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    }

    // ── Step 2: Try to load AI-generated extras (optional, may fail silently) ─
    const prompt = `Generate 4 realistic mock ${svc.label} service providers near "${location}" in KwaZulu-Natal, South Africa. Return ONLY a JSON array, no markdown. Each object: {"name":"string","rating":number 3.8-4.9,"reviewCount":integer 12-180,"vicinity":"suburb near ${location}","phone":"SA mobile starting with 0","emergency":boolean,"openNow":boolean,"serviceType":"${selectedService}","plan":"basic","description":"one sentence about their specialty"}`;

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 600, messages: [{ role: "user", content: prompt }] })
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = data.content?.map(i => i.text || "").join("") || "";
        const clean = text.replace(/```json|```/g, "").trim();
        const aiProviders = JSON.parse(clean);
        // Registered providers always first, AI fills in the rest
        setProviders([...registeredProviders, ...aiProviders]);
      }
    } catch {
      // AI failed — that's fine, registered providers are already showing
    }

    // If no registered providers and AI also failed, show helpful message
    if (registeredProviders.length === 0) {
      setSearchDone(true);
      setError("");
    }
    setLoading(false);
  };

  const filtered = providers
    .filter(p => !emergencyOnly || p.emergency)
    .filter(p => sortBy === "available" ? isAvailableToday(p.avail) : true)
    .map(p => ({
      ...p,
      _score:     rankScore(p),
      _available: isAvailableToday(p.avail),
    }))
    .sort((a, b) => {
      // Unavailable providers always sort below available ones (unless filtering by available)
      if (sortBy !== "available") {
        if (a._available !== b._available) return a._available ? -1 : 1;
      }
      if (sortBy === "best" || sortBy === "available") return b._score - a._score;
      if (sortBy === "rating") {
        const ra = a.liveRating || a.rating || 0;
        const rb = b.liveRating || b.rating || 0;
        if (rb !== ra) return rb - ra;
        return b._score - a._score;
      }
      if (sortBy === "speed") {
        const sa = a.avgResponseMins ?? 99999;
        const sb = b.avgResponseMins ?? 99999;
        if (sa !== sb) return sa - sb;
        return b._score - a._score;
      }
      if (sortBy === "reviews") {
        const ra = a.liveReviewCount || a.reviewCount || 0;
        const rb = b.liveReviewCount || b.reviewCount || 0;
        if (rb !== ra) return rb - ra;
        return b._score - a._score;
      }
      return b._score - a._score;
    });

  // Fresh picks: registered providers with <10 reviews, <90 days old, available
  const freshPicks = providers.filter(p =>
    p.providerId &&
    (p.liveReviewCount || 0) < 10 &&
    p._available !== false &&
    p.joinDate && (Date.now() - new Date(p.joinDate).getTime()) < 90 * 86400000
  );

  return (
    <div style={{ minHeight: "100vh", background: "#060A14", maxWidth: 500, margin: "0 auto" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500;600&family=Space+Grotesk:wght@600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}body{background:#060A14}
        input,textarea,select{outline:none}
        input::placeholder,textarea::placeholder{color:#475569}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#1E293B;border-radius:4px}
        @keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes shimmer{0%{background-position:-400px 0}100%{background-position:400px 0}}
        .fadeUp{animation:fadeUp 0.35s ease forwards}
        .shimmer{background:linear-gradient(90deg,rgba(255,255,255,0.03) 25%,rgba(255,255,255,0.07) 50%,rgba(255,255,255,0.03) 75%);background-size:400px 100%;animation:shimmer 1.4s infinite;border-radius:14px;height:84px;margin-bottom:10px}
      `}</style>

      {tab === "find" && (
        <div style={{ padding: "0 16px 100px" }}>
          <div style={{ paddingTop: 44, paddingBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Logo size={32} />
                <Wordmark size={17} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <NotificationBell userId={user.email} onOpen={() => setShowNotifs(true)} />
                <div style={{ width: 34, height: 34, borderRadius: "50%", background: "linear-gradient(135deg,#0EA5E9,#6366F1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: "white", fontFamily: "'Syne',sans-serif", cursor: "pointer" }} onClick={() => setTab("profile")}>
                  {user.name?.charAt(0).toUpperCase()}
                </div>
              </div>
            </div>
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 22, fontFamily: "'Syne',sans-serif", fontWeight: 800, color: "#F1F5F9", lineHeight: "1.2" }}>Hi {user.name?.split(" ")[0]} 👋</div>
              <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>What do you need help with today?</div>
              {user.suburb && (
                <div style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "rgba(14,165,233,0.08)", border: "1px solid rgba(14,165,233,0.15)", borderRadius: 20, padding: "4px 10px", marginTop: 8 }}>
                  <Icon name="pin" size={11} color="#0EA5E9" strokeWidth={1.8} />
                  <span style={{ color: "#0EA5E9", fontSize: 11, fontWeight: 600 }}>{user.suburb}, {user.city}</span>
                </div>
              )}
              {/* Recent searches */}
              {searchHistory.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: "#334155", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Recent searches</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {searchHistory.slice(0, 4).map((s, i) => {
                      const svc = SERVICES.find(sv => sv.id === s.serviceId);
                      return (
                        <div key={i} onClick={() => { setSelectedService(s.serviceId); setLocation(s.location); }}
                          style={{ display: "flex", alignItems: "center", gap: 5, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 20, padding: "4px 10px", cursor: "pointer", transition: "background 0.15s" }}
                          onMouseEnter={e => e.currentTarget.style.background="rgba(255,255,255,0.09)"}
                          onMouseLeave={e => e.currentTarget.style.background="rgba(255,255,255,0.05)"}>
                          <ServiceIcon serviceId={svc?.id || "handyman"} size={13} color={svc?.color || "#94A3B8"} />
                          <span style={{ fontSize: 11, color: "#94A3B8" }}>{svc?.label}</span>
                          <span style={{ fontSize: 10, color: "#334155" }}>· {s.location}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Service picker */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10, fontFamily: "'DM Sans',sans-serif" }}>Select Service</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
              {SERVICES.map(s => {
                const sel = selectedService === s.id;
                return (
                  <div key={s.id} onClick={() => { setSelectedService(s.id); setError(""); }}
                    style={{ background: sel ? `${s.color}18` : "rgba(255,255,255,0.03)", border: `1.5px solid ${sel ? s.color+"55" : "rgba(255,255,255,0.07)"}`, borderRadius: 13, padding: "13px 8px", cursor: "pointer", textAlign: "center", transition: "all 0.2s", position: "relative" }}>
                    {s.emergency && <div style={{ position: "absolute", top: 5, right: 6, width: 5, height: 5, borderRadius: "50%", background: sel ? "#EF4444" : "#374151" }} />}
                    <div style={{ marginBottom: 5, display: "flex", justifyContent: "center" }}>
                      <ServiceIcon serviceId={s.id} size={24} color={sel ? s.color : "#64748B"} />
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: sel ? "#F1F5F9" : "#64748B", fontFamily: "'Syne',sans-serif", lineHeight: "1.2" }}>{s.label}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Location */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#64748B", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8, fontFamily: "'DM Sans',sans-serif" }}>Search Area</div>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", display: "flex" }}>
                <Icon name="pin" size={14} color="#475569" strokeWidth={1.8} />
              </span>
              <input value={location} onChange={e => setLocation(e.target.value)} onKeyDown={e => e.key==="Enter" && search()} placeholder="Suburb or city…"
                style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1.5px solid rgba(255,255,255,0.08)", borderRadius: 11, padding: "12px 80px 12px 38px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif" }} />
              {user.suburb && <button onClick={() => setLocation(`${user.suburb}, ${user.city}`)} style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "rgba(14,165,233,0.12)", border: "1px solid rgba(14,165,233,0.2)", borderRadius: 7, padding: "5px 9px", color: "#0EA5E9", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Home</button>}
            </div>
          </div>

          {/* Emergency toggle */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.12)", borderRadius: 11, padding: "11px 14px", marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#FCA5A5" }}>Emergency / 24hr only</div>
            <div onClick={() => setEmergencyOnly(e => !e)} style={{ width: 40, height: 22, borderRadius: 11, background: emergencyOnly ? "#EF4444" : "rgba(255,255,255,0.1)", position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0 }}>
              <div style={{ position: "absolute", top: 3, left: emergencyOnly ? 21 : 3, width: 16, height: 16, borderRadius: "50%", background: "white", transition: "left 0.2s" }} />
            </div>
          </div>

          {error && <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 9, padding: "10px 14px", marginBottom: 12, color: "#FCA5A5", fontSize: 12 }}>{error}</div>}

          <button onClick={search} disabled={loading} style={{ width: "100%", background: loading ? "rgba(255,255,255,0.06)" : "linear-gradient(135deg,#0EA5E9,#6366F1)", border: "none", borderRadius: 13, padding: 15, color: loading ? "#475569" : "white", fontSize: 14, fontWeight: 700, fontFamily: "'Syne',sans-serif", cursor: loading ? "default" : "pointer", boxShadow: loading ? "none" : "0 6px 24px rgba(14,165,233,0.2)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            {loading
              ? <><span style={{ width: 14, height: 14, border: "2px solid #475569", borderTopColor: "#94A3B8", borderRadius: "50%", animation: "spin 0.8s linear infinite", display: "inline-block" }} />Finding pros…</>
              : `Find ${SERVICES.find(s=>s.id===selectedService)?.label || "Pros"} Near Me →`}
          </button>

          <div ref={resultsRef}>
            {loading && <div style={{ marginTop: 24 }}>{[0,1,2,3].map(i=><div key={i} className="shimmer" style={{ animationDelay: `${i*0.1}s` }} />)}</div>}
            {searchDone && filtered.length > 0 && (
              <div className="fadeUp" style={{ marginTop: 24 }}>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 15, color: "#F1F5F9" }}>{filtered.length} Providers Found</div>
                  <div style={{ color: "#475569", fontSize: 11, marginTop: 2 }}>Near {location}</div>
                  <button onClick={() => setShowQuoteModal(true)}
                    style={{ marginTop: 10, width: "100%", background: "rgba(99,102,241,0.12)", border: "1.5px solid rgba(99,102,241,0.3)", borderRadius: 10, padding: "10px 14px", color: "#A5B4FC", fontSize: 12, fontWeight: 700, fontFamily: "'Syne',sans-serif", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                    <Icon name="send" size={13} color="#A5B4FC" strokeWidth={2} />
                    Get quotes from top 3 AI-matched pros
                  </button>
                </div>
                {/* Sort / filter chips */}
                <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, marginBottom: 14, scrollbarWidth: "none" }}>
                  {[
                    { id: "best",      label: "Best match"     },
                    { id: "available", label: "🟢 Available today" },
                    { id: "rating",    label: "⭐ Top rated"   },
                    { id: "speed",     label: "⚡ Fastest"     },
                    { id: "reviews",   label: "Most reviewed"  },
                  ].map(({ id, label }) => (
                    <button key={id} onClick={() => setSortBy(id)}
                      style={{
                        flexShrink: 0,
                        padding: "6px 13px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                        fontFamily: "'DM Sans',sans-serif", cursor: "pointer", transition: "all 0.15s",
                        background: sortBy === id ? "rgba(14,165,233,0.2)"  : "rgba(255,255,255,0.05)",
                        border:     sortBy === id ? "1.5px solid #0EA5E9"   : "1px solid rgba(255,255,255,0.1)",
                        color:      sortBy === id ? "#38BDF8"               : "#64748B",
                      }}>
                      {label}
                    </button>
                  ))}
                </div>

                {/* ── DEALS BOARD ── */}
                {deals.length > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 13, color: "#F59E0B" }}>🏷️ Deals this week</div>
                      <div style={{ flex: 1, height: 1, background: "rgba(245,158,11,0.2)" }} />
                    </div>
                    <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4, scrollbarWidth: "none" }}>
                      {deals.map(deal => (
                        <div key={deal.id} style={{ flexShrink: 0, width: 220, background: "linear-gradient(135deg,rgba(245,158,11,0.1),rgba(245,158,11,0.05))", border: "1.5px solid rgba(245,158,11,0.3)", borderRadius: 14, padding: 14 }}>
                          <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 18, color: "#F59E0B", marginBottom: 4 }}>{deal.headline}</div>
                          <div style={{ fontSize: 11, color: "#94A3B8", lineHeight: 1.5, marginBottom: 8 }}>{deal.description}</div>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <div style={{ fontSize: 11, color: "#64748B" }}>{deal.providerName}</div>
                            {deal.slotsLeft > 0 && <div style={{ fontSize: 10, fontWeight: 700, color: "#EF4444", background: "rgba(239,68,68,0.12)", borderRadius: 6, padding: "2px 7px" }}>{deal.slotsLeft} slots left</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── FRESH PICKS — New providers ── */}
                {freshPicks.length > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 13, color: "#34D399" }}>✨ New to FixIt Now</div>
                      <div style={{ flex: 1, height: 1, background: "rgba(16,185,129,0.2)" }} />
                    </div>
                    <div style={{ background: "rgba(16,185,129,0.05)", border: "1px solid rgba(16,185,129,0.15)", borderRadius: 14, padding: "12px 14px", marginBottom: 8 }}>
                      <div style={{ fontSize: 12, color: "#475569", lineHeight: 1.6, marginBottom: 10 }}>
                        These providers are new to the platform. Give them a shot — your review could be their first.
                      </div>
                      {freshPicks.slice(0, 3).map((p, i) => (
                        <div key={i} className="fadeUp" style={{ animationDelay: `${i*0.05}s` }}>
                          <ProviderCard provider={p} searchArea={location} searchQuery={`${SERVICES.find(s=>s.id===selectedService)?.label || ""} near ${location}`} user={user} onBooked={(job) => { loadMyJobs(); setJobsBadge(b => b+1); }} />
                        </div>
                      ))}
                    </div>
                    <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", marginBottom: 14 }} />
                  </div>
                )}

                {/* ── MAIN RESULTS ── */}
                {filtered.filter(p => !freshPicks.find(fp => fp.providerId === p.providerId)).map((p,i) => (
                  <div key={i} className="fadeUp" style={{ animationDelay: `${i*0.05}s` }}>
                    {/* Booked out badge */}
                    {!p._available && (
                      <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: "12px 12px 0 0", padding: "6px 14px", marginBottom: -1, display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#EF4444" }} />
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#FCA5A5" }}>
                          {p.avail?.slotsLeft === 0 ? "Fully booked this week — enquire anyway" : "Limited availability this week"}
                        </span>
                      </div>
                    )}
                    <ProviderCard provider={p} searchArea={location} searchQuery={`${SERVICES.find(s=>s.id===selectedService)?.label || ""} near ${location}`} user={user} onBooked={(job) => { loadMyJobs(); setJobsBadge(b => b+1); }} />
                  </div>
                ))}
              </div>
            )}
            {searchDone && filtered.length === 0 && (
              <div style={{ textAlign: "center", marginTop: 40, color: "#475569" }}>
                <div style={{ marginBottom: 10 }}><Icon name="search" size={36} color="#475569" strokeWidth={1.4} /></div>
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, color: "#64748B", fontSize: 15 }}>No providers found nearby</div>
                <div style={{ fontSize: 12, marginTop: 8, lineHeight: 1.7, color: "#334155", maxWidth: 260, margin: "8px auto 0" }}>
                  No registered {SERVICES.find(s=>s.id===selectedService)?.label?.toLowerCase() || "service"} providers in {location} yet.
                  Try removing the emergency filter, or use the quote request above to reach providers directly.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "profile" && (
        <div style={{ padding: "44px 20px 100px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Logo size={28} />
              <Wordmark size={16} />
            </div>
            <button onClick={() => setTab("find")} style={{ background: "none", border: "none", color: "#64748B", fontSize: 13, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>← Back</button>
          </div>

          {/* Avatar + name */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 28 }}>
            <div style={{ width: 64, height: 64, borderRadius: "50%", background: "linear-gradient(135deg,#0EA5E9,#6366F1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, fontWeight: 700, color: "white", fontFamily: "'Syne',sans-serif", marginBottom: 12 }}>
              {user.name?.charAt(0).toUpperCase()}
            </div>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 18, color: "#F1F5F9" }}>{user.name}</div>
            <div style={{ color: "#475569", fontSize: 13 }}>{user.email}</div>
            {user.refCode && (
              <div style={{ marginTop: 6, fontSize: 11, color: "#64748B" }}>
                Ref code: <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, color: "#A5B4FC", letterSpacing: "0.1em" }}>{user.refCode}</span>
              </div>
            )}
          </div>

          {/* Referral & Credits */}
          <CreditWallet user={user} />

          {/* Home address */}
          <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: 18, marginBottom: 14 }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 14, color: "#F1F5F9", marginBottom: 14, display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name="home" size={14} color="#0EA5E9" strokeWidth={1.8} />Home Address
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {[["Street", user.address],["Suburb", user.suburb],["City", user.city],["Province", user.province],["Phone", user.phone]].map(([k,v]) => v && (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                  <span style={{ color: "#475569" }}>{k}</span>
                  <span style={{ color: "#94A3B8", textAlign: "right", maxWidth: 200 }}>{v}</span>
                </div>
              ))}
            </div>
          </div>
          <Btn full variant="ghost" onClick={onLogout} style={{ marginTop: 8 }}>Sign Out</Btn>
        </div>
      )}

      {tab === "jobs" && (
        <div style={{ padding: "44px 18px 100px" }} className="fadeUp">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Logo size={28} />
              <Wordmark size={16} />
            </div>
            <button onClick={() => setTab("find")} style={{ background: "none", border: "none", color: "#64748B", fontSize: 13, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>← Back</button>
          </div>

          <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 20, color: "#F1F5F9", marginBottom: 4 }}>My Jobs</div>
          <div style={{ fontSize: 12, color: "#475569", marginBottom: 20 }}>Track your job requests and saved discounts.</div>

          {/* Discount wallet */}
          <DiscountWallet customerId={user.email} />

          {myJobs.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 0" }}>
              <div style={{ marginBottom: 16 }}><Icon name="jobs" size={44} color="#334155" strokeWidth={1.4} /></div>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 15, color: "#64748B", marginBottom: 8 }}>No jobs yet</div>
              <div style={{ fontSize: 12, color: "#334155", maxWidth: 240, margin: "0 auto", lineHeight: 1.7 }}>Browse providers and tap "Request a Job" to book your first service.</div>
              <Btn onClick={() => setTab("find")} style={{ marginTop: 20 }}>Find Providers →</Btn>
            </div>
          ) : myJobs.map((job, i) => {
            const st = JOB_STATUS[job.status] || JOB_STATUS.pending;
            const svc = SERVICES.find(s => s.id === job.serviceType);
            return (
              <div key={job.id} className="fadeUp" style={{ animationDelay: `${i*0.04}s`, background: "rgba(255,255,255,0.04)", border: `1px solid ${st.color}30`, borderRadius: 14, padding: 16, marginBottom: 10 }}>
                {/* Header row */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <div style={{ width: 38, height: 38, borderRadius: 10, background: `${svc?.color || "#0EA5E9"}18`, border: `1.5px solid ${svc?.color || "#0EA5E9"}33`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <ServiceIcon serviceId={job.serviceType || "handyman"} size={18} color={svc?.color || "#0EA5E9"} />
                    </div>
                    <div>
                      <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 14, color: "#F1F5F9" }}>{job.providerName}</div>
                      <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>{job.serviceName} · {job.dateLabel} {job.timeLabel}</div>
                    </div>
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 20, padding: "3px 10px", background: `${st.color}20`, border: `1px solid ${st.color}44`, color: st.color, flexShrink: 0, marginLeft: 8 }}>{st.label}</span>
                </div>

                {/* Status progress bar */}
                <div style={{ display: "flex", gap: 3, marginBottom: 10 }}>
                  {JOB_PROGRESS_STEPS.map((s, idx) => {
                    const currentIdx = JOB_PROGRESS_STEPS.indexOf(job.status);
                    const filled = job.status === "declined" ? false : idx <= currentIdx;
                    const isCurrent = idx === currentIdx && job.status !== "declined";
                    return (
                      <div key={s} style={{ flex: 1, height: 3, borderRadius: 3, background: filled ? JOB_STATUS[s]?.color : "rgba(255,255,255,0.08)", opacity: isCurrent ? 1 : filled ? 0.7 : 1, transition: "background 0.3s" }} />
                    );
                  })}
                </div>
                <div style={{ fontSize: 11, color: st.color, marginBottom: 10 }}>{st.desc}{job.statusNote ? ` — "${job.statusNote}"` : ""}</div>

                {/* Job details */}
                <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 9, padding: "10px 12px", marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: "#94A3B8", lineHeight: 1.6 }}>{job.description}</div>
                  <div style={{ fontSize: 11, color: "#475569", marginTop: 6 }}><Icon name="pin" size={11} color="#475569" strokeWidth={1.8} /> {job.address}</div>
                  <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}><Icon name="calendar" size={11} color="#475569" strokeWidth={1.8} /> {job.preferredDate} at {job.preferredTime}{job.isEmergency ? " · Emergency" : ""}</div>
                  {job.discountApplied > 0 && job.estimatedValue ? (
                    <div style={{ fontSize: 11, color: "#34D399", marginTop: 4, fontWeight: 600 }}>
                      {job.discountApplied}% loyalty discount applied · You pay R{parseFloat(job.discountedValue || job.estimatedValue).toLocaleString("en-ZA",{maximumFractionDigits:0})}
                      <span style={{ color: "#475569", fontWeight: 400 }}> (was R{parseFloat(job.estimatedValue).toLocaleString()})</span>
                    </div>
                  ) : job.estimatedValue ? (
                    <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>Est. R{parseFloat(job.estimatedValue).toLocaleString()} · Platform fee R{job.platformFee}</div>
                  ) : null}
                </div>

                {/* Actions */}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {/* In-app chat */}
                  {job.providerId && (
                    <button onClick={() => setChatJob(job)}
                      style={{ flex: 1, minWidth: 70, background: "rgba(99,102,241,0.15)", color: "#A5B4FC", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 8, padding: "8px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
                      <Icon name="message" size={11} color="#A5B4FC" strokeWidth={2} />Chat
                    </button>
                  )}
                  {/* GPS tracking — show when provider is on route OR in progress */}
                  {(job.status === "onroute" || job.status === "inprogress") && job.providerId && (
                    <button onClick={() => setGpsJob(job)}
                      style={{ flex: 1, minWidth: 70, background: job.status === "onroute" ? "rgba(139,92,246,0.15)" : "rgba(16,185,129,0.12)", color: job.status === "onroute" ? "#C4B5FD" : "#34D399", border: `1px solid ${job.status === "onroute" ? "rgba(139,92,246,0.3)" : "rgba(16,185,129,0.3)"}`, borderRadius: 8, padding: "8px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
                      <Icon name="location" size={11} color={job.status === "onroute" ? "#C4B5FD" : "#34D399"} strokeWidth={2} />{job.status === "onroute" ? "Track (On the way)" : "Track"}
                    </button>
                  )}
                  {job.status === "completed" && !job.reviewed && (
                    <button onClick={() => setReviewJob(job)}
                      style={{ flex: 1, minWidth: 70, background: "rgba(245,158,11,0.15)", color: "#F59E0B", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 8, padding: "8px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
                      Rate
                    </button>
                  )}
                  {job.status === "completed" && job.reviewed && (
                    <div style={{ fontSize: 11, color: "#10B981", padding: "8px 10px" }}>✓ Reviewed</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Notifications panel */}
      {showNotifs && <NotificationsPanel userId={user.email} onClose={() => setShowNotifs(false)} />}

      {chatJob && <ChatModal job={chatJob} user={user} userRole="customer" onClose={() => setChatJob(null)} />}
      {gpsJob  && <GPSTrackerModal job={gpsJob} onClose={() => setGpsJob(null)} />}
      {showQuoteModal && <QuoteRequestModal user={user} onClose={() => setShowQuoteModal(false)} onDone={() => { setShowQuoteModal(false); loadMyJobs(); setTab("jobs"); }} />}

      {completionNotif && (
        <CompletionPopup
          notification={completionNotif}
          user={user}
          onClose={() => { setCompletionNotif(null); loadMyJobs(); }}
        />
      )}

      {/* Review modal */}
      {reviewJob && (
        <ReviewModal
          job={reviewJob}
          user={user}
          onClose={() => setReviewJob(null)}
          onDone={() => { setReviewJob(null); loadMyJobs(); }}
        />
      )}

      {/* Bottom nav */}
      <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 500, background: "rgba(6,10,20,0.95)", borderTop: "1px solid rgba(255,255,255,0.07)", display: "flex", backdropFilter: "blur(20px)" }}>
        {[["find","search","Find Pros"],["jobs","jobs","My Jobs"],["profile","profile","Profile"]].map(([id,iconName,label]) => (
          <button key={id} onClick={() => setTab(id)} style={{ flex: 1, padding: "13px 0 17px", background: "none", border: "none", color: tab === id ? "#0EA5E9" : "#475569", fontSize: 10, fontWeight: 600, fontFamily: "'DM Sans',sans-serif", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, letterSpacing: "0.06em", transition: "color 0.2s", position: "relative" }}>
            <Icon name={iconName} size={19} color={tab === id ? "#0EA5E9" : "#475569"} strokeWidth={1.6} />
            {label.toUpperCase()}
            {id === "jobs" && jobsBadge > 0 && (
              <div style={{ position: "absolute", top: 10, right: "calc(50% - 14px)", width: 16, height: 16, borderRadius: "50%", background: "#EF4444", fontSize: 9, fontWeight: 800, color: "white", display: "flex", alignItems: "center", justifyContent: "center" }}>{jobsBadge}</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── ADMIN DASHBOARD ─────────────────────────────────────────────────────────────
function AdminDashboard({ onLogout }) {
  const [tab, setTab]         = useState("jobs");
  const [providers, setProviders] = useState([]);
  const [events, setEvents]   = useState([]);

  const [allJobs, setAllJobs]     = useState([]);
  const [allReviews, setAllReviews] = useState([]);

  useEffect(() => { loadAll(); }, []);
  const loadAll = async () => {
    const raw = await store.get("providers");
    setProviders(raw ? JSON.parse(raw.value) : []);
    const evRaw = await store.get("events");
    setEvents(evRaw ? JSON.parse(evRaw.value) : []);
    const jRaw = await store.get("jobs");
    setAllJobs(jRaw ? JSON.parse(jRaw.value) : []);
    const rRaw = await store.get("reviews");
    setAllReviews(rRaw ? JSON.parse(rRaw.value) : []);
  };

  const updateStatus = async (id, status) => {
    const updated = providers.map(p => p.id === id ? { ...p, status } : p);
    await store.set("providers", updated);
    setProviders(updated);
  };

  const totalRevenue   = providers.filter(p=>p.status==="approved").reduce((s,p) => s + (PLANS.find(pl=>pl.id===p.plan)?.price||0), 0);
  const pending        = providers.filter(p=>p.status==="pending");
  const approved       = providers.filter(p=>p.status==="approved");

  // Real event totals from global log
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const monthEvents   = events.filter(e => e.ts >= monthStart);
  const totalCalls    = events.filter(e => e.type === "call").length;
  const totalWA       = events.filter(e => e.type === "whatsapp").length;
  const totalViews    = events.filter(e => e.type === "view").length;
  const totalReferrals = totalCalls + totalWA;
  const totalBookings = events.filter(e => e.type === "booking").length;
  const totalReviews  = allReviews.length;
  const avgPlatformRating = allReviews.length > 0
    ? (allReviews.reduce((s, r) => s + r.rating, 0) / allReviews.length).toFixed(1)
    : "—";

  // Real booking commission: 8% of declared job values for completed jobs this month
  const bookingCommission = allJobs
    .filter(j => j.status === "completed" && j.estimatedValue && j.createdAt >= monthStart)
    .reduce((sum, j) => sum + (parseFloat(j.estimatedValue) * PLATFORM_FEE_PCT), 0);

  // Referral revenue from per-provider billing
  const referralRevenue = approved.reduce((sum, p) => {
    const rate = p.plan === "premium" ? 10 : p.plan === "featured" ? 15 : 0;
    const leads = (p.leads || []).filter(l => l.ts >= monthStart && ["call","whatsapp"].includes(l.type));
    return sum + (leads.length * rate);
  }, 0);

  const StatCard = ({ iconName, label, value, sub, color="#0EA5E9" }) => (
    <div style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${color}22`, borderRadius: 14, padding: 16, flex: 1, minWidth: 130 }}>
      <div style={{ marginBottom: 8 }}><Icon name={iconName} size={18} color={color} strokeWidth={1.6} /></div>
      <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 22, color: "#F1F5F9" }}>{value}</div>
      <div style={{ color, fontSize: 11, fontWeight: 600, marginTop: 2 }}>{label}</div>
      {sub && <div style={{ color: "#475569", fontSize: 10, marginTop: 3 }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#060A14", padding: "0 16px 80px", maxWidth: 600, margin: "0 auto" }}>
      <div style={{ paddingTop: 44, paddingBottom: 24, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo size={36} />
          <div>
            <Wordmark size={18} />
            <div style={{ fontSize: 10, color: "#F59E0B", fontWeight: 700, letterSpacing: "0.08em", marginTop: 2 }}>ADMIN PORTAL</div>
          </div>
        </div>
        <Btn variant="ghost" small onClick={onLogout}>Sign Out</Btn>
      </div>

      <div style={{ display: "flex", background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: 4, marginBottom: 22, gap: 4 }}>
        {[
          ["dashboard", "Dashboard"],
          ["providers", "Providers"],
          ["pending",  "Pending" + (pending.length ? ` (${pending.length})` : "")],
          ["reviews",  "Reviews"],
        ].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{ flex: 1, padding: "11px 4px", borderRadius: 8, border: "none", background: tab===id ? "rgba(255,255,255,0.08)" : "transparent", color: tab===id ? "#F1F5F9" : "#475569", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", transition: "all 0.2s" }}>{label}</button>
        ))}
      </div>

      {tab === "dashboard" && (
        <div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
            <StatCard iconName="chart"   label="Subscription revenue" value={`R${totalRevenue.toLocaleString()}`} sub="Active subscriptions" color="#10B981" />
            <StatCard iconName="send"    label="Referral revenue" value={`R${referralRevenue.toLocaleString()}`} sub="This month, per-lead billing" color="#F59E0B" />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
            <StatCard iconName="booking" label="Booking commission" value={`R${Math.round(bookingCommission).toLocaleString()}`} sub="8% of completed job values" color="#8B5CF6" />
            <StatCard iconName="star"    label="Platform rating" value={avgPlatformRating} sub={`${totalReviews} reviews submitted`} color="#F59E0B" />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 24 }}>
            <StatCard iconName="home"    label="Active providers" value={approved.length} sub={`${pending.length} pending`} color="#0EA5E9" />
            <StatCard iconName="strike"  label="Auto-suspended" value={providers.filter(p=>p.autoSuspendedAt).length} sub="3-strike violations" color="#EF4444" />
          </div>

          {/* Real event breakdown */}
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 16, marginBottom: 16 }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 14, color: "#F1F5F9", marginBottom: 14 }}>Platform events — all time</div>
            {[
              { label: "WhatsApp taps", val: totalWA,        color: "#25D366", iconName: "whatsapp"  },
              { label: "Call taps",     val: totalCalls,     color: "#10B981", iconName: "phone"     },
              { label: "Profile views", val: totalViews,     color: "#6366F1", iconName: "search"    },
              { label: "Job bookings",  val: totalBookings,  color: "#F59E0B", iconName: "booking"   },
              { label: "Total leads",   val: totalReferrals, color: "#0EA5E9", iconName: "send"      },
            ].map(({ label, val, color, iconName }) => (
              <div key={label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name={iconName} size={14} color={color} strokeWidth={1.6} />
                  <span style={{ fontSize: 12, color: "#94A3B8" }}>{label}</span>
                </div>
                <span style={{ fontSize: 14, fontWeight: 700, color, fontFamily: "'Syne',sans-serif" }}>{val}</span>
              </div>
            ))}
            {events.length === 0 && (
              <div style={{ fontSize: 11, color: "#334155", textAlign: "center", padding: "16px 0" }}>No events tracked yet. Events appear here as customers interact with provider listings.</div>
            )}
          </div>
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 16, marginBottom: 16 }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 14, color: "#F1F5F9", marginBottom: 14 }}>Revenue by Plan</div>
            {PLANS.map(plan => {
              const count = approved.filter(p=>p.plan===plan.id).length;
              const rev   = count * plan.price;
              const pct   = totalRevenue > 0 ? (rev/totalRevenue*100).toFixed(0) : 0;
              return (
                <div key={plan.id} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                    <span style={{ color: "#94A3B8", fontWeight: 600 }}>{plan.label} <span style={{ color: "#475569" }}>({count} providers)</span></span>
                    <span style={{ color: plan.color, fontWeight: 700 }}>R{rev.toLocaleString()}</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 6, background: "rgba(255,255,255,0.06)" }}>
                    <div style={{ height: "100%", borderRadius: 6, background: plan.color, width: `${pct}%`, transition: "width 0.6s ease" }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === "providers" && (
        <div>
          {/* Suspended providers (auto-suspended by strikes) shown first */}
          {providers.filter(p => p.status === "suspended" && p.autoSuspendedAt).length > 0 && (
            <div style={{ background: "rgba(239,68,68,0.07)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 12, padding: "12px 14px", marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#FCA5A5", marginBottom: 4 }}>
                ⛔ {providers.filter(p => p.status === "suspended" && p.autoSuspendedAt).length} provider{providers.filter(p => p.status === "suspended" && p.autoSuspendedAt).length !== 1 ? "s" : ""} auto-suspended
              </div>
              <div style={{ fontSize: 11, color: "#7F1D1D" }}>Suspended after receiving {MAX_STRIKES} negative reviews. Review and clear strikes to reinstate.</div>
            </div>
          )}

          {approved.concat(providers.filter(p => p.status === "suspended" && p.autoSuspendedAt)).length === 0
            ? <div style={{ textAlign: "center", color: "#475569", marginTop: 40 }}>No providers yet.</div>
            : [...providers.filter(p => p.status === "suspended" && p.autoSuspendedAt), ...approved].map(p => {
              const activeStrikes = (p.strikeLog || []).filter(s => !s.cleared).length;
              const isSuspended   = p.status === "suspended" && p.autoSuspendedAt;
              const borderColor   = isSuspended ? "rgba(239,68,68,0.35)" : activeStrikes > 0 ? "rgba(245,158,11,0.3)" : "rgba(255,255,255,0.08)";
              return (
                <div key={p.id} style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${borderColor}`, borderRadius: 14, padding: 16, marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                    <div>
                      <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 14, color: "#F1F5F9" }}>{p.bizName}</div>
                      <div style={{ color: "#64748B", fontSize: 11 }}>{p.contactName} · {p.city}</div>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      {isSuspended && <Badge color="#EF4444">SUSPENDED</Badge>}
                      {!isSuspended && activeStrikes > 0 && <Badge color="#F59E0B">{activeStrikes} STRIKE{activeStrikes > 1 ? "S" : ""}</Badge>}
                      <Badge color={PLANS.find(pl=>pl.id===p.plan)?.color||"#64748B"}>{p.plan}</Badge>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                    {p.services?.map(s => { const svc = SERVICES.find(sv=>sv.id===s); return svc ? <Badge key={s} color={svc.color}>{svc.label}</Badge> : null; })}
                    {p.emergency && <Badge color="#EF4444">24hr</Badge>}
                  </div>

                  {/* Strike log */}
                  {activeStrikes > 0 && (
                    <div style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.15)", borderRadius: 9, padding: "10px 12px", marginBottom: 10 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#F59E0B", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>Strike history</div>
                      {(p.strikeLog || []).map((s, idx) => !s.cleared && (
                        <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                          <div style={{ width: 18, height: 18, borderRadius: "50%", background: "rgba(245,158,11,0.2)", border: "1px solid rgba(245,158,11,0.4)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, color: "#F59E0B", flexShrink: 0 }}>{idx + 1}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11, color: "#94A3B8" }}>{s.dateLabel} · {"★".repeat(s.rating)}{"☆".repeat(5 - s.rating)} · {s.customerName}</div>
                            {s.comment && <div style={{ fontSize: 10, color: "#475569", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>"{s.comment}"</div>}
                          </div>
                          <button onClick={async () => { await clearStrike(p.id, idx); const raw = await store.get("providers"); setProviders(raw ? JSON.parse(raw.value) : []); }}
                            style={{ fontSize: 10, fontWeight: 700, background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)", color: "#34D399", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", flexShrink: 0 }}>
                            Clear ✓
                          </button>
                        </div>
                      ))}
                      {isSuspended && (
                        <div style={{ fontSize: 11, color: "#F59E0B", marginTop: 4 }}>Clear all strikes to reinstate this provider.</div>
                      )}
                    </div>
                  )}

                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#475569", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 10 }}>
                    <span><Icon name="phone" size={11} color="#475569" strokeWidth={1.8} /> {p.phone}</span>
                    <span>{(p.leads||[]).filter(l=>["call","whatsapp"].includes(l.type)).length} leads</span>
                    {(() => {
                      const tier = getSpeedTier(getResponseSpeed(p.jobs || []));
                      return tier
                        ? <span style={{ color: tier.color }}>{tier.icon} {tier.short}</span>
                        : <span>R{PLANS.find(pl=>pl.id===p.plan)?.price||0}/mo</span>;
                    })()}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    {isSuspended
                      ? <Btn small variant="green"  onClick={() => updateStatus(p.id, "approved")} style={{ flex: 1 }}>Reinstate</Btn>
                      : <Btn small variant="ghost"  onClick={() => updateStatus(p.id, "suspended")} style={{ flex: 1 }}>Suspend</Btn>}
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {tab === "pending" && (
        <div>
          {pending.length === 0 ? (
            <div style={{ textAlign: "center", color: "#475569", marginTop: 40 }}>
              <div style={{ marginBottom: 12 }}><Icon name="check" size={40} color="#10B981" strokeWidth={1.4} /></div>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, color: "#64748B", fontSize: 15 }}>All clear</div>
              <div style={{ fontSize: 12, marginTop: 6, color: "#334155" }}>No pending applications right now.</div>
            </div>
          ) : pending.map(p => (
            <div key={p.id} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: 14, padding: 16, marginBottom: 12 }}>
              {/* Header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                <div>
                  <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 15, color: "#F1F5F9" }}>{p.bizName}</div>
                  <div style={{ fontSize: 12, color: "#64748B", marginTop: 2 }}>{p.contactName}</div>
                </div>
                <Badge color="#F59E0B">Pending</Badge>
              </div>

              {/* Contact details */}
              <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 9, padding: "10px 12px", marginBottom: 10 }}>
                {[
                  ["Email",    p.email],
                  ["Phone",    p.phone],
                  ["Location", `${p.suburb}, ${p.city}`],
                  ["Reg No.",  p.regNum],
                ].filter(([,v]) => v).map(([k, v]) => (
                  <div key={k} style={{ display: "flex", gap: 10, padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                    <span style={{ fontSize: 11, color: "#475569", minWidth: 64, flexShrink: 0 }}>{k}</span>
                    <span style={{ fontSize: 11, color: "#94A3B8", wordBreak: "break-all" }}>{v}</span>
                  </div>
                ))}
              </div>

              {/* Services + plan */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
                {p.services?.map(s => { const svc = SERVICES.find(sv => sv.id === s); return svc ? <Badge key={s} color={svc.color}>{svc.label}</Badge> : null; })}
                {p.emergency && <Badge color="#EF4444">24hr Emergency</Badge>}
                <Badge color={PLANS.find(pl => pl.id === p.plan)?.color || "#64748B"}>{PLANS.find(pl => pl.id === p.plan)?.label || p.plan}</Badge>
              </div>

              {/* Description */}
              {p.description && (
                <div style={{ fontSize: 12, color: "#64748B", lineHeight: 1.6, background: "rgba(255,255,255,0.02)", borderRadius: 8, padding: "8px 10px", marginBottom: 12 }}>
                  "{p.description}"
                </div>
              )}

              {/* Approve / Reject */}
              <div style={{ display: "flex", gap: 8 }}>
                <Btn small variant="green"  onClick={() => updateStatus(p.id, "approved")} style={{ flex: 1 }}>Approve</Btn>
                <Btn small variant="danger" onClick={() => updateStatus(p.id, "rejected")} style={{ flex: 1 }}>Reject</Btn>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "reviews" && (
        <div>
          {/* Summary strip */}
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <div style={{ flex: 1, background: "rgba(245,158,11,0.07)", border: "1px solid rgba(245,158,11,0.18)", borderRadius: 12, padding: "12px 14px" }}>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 22, color: "#F59E0B" }}>{avgPlatformRating}</div>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#854F0B", letterSpacing: "0.07em", marginTop: 2 }}>AVG PLATFORM RATING</div>
            </div>
            <div style={{ flex: 1, background: "rgba(14,165,233,0.07)", border: "1px solid rgba(14,165,233,0.18)", borderRadius: 12, padding: "12px 14px" }}>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 22, color: "#0EA5E9" }}>{totalReviews}</div>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#185FA5", letterSpacing: "0.07em", marginTop: 2 }}>TOTAL REVIEWS</div>
            </div>
          </div>

          {allReviews.length === 0 ? (
            <div style={{ textAlign: "center", color: "#475569", marginTop: 40 }}>
              <div style={{ marginBottom: 10 }}><Icon name="star" size={36} color="#475569" strokeWidth={1.4} /></div>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, color: "#64748B" }}>No reviews yet</div>
              <div style={{ fontSize: 12, marginTop: 6, color: "#334155" }}>Reviews appear here when customers rate completed jobs.</div>
            </div>
          ) : allReviews.map(r => (
            <div key={r.id} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 13, padding: 14, marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8 }}>
                <div>
                  <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 13, color: "#F1F5F9" }}>{r.providerName}</div>
                  <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>{r.customerName} · {r.dateLabel}</div>
                </div>
                <div style={{ display: "flex", gap: 1 }}>
                  {[1,2,3,4,5].map(i => (
                    <span key={i} style={{ color: i <= r.rating ? "#F59E0B" : "#1E293B", fontSize: 14 }}>★</span>
                  ))}
                </div>
              </div>
              {r.comment && (
                <div style={{ fontSize: 12, color: "#64748B", lineHeight: 1.6, background: "rgba(255,255,255,0.02)", borderRadius: 8, padding: "8px 10px" }}>"{r.comment}"</div>
              )}
              <div style={{ fontSize: 10, color: "#334155", marginTop: 6 }}>
                {SERVICES.find(s=>s.id===r.serviceType)?.icon} {SERVICES.find(s=>s.id===r.serviceType)?.label || r.serviceType}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── PROVIDER STATUS SCREEN ──────────────────────────────────────────────────────
function ProviderStatusScreen({ provider, onLogout }) {
  const isPending  = provider.status === "pending";
  const isRejected = provider.status === "rejected";
  return (
    <div style={{ minHeight: "100vh", background: "#060A14", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 24px", textAlign: "center" }}>
      <Logo size={64} />
      <div style={{ marginTop: 28, marginBottom: 12 }}>
        <Icon name={isPending ? "pending" : "strike"} size={48} color={isPending ? "#F59E0B" : "#EF4444"} strokeWidth={1.2} />
      </div>
      <h2 style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 22, color: "#F1F5F9", marginBottom: 8 }}>
        {isPending ? "Application under review" : "Application not approved"}
      </h2>
      <p style={{ color: "#64748B", fontSize: 13, maxWidth: 300, lineHeight: 1.7, marginBottom: 8 }}>
        {isPending
          ? `We're reviewing your application for ${provider.bizName}. You'll hear from us at ${provider.email} within 24 hours.`
          : `Unfortunately your application for ${provider.bizName} was not approved at this time. Please contact support for more information.`}
      </p>
      {isPending && (
        <div style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 12, padding: "12px 20px", marginBottom: 24, marginTop: 8 }}>
          <div style={{ fontSize: 12, color: "#FCD34D", fontWeight: 600 }}>What happens next?</div>
          <div style={{ fontSize: 11, color: "#78350F", marginTop: 4, lineHeight: 1.6 }}>Our team verifies your business details and services. Once approved you'll have full access to your provider dashboard.</div>
        </div>
      )}
      <Btn variant="ghost" onClick={onLogout} style={{ marginTop: 8 }}>Sign Out</Btn>
    </div>
  );
}

// ─── PROVIDER VERIFICATION SECTION ──────────────────────────────────────────────
function ProviderVerificationSection({ provider, onUpdated }) {
  const [docType, setDocType]     = useState("id");
  const [docNumber, setDocNumber] = useState("");
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const v = provider.verification;

  const submit = async () => {
    if (!docNumber.trim()) return;
    setSaving(true);
    await submitVerification(provider.id, docType, docNumber);
    setSaving(false);
    setSaved(true);
    if (onUpdated) onUpdated({ ...provider, verification: { docType, docNumber, status: "pending", submittedAt: new Date().toISOString() } });
  };

  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 16, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#64748B" }}>ID Verification</div>
        {v && <VerificationBadge verification={v} compact />}
      </div>
      {v?.status === "verified" ? (
        <div style={{ fontSize: 12, color: "#10B981", lineHeight: 1.6 }}>Your identity has been verified. A verified badge appears on your listing.</div>
      ) : v?.status === "pending" ? (
        <div style={{ fontSize: 12, color: "#F59E0B", lineHeight: 1.6 }}>Your documents are under review. We'll notify you within 24 hours.</div>
      ) : (
        <>
          <div style={{ fontSize: 11, color: "#475569", lineHeight: 1.6, marginBottom: 12 }}>Submit your ID or CIPC registration to get a verified badge on your listing. Verified providers get more bookings.</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {[["id","SA ID"],["passport","Passport"],["cipc","CIPC Reg"]].map(([id, label]) => (
              <button key={id} onClick={() => setDocType(id)}
                style={{ flex: 1, padding: "7px 4px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: docType === id ? "rgba(14,165,233,0.15)" : "rgba(255,255,255,0.04)", border: `1.5px solid ${docType === id ? "#0EA5E9" : "rgba(255,255,255,0.08)"}`, color: docType === id ? "#38BDF8" : "#64748B" }}>
                {label}
              </button>
            ))}
          </div>
          <input value={docNumber} onChange={e => setDocNumber(e.target.value)}
            placeholder={docType === "id" ? "SA ID number" : docType === "passport" ? "Passport number" : "CIPC registration number"}
            style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1.5px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "10px 12px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none", marginBottom: 10 }} />
          <Btn small full onClick={submit} disabled={!docNumber.trim() || saving}>
            {saved ? "Submitted ✓" : saving ? "Submitting…" : "Submit for verification"}
          </Btn>
        </>
      )}
    </div>
  );
}

// ─── GPS SHARE TOGGLE (Provider) ─────────────────────────────────────────────────
function GPSShareToggle({ providerId }) {
  const [sharing, setSharing] = useState(false);
  const [watchId, setWatchId] = useState(null);

  const toggleShare = () => {
    if (sharing) {
      if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
      setSharing(false);
      setWatchId(null);
    } else {
      if (!navigator.geolocation) return alert("Geolocation not supported on this device.");
      const id = navigator.geolocation.watchPosition(
        pos => updateProviderLocation(providerId, pos.coords.latitude, pos.coords.longitude),
        () => {},
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
      );
      setWatchId(id);
      setSharing(true);
    }
  };

  return (
    <div style={{ background: sharing ? "rgba(16,185,129,0.07)" : "rgba(255,255,255,0.03)", border: `1px solid ${sharing ? "rgba(16,185,129,0.25)" : "rgba(255,255,255,0.07)"}`, borderRadius: 14, padding: 16, marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: sharing ? "#6EE7B7" : "#64748B", marginBottom: 3 }}>Share live location</div>
        <div style={{ fontSize: 11, color: "#334155", lineHeight: 1.5 }}>Customers can track you when you're on the way. Only active when toggled on.</div>
      </div>
      <div onClick={toggleShare} style={{ width: 42, height: 23, borderRadius: 12, background: sharing ? "#10B981" : "rgba(255,255,255,0.1)", position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0, marginLeft: 12 }}>
        <div style={{ position: "absolute", top: 3, left: sharing ? 22 : 3, width: 17, height: 17, borderRadius: "50%", background: "white", transition: "left 0.2s" }} />
      </div>
    </div>
  );
}

// ─── NOTIF TOGGLES ───────────────────────────────────────────────────────────────
// Extracted into its own component so useState hooks are called at the top level
function NotifToggles() {
  const [newLead,    setNewLead]    = useState(true);
  const [weeklyRep,  setWeeklyRep]  = useState(true);
  const [billing,    setBilling]    = useState(true);
  const [marketing,  setMarketing]  = useState(false);

  const rows = [
    ["New lead received",          newLead,   setNewLead],
    ["Weekly performance report",  weeklyRep, setWeeklyRep],
    ["Billing reminders",          billing,   setBilling],
    ["Marketing updates",          marketing, setMarketing],
  ];

  return (
    <>
      {rows.map(([label, on, setOn]) => (
        <div key={label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
          <span style={{ fontSize: 12, color: "#94A3B8" }}>{label}</span>
          <div onClick={() => setOn(v => !v)} style={{ width: 36, height: 20, borderRadius: 10, background: on ? "#0EA5E9" : "rgba(255,255,255,0.1)", position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0 }}>
            <div style={{ position: "absolute", top: 2, left: on ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: "white", transition: "left 0.2s" }} />
          </div>
        </div>
      ))}
    </>
  );
}

// ─── PROVIDER REVIEWS WIDGET ─────────────────────────────────────────────────────
function ProviderReviews({ providerId }) {
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const raw = await store.get("reviews");
        const all = raw ? JSON.parse(raw.value) : [];
        setReviews(all.filter(r => r.providerId === providerId));
      } catch {}
      setLoading(false);
    };
    load();
  }, [providerId]);

  if (loading) return null;

  const avg = reviews.length > 0
    ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1)
    : null;

  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 16, marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "#475569", letterSpacing: "0.08em", textTransform: "uppercase" }}>Customer reviews</div>
        {avg && (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 15, color: "#F59E0B" }}>{avg}</span>
            <div style={{ display: "flex", gap: 1 }}>
              {[1,2,3,4,5].map(i => <span key={i} style={{ color: i <= Math.round(avg) ? "#F59E0B" : "#1E293B", fontSize: 12 }}>★</span>)}
            </div>
            <span style={{ fontSize: 11, color: "#475569" }}>({reviews.length})</span>
          </div>
        )}
      </div>
      {reviews.length === 0 ? (
        <div style={{ fontSize: 12, color: "#334155", textAlign: "center", padding: "16px 0" }}>No reviews yet — complete your first job to earn one.</div>
      ) : reviews.slice(0, 5).map(r => (
        <div key={r.id} style={{ padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#E2E8F0" }}>{r.customerName}</span>
            <div style={{ display: "flex", gap: 1 }}>
              {[1,2,3,4,5].map(i => <span key={i} style={{ color: i <= r.rating ? "#F59E0B" : "#1E293B", fontSize: 11 }}>★</span>)}
            </div>
          </div>
          {r.comment && <div style={{ fontSize: 11, color: "#64748B", lineHeight: 1.5 }}>"{r.comment}"</div>}
          <div style={{ fontSize: 10, color: "#334155", marginTop: 4 }}>{r.dateLabel}</div>
        </div>
      ))}
    </div>
  );
}

// ─── AVAILABILITY MANAGER ────────────────────────────────────────────────────────
function AvailabilityManager({ providerId }) {
  const [avail, setAvail]       = useState(null);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [selectedDays, setSelectedDays] = useState([]);
  const [slotsLeft, setSlotsLeft] = useState(5);

  useEffect(() => {
    getAvailability(providerId).then(a => {
      if (a) { setAvail(a); setSelectedDays(a.days || []); setSlotsLeft(a.slotsLeft ?? 5); }
    });
  }, [providerId]);

  const toggleDay = (d) => setSelectedDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);

  const save = async () => {
    setSaving(true);
    await saveAvailability(providerId, selectedDays, slotsLeft);
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const today = DAY_NAMES[new Date().getDay()];

  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 16, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#F1F5F9" }}>Weekly availability</div>
          <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>Customers see when you're free. Full weeks sort you higher.</div>
        </div>
        {avail && isAvailableToday(avail)
          ? <div style={{ fontSize: 10, fontWeight: 700, color: "#10B981", background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.25)", borderRadius: 20, padding: "3px 10px" }}>Open today</div>
          : <div style={{ fontSize: 10, fontWeight: 700, color: "#EF4444", background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 20, padding: "3px 10px" }}>Unavailable today</div>
        }
      </div>

      {/* Day picker */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {DAY_NAMES.map(d => {
          const isToday   = d === today;
          const selected  = selectedDays.includes(d);
          return (
            <button key={d} onClick={() => toggleDay(d)}
              style={{ flex: 1, padding: "8px 0", borderRadius: 9, fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", transition: "all 0.15s",
                background: selected ? "rgba(14,165,233,0.2)" : "rgba(255,255,255,0.04)",
                border: `1.5px solid ${selected ? "#0EA5E9" : isToday ? "rgba(245,158,11,0.4)" : "rgba(255,255,255,0.08)"}`,
                color: selected ? "#38BDF8" : isToday ? "#F59E0B" : "#475569" }}>
              {d}
            </button>
          );
        })}
      </div>

      {/* Slots left */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: "#64748B" }}>Job slots available this week</span>
          <span style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 16, color: slotsLeft === 0 ? "#EF4444" : "#10B981" }}>{slotsLeft}</span>
        </div>
        <input type="range" min={0} max={10} value={slotsLeft} onChange={e => setSlotsLeft(Number(e.target.value))}
          style={{ width: "100%", accentColor: slotsLeft === 0 ? "#EF4444" : "#0EA5E9" }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#334155", marginTop: 2 }}>
          <span>Fully booked</span><span>10 slots open</span>
        </div>
      </div>

      <Btn small full onClick={save} disabled={saving}>
        {saved ? "✓ Saved!" : saving ? "Saving…" : "Save availability"}
      </Btn>
    </div>
  );
}

// ─── DEALS MANAGER ───────────────────────────────────────────────────────────────
function DealsManager({ provider }) {
  const [currentDeal, setCurrentDeal] = useState(null);
  const [form, setForm]     = useState({ headline: "", description: "", serviceId: provider.services?.[0] || "", slotsLeft: 3 });
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => {
    getDeals().then(all => {
      const mine = all.find(d => d.providerId === provider.id);
      if (mine) { setCurrentDeal(mine); }
    });
  }, [provider.id]);

  const save = async () => {
    if (!form.headline.trim() || !form.description.trim()) return;
    setSaving(true);
    const deal = {
      ...form,
      providerId:   provider.id,
      providerName: provider.bizName,
      expiresAt:    new Date(Date.now() + 7 * 86400000).toISOString(), // 7 days
    };
    await saveDeal(provider.id, deal);
    setCurrentDeal(deal);
    setAdding(false);
    setSaving(false);
  };

  const remove = async () => {
    await deleteDeal(provider.id);
    setCurrentDeal(null);
  };

  return (
    <div style={{ background: "rgba(245,158,11,0.05)", border: "1px solid rgba(245,158,11,0.18)", borderRadius: 14, padding: 16, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#F1F5F9" }}>Weekly deal</div>
          <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>Offer a discount or special to appear in the Deals section of search.</div>
        </div>
        <Icon name="star" size={18} color="#F59E0B" strokeWidth={1.8} />
      </div>

      {currentDeal && !adding ? (
        <div>
          <div style={{ background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: 10, padding: "12px 14px", marginBottom: 10 }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 16, color: "#F59E0B", marginBottom: 4 }}>{currentDeal.headline}</div>
            <div style={{ fontSize: 12, color: "#94A3B8", lineHeight: 1.5, marginBottom: 6 }}>{currentDeal.description}</div>
            <div style={{ fontSize: 10, color: "#64748B" }}>{currentDeal.slotsLeft} slots · Expires {new Date(currentDeal.expiresAt).toLocaleDateString("en-ZA", { day: "numeric", month: "short" })}</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn small onClick={() => { setForm({ headline: currentDeal.headline, description: currentDeal.description, serviceId: currentDeal.serviceId || provider.services?.[0], slotsLeft: currentDeal.slotsLeft }); setAdding(true); }} style={{ flex: 1 }}>Edit deal</Btn>
            <Btn small variant="danger" onClick={remove} style={{ flex: 1 }}>Remove</Btn>
          </div>
        </div>
      ) : adding ? (
        <div>
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 10, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 5 }}>Headline</label>
            <input value={form.headline} onChange={e => set("headline", e.target.value)} placeholder="e.g. 20% off gate repairs this week" maxLength={50}
              style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1.5px solid rgba(255,255,255,0.1)", borderRadius: 9, padding: "9px 11px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 10, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: 5 }}>Details</label>
            <textarea value={form.description} onChange={e => set("description", e.target.value)} placeholder="e.g. Free callout fee + 20% off parts for any gate motor repair booked this week." rows={2}
              style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1.5px solid rgba(255,255,255,0.1)", borderRadius: 9, padding: "9px 11px", color: "#E2E8F0", fontSize: 12, fontFamily: "'DM Sans',sans-serif", outline: "none", resize: "none" }} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase" }}>Available slots</label>
              <span style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 14, color: "#F59E0B" }}>{form.slotsLeft}</span>
            </div>
            <input type="range" min={1} max={10} value={form.slotsLeft} onChange={e => set("slotsLeft", Number(e.target.value))}
              style={{ width: "100%", accentColor: "#F59E0B" }} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn small variant="ghost" onClick={() => setAdding(false)} style={{ flex: 1 }}>Cancel</Btn>
            <Btn small onClick={save} disabled={saving || !form.headline.trim()} style={{ flex: 1, background: "linear-gradient(135deg,#F59E0B,#D97706)", border: "none" }}>
              {saving ? "Posting…" : "Post deal"}
            </Btn>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)}
          style={{ width: "100%", background: "rgba(245,158,11,0.08)", border: "1.5px dashed rgba(245,158,11,0.3)", borderRadius: 10, padding: "12px", fontSize: 12, fontWeight: 600, color: "#F59E0B", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
          + Post a deal for this week
        </button>
      )}
    </div>
  );
}

// ─── PROVIDER DASHBOARD ───────────────────────────────────────────────────────────
function ProviderDashboard({ provider: initialProvider, onLogout }) {
  const [tab, setTab]         = useState("jobs");
  const [provider, setProvider] = useState(initialProvider);
  const [available, setAvailable] = useState(true);
  const [leads, setLeads]     = useState([]);
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState({
    description:    initialProvider.description    || "",
    tagline:        initialProvider.tagline        || "",
    yearsInBusiness: initialProvider.yearsInBusiness || "",
    priceRangeMin:  initialProvider.priceRangeMin  || "",
    certifications: initialProvider.certifications || "",
    logoUrl:        initialProvider.logoUrl        || "",
    insuranceConfirmed:     initialProvider.insuranceConfirmed     || false,
    backgroundCheckConsent: initialProvider.backgroundCheckConsent || false,
    emergency:      initialProvider.emergency      || false,
  });
  const [expandedService, setExpandedService] = useState(null);
  const [showAllAreas, setShowAllAreas]       = useState({});
  const [saving, setSaving]   = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [showNotifs, setShowNotifs] = useState(false);

  // Load real leads from storage
  const loadLeads = async () => {
    try {
      const raw = await store.get("providers");
      const providers = raw ? JSON.parse(raw.value) : [];
      const me = providers.find(p => p.id === provider.id);
      if (me) {
        setLeads(me.leads || []);
        setProvider(prev => ({ ...prev, ...me, role: "provider" }));
      }
    } catch {}
  };

  const [providerJobs, setProviderJobs] = useState([]);
  const [jobsBadge, setJobsBadge] = useState(0);

  const loadProviderJobs = async () => {
    try {
      const raw = await store.get("providers");
      const providers = raw ? JSON.parse(raw.value) : [];
      const me = providers.find(p => p.id === provider.id);
      const jobs = me?.jobs || [];
      setProviderJobs(jobs);
      // Badge = count of new pending jobs
      setJobsBadge(jobs.filter(j => j.status === "pending").length);
    } catch {}
  };

  useEffect(() => { loadLeads(); loadProviderJobs(); }, [provider.id]);
  useEffect(() => {
    if (tab === "dashboard") loadLeads();
    if (tab === "jobs") { loadProviderJobs(); setJobsBadge(0); }
  }, [tab]);

  const [salesJob, setSalesJob] = useState(null);
  const [providerChatJob, setProviderChatJob] = useState(null);

  const handleJobAction = async (jobId, newStatus, note = "") => {
    // Intercept "completed" — show sales moment modal first
    if (newStatus === "completed") {
      const job = providerJobs.find(j => j.id === jobId);
      if (job) { setSalesJob(job); return; }
    }
    await updateJobStatus(jobId, newStatus, note);
    const job = providerJobs.find(j => j.id === jobId);

    // Auto-start GPS when provider taps "On My Way"
    if (newStatus === "onroute" && provider.id) {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          pos => updateProviderLocation(provider.id, pos.coords.latitude, pos.coords.longitude),
          () => {}
        );
        // Start watching position
        if (!window._gpsWatchId) {
          window._gpsWatchId = navigator.geolocation.watchPosition(
            pos => updateProviderLocation(provider.id, pos.coords.latitude, pos.coords.longitude),
            () => {},
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
          );
        }
      }
    }
    // Stop GPS when job is completed or declined
    if (["completed","declined"].includes(newStatus) && window._gpsWatchId) {
      navigator.geolocation?.clearWatch(window._gpsWatchId);
      window._gpsWatchId = null;
    }

    if (job?.customerId) {
      const messages = {
        accepted:   { title: "Job accepted! ✅", body: `${provider.bizName} accepted your ${job.serviceName} request for ${job.preferredDate}.` },
        onroute:    { title: "Provider on the way! 🚗", body: `${provider.bizName} is on their way to you. You can track their location in My Jobs.` },
        inprogress: { title: "Work has started 🔧", body: `${provider.bizName} has started work on your ${job.serviceName} job.` },
        declined:   { title: "Job declined", body: `${provider.bizName} couldn't take your ${job.serviceName} request. Try another provider.` },
        completed:  { title: "Job complete! 🎉", body: `${provider.bizName} has marked your ${job.serviceName} job as complete. Please leave a review.` },
      };
      const msg = messages[newStatus];
      if (msg) await pushNotif(job.customerId, { ...msg, type: newStatus, jobId });
    }
    await loadProviderJobs();
  };

  // Called from SalesMomentModal when provider confirms completion + discount
  const confirmCompletion = async ({ discountPct, customNote, offerDiscount }) => {
    const job = salesJob;
    setSalesJob(null);

    // 1. Mark job complete in storage
    await updateJobStatus(job.id, "completed");

    // 2. Store discount for the customer if offered
    if (offerDiscount && discountPct > 0 && job.customerId) {
      await saveDiscount({
        customerId:   job.customerId,
        providerId:   provider.id,
        providerName: provider.contactName,
        bizName:      provider.bizName,
        discountPct,
        jobId:        job.id,
      });
    }

    // 3. Push a rich completion notification to customer
    if (job.customerId) {
      await pushNotif(job.customerId, {
        title:       "Job complete!",
        body:        customNote || `${provider.bizName} has finished your ${job.serviceName} job.`,
        type:        "completed",
        jobId:       job.id,
        // Embed sales payload so CompletionPopup can read it
        providerId:  provider.id,
        providerName: provider.bizName,
        serviceName: job.serviceName,
        serviceType: job.serviceType,
        discountPct: offerDiscount ? discountPct : 0,
        customNote,
        isSalesNotif: true,
      });
    }

    // 4. Check if this customer was referred — reward the referrer on their first completed job
    if (job.customerId) {
      await processReferralReward(job.customerId, job.customerName);
    }

    await loadProviderJobs();
  };
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const thisMonth  = leads.filter(l => l.ts >= monthStart);
  const views      = thisMonth.filter(l => l.type === "view").length;
  const whatsapps  = thisMonth.filter(l => l.type === "whatsapp").length;
  const calls      = thisMonth.filter(l => l.type === "call").length;
  const totalLeads = whatsapps + calls;

  // Referral billing: Featured = R15/lead, Premium = R10/lead
  const referralRate = provider.plan === "premium" ? 10 : provider.plan === "featured" ? 15 : 0;
  const referralCredits = (provider.plan === "featured" || provider.plan === "premium")
    ? totalLeads * referralRate : 0;

  // Weekly bar chart — last 7 days by day-of-week label
  const days = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const barData = days.map(d => leads.filter(l => l.dayLabel === d).length);
  const barMax  = Math.max(...barData, 1);

  const plan = PLANS.find(p=>p.id===provider.plan) || PLANS[0];

  const saveProfile = async () => {
    setSaving(true);
    const raw = await store.get("providers");
    const providers = raw ? JSON.parse(raw.value) : [];
    const updated = providers.map(p => p.id === provider.id
      ? { ...p, description: editForm.description, tagline: editForm.tagline, yearsInBusiness: editForm.yearsInBusiness, priceRangeMin: editForm.priceRangeMin, certifications: editForm.certifications, logoUrl: editForm.logoUrl, insuranceConfirmed: editForm.insuranceConfirmed, backgroundCheckConsent: editForm.backgroundCheckConsent, emergency: editForm.emergency, serviceAreas: provider.serviceAreas }
      : p
    );
    await store.set("providers", updated);
    setProvider(p => ({ ...p, description: editForm.description, tagline: editForm.tagline, yearsInBusiness: editForm.yearsInBusiness, priceRangeMin: editForm.priceRangeMin, certifications: editForm.certifications, logoUrl: editForm.logoUrl, insuranceConfirmed: editForm.insuranceConfirmed, backgroundCheckConsent: editForm.backgroundCheckConsent, emergency: editForm.emergency }));
    setSaving(false); setSaveMsg("Saved ✓"); setEditMode(false);
    setTimeout(() => setSaveMsg(""), 3000);
  };

  // Area editing helpers (reused from registration)
  const toggleArea = (serviceId, area) => {
    const current = provider.serviceAreas?.[serviceId] || {};
    if (current.allKZN) return;
    const areas = current.areas || [];
    const next = areas.includes(area) ? areas.filter(a=>a!==area) : [...areas, area];
    setProvider(p => ({ ...p, serviceAreas: { ...p.serviceAreas, [serviceId]: { allKZN: false, areas: next } } }));
  };
  const toggleAllKZN = (serviceId) => {
    const isAll = provider.serviceAreas?.[serviceId]?.allKZN;
    setProvider(p => ({ ...p, serviceAreas: { ...p.serviceAreas, [serviceId]: { allKZN: !isAll, areas: [] } } }));
  };

  const initials = provider.bizName?.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase() || "??";
  const planColor = plan.color;

  const SBadge = ({ children, color }) => (
    <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 20, padding: "2px 8px", background: `${color}20`, border: `1px solid ${color}44`, color }}>{children}</span>
  );

  const LeadIcon = ({ type }) => {
    if (type === "whatsapp") return <span style={{ width: 28, height: 28, borderRadius: 8, background: "rgba(37,211,102,0.12)", border: "1px solid rgba(37,211,102,0.25)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon name="whatsapp" size={13} color="#25D366" strokeWidth={1.8} /></span>;
    if (type === "call")     return <span style={{ width: 28, height: 28, borderRadius: 8, background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.25)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon name="phone" size={13} color="#10B981" strokeWidth={1.8} /></span>;
    return                          <span style={{ width: 28, height: 28, borderRadius: 8, background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.25)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon name="search" size={13} color="#6366F1" strokeWidth={1.8} /></span>;
  };

  return (
    <div style={{ minHeight: "100vh", background: "#060A14", maxWidth: 500, margin: "0 auto", fontFamily: "'DM Sans',sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600&family=Space+Grotesk:wght@600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}body{background:#060A14}
        input,textarea{outline:none}input::placeholder,textarea::placeholder{color:#475569}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#1E293B;border-radius:4px}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        .fadeUp{animation:fadeUp 0.3s ease forwards}
      `}</style>

      {/* ── HEADER ── */}
      <div style={{ padding: "44px 18px 0" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Logo size={32} />
            <div>
              <Wordmark size={16} />
              <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.14em", marginTop: 1 }}>PROVIDER PORTAL</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: available ? "#10B981" : "#475569" }} />
            <span style={{ fontSize: 11, color: available ? "#10B981" : "#475569", fontWeight: 600 }}>{available ? "Active" : "Paused"}</span>
            <NotificationBell userId={provider.id} onOpen={() => setShowNotifs(true)} />
          </div>
        </div>

        {/* Business card */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 14, marginBottom: 20 }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, background: "linear-gradient(135deg,#0EA5E9,#6366F1)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 17, color: "white", flexShrink: 0 }}>{initials}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 15, color: "#F1F5F9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{provider.bizName}</div>
            <div style={{ fontSize: 11, color: "#475569", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{provider.email}</div>
            <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
              <SBadge color={planColor}>{plan.label}</SBadge>
              {provider.emergency && <SBadge color="#EF4444">24hr</SBadge>}
              {provider.services?.slice(0,2).map(id => { const s = SERVICES.find(sv=>sv.id===id); return s ? <SBadge key={id} color={s.color}>{s.label}</SBadge> : null; })}
              {(provider.services?.length||0) > 2 && <SBadge color="#64748B">+{provider.services.length-2}</SBadge>}
            </div>
          </div>
        </div>
      </div>

      {/* ── TAB CONTENT ── */}
      <div style={{ padding: "0 18px 100px" }}>

        {/* ── OVERVIEW ── */}
        {tab === "dashboard" && (
          <div className="fadeUp">

            {/* ── STRIKE BANNER ── */}
            {(() => {
              const activeStrikes = (provider.strikeLog || []).filter(s => !s.cleared).length;
              if (!activeStrikes) return null;
              const isSuspended = provider.status === "suspended";
              const remaining   = MAX_STRIKES - activeStrikes;
              const bgColor     = isSuspended ? "rgba(239,68,68,0.12)" : "rgba(245,158,11,0.08)";
              const bdColor     = isSuspended ? "rgba(239,68,68,0.35)" : "rgba(245,158,11,0.35)";
              const iconColor   = isSuspended ? "#EF4444" : "#F59E0B";
              return (
                <div style={{ background: bgColor, border: `1px solid ${bdColor}`, borderRadius: 12, padding: "14px 16px", marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <Icon name="warning" size={16} color={iconColor} strokeWidth={1.8} />
                    <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 14, color: isSuspended ? "#FCA5A5" : "#FCD34D" }}>
                      {isSuspended ? "Account suspended" : `${activeStrikes} of ${MAX_STRIKES} quality strikes`}
                    </div>
                    <div style={{ display: "flex", gap: 5, marginLeft: "auto" }}>
                      {[1,2,3].map(i => (
                        <div key={i} style={{ width: 10, height: 10, borderRadius: "50%", background: i <= activeStrikes ? iconColor : "rgba(255,255,255,0.12)" }} />
                      ))}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: isSuspended ? "#FCA5A5" : "#B45309", lineHeight: 1.6 }}>
                    {isSuspended
                      ? "Your account has been suspended after 3 negative reviews. Contact FixIt Now support to appeal."
                      : `${remaining} more strike${remaining !== 1 ? "s" : ""} will suspend your account. A strike is issued for a 1 or 2 star review.`}
                  </div>
                </div>
              );
            })()}

            {/* ── AVAILABILITY ── top priority, most important toggle */}
            <div onClick={() => setAvailable(a=>!a)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: available ? "rgba(16,185,129,0.09)" : "rgba(239,68,68,0.07)", border: `1.5px solid ${available ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.25)"}`, borderRadius: 14, padding: "14px 16px", marginBottom: 16, cursor: "pointer" }}>
              <div>
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 14, color: available ? "#34D399" : "#FCA5A5" }}>
                  {available ? "🟢 Open for business" : "🔴 Not available"}
                </div>
                <div style={{ fontSize: 11, color: available ? "#065F46" : "#7F1D1D", marginTop: 3 }}>
                  {available ? "You appear in search results — tap to go offline" : "You're hidden from all searches — tap to go online"}
                </div>
              </div>
              <div style={{ width: 46, height: 25, borderRadius: 13, background: available ? "#10B981" : "#EF4444", position: "relative", flexShrink: 0, transition: "background 0.2s" }}>
                <div style={{ position: "absolute", top: 3, left: available ? 24 : 3, width: 19, height: 19, borderRadius: "50%", background: "white", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
              </div>
            </div>

            {/* ── THIS MONTH STATS ── */}
            <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>
              Performance · {new Date().toLocaleDateString("en-ZA", { month: "long", year: "numeric" })}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              {[
                { val: views,                                                label: "Profile views",  color: "#6366F1", icon: "search" },
                { val: totalLeads,                                           label: "New leads",       color: "#10B981", icon: "send"   },
              ].map(({ val, label, color, icon }) => (
                <div key={label} style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${color}22`, borderRadius: 12, padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 28, color: "#F1F5F9" }}>{val}</div>
                    <div style={{ width: 32, height: 32, borderRadius: 9, background: `${color}18`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Icon name={icon} size={15} color={color} strokeWidth={1.8} />
                    </div>
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 600, color, letterSpacing: "0.07em", textTransform: "uppercase" }}>{label}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
              {(() => {
                const completed = providerJobs.filter(j => j.status === "completed").length;
                const pending   = providerJobs.filter(j => j.status === "pending").length;
                const avgMins   = getResponseSpeed(providerJobs);
                const tier      = getSpeedTier(avgMins);
                return [
                  { val: completed, label: "Jobs done",  color: "#10B981" },
                  { val: pending,   label: "Awaiting",   color: "#F59E0B" },
                  { val: avgMins !== null ? formatResponseTime(avgMins) : "—", label: "Avg response", color: tier?.color || "#64748B" },
                ].map(({ val, label, color }) => (
                  <div key={label} style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${color}22`, borderRadius: 12, padding: "11px 10px", textAlign: "center" }}>
                    <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 20, color }}>{val}</div>
                    <div style={{ fontSize: 9, fontWeight: 600, color, letterSpacing: "0.07em", textTransform: "uppercase", marginTop: 3 }}>{label}</div>
                  </div>
                ));
              })()}
            </div>

            {/* ── EARNINGS ESTIMATE ── */}
            {(() => {
              const completedWithValue = providerJobs.filter(j => j.status === "completed" && j.estimatedValue);
              const totalEarned = completedWithValue.reduce((s, j) => s + (parseFloat(j.discountedValue || j.estimatedValue) || 0), 0);
              const commissionPaid = completedWithValue.reduce((s, j) => s + (j.platformFee || 0), 0);
              if (!completedWithValue.length) return null;
              return (
                <div style={{ background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 13, padding: 14, marginBottom: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#10B981", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>Earnings (declared jobs)</div>
                  <div style={{ display: "flex", gap: 16 }}>
                    <div>
                      <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 24, color: "#34D399" }}>R{totalEarned.toLocaleString("en-ZA", {maximumFractionDigits: 0})}</div>
                      <div style={{ fontSize: 10, color: "#065F46" }}>Total job value</div>
                    </div>
                    <div style={{ width: 1, background: "rgba(16,185,129,0.2)" }} />
                    <div>
                      <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 24, color: "#94A3B8" }}>R{commissionPaid.toLocaleString("en-ZA", {maximumFractionDigits: 0})}</div>
                      <div style={{ fontSize: 10, color: "#334155" }}>Platform fees (8%)</div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* ── WEEKLY ACTIVITY CHART ── */}
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 13, padding: 16, marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#475569", letterSpacing: "0.08em", textTransform: "uppercase" }}>Weekly activity</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {[{label:"Calls",val:calls,color:"#10B981"},{label:"WA",val:whatsapps,color:"#25D366"},{label:"Views",val:views,color:"#6366F1"}].map(({ label, val, color }) => (
                    <div key={label} style={{ fontSize: 10, fontWeight: 600, color, background: `${color}18`, borderRadius: 6, padding: "2px 7px" }}>{val} {label}</div>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 60 }}>
                {days.map((d, i) => {
                  const h = barMax > 0 ? Math.round((barData[i] / barMax) * 100) : 0;
                  const isToday = i === new Date().getDay() - 1;
                  return (
                    <div key={d} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, height: "100%" }}>
                      <div style={{ width: "100%", flex: 1, display: "flex", alignItems: "flex-end" }}>
                        <div style={{ width: "100%", background: isToday ? "#0EA5E9" : "rgba(255,255,255,0.1)", borderRadius: "3px 3px 0 0", height: `${Math.max(h, 4)}%`, transition: "height 0.4s ease" }} />
                      </div>
                      <div style={{ fontSize: 9, color: isToday ? "#0EA5E9" : "#334155", fontWeight: isToday ? 700 : 400 }}>{d}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── RECENT ACTIVITY FEED ── (was "Leads" tab) */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Recent activity</div>
              {leads.length === 0 ? (
                <div style={{ textAlign: "center", padding: "28px 0", color: "#334155", background: "rgba(255,255,255,0.02)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.06)" }}>
                  <div style={{ marginBottom: 8 }}><Icon name="search" size={28} color="#334155" strokeWidth={1.4} /></div>
                  <div style={{ fontSize: 12, color: "#475569" }}>No activity yet</div>
                  <div style={{ fontSize: 11, color: "#334155", marginTop: 4 }}>Profile views and customer contacts appear here</div>
                </div>
              ) : leads.slice(0, 8).map((lead, i) => (
                <div key={lead.id || i} className="fadeUp" style={{ animationDelay: `${i * 0.03}s`, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 11, padding: "10px 12px", marginBottom: 6, display: "flex", alignItems: "center", gap: 10 }}>
                  <LeadIcon type={lead.type} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#E2E8F0", textTransform: "capitalize" }}>
                      {lead.type === "whatsapp" ? "WhatsApp contact" : lead.type === "call" ? "Phone call tapped" : "Profile viewed"}
                    </div>
                    {lead.searchArea && <div style={{ fontSize: 10, color: "#475569", marginTop: 1 }}>{lead.searchArea}{lead.searchQuery ? ` · "${lead.searchQuery.slice(0,40)}"` : ""}</div>}
                  </div>
                  <div style={{ fontSize: 10, color: "#334155", flexShrink: 0, textAlign: "right" }}>
                    <div>{lead.timeLabel}</div><div style={{ marginTop: 1 }}>{lead.dateLabel}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* ── PLAN & BILLING ── */}
            <div style={{ background: `${planColor}0A`, border: `1px solid ${planColor}25`, borderRadius: 13, padding: 14, marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div>
                  <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 15, color: "#F1F5F9" }}>{plan.label} Plan</div>
                  <div style={{ fontSize: 11, color: planColor, marginTop: 2 }}>{plan.priceLabel} · Next billing 1 Apr 2026</div>
                </div>
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 20, color: planColor }}>{plan.priceLabel}</div>
              </div>
              {referralCredits > 0 && (
                <div style={{ fontSize: 11, color: "#10B981", marginBottom: 8 }}>
                  Referral credits this month: <strong>R{referralCredits.toLocaleString()}</strong> ({totalLeads} leads × R{referralRate})
                </div>
              )}
              <Btn small variant="ghost" onClick={() => setTab("account")} style={{ fontSize: 11 }}>Manage plan →</Btn>
            </div>

            {/* ── RANKING TIPS ── */}
            <div style={{ background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.18)", borderRadius: 13, padding: 14 }}>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 13, color: "#A5B4FC", marginBottom: 10 }}>
                How your search ranking works
              </div>
              {[
                { label: "Star rating",     weight: "40%", tip: "Higher ratings = top of results", icon: "star" },
                { label: "Response speed",  weight: "25%", tip: "Accept jobs fast to rank higher", icon: "lightning" },
                { label: "Review count",    weight: "15%", tip: "More reviews builds more trust", icon: "message" },
                { label: "Plan tier",       weight: "15%", tip: "Featured & Premium get boosted", icon: "chart" },
                { label: "24hr emergency",  weight: "5%",  tip: "Being on-call adds ranking points", icon: "emergency" },
              ].map(({ label, weight, tip, icon }) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 11, fontWeight: 800, color: "#6366F1", minWidth: 32, flexShrink: 0 }}>{weight}</div>
                  <div style={{ width: 24, height: 24, borderRadius: 7, background: "rgba(99,102,241,0.15)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon name={icon} size={12} color="#8B9CF8" strokeWidth={1.8} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#94A3B8" }}>{label}</div>
                    <div style={{ fontSize: 10, color: "#334155" }}>{tip}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── OLD LEADS TAB — now merged into dashboard ── */}
        {(false) && (
          <div className="fadeUp">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase" }}>All leads</div>
              <div style={{ display: "flex", gap: 6 }}>
                {[
                  { val: whatsapps, label: "WA", color: "#25D366" },
                  { val: calls,     label: "Calls", color: "#10B981" },
                  { val: views,     label: "Views", color: "#6366F1" },
                ].map(({ val, label, color }) => (
                  <div key={label} style={{ background: `${color}15`, border: `1px solid ${color}33`, borderRadius: 8, padding: "3px 8px", display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ fontSize: 12 }}>{label}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color }}>{val}</span>
                  </div>
                ))}
              </div>
            </div>

            {leads.length === 0 ? (
              <div style={{ textAlign: "center", padding: "48px 0", color: "#334155" }}>
                <div style={{ marginBottom: 12 }}><Icon name="message" size={32} color="#334155" strokeWidth={1.4} /></div>
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 14, color: "#475569" }}>No leads yet</div>
                <div style={{ fontSize: 12, marginTop: 6, color: "#334155" }}>When customers view or contact you, leads appear here in real time.</div>
              </div>
            ) : leads.map((lead, i) => (
              <div key={lead.id} className="fadeUp" style={{ animationDelay: `${i * 0.03}s`, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 13, marginBottom: 7, display: "flex", alignItems: "center", gap: 12 }}>
                <LeadIcon type={lead.type} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#E2E8F0", textTransform: "capitalize" }}>
                      {lead.type === "whatsapp" ? "WhatsApp" : lead.type === "call" ? "Call" : "Profile view"}
                    </span>
                    {lead.searchArea && <><span style={{ fontSize: 10, color: "#475569" }}>·</span><span style={{ fontSize: 11, color: "#475569" }}>{lead.searchArea}</span></>}
                  </div>
                  {lead.searchQuery && <div style={{ fontSize: 11, color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>"{lead.searchQuery}"</div>}
                </div>
                <div style={{ fontSize: 10, color: "#334155", flexShrink: 0, textAlign: "right" }}>
                  <div>{lead.timeLabel}</div>
                  <div style={{ marginTop: 1 }}>{lead.dateLabel}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── PROFILE ── */}
        {tab === "profile" && (
          <div className="fadeUp">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase" }}>Your listing</div>
              {!editMode
                ? <Btn small variant="ghost" onClick={() => setEditMode(true)}>Edit</Btn>
                : <div style={{ display: "flex", gap: 8 }}>
                    <Btn small variant="ghost" onClick={() => setEditMode(false)}>Cancel</Btn>
                    <Btn small variant="green" onClick={saveProfile} disabled={saving}>{saving ? "Saving…" : "Save ✓"}</Btn>
                  </div>}
            </div>

            {saveMsg && <div style={{ background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 9, padding: "9px 14px", marginBottom: 12, color: "#6EE7B7", fontSize: 12 }}>{saveMsg}</div>}

            {/* Preview card — how customers see them */}
            <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#334155", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Customer view</div>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: `${SERVICES.find(s=>s.id===provider.services?.[0])?.color || "#0EA5E9"}18`, border: `1.5px solid ${SERVICES.find(s=>s.id===provider.services?.[0])?.color || "#0EA5E9"}33`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>
                  {SERVICES.find(s=>s.id===provider.services?.[0]) && (
                    <ServiceIcon serviceId={provider.services[0]} size={18} color={SERVICES.find(s=>s.id===provider.services[0])?.color || "#0EA5E9"} />
                  )}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 14, color: "#F1F5F9", marginBottom: 4 }}>{provider.bizName}</div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
                    {provider.emergency && <SBadge color="#EF4444">24hr</SBadge>}
                    <SBadge color={planColor}>{plan.label}</SBadge>
                  </div>
                  <div style={{ fontSize: 11, color: "#475569" }}><Icon name="pin" size={11} color="#475569" strokeWidth={1.8} /> {provider.suburb}, {provider.city}</div>
                </div>
              </div>
              {/* Service areas preview */}
              {provider.serviceAreas && Object.entries(provider.serviceAreas).length > 0 && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                  {Object.entries(provider.serviceAreas).map(([id, sa]) => {
                    const s = SERVICES.find(sv=>sv.id===id);
                    if (!s) return null;
                    return (
                      <div key={id} style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 5 }}>
                        <span style={{ fontSize: 11, color: "#475569", minWidth: 72 }}>{s.icon} {s.label}</span>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                          {sa.allKZN ? (
                            <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 20, padding: "2px 8px", background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)", color: "#34D399" }}>All KZN</span>
                          ) : (
                            sa.areas?.slice(0,4).map(a => (
                              <span key={a} style={{ fontSize: 10, fontWeight: 600, borderRadius: 20, padding: "2px 7px", background: `${s.color}15`, border: `1px solid ${s.color}35`, color: s.color }}>{a}</span>
                            ))
                          )}
                          {!sa.allKZN && (sa.areas?.length||0) > 4 && <span style={{ fontSize: 10, color: "#475569" }}>+{sa.areas.length - 4}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Editable fields */}
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 16, marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#475569", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>Tagline</div>
              {editMode ? (
                <input value={editForm.tagline} onChange={e => setEditForm(f=>({...f,tagline:e.target.value}))}
                  placeholder="e.g. KZN's most trusted plumber since 2008"
                  style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1.5px solid rgba(255,255,255,0.1)", borderRadius: 9, padding: "9px 11px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
              ) : (
                <p style={{ fontSize: 13, color: editForm.tagline ? "#94A3B8" : "#334155", fontStyle: editForm.tagline ? "italic" : "normal" }}>
                  {editForm.tagline ? `"${editForm.tagline}"` : "No tagline added yet."}
                </p>
              )}
            </div>

            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 16, marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#475569", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>About your business</div>
              {editMode ? (
                <textarea value={editForm.description} onChange={e => setEditForm(f=>({...f,description:e.target.value}))} rows={4}
                  placeholder="Tell customers what makes you great…"
                  style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1.5px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "10px 12px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", resize: "vertical", outline: "none" }}/>
              ) : (
                <p style={{ fontSize: 13, color: provider.description ? "#94A3B8" : "#334155", lineHeight: 1.6 }}>{provider.description || "No description added yet. Tap Edit to add one."}</p>
              )}
            </div>

            {/* Emergency toggle */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.12)", borderRadius: 12, padding: 14, marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#FCA5A5" }}>24/7 emergency available</div>
                <div style={{ fontSize: 11, color: "#7F1D1D", marginTop: 2 }}>Shows the 24hr badge on your listing</div>
              </div>
              {editMode ? (
                <div onClick={() => setEditForm(f=>({...f,emergency:!f.emergency}))} style={{ width: 42, height: 23, borderRadius: 12, background: editForm.emergency ? "#EF4444" : "rgba(255,255,255,0.1)", position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0 }}>
                  <div style={{ position: "absolute", top: 3, left: editForm.emergency ? 22 : 3, width: 17, height: 17, borderRadius: "50%", background: "white", transition: "left 0.2s" }} />
                </div>
              ) : (
                <SBadge color={provider.emergency ? "#EF4444" : "#475569"}>{provider.emergency ? "On" : "Off"}</SBadge>
              )}
            </div>

            {/* Credentials & brand */}
            <div style={{ background: "rgba(14,165,233,0.04)", border: "1px solid rgba(14,165,233,0.14)", borderRadius: 13, padding: 14, marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#38BDF8", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>Credentials & brand</div>

              {/* Years in business */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: "#475569", marginBottom: 4 }}>Years in business</div>
                {editMode ? (
                  <input type="number" value={editForm.yearsInBusiness} onChange={e => setEditForm(f=>({...f,yearsInBusiness:e.target.value}))} placeholder="e.g. 12"
                    style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1.5px solid rgba(255,255,255,0.1)", borderRadius: 9, padding: "8px 11px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
                ) : (
                  <div style={{ fontSize: 13, color: "#94A3B8" }}>{provider.yearsInBusiness ? `${provider.yearsInBusiness} years` : "Not set"}</div>
                )}
              </div>

              {/* Call-out fee */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: "#475569", marginBottom: 4 }}>Call-out fee from (R)</div>
                {editMode ? (
                  <input type="number" value={editForm.priceRangeMin} onChange={e => setEditForm(f=>({...f,priceRangeMin:e.target.value}))} placeholder="e.g. 350"
                    style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1.5px solid rgba(255,255,255,0.1)", borderRadius: 9, padding: "8px 11px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
                ) : (
                  <div style={{ fontSize: 13, color: "#94A3B8" }}>{provider.priceRangeMin ? `From R${provider.priceRangeMin}` : "Not set"}</div>
                )}
              </div>

              {/* Certifications */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: "#475569", marginBottom: 4 }}>Certifications & licences</div>
                {editMode ? (
                  <input value={editForm.certifications} onChange={e => setEditForm(f=>({...f,certifications:e.target.value}))} placeholder="e.g. ECSA registered, COC certified"
                    style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1.5px solid rgba(255,255,255,0.1)", borderRadius: 9, padding: "8px 11px", color: "#E2E8F0", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
                ) : (
                  <div style={{ fontSize: 13, color: "#94A3B8" }}>{provider.certifications || "Not set"}</div>
                )}
              </div>

              {/* Logo URL */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: "#475569", marginBottom: 4 }}>Logo URL</div>
                {editMode ? (
                  <>
                    <input value={editForm.logoUrl} onChange={e => setEditForm(f=>({...f,logoUrl:e.target.value}))} placeholder="https://imgur.com/your-logo.png"
                      style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1.5px solid rgba(255,255,255,0.1)", borderRadius: 9, padding: "8px 11px", color: "#E2E8F0", fontSize: 12, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
                    <div style={{ fontSize: 10, color: "#334155", marginTop: 3 }}>Free upload at imgur.com — paste the image link here</div>
                  </>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {provider.logoUrl
                      ? <img src={provider.logoUrl} alt="logo" style={{ width: 36, height: 36, borderRadius: 8, objectFit: "cover", border: "1px solid rgba(255,255,255,0.1)" }} />
                      : <div style={{ fontSize: 12, color: "#334155" }}>No logo uploaded</div>
                    }
                  </div>
                )}
              </div>

              {/* Trust declarations */}
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {[
                  ["insuranceConfirmed", "Public liability insurance"],
                  ["backgroundCheckConsent", "Background check consented"],
                ].map(([key, label]) => (
                  <div key={key} style={{ display: "flex", alignItems: "center", gap: 8 }}
                    onClick={() => editMode && setEditForm(f => ({...f, [key]: !f[key]}))}>
                    <div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${(editMode ? editForm[key] : provider[key]) ? "#10B981" : "rgba(255,255,255,0.2)"}`, background: (editMode ? editForm[key] : provider[key]) ? "#10B981" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: editMode ? "pointer" : "default", transition: "all 0.15s" }}>
                      {(editMode ? editForm[key] : provider[key]) && <Icon name="check" size={9} color="white" strokeWidth={2.5} />}
                    </div>
                    <span style={{ fontSize: 11, color: (editMode ? editForm[key] : provider[key]) ? "#6EE7B7" : "#475569", fontFamily: "'DM Sans',sans-serif" }}>{label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Service areas edit */}
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#475569", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>Service areas</div>
              {provider.services?.map(id => {
                const s = SERVICES.find(sv=>sv.id===id);
                if (!s) return null;
                const sa = provider.serviceAreas?.[id] || {};
                const expanded = expandedService === id;
                const showingAll = showAllAreas[id];
                const hints = SERVICE_AREA_HINTS[id] || [];
                const displayAreas = showingAll ? KZN_AREAS : hints;
                return (
                  <div key={id} style={{ marginBottom: 10 }}>
                    <div onClick={() => editMode && setExpandedService(expanded ? null : id)}
                      style={{ display: "flex", alignItems: "center", gap: 8, cursor: editMode ? "pointer" : "default", marginBottom: expanded && editMode ? 8 : 0 }}>
                      <ServiceIcon serviceId={id} size={15} color="#94A3B8" />
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#94A3B8", flex: 1 }}>{s.label}</span>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                        {sa.allKZN ? (
                          <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 20, padding: "2px 8px", background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)", color: "#34D399" }}>All KZN</span>
                        ) : (
                          (sa.areas||[]).slice(0,3).map(a => (
                            <span key={a} style={{ fontSize: 10, fontWeight: 600, borderRadius: 20, padding: "2px 7px", background: `${s.color}15`, border: `1px solid ${s.color}35`, color: s.color }}>{a}</span>
                          ))
                        )}
                        {!sa.allKZN && (sa.areas?.length||0) > 3 && <span style={{ fontSize: 10, color: "#475569" }}>+{sa.areas.length-3}</span>}
                      </div>
                      {editMode && <span style={{ fontSize: 11, color: "#0EA5E9" }}>{expanded ? "▲" : "▼"}</span>}
                    </div>
                    {editMode && expanded && (
                      <div style={{ paddingLeft: 24, marginTop: 8 }}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 }}>
                          <div onClick={() => toggleAllKZN(id)} style={{ fontSize: 11, fontWeight: 700, borderRadius: 20, padding: "4px 10px", cursor: "pointer", background: sa.allKZN ? "rgba(16,185,129,0.25)" : "rgba(16,185,129,0.08)", border: `1.5px solid ${sa.allKZN ? "#10B98188" : "rgba(16,185,129,0.25)"}`, color: sa.allKZN ? "#34D399" : "#10B981" }}>
                            {sa.allKZN ? "✓ " : ""}All KZN
                          </div>
                        </div>
                        {!sa.allKZN && (
                          <>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 }}>
                              {displayAreas.map(area => {
                                const sel = (sa.areas||[]).includes(area);
                                return (
                                  <div key={area} onClick={() => toggleArea(id, area)} style={{ fontSize: 11, fontWeight: 600, borderRadius: 20, padding: "3px 9px", cursor: "pointer", background: sel ? `${s.color}22` : "rgba(255,255,255,0.04)", border: `1px solid ${sel ? s.color+"55" : "rgba(255,255,255,0.1)"}`, color: sel ? s.color : "#64748B" }}>
                                    {sel ? "✓ " : ""}{area}
                                  </div>
                                );
                              })}
                            </div>
                            <button onClick={() => setShowAllAreas(p=>({...p,[id]:!showingAll}))} style={{ background: "none", border: "none", color: "#0EA5E9", fontSize: 11, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "'DM Sans',sans-serif" }}>
                              {showingAll ? "▲ Show less" : `▼ Show all ${KZN_AREAS.length} areas`}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Live reviews from customers */}
            <ProviderReviews providerId={provider.id} />

            {/* Availability & deals — discovery tools */}
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>Availability & deals</div>
              <AvailabilityManager providerId={provider.id} />
              <DealsManager provider={provider} />
            </div>
          </div>
        )}
        {tab === "account" && (
          <div className="fadeUp">
            <div style={{ fontSize: 11, fontWeight: 600, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 14 }}>Account settings</div>

            {/* Contact info */}
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 16, marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#64748B", marginBottom: 10 }}>Contact info</div>
              {[["Business", provider.bizName],["Contact", provider.contactName],["Email", provider.email],["Phone", provider.phone],["Location", `${provider.suburb}, ${provider.city}`]].map(([k,v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 12 }}>
                  <span style={{ color: "#475569" }}>{k}</span>
                  <span style={{ color: "#94A3B8", maxWidth: "55%", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v}</span>
                </div>
              ))}
            </div>

            {/* Plan upgrade */}
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 16, marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#64748B", marginBottom: 12 }}>Subscription plan</div>
              {PLANS.map(p => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: provider.plan === p.id ? "#F1F5F9" : "#64748B" }}>{p.label}</div>
                    <div style={{ fontSize: 11, color: p.color, marginTop: 2 }}>{p.priceLabel}</div>
                  </div>
                  {provider.plan === p.id
                    ? <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 20, padding: "3px 10px", background: `${p.color}20`, border: `1px solid ${p.color}44`, color: p.color }}>Current</span>
                    : <Btn small variant="ghost" style={{ fontSize: 11 }}>Switch</Btn>}
                </div>
              ))}
            </div>

            {/* Notifications */}
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 16, marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#64748B", marginBottom: 12 }}>Notifications</div>
              <NotifToggles />
            </div>

            {/* ID Verification */}
            <ProviderVerificationSection provider={provider} onUpdated={(updated) => setProvider(p => ({ ...p, verification: updated.verification }))} />

            {/* GPS location sharing */}
            <GPSShareToggle providerId={provider.id} />

            <Btn full variant="ghost" onClick={onLogout}>Sign Out</Btn>
          </div>
        )}

        {/* ── JOBS ── */}
        {tab === "jobs" && (
          <div className="fadeUp">
            {/* Jobs header with status summary */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 17, color: "#F1F5F9" }}>Jobs</div>
                <button onClick={loadProviderJobs} style={{ background: "none", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "5px 10px", color: "#64748B", fontSize: 11, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
                  Refresh
                </button>
              </div>
              {/* Status summary chips */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[
                  { status: "pending",    label: "New",        color: "#F59E0B" },
                  { status: "accepted",   label: "Accepted",   color: "#0EA5E9" },
                  { status: "onroute",    label: "On the way", color: "#8B5CF6" },
                  { status: "inprogress", label: "In progress",color: "#06B6D4" },
                  { status: "completed",  label: "Done",       color: "#10B981" },
                ].map(({ status, label, color }) => {
                  const count = providerJobs.filter(j => j.status === status).length;
                  if (!count) return null;
                  return (
                    <div key={status} style={{ display: "flex", alignItems: "center", gap: 5, background: `${color}15`, border: `1px solid ${color}33`, borderRadius: 20, padding: "4px 10px" }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
                      <span style={{ fontSize: 11, fontWeight: 600, color }}>{count} {label}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {providerJobs.length === 0 ? (
              <div style={{ textAlign: "center", padding: "48px 0", color: "#334155" }}>
                <div style={{ marginBottom: 12 }}><Icon name="message" size={32} color="#334155" strokeWidth={1.4} /></div>
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 14, color: "#475569" }}>No job requests yet</div>
                <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>When customers book you through FixIt Now, their requests appear here.</div>
              </div>
            ) : providerJobs.map((job, i) => {
              const st = JOB_STATUS[job.status] || JOB_STATUS.pending;
              const svc = SERVICES.find(s => s.id === job.serviceType);
              return (
                <div key={job.id} className="fadeUp" style={{ animationDelay: `${i*0.04}s`, background: "rgba(255,255,255,0.04)", border: `1px solid ${st.color}30`, borderRadius: 14, padding: 16, marginBottom: 10 }}>
                  {/* Header */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <div style={{ width: 34, height: 34, borderRadius: 9, background: `${svc?.color || "#0EA5E9"}18`, border: `1.5px solid ${svc?.color || "#0EA5E9"}33`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><ServiceIcon serviceId={job.serviceType || "handyman"} size={17} color={svc?.color || "#0EA5E9"} /></div>
                      <div>
                        <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 13, color: "#F1F5F9" }}>{job.customerName}</div>
                        <div style={{ fontSize: 11, color: "#475569" }}>{job.serviceName} · {job.dateLabel} {job.timeLabel}</div>
                      </div>
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 20, padding: "3px 10px", background: `${st.color}20`, border: `1px solid ${st.color}44`, color: st.color }}>{st.label}</span>
                  </div>

                  {/* Details */}
                  <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 9, padding: "10px 12px", marginBottom: 10 }}>
                    <div style={{ fontSize: 12, color: "#94A3B8", lineHeight: 1.6 }}>{job.description}</div>
                    <div style={{ fontSize: 11, color: "#475569", marginTop: 5 }}><Icon name="pin" size={11} color="#475569" strokeWidth={1.8} /> {job.address}</div>
                    <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}><Icon name="calendar" size={11} color="#475569" strokeWidth={1.8} /> {job.preferredDate} at {job.preferredTime}{job.isEmergency ? " · Emergency" : ""}</div>
                    {job.recurring && job.recurring !== "once" && (
                      <div style={{ fontSize: 11, color: "#0EA5E9", marginTop: 2 }}>🔄 {job.recurring === "weekly" ? "Weekly" : "Monthly"} recurring job</div>
                    )}
                    {job.estimatedValue && !job.discountApplied && <div style={{ fontSize: 11, color: "#F59E0B", marginTop: 2 }}>Est. R{parseFloat(job.estimatedValue).toLocaleString()} · Platform fee R{job.platformFee}</div>}
                    {job.customerPhone && <div style={{ fontSize: 11, color: "#475569", marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}><Icon name="phone" size={11} color="#475569" strokeWidth={1.8} /> {job.customerPhone}</div>}
                  </div>

                  {/* Loyalty discount banner — visible to provider */}
                  {job.discountApplied > 0 && (
                    <div style={{ background: "linear-gradient(135deg,rgba(16,185,129,0.12),rgba(16,185,129,0.06))", border: "1.5px solid rgba(16,185,129,0.3)", borderRadius: 10, padding: "10px 12px", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                      <Icon name="star" size={16} color="#10B981" strokeWidth={2} />
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#34D399" }}>Returning client — {job.discountApplied}% loyalty discount</div>
                        <div style={{ fontSize: 10, color: "#065F46", marginTop: 1 }}>
                          {job.estimatedValue ? `Original R${parseFloat(job.estimatedValue).toLocaleString()} → Client pays R${parseFloat(job.discountedValue || job.estimatedValue).toLocaleString("en-ZA",{maximumFractionDigits:0})}` : "Discount applies to final invoice"}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Action buttons based on status */}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {job.status === "pending" && (<>
                      <Btn small variant="green"  onClick={() => handleJobAction(job.id, "accepted")}   style={{ flex: 1 }}>Accept</Btn>
                      <Btn small variant="danger" onClick={() => handleJobAction(job.id, "declined", "Sorry, unavailable at this time")} style={{ flex: 1 }}>Decline</Btn>
                    </>)}
                    {job.status === "accepted" && (
                      <Btn small onClick={() => handleJobAction(job.id, "onroute")} style={{ flex: 1, background: "linear-gradient(135deg,#8B5CF6,#6366F1)", color: "white", border: "none" }}>
                        🚗 On My Way
                      </Btn>
                    )}
                    {job.status === "onroute" && (
                      <Btn small onClick={() => handleJobAction(job.id, "inprogress")} style={{ flex: 1, background: "linear-gradient(135deg,#06B6D4,#0EA5E9)", color: "white", border: "none" }}>
                        🔧 Start Work
                      </Btn>
                    )}
                    {job.status === "inprogress" && (
                      <Btn small variant="green" onClick={() => handleJobAction(job.id, "completed")} style={{ flex: 1 }}>Mark Complete</Btn>
                    )}
                    {/* In-app chat */}
                    <button onClick={() => setProviderChatJob(job)}
                      style={{ flex: 1, minWidth: 70, background: "rgba(99,102,241,0.15)", color: "#A5B4FC", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 8, padding: "8px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
                      <Icon name="message" size={11} color="#A5B4FC" strokeWidth={2} />Chat
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

      </div>

      {showNotifs && <NotificationsPanel userId={provider.id} onClose={() => setShowNotifs(false)} />}

      {providerChatJob && (
        <ChatModal
          job={providerChatJob}
          user={{ email: provider.id, name: provider.bizName, ...provider }}
          userRole="provider"
          onClose={() => setProviderChatJob(null)}
        />
      )}

      {salesJob && (
        <SalesMomentModal
          job={salesJob}
          provider={provider}
          onCancel={() => setSalesJob(null)}
          onConfirm={confirmCompletion}
        />
      )}

      {/* ── BOTTOM NAV ── */}
      <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 500, background: "rgba(6,10,20,0.97)", borderTop: "1px solid rgba(255,255,255,0.07)", display: "flex", backdropFilter: "blur(20px)" }}>
        {[["jobs","jobs","Jobs"],["dashboard","overview","Dashboard"],["profile","profile","My Profile"],["account","settings","Account"]].map(([id,iconName,label]) => (
          <button key={id} onClick={() => setTab(id)} style={{ flex: 1, padding: "13px 0 17px", background: "none", border: "none", color: tab === id ? "#0EA5E9" : "#475569", fontSize: 10, fontWeight: 600, fontFamily: "'DM Sans',sans-serif", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, letterSpacing: "0.06em", transition: "color 0.2s", position: "relative" }}>
            <Icon name={iconName} size={18} color={tab === id ? "#0EA5E9" : "#475569"} strokeWidth={1.6} />
            {label.toUpperCase()}
            {id === "jobs" && jobsBadge > 0 && (
              <div style={{ position: "absolute", top: 10, right: "calc(50% - 14px)", width: 15, height: 15, borderRadius: "50%", background: "#EF4444", fontSize: 8, fontWeight: 800, color: "white", display: "flex", alignItems: "center", justifyContent: "center" }}>{jobsBadge}</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── ROOT ────────────────────────────────────────────────────────────────────────
// Register service worker — only in real deployments, not inside Claude or localhost
if (typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    !window.location.hostname.includes("claudeusercontent.com") &&
    !window.location.hostname.includes("localhost") &&
    !window.location.hostname.includes("stackblitz") &&
    !window.location.hostname.includes("csb.app")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js")
      .catch(() => {});
  });
}

export default function App() {
  const [user, setUser] = useState(null);

  // Hide PWA splash screen once app mounts
  useEffect(() => {
    if (typeof window.__fixitReady === "function") window.__fixitReady();
  }, []);

  const handleLogin = async (u) => {
    // If logging in as a provider (has email, not admin, not customer role)
    if (u.role === "provider" || (!u.role && u.email && u.email !== "admin@fixitnow.co.za")) {
      // Try to find matching provider in storage
      const raw = await store.get("providers");
      const providers = raw ? JSON.parse(raw.value) : [];
      const match = providers.find(p => p.email?.toLowerCase() === u.email?.toLowerCase());
      if (match) {
        setUser({ ...match, role: "provider" });
        return;
      }
    }
    setUser(u);
  };

  if (!user) return <AuthScreen onLogin={handleLogin} />;
  if (user.role === "admin") return <AdminDashboard onLogout={() => setUser(null)} />;
  if (user.role === "provider") {
    if (user.status === "approved") return <ProviderDashboard provider={user} onLogout={() => setUser(null)} />;
    return <ProviderStatusScreen provider={user} onLogout={() => setUser(null)} />;
  }
  return <CustomerHome user={user} onLogout={() => setUser(null)} />;
}
