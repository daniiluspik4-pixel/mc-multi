const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),crypto=require('crypto');
const {pipeline}=require('stream/promises'),{Readable}=require('stream');
const {initializeApp}=require('firebase/app');
const {getAuth,createUserWithEmailAndPassword,signInWithEmailAndPassword,signOut}=require('firebase/auth');
const {initializeFirestore,doc,collection,onSnapshot,setDoc,getDoc,deleteDoc}=require('firebase/firestore');
const mineflayer=require('mineflayer');
process.on('uncaughtException',e=>console.error('Ошибка:',e.message));
process.on('unhandledRejection',e=>console.error('Ошибка:',e&&e.message||e));
const D=path.join(__dirname,'data');fs.mkdirSync(D,{recursive:true});
const CF=path.join(D,'config.json'),LIMIT=+process.env.MC_LIMIT_MB||200;
const fb=JSON.parse(fs.readFileSync(path.join(__dirname,'..','docs','firebase-config.json')));
let C={};try{C=JSON.parse(fs.readFileSync(CF))}catch{}
const saveC=()=>fs.writeFileSync(CF,JSON.stringify(C));
const app=initializeApp(fb),auth=getAuth(app),db=initializeFirestore(app,{experimentalForceLongPolling:true});
const mem=()=>process.memoryUsage().rss/1048576;

async function boot(){
  if(C.email){
    try{await signInWithEmailAndPassword(auth,C.email,C.pass)}
    catch(e){console.log('Старый ключ недействителен, создаю новый…');C={};saveC()}
  }
  if(!C.email){
    C.email='agent-'+crypto.randomBytes(5).toString('hex')+'@mcmulti.local';
    C.pass=crypto.randomBytes(18).toString('hex');
    await createUserWithEmailAndPassword(auth,C.email,C.pass);saveC();
  }
  const me=auth.currentUser.uid;
  if(C.owner){
    const s=await getDoc(doc(db,'pairings',me));
    if(!s.exists()||s.data().ownerUid!==C.owner){
      console.log('Привязка недействительна (ПК отвязан на сайте). Выдаю новый ключ…');
      C={};saveC();await signOut(auth);return boot();
    }
  }
  if(!C.owner){
    console.log('\n==============================================');
    console.log('НОВЫЙ КЛЮЧ (ID АГЕНТА) — вставь на сайте в «Подключить ПК»:\n');
    console.log(me);
    console.log('\n==============================================\n');
    await new Promise(r=>onSnapshot(doc(db,'pairings',me),s=>{if(s.exists()){C.owner=s.data().ownerUid;saveC();r()}}));
  }
  run(C.owner,me);
}
boot().catch(e=>{console.error(e);process.exit(1)});

function run(U,me){
  const P=(...p)=>doc(db,'users',U,...p);
  const A={},W={},R={},WR={},dirty=new Set();
  const rt=id=>R[id]??={status:'offline',log:[],chat:[]};
  const log=(id,m)=>{const r=rt(id);r.log.push(new Date().toLocaleTimeString()+' '+m);r.log=r.log.slice(-8);dirty.add(id)};
  const setW=(id,status,msg='')=>{WR[id]={...WR[id],status};setDoc(P('wstate',id),{status,msg})};
  function startBot(id){
    const a=A[id],r=rt(id);if(!a||r.bot)return;
    const t=a.target;if(!t){log(id,'Сервер не выбран — задай его на сайте');return}
    let host,port,version=t.version;
    if(t.kind==='world'){const w=W[t.worldId];if(!w||WR[w.id]?.status!=='running'){log(id,'Мир не запущен');return}host='127.0.0.1';port=w.port;version=w.version}
    else{host=t.host;port=+t.port||25565}
    if(mem()>LIMIT-25){log(id,'Лимит ОЗУ — запуск отменён');return}
    r.manual=true;r.status='connecting';dirty.add(id);
    const o={host,port,username:a.name,viewDistance:'tiny',hideErrors:true,checkTimeoutInterval:60000,auth:'offline'};
    if(version)o.version=version;
    if(a.type==='microsoft'){o.auth='microsoft';o.profilesFolder=path.join(D,'auth',id);
      o.onMsaCode=c=>{r.code={code:c.user_code,url:c.verification_uri};log(id,'Нужен вход Microsoft')}}
    let bot;try{bot=mineflayer.createBot(o)}catch(e){log(id,'Ошибка: '+e.message);r.status='offline';return}
    r.bot=bot;
    bot.once('spawn',()=>{r.status='online';r.code=null;log(id,'Зашёл');
      r.afk=setInterval(()=>{try{bot.swingArm();bot.setControlState('jump',true);setTimeout(()=>bot.setControlState('jump',false),300)}catch{}},45000)});
    bot.on('health',()=>{r.health=bot.health;r.food=bot.food;dirty.add(id)});
    bot.on('messagestr',m=>{r.chat.push(m.slice(0,200));r.chat=r.chat.slice(-40);dirty.add(id)});
    bot.on('move',()=>{const p=bot.entity.position;r.pos=[p.x|0,p.y|0,p.z|0];r.dim=bot.game.dimension});
    bot.on('kicked',x=>log(id,'Кик: '+JSON.stringify(x).slice(0,90)));
    bot.on('error',e=>log(id,'Ошибка: '+e.message));
    bot.on('end',()=>{clearInterval(r.afk);r.bot=null;r.code=null;r.status='offline';log(id,'Отключён');
      if(r.manual&&A[id]){r.status='reconnecting';r.timer=setTimeout(()=>startBot(id),15000)}});
  }
  function stopBot(id){const r=rt(id);r.manual=false;clearTimeout(r.timer);if(r.bot)r.bot.quit();else r.status='offline';dirty.add(id)}
  async function startWorld(id){
    const w=W[id];if(!w||WR[id]?.proc)return;
    const dir=path.join(D,'worlds',id),jar=path.join(D,'jars',w.version+'.jar');fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.dirname(jar),{recursive:true});
    try{
      if(!fs.existsSync(jar)){setW(id,'downloading','Скачиваю сервер '+w.version);
        const m=await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json();
        const v=m.versions.find(x=>x.id===w.version);if(!v)return setW(id,'error','Версия не найдена');
        const vj=await (await fetch(v.url)).json();const res=await fetch(vj.downloads.server.url);
        await pipeline(Readable.fromWeb(res.body),fs.createWriteStream(jar))}
      fs.writeFileSync(path.join(dir,'eula.txt'),'eula=true\n');
      const sp=path.join(dir,'server.properties');
      if(!fs.existsSync(sp))fs.writeFileSync(sp,`online-mode=false\nserver-port=${w.port}\nmotd=MC Multi\n`);
      setW(id,'starting','Запуск…');
      const p=cp.spawn('java',['-Xmx'+(w.ram||1024)+'M','-jar',jar,'nogui'],{cwd:dir});
      WR[id].proc=p;
      p.on('error',()=>{WR[id].proc=null;setW(id,'error','Java не найдена — установи Java 17/21')});
      p.stdout.on('data',d=>{if(/Done \(/.test(d))setW(id,'running','Мир запущен')});
      p.on('exit',()=>{WR[id].proc=null;setW(id,'stopped')});
    }catch(e){setW(id,'error',e.message)}
  }
  const stopWorld=id=>{const p=WR[id]?.proc;if(p)p.stdin.write('stop\n')};
  onSnapshot(collection(db,'users',U,'accounts'),s=>s.docChanges().forEach(c=>{
    const id=c.doc.id,old=A[id];
    if(c.type==='removed'){stopBot(id);delete A[id];deleteDoc(P('state',id));return}
    A[id]=c.doc.data();
    if(!old){if(A[id].autostart)setTimeout(()=>startBot(id),2000+Object.keys(A).length*3000)}
    else if(JSON.stringify(old.target)!==JSON.stringify(A[id].target)&&rt(id).bot){stopBot(id);setTimeout(()=>startBot(id),3000)}
  }));
  onSnapshot(collection(db,'users',U,'worlds'),s=>s.docChanges().forEach(c=>{
    const id=c.doc.id;if(c.type==='removed'){stopWorld(id);delete W[id]}else{W[id]={id,...c.doc.data()};if(!WR[id])setW(id,'stopped')}}));
  onSnapshot(collection(db,'users',U,'cmds'),s=>s.docChanges().forEach(c=>{
    if(c.type!=='added')return;const m=c.doc.data();deleteDoc(c.doc.ref);
    if(m.kind==='start')startBot(m.id);else if(m.kind==='stop')stopBot(m.id);
    else if(m.kind==='chat'){try{R[m.id]?.bot?.chat(String(m.text).slice(0,256))}catch{}}
    else if(m.kind==='wstart')startWorld(m.id);else if(m.kind==='wstop')stopWorld(m.id);
  }));
  setInterval(()=>{for(const id of dirty){const r=rt(id);
    setDoc(P('state',id),{status:r.status,health:r.health??null,food:r.food??null,pos:r.pos??null,dim:r.dim??null,code:r.code??null,chat:r.chat,log:r.log,t:Date.now()});}
    dirty.clear()},3000);
  setInterval(()=>setDoc(P('meta','agent'),{mem:+mem().toFixed(0),limit:LIMIT,t:Date.now(),host:os.hostname(),bots:Object.values(R).filter(r=>r.bot).length}),10000);
  onSnapshot(doc(db,'pairings',me),s=>{
    if(!s.exists()&&!s.metadata.fromCache){
      console.log('ПК отвязан на сайте. Останавливаю ботов и сбрасываю ключ…');
      Object.keys(R).forEach(stopBot);Object.keys(W).forEach(stopWorld);
      C={};saveC();
      setTimeout(()=>process.exit(0),4000);
    }
  });
  console.log('Агент работает, привязан к',U);
}
