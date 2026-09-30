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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
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
function hashAdminPassword(v) { return crypto.scryptSync(safeString(v), APP_ID || "ia-mastery-admin", 64).toString("hex"); }
function safeEqualText(a,b){ const aa=Buffer.from(String(a||"")); const bb=Buffer.from(String(b||"")); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); }
async function validAdminPassword(v){ const b=await client(); const rows=await b.entities.CommerceConfig.list(); const saved=rows[0]?.panel_access_hash || ""; if(saved) return safeEqualText(hashAdminPassword(v),saved); return Boolean(ADMIN_PASSWORD) && safeEqualText(v,ADMIN_PASSWORD); }

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
function adminLoginPage(){ return "<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>IA Mastery — Admin</title><style>\nbody{margin:0;font-family:Inter,Arial,sans-serif;background:#07111f;color:#eef4ff;display:grid;min-height:100vh;place-items:center}.box{width:min(420px,90vw);background:#0d1a2d;border:1px solid #243b62;border-radius:18px;padding:28px;box-shadow:0 20px 70px #0008}h1{margin:0 0 8px}p{color:#9fb0ca}input,button{width:100%;box-sizing:border-box;padding:13px;border-radius:10px;border:1px solid #29466f;background:#091525;color:white;margin-top:10px}button{background:linear-gradient(90deg,#1ea7ff,#7257ff);border:0;font-weight:700;cursor:pointer}.err{color:#ff8e8e;min-height:20px}\n</style></head><body><div class=\"box\"><h1>IA Mastery Academy</h1><p>Área administrativa restrita</p><input id=\"p\" type=\"password\" placeholder=\"Senha administrativa\"><button onclick=\"login()\">Entrar</button><div id=\"e\" class=\"err\"></div></div><script>\nasync function login(){const r=await fetch('/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});if(r.ok)location.reload();else document.getElementById('e').textContent='Senha inválida';}\n</script></body></html>"; }
function adminDashboardPage(){ return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IA Mastery — Administração</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Inter,Arial,sans-serif;background:#07111f;color:#eef4ff}
.app{display:grid;grid-template-columns:250px 1fr;min-height:100vh}.side{background:#0a1627;border-right:1px solid #203655;padding:22px;position:sticky;top:0;height:100vh}
.brand{font-size:22px;font-weight:850;line-height:1.05}.brand small{display:block;font-size:12px;color:#7fa7d8;margin-top:6px;font-weight:600}
.nav{display:grid;gap:8px;margin-top:28px}.nav button{width:100%;text-align:left;background:transparent;color:#b8c7dc;border:1px solid transparent;padding:12px;border-radius:10px;cursor:pointer;font-weight:650}
.nav button:hover,.nav button.active{background:#11253f;border-color:#274b78;color:white}.sidefoot{position:absolute;left:22px;right:22px;bottom:22px}
.main{padding:24px 30px;min-width:0}.top{display:flex;justify-content:space-between;align-items:center;gap:15px;margin-bottom:22px}.top h1{margin:0;font-size:26px}.muted{color:#91a5c2}
button,input,select,textarea{font:inherit}.btn{border:1px solid #2a466d;background:#0b1a2e;color:white;padding:10px 13px;border-radius:9px;cursor:pointer}.primary{background:linear-gradient(90deg,#1fa9ff,#7257ff);border:0;font-weight:750}.danger{background:#461722;border-color:#74283a}.successbtn{background:#123d2d;border-color:#28694e}
.cards{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:12px}.card,.panel{background:#0d1a2d;border:1px solid #203a61;border-radius:16px}.card{padding:17px}.card .n{font-size:30px;font-weight:850;margin-top:4px}
.panel{padding:18px;margin-top:16px}.section{display:none}.section.active{display:block}.panel h2{margin:0 0 5px;font-size:19px}.panel p{margin:0 0 14px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
label{display:grid;gap:6px;color:#b8c7dc;font-size:13px}input,select,textarea{width:100%;padding:10px 11px;border-radius:9px;border:1px solid #29466f;background:#091525;color:white}textarea{min-height:130px;resize:vertical}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.grow{flex:1}.quick{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
table{width:100%;border-collapse:collapse;min-width:840px}th,td{text-align:left;padding:10px;border-bottom:1px solid #1d3353;font-size:13px;vertical-align:middle}th{color:#8fa4c0}.tablewrap{overflow:auto}
.pill{display:inline-block;padding:4px 8px;border-radius:999px;background:#152945}.ok{color:#72e4a5}.warn{color:#ffd073}.red{color:#ff8c8c}.msg{margin-top:10px;min-height:20px;color:#82d4ff}
.callout{padding:14px;border-radius:12px;background:#0a2237;border:1px solid #1f5b8a}.callout strong{display:block;margin-bottom:5px}
.modal{position:fixed;inset:0;background:#000a;display:none;place-items:center;padding:20px;z-index:50}.modal.open{display:grid}.modalbox{width:min(900px,96vw);max-height:90vh;overflow:auto;background:#0d1a2d;border:1px solid #31527f;border-radius:16px;padding:18px}
@media(max-width:900px){.app{grid-template-columns:1fr}.side{height:auto;position:static;border-right:0;border-bottom:1px solid #203655}.sidefoot{position:static;margin-top:16px}.nav{grid-template-columns:1fr 1fr;margin-top:14px}.main{padding:18px}.cards{grid-template-columns:1fr 1fr}.grid2,.grid3{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}}
</style></head>
<body><div class="app">
<aside class="side"><div class="brand">IA Mastery Academy<small>PAINEL ADMINISTRATIVO</small></div>
<nav class="nav">
<button class="active" data-sec="dashboard" onclick="showSec('dashboard',this)">▦ Visão geral</button>
<button data-sec="access" onclick="showSec('access',this)">👤 Alunos e acessos</button>
<button data-sec="commercial" onclick="showSec('commercial',this)">💳 Comercial</button>
<button data-sec="content" onclick="showSec('content',this)">📚 Conteúdo</button>
<button data-sec="payments" onclick="showSec('payments',this)">↔ Pagamentos</button>
<button data-sec="security" onclick="showSec('security',this)">🔐 Segurança</button>
</nav><div class="sidefoot"><button class="btn" style="width:100%" onclick="logout()">Sair do painel</button></div></aside>
<main class="main"><div class="top"><div><h1 id="pageTitle">Visão geral</h1><div class="muted">Administrador: Rodrigo</div></div><button class="btn" onclick="load()">Atualizar dados</button></div>

<section id="dashboard" class="section active">
<div class="cards"><div class="card"><div class="muted">Usuários</div><div class="n" id="total">—</div></div><div class="card"><div class="muted">Ativos</div><div class="n ok" id="active">—</div></div><div class="card"><div class="muted">Trial</div><div class="n warn" id="trial">—</div></div><div class="card"><div class="muted">Revogados</div><div class="n red" id="revoked">—</div></div><div class="card"><div class="muted">Vendas</div><div class="n" id="sales">—</div></div></div>
<div class="panel"><h2>Ações rápidas</h2><p class="muted">As funções mais usadas ficam aqui.</p><div class="quick">
<button class="btn primary" onclick="go('access')">+ Liberar acesso</button><button class="btn" onclick="go('commercial')">Editar comercial</button><button class="btn" onclick="go('content')">Gerenciar módulos</button><button class="btn" onclick="go('payments')">Ver pagamentos</button></div></div>
<div class="panel"><div class="callout"><strong>Status operacional</strong><span id="systemStatus">Carregando…</span></div></div>
</section>

<section id="access" class="section">
<div class="panel"><h2>Liberar acesso manualmente</h2><p class="muted">Digite o e-mail. Se a pessoa já tiver cadastro, o acesso é liberado na hora. Se ainda não tiver, fica pré-liberado para ativação após o cadastro.</p>
<div class="grid3"><label>E-mail do aluno<input id="grantEmail" type="email" placeholder="aluno@email.com"></label><label>Tipo de acesso<select id="grantType"><option value="active">Acesso completo</option><option value="trial">Trial 7 dias</option></select></label><label>Plano<input id="grantPlan" value="launch-97"></label></div>
<div class="row" style="margin-top:12px"><button class="btn primary" onclick="grantAccess()">Liberar acesso</button><span id="grantMsg" class="msg"></span></div></div>
<div class="panel"><h2>Alunos cadastrados</h2><div class="row"><input id="q" class="grow" placeholder="Pesquisar nome ou e-mail" oninput="renderUsers()"><button class="btn" onclick="load()">Atualizar</button></div>
<div class="tablewrap"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Acesso</th><th>Plano</th><th>Validade</th><th>Alterar</th></tr></thead><tbody id="users"></tbody></table></div></div>
</section>

<section id="commercial" class="section">
<div class="panel"><h2>Configuração comercial</h2><p class="muted">Controle de preço, checkout e disponibilidade de vendas.</p>
<div class="grid2"><label>Preço exibido<input id="price"></label><label>Checkout Kiwify<input id="checkout"></label><label>Contato de suporte<input id="support"></label><label>Produto Kiwify<input id="productId" disabled></label></div>
<div class="row" style="margin-top:14px"><label style="display:flex;align-items:center;gap:8px"><input id="enabled" type="checkbox" style="width:auto"> Vendas habilitadas</label><button class="btn primary" onclick="saveCommercial()">Salvar alterações</button><span id="commercialMsg" class="msg"></span></div></div>
</section>

<section id="content" class="section">
<div class="panel"><h2>Conteúdo do curso</h2><p class="muted">Publicar, despublicar e editar os módulos.</p><div class="tablewrap"><table><thead><tr><th>#</th><th>Módulo</th><th>Status</th><th>Ações</th></tr></thead><tbody id="modules"></tbody></table></div></div>
</section>

<section id="payments" class="section">
<div class="panel"><h2>Eventos e pagamentos</h2><p class="muted">Últimos eventos recebidos da integração comercial.</p><div class="tablewrap"><table><thead><tr><th>Data</th><th>Evento</th><th>E-mail</th><th>Status</th><th>Ação</th></tr></thead><tbody id="events"></tbody></table></div></div>
</section>

<section id="security" class="section">
<div class="panel"><h2>Alterar senha do painel</h2><p class="muted">Troque a senha administrativa sem depender das contas técnicas.</p>
<div class="grid2"><label>Senha atual<input id="currentPass" type="password"></label><label>Nova senha<input id="newPass" type="password" placeholder="Mínimo de 8 caracteres"></label></div>
<div class="row" style="margin-top:12px"><button class="btn primary" onclick="changePassword()">Alterar senha</button><span id="passMsg" class="msg"></span></div></div>
<div class="panel"><h2>Sessão administrativa</h2><p class="muted">Use “Sair do painel” quando terminar. A área administrativa não é acessível sem autenticação.</p></div>
</section>
</main></div>

<div id="moduleModal" class="modal"><div class="modalbox"><div class="row" style="justify-content:space-between"><h2>Editar módulo</h2><button class="btn" onclick="closeModule()">Fechar</button></div>
<input id="modId" type="hidden"><div class="grid3"><label>Título PT<input id="mtpt"></label><label>Título ES<input id="mtes"></label><label>Título EN<input id="mten"></label></div>
<div class="grid3" style="margin-top:10px"><label>Subtítulo PT<input id="mspt"></label><label>Subtítulo ES<input id="mses"></label><label>Subtítulo EN<input id="msen"></label></div>
<div class="grid3" style="margin-top:10px"><label>Conteúdo PT<textarea id="mcpt"></textarea></label><label>Conteúdo ES<textarea id="mces"></textarea></label><label>Conteúdo EN<textarea id="mcen"></textarea></label></div>
<div class="row" style="margin-top:12px"><button class="btn primary" onclick="saveModule()">Salvar módulo</button><span id="moduleMsg" class="msg"></span></div></div></div>

<script>
let DATA=null;
const titles={dashboard:'Visão geral',access:'Alunos e acessos',commercial:'Comercial',content:'Conteúdo',payments:'Pagamentos',security:'Segurança'};
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]})}
function showSec(id,btn){document.querySelectorAll('.section').forEach(function(x){x.classList.remove('active')});document.getElementById(id).classList.add('active');document.querySelectorAll('.nav button').forEach(function(x){x.classList.remove('active')});if(btn)btn.classList.add('active');document.getElementById('pageTitle').textContent=titles[id]||id}
function go(id){const b=document.querySelector('[data-sec="'+id+'"]');showSec(id,b)}
async function api(url,opt){const r=await fetch(url,opt);if(r.status===401){location.reload();throw new Error('Sessão expirada')}const j=await r.json();if(!r.ok)throw new Error(j.error||'Erro');return j}
async function load(){DATA=await api('/admin/api/overview');total.textContent=DATA.stats.total;active.textContent=DATA.stats.active;trial.textContent=DATA.stats.trial;revoked.textContent=DATA.stats.revoked;sales.textContent=DATA.stats.sales;price.value=DATA.commercial.price_text||'';checkout.value=DATA.commercial.checkout_url||'';support.value=DATA.commercial.support_contact||'';productId.value=DATA.commercial.provider_product_id||'';enabled.checked=!!DATA.commercial.sales_enabled;systemStatus.textContent='Base44 conectado • '+DATA.modules.length+' módulos • Kiwify '+(DATA.commercial.webhook_mode||'')+' • vendas '+(DATA.commercial.sales_enabled?'ATIVAS':'DESATIVADAS');renderUsers();renderModules();renderEvents()}
function renderUsers(){if(!DATA)return;const q=(document.getElementById('q').value||'').toLowerCase();users.innerHTML=DATA.users.filter(function(u){return (u.email+' '+(u.full_name||'')).toLowerCase().includes(q)}).map(function(u){return '<tr><td>'+esc(u.full_name||'')+'</td><td>'+esc(u.email)+'</td><td><span class="pill">'+esc(u.course_access||'none')+'</span></td><td>'+esc(u.course_plan||'')+'</td><td>'+esc(u.access_expires_at||'')+'</td><td><select id="a_'+u.id+'"><option value="active">Ativo</option><option value="trial">Trial</option><option value="revoked">Revogado</option><option value="expired">Expirado</option><option value="none">Sem acesso</option></select> <button class="btn" onclick="setAccess(\''+u.id+'\',\''+esc(u.email)+'\')">Aplicar</button></td></tr>'}).join('')}
async function grantAccess(){grantMsg.textContent='Liberando...';try{const j=await api('/admin/api/grant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:grantEmail.value,access:grantType.value,plan:grantPlan.value,trial_days:7})});grantMsg.textContent=j.user_found?'Acesso liberado agora.':'Acesso pré-liberado. O aluno precisa criar a conta com esse mesmo e-mail.';await load()}catch(e){grantMsg.textContent='Erro: '+e.message}}
async function setAccess(id,email){const access=document.getElementById('a_'+id).value;let expires_at='';if(access==='trial'){const d=new Date();d.setDate(d.getDate()+7);expires_at=d.toISOString()}await api('/admin/api/access',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,email:email,access:access,plan:'launch-97',expires_at:expires_at})});await load()}
async function saveCommercial(){commercialMsg.textContent='Salvando...';try{await api('/admin/api/commercial',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({price_text:price.value,checkout_url:checkout.value,support_contact:support.value,sales_enabled:enabled.checked})});commercialMsg.textContent='Configuração salva.';await load()}catch(e){commercialMsg.textContent='Erro: '+e.message}}
function renderModules(){modules.innerHTML=DATA.modules.map(function(m){return '<tr><td>'+esc(m.order)+'</td><td>'+esc(m.title_pt)+'</td><td>'+(m.published?'<span class="ok">Publicado</span>':'<span class="warn">Oculto</span>')+'</td><td><button class="btn" onclick="editModule(\''+m.id+'\')">Editar</button> <button class="btn" onclick="toggleModule(\''+m.id+'\','+(!m.published)+')">'+(m.published?'Despublicar':'Publicar')+'</button></td></tr>'}).join('')}
async function toggleModule(id,published){await api('/admin/api/module',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,published:published})});await load()}
async function editModule(id){const m=await api('/admin/api/module?id='+encodeURIComponent(id));modId.value=m.id;mtpt.value=m.title_pt||'';mtes.value=m.title_es||'';mten.value=m.title_en||'';mspt.value=m.subtitle_pt||'';mses.value=m.subtitle_es||'';msen.value=m.subtitle_en||'';mcpt.value=m.content_pt||'';mces.value=m.content_es||'';mcen.value=m.content_en||'';moduleModal.classList.add('open')}
function closeModule(){moduleModal.classList.remove('open')}
async function saveModule(){moduleMsg.textContent='Salvando...';try{await api('/admin/api/module',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:modId.value,title_pt:mtpt.value,title_es:mtes.value,title_en:mten.value,subtitle_pt:mspt.value,subtitle_es:mses.value,subtitle_en:msen.value,content_pt:mcpt.value,content_es:mces.value,content_en:mcen.value})});moduleMsg.textContent='Módulo salvo.';await load()}catch(e){moduleMsg.textContent='Erro: '+e.message}}
function renderEvents(){events.innerHTML=DATA.events.map(function(e){return '<tr><td>'+esc(e.received_at||'')+'</td><td>'+esc(e.event_type||'')+'</td><td>'+esc(e.customer_email||'')+'</td><td>'+esc(e.status||'')+'</td><td>'+esc(e.action||'')+'</td></tr>'}).join('')}
async function changePassword(){passMsg.textContent='Alterando...';try{await api('/admin/api/change-password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({current_password:currentPass.value,new_password:newPass.value})});passMsg.textContent='Senha alterada com sucesso.';currentPass.value='';newPass.value=''}catch(e){passMsg.textContent='Erro: '+e.message}}
async function logout(){await fetch('/admin/logout',{method:'POST'});location.reload()}
load().catch(function(e){alert(e.message)});
</script></body></html>`; }
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
    if (e.status !== "active" || !["kiwify","manual"].includes(e.provider)) continue;
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
      const supplied = safeString(body.password);
      if (!supplied || !(await validAdminPassword(supplied))) return json(res, 401, { ok: false, error: "INVALID_CREDENTIALS" });
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
      await reconcile(b);
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
      if (["revoked","expired","none"].includes(body.access)) {
        const ents = await b.entities.Entitlement.list();
        const e = ents.find((x)=>norm(x.account_email)===norm(target.email));
        if (e) await b.entities.Entitlement.update(e.id,{status:"revoked",updated_at:new Date().toISOString()});
      }
      return json(res, 200, { ok:true, email:target.email, access:body.access });
    }

    if (req.method === "POST" && url.pathname === "/admin/api/grant") {
      const body = await parseJsonBody(req);
      const email = norm(body.email);
      const access = safeString(body.access || "active");
      const plan = safeString(body.plan || COURSE_PLAN);
      if (!email || !email.includes("@")) return json(res, 400, { ok:false, error:"EMAIL_INVALIDO" });
      if (!["active","trial"].includes(access)) return json(res, 400, { ok:false, error:"ACCESS_INVALID" });
      const b = await client();
      await enforceOwnerAdmin(b);
      const user = await userByEmail(b, email);
      let expires_at = "";
      if (access === "trial") {
        if (!user) return json(res, 400, { ok:false, error:"TRIAL_REQUER_USUARIO_CADASTRADO" });
        const d = new Date(); d.setDate(d.getDate() + Math.max(1, Number(body.trial_days || 7))); expires_at = d.toISOString();
      }
      if (user) await b.entities.User.update(user.id, { course_access: access, course_plan: plan, access_expires_at: expires_at });
      if (access === "active") {
        const rows = await b.entities.Entitlement.list();
        const existing = rows.find((x)=>norm(x.account_email)===email);
        const patch = { status:"active", plan, provider:"manual", external_reference:"manual:"+email, payment_reference:"manual", customer_reference:email, last_event_reference:"manual:"+Date.now(), course_version:COURSE_VERSION, course_payload_json:JSON.stringify({course:COURSE_KEY,version:COURSE_VERSION,modules:16}), granted_at:new Date().toISOString(), updated_at:new Date().toISOString() };
        if (existing) await b.entities.Entitlement.update(existing.id, patch); else await b.entities.Entitlement.create({account_email:email,...patch});
        if (!user) retryReconcile();
      }
      return json(res, 200, { ok:true, user_found:Boolean(user), email, access });
    }
    if (req.method === "POST" && url.pathname === "/admin/api/change-password") {
      const body = await parseJsonBody(req);
      if (!(await validAdminPassword(body.current_password))) return json(res, 400, { ok:false, error:"SENHA_ATUAL_INCORRETA" });
      const next = safeString(body.new_password);
      if (next.length < 8) return json(res, 400, { ok:false, error:"NOVA_SENHA_MINIMO_8_CARACTERES" });
      const b = await client();
      const rows = await b.entities.CommerceConfig.list();
      if (!rows[0]) return json(res, 404, { ok:false, error:"COMMERCE_CONFIG_NOT_FOUND" });
      await b.entities.CommerceConfig.update(rows[0].id, { panel_access_hash: hashAdminPassword(next), updated_at:new Date().toISOString() });
      return json(res, 200, { ok:true });
    }
    if (req.method === "GET" && url.pathname === "/admin/api/module") {
      const b = await client();
      const modules = await b.entities.CourseModule.list();
      const target = modules.find((m)=>m.id===url.searchParams.get("id"));
      if (!target) return json(res, 404, { ok:false, error:"MODULE_NOT_FOUND" });
      return json(res, 200, target);
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
