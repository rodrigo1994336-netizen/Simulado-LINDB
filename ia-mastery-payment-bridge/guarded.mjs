import http from "node:http";
import crypto from "node:crypto";
import { createClient } from "@base44/sdk";

const PORT = process.env.PORT || 10000;
const APP_ID = process.env.BASE44_APP_ID;
const BOT_EMAIL = process.env.BASE44_BOT_EMAIL;
const BOT_PASSWORD = process.env.BASE44_BOT_PASSWORD;
const ACCESS_TOKEN = process.env.BASE44_ACCESS_TOKEN;
const KIWIFY_SECRET = process.env.KIWIFY_WEBHOOK_SECRET;
const KIWIFY_PRODUCT_ID = process.env.KIWIFY_PRODUCT_ID || "26d6b860-afba-11f1-b7e0-1b0e168672c7";
const OWNER_EMAIL = normEnv(process.env.OWNER_EMAIL || "rodrigo1994336@gmail.com");
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || KIWIFY_SECRET || "";
const TECHNICAL_ADMIN_EMAILS = new Set([normEnv(BOT_EMAIL), "ricteste.afiliacao@gmail.com", "ricteste.afiliacao+payments@gmail.com"].filter(Boolean));
function normEnv(v){ return String(v || "").trim().toLowerCase(); }
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
  if (!APP_ID) throw new Error("BASE44_APP_ID_MISSING");
  if (ACCESS_TOKEN) return createClient({ appId: APP_ID, token: ACCESS_TOKEN });
  if (!BOT_EMAIL || !BOT_PASSWORD) throw new Error("BASE44_CONFIG_MISSING");
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


async function parseJsonBody(req) {
  const body = await raw(req);
  if (!body.length) return {};
  try { return JSON.parse(body.toString("utf8")); } catch { throw new Error("INVALID_JSON"); }
}
function cookieMap(req) {
  const out = {};
  const rawCookie = String(req.headers.cookie || "");
  for (const part of rawCookie.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function adminToken() {
  if (!ADMIN_SESSION_SECRET) return "";
  return crypto.createHmac("sha256", ADMIN_SESSION_SECRET).update("ia-mastery-admin").digest("hex");
}
function adminAuthed(req) {
  const got = cookieMap(req).ia_admin || "";
  const expected = adminToken();
  if (!got || !expected || got.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected)); } catch { return false; }
}
function html(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(body);
}
function adminLoginPage(){ return "<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>IA Mastery — Admin</title><style>\nbody{margin:0;font-family:Inter,Arial,sans-serif;background:#07111f;color:#eef4ff;display:grid;min-height:100vh;place-items:center}.box{width:min(420px,90vw);background:#0d1a2d;border:1px solid #243b62;border-radius:18px;padding:28px;box-shadow:0 20px 70px #0008}h1{margin:0 0 8px}p{color:#9fb0ca}input,button{width:100%;box-sizing:border-box;padding:13px;border-radius:10px;border:1px solid #29466f;background:#091525;color:white;margin-top:10px}button{background:linear-gradient(90deg,#1ea7ff,#7257ff);border:0;font-weight:700;cursor:pointer}.err{color:#ff8e8e;min-height:20px}\n</style></head><body><div class=\"box\"><h1>IA Mastery Academy</h1><p>Área administrativa restrita</p><input id=\"e1\" type=\"email\" value=\"ricteste.afiliacao@gmail.com\" placeholder=\"E-mail administrativo\"><input id=\"p\" type=\"password\" placeholder=\"Senha da conta\"><button onclick=\"login()\">Entrar</button><div id=\"e\" class=\"err\"></div></div><script>\nasync function login(){const r=await fetch('/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:document.getElementById('e1').value,password:document.getElementById('p').value})});if(r.ok)location.reload();else document.getElementById('e').textContent='Senha inválida';}\n</script></body></html>"; }
function adminDashboardPage(){ return "<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>IA Mastery — Administração</title><style>\n*{box-sizing:border-box}body{margin:0;font-family:Inter,Arial,sans-serif;background:#07111f;color:#eef4ff}.wrap{max-width:1280px;margin:auto;padding:24px}.top{display:flex;justify-content:space-between;gap:16px;align-items:center}.muted{color:#9fb0ca}.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:20px 0}.card,.panel{background:#0d1a2d;border:1px solid #223d65;border-radius:16px;padding:16px}.n{font-size:28px;font-weight:800}.panel{margin:14px 0;overflow:auto}h1,h2{margin:0 0 10px}input,select,button{padding:9px 11px;border-radius:9px;border:1px solid #2a466d;background:#0a1728;color:white}button{cursor:pointer}.primary{background:linear-gradient(90deg,#1ea7ff,#7257ff);border:0;font-weight:700}.danger{background:#4a1822}.ok{background:#143c2d}table{width:100%;border-collapse:collapse;min-width:850px}th,td{text-align:left;padding:10px;border-bottom:1px solid #1d3353;font-size:14px}th{color:#9fb0ca}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.grow{flex:1}.pill{padding:4px 8px;border-radius:999px;background:#152945}.success{color:#71e6a7}.warn{color:#ffcf70}.red{color:#ff8e8e}@media(max-width:900px){.cards{grid-template-columns:1fr 1fr}.top{align-items:flex-start;flex-direction:column}}\n</style></head><body><div class=\"wrap\">\n<div class=\"top\"><div><h1>IA Mastery Academy — Administração</h1><div class=\"muted\">Acessos, comercial, módulos e pagamentos</div></div><button onclick=\"logout()\">Sair</button></div>\n<div class=\"cards\"><div class=\"card\"><div class=\"muted\">Usuários</div><div class=\"n\" id=\"total\">—</div></div><div class=\"card\"><div class=\"muted\">Ativos</div><div class=\"n success\" id=\"active\">—</div></div><div class=\"card\"><div class=\"muted\">Trial</div><div class=\"n warn\" id=\"trial\">—</div></div><div class=\"card\"><div class=\"muted\">Revogados</div><div class=\"n red\" id=\"revoked\">—</div></div><div class=\"card\"><div class=\"muted\">Vendas</div><div class=\"n\" id=\"sales\">—</div></div></div>\n<div class=\"panel\"><h2>Alunos e acessos</h2><div class=\"row\"><input id=\"q\" class=\"grow\" placeholder=\"Pesquisar nome ou e-mail\" oninput=\"renderUsers()\"><button class=\"primary\" onclick=\"load()\">Atualizar</button></div><table><thead><tr><th>Nome</th><th>E-mail</th><th>Acesso</th><th>Plano</th><th>Validade</th><th>Ação</th></tr></thead><tbody id=\"users\"></tbody></table></div>\n<div class=\"panel\"><h2>Configuração comercial</h2><div class=\"row\"><input id=\"price\" class=\"grow\" placeholder=\"Texto do preço\"><input id=\"checkout\" class=\"grow\" placeholder=\"Checkout Kiwify\"></div><div class=\"row\" style=\"margin-top:10px\"><input id=\"support\" class=\"grow\" placeholder=\"Contato de suporte\"><label><input id=\"enabled\" type=\"checkbox\"> Vendas habilitadas</label><button class=\"primary\" onclick=\"saveCommercial()\">Salvar comercial</button></div><div id=\"commercialMsg\" class=\"muted\"></div></div>\n<div class=\"panel\"><h2>Módulos</h2><table><thead><tr><th>#</th><th>Título</th><th>Publicado</th><th>Ação</th></tr></thead><tbody id=\"modules\"></tbody></table></div>\n<div class=\"panel\"><h2>Eventos de pagamento</h2><table><thead><tr><th>Data</th><th>Evento</th><th>E-mail</th><th>Status</th><th>Ação</th></tr></thead><tbody id=\"events\"></tbody></table></div>\n</div><script>\nlet DATA=null;\nfunction esc(v){return String(v??'').replace(/[&<>\"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#039;'}[m]));}\nasync function api(url,opt){const r=await fetch(url,opt);if(r.status===401){location.reload();throw new Error('unauthorized')}const j=await r.json();if(!r.ok)throw new Error(j.error||'Erro');return j}\nasync function load(){DATA=await api('/admin/api/overview');document.getElementById('total').textContent=DATA.stats.total;document.getElementById('active').textContent=DATA.stats.active;document.getElementById('trial').textContent=DATA.stats.trial;document.getElementById('revoked').textContent=DATA.stats.revoked;document.getElementById('sales').textContent=DATA.stats.sales;price.value=DATA.commercial.price_text||'';checkout.value=DATA.commercial.checkout_url||'';support.value=DATA.commercial.support_contact||'';enabled.checked=!!DATA.commercial.sales_enabled;renderUsers();renderModules();renderEvents();}\nfunction renderUsers(){if(!DATA)return;const q=document.getElementById('q').value.toLowerCase();users.innerHTML=DATA.users.filter(u=>(u.email+' '+(u.full_name||'')).toLowerCase().includes(q)).map(u=>'<tr><td>'+esc(u.full_name||'')+'</td><td>'+esc(u.email)+'</td><td><span class=\"pill\">'+esc(u.course_access||'none')+'</span></td><td>'+esc(u.course_plan||'')+'</td><td>'+esc(u.access_expires_at||'')+'</td><td><select id=\"a_'+u.id+'\"><option>active</option><option>trial</option><option>revoked</option><option>expired</option><option>none</option></select> <button onclick=\"setAccess(\\''+u.id+'\\',\\''+esc(u.email)+'\\')\">Aplicar</button></td></tr>').join('');}\nasync function setAccess(id,email){const access=document.getElementById('a_'+id).value;let expires_at='';if(access==='trial'){const d=new Date();d.setDate(d.getDate()+7);expires_at=d.toISOString()}await api('/admin/api/access',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,email,access,plan:'launch-97',expires_at})});await load();}\nasync function saveCommercial(){commercialMsg.textContent='Salvando...';await api('/admin/api/commercial',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({price_text:price.value,checkout_url:checkout.value,support_contact:support.value,sales_enabled:enabled.checked})});commercialMsg.textContent='Configuração salva.';await load();}\nfunction renderModules(){modules.innerHTML=DATA.modules.map(m=>'<tr><td>'+esc(m.order)+'</td><td>'+esc(m.title_pt)+'</td><td>'+(m.published?'Sim':'Não')+'</td><td><button onclick=\"toggleModule(\\''+m.id+'\\','+(!m.published)+')\">'+(m.published?'Despublicar':'Publicar')+'</button></td></tr>').join('');}\nasync function toggleModule(id,published){await api('/admin/api/module',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,published})});await load();}\nfunction renderEvents(){events.innerHTML=DATA.events.map(e=>'<tr><td>'+esc(e.received_at||'')+'</td><td>'+esc(e.event_type||'')+'</td><td>'+esc(e.customer_email||'')+'</td><td>'+esc(e.status||'')+'</td><td>'+esc(e.action||'')+'</td></tr>').join('');}\nasync function logout(){await fetch('/admin/logout',{method:'POST'});location.reload()}load().catch(e=>alert(e.message));\n</script></body></html>"; }

async function enforceOwnerAdmin(b) {
  let users = await b.entities.User.list();

  // Restore service identities first. The access token may belong to one of them.
  for (const u of users) {
    const email = norm(u.email);
    if (TECHNICAL_ADMIN_EMAILS.has(email) && u.role !== "admin") {
      await b.entities.User.update(u.id, { role: "admin" });
    }
  }

  users = await b.entities.User.list();
  const owner = users.find((u) => norm(u.email) === OWNER_EMAIL);
  if (owner) {
    await b.entities.User.update(owner.id, { role: "admin" });
    await b.entities.User.update(owner.id, { course_access: "active", course_plan: "owner" });
  }

  users = await b.entities.User.list();
  for (const u of users) {
    const email = norm(u.email);
    if (u.role === "admin" && email !== OWNER_EMAIL && !TECHNICAL_ADMIN_EMAILS.has(email)) {
      await b.entities.User.update(u.id, { role: "user" });
    }
  }

  const refreshed = await b.entities.User.list();
  return {
    owner_admin: Boolean(refreshed.find((u) => norm(u.email) === OWNER_EMAIL && u.role === "admin")),
    technical_admins: refreshed.filter((u) => u.role === "admin" && TECHNICAL_ADMIN_EMAILS.has(norm(u.email))).map((u) => u.email),
    human_admins: refreshed.filter((u) => u.role === "admin" && !TECHNICAL_ADMIN_EMAILS.has(norm(u.email))).map((u) => u.email),
  };
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
  const adminState = await enforceOwnerAdmin(b);
  const bot = await userByEmail(b, BOT_EMAIL);
  if (!bot || bot.role !== "admin") throw new Error("BASE44_BOT_NOT_ADMIN");
  if (!adminState.owner_admin) throw new Error("OWNER_NOT_ADMIN");
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
    owner_admin: adminState.owner_admin,
    human_admins: adminState.human_admins,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/admin") {
      if (!adminAuthed(req)) return html(res, 200, adminLoginPage());
      return html(res, 200, adminDashboardPage());
    }
    if (req.method === "POST" && url.pathname === "/admin/login") {
      const body = await parseJsonBody(req);
      const email = norm(body.email);
      if (![OWNER_EMAIL, "ricteste.afiliacao@gmail.com"].includes(email) || !body.password) return json(res, 401, { ok: false, error: "INVALID_CREDENTIALS" });
      try {
        const verify = createClient({ appId: APP_ID });
        await verify.auth.loginViaEmailPassword(email, safeString(body.password));
      } catch {
        return json(res, 401, { ok: false, error: "INVALID_CREDENTIALS" });
      }
      const b = await client();
      const state = await enforceOwnerAdmin(b);
      if (!state.owner_admin) return json(res, 500, { ok: false, error: "OWNER_ADMIN_SETUP_FAILED" });
      const token = adminToken();
      res.writeHead(204, { "set-cookie": "ia_admin=" + encodeURIComponent(token) + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200", "cache-control": "no-store" });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/admin/logout") {
      res.writeHead(204, { "set-cookie": "ia_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0", "cache-control": "no-store" });
      return res.end();
    }
    if (url.pathname.startsWith("/admin/api/") && !adminAuthed(req)) return json(res, 401, { ok: false, error: "UNAUTHORIZED" });
    if (req.method === "GET" && url.pathname === "/admin/api/overview") {
      const b = await client();
      const adminState = await enforceOwnerAdmin(b);
      const [users, entitlements, events, configs, modules] = await Promise.all([
        b.entities.User.list(), b.entities.Entitlement.list(), b.entities.PaymentEvent.list(), b.entities.CommerceConfig.list(), b.entities.CourseModule.list()
      ]);
      const commercial = configs[0] || {};
      return json(res, 200, {
        ok: true,
        admin: adminState,
        stats: {
          total: users.filter((u) => !TECHNICAL_ADMIN_EMAILS.has(norm(u.email))).length,
          active: users.filter((u) => u.course_access === "active").length,
          trial: users.filter((u) => u.course_access === "trial").length,
          revoked: users.filter((u) => u.course_access === "revoked").length,
          sales: events.filter((e) => e.status === "paid").length
        },
        users: users.filter((u) => !TECHNICAL_ADMIN_EMAILS.has(norm(u.email))).map((u) => ({
          id: u.id, email: u.email, full_name: u.full_name, role: u.role, course_access: u.course_access || "none",
          course_plan: u.course_plan || "", access_expires_at: u.access_expires_at || ""
        })),
        commercial,
        modules: modules.sort((a,b2)=>(a.order||0)-(b2.order||0)).map((m)=>({id:m.id,order:m.order,title_pt:m.title_pt,published:m.published})),
        events: events.sort((a,b2)=>String(b2.received_at||"").localeCompare(String(a.received_at||""))).slice(0,50),
        entitlements
      });
    }
    if (req.method === "POST" && url.pathname === "/admin/api/access") {
      const body = await parseJsonBody(req);
      const allowed = new Set(["none","trial","active","expired","revoked"]);
      if (!allowed.has(body.access)) return json(res, 400, { ok:false, error:"INVALID_ACCESS" });
      const b = await client();
      await enforceOwnerAdmin(b);
      const users = await b.entities.User.list();
      const target = users.find((u) => u.id === body.id || norm(u.email) === norm(body.email));
      if (!target) return json(res, 404, { ok:false, error:"USER_NOT_FOUND_REGISTER_FIRST" });
      if (norm(target.email) === OWNER_EMAIL) return json(res, 400, { ok:false, error:"OWNER_ACCESS_CANNOT_BE_CHANGED_HERE" });
      await b.entities.User.update(target.id, {
        course_access: body.access,
        course_plan: safeString(body.plan || COURSE_PLAN),
        access_expires_at: safeString(body.expires_at || "")
      });
      return json(res, 200, { ok:true, email:target.email, access:body.access });
    }
    if (req.method === "POST" && url.pathname === "/admin/api/commercial") {
      const body = await parseJsonBody(req);
      const b = await client();
      const rows = await b.entities.CommerceConfig.list();
      if (!rows[0]) return json(res, 404, { ok:false, error:"COMMERCE_CONFIG_NOT_FOUND" });
      const patch = {};
      for (const k of ["product_name","price_text","checkout_url","support_contact","provider_product_id","provider_offer_id"]) if (k in body) patch[k] = body[k];
      if ("sales_enabled" in body) patch.sales_enabled = Boolean(body.sales_enabled);
      patch.updated_at = new Date().toISOString();
      await b.entities.CommerceConfig.update(rows[0].id, patch);
      return json(res, 200, { ok:true });
    }
    if (req.method === "POST" && url.pathname === "/admin/api/module") {
      const body = await parseJsonBody(req);
      const b = await client();
      const modules = await b.entities.CourseModule.list();
      const target = modules.find((m)=>m.id===body.id);
      if (!target) return json(res, 404, { ok:false, error:"MODULE_NOT_FOUND" });
      const patch = {};
      if ("published" in body) patch.published = Boolean(body.published);
      for (const k of ["title_pt","title_es","title_en","subtitle_pt","subtitle_es","subtitle_en","content_pt","content_es","content_en","estimated_min"]) if (k in body) patch[k] = body[k];
      await b.entities.CourseModule.update(target.id, patch);
      return json(res, 200, { ok:true });
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        service: "ia-mastery-payment-bridge",
        provider: "kiwify",
        configured: Boolean(APP_ID && (ACCESS_TOKEN || (BOT_EMAIL && BOT_PASSWORD)) && KIWIFY_SECRET && KIWIFY_PRODUCT_ID),
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
