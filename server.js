const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {Pool}=require('pg');
const PORT=Number(process.env.PORT||3000), ADMIN_PASSWORD=process.env.ADMIN_PASSWORD;
if(!ADMIN_PASSWORD){console.error('Define ADMIN_PASSWORD antes de iniciar.');process.exit(1)}
if(!process.env.DATABASE_URL){console.error('Define DATABASE_URL para guardar los datos en Neon.');process.exit(1)}
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true},max:3});
let data={riders:[],shifts:[],points:[]};
let writeQueue=Promise.resolve();
async function save(){
 const snapshot=JSON.stringify(data);
 const p=writeQueue.then(()=>pool.query('INSERT INTO app_state (id,data,updated_at) VALUES (1,$1::jsonb,now()) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()',[snapshot]));
 writeQueue=p.catch(err=>{console.error('Error guardando en Neon:',err.message)});
 await p;
}
async function loadData(){
 await pool.query('CREATE TABLE IF NOT EXISTS app_state (id integer PRIMARY KEY CHECK (id=1),data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())');
 const result=await pool.query('SELECT data FROM app_state WHERE id=1');
 if(result.rows.length){
  const stored=result.rows[0].data;
  if(!stored||!Array.isArray(stored.riders)||!Array.isArray(stored.shifts)||!Array.isArray(stored.points)) throw Error('Estado de Neon inválido');
  data=stored;
 }
}
const sessions=new Map();
const accessKey=crypto.scryptSync(ADMIN_PASSWORD,'estacion-gps-code-v1',32);
function encryptCode(code){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',accessKey,iv);const ct=Buffer.concat([cipher.update(code,'utf8'),cipher.final()]);return [iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),ct.toString('base64url')].join('.')}
function decryptCode(saved){const [iv,tag,ct]=String(saved).split('.');if(!iv||!tag||!ct)throw Error('Código no disponible');const decipher=crypto.createDecipheriv('aes-256-gcm',accessKey,Buffer.from(iv,'base64url'));decipher.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([decipher.update(Buffer.from(ct,'base64url')),decipher.final()]).toString('utf8')}
function hash(s,salt){return crypto.scryptSync(s,salt,64).toString('hex')}
function verify(s,salt,digest){let a=Buffer.from(hash(s,salt),'hex'),b=Buffer.from(digest,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b)}
function json(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj))}
function getAuth(req){const t=(req.headers.authorization||'').replace(/^Bearer /,'');const s=sessions.get(t);if(!s||s.until<Date.now()){sessions.delete(t);return null}return s}
async function body(req){let s='';for await(const chunk of req){s+=chunk;if(s.length>25000)throw Error('Solicitud demasiado grande')}return JSON.parse(s||'{}')}
const token=()=>crypto.randomBytes(32).toString('hex');
function sanitizeRider(r){return {id:r.id,name:r.name,active:r.active,status:r.status,lat:r.lat,lon:r.lon,accuracy:r.accuracy,lastSeen:r.lastSeen,started:r.started,archived:!!r.archived}}
const handler=async(req,res)=>{try{
const u=new URL(req.url,'http://localhost');if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return fs.createReadStream(path.join(__dirname,'index.html')).pipe(res)}
if(!u.pathname.startsWith('/api/'))return json(res,404,{error:'No encontrado'});
if(req.method==='POST'&&u.pathname==='/api/login'){const b=await body(req);if(b.role==='admin'&&b.password===ADMIN_PASSWORD){let t=token();sessions.set(t,{role:'admin',until:Date.now()+86400000});return json(res,200,{token:t,role:'admin'})}if(b.role==='rider'){const r=data.riders.find(r=>!r.archived&&r.codeSalt&&verify(String(b.code||''),r.codeSalt,r.codeHash));if(r){let t=token();sessions.set(t,{role:'rider',id:r.id,until:Date.now()+30*86400000});return json(res,200,{token:t,role:'rider',name:r.name})}}return json(res,401,{error:'Credenciales inválidas'})}
const auth=getAuth(req);if(!auth)return json(res,401,{error:'Debes iniciar sesión'});
if(req.method==='GET'&&u.pathname==='/api/state'){if(auth.role==='admin')return json(res,200,{riders:data.riders.map(sanitizeRider),shifts:data.shifts});const r=data.riders.find(x=>x.id===auth.id);if(!r||r.archived)return json(res,403,{error:'Repartidor archivado o eliminado'});return json(res,200,{me:sanitizeRider(r),shifts:data.shifts.filter(s=>s.riderId===auth.id)})}
if(req.method==='GET'&&u.pathname==='/api/route'){const id=auth.role==='admin'?u.searchParams.get('id'):auth.id;if(auth.role==='rider'&&!data.riders.some(r=>r.id===auth.id&&!r.archived))return json(res,403,{error:'Repartidor archivado o eliminado'});const shift=u.searchParams.get('shift');if(auth.role!=='admin'&&id!==auth.id)return json(res,403,{error:'Prohibido'});return json(res,200,{points:data.points.filter(p=>p.riderId===id&&(!shift||p.shiftId===shift)).slice(-1500)})}
if(req.method==='POST'&&u.pathname==='/api/riders'&&auth.role==='admin'){const b=await body(req);const name=String(b.name||'').trim().slice(0,60);if(!name)return json(res,400,{error:'Ingresa el nombre'});const code=crypto.randomBytes(9).toString('base64url');const salt=crypto.randomBytes(16).toString('hex');const r={id:crypto.randomUUID(),name,codeSalt:salt,codeHash:hash(code,salt),codeEncrypted:encryptCode(code),active:false,status:'Desconectado',lat:null,lon:null,accuracy:null,lastSeen:null,started:null};data.riders.push(r);await save();return json(res,200,{rider:sanitizeRider(r),code})}
if(req.method==='GET'&&u.pathname==='/api/rider-code'&&auth.role==='admin'){
 const rider=data.riders.find(x=>x.id===u.searchParams.get('id'));if(!rider)return json(res,404,{error:'Repartidor no encontrado'});
 if(!rider.codeEncrypted)return json(res,409,{error:'Código anterior no recuperable. Restablécelo una sola vez.'});
 try{return json(res,200,{code:decryptCode(rider.codeEncrypted)})}catch{return json(res,409,{error:'No se puede leer el código tras cambiar la contraseña de administrador. Restablécelo.'})}
}
if(req.method==='POST'&&u.pathname==='/api/reset-code'&&auth.role==='admin'){
 const b=await body(req),r=data.riders.find(x=>x.id===b.id);
 if(!r)return json(res,404,{error:'Repartidor no encontrado'});
 const code=crypto.randomBytes(12).toString('base64url');
 const salt=crypto.randomBytes(16).toString('hex');
 const oldHash=r.codeHash,oldSalt=r.codeSalt,oldEncrypted=r.codeEncrypted,oldActive=r.active,oldStatus=r.status,oldStarted=r.started;
 const sh=data.shifts.findLast(s=>s.riderId===r.id&&!s.end),oldEnd=sh?.end;
 r.codeSalt=salt;r.codeHash=hash(code,salt);r.codeEncrypted=encryptCode(code);
 if(r.active){r.active=false;r.status='Desconectado';r.started=null;if(sh)sh.end=new Date().toISOString()}
 try{await save()}catch(e){r.codeHash=oldHash;r.codeSalt=oldSalt;r.codeEncrypted=oldEncrypted;r.active=oldActive;r.status=oldStatus;r.started=oldStarted;if(sh)sh.end=oldEnd;throw e}
 for(const [k,s] of sessions)if(s.id===r.id)sessions.delete(k);
 return json(res,200,{code,name:r.name});
}
if(req.method==='POST'&&u.pathname==='/api/rider-manage'&&auth.role==='admin'){
 const b=await body(req),r=data.riders.find(x=>x.id===b.id);
 if(!r)return json(res,404,{error:'Repartidor no encontrado'});
 if(!['archive','restore','delete'].includes(b.action))return json(res,400,{error:'Acción inválida'});
 const snapshot=JSON.stringify(data);
 if(b.action==='delete'){
   if(b.confirmName!==r.name)return json(res,400,{error:'Escribe el nombre exacto para confirmar'});
   data.riders=data.riders.filter(x=>x.id!==r.id);
   data.shifts=data.shifts.filter(x=>x.riderId!==r.id);
   data.points=data.points.filter(x=>x.riderId!==r.id);
 }else if(b.action==='archive'){
   if(r.archived)return json(res,409,{error:'Ya está archivado'});
   const now=new Date().toISOString(),sh=data.shifts.findLast(s=>s.riderId===r.id&&!s.end);
   if(sh)sh.end=now;
   r.archived=true;r.active=false;r.status='Desconectado';r.started=null;
 }else{
   if(!r.archived)return json(res,409,{error:'No está archivado'});
   r.archived=false;
 }
 try{await save()}catch(e){data=JSON.parse(snapshot);throw e}
 if(b.action!=='restore')for(const [key,s] of sessions)if(s.id===r.id)sessions.delete(key);
 return json(res,200,{ok:true});
}
if(req.method==='POST'&&u.pathname==='/api/revoke'&&auth.role==='admin'){let b=await body(req),r=data.riders.find(x=>x.id===b.id);if(!r)return json(res,404,{error:'No encontrado'});r.codeHash=hash(token(),r.codeSalt);r.active=false;r.status='Desconectado';r.started=null;for(const [k,s] of sessions)if(s.id===r.id)sessions.delete(k);await save();return json(res,200,{ok:true})}
if(auth.role!=='rider')return json(res,403,{error:'No autorizado'});
const r=data.riders.find(x=>x.id===auth.id);if(!r||r.archived)return json(res,403,{error:'Repartidor archivado o eliminado'});
if(req.method==='POST'&&u.pathname==='/api/shift'){const b=await body(req);if(b.action==='start'&&!r.active){r.active=true;r.started=new Date().toISOString();r.status='Disponible';data.shifts.push({id:crypto.randomUUID(),riderId:r.id,name:r.name,start:r.started,end:null,km:0})}else if(b.action==='end'&&r.active){r.active=false;r.status='Desconectado';r.started=null;const sh=data.shifts.findLast(s=>s.riderId===r.id&&!s.end);if(sh)sh.end=new Date().toISOString()}else if(b.action==='service'&&r.active){r.status=b.status==='En servicio'?'En servicio':'Disponible'}await save();return json(res,200,{me:sanitizeRider(r)})}
if(req.method==='POST'&&u.pathname==='/api/location'){if(!r.active)return json(res,409,{error:'Turno cerrado'});const b=await body(req),lat=Number(b.lat),lon=Number(b.lon),acc=Number(b.accuracy);if(!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lon)||Math.abs(lon)>180||!Number.isFinite(acc)||acc<0)return json(res,400,{error:'Coordenadas inválidas'});r.lat=lat;r.lon=lon;r.accuracy=acc;r.lastSeen=new Date().toISOString();const sh=data.shifts.findLast(s=>s.riderId===r.id&&!s.end);if(sh&&acc<=150){const last=[...data.points].reverse().find(p=>p.shiftId===sh.id&&p.accuracy<=150);if(last){const rad=Math.PI/180,dlat=(lat-last.lat)*rad,dlon=(lon-last.lon)*rad,a=Math.sin(dlat/2)**2+Math.cos(lat*rad)*Math.cos(last.lat*rad)*Math.sin(dlon/2)**2,km=12742*Math.asin(Math.min(1,Math.sqrt(a)));if(km>.02&&km<2)sh.km=+(sh.km+km).toFixed(2)}}data.points.push({riderId:r.id,shiftId:sh?.id,lat,lon,accuracy:acc,at:r.lastSeen});if(data.points.length>50000)data.points.splice(0,data.points.length-50000);await save();return json(res,200,{ok:true})}
return json(res,404,{error:'Ruta no encontrada'});
}catch(e){json(res,400,{error:e.message||'Error'})}};
loadData().then(()=>http.createServer(handler).listen(PORT,()=>console.log(`Estación GPS con Neon escuchando en puerto ${PORT}`))).catch(e=>{console.error('No se pudo conectar a Neon:',e.message);process.exit(1)});