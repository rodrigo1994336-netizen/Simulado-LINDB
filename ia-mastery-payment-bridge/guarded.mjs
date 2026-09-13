import http from "node:http";
import crypto from "node:crypto";
import { createClient } from "@base44/sdk";

const PORT = process.env.PORT || 10000;
const APP_ID = process.env.BASE44_APP_ID;
const BOT_EMAIL = process.env.BASE44_BOT_EMAIL;
const BOT_PASSWORD = process.env.BASE44_BOT_PASSWORD;
const KIWIFY_SECRET = process.env.KIWIFY_WEBHOOK_SECRET;
const KIWIFY_PRODUCT_ID = process.env.KIWIFY_PRODUCT_ID || "26d6b860-afba-11f1-b7e0-1b0e168672c7";
const COURSE_VERSION = process.env.COURSE_VERSION || "1.0";
const COURSE_PLAN = process.env.COURSE_PLAN || "launch-97";
const COURSE_KEY = "ia-mastery-academy";
const BASE44_REGISTER_URL = "https://fortunate-mastery-flow-labs.base44.app/register?returnTo=%2Fcurso";

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
const norm = (v) => String(v || "").trim().toLowerCase();
const safeString = (v) => String(v == null ? "" : v);

async function raw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function validKiwifySignature(body, url) {
  if (!KIWIFY_SECRET) return false;
  const supplied = norm(url.searchParams.get("signature"));
  if (!/^[a-f0-9]{40}$/.test(supplied)) return false;
  const expected = crypto.createHmac("sha1", KIWIFY_SECRET).update(body).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));
  } catch {
    return false;
  }
}

async function client() {
  if (!APP_ID || !BOT_EMAIL || !BOT_PASSWORD) throw new Error("BASE44_CONFIG_MISSING");
  const b = createClient({ appId: APP_ID });
  await b.auth.loginViaEmailPassword(BOT_EMAIL, BOT_PASSWORD);
  return b;
}

async function userByEmail(b, email) {
  const users = await b.entities.User.list();
  return users.find((u) => norm(u.email) === norm(email)) || null;
}

async function setAccess(b, email, access, plan = COURSE_PLAN) {
  const user = await userByEmail(b, email);
  if (!user) return false;
  await b.entities.User.update(user.id, { course_access: access, course_plan: plan });
  return true;
}

async function processed(b, eventId) {
  const rows = await b.entities.PaymentEvent.list();
  return rows.some((r) => r.event_id === eventId && r.processed === true);
}

function kiwifyEventId(payload) {
  return `kiwify:${safeString(payload.webhook_event_type || payload.event)}:${safeString(payload.order_id || payload.order_ref)}`;
}

function amountBrl(payload) {
  const raw = payload?.Commissions?.charge_amount ?? payload?.Purchase?.original_offer_price ?? payload?.purchase?.original_offer_price ?? 0;
  const n = Number(String(raw).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

async function logEvent(b, payload, status, action, email = "") {
  const eventType = safeString(payload.webhook_event_type || payload.event);
  const eventId = kiwifyEventId(payload);
  await b.entities.PaymentEvent.create({
    provider: "kiwify",
    event_id: eventId,
    event_type: eventType,
    order_id: safeString(payload.order_id || payload.order_ref),
    customer_email: email || payload?.Customer?.email || payload?.customer?.email || "",
    product_id: safeString(payload?.Product?.product_id || payload?.product?.product_id),
    amount: amountBrl(payload),
    currency: "brl",
    status,
    processed: true,
    action,
    received_at: new Date().toISOString(),
    processed_at: new Date().toISOString(),
    payload_hash: crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  });
}

async function upsertEntitlement(b, email, payload, eventId) {
  const rows = await b.entities.Entitlement.list();
  const existing = rows.find((r) => norm(r.account_email) === norm(email));
  const orderId = safeString(payload.order_id || payload.order_ref);
  const patch = {
    status: "active",
    plan: COURSE_PLAN,
    provider: "kiwify",
    external_reference: orderId,
    payment_reference: safeString(payload.payment_merchant_id || payload.order_ref || orderId),
    customer_reference: norm(email),
    last_event_reference: eventId,
    course_version: COURSE_VERSION,
    course_payload_json: JSON.stringify({ course: COURSE_KEY, version: COURSE_VERSION, modules: 16 }),
    granted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (existing) return b.entities.Entitlement.update(existing.id, patch);
  return b.entities.Entitlement.create({ account_email: norm(email), ...patch });
}

async function revokeByOrder(b, orderId, eventId, finalStatus = "revoked") {
  if (!orderId) return false;
  const rows = await b.entities.Entitlement.list();
  const e = rows.find((r) => r.provider === "kiwify" && r.external_reference === String(orderId));
  if (!e) return false;
  await b.entities.Entitlement.update(e.id, {
    status: finalStatus === "refunded" ? "refunded" : "revoked",
    last_event_reference: eventId,
    updated_at: new Date().toISOString(),
  });
  await setAccess(b, e.account_email, "revoked", e.plan || COURSE_PLAN);
  return true;
}

function productMatches(payload) {
  const id = safeString(payload?.Product?.product_id || payload?.product?.product_id);
  return id === KIWIFY_PRODUCT_ID;
}

async function reconcile(b) {
  const rows = await b.entities.Entitlement.list();
  let activated = 0;
  for (const e of rows) {
    if (e.provider !== "kiwify" || e.status !== "active") continue;
    try {
      if (await setAccess(b, e.account_email, "active", e.plan || COURSE_PLAN)) activated++;
    } catch (err) {
      console.error("RECONCILE_USER_FAILED", err?.message || String(err));
    }
  }
  return { active: rows.filter((e) => e.provider === "kiwify" && e.status === "active").length, activated };
}

function retryReconcile() {
  for (const ms of [5000, 30000, 120000, 300000, 600000, 1800000]) {
    const t = setTimeout(async () => {
      try {
        const b = await client();
        console.log("RECONCILE", JSON.stringify(await reconcile(b)));
      } catch (err) {
        console.error("RECONCILE_FAILED", err?.message || String(err));
      }
    }, ms);
    t.unref?.();
  }
}

async function handleKiwify(payload) {
  const b = await client();
  const eventType = norm(payload.webhook_event_type || payload.event);
  const eventId = kiwifyEventId(payload);
  if (await processed(b, eventId)) return { ok: true, duplicate: true };

  if (!productMatches(payload)) {
    await logEvent(b, payload, "ignored_non_course_product", "ignore");
    return { ok: true, ignored: true };
  }

  if (payload.is_test === true || payload.test === true) {
    await logEvent(b, payload, "test", "ignore");
    return { ok: true, test: true };
  }

  const email = payload?.Customer?.email || payload?.customer?.email || "";
  const orderId = safeString(payload.order_id || payload.order_ref);

  if (eventType === "order_approved") {
    if (norm(payload.order_status) !== "paid" || !email) {
      await logEvent(b, payload, !email ? "missing_email" : "not_paid", "ignore", email);
      return { ok: true, activated: false };
    }
    await upsertEntitlement(b, email, payload, eventId);
    let activated = false;
    try { activated = await setAccess(b, email, "active"); }
    catch (err) { console.error("SET_ACCESS_FAILED", err?.message || String(err)); }
    if (!activated) retryReconcile();
    await logEvent(b, payload, "paid", activated ? "grant_access" : "pending_registration", email);
    return { ok: true, entitlement: true, user_activated: activated };
  }

  if (eventType === "order_refunded") {
    const changed = await revokeByOrder(b, orderId, eventId, "refunded");
    await logEvent(b, payload, "refunded", changed ? "revoke_access" : "no_match", email);
    return { ok: true, revoked: changed };
  }

  if (eventType === "chargeback") {
    const changed = await revokeByOrder(b, orderId, eventId, "revoked");
    await logEvent(b, payload, "chargeback", changed ? "revoke_access" : "no_match", email);
    return { ok: true, revoked: changed };
  }

  await logEvent(b, payload, "ignored", "ignore", email);
  return { ok: true, ignored: true };
}

async function ready() {
  const b = await client();
  const bot = await userByEmail(b, BOT_EMAIL);
  if (!bot || bot.role !== "admin") throw new Error("BASE44_BOT_NOT_ADMIN");
  const modules = await b.entities.CourseModule.list();
  if (modules.length !== 16) throw new Error(`COURSE_MODULE_COUNT_${modules.length}`);
  await b.entities.User.update(bot.id, { preferred_locale: bot.preferred_locale || "pt-BR" });
  return {
    ok: true,
    provider: "kiwify",
    base44_authenticated: true,
    bot_admin: true,
    user_update_writable: true,
    course_modules: 16,
    product_id: KIWIFY_PRODUCT_ID,
    reconciliation: await reconcile(b),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        service: "ia-mastery-payment-bridge",
        provider: "kiwify",
        configured: Boolean(APP_ID && BOT_EMAIL && BOT_PASSWORD && KIWIFY_SECRET && KIWIFY_PRODUCT_ID),
      });
    }
    if (req.method === "GET" && url.pathname === "/ready") return json(res, 200, await ready());
    if (req.method === "GET" && url.pathname === "/purchase-success") {
      retryReconcile();
      res.writeHead(302, { location: BASE44_REGISTER_URL, "cache-control": "no-store" });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/kiwify/webhook") {
      if (!KIWIFY_SECRET) return json(res, 503, { ok: false, error: "KIWIFY_SECRET_MISSING" });
      const body = await raw(req);
      if (!validKiwifySignature(body, url)) return json(res, 401, { ok: false, error: "INVALID_SIGNATURE" });
      let payload;
      try { payload = JSON.parse(body.toString("utf8")); }
      catch { return json(res, 400, { ok: false, error: "INVALID_JSON" }); }
      return json(res, 200, await handleKiwify(payload));
    }
    if (req.method === "POST" && url.pathname === "/stripe/webhook") {
      return json(res, 410, { ok: false, error: "STRIPE_DISABLED_USE_KIWIFY" });
    }
    return json(res, 404, { ok: false, error: "NOT_FOUND" });
  } catch (err) {
    console.error(err);
    return json(res, 500, { ok: false, error: err?.message || String(err) });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`IA Mastery Kiwify bridge listening on ${PORT}`));
