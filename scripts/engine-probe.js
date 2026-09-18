const path=require('path');
const INIT=require(path.resolve(__dirname, '..', 'vendor/stockfish/stockfish-19-lite-single.js'));
const lines=[];
const engine={ locateFile:(f)=>f.endsWith('.wasm')?path.resolve(__dirname, '..', 'vendor/stockfish/stockfish-19-lite-single.wasm'):f, listener:(l)=>lines.push(l), print:(l)=>lines.push(l) };
const t0=Date.now();
INIT()(engine).then(function ready(){
  if (engine._isReady && !engine._isReady()) return setTimeout(ready,10);
  const send=c=>engine.ccall('command',null,['string'],[c],{async:/^go\b/.test(c)});
  send('uci'); send('isready');
  send('position fen rnb1kbnr/ppp2ppp/4p3/3p4/3Q4/8/PPPP1PPP/RNB1KBNR w KQkq - 0 4');
  send('go depth 12');
  const iv=setInterval(()=>{ const bm=lines.find(l=>/^bestmove/.test(l)); if(bm){ clearInterval(iv); console.log(lines.find(l=>/^id name/.test(l))); console.log(lines.filter(l=>/^info depth 12 /.test(l)).pop()?.slice(0,120)); console.log(bm, 'in', Date.now()-t0,'ms'); process.exit(0);} },50);
});
setTimeout(()=>{ console.log('TIMEOUT', lines.slice(-3)); process.exit(1); },40000);
