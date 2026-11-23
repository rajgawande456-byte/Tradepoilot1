import WebSocket from 'ws';
import protobuf from 'protobufjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYS = { 'NIFTY 50':'NSE_INDEX|Nifty 50', BANKNIFTY:'NSE_INDEX|Nifty Bank', FINNIFTY:'NSE_INDEX|Nifty Fin Service' };
const __dirname=path.dirname(fileURLToPath(import.meta.url));
let rootPromise;
function getFeedType(){if(!rootPromise)rootPromise=protobuf.load(path.join(__dirname,'MarketDataFeedV3.proto')).then(root=>root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse'));return rootPromise;}
export function startUpstoxStream({token,marketStream,onStatus=()=>{}}={}){
 if(!token||!marketStream)return()=>{};
 let stopped=false,ws=null,timer=null,attempt=0,seq=0;
 async function connect(){
  if(stopped)return;
  try{
   const auth=await fetch('https://api.upstox.com/v3/feed/market-data-feed/authorize',{headers:{Accept:'application/json',Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});
   if(!auth.ok)throw new Error('Feed authorization HTTP '+auth.status);
   const body=await auth.json(),url=body?.data?.authorized_redirect_uri;
   if(typeof url!=='string'||!url.startsWith('wss://'))throw new Error('Secure feed URL missing');
   const FeedResponse=await getFeedType();
   ws=new WebSocket(url,{followRedirects:true,handshakeTimeout:15000});
   ws.on('open',()=>{attempt=0;onStatus('connected');ws.send(Buffer.from(JSON.stringify({guid:'tradepilot-'+Date.now(),method:'sub',data:{mode:'full',instrumentKeys:Object.values(KEYS)}})),{binary:true});});
   ws.on('message',(data,isBinary)=>{if(!isBinary)return;try{const decoded=FeedResponse.decode(data);const obj=FeedResponse.toObject(decoded,{longs:Number,enums:String,defaults:false});const feeds=obj.feeds||{};for(const [symbol,key] of Object.entries(KEYS)){const feed=feeds[key];if(!feed)continue;const ltpc=feed.ltpc||feed.ff?.indexFF?.ltpc||feed.ff?.marketFF?.ltpc||feed.fullFeed?.indexFF?.ltpc||feed.fullFeed?.marketFF?.ltpc||feed.firstLevelWithGreeks?.ltpc;const price=Number(ltpc?.ltp),ts=Number(obj.currentTs||ltpc?.ltt||Date.now());if(!Number.isFinite(price)||price<=0||!Number.isFinite(ts))continue;try{marketStream.publish({symbol,price,sequence:++seq,asOf:new Date(ts).toISOString()},'UPSTOX V3 WS');}catch{onStatus('tick_rejected');}}}catch{onStatus('decode_error');}});
   ws.on('error',()=>onStatus('error'));
   ws.on('close',()=>{onStatus('disconnected');schedule();});
  }catch{onStatus('error');schedule();}
 }
 function schedule(){if(stopped||timer)return;const delay=Math.min(30000,1000*(2**attempt));attempt++;timer=setTimeout(()=>{timer=null;connect();},delay);}
 connect();
 return()=>{stopped=true;if(timer)clearTimeout(timer);if(ws){ws.removeAllListeners('close');ws.close();}};
}
