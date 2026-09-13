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

async function upsertEntitlement(base44, email, patch) {
  const rows = await base44.entities.Entitlement.list();
  const normalized = email.toLowerCase();
  const existing = rows.find(
    (row) => (row.account_email || "").toLowerCase() === normalized,
  );

  if (existing) {
    return base44.entities.Entitlement.update(existing.id, patch);
  }

  return base44.entities.Entitlement.create({
    account_email: normalized,
    ...patch,
  });
}

async function revokeByPaymentReference(base44, paymentReference, status, eventId) {
  if (!paymentReference) return null;
  const rows = await base44.entities.Entitlement.list();
  const existing = rows.find(
    (row) => row.payment_reference === String(paymentReference),
  );
  if (!existing) return null;

  return base44.entities.Entitlement.update(existing.id, {
    status,
    last_event_reference: eventId,
    updated_at: new Date().toISOString(),
  });
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
    await upsertEntitlement(base44, email, {
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

    await logPaymentEvent(base44, event, {
      email,
      processed: true,
      status: "paid",
      action: "grant_access",
    });

    return { ok: true, activated: true };
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
