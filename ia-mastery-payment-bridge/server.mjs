import http from "node:http";
import Stripe from "stripe";
import { createClient } from "@base44/sdk";

const PORT = process.env.PORT || 10000;
const BASE44_APP_ID = process.env.BASE44_APP_ID;
const BASE44_BOT_EMAIL = process.env.BASE44_BOT_EMAIL;
const BASE44_BOT_PASSWORD = process.env.BASE44_BOT_PASSWORD;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const COURSE_VERSION = process.env.COURSE_VERSION || "1.0";
const COURSE_PLAN = process.env.COURSE_PLAN || "launch-97";

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function getBase44() {
  if (!BASE44_APP_ID || !BASE44_BOT_EMAIL || !BASE44_BOT_PASSWORD) {
    throw new Error("BASE44_CONFIG_MISSING");
  }
  const base44 = createClient({ appId: BASE44_APP_ID });
  await base44.auth.loginViaEmailPassword(BASE44_BOT_EMAIL, BASE44_BOT_PASSWORD);
  return base44;
}

async function wasProcessed(base44, eventId) {
  const rows = await base44.entities.PaymentEvent.list();
  return rows.some((row) => row.event_id === eventId && row.processed === true);
}

async function coursePayload(base44) {
  const modules = await base44.entities.CourseModule.list();
  modules.sort((a, b) => (a.order || 0) - (b.order || 0));
  return JSON.stringify({
    course: "IA Mastery Academy",
    version: COURSE_VERSION,
    generated_at: new Date().toISOString(),
    modules,
  });
}

async function findUserByEmail(base44, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const users = await base44.entities.User.list();
  return users.find((user) => normalizeEmail(user.email) === normalized) || null;
}

async function setUserCourseAccess(base44, email, access, plan = COURSE_PLAN) {
  try {
    const user = await findUserByEmail(base44, email);
    if (!user) return { matched: false, updated: false };
    await base44.entities.User.update(user.id, {
      course_access: access,
      course_plan: plan,
    });
    return { matched: true, updated: true, user_id: user.id };
  } catch (error) {
    console.error("USER_ACCESS_UPDATE_FAILED", error);
    return { matched: false, updated: false, error: error?.message || String(error) };
  }
}

async function upsertEntitlement(base44, email, patch) {
  const rows = await base44.entities.Entitlement.list();
  const normalized = normalizeEmail(email);
  const existing = rows.find(
    (row) => normalizeEmail(row.account_email) === normalized,
  );

  if (existing) {
    const updated = await base44.entities.Entitlement.update(existing.id, patch);
    return { record: updated, created: false };
  }

  const created = await base44.entities.Entitlement.create({
    account_email: normalized,
    ...patch,
  });
  return { record: created, created: true };
}

async function revokeByPaymentReference(base44, paymentReference, status, eventId) {
  if (!paymentReference) return null;
  const rows = await base44.entities.Entitlement.list();
  const existing = rows.find(
    (row) => row.payment_reference === String(paymentReference),
  );
  if (!existing) return null;

  const updated = await base44.entities.Entitlement.update(existing.id, {
    status,
    last_event_reference: eventId,
    updated_at: new Date().toISOString(),
  });

  const userAccess = status === "refunded" ? "revoked" : "revoked";
  const userResult = await setUserCourseAccess(
    base44,
    existing.account_email,
    userAccess,
    existing.plan || COURSE_PLAN,
  );

  return { entitlement: updated, userResult };
}

async function logPaymentEvent(base44, event, fields = {}) {
  const object = event.data?.object || {};
  await base44.entities.PaymentEvent.create({
    provider: "stripe",
    event_id: event.id,
    event_type: event.type,
    order_id: fields.order_id || object.id || "",
    customer_email:
      fields.email || object.customer_details?.email || object.customer_email || "",
    product_id: "ia-mastery-academy",
    amount:
      typeof fields.amount === "number"
        ? fields.amount
        : (object.amount_total || object.amount || 0) / 100,
    currency: fields.currency || object.currency || "brl",
    status: fields.status || "received",
    processed: fields.processed === true,
    action: fields.action || "none",
    received_at: new Date(event.created * 1000).toISOString(),
    processed_at: fields.processed ? new Date().toISOString() : undefined,
    payload_hash: event.id,
  });
}

async function processStripeEvent(event) {
  const base44 = await getBase44();
  if (await wasProcessed(base44, event.id)) {
    return { ok: true, duplicate: true };
  }

  const object = event.data?.object || {};

  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    const paid =
      event.type === "checkout.session.async_payment_succeeded" ||
      object.payment_status === "paid";
    const email = object.customer_details?.email || object.customer_email;

    if (!paid || !email) {
      await logPaymentEvent(base44, event, {
        processed: false,
        status: paid ? "missing_email" : "not_paid",
      });
      return { ok: true, activated: false };
    }

    const payload = await coursePayload(base44);
    const entitlement = await upsertEntitlement(base44, email, {
      status: "active",
      plan: COURSE_PLAN,
      provider: "stripe",
      external_reference: object.id,
      payment_reference: String(object.payment_intent || ""),
      customer_reference: String(object.customer || ""),
      last_event_reference: event.id,
      course_version: COURSE_VERSION,
      course_payload_json: payload,
      granted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const userResult = await setUserCourseAccess(base44, email, "active", COURSE_PLAN);

    await logPaymentEvent(base44, event, {
      email,
      processed: true,
      status: "paid",
      action: userResult.updated
        ? "grant_access_and_activate_user"
        : "grant_entitlement_pending_registration",
    });

    return {
      ok: true,
      activated: true,
      entitlement_created: entitlement.created,
      user_activated: userResult.updated,
    };
  }

  if (
    event.type === "charge.refunded" ||
    event.type === "refund.created" ||
    event.type === "refund.updated"
  ) {
    const paymentReference = object.payment_intent || object.charge || "";
    const changed = await revokeByPaymentReference(
      base44,
      paymentReference,
      "refunded",
      event.id,
    );
    await logPaymentEvent(base44, event, {
      processed: true,
      status: "refunded",
      action: changed ? "revoke_access" : "no_entitlement_match",
    });
    return { ok: true, revoked: Boolean(changed) };
  }

  if (event.type === "charge.dispute.created") {
    const changed = await revokeByPaymentReference(
      base44,
      object.payment_intent || "",
      "revoked",
      event.id,
    );
    await logPaymentEvent(base44, event, {
      processed: true,
      status: "disputed",
      action: changed ? "revoke_access" : "no_entitlement_match",
    });
    return { ok: true, revoked: Boolean(changed) };
  }

  await logPaymentEvent(base44, event, {
    processed: true,
    status: "ignored",
    action: "ignore",
  });
  return { ok: true, ignored: true };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "ia-mastery-payment-bridge",
        configured: Boolean(
          BASE44_APP_ID &&
            BASE44_BOT_EMAIL &&
            BASE44_BOT_PASSWORD &&
            STRIPE_WEBHOOK_SECRET,
        ),
      });
    }

    if (req.method === "POST" && url.pathname === "/stripe/webhook") {
      if (!STRIPE_WEBHOOK_SECRET) {
        return sendJson(res, 503, { ok: false, error: "WEBHOOK_SECRET_MISSING" });
      }

      const body = await readRawBody(req);
      const signature = req.headers["stripe-signature"];
      if (!signature) {
        return sendJson(res, 400, { ok: false, error: "SIGNATURE_MISSING" });
      }

      let event;
      try {
        event = Stripe.webhooks.constructEvent(
          body,
          signature,
          STRIPE_WEBHOOK_SECRET,
        );
      } catch {
        return sendJson(res, 400, { ok: false, error: "INVALID_SIGNATURE" });
      }

      const result = await processStripeEvent(event);
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { ok: false, error: "NOT_FOUND" });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, {
      ok: false,
      error: error?.message || String(error),
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`IA Mastery payment bridge listening on ${PORT}`);
});
