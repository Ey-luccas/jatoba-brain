const $=id=>document.getElementById(id);
const views={overview:'Visao geral',projects:'Projetos',repositories:'Repositorios',agents:'Agentes',sessions:'Sessoes',tasks:'Tarefas',memories:'Memorias',decisions:'Decisoes',errors:'Erros',checkpoints:'Checkpoints',timeline:'Timeline',graph:'Relacoes',metrics:'Metricas',audit_log:'Auditoria'};
let view='overview',requestId=0;
function element(tag,text){const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);return e;}
for(const [key,label] of Object.entries(views)){const b=element('button',label);b.type='button';b.dataset.view=key;b.onclick=()=>{view=key;void load();};$('navigation').append(b);}
async function api(name,params={}) {
  const response=await fetch('/api/dashboard/'+name+'?'+new URLSearchParams(params),{credentials:'same-origin'});
  if(!response.ok)throw new Error(response.status===401?'Autenticacao necessaria.':'Nao foi possivel carregar os dados.');
  return response.json();
}
function table(rows) {
  if(!rows.length){const empty=element('p','Nenhum registro neste contexto.');empty.className='empty';return empty;}
  const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))].filter(k=>!['embedding','metadata'].includes(k));
  const wrap=element('div');wrap.className='table-wrap';const t=element('table'),head=element('tr');
  keys.forEach(k=>head.append(element('th',k)));const thead=element('thead');thead.append(head);t.append(thead);
  const body=element('tbody');for(const row of rows){const tr=element('tr');for(const k of keys){const td=element('td');td.append(element('pre',typeof row[k]==='object'?JSON.stringify(row[k],null,2):row[k]??''));tr.append(td);}body.append(tr);}
  t.append(body);wrap.append(t);return wrap;
}
function cards(data){const grid=element('div');grid.className='cards';for(const [key,value] of Object.entries(data)){const card=element('article');card.className='card';card.append(element('h2',key.replaceAll('_',' ')),element('strong',typeof value==='number'?Number(value.toFixed(2)):value));grid.append(card);}return grid;}
function graph(edges) {
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('graph');svg.setAttribute('viewBox','0 0 950 '+Math.max(100,edges.length*64));
  const add=(tag,attrs,text)=>{const n=document.createElementNS(svg.namespaceURI,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v));if(text)n.textContent=text;svg.append(n);};
  edges.slice(0,50).forEach((e,i)=>{const y=i*64+28;add('line',{x1:305,y1:y,x2:645,y2:y});add('text',{x:335,y:y-8},e.relation_type+' →');
    add('rect',{x:12,y:y-18,width:285,height:35,rx:3});add('text',{x:20,y:y+4},(e.source_type+':'+e.source_id).slice(0,38));
    add('rect',{x:650,y:y-18,width:288,height:35,rx:3});add('text',{x:660,y:y+4},(e.target_type+':'+e.target_id).slice(0,38));});
  return svg;
}
async function load() {
  const current=++requestId;$('title').textContent=views[view];$('status').textContent='Consultando...';
  document.querySelectorAll('nav button').forEach(b=>b.setAttribute('aria-current',b.dataset.view===view?'page':'false'));
  const params={project:$('project').value};
  if(!params.project && view!=='projects'){$('content').replaceChildren(element('p','Selecione um projeto para consultar a memoria.'));$('status').textContent='';return;}
  if($('repository').value)params.repositoryId=$('repository').value;
  if($('type').value)params.type=$('type').value;if($('search').value)params.query=$('search').value;
  try {
    const data=await api(view,params);if(current!==requestId)return;
    const content=$('content');content.replaceChildren();
    if(view==='overview'){content.append(cards(data.metrics));for(const [key,label] of [['recent_tasks','Tarefas recentes'],['checkpoints','Checkpoints'],['decisions','Decisoes'],['errors','Erros']])content.append(element('h2',label),table(data.context[key]));}
    else if(view==='metrics')content.append(cards(data));
    else if(view==='graph')content.append(data.length?graph(data):table([]),table(data));
    else content.append(table(data));
    $('status').textContent='Consulta concluida. Resultados limitados ao contexto selecionado.';
  }catch(error){if(current===requestId){$('status').textContent=error.message;$('content').replaceChildren();}}
}
$('filters').onsubmit=e=>{e.preventDefault();void load();};
$('project').onchange=async()=>{const selected=$('project').value;$('repository').replaceChildren(new Option('Todos do projeto',''));if(selected){try{const repos=await api('repositories',{project:selected});if($('project').value!==selected)return;repos.forEach(r=>$('repository').append(new Option(r.name,r.id)));}catch(error){$('status').textContent=error.message;}}void load();};
void (async()=>{try{const projects=await api('projects');projects.forEach(p=>$('project').append(new Option(p.name,p.id)));if(projects.length){$('project').value=projects[0].id;await $('project').onchange();}else await load();}catch(error){$('status').textContent=error.message;}})();
