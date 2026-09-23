import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();
const app=express(), PORT=process.env.PORT||5000;
const origins=new Set((process.env.FRONTEND_ORIGIN||'http://localhost:5500,http://127.0.0.1:5500,http://localhost:3000').split(','));
app.use(cors({origin(origin,done){return !origin||origins.has(origin)?done(null,true):done(new Error('Origin not allowed'));},credentials:true}));
app.use(express.json({limit:'1mb'}));
app.use(session({name:'life_replay_session',secret:process.env.SESSION_SECRET||'change-this-development-session-secret',resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',path:'/',maxAge:604800000}}));
const userFile=path.join(process.cwd(),'data','users.json');
fs.mkdirSync(path.dirname(userFile),{recursive:true});
const storedUsers=fs.existsSync(userFile)?JSON.parse(fs.readFileSync(userFile,'utf8')):[];
const users=new Map(storedUsers.map(user=>[user.username.toLowerCase(),user])), saveUsers=()=>fs.writeFileSync(userFile,JSON.stringify([...users.values()]));
const usernamePattern=/^[A-Za-z0-9_-]{3,30}$/;
const userView=user=>({id:user.id,username:user.username});
const validPassword=value=>typeof value==='string'&&value.length>=7;
const requireAuth=(req,res,next)=>req.session.user?next():res.status(401).json({success:false,message:'Not authenticated.'});
const attempts=new Map();
function throttle(req,res,next){let now=Date.now(),key=req.ip,list=(attempts.get(key)||[]).filter(time=>now-time<60000);if(list.length>=12)return res.status(429).json({success:false,message:'Too many attempts. Please try again shortly.'});req.recordAttempt=()=>attempts.set(key,[...list,now]);next();}
app.get('/api/health',(req,res)=>res.json({success:true,message:'Life Replay API is working'}));
app.post('/api/auth/signup',throttle,async(req,res)=>{let username=String(req.body?.username||'').trim(),password=String(req.body?.password||''),key=username.toLowerCase();if(!usernamePattern.test(username))return res.status(400).json({success:false,message:'Username must be 3–30 characters and use only letters, numbers, underscores, or hyphens.'});if(!validPassword(password))return res.status(400).json({success:false,message:'Use at least 7 characters.'});if(users.has(key))return res.status(409).json({success:false,message:'Username already exists'});let user={id:crypto.randomUUID(),username,passwordHash:await bcrypt.hash(password,12)};users.set(key,user);saveUsers();req.session.user=userView(user);res.status(201).json({success:true,user:userView(user)});});
app.post('/api/auth/login',throttle,async(req,res)=>{let username=String(req.body?.username||'').trim(),password=String(req.body?.password||''),user=users.get(username.toLowerCase());if(!user||!(await bcrypt.compare(password,user.passwordHash))){req.recordAttempt();return res.status(401).json({success:false,message:'Invalid username or password.'});}req.session.user=userView(user);res.json({success:true,user:userView(user)});});
app.get('/api/auth/me',(req,res)=>req.session.user?res.json({success:true,user:req.session.user}):res.status(401).json({success:false,message:'Not authenticated.'}));
app.post('/api/auth/logout',(req,res)=>req.session.destroy(()=>{res.clearCookie('life_replay_session');res.json({success:true});}));
const num=(value,max=24)=>Math.max(0,Math.min(max,Number(value)||0));
const validLogs=logs=>Array.isArray(logs)&&logs.length>0&&logs.length<=1000;
const score=log=>Math.round(Math.min(100,Math.min(num(log.coding)/4,1)*35+Math.min(num(log.reading)/2,1)*20+Math.min(num(log.exercise),1)*20+Math.max(0,1-Math.abs(num(log.sleep)-8)/4)*25));
const compactLogs=logs=>logs.slice(-14).map(log=>({date:String(log.date||'').slice(0,10),productivity:score(log),sleep:num(log.sleep),energy:num(log.energy,5),mood:String(log.mood||'').slice(0,30),coding:num(log.coding),reading:num(log.reading),exercise:num(log.exercise)}));
const unavailable=error=>error?.status===503||error?.code===503||error?.status==='UNAVAILABLE';
async function gemini(contents){if(!process.env.GEMINI_API_KEY)throw Object.assign(new Error('AI chat is not configured.'),{status:503});let ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY}),config={maxOutputTokens:300,temperature:.6};try{return await ai.models.generateContent({model:'gemini-3.6-flash',contents,config});}catch(error){if(!unavailable(error))throw error;return ai.models.generateContent({model:'gemini-3.5-flash-lite',contents,config});}}
app.post('/api/productivity',requireAuth,(req,res)=>!validLogs(req.body.logs)?res.status(400).json({success:false,message:'Provide at least one life log.'}):res.json({success:true,score:Math.round(req.body.logs.reduce((sum,log)=>sum+score(log),0)/req.body.logs.length)}));
async function insight(req,res,instruction){if(!validLogs(req.body.logs))return res.status(400).json({success:false,message:'Provide at least one life log.'});try{let response=await gemini(`You are Life Replay AI, a personal productivity and life-pattern assistant. ${instruction} Use only this compact activity data: ${JSON.stringify(compactLogs(req.body.logs))}. Be concise, practical, non-medical, and never invent statistics. Question: ${String(req.body.question||'').slice(0,300)}`);res.json({success:true,insight:response.text||'No response was returned.'});}catch(error){console.error('AI request failed:',error.message);res.status(error.status||502).json({success:false,message:'I couldn’t reach the AI service right now. Your Life Replay data is safe. Please try again.'});}}
app.post('/api/ai-insight',requireAuth,(req,res)=>insight(req,res,'Give a concise reflection with observations and a practical next step.'));
for(const [name,instruction] of Object.entries({weekly:'Write a weekly reflection with wins, one observed pattern, and one next step.',patterns:'Identify up to three observable patterns. Do not claim causation.',goal:'Suggest one measurable goal and a realistic first step.',ask:'Answer the user question using only the supplied data.'}))app.post(`/api/ai-${name}`,requireAuth,(req,res)=>insight(req,res,instruction));
app.post('/api/ai/chat',requireAuth,async(req,res)=>{let message=String(req.body?.message||'').trim().slice(0,500),context=req.body.context||{},history=Array.isArray(req.body.history)?req.body.history.slice(-8).map(item=>({role:item?.role==='user'?'user':'assistant',text:String(item?.text||'').slice(0,500)})):[];if(!message)return res.status(400).json({success:false,message:'Please enter a question.'});let safe={stats:context.stats||{},recentLogs:Array.isArray(context.recentLogs)?context.recentLogs.slice(-14):[],weeklyStats:context.weeklyStats||{},monthlyStats:context.monthlyStats||{},goals:Array.isArray(context.goals)?context.goals.slice(0,10):[],achievements:Array.isArray(context.achievements)?context.achievements.slice(0,12):[]};if(!safe.stats.totalDays)return res.json({success:true,reply:"I don't have enough logged data yet to identify a reliable pattern. Try logging a few more days."});try{let response=await gemini(`You are Life Replay AI, a personal productivity and life-pattern assistant. Use actual supplied data only; never invent statistics. Distinguish observations from suggestions, be conversational and concise, and preserve paragraph/list line breaks. Recent conversation: ${JSON.stringify(history)}. User question: ${message}. Compact context: ${JSON.stringify(safe)}`);res.json({success:true,reply:response.text||'I could not form a reply from the available data.'});}catch(error){console.error('AI chat failed:',error.message);res.status(error.status||502).json({success:false,message:'I couldn’t reach the AI service right now. Your Life Replay data is safe. Please try again.'});}});
app.use((err,req,res,next)=>err instanceof SyntaxError?res.status(400).json({success:false,message:'Invalid JSON request.'}):res.status(500).json({success:false,message:'Server error.'}));
app.use((req,res)=>res.status(404).json({success:false,message:'Not found.'}));
app.listen(PORT,()=>console.log(`Life Replay API running at http://localhost:${PORT}`));