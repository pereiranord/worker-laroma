// ============================================================
//  🍕 WORKER — PIZZARIA LA ROMA
//  Cloudflare Workers
//
//  Variáveis de ambiente necessárias (Settings > Variables):
//    AIRTABLE_BASE_ID   → ID da base Airtable (ex: appe1UN4...)
//    AIRTABLE_API_KEY   → Token pessoal do Airtable
//    ADMIN_SENHA        → Senha do painel admin
//    ADMIN_TOKEN        → Token estático para autenticar o admin
// ============================================================

const AIRTABLE_API = "https://api.airtable.com/v0";

// ─── Cabeçalhos CORS ────────────────────────────────────────
const CORS = {
"Access-Control-Allow-Origin": "*",
"Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
"Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ─── Helpers ────────────────────────────────────────────────
function json(data, status = 200) {
return new Response(JSON.stringify(data), {
status,
headers: { ...CORS, "Content-Type": "application/json" },
});
}

function error(message, status = 400, extra = {}) {
return json({ ok: false, error: message, ...extra }, status);
}

async function airtableFetch(env, path, options = {}) {
const res = await fetch(`${AIRTABLE_API}/${env.AIRTABLE_BASE_ID}/${path}`, {
...options,
headers: {
Authorization: `Bearer ${env.AIRTABLE_API_KEY}`,
"Content-Type": "application/json",
...(options.headers || {}),
},
});

const data = await res.json();
return { data, status: res.status };
}

// Mapeia um record de produto para o formato limpo do front-end
function mapProduto(r) {
const f = r.fields;

return {
id: r.id,
nome: f["Nome"] ?? f["Nome da variação"] ?? "",
descricao: f["Descrição"] ?? "",
preco: f["Preço"] ?? 0,
imagem:
f["Imagem"]?.[0]?.thumbnails?.large?.url ??
f["Imagem"]?.[0]?.url ??
null,
adicionais_ids: f["Relacionamento Adicionais"] ?? [],
bordas_ids: f["Relacionamento Bordas"] ?? [],
bebida_id: f["Bebida"] ?? [],        // só para Variações de Bebidas
variacoes_ids: f["Variações de Bebidas"] ?? [], // só para Bebidas
};
}

// Verifica se o token admin é válido
function isAdmin(request, env) {
const auth = request.headers.get("Authorization") ?? "";
return auth === `Bearer ${env.ADMIN_TOKEN}`;
}

// ─── Handler principal ───────────────────────────────────────
export default {
async fetch(request, env) {
const url = new URL(request.url);

const path = url.pathname.replace(/\/$/, "");
const segments = path.split("/").filter(Boolean);
const method = request.method;

if (method === "OPTIONS") {
return new Response(null, { headers: CORS });
}

if (segments[0] !== "login" && segments[0] !== "") {
if (!env.AIRTABLE_BASE_ID || !env.AIRTABLE_API_KEY) {
return error("Variáveis AIRTABLE_BASE_ID ou AIRTABLE_API_KEY não configuradas", 500);
}
}

// ===========================================================
// GET /
// ===========================================================
if (path === "" || path === "/") {
return json({
status: "🍕 API Pizzaria LA ROMA ativa",
rotas: {
"GET  /menu": "Cardápio completo",
"GET  /config": "Configurações da pizzaria",
"POST /login": "Login do admin",
"POST /pedido": "Criar novo pedido",
"GET  /pedidos": "Listar pedidos (admin)",
"GET  /pedidos/:id": "Detalhe de um pedido (admin)",
"PATCH /pedidos/:id": "Atualizar status do pedido (admin)",
},
});
}

// ===========================================================
// GET /menu
// ===========================================================
if (path === "/menu" && method === "GET") {
const tables = [
"Pizzas Grandes",
"Pizzas Médias",
"Brotinhos",
"Esfirras",
"Bebidas",
"Variações de Bebidas",
"Adicionais",
"Bordas",
];

try {
const responses = await Promise.all(
tables.map((table) =>
airtableFetch(env, encodeURIComponent(table)).then(
({ data, status }) => ({
table,
data,
status,
})
)
)
);

const menu = {};

for (const { table, data, status } of responses) {
if (data.error || !data.records) {
return error(`Erro na tabela "${table}"`, 500, {
airtable_error: data.error ?? "sem records",
airtable_status: status,
});
}

const key = table
.normalize("NFD")
.replace(/[\u0300-\u036f]/g, "")
.replace(/\s+/g, "_")
.toLowerCase();

menu[key] = data.records.map(mapProduto);
}

return json({ ok: true, menu });
} catch (err) {
return error("Erro ao buscar menu", 500, { details: err.message });
}
}

// ===========================================================
// GET /config
// ===========================================================
if (path === "/config" && method === "GET") {
try {
const { data, status } = await airtableFetch(
env,
encodeURIComponent("Configurações do Sistema")
);

if (data.error || !data.records) {
return error("Erro na tabela Configurações do Sistema", 500, {
airtable_error: data.error ?? "sem records",
airtable_status: status,
});
}

const config = data.records[0]?.fields ?? {};

return json({
ok: true,
config: {
taxa_entrega: config["Taxa de entrega"] ?? 0,
pedido_minimo: config["Pedido mínimo"] ?? 0,
hora_abertura: config["Hora abertura"] ?? "00:00",
hora_fechamento: config["Hora fechamento"] ?? "23:59",
},
});
} catch (err) {
return error("Erro ao buscar configurações", 500, {
details: err.message,
});
}
}

// Adicionar ao worker após a rota /config:

// ===========================================================
// GET /promocoes — Promoções ativas
// ===========================================================
if (path === "/promocoes" && method === "GET") {
  try {
    const { data } = await airtableFetch(env, encodeURIComponent("Promoções"));
    if (data.error || !data.records) return json({ ok: true, promocoes: [] });
    const promocoes = data.records.map(r => ({
      id: r.id,
      nome: r.fields["Nome"] ?? "",
      preco_promocional: r.fields["Preco Promocional"] ?? 0,
      dias_ativos: (r.fields["Dias Ativos"] ?? []).map(d => d.name ?? d),
      ativo: r.fields["Ativo"] ?? false,
      pizza_grande_ids: (r.fields["Pizza Grande"] ?? []),
      pizza_media_ids: (r.fields["Pizza Media"] ?? []),
      brotinho_ids: (r.fields["Brotinho"] ?? []),
      esfirra_ids: (r.fields["Esfirra"] ?? []),
    }));
    return json({ ok: true, promocoes });
  } catch (err) {
    return json({ ok: true, promocoes: [] });
  }
}

// ===========================================================
// GET /dias-fechados — Dias em que a pizzaria está fechada
// ===========================================================
if (path === "/dias-fechados" && method === "GET") {
  try {
    const { data } = await airtableFetch(env, encodeURIComponent("Dias Fechados"));
    if (data.error || !data.records) return json({ ok: true, dias: [] });
    const dias = data.records.map(r => ({
      id: r.id,
      descricao: r.fields["Descricao"] ?? "",
      dia: r.fields["Dia da Semana"]?.name ?? r.fields["Dia da Semana"] ?? "",
      ativo: r.fields["Ativo"] ?? false,
      mensagem: r.fields["Mensagem"] ?? "",
    }));
    return json({ ok: true, dias });
  } catch (err) {
    return json({ ok: true, dias: [] });
  }
}


// ===========================================================
// POST /login
// ===========================================================
if (path === "/login" && method === "POST") {
let body;

try {
body = await request.json();
} catch {
return error("Body inválido — envie JSON com { senha }");
}

if (!body.senha) {
return error("Campo 'senha' é obrigatório");
}

if (!env.ADMIN_SENHA || !env.ADMIN_TOKEN) {
return error("ADMIN_SENHA ou ADMIN_TOKEN não configurados no Worker", 500);
}

if (body.senha !== env.ADMIN_SENHA) {
return error("Senha incorreta", 401);
}

return json({ ok: true, token: env.ADMIN_TOKEN });
}

// ===========================================================
// POST /pedido
// ===========================================================
if (path === "/pedido" && method === "POST") {
let body;

try {
body = await request.json();
} catch {
return error("Body inválido — envie JSON");
}

const camposObrigatorios = [
"nome",
"telefone",
"endereco",
"pagamento",
"itens",
];

for (const campo of camposObrigatorios) {
if (!body[campo]) {
return error(`Campo '${campo}' é obrigatório`);
}
}

if (!Array.isArray(body.itens) || body.itens.length === 0) {
return error("O pedido deve ter pelo menos 1 item em 'itens'");
}

try {
const { data: pedidoCriado, status: pedidoStatus } =
await airtableFetch(env, "Pedidos", {
method: "POST",
body: JSON.stringify({
fields: {
"Nome Cliente": body.nome,
"Telefone": body.telefone,
"Endereço": body.endereco,
"Pagamento": body.pagamento,
"Status": "Aguardando",
"Data": new Date().toISOString().split("T")[0],
"Taxa de entrega": body.taxa_entrega ?? 0,
},
}),
});

if (pedidoCriado.error || !pedidoCriado.id) {
return error("Erro ao criar pedido no Airtable", 500);
}

const pedidoRecordId = pedidoCriado.id;
const idPedido = pedidoCriado.fields?.["ID Pedido"];

const itensCriados = await Promise.all(
body.itens.map((item) => {
const linksItem = {};

if (item.pizza_grande_id)
linksItem["Pizza Grande"] = [item.pizza_grande_id];

if (item.pizza_media_id)
linksItem["Pizza Média"] = [item.pizza_media_id];

if (item.brotinho_id)
linksItem["Brotinho"] = [item.brotinho_id];

if (item.esfirra_id)
linksItem["Esfirra"] = [item.esfirra_id];

if (item.bebida_id)
linksItem["Bebida"] = [item.bebida_id];

if (item.variacao_bebida_id)
linksItem["Variação Bebida"] = [item.variacao_bebida_id];

if (item.adicional_ids?.length)
linksItem["Adicionais"] = item.adicional_ids;

if (item.borda_ids?.length)
linksItem["Bordas"] = item.borda_ids;

return airtableFetch(env, encodeURIComponent("Itens do Pedido"), {
method: "POST",
body: JSON.stringify({
fields: {
"Nome": item.nome ?? "Item",
"Pedido": [pedidoRecordId],
"Quantidade": item.quantidade ?? 1,
"Preço": item.preco ?? 0,
...linksItem,
},
}),
});
})
);

const itensFalhos = itensCriados
.map(({ data }, i) =>
data.error ? { item: i, erro: data.error } : null
)
.filter(Boolean);

if (itensFalhos.length > 0) {
return error("Pedido criado com erros nos itens", 207, {
id_pedido: idPedido,
pedido_record_id: pedidoRecordId,
itens_com_erro: itensFalhos,
});
}

return json(
{
ok: true,
id_pedido: idPedido,
pedido_record_id: pedidoRecordId,
total_itens: body.itens.length,
},
201
);
} catch (err) {
return error("Erro interno ao criar pedido", 500, {
details: err.message,
});
}
}

// ===========================================================
// GET /pedidos
// ===========================================================
if (path === "/pedidos" && method === "GET") {
if (!isAdmin(request, env)) {
return error("Não autorizado", 401);
}

try {
const status = url.searchParams.get("status");
const limite = url.searchParams.get("limite") ?? "50";
const paginacao = url.searchParams.get("offset") ?? "";

let airtableQuery = `?sort[0][field]=ID Pedido&sort[0][direction]=desc&pageSize=${limite}`;

if (status) {
airtableQuery += `&filterByFormula={Status}="${status}"`;
}

if (paginacao) {
airtableQuery += `&offset=${paginacao}`;
}

const { data, status: httpStatus } = await airtableFetch(
env,
`Pedidos${encodeURI(airtableQuery)}`
);

if (data.error || !data.records) {
return error("Erro ao listar pedidos", 500);
}

const pedidos = data.records.map((r) => ({
record_id: r.id,
id_pedido: r.fields["ID Pedido"],
nome_cliente: r.fields["Nome Cliente"],
telefone: r.fields["Telefone"],
endereco: r.fields["Endereço"],
status: r.fields["Status"],
pagamento: r.fields["Pagamento"],
taxa_entrega: r.fields["Taxa de entrega"] ?? 0,
total: r.fields["Total"] ?? 0,
data: r.fields["Data"],
itens_ids: r.fields["Itens do Pedido"] ?? [],
}));

return json({
ok: true,
total: pedidos.length,
offset_proximo: data.offset ?? null,
pedidos,
});
} catch (err) {
return error("Erro ao listar pedidos", 500);
}
}

// ===========================================================
// GET /pedidos/:id
// ===========================================================
if (segments[0] === "pedidos" && segments[1] && method === "GET") {
if (!isAdmin(request, env)) {
return error("Não autorizado", 401);
}

const recordId = segments[1];

try {
const { data: pedidoData } = await airtableFetch(
env,
`Pedidos/${recordId}`
);

if (pedidoData.error) {
return error("Pedido não encontrado", 404);
}

const itensIds = pedidoData.fields?.["Itens do Pedido"] ?? [];
let itens = [];

if (itensIds.length > 0) {
const filterFormula = `OR(${itensIds
.map((id) => `RECORD_ID()="${id}"`)
.join(",")})`;

const { data: itensData } = await airtableFetch(
env,
`${encodeURIComponent(
"Itens do Pedido"
)}?filterByFormula=${encodeURIComponent(filterFormula)}`
);

if (itensData.records) {
itens = itensData.records.map((r) => ({
id: r.id,
nome: r.fields["Nome"],
quantidade: r.fields["Quantidade"],
preco: r.fields["Preço"],
subtotal: r.fields["Subtotal"],
}));
}
}

return json({
ok: true,
pedido: {
record_id: pedidoData.id,
id_pedido: pedidoData.fields["ID Pedido"],
nome_cliente: pedidoData.fields["Nome Cliente"],
telefone: pedidoData.fields["Telefone"],
endereco: pedidoData.fields["Endereço"],
status: pedidoData.fields["Status"],
pagamento: pedidoData.fields["Pagamento"],
taxa_entrega: pedidoData.fields["Taxa de entrega"] ?? 0,
total: pedidoData.fields["Total"] ?? 0,
data: pedidoData.fields["Data"],
itens,
},
});
} catch (err) {
return error("Erro ao buscar pedido", 500);
}
}

// ===========================================================
// PATCH /pedidos/:id
// ===========================================================
if (segments[0] === "pedidos" && segments[1] && method === "PATCH") {
if (!isAdmin(request, env)) {
return error("Não autorizado", 401);
}

const recordId = segments[1];

let body;

try {
body = await request.json();
} catch {
return error("Body inválido — envie JSON com { status }");
}

const statusValidos = [
"Aguardando",
"Em preparo",
"Saiu para entrega",
"Entregue",
"Cancelado",
];

if (!body.status) {
return error("Campo 'status' é obrigatório");
}

if (!statusValidos.includes(body.status)) {
return error(`Status inválido. Use: ${statusValidos.join(", ")}`);
}

try {
const { data, status: httpStatus } = await airtableFetch(
env,
`Pedidos/${recordId}`,
{
method: "PATCH",
body: JSON.stringify({
fields: { Status: body.status },
}),
}
);

if (data.error) {
return error("Erro ao atualizar pedido", 500);
}

return json({
ok: true,
record_id: data.id,
status_novo: data.fields["Status"],
});
} catch (err) {
return error("Erro ao atualizar pedido", 500);
}
}

// ===========================================================
// 404
// ===========================================================
return json({ ok: false, error: `Rota '${path}' não encontrada` }, 404);
},
};