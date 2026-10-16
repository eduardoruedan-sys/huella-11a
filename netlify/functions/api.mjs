import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const data = () => getStore({name:'huella-11a-data',consistency:'strong'});
const json = (d,s=200) => Response.json(d,{status:s,headers:{'Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}});
const hash = x => createHash('sha256').update(String(x)).digest('hex');
const clean = (s,max=1600) => String(s??'').trim().slice(0,max);
const criteria = ['solidaridad','empatia','inclusion','inspiracion','huella'];
const defaults = {names:[],codes:[],phase:'setup',winner:null,revealAt:null,createdAt:Date.now()};
const safeEqual = (a,b)=> {const A=Buffer.from(hash(a)), B=Buffer.from(hash(b));return timingSafeEqual(A,B)};
const readConfig = async store => (await store.get('config',{type:'json'}))||defaults;
const userKey = id => `user/${id}`;
const readUsers = async (store,config)=>Promise.all((config.codes||[]).map(async c=>({...(await store.get(userKey(c.id),{type:'json'})||{}),id:c.id,name:c.name})));
const auth = (payload, config) => {const id=hash(clean(payload.code,60).toUpperCase()); const code=(config.codes||[]).find(x=>x.id===id); return code||null;};
const statusView = c=>({phase:c.phase,names:c.names,criteria,revealed:c.phase==='revealed',winner:c.phase==='revealed'?c.winner:null,revealAt:c.revealAt||null});
const partial = u=>({startedAt:u?.startedAt||null,answers:u?.answers||{},submittedAt:u?.submittedAt||null});
const validateAnswers = (a,names)=>{
 if(!a||typeof a!=='object') return 'Respuestas inválidas';
 for(const k of ['self','memory1','memory2','memory3','finalWhy']) if(clean(a[k],2000).length<25) return `Completa tu reflexión: ${k} (mínimo 25 caracteres)`;
 const recognitions=Array.isArray(a.recognitions)?a.recognitions:[];
 if(recognitions.length>3) return 'Máximo tres reconocimientos';
 for(const r of recognitions){if(!names.includes(r.name)||clean(r.why,1000).length<20) return 'Revisa nombres y justificaciones de los reconocimientos'}
 const values=a.values||{};
 for(const k of criteria) if(values[k] && !names.includes(values[k])) return 'Criterio inválido';
 if(!names.includes(a.finalChoice)) return 'Selecciona una compañera válida';
 return null;
};
const summarize = users =>{
 const done=users.filter(x=>x.submittedAt);
 const byName={};for(const u of users) byName[u.name]={name:u.name,final:0,values:0,per:{},total:0};
 for(const u of done){const a=u.answers||{};if(byName[a.finalChoice])byName[a.finalChoice].final++;
 for(const k of criteria){const n=a.values?.[k];if(byName[n]){byName[n].values++;byName[n].per[k]=(byName[n].per[k]||0)+1;}}}
 const n=done.length||1;
 const ranked=Object.values(byName).map(o=>({...o,score:0.6*o.final/n+0.4*o.values/(5*n)})).sort((a,b)=>b.score-a.score||b.final-a.final||b.values-a.values||a.name.localeCompare(b.name,'es'));
 const totals=Object.fromEntries(criteria.map(k=>[k,done.filter(u=>u.answers?.values?.[k]).length]));
 return {done:done.length,roster:users.length,totals,recognized:new Set(done.flatMap(u=>[u.answers?.finalChoice,...Object.values(u.answers?.values||{})].filter(Boolean))).size,ranked};
};
export default async function(req){
 try{
  if(req.method!=='POST')return json({error:'Usa POST'},405);
  let b;try{b=await req.json()}catch{return json({error:'JSON inválido'},400)}
  if(JSON.stringify(b).length>30000)return json({error:'Solicitud demasiado grande'},413);
  const store=data(), c=await readConfig(store), action=clean(b.action,40);
  const admin=safeEqual(clean(b.pin,150),process.env.ADMIN_PIN||randomBytes(24).toString('hex'));
  if(action==='status')return json(statusView(c));
  if(action==='login'){
   if(c.phase==='setup')return json({error:'La actividad aún no está preparada'},403);
   const entry=auth(b,c);if(!entry)return json({error:'Código de acceso incorrecto'},403);
   let u=await store.get(userKey(entry.id),{type:'json'});
   if(!u){u={startedAt:Date.now(),answers:{},submittedAt:null};await store.setJSON(userKey(entry.id),u)}
   return json({...statusView(c),...partial(u),student:entry.name,serverNow:Date.now()});
  }
  if(['save','submit','me'].includes(action)){
   const entry=auth(b,c);if(!entry)return json({error:'Código de acceso incorrecto'},403);
   const u=await store.get(userKey(entry.id),{type:'json'});if(!u)return json({error:'Primero ingresa con tu código'},403);
   if(action==='me')return json({...partial(u),...statusView(c),student:entry.name,serverNow:Date.now()});
   if(c.phase!=='open')return json({error:'La votación está cerrada'},403);
   if(u.submittedAt)return json({error:'Tu participación ya fue enviada'},409);
   if(!b.answers||typeof b.answers!=='object')return json({error:'Formato de respuestas inválido'},400);
   const a=structuredClone(b.answers);
   for(const key of ['self','memory1','memory2','memory3','finalWhy'])a[key]=clean(a[key],2000);
   a.recognitions=(Array.isArray(a.recognitions)?a.recognitions:[]).slice(0,3).map(r=>({name:clean(r.name,100),why:clean(r.why,1200)}));
   a.values=Object.fromEntries(criteria.map(k=>[k,clean(a.values?.[k],100)]));
   a.finalChoice=clean(a.finalChoice,100);
   const names=c.names.filter(n=>n!==entry.name);
   for(const r of a.recognitions)if(r.name&&!names.includes(r.name))return json({error:'No puedes reconocerte a ti misma'},400);
   for(const k of criteria)if(a.values[k]&&!names.includes(a.values[k]))return json({error:'No puedes votarte a ti misma'},400);
   if(a.finalChoice&&!names.includes(a.finalChoice))return json({error:'Elección final inválida'},400);
   if(action==='submit'){
    if(Date.now()-u.startedAt<65*60000)return json({error:'La etapa final se habilita a los 65 minutos de tu ingreso'},403);
    const err=validateAnswers(a,names);if(err)return json({error:err},400);
    u.submittedAt=Date.now();
   }
   u.answers=a;u.updatedAt=Date.now();await store.setJSON(userKey(entry.id),u);return json({ok:true,submittedAt:u.submittedAt,savedAt:u.updatedAt});
  }
  if(!admin)return json({error:'PIN docente incorrecto o variable ADMIN_PIN no configurada'},403);
  if(action==='admin'){
   const users=await readUsers(store,c);const sums=summarize(users);
   return json({...statusView(c),summary:{...sums,ranked:c.phase==='revealed'?sums.ranked:[]},participation:users.map(u=>({name:u.name,started:!!u.startedAt,done:!!u.submittedAt})),ready:!!process.env.ADMIN_PIN});
  }
  if(action==='setup'){
   if(c.phase!=='setup')return json({error:'La lista ya fue confirmada. No se puede modificar tras iniciar.'},409);
   const names=[...new Set(String(b.names||'').split(/\r?\n/).map(v=>clean(v,100)).filter(Boolean))];
   if(names.length<2||names.length>80)return json({error:'Escribe entre 2 y 80 estudiantes (una por línea)'},400);
   const codes=names.map(name=>{const code=randomBytes(5).toString('hex').toUpperCase();return {name,code,id:hash(code)}});
   await store.setJSON('config',{...c,names,codes:codes.map(({name,id})=>({name,id})),phase:'ready'});
   return json({ok:true,codes:codes.map(({name,code})=>({name,code}))});
  }
  if(action==='open'){
   if(c.phase!=='ready')return json({error:'La actividad ya fue iniciada o no está configurada'},409);
   c.phase='open';await store.setJSON('config',c);return json({ok:true});
  }
  if(action==='close'){
   if(c.phase!=='open')return json({error:'La votación no está abierta'},409);
   c.phase='closed';await store.setJSON('config',c);return json({ok:true});
  }
  if(action==='reveal'){
   if(c.phase!=='closed')return json({error:'Primero cierra la votación'},409);
   const sums=summarize(await readUsers(store,c));if(!sums.done)return json({error:'No hay votos completos'},409);
   const [first,second]=sums.ranked;
   if(second&&Math.abs(first.score-second.score)<1e-10&&first.final===second.final&&first.values===second.values)return json({error:'Empate total. No se puede garantizar una ganadora única; se necesita desempate adicional'},409);
   c.winner=first.name;c.phase='revealed';c.revealAt=Date.now();await store.setJSON('config',c);return json({ok:true,winner:c.winner,summary:sums});
  }
  return json({error:'Acción no reconocida'},400);
 }catch(err){console.error(err);return json({error:'Error del servidor. Verifica el despliegue y Netlify Blobs.'},500)}
}
