import crypto from "node:crypto";
import { createClient } from "@base44/sdk";

const RUN = true;
const PORT = process.env.PORT || 10000;
const APP_ID = process.env.BASE44_APP_ID;
const ACCESS_TOKEN = process.env.BASE44_ACCESS_TOKEN;
const BOT_EMAIL = process.env.BASE44_BOT_EMAIL;
const BOT_PASSWORD = process.env.BASE44_BOT_PASSWORD;
const SECRET = process.env.KIWIFY_WEBHOOK_SECRET;
const PRODUCT_ID = process.env.KIWIFY_PRODUCT_ID || "26d6b860-afba-11f1-b7e0-1b0e168672c7";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (v) => String(v || "").trim().toLowerCase();

async function base44() {
  if (ACCESS_TOKEN) return createClient({ appId: APP_ID, token: ACCESS_TOKEN });
  const b = createClient({ appId: APP_ID });
  await b.auth.loginViaEmailPassword(BOT_EMAIL, BOT_PASSWORD);
  return b;
}

async function signedPost(payload) {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha1", SECRET).update(Buffer.from(body)).digest("hex");
  const res = await fetch(`http://127.0.0.1:${PORT}/kiwify/webhook?signature=${signature}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: res.status, body: await res.json() };
}

async function getUser(b, email) {
  const rows = await b.entities.User.list();
  return rows.find((u) => norm(u.email) === norm(email));
}

async function run() {
  if (!RUN) return;
  await sleep(2500);
  const b = await base44();
  const email = BOT_EMAIL;
  const user = await getUser(b, email);
  if (!user) throw new Error("SELFTEST_USER_NOT_FOUND");
  const originalAccess = user.course_access || "none";
  const originalPlan = user.course_plan || "";
  const orderId = `SELFTEST-${Date.now()}`;
  let result = { orderId };

  try {
    const approved = await signedPost({
      order_id: orderId,
      order_ref: orderId,
      order_status: "paid",
      webhook_event_type: "order_approved",
      payment_merchant_id: `SELFTEST-PAY-${Date.now()}`,
      Product: { product_id: PRODUCT_ID, product_name: "IA Mastery Academy - SELFTEST" },
      Customer: { email, full_name: "IA Mastery Self Test" },
      Commissions: { charge_amount: 9700 },
    });
    await sleep(750);
    const ua = await getUser(b, email);
    const entA = (await b.entities.Entitlement.list()).find((e) => e.external_reference === orderId);

    const refunded = await signedPost({
      order_id: orderId,
      order_ref: orderId,
      order_status: "refunded",
      webhook_event_type: "order_refunded",
      Product: { product_id: PRODUCT_ID, product_name: "IA Mastery Academy - SELFTEST" },
      Customer: { email, full_name: "IA Mastery Self Test" },
      Commissions: { charge_amount: 9700 },
    });
    await sleep(750);
    const ur = await getUser(b, email);
    const entR = (await b.entities.Entitlement.list()).find((e) => e.external_reference === orderId);

    const pass = approved.status === 200 && approved.body?.user_activated === true && ua?.course_access === "active" && entA?.status === "active" && refunded.status === 200 && refunded.body?.revoked === true && ur?.course_access === "revoked" && entR?.status === "refunded";
    result = {
      orderId,
      approved_http: approved.status,
      approved_result: approved.body,
      access_after_approved: ua?.course_access,
      entitlement_after_approved: entA?.status,
      refunded_http: refunded.status,
      refunded_result: refunded.body,
      access_after_refund: ur?.course_access,
      entitlement_after_refund: entR?.status,
      pass,
    };
  } finally {
    try { await b.entities.User.update(user.id, { course_access: originalAccess, course_plan: originalPlan }); } catch (e) { console.error("SELFTEST_RESTORE_USER_FAILED", e?.message || String(e)); }
    try {
      const ents = await b.entities.Entitlement.list();
      for (const e of ents.filter((x) => x.external_reference === orderId)) await b.entities.Entitlement.delete(e.id);
    } catch (e) { console.error("SELFTEST_CLEAN_ENTITLEMENT_FAILED", e?.message || String(e)); }
    try {
      const events = await b.entities.PaymentEvent.list();
      for (const e of events.filter((x) => x.order_id === orderId)) await b.entities.PaymentEvent.delete(e.id);
    } catch (e) { console.error("SELFTEST_CLEAN_EVENTS_FAILED", e?.message || String(e)); }
  }
  console.log("SELFTEST_RESULT", JSON.stringify(result));
}

run().catch((e) => console.error("SELFTEST_FATAL", e?.stack || e?.message || String(e)));
