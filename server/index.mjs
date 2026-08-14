import express from 'express';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import QRCode from 'qrcode';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiz = JSON.parse(fs.readFileSync(path.join(root, 'quiz.json'), 'utf8'));
const stateFile = process.env.STATE_FILE || path.join(root, 'game-state.json');
const port = Number(process.env.PORT || 3000);
const gamePin = process.env.GAME_PIN || '123456';
const hostToken = process.env.HOST_TOKEN || crypto.randomBytes(24).toString('hex');
const origins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(v=>v.trim());
const app = express(); const server = http.createServer(app);
const io = new Server(server, {cors:{origin: origins.includes('*') ? true : origins, methods:['GET','POST']}, transports:['websocket','polling'], pingInterval:10000, pingTimeout:8000, connectionStateRecovery:{maxDisconnectionDuration:120000,skipMiddlewares:true}});

const fresh = () => ({pin:gamePin, phase:'LOBBY', questionIndex:-1, gameStartTime:null, questionStartsAt:null, questionEndsAt:null, auto:false, paused:false, players:{}, answers:{}, history:[]});
let game = fresh();
try { const saved=JSON.parse(fs.readFileSync(stateFile,'utf8')); if(saved.pin===gamePin) game={...fresh(),...saved}; } catch {}
const save = () => { try { fs.writeFileSync(stateFile, JSON.stringify(game)); } catch {} };
setInterval(save,5000).unref();
const room = `game:${gamePin}`;
const now=()=>Date.now();
const safeNick = s => String(s||'Player').replace(/[<>]/g,'').trim().slice(0,20)||'Player';
const publicPlayers=()=>Object.values(game.players).map(({token,...p})=>p);
const leaderboard=()=>publicPlayers().sort((a,b)=>b.score-a.score||a.nickname.localeCompare(b.nickname)).map((p,i)=>({...p,rank:i+1}));
const currentQuestion=()=>quiz.questions[game.questionIndex];
const clientState=(playerId=null)=>{ const q=currentQuestion(); const answer=playerId&&game.answers[q?.id]?.[playerId]; return {pin:gamePin,title:quiz.title,phase:game.phase,questionIndex:game.questionIndex,totalQuestions:quiz.questions.length,gameStartTime:game.gameStartTime,questionStartsAt:game.questionStartsAt,questionEndsAt:game.questionEndsAt,auto:game.auto,paused:game.paused,connected:io.sockets.adapter.rooms.get(room)?.size||0,playerCount:Object.keys(game.players).length,answersReceived:q?Object.keys(game.answers[q.id]||{}).length:0,players:publicPlayers(),leaderboard:leaderboard().slice(0,game.phase==='FINISHED'?10:5),question:q&&game.phase!=='LOBBY'&&game.phase!=='FINISHED'?{id:q.id,text:q.text,options:q.options}:null,reveal:q&&['REVEAL','LEADERBOARD'].includes(game.phase)?{correctIndex:q.correctIndex,explanation:q.explanation,distribution:q.options.map((_,i)=>Object.values(game.answers[q.id]||{}).filter(a=>a.optionIndex===i).length),correctCount:Object.values(game.answers[q.id]||{}).filter(a=>a.correct).length}:null,myAnswer:answer||null,myPlayer:playerId?leaderboard().find(p=>p.id===playerId)||null:null}; };
const emitState=(personal=false)=>{ io.to(room).emit('state',clientState()); if(personal)for(const [id,p] of Object.entries(game.players)){ if(p.socketId) io.to(p.socketId).emit('state',clientState(id)); } };
let phaseTimer;
const schedule=(ms,fn)=>{clearTimeout(phaseTimer); phaseTimer=setTimeout(fn,ms);};
function startQuestion(index){ if(index>=quiz.questions.length||now()-game.gameStartTime>=600000) return finish(); game.questionIndex=index; game.phase='QUESTION'; game.questionStartsAt=now()+1000; game.questionEndsAt=game.questionStartsAt+20000; game.answers[currentQuestion().id]={}; save(); emitState(true); schedule(game.questionEndsAt-now(),()=>reveal()); }
function reveal(){ if(game.phase!=='QUESTION')return; game.phase='REVEAL'; save(); emitState(true); if(game.auto)schedule(5000,leaderPhase); }
function leaderPhase(){ if(!['QUESTION','REVEAL'].includes(game.phase))return; if(game.phase==='QUESTION')reveal(); game.phase='LEADERBOARD'; save(); emitState(true); if(game.auto)schedule(10000,()=>startQuestion(game.questionIndex+1)); }
function finish(){clearTimeout(phaseTimer);game.phase='FINISHED';save();emitState(true);}
function requireHost(token,ack){if(token!==hostToken){ack?.({ok:false,error:'unauthorized'});return false;}return true;}

io.on('connection',socket=>{
  socket.on('join',({pin,nickname,sessionToken}={},ack)=>{if(String(pin)!==gamePin)return ack?.({ok:false,error:'invalid_pin'}); let player=Object.values(game.players).find(p=>p.token===sessionToken); if(!player){let name=safeNick(nickname);const used=new Set(Object.values(game.players).map(p=>p.nickname));let n=2,base=name;while(used.has(name))name=`${base.slice(0,16)} ${n++}`;const id=crypto.randomUUID();player={id,nickname:name,score:0,correctAnswers:0,token:crypto.randomBytes(24).toString('base64url'),socketId:socket.id};game.players[id]=player;} player.socketId=socket.id;socket.join(room);save();ack?.({ok:true,playerId:player.id,sessionToken:player.token,nickname:player.nickname,state:clientState(player.id)});emitState();});
  socket.on('host:join',({token}={},ack)=>{if(!requireHost(token,ack))return;socket.join(room);socket.data.host=true;ack?.({ok:true,pin:gamePin,state:clientState(),hostToken:token});});
  socket.on('answer',({sessionToken,questionId,optionIndex}={},ack)=>{const received=now(),p=Object.values(game.players).find(x=>x.token===sessionToken),q=currentQuestion();if(!p)return ack?.({ok:false,error:'invalid_session'});if(game.phase!=='QUESTION'||!q||questionId!==q.id)return ack?.({ok:false,error:'wrong_question'});if(received<game.questionStartsAt)return ack?.({ok:false,error:'not_started'});if(received>game.questionEndsAt)return ack?.({ok:false,error:'too_late'});game.answers[q.id]??={};if(game.answers[q.id][p.id])return ack?.({ok:false,error:'duplicate'});const elapsedMs=received-game.questionStartsAt,correct=Number(optionIndex)===q.correctIndex,points=correct?500+Math.floor(500*Math.max(0,1-elapsedMs/(game.questionEndsAt-game.questionStartsAt))):0;game.answers[q.id][p.id]={optionIndex:Number(optionIndex),serverReceivedAt:received,elapsedMs,correct,points};p.score+=points;if(correct)p.correctAnswers++;save();ack?.({ok:true,locked:true,serverReceivedAt:received});io.to(room).emit('answer-count',{questionId:q.id,count:Object.keys(game.answers[q.id]).length});io.to(socket.id).emit('state',clientState(p.id));});
  socket.on('host:action',({token,action,auto}={},ack)=>{if(!requireHost(token,ack))return; if(action==='start'&&game.phase==='LOBBY'){game.gameStartTime=now();game.auto=!!auto;startQuestion(0);}else if(action==='reveal')reveal();else if(action==='leaderboard')leaderPhase();else if(action==='next')startQuestion(game.questionIndex+1);else if(action==='end')finish();else if(action==='pause'){game.paused=!game.paused;clearTimeout(phaseTimer);}else if(action==='reset'){game=fresh();save();emitState();}else return ack?.({ok:false,error:'invalid_action'});ack?.({ok:true});});
  socket.on('disconnect',()=>{for(const p of Object.values(game.players))if(p.socketId===socket.id)p.socketId=null;emitState();});
});

app.get('/health',(_req,res)=>res.json({ok:true,phase:game.phase,players:Object.keys(game.players).length,uptime:process.uptime()}));
app.get('/config.js',(_req,res)=>res.type('js').send(`window.REALTIME_SERVER_URL=${JSON.stringify(process.env.PUBLIC_REALTIME_SERVER_URL||'')};`));
app.get('/host',(_req,res)=>res.sendFile(path.join(root,'standalone','host.html')));
app.get('/join',(_req,res)=>res.sendFile(path.join(root,'standalone','index.html')));
app.get('/qr',async(req,res)=>{const url=String(req.query.url||'');res.type('png').send(await QRCode.toBuffer(url,{width:420,margin:1,color:{dark:'#071c4d',light:'#ffffff'}}));});
app.get('/export.csv',(req,res)=>{if(req.query.token!==hostToken)return res.sendStatus(403);const rows=['rank,nickname,score,correct_answers',...leaderboard().map(p=>`${p.rank},"${p.nickname.replaceAll('"','""')}",${p.score},${p.correctAnswers}`)];res.attachment('freedom-challenge-results.csv').send(rows.join('\n'));});
app.use(express.static(path.join(root,'standalone'))); app.use(express.static(path.join(root,'public')));
server.listen(port,'0.0.0.0',()=>{const lans=[];try{for(const xs of Object.values(os.networkInterfaces()))for(const x of xs||[])if(x.family==='IPv4'&&!x.internal)lans.push(x.address);}catch{}console.log(`\nFreedom Challenge ready\nHost: http://localhost:${port}/host?token=${hostToken}\nPlayers: http://${lans[0]||'localhost'}:${port}/join?pin=${gamePin}\nHost token: ${hostToken}\n`);});
