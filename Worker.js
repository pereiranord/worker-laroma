// ═══════════════════════════════════════════════════════════════════
//  WORKER — LA ROMA  v5.1
//  Cloudflare Workers
//
//  ENV VARS (Settings › Variables › Secrets):
//    AIRTABLE_BASE_ID  → appe1UN4tqImejQXR
//    AIRTABLE_API_KEY  → Token pessoal Airtable
//    ADMIN_SENHA       → Senha do painel admin
//    ADMIN_TOKEN       → Token retornado no login admin
//    FIREBASE_API_KEY  → AIzaSyCASqAMf5fiC7theEZHzAukG20J0FvdVUc
// ═══════════════════════════════════════════════════════════════════

const AT_BASE = 'https://api.airtable.com/v0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

// ── Helpers de resposta ──────────────────────────────────────────
const ok  = (d, s=200) => new Response(JSON.stringify(d), { status:s, headers:{...CORS,'Content-Type':'application/json'} });
const err = (m, s=400, x={}) => ok({ ok:false, error:m, ...x }, s);

// ── Airtable fetch ───────────────────────────────────────────────
async function at(env, path, opts={}) {
  const res = await fetch(`${AT_BASE}/${env.AIRTABLE_BASE_ID}/${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${env.AIRTABLE_API_KEY}`,
      'Content-Type':  'application/json',
      ...(opts.headers || {}),
    },
  });
  const data = await res.json();
  return { data, status: res.status };
}

// ── CORRIGIDO: atRetry agora sempre retorna o último resultado ───
async function atR(env, path, opts={}, tries=2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await at(env, path, opts);
      return r; // retorna sempre, mesmo com error — quem chama decide
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 400));
    }
  }
  throw lastErr;
}

// ── Firebase Token Validation ───────────────────────────────────
async function verifyFirebase(token, env) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ idToken: token }) }
  );
  const d = await res.json();
  if (d.error || !d.users?.[0]) return null;
  const u = d.users[0];
  return { uid: u.localId, email: u.email||'', name: u.displayName||'', photo: u.photoUrl||'' };
}

// ── Admin check ──────────────────────────────────────────────────
const isAdmin = (req, env) =>
  (req.headers.get('Authorization') || '') === `Bearer ${env.ADMIN_TOKEN}`;

// ── Normaliza nome de tabela → chave do menu ─────────────────────
const toKey = t => t.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'_').toLowerCase();

// ── Mapeia record de produto ──────────────────────────────────────
function mapProduto(r) {
  const f = r.fields;
  return {
    id:             r.id,
    nome:           f['Nome'] ?? f['Nome da variação'] ?? '',
    descricao:      f['Descrição'] ?? '',
    preco:          f['Preço'] ?? 0,
    ativo:          f['Ativo'] ?? false,
    ordem:          f['Ordem'] ?? null,
    destaque:       f['Destaque'] ?? false,
    categoria:      f['Categoria']?.name ?? f['Categoria'] ?? '',
    imagem:         f['Imagem']?.[0]?.url ?? null,
    imagem_thumb:   f['Imagem']?.[0]?.thumbnails?.large?.url ?? null,
    adicionais_ids: f['Relacionamento Adicionais'] ?? [],
    bordas_ids:     f['Relacionamento Bordas'] ?? [],
    bebida_id:      f['Bebida'] ?? [],
    tipo:           f['Tipo']?.name ?? f['Tipo'] ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname.replace(/\/+$/, '') || '/';
    const seg    = path.split('/').filter(Boolean);
    const method = request.method;

    // Preflight
    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    // Valida env para rotas que usam Airtable
    if (seg.length && !['login','auth'].includes(seg[0])) {
      if (!env.AIRTABLE_BASE_ID || !env.AIRTABLE_API_KEY)
        return err('Variáveis AIRTABLE não configuradas', 500);
    }

    // ── GET / ────────────────────────────────────────────────────
    if (path === '/') {
      return ok({ ok:true, service:'La Roma API', version:'5.1',
        rotas: {
          publicas: ['GET /site','GET /config','GET /menu','GET /promocoes','GET /dias-fechados'],
          cliente:  ['POST /auth/google','POST /pedido','GET /meus-pedidos?uid=','GET /meus-pedidos/:id/itens?uid=','GET /status-pedido/:id?uid=','GET /cupom/validar?codigo='],
          admin:    ['POST /login','GET /pedidos','GET /pedidos/:id','PATCH /pedidos/:id'],
        }
      });
    }

    // ── GET /site ────────────────────────────────────────────────
    if (path === '/site' && method === 'GET') {
      try {
        const { data } = await atR(env, encodeURIComponent('Configurações do Site'));
        if (!data.records) return ok({ ok:true, site:{} });
        const site = {};
        for (const r of data.records)
          if (r.fields['Chave']) site[r.fields['Chave']] = r.fields['Valor'] ?? '';
        return ok({ ok:true, site });
      } catch { return ok({ ok:true, site:{} }); }
    }

    // ── GET /config ──────────────────────────────────────────────
    if (path === '/config' && method === 'GET') {
      try {
        const { data } = await atR(env, encodeURIComponent('Configurações do Sistema'));
        if (!data.records?.length) return err('Sem registros de config', 404);
        const f = data.records[0].fields;
        return ok({ ok:true, config: {
          taxa_entrega:    f['Taxa de entrega']  ?? 5,
          pedido_minimo:   f['Pedido mínimo']    ?? 25,
          hora_abertura:   f['Hora abertura']    ?? '18:00',
          hora_fechamento: f['Hora fechamento']  ?? '23:59',
          tempo_espera:    f['Tempo de espera']  ?? '30-50 min',
        }});
      } catch(e) { return err('Erro ao buscar config', 500, { details: e.message }); }
    }

    // ── GET /menu ────────────────────────────────────────────────
    // 7 tabelas em paralelo — filtra Ativo=true OU campo ausente
    if (path === '/menu' && method === 'GET') {
      const TABELAS = [
        'Pizzas Grandes', 'Brotinhos', 'Esfirras',
        'Bebidas', 'Variações de Bebidas', 'Adicionais', 'Bordas',
      ];
      try {
        const results = await Promise.all(
          TABELAS.map(t =>
            atR(env, encodeURIComponent(t))
              .then(({ data, status }) => ({ t, data, status }))
          )
        );
        const menu = {};
        for (const { t, data, status } of results) {
          if (data.error || !data.records) {
            return err(`Erro na tabela "${t}"`, 500, { airtable: data.error, status });
          }
          // Inclui: Ativo=true OU campo Ativo não existe no registro (retrocompat)
          menu[toKey(t)] = data.records
            .filter(r => r.fields['Ativo'] === true || !('Ativo' in r.fields))
            .map(mapProduto);
        }
        return ok({ ok:true, menu });
      } catch(e) { return err('Erro ao buscar menu', 500, { details: e.message }); }
    }

    // ── GET /promocoes ───────────────────────────────────────────
    if (path === '/promocoes' && method === 'GET') {
      try {
        const { data } = await atR(env, encodeURIComponent('Promoções'));
        if (!data.records) return ok({ ok:true, promocoes:[] });
        const promocoes = data.records
          .filter(r => r.fields['Ativo'] === true)
          .map(r => ({
            id:               r.id,
            nome:             r.fields['Nome'] ?? '',
            preco_promocional: r.fields['Preco Promocional'] ?? 0,
            dias_ativos:      (r.fields['Dias Ativos'] ?? []).map(d => d.name ?? d),
            pizza_grande_ids: r.fields['Pizza Grande'] ?? [],
            brotinho_ids:     r.fields['Brotinho']     ?? [],
            esfirra_ids:      r.fields['Esfirra']      ?? [],
          }));
        return ok({ ok:true, promocoes });
      } catch { return ok({ ok:true, promocoes:[] }); }
    }

    // ── GET /dias-fechados ───────────────────────────────────────
    if (path === '/dias-fechados' && method === 'GET') {
      try {
        const { data } = await atR(env, encodeURIComponent('Dias Fechados'));
        if (!data.records) return ok({ ok:true, dias:[] });
        const dias = data.records
          .filter(r => r.fields['Ativo'] === true)
          .map(r => ({
            id:       r.id,
            dia:      r.fields['Dia da Semana']?.name ?? r.fields['Dia da Semana'] ?? '',
            mensagem: r.fields['Mensagem'] ?? '',
          }));
        return ok({ ok:true, dias });
      } catch { return ok({ ok:true, dias:[] }); }
    }

    // ── POST /auth/google ────────────────────────────────────────
    if (path === '/auth/google' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return err('Body JSON inválido'); }
      if (!body.token) return err("Campo 'token' obrigatório");
      if (!env.FIREBASE_API_KEY) return err('FIREBASE_API_KEY não configurado', 500);
      try {
        const fb = await verifyFirebase(body.token, env);
        if (!fb) return err('Token Firebase inválido', 401);

        const { data: found } = await at(env,
          `Clientes?filterByFormula={UID Firebase}="${fb.uid}"`);
        let record_id, created;

        if (found.records?.length > 0) {
          record_id = found.records[0].id; created = false;
          await at(env, `Clientes/${record_id}`, {
            method: 'PATCH',
            body: JSON.stringify({ fields:{ Nome: fb.name, 'Foto URL': fb.photo } }),
          });
        } else {
          const { data: nr } = await at(env, 'Clientes', {
            method: 'POST',
            body: JSON.stringify({ fields:{
              Nome: fb.name, Email: fb.email, 'UID Firebase': fb.uid,
              'Foto URL': fb.photo, 'Tipo de Login': 'Google',
              Ativo: true, 'Criado em': new Date().toISOString().split('T')[0],
            }}),
          });
          record_id = nr.id; created = true;
        }
        return ok({ ok:true, created, user:{ uid:fb.uid, email:fb.email, name:fb.name, photo:fb.photo, record_id } });
      } catch(e) { return err('Erro na autenticação', 500, { details: e.message }); }
    }

    // ── GET /cupom/validar?codigo= ───────────────────────────────
    if (path === '/cupom/validar' && method === 'GET') {
      const codigo = url.searchParams.get('codigo')?.trim().toUpperCase();
      if (!codigo) return err("Parâmetro 'codigo' obrigatório");
      try {
        const { data } = await at(env,
          `Cupons?filterByFormula=AND({Codigo}="${codigo}",{Ativo}=1)`);
        if (!data.records?.length) return err('Cupom não encontrado ou inativo', 404);
        const c = data.records[0], f = c.fields;
        if (f['Valido Ate']) {
          const exp = new Date(f['Valido Ate'] + 'T23:59:59-03:00');
          if (new Date() > exp) return err('Cupom expirado', 400);
        }
        const maxU = f['Usos Maximos'] ?? 0, curU = f['Usos Atuais'] ?? 0;
        if (maxU > 0 && curU >= maxU) return err('Cupom esgotado', 400);
        const sub = parseFloat(url.searchParams.get('subtotal') || '0');
        const minP = f['Pedido Minimo'] ?? 0;
        if (sub > 0 && minP > 0 && sub < minP)
          return err(`Pedido mínimo para este cupom: R$ ${minP.toFixed(2)}`, 400);
        return ok({ ok:true, cupom:{
          id: c.id, Codigo: f['Codigo'],
          Tipo:          f['Tipo']?.name ?? f['Tipo'],
          Valor:         f['Valor']      ?? 0,
          Percentual:    f['Percentual'] ?? 0,
          Pedido_minimo: f['Pedido Minimo'] ?? 0,
          Descricao:     f['Descricao']  ?? '',
        }});
      } catch(e) { return err('Erro ao validar cupom', 500, { details: e.message }); }
    }

    // ── POST /pedido ─────────────────────────────────────────────
    if (path === '/pedido' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return err('Body JSON inválido'); }
      for (const c of ['nome','telefone','endereco','pagamento','itens'])
        if (!body[c]) return err(`Campo '${c}' obrigatório`);
      if (!Array.isArray(body.itens) || !body.itens.length)
        return err('Pedido deve ter pelo menos 1 item');
      try {
        const pf = {
          'Nome Cliente':    body.nome,
          'Telefone':        body.telefone,
          'Endereço':        body.endereco,
          'Pagamento':       body.pagamento,
          'Status':          'Aguardando',
          'Data e Hora':     new Date().toISOString(),
          'Taxa de entrega': body.taxa_entrega ?? 0,
          'Total':           body.total        ?? 0,
          'Firebase UID':    body.firebase_uid ?? '',
          'Troco Para':      body.troco_para   ?? 0,
          'Canal de Venda':  'Site',
          'Observacao':      body.observacao   ?? '',
        };
        if (body.cliente_record_id) pf['Cliente'] = [body.cliente_record_id];
        if (body.cupom_record_id) {
          pf['Cupom'] = [body.cupom_record_id];
          pf['Desconto Cupom'] = body.desconto_cupom ?? 0;
        }
        const { data: pedido } = await at(env, 'Pedidos', {
          method: 'POST', body: JSON.stringify({ fields: pf }),
        });
        if (pedido.error || !pedido.id)
          return err('Erro ao criar pedido', 500, { airtable: pedido.error });
        const pid = pedido.id;
        const iRes = await Promise.all(body.itens.map(i =>
          at(env, encodeURIComponent('Itens do Pedido'), {
            method: 'POST',
            body: JSON.stringify({ fields:{
              Nome: i.nome ?? 'Item', Pedido: [pid],
              Quantidade: i.quantidade ?? 1, Preço: i.preco ?? 0,
              Detalhes: i.detalhes ?? '',
            }}),
          })
        ));
        const erros = iRes.map(({ data },i) => data.error ? {i, e: data.error} : null).filter(Boolean);
        return ok({ ok:true, pedido_id: pid, erros_itens: erros }, 201);
      } catch(e) { return err('Erro ao criar pedido', 500, { details: e.message }); }
    }

    // ── GET /meus-pedidos?uid= ───────────────────────────────────
    if (path === '/meus-pedidos' && method === 'GET') {
      const uid = url.searchParams.get('uid');
      if (!uid) return err("Parâmetro 'uid' obrigatório");
      try {
        const { data } = await at(env,
          `Pedidos?filterByFormula={Firebase UID}="${uid}"&sort[0][field]=Data e Hora&sort[0][direction]=desc&pageSize=30`);
        if (!data.records) return ok({ ok:true, pedidos:[] });
        return ok({ ok:true, pedidos: data.records.map(r => ({
          id:           r.id,
          status:       r.fields['Status'],
          pagamento:    r.fields['Pagamento'],
          endereco:     r.fields['Endereço'],
          taxa_entrega: r.fields['Taxa de entrega'] ?? 0,
          total:        r.fields['Total']           ?? 0,
          data_hora:    r.fields['Data e Hora'],
          itens_ids:    r.fields['Itens do Pedido'] ?? [],
        }))});
      } catch { return err('Erro ao buscar pedidos', 500); }
    }

    // ── GET /meus-pedidos/:id/itens?uid= ─────────────────────────
    if (seg[0]==='meus-pedidos' && seg[1] && seg[2]==='itens' && method==='GET') {
      const uid = url.searchParams.get('uid');
      if (!uid) return err("Parâmetro 'uid' obrigatório");
      try {
        const { data: pd } = await at(env, `Pedidos/${seg[1]}`);
        if (pd.error) return err('Pedido não encontrado', 404);
        if (pd.fields['Firebase UID'] !== uid) return err('Acesso negado', 403);
        const ids = pd.fields?.['Itens do Pedido'] ?? [];
        let itens = [];
        if (ids.length) {
          const f = `OR(${ids.map(id=>`RECORD_ID()="${id}"`).join(',')})`;
          const { data: id_ } = await at(env,
            `${encodeURIComponent('Itens do Pedido')}?filterByFormula=${encodeURIComponent(f)}`);
          if (id_.records)
            itens = id_.records.map(r => ({
              id: r.id, nome: r.fields['Nome'],
              quantidade: r.fields['Quantidade'], preco: r.fields['Preço'],
            }));
        }
        return ok({ ok:true, pedido:{
          id: pd.id, status: pd.fields['Status'], pagamento: pd.fields['Pagamento'],
          endereco: pd.fields['Endereço'], taxa_entrega: pd.fields['Taxa de entrega'] ?? 0,
          total: pd.fields['Total'] ?? 0, data_hora: pd.fields['Data e Hora'], itens,
        }});
      } catch { return err('Erro ao buscar pedido', 500); }
    }

    // ── GET /status-pedido/:id?uid= ──────────────────────────────
    // Endpoint leve para polling a cada 3s
    if (seg[0]==='status-pedido' && seg[1] && method==='GET') {
      const uid = url.searchParams.get('uid');
      if (!uid) return err("Parâmetro 'uid' obrigatório");
      try {
        const { data } = await at(env,
          `Pedidos/${seg[1]}?fields[]=Status&fields[]=Firebase UID`);
        if (data.error) return err('Pedido não encontrado', 404);
        if (data.fields['Firebase UID'] !== uid) return err('Acesso negado', 403);
        return ok({ ok:true, status: data.fields['Status'] });
      } catch { return err('Erro ao buscar status', 500); }
    }

    // ════════════════════════════════════════════════════════════
    //  ROTAS ADMIN
    // ════════════════════════════════════════════════════════════

    // ── POST /login ──────────────────────────────────────────────
    if (path === '/login' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return err('Body inválido'); }
      if (!body.senha) return err("Campo 'senha' obrigatório");
      if (!env.ADMIN_SENHA || !env.ADMIN_TOKEN) return err('Variáveis ADMIN não configuradas', 500);
      if (body.senha !== env.ADMIN_SENHA) return err('Senha incorreta', 401);
      return ok({ ok:true, token: env.ADMIN_TOKEN });
    }

    // ── GET /pedidos (admin) — lista com filtro opcional de status ─
    if (path === '/pedidos' && method === 'GET') {
      if (!isAdmin(request, env)) return err('Não autorizado', 401);
      try {
        const sq  = url.searchParams.get('status');
        const lm  = url.searchParams.get('limite') ?? '50';
        const off = url.searchParams.get('offset') ?? '';
        let q = `sort[0][field]=Data e Hora&sort[0][direction]=desc&pageSize=${lm}`;
        if (sq)  q += `&filterByFormula={Status}="${sq}"`;
        if (off) q += `&offset=${off}`;
        const { data } = await at(env, `Pedidos?${encodeURI(q)}`);
        if (!data.records) return err('Erro ao listar pedidos', 500);
        return ok({ ok:true, total: data.records.length, offset_next: data.offset ?? null,
          pedidos: data.records.map(r => ({
            id:           r.id,
            nome_cliente: r.fields['Nome Cliente'],
            telefone:     r.fields['Telefone'],
            endereco:     r.fields['Endereço'],
            status:       r.fields['Status'],
            pagamento:    r.fields['Pagamento'],
            taxa_entrega: r.fields['Taxa de entrega'] ?? 0,
            total:        r.fields['Total']           ?? 0,
            data_hora:    r.fields['Data e Hora'],
            firebase_uid: r.fields['Firebase UID'],
            canal:        r.fields['Canal de Venda'],
            itens_count:  (r.fields['Itens do Pedido'] ?? []).length,
          }))
        });
      } catch { return err('Erro ao listar pedidos', 500); }
    }

    // ── GET /pedidos/:id (admin) ─────────────────────────────────
    if (seg[0]==='pedidos' && seg[1] && method==='GET') {
      if (!isAdmin(request, env)) return err('Não autorizado', 401);
      try {
        const { data: pd } = await at(env, `Pedidos/${seg[1]}`);
        if (pd.error) return err('Pedido não encontrado', 404);
        const ids = pd.fields?.['Itens do Pedido'] ?? [];
        let itens = [];
        if (ids.length) {
          const f = `OR(${ids.map(id=>`RECORD_ID()="${id}"`).join(',')})`;
          const { data: id_ } = await at(env,
            `${encodeURIComponent('Itens do Pedido')}?filterByFormula=${encodeURIComponent(f)}`);
          if (id_.records)
            itens = id_.records.map(r => ({
              id: r.id, nome: r.fields['Nome'],
              quantidade: r.fields['Quantidade'], preco: r.fields['Preço'],
              detalhes: r.fields['Detalhes'],
            }));
        }
        return ok({ ok:true, pedido:{
          id:                  pd.id,
          nome_cliente:        pd.fields['Nome Cliente'],
          telefone:            pd.fields['Telefone'],
          endereco:            pd.fields['Endereço'],
          status:              pd.fields['Status'],
          pagamento:           pd.fields['Pagamento'],
          taxa_entrega:        pd.fields['Taxa de entrega']  ?? 0,
          troco_para:          pd.fields['Troco Para']       ?? 0,
          total:               pd.fields['Total']            ?? 0,
          desconto_cupom:      pd.fields['Desconto Cupom']   ?? 0,
          data_hora:           pd.fields['Data e Hora'],
          firebase_uid:        pd.fields['Firebase UID'],
          observacao:          pd.fields['Observacao']       ?? '',
          canal:               pd.fields['Canal de Venda'],
          aceito_em:           pd.fields['Aceito Em'],
          saiu_em:             pd.fields['Saiu Em'],
          motivo_cancelamento: pd.fields['Motivo Cancelamento'],
          itens,
        }});
      } catch { return err('Erro ao buscar pedido', 500); }
    }

    // ── PATCH /pedidos/:id (admin) — muda status + timestamps ────
    if (seg[0]==='pedidos' && seg[1] && method==='PATCH') {
      if (!isAdmin(request, env)) return err('Não autorizado', 401);
      let body;
      try { body = await request.json(); } catch { return err('Body inválido'); }
      const VALIDOS = ['Aguardando','Pedido aceito','Em preparo','Saiu para entrega','Entregue','Recusado'];
      if (!body.status) return err("Campo 'status' obrigatório");
      if (!VALIDOS.includes(body.status))
        return err(`Status inválido. Use: ${VALIDOS.join(', ')}`);
      try {
        const fields = { Status: body.status };
        const now = new Date().toISOString();
        if (body.status === 'Pedido aceito')     fields['Aceito Em'] = now;
        if (body.status === 'Saiu para entrega') fields['Saiu Em']   = now;
        if (body.status === 'Recusado' && body.motivo)
          fields['Motivo Cancelamento'] = body.motivo;
        const { data } = await at(env, `Pedidos/${seg[1]}`, {
          method: 'PATCH', body: JSON.stringify({ fields }),
        });
        if (data.error) return err('Erro ao atualizar pedido', 500);
        return ok({ ok:true, id: data.id, status_novo: data.fields['Status'],
          aceito_em: data.fields['Aceito Em'], saiu_em: data.fields['Saiu Em'] });
      } catch { return err('Erro ao atualizar pedido', 500); }
    }

    // ── 404 ──────────────────────────────────────────────────────
    return ok({ ok:false, error:`Rota '${path}' não encontrada` }, 404);
  },
};
