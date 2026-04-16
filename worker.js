// ═══════════════════════════════════════════════════════════════════
//  WORKER — LA ROMA TRADIZIONE  v5.0
//  Cloudflare Workers
//
//  ENV VARS (Settings › Variables › Secrets):
//    AIRTABLE_BASE_ID    → appe1UN4tqImejQXR
//    AIRTABLE_API_KEY    → Token pessoal do Airtable
//    ADMIN_SENHA         → Senha para login do painel admin
//    ADMIN_TOKEN         → Token devolvido após login admin
//    FIREBASE_API_KEY    → AIzaSyCASqAMf5fiC7theEZHzAukG20J0FvdVUc
// ═══════════════════════════════════════════════════════════════════

const AT = 'https://api.airtable.com/v0';
const CORS = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type,Authorization',
};

const R = (d,s=200) => new Response(JSON.stringify(d),{status:s,headers:{...CORS,'Content-Type':'application/json'}});
const E = (m,s=400,x={}) => R({ok:false,error:m,...x},s);

async function airtable(env,path,opts={}){
  const res=await fetch(`${AT}/${env.AIRTABLE_BASE_ID}/${path}`,{
    ...opts,
    headers:{Authorization:`Bearer ${env.AIRTABLE_API_KEY}`,'Content-Type':'application/json',...(opts.headers||{})},
  });
  return{data:await res.json(),status:res.status};
}

async function atRetry(env,path,opts={},tries=2){
  let last;
  for(let i=0;i<tries;i++){
    try{last=await airtable(env,path,opts);if(!last.data.error)return last;}
    catch(e){if(i===tries-1)throw e;}
  }
  return last;
}

async function verifyFirebase(token,env){
  const res=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({idToken:token}),
  });
  const d=await res.json();
  if(d.error||!d.users?.[0])return null;
  const u=d.users[0];
  return{uid:u.localId,email:u.email||'',name:u.displayName||'',photo:u.photoUrl||''};
}

const isAdmin=(req,env)=>(req.headers.get('Authorization')||'')==`Bearer ${env.ADMIN_TOKEN}`;

function mapItem(r){
  const f=r.fields;
  return{
    id:r.id,
    nome:f['Nome']??f['Nome da variação']??'',
    descricao:f['Descrição']??'',
    preco:f['Preço']??0,
    ativo:f['Ativo']??false,
    ordem:f['Ordem']??null,
    destaque:f['Destaque']??false,
    categoria:f['Categoria']?.name??f['Categoria']??'',
    imagem:f['Imagem']?.[0]?.url??null,
    imagem_thumb:f['Imagem']?.[0]?.thumbnails?.large?.url??null,
    adicionais_ids:f['Relacionamento Adicionais']??[],
    bordas_ids:f['Relacionamento Bordas']??[],
    bebida_id:f['Bebida']??[],
    tipo:f['Tipo']?.name??f['Tipo']??null,
  };
}

export default{
  async fetch(request,env){
    const url=new URL(request.url);
    const path=url.pathname.replace(//+$/,'');
    const seg=path.split('/').filter(Boolean);
    const method=request.method;

    if(method==='OPTIONS')return new Response(null,{headers:CORS});

    if(seg[0]&&!['login','auth'].includes(seg[0])){
      if(!env.AIRTABLE_BASE_ID||!env.AIRTABLE_API_KEY)return E('Variáveis AIRTABLE não configuradas',500);
    }

    // GET /
    if(!seg.length)return R({ok:true,service:'La Roma Tradizione API',version:'5.0',
      rotas:{publica:['GET /site','GET /config','GET /menu','GET /promocoes','GET /dias-fechados'],
             cliente:['POST /auth/google','POST /pedido','GET /meus-pedidos?uid=','GET /meus-pedidos/:id/itens?uid=','GET /status-pedido/:id?uid=','GET /cupom/validar?codigo='],
             admin:['POST /login','GET /pedidos','GET /pedidos/:id','PATCH /pedidos/:id']}});

    // GET /site
    if(path==='/site'&&method==='GET'){
      try{
        const{data}=await atRetry(env,encodeURIComponent('Configurações do Site'));
        if(!data.records)return R({ok:true,site:{}});
        const site={};
        for(const r of data.records)if(r.fields['Chave'])site[r.fields['Chave']]=r.fields['Valor']??'';
        return R({ok:true,site});
      }catch{return R({ok:true,site:{}});}
    }

    // GET /config
    if(path==='/config'&&method==='GET'){
      try{
        const{data}=await atRetry(env,encodeURIComponent('Configurações do Sistema'));
        if(!data.records?.length)return E('Sem configuração',404);
        const f=data.records[0].fields;
        return R({ok:true,config:{taxa_entrega:f['Taxa de entrega']??5,pedido_minimo:f['Pedido mínimo']??25,hora_abertura:f['Hora abertura']??'18:00',hora_fechamento:f['Hora fechamento']??'23:59',tempo_espera:f['Tempo de espera']??'30-50 min'}});
      }catch(e){return E('Erro ao buscar config',500,{details:e.message});}
    }

    // GET /menu — pula tabelas com erro em vez de abortar tudo
    if(path==='/menu'&&method==='GET'){
      const tables=['Pizzas Grandes','Brotinhos','Esfirras','Bebidas','Variações de Bebidas','Adicionais','Bordas'];
      try{
        const results=await Promise.allSettled(tables.map(t=>atRetry(env,encodeURIComponent(t)).then(({data,status})=>({t,data,status}))));
        const menu={};
        const erros=[];
        for(const result of results){
          if(result.status==='rejected'){erros.push(result.reason?.message||'erro');continue;}
          const{t,data,status}=result.value;
          if(data.error||!data.records){erros.push(`${t}: ${data.error?.message||data.error||'sem registros'}`);continue;}
          const key=t.normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/s+/g,'_').toLowerCase();
          menu[key]=data.records.filter(r=>r.fields['Ativo']===true||r.fields['Ativo']===undefined).map(mapItem);
        }
        return R({ok:true,menu,erros_ignorados:erros});
      }catch(e){return E('Erro ao buscar menu',500,{details:e.message});}
    }

    // GET /promocoes
    if(path==='/promocoes'&&method==='GET'){
      try{
        const{data}=await atRetry(env,encodeURIComponent('Promoções'));
        if(!data.records)return R({ok:true,promocoes:[]});
        const promocoes=data.records.filter(r=>r.fields['Ativo']===true).map(r=>({
          id:r.id,nome:r.fields['Nome']??'',
          preco_promocional:r.fields['Preco Promocional']??0,
          dias_ativos:(r.fields['Dias Ativos']??[]).map(d=>d.name??d),
          ativo:r.fields['Ativo']??false,
          pizza_grande_ids:r.fields['Pizza Grande']??[],
          brotinho_ids:r.fields['Brotinho']??[],
          esfirra_ids:r.fields['Esfirra']??[],
        }));
        return R({ok:true,promocoes});
      }catch{return R({ok:true,promocoes:[]});}
    }

    // GET /dias-fechados
    if(path==='/dias-fechados'&&method==='GET'){
      try{
        const{data}=await atRetry(env,encodeURIComponent('Dias Fechados'));
        if(!data.records)return R({ok:true,dias:[]});
        const dias=data.records.filter(r=>r.fields['Ativo']===true).map(r=>({
          id:r.id,
          dia:r.fields['Dia da Semana']?.name??r.fields['Dia da Semana']??'',
          mensagem:r.fields['Mensagem']??'',
        }));
        return R({ok:true,dias});
      }catch{return R({ok:true,dias:[]});}
    }

    // POST /auth/google
    if(path==='/auth/google'&&method==='POST'){
      let body;try{body=await request.json();}catch{return E('Body JSON inválido');}
      if(!body.token)return E("Campo 'token' obrigatório");
      if(!env.FIREBASE_API_KEY)return E('FIREBASE_API_KEY não configurado',500);
      try{
        const fb=await verifyFirebase(body.token,env);
        if(!fb)return E('Token Firebase inválido',401);
        const{data:found}=await airtable(env,`Clientes?filterByFormula={UID Firebase}="${fb.uid}"`);
        let record_id,created;
        if(found.records?.length>0){
          record_id=found.records[0].id;created=false;
          await airtable(env,`Clientes/${record_id}`,{method:'PATCH',body:JSON.stringify({fields:{Nome:fb.name,'Foto URL':fb.photo}})});
        }else{
          const{data:nr}=await airtable(env,'Clientes',{method:'POST',body:JSON.stringify({fields:{Nome:fb.name,Email:fb.email,'UID Firebase':fb.uid,'Foto URL':fb.photo,'Tipo de Login':'Google',Ativo:true,'Criado em':new Date().toISOString().split('T')[0]}})});
          record_id=nr.id;created=true;
        }
        return R({ok:true,created,user:{uid:fb.uid,email:fb.email,name:fb.name,photo:fb.photo,record_id}});
      }catch(e){return E('Erro na autenticação',500,{details:e.message});}
    }

    // GET /cupom/validar?codigo=
    if(path==='/cupom/validar'&&method==='GET'){
      const codigo=url.searchParams.get('codigo')?.trim().toUpperCase();
      if(!codigo)return E("Parâmetro 'codigo' obrigatório");
      try{
        const{data}=await airtable(env,`Cupons?filterByFormula=AND({Codigo}="${codigo}",{Ativo}=1)`);
        if(!data.records?.length)return E('Cupom não encontrado',404);
        const c=data.records[0],f=c.fields;
        if(f['Valido Ate']){const ex=new Date(f['Valido Ate']+'T23:59:59-03:00');if(new Date()>ex)return E('Cupom expirado',400);}
        const maxU=f['Usos Maximos']??0,curU=f['Usos Atuais']??0;
        if(maxU>0&&curU>=maxU)return E('Cupom esgotado',400);
        return R({ok:true,cupom:{id:c.id,Codigo:f['Codigo'],Tipo:f['Tipo']?.name??f['Tipo'],Valor:f['Valor']??0,Percentual:f['Percentual']??0,Pedido_minimo:f['Pedido Minimo']??0,Descricao:f['Descricao']??''}});
      }catch(e){return E('Erro ao validar cupom',500,{details:e.message});}
    }

    // POST /pedido
    if(path==='/pedido'&&method==='POST'){
      let body;try{body=await request.json();}catch{return E('Body JSON inválido');}
      for(const c of['nome','telefone','endereco','pagamento','itens'])if(!body[c])return E(`Campo '${c}' obrigatório`);
      if(!Array.isArray(body.itens)||!body.itens.length)return E('Pedido deve ter pelo menos 1 item');
      try{
        const pf={
          'Nome Cliente':body.nome,'Telefone':body.telefone,'Endereço':body.endereco,
          'Pagamento':body.pagamento,'Status':'Aguardando','Data e Hora':new Date().toISOString(),
          'Taxa de entrega':body.taxa_entrega??0,'Total':body.total??0,
          'Firebase UID':body.firebase_uid??'','Troco Para':body.troco_para??0,
          'Canal de Venda':'Site','Observacao':body.observacao??'',
        };
        if(body.cliente_record_id)pf['Cliente']=[body.cliente_record_id];
        if(body.cupom_record_id){pf['Cupom']=[body.cupom_record_id];pf['Desconto Cupom']=body.desconto_cupom??0;}
        const{data:pedido}=await airtable(env,'Pedidos',{method:'POST',body:JSON.stringify({fields:pf})});
        if(pedido.error||!pedido.id)return E('Erro ao criar pedido',500,{airtable:pedido.error});
        const pid=pedido.id;
        const iRes=await Promise.all(body.itens.map(i=>airtable(env,encodeURIComponent('Itens do Pedido'),{method:'POST',body:JSON.stringify({fields:{Nome:i.nome??'Item',Pedido:[pid],Quantidade:i.quantidade??1,Preço:i.preco??0,Detalhes:i.detalhes??''}})})));
        const erros=iRes.map(({data},idx)=>data.error?{idx,err:data.error}:null).filter(Boolean);
        return R({ok:true,pedido_id:pid,erros_itens:erros},201);
      }catch(e){return E('Erro ao criar pedido',500,{details:e.message});}
    }

    // GET /meus-pedidos?uid=
    if(path==='/meus-pedidos'&&method==='GET'){
      const uid=url.searchParams.get('uid');
      if(!uid)return E("Parâmetro 'uid' obrigatório");
      try{
        const{data}=await airtable(env,`Pedidos?filterByFormula={Firebase UID}="${uid}"&sort[0][field]=Data e Hora&sort[0][direction]=desc&pageSize=30`);
        if(!data.records)return R({ok:true,pedidos:[]});
        return R({ok:true,pedidos:data.records.map(r=>({id:r.id,status:r.fields['Status'],pagamento:r.fields['Pagamento'],endereco:r.fields['Endereço'],taxa_entrega:r.fields['Taxa de entrega']??0,total:r.fields['Total']??0,data_hora:r.fields['Data e Hora'],itens_ids:r.fields['Itens do Pedido']??[]}))});
      }catch{return E('Erro ao buscar pedidos',500);}
    }

    // GET /meus-pedidos/:id/itens?uid=
    if(seg[0]==='meus-pedidos'&&seg[1]&&seg[2]==='itens'&&method==='GET'){
      const uid=url.searchParams.get('uid');
      if(!uid)return E("Parâmetro 'uid' obrigatório");
      try{
        const{data:pd}=await airtable(env,`Pedidos/${seg[1]}`);
        if(pd.error)return E('Pedido não encontrado',404);
        if(pd.fields['Firebase UID']!==uid)return E('Acesso negado',403);
        const ids=pd.fields?.['Itens do Pedido']??[];
        let itens=[];
        if(ids.length){
          const f=`OR(${ids.map(id=>`RECORD_ID()="${id}"`).join(',')})`;
          const{data:id_}=await airtable(env,`${encodeURIComponent('Itens do Pedido')}?filterByFormula=${encodeURIComponent(f)}`);
          if(id_.records)itens=id_.records.map(r=>({id:r.id,nome:r.fields['Nome'],quantidade:r.fields['Quantidade'],preco:r.fields['Preço'],detalhes:r.fields['Detalhes']}));
        }
        return R({ok:true,pedido:{id:pd.id,status:pd.fields['Status'],pagamento:pd.fields['Pagamento'],endereco:pd.fields['Endereço'],taxa_entrega:pd.fields['Taxa de entrega']??0,total:pd.fields['Total']??0,data_hora:pd.fields['Data e Hora'],itens}});
      }catch{return E('Erro ao buscar pedido',500);}
    }

    // GET /status-pedido/:id?uid=
    if(seg[0]==='status-pedido'&&seg[1]&&method==='GET'){
      const uid=url.searchParams.get('uid');
      if(!uid)return E("Parâmetro 'uid' obrigatório");
      try{
        const{data}=await airtable(env,`Pedidos/${seg[1]}?fields[]=Status&fields[]=Firebase UID`);
        if(data.error)return E('Pedido não encontrado',404);
        if(data.fields['Firebase UID']!==uid)return E('Acesso negado',403);
        return R({ok:true,status:data.fields['Status']});
      }catch{return E('Erro ao buscar status',500);}
    }

    // POST /login
    if(path==='/login'&&method==='POST'){
      let body;try{body=await request.json();}catch{return E('Body inválido');}
      if(!body.senha)return E("Campo 'senha' obrigatório");
      if(!env.ADMIN_SENHA||!env.ADMIN_TOKEN)return E('Variáveis ADMIN não configuradas',500);
      if(body.senha!==env.ADMIN_SENHA)return E('Senha incorreta',401);
      return R({ok:true,token:env.ADMIN_TOKEN});
    }

    // GET /pedidos (admin)
    if(path==='/pedidos'&&method==='GET'){
      if(!isAdmin(request,env))return E('Não autorizado',401);
      try{
        const sq=url.searchParams.get('status'),lm=url.searchParams.get('limite')??'50',of=url.searchParams.get('offset')??'';
        let q=`sort[0][field]=Data e Hora&sort[0][direction]=desc&pageSize=${lm}`;
        if(sq)q+=`&filterByFormula={Status}="${sq}"`;
        if(of)q+=`&offset=${of}`;
        const{data}=await airtable(env,`Pedidos?${encodeURI(q)}`);
        if(!data.records)return E('Erro ao listar pedidos',500);
        return R({ok:true,total:data.records.length,offset_next:data.offset??null,
          pedidos:data.records.map(r=>({id:r.id,nome_cliente:r.fields['Nome Cliente'],telefone:r.fields['Telefone'],endereco:r.fields['Endereço'],status:r.fields['Status'],pagamento:r.fields['Pagamento'],taxa_entrega:r.fields['Taxa de entrega']??0,total:r.fields['Total']??0,data_hora:r.fields['Data e Hora'],firebase_uid:r.fields['Firebase UID'],canal:r.fields['Canal de Venda'],itens_count:(r.fields['Itens do Pedido']??[]).length}))});
      }catch{return E('Erro ao listar pedidos',500);}
    }

    // GET /pedidos/:id (admin)
    if(seg[0]==='pedidos'&&seg[1]&&method==='GET'){
      if(!isAdmin(request,env))return E('Não autorizado',401);
      try{
        const{data:pd}=await airtable(env,`Pedidos/${seg[1]}`);
        if(pd.error)return E('Pedido não encontrado',404);
        const ids=pd.fields?.['Itens do Pedido']??[];
        let itens=[];
        if(ids.length){
          const f=`OR(${ids.map(id=>`RECORD_ID()="${id}"`).join(',')})`;
          const{data:id_}=await airtable(env,`${encodeURIComponent('Itens do Pedido')}?filterByFormula=${encodeURIComponent(f)}`);
          if(id_.records)itens=id_.records.map(r=>({id:r.id,nome:r.fields['Nome'],quantidade:r.fields['Quantidade'],preco:r.fields['Preço'],detalhes:r.fields['Detalhes']}));
        }
        return R({ok:true,pedido:{id:pd.id,nome_cliente:pd.fields['Nome Cliente'],telefone:pd.fields['Telefone'],endereco:pd.fields['Endereço'],status:pd.fields['Status'],pagamento:pd.fields['Pagamento'],taxa_entrega:pd.fields['Taxa de entrega']??0,troco_para:pd.fields['Troco Para']??0,total:pd.fields['Total']??0,desconto_cupom:pd.fields['Desconto Cupom']??0,data_hora:pd.fields['Data e Hora'],firebase_uid:pd.fields['Firebase UID'],observacao:pd.fields['Observacao']??'',canal:pd.fields['Canal de Venda'],aceito_em:pd.fields['Aceito Em'],saiu_em:pd.fields['Saiu Em'],motivo_cancelamento:pd.fields['Motivo Cancelamento'],itens}});
      }catch{return E('Erro ao buscar pedido',500);}
    }

    // PATCH /pedidos/:id (admin)
    if(seg[0]==='pedidos'&&seg[1]&&method==='PATCH'){
      if(!isAdmin(request,env))return E('Não autorizado',401);
      let body;try{body=await request.json();}catch{return E('Body inválido');}
      const VALID=['Aguardando','Pedido aceito','Em preparo','Saiu para entrega','Entregue','Recusado'];
      if(!body.status)return E("Campo 'status' obrigatório");
      if(!VALID.includes(body.status))return E(`Status inválido. Use: ${VALID.join(', ')}`);
      try{
        const fields={Status:body.status};
        const now=new Date().toISOString();
        if(body.status==='Pedido aceito')fields['Aceito Em']=now;
        if(body.status==='Saiu para entrega')fields['Saiu Em']=now;
        if(body.status==='Recusado'&&body.motivo)fields['Motivo Cancelamento']=body.motivo;
        const{data}=await airtable(env,`Pedidos/${seg[1]}`,{method:'PATCH',body:JSON.stringify({fields})});
        if(data.error)return E('Erro ao atualizar pedido',500);
        return R({ok:true,id:data.id,status_novo:data.fields['Status'],aceito_em:data.fields['Aceito Em'],saiu_em:data.fields['Saiu Em']});
      }catch{return E('Erro ao atualizar pedido',500);}
    }

    // 404
    return R({ok:false,error:`Rota '${path}' não encontrada`},404);
  },
};