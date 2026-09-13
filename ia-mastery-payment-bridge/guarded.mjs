import http from "node:http";
import Stripe from "stripe";
import { createClient } from "@base44/sdk";

const PORT = process.env.PORT || 10000;
const APP_ID = process.env.BASE44_APP_ID;
const BOT_EMAIL = process.env.BASE44_BOT_EMAIL;
const BOT_PASSWORD = process.env.BASE44_BOT_PASSWORD;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const COURSE_VERSION = process.env.COURSE_VERSION || "1.0";
const COURSE_PLAN = process.env.COURSE_PLAN || "launch-97";
const COURSE_KEY = "ia-mastery-academy";
const PAYMENT_LINK_ID = "plink_1UFJ6d1OT4dIOGZjKMNich7n";
const EXPECTED_AMOUNT = 9700;

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const norm = (v) => String(v || "").trim().toLowerCase();

async function raw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
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

async function logEvent(b, event, status, action, email = "") {
  const o = event.data?.object || {};
  await b.entities.PaymentEvent.create({
    provider: "stripe",
    event_id: event.id,
    event_type: event.type,
    order_id: o.id || "",
    customer_email: email || o.customer_details?.email || o.customer_email || "",
    product_id: COURSE_KEY,
    amount: (o.amount_total || o.amount || 0) / 100,
    currency: o.currency || "brl",
    status,
    processed: true,
    action,
    received_at: new Date(event.created * 1000).toISOString(),
    processed_at: new Date().toISOString(),
    payload_hash: event.id,
  });
}

async function upsertEntitlement(b, email, o, eventId) {
  const rows = await b.entities.Entitlement.list();
  const existing = rows.find((r) => norm(r.account_email) === norm(email));
  const patch = {
    status: "active",
    plan: COURSE_PLAN,
    provider: "stripe",
    external_reference: o.id,
    payment_reference: String(o.payment_intent || ""),
    customer_reference: String(o.customer || ""),
    last_event_reference: eventId,
    course_version: COURSE_VERSION,
    course_payload_json: JSON.stringify({ course: COURSE_KEY, version: COURSE_VERSION, modules: 16 }),
    granted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (existing) return b.entities.Entitlement.update(existing.id, patch);
  return b.entities.Entitlement.create({ account_email: norm(email), ...patch });
}

async function revokeByPayment(b, paymentRef, eventId) {
  if (!paymentRef) return false;
  const rows = await b.entities.Entitlement.list();
  const e = rows.find((r) => r.payment_reference === String(paymentRef));
  if (!e) return false;
  await b.entities.Entitlement.update(e.id, {
    status: "revoked",
    last_event_reference: eventId,
    updated_at: new Date().toISOString(),
  });
  await setAccess(b, e.account_email, "revoked", e.plan || COURSE_PLAN);
  return true;
}

function isCourseCheckout(o) {
  return o.metadata?.course === COURSE_KEY &&
    o.metadata?.offer === COURSE_PLAN &&
    o.payment_link === PAYMENT_LINK_ID &&
    Number(o.amount_total || 0) === EXPECTED_AMOUNT &&
    norm(o.currency) === "brl";
}

async function reconcile(b) {
  const rows = await b.entities.Entitlement.list();
  let activated = 0;
  for (const e of rows) {
    if (e.status !== "active") continue;
    try {
      if (await setAccess(b, e.account_email, "active", e.plan || COURSE_PLAN)) activated++;
    } catch (err) {
      console.error("RECONCILE_USER_FAILED", err?.message || String(err));
    }
  }
  return { active: rows.filter((e) => e.status === "active").length, activated };
}

function retryReconcile() {
  for (const ms of [5000, 30000, 120000, 300000, 600000]) {
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

async function handleEvent(event) {
  const b = await client();
  if (await processed(b, event.id)) return { ok: true, duplicate: true };
  const o = event.data?.object || {};

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    if (!isCourseCheckout(o)) {
      await logEvent(b, event, "ignored_non_course_checkout", "ignore");
      return { ok: true, ignored: true };
    }
    const paid = event.type === "checkout.session.async_payment_succeeded" || o.payment_status === "paid";
    const email = o.customer_details?.email || o.customer_email;
    if (!paid || !email) {
      await logEvent(b, event, paid ? "missing_email" : "not_paid", "ignore", email || "");
      return { ok: true, activated: false };
    }
    await upsertEntitlement(b, email, o, event.id);
    let activated = false;
    try { activated = await setAccess(b, email, "active"); } catch (err) { console.error("SET_ACCESS_FAILED", err?.message || String(err)); }
    if (!activated) retryReconcile();
    await logEvent(b, event, "paid", activated ? "grant_access" : "pending_registration", email);
    return { ok: true, entitlement: true, user_activated: activated };
  }

  if (["charge.refunded", "refund.created", "refund.updated"].includes(event.type)) {
    const changed = await revokeByPayment(b, o.payment_intent || o.charge || "", event.id);
    await logEvent(b, event, "refunded", changed ? "revoke_access" : "no_match");
    return { ok: true, revoked: changed };
  }

  if (event.type === "charge.dispute.created") {
    const changed = await revokeByPayment(b, o.payment_intent || "", event.id);
    await logEvent(b, event, "disputed", changed ? "revoke_access" : "no_match");
    return { ok: true, revoked: changed };
  }

  await logEvent(b, event, "ignored", "ignore");
  return { ok: true, ignored: true };
}

async function ready() {
  const b = await client();
  const bot = await userByEmail(b, BOT_EMAIL);
  if (!bot || bot.role !== "admin") throw new Error("BASE44_BOT_NOT_ADMIN");
  const modules = await b.entities.CourseModule.list();
  if (modules.length !== 16) throw new Error(`COURSE_MODULE_COUNT_${modules.length}`);
  await b.entities.User.update(bot.id, { preferred_locale: bot.preferred_locale || "pt-BR" });
  return { ok: true, base44_authenticated: true, bot_admin: true, user_update_writable: true, course_modules: 16, reconciliation: await reconcile(b) };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, service: "ia-mastery-payment-bridge", configured: Boolean(APP_ID && BOT_EMAIL && BOT_PASSWORD && WEBHOOK_SECRET) });
    }
    if (req.method === "GET" && url.pathname === "/ready") return json(res, 200, await ready());
    if (req.method === "POST" && url.pathname === "/stripe/webhook") {
      if (!WEBHOOK_SECRET) return json(res, 503, { ok: false, error: "WEBHOOK_SECRET_MISSING" });
      const body = await raw(req);
      const sig = req.headers["stripe-signature"];
      if (!sig) return json(res, 400, { ok: false, error: "SIGNATURE_MISSING" });
      let event;
      try { event = Stripe.webhooks.constructEvent(body, sig, WEBHOOK_SECRET); }
      catch { return json(res, 400, { ok: false, error: "INVALID_SIGNATURE" }); }
      return json(res, 200, await handleEvent(event));
    }
    return json(res, 404, { ok: false, error: "NOT_FOUND" });
  } catch (err) {
    console.error(err);
    return json(res, 500, { ok: false, error: err?.message || String(err) });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`IA Mastery guarded bridge listening on ${PORT}`));
