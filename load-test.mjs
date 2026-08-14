import { io } from 'socket.io-client';
import { performance } from 'node:perf_hooks';
const url=process.env.TEST_URL||'http://127.0.0.1:3000',pin=process.env.GAME_PIN||'123456',hostToken=process.env.HOST_TOKEN||'load-test-secret',N=Number(process.env.PLAYERS||200);
const clients=[],players=[];let failed=0,acks=0,dupes=0;const latencies=[],answerTimes=[];
const emitAck=(s,e,p)=>new Promise((resolve,reject)=>{const t=performance.now();s.timeout(5000).emit(e,p,(err,r)=>{if(err)return reject(err);latencies.push(performance.now()-t);resolve(r)})});
for(let i=0;i<N;i++)clients.push(io(url,{transports:['websocket'],reconnection:true,timeout:5000,forceNew:true}));
await Promise.all(clients.map((s,i)=>new Promise(resolve=>{let done=false;const finish=()=>{if(!done){done=true;resolve()}};const timeout=setTimeout(()=>{failed++;finish()},10000);s.on('connect',async()=>{try{const r=await emitAck(s,'join',{pin,nickname:`Player ${i+1}`});if(r.ok)players[i]=r;else failed++}catch{failed++}clearTimeout(timeout);finish()});s.on('connect_error',()=>{});} )));
if(failed)throw new Error(`${failed} clients failed to connect or join`);
const host=io(url,{transports:['websocket'],forceNew:true});await new Promise(r=>host.on('connect',r));await emitAck(host,'host:join',{token:hostToken});
let latest;host.on('state',s=>latest=s);await emitAck(host,'host:action',{token:hostToken,action:'start',auto:false});
for(let q=0;q<15;q++){
  while(!latest||latest.phase!=='QUESTION'||latest.questionIndex!==q)await new Promise(r=>setTimeout(r,20));
  const wait=Math.max(0,latest.questionStartsAt-Date.now()+30);await new Promise(r=>setTimeout(r,wait));
  const burst=Date.now();const rs=await Promise.all(clients.map(async(s,i)=>{const p={sessionToken:players[i].sessionToken,questionId:latest.question.id,optionIndex:i%4};const r=await emitAck(s,'answer',p);answerTimes.push(Date.now());if(r.ok)acks++;const d=await emitAck(s,'answer',p);if(d.error==='duplicate')dupes++;return r}));
  if(rs.filter(r=>r.ok).length!==N)throw new Error(`Question ${q+1}: expected ${N} accepted answers`);
  if(q===4){for(let i=0;i<Math.min(10,N);i++){clients[i].disconnect();clients[i].connect()}await new Promise(r=>setTimeout(r,300));}
  await emitAck(host,'host:action',{token:hostToken,action:'reveal'});await emitAck(host,'host:action',{token:hostToken,action:'leaderboard'});if(q<14)await emitAck(host,'host:action',{token:hostToken,action:'next'});else await emitAck(host,'host:action',{token:hostToken,action:'end'});
  const sec=Math.max(1,(Math.max(...answerTimes.slice(-N))-burst)/1000);process.stdout.write(`Question ${q+1}/15: ${Math.round(N/sec)} answers/sec\n`);
}
latencies.sort((a,b)=>a-b);const pct=p=>latencies[Math.min(latencies.length-1,Math.floor(latencies.length*p))].toFixed(1);const buckets={};for(const t of answerTimes)buckets[Math.floor(t/1000)]=(buckets[Math.floor(t/1000)]||0)+1;
console.log(JSON.stringify({successfulConnections:N-failed,failedConnections:failed,peakAnswersPerSecond:Math.max(...Object.values(buckets)),answerAcknowledgements:acks,duplicateAnswersRejected:dupes,latencyMs:{p50:pct(.50),p95:pct(.95),p99:pct(.99)},questions:15,expectedScoredAnswers:N*15,scoredExactlyOnce:acks===N*15&&dupes===N*15,finalScoreConsistency:acks===N*15},null,2));
for(const s of clients)s.disconnect();host.disconnect();
