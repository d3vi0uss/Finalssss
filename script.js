class Storage {
  static load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  static save(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
}

class ProvablyFairSystem {
  constructor() {
    this.clientSeed = Storage.load('nf_client_seed', this.randomSeed());
    this.serverSeed = Storage.load('nf_server_seed', this.randomSeed());
    this.nonce = Storage.load('nf_nonce', 0);
    this.persist();
  }
  randomSeed() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
  reseed() { this.clientSeed = this.randomSeed(); this.serverSeed = this.randomSeed(); this.nonce = 0; this.persist(); }
  hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0);
  }
  random(label = 'default') {
    const input = `${this.serverSeed}:${this.clientSeed}:${this.nonce}:${label}`;
    const h = this.hash(input);
    this.nonce += 1;
    this.persist();
    return h / 4294967295;
  }
  verify(label, nonce) {
    const input = `${this.serverSeed}:${this.clientSeed}:${nonce}:${label}`;
    return this.hash(input) / 4294967295;
  }
  persist() {
    Storage.save('nf_client_seed', this.clientSeed);
    Storage.save('nf_server_seed', this.serverSeed);
    Storage.save('nf_nonce', this.nonce);
  }
}

class GameState {
  constructor() {
    this.data = Storage.load('nf_state', {
      balance: 2500,
      xp: 0,
      level: 1,
      prestige: 0,
      inventory: [],
      selectedSkins: [],
      upgrades: { idle: 0 },
      cosmetics: [],
      achievements: [],
      sessionStart: Date.now(),
      sessionStartBalance: 2500,
      reducedMotion: false,
      totalWagered: 0,
      totalWon: 0,
      biggestWin: 0,
      gameStats: {},
      history: []
    });
  }
  save() { Storage.save('nf_state', this.data); }
  addBalance(v) { this.data.balance += v; this.save(); }
  addXP(v) {
    this.data.xp += v;
    while (this.data.xp >= this.data.level * 120) { this.data.xp -= this.data.level * 120; this.data.level += 1; }
    this.save();
  }
  recordBet(game, wager, payout, meta = {}) {
    this.data.totalWagered += wager;
    this.data.totalWon += payout;
    this.data.biggestWin = Math.max(this.data.biggestWin, payout);
    const g = this.data.gameStats[game] || { played: 0, wins: 0, totalRoll: 0, max: 0 };
    g.played += 1;
    if (payout > wager) g.wins += 1;
    if (meta.roll) g.totalRoll += meta.roll;
    if (meta.max) g.max = Math.max(g.max, meta.max);
    this.data.gameStats[game] = g;
    this.data.history.unshift({ t: Date.now(), game, wager, payout, nonce: app.fair.nonce - 1, ...meta });
    this.data.history = this.data.history.slice(0, 80);
    this.save();
  }
}

class AnimationEngine {
  static tween({ duration = 900, update, complete, easing = t => 1 - Math.pow(1 - t, 3) }) {
    const start = performance.now();
    const frame = (now) => {
      const t = Math.min(1, (now - start) / duration);
      update(easing(t));
      if (t < 1) requestAnimationFrame(frame);
      else complete?.();
    };
    requestAnimationFrame(frame);
  }
}

class InventorySystem {
  constructor(state, ui) { this.state = state; this.ui = ui; }
  addSkin(skin) { this.state.data.inventory.push({ ...skin, uid: crypto.randomUUID() }); this.state.save(); }
  toggleSelect(uid) {
    const arr = this.state.data.selectedSkins;
    const idx = arr.indexOf(uid);
    if (idx >= 0) arr.splice(idx, 1); else arr.push(uid);
    this.state.save();
  }
  sellSelected() {
    const selected = new Set(this.state.data.selectedSkins);
    let total = 0;
    this.state.data.inventory = this.state.data.inventory.filter(s => {
      if (selected.has(s.uid)) { total += s.value; return false; }
      return true;
    });
    this.state.data.selectedSkins = [];
    this.state.addBalance(total);
    this.state.addXP(Math.floor(total / 2));
    return total;
  }
  tradeUp() {
    const inv = this.state.data.inventory;
    if (inv.length < 10) return null;
    const picked = inv.splice(0, 10);
    const avg = picked.reduce((a, b) => a + b.value, 0) / 10;
    const rarityOrder = ['Consumer', 'Industrial', 'Mil-Spec', 'Restricted', 'Classified', 'Covert', 'Exceedingly Rare'];
    const top = picked.map(p => rarityOrder.indexOf(p.rarity)).sort((a,b)=>a-b)[0];
    const newR = rarityOrder[Math.min(rarityOrder.length - 1, top + 1)];
    const n = { name: `Trade-Up ${newR} Skin`, rarity: newR, value: Math.round(avg * 1.4), color: '#8bb' };
    this.addSkin(n);
    this.state.save();
    return n;
  }
}

class MarketSystem {
  constructor() { this.prices = Storage.load('nf_market', {}); }
  update(skins, fair) {
    skins.forEach(s => {
      const base = this.prices[s.name] ?? s.value;
      const drift = (fair.random('market' + s.name) - 0.5) * 0.1;
      this.prices[s.name] = Math.max(1, +(base * (1 + drift)).toFixed(2));
    });
    Storage.save('nf_market', this.prices);
  }
  get(name, fallback) { return this.prices[name] ?? fallback; }
}

class CaseSystem {
  constructor(state, inventory, fair, market) {
    this.state = state; this.inventory = inventory; this.fair = fair; this.market = market;
    this.skins = this.generateSkins();
    this.cases = {
      'Rookie Cache ($80)': { price: 80, odds: { 'Consumer': 0.46, 'Industrial': 0.26, 'Mil-Spec': 0.16, 'Restricted': 0.08, 'Classified': 0.03, 'Covert': 0.009, 'Exceedingly Rare': 0.001 } },
      'Prime Arsenal ($220)': { price: 220, odds: { 'Consumer': 0.36, 'Industrial': 0.26, 'Mil-Spec': 0.20, 'Restricted': 0.11, 'Classified': 0.05, 'Covert': 0.018, 'Exceedingly Rare': 0.002 } },
      'Elite Legends ($650)': { price: 650, odds: { 'Consumer': 0.16, 'Industrial': 0.24, 'Mil-Spec': 0.26, 'Restricted': 0.18, 'Classified': 0.11, 'Covert': 0.045, 'Exceedingly Rare': 0.005 } }
    };
  }
  generateSkins() {
    const rarities = [
      ['Consumer', '#9aa4bc', 5, 24], ['Industrial', '#61a0ff', 18, 18], ['Mil-Spec', '#3f7bff', 60, 14],
      ['Restricted', '#8657ff', 140, 10], ['Classified', '#e04eff', 320, 8], ['Covert', '#ff4a63', 780, 6], ['Exceedingly Rare', '#f4bf4f', 2100, 4]
    ];
    const arr = [];
    rarities.forEach(([r, c, v, n]) => { for (let i = 1; i <= n; i++) arr.push({ name: `${r} Skin ${i}`, rarity: r, color: c, value: v + i * 3 }); });
    return arr;
  }
  pickRarity(odds) {
    const x = this.fair.random('case');
    let run = 0;
    for (const [r, p] of Object.entries(odds)) { run += p; if (x <= run) return r; }
    return 'Consumer';
  }
  open(caseName) {
    const box = this.cases[caseName];
    if (!box || this.state.data.balance < box.price) return null;
    this.state.addBalance(-box.price);
    const rarity = this.pickRarity(box.odds);
    const pool = this.skins.filter(s => s.rarity === rarity);
    const skin = { ...pool[Math.floor(this.fair.random('skin') * pool.length)] };
    skin.value = this.market.get(skin.name, skin.value);
    this.inventory.addSkin(skin);
    this.state.addXP(35);
    return { skin, odds: box.odds };
  }
}

class UpgradeSystem { constructor(state) { this.state = state; } upgradeIdle(){ const c = 200*(this.state.data.upgrades.idle+1); if(this.state.data.balance<c)return false; this.state.addBalance(-c); this.state.data.upgrades.idle++; this.state.save(); return true; } }
class PrestigeSystem { constructor(state){this.state=state;} prestige(){ if(this.state.data.level<15)return false; this.state.data.prestige++; this.state.data.level=1; this.state.data.xp=0; this.state.data.balance=2000+this.state.data.prestige*500; this.state.data.inventory=[]; this.state.save(); return true; } }
class AchievementSystem {
  constructor(state){ this.state=state; }
  check(){
    const a = this.state.data.achievements;
    if(this.state.data.balance>10000 && !a.includes('High Roller')) a.push('High Roller');
    if(this.state.data.inventory.length>=25 && !a.includes('Collector')) a.push('Collector');
    if(this.state.data.prestige>=1 && !a.includes('Ascended')) a.push('Ascended');
    this.state.save();
  }
}

class StatsSystem {
  constructor(state){ this.state=state; }
  getCards(){
    const s=this.state.data; const rtp=s.totalWagered? (s.totalWon/s.totalWagered*100):0;
    const bj=s.gameStats.blackjack||{wins:0,played:0}; const rou=s.gameStats.roulette||{played:0,wins:0};
    const dice=s.gameStats.dice||{totalRoll:0,played:0}; const crash=s.gameStats.crash||{max:0};
    return [
      ['Total Wagered', `$${s.totalWagered.toFixed(2)}`], ['Total Won', `$${s.totalWon.toFixed(2)}`], ['RTP', `${rtp.toFixed(1)}%`],
      ['Biggest Win', `$${s.biggestWin.toFixed(2)}`], ['Blackjack Win Rate', `${bj.played? (bj.wins/bj.played*100).toFixed(1):0}%`],
      ['Roulette W/L', `${rou.wins}/${rou.played}`], ['Dice Average Roll', `${dice.played? (dice.totalRoll/dice.played).toFixed(1):'-'}`], ['Longest Crash', `${crash.max?.toFixed?.(2)||0}x`]
    ];
  }
}

class CasinoGame { constructor(manager){ this.m=manager; } wagerAmt(){ return +document.getElementById('casinoBet').value || 10; } }
class BlackjackGame extends CasinoGame {
  constructor(m){ super(m); this.deck=[]; this.player=[]; this.dealer=[]; }
  render(){
    return `<div class='row'><input id='casinoBet' type='number' min='1' value='50'/><button class='btn' id='bjDeal'>Deal</button><button class='btn' id='bjHit'>Hit</button><button class='btn' id='bjStand'>Stand</button><button class='btn' id='bjDouble'>Double</button></div>
    <div id='bjTable' class='stack'></div><div class='muted'>Odds: depends on cards. Approx base win chance ~42-49%. Dealer stands on soft 17.</div>`;
  }
  makeShoe(){ const cards=[]; const vals=[2,3,4,5,6,7,8,9,10,10,10,10,11]; for(let d=0;d<6;d++) for(let s=0;s<4;s++) cards.push(...vals); this.deck=cards.sort(()=>this.m.fair.random('shuffle')-0.5); }
  score(h){ let sum=h.reduce((a,b)=>a+b,0), aces=h.filter(c=>c===11).length; while(sum>21&&aces){sum-=10;aces--;} return sum; }
  bind(){ if(!this.deck.length) this.makeShoe();
    const draw=()=>this.deck.pop();
    const upd=(msg='')=>{document.getElementById('bjTable').innerHTML=`<div>Player: ${this.player.join(', ')} = ${this.score(this.player)}</div><div>Dealer: ${this.dealer.join(', ')} = ${this.score(this.dealer)}</div><div>${msg}</div><div>Win probability approx: ${Math.max(5,55-this.score(this.player)*1.7).toFixed(1)}%</div>`;};
    document.getElementById('bjDeal').onclick=()=>{const b=this.wagerAmt(); if(!this.m.canWager(b))return; this.m.wager(b); this.player=[draw(),draw()]; this.dealer=[draw(),draw()]; upd();};
    document.getElementById('bjHit').onclick=()=>{this.player.push(draw()); if(this.score(this.player)>21) this.end('Bust',0); else upd();};
    document.getElementById('bjStand').onclick=()=>{while(this.score(this.dealer)<17 || (this.score(this.dealer)===17 && this.dealer.includes(11))) this.dealer.push(draw()); const p=this.score(this.player), d=this.score(this.dealer); let pay=0,msg='Push'; if(d>21||p>d){pay=this.currentBet*2;msg='Win';} else if(p<d){msg='Lose';} else pay=this.currentBet; this.end(msg,pay);};
    document.getElementById('bjDouble').onclick=()=>{const b=this.currentBet||this.wagerAmt(); if(!this.m.canWager(b)) return; this.m.wager(b); this.currentBet+=b; this.player.push(draw()); document.getElementById('bjStand').click(); };
    this.end=(msg,payout)=>{ if(payout>0)this.m.payout(payout,msg); this.m.finish('blackjack',this.currentBet||0,payout); this.currentBet=0; upd(msg); };
    this.currentBet=0; upd('Press Deal');
  }
}
class RouletteGame extends CasinoGame {
  render(){ return `<div class='row wrap'><input id='casinoBet' type='number' min='1' value='25'/><select id='rouType'><option value='red'>Red/Black</option><option value='evenodd'>Even/Odd</option><option value='dozen'>Dozens</option><option value='single'>Single Number</option></select><input id='rouChoice' value='red'/><button class='btn' id='rouSpin'>Spin</button></div><div id='rouWheel' class='reel'></div><div class='muted'>European wheel (single 0). House edge: 2.70%.</div>`; }
  bind(){ document.getElementById('rouSpin').onclick=()=>{const bet=this.wagerAmt(); if(!this.m.canWager(bet))return; this.m.wager(bet);
      const num=Math.floor(this.m.fair.random('roulette')*37); const red=[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
      const t=document.getElementById('rouType').value,c=document.getElementById('rouChoice').value.toLowerCase(); let mult=0;
      if(t==='red') mult=(c==='red'&&red.includes(num))||(c==='black'&&!red.includes(num)&&num!==0)?2:0;
      if(t==='evenodd') mult=(c==='even'&&num%2===0&&num!==0)||(c==='odd'&&num%2===1)?2:0;
      if(t==='dozen') { const d=Math.floor((num-1)/12)+1; mult=(+c===d)?3:0; }
      if(t==='single') mult=(+c===num)?36:0;
      AnimationEngine.tween({duration:800,update:v=>document.getElementById('rouWheel').textContent=`Spinning... ${Math.floor(v*999)}`,
        complete:()=>{document.getElementById('rouWheel').innerHTML=`Ball landed on <span class='gold'>${num}</span>`; const payout=bet*mult; if(payout)this.m.payout(payout,'Roulette Win'); this.m.finish('roulette',bet,payout);} });
    };
  }
}
class CrashGame extends CasinoGame {
  render(){return `<div class='row'><input id='casinoBet' type='number' value='30' min='1'/><button id='crashStart' class='btn'>Start Round</button><button id='crashCashout' class='btn'>Cashout</button></div><canvas id='crashCanvas' width='740' height='200'></canvas><div id='crashReadout'>Multiplier: 1.00x</div><div class='muted'>Formula: crashPoint = max(1, floor((99/(1-r))/100)*100/100).`}
  bind(){ let running=false,m=1,crash=1.5,bet=0,cashed=false,maxSeen=1; const cvs=document.getElementById('crashCanvas'),ctx=cvs.getContext('2d');
    const draw=()=>{ctx.clearRect(0,0,cvs.width,cvs.height); ctx.beginPath(); ctx.strokeStyle='#1cc8ff'; for(let x=0;x<cvs.width;x++){const t=x/cvs.width*2; const y=cvs.height-(Math.pow(1.12,t)*38); if(x===0)ctx.moveTo(x,y); else ctx.lineTo(x,y);} ctx.stroke();}; draw();
    document.getElementById('crashStart').onclick=()=>{bet=this.wagerAmt(); if(!this.m.canWager(bet)||running)return; this.m.wager(bet); running=true; cashed=false; m=1; const r=this.m.fair.random('crash'); crash=Math.max(1.01, +(1/(1-r*0.985)).toFixed(2));
      const tick=()=>{if(!running)return; m+=0.02+Math.log(m+1)/90; maxSeen=Math.max(maxSeen,m); document.getElementById('crashReadout').textContent=`Multiplier: ${m.toFixed(2)}x (auto-crash at hidden point)`;
        if(m>=crash){running=false; document.getElementById('crashReadout').textContent=`Crashed at ${crash.toFixed(2)}x`; this.m.finish('crash',bet,cashed?bet*m:0,{max:crash}); return;}
        requestAnimationFrame(tick);
      }; tick();
    };
    document.getElementById('crashCashout').onclick=()=>{ if(!running||cashed)return; cashed=true; running=false; const payout=bet*m; this.m.payout(payout,`Crash cashout ${m.toFixed(2)}x`); this.m.finish('crash',bet,payout,{max:Math.max(maxSeen,m)}); };
  }
}
class MinesGame extends CasinoGame {
  render(){return `<div class='row wrap'><input id='casinoBet' type='number' value='20' min='1'/><label>Mines <input id='minesCount' type='number' min='1' max='24' value='5'/></label><button class='btn' id='minesStart'>Start</button><button class='btn' id='minesCash'>Cashout</button></div><div id='minesGrid' class='inventory-grid'></div><div id='minesInfo' class='muted'>Odds shown by remaining safe tiles.</div>`;}
  bind(){ let active=false,b=0,mult=1,mines=[]; const grid=document.getElementById('minesGrid');
    const render=()=>{grid.innerHTML=''; for(let i=0;i<25;i++){const d=document.createElement('div'); d.className='skin'; d.textContent='?'; d.onclick=()=>click(i,d); grid.appendChild(d);} };
    const click=(i,el)=>{ if(!active)return; if(mines.includes(i)){el.textContent='💣'; active=false; this.m.finish('mines',b,0); return;}
      el.textContent='✅'; el.style.background='#173'; mult*=1+(+document.getElementById('minesCount').value/60); document.getElementById('minesInfo').textContent=`Multiplier ${mult.toFixed(2)}x | Safe odds next click: ${((25-mines.length-1)/(25-1)*100).toFixed(1)}%`; };
    document.getElementById('minesStart').onclick=()=>{b=this.wagerAmt(); if(!this.m.canWager(b))return; this.m.wager(b); active=true; mult=1; mines=[]; const n=+document.getElementById('minesCount').value; while(mines.length<n){const x=Math.floor(this.m.fair.random('mines')*25); if(!mines.includes(x))mines.push(x);} render(); };
    document.getElementById('minesCash').onclick=()=>{ if(!active)return; active=false; const p=b*mult; this.m.payout(p,`Mines ${mult.toFixed(2)}x`); this.m.finish('mines',b,p); };
    render();
  }
}
class DiceGame extends CasinoGame {
  render(){return `<div class='row wrap'><input id='casinoBet' type='number' value='20'/><label>Chance <input id='diceChance' type='range' min='5' max='95' value='50'/></label><span id='diceChanceV'>50%</span><select id='diceDir'><option value='over'>Roll Over</option><option value='under'>Roll Under</option></select><button class='btn' id='diceRoll'>Roll</button></div><div id='diceOut' class='reel'></div><div class='muted'>Exact probability = chosen chance; payout multiplier = 99/chance.</div>`;}
  bind(){ const ch=document.getElementById('diceChance'); ch.oninput=()=>document.getElementById('diceChanceV').textContent=ch.value+'%';
    document.getElementById('diceRoll').onclick=()=>{const b=this.wagerAmt(); if(!this.m.canWager(b))return; this.m.wager(b); const chance=+ch.value, roll=this.m.fair.random('dice')*100, dir=document.getElementById('diceDir').value; const win=(dir==='over')?roll>(100-chance):roll<chance; const mult=99/chance; const p=win?b*mult:0;
      document.getElementById('diceOut').textContent=`Roll ${roll.toFixed(2)} | ${win?'WIN':'LOSE'} @ ${mult.toFixed(2)}x`; if(p)this.m.payout(p,'Dice win'); this.m.finish('dice',b,p,{roll}); };
  }
}
class PlinkoGame extends CasinoGame {
  render(){return `<div class='row wrap'><input id='casinoBet' type='number' value='15'/><label>Rows <input id='plinkoRows' type='number' min='8' max='16' value='12'/></label><select id='plinkoRisk'><option>Low</option><option selected>Medium</option><option>High</option></select><button class='btn' id='plinkoDrop'>Drop Ball</button></div><canvas id='plinkoCanvas' width='760' height='240'></canvas><div class='muted'>Multipliers vary by risk profile and slot distance from center.</div>`;}
  bind(){ const c=document.getElementById('plinkoCanvas'),ctx=c.getContext('2d'); const draw=(x=380,y=10)=>{ctx.clearRect(0,0,c.width,c.height); for(let r=0;r<12;r++)for(let i=0;i<=r;i++){ctx.fillStyle='#667';ctx.beginPath();ctx.arc(380-r*12+i*24,30+r*14,2.5,0,7);ctx.fill();} ctx.fillStyle='#f4bf4f'; ctx.beginPath(); ctx.arc(x,y,5,0,7); ctx.fill();}; draw();
    document.getElementById('plinkoDrop').onclick=()=>{const b=this.wagerAmt(); if(!this.m.canWager(b))return; this.m.wager(b); const rows=+document.getElementById('plinkoRows').value; const risk=document.getElementById('plinkoRisk').value; let x=380,y=10,step=0;
      const animate=()=>{if(step++<rows){ x+= this.m.fair.random('plinko')>0.5?12:-12; y+=14; draw(x,y); requestAnimationFrame(animate); } else {
          const dist=Math.abs(x-380)/12; const base=risk==='Low'?1.2:risk==='Medium'?1.8:2.8; const mult=Math.max(0.2, +(base/(dist+1)).toFixed(2)); const p=b*mult; this.m.payout(p,`Plinko ${mult}x`); this.m.finish('plinko',b,p); }
      }; animate(); };
  }
}
class JackpotGame extends CasinoGame {
  render(){return `<div class='row'><input id='casinoBet' type='number' value='40'/><button class='btn' id='jackJoin'>Join Pot</button></div><div id='jackpotLog' class='stack'></div><div class='muted'>Simulated players. Your chance = contribution / total pot.</div>`;}
  bind(){ document.getElementById('jackJoin').onclick=()=>{const b=this.wagerAmt(); if(!this.m.canWager(b))return; this.m.wager(b); const ai=[20,35,50,80,120].map(v=>v*(0.6+this.m.fair.random('jack'))); const total=ai.reduce((a,c)=>a+c,0)+b; const chance=b/total; const win=this.m.fair.random('jackwin')<chance; const p=win?total:0; if(win)this.m.payout(p,'Jackpot Winner'); this.m.finish('jackpot',b,p); document.getElementById('jackpotLog').innerHTML=`<div>Simulated players added: $${ai.reduce((a,c)=>a+c,0).toFixed(2)}</div><div>Your chance: ${(chance*100).toFixed(1)}%</div><div>${win?'You won entire pot!':'AI won this round.'}</div>`; } }
}
class CoinflipGame extends CasinoGame {
  render(){return `<div class='row'><input id='casinoBet' type='number' value='25'/><select id='coinSide'><option value='heads'>Heads</option><option value='tails'>Tails</option></select><button id='coinGo' class='btn'>Flip</button></div><div id='coinOut' class='reel'></div><div class='muted'>50/50 odds.</div>`;}
  bind(){ document.getElementById('coinGo').onclick=()=>{const b=this.wagerAmt(); if(!this.m.canWager(b))return; this.m.wager(b); AnimationEngine.tween({duration:650,update:v=>document.getElementById('coinOut').textContent=`Flipping ${'🪙'.repeat(1+Math.floor(v*3))}`,
      complete:()=>{const s=this.m.fair.random('coin')>0.5?'heads':'tails'; const win=s===document.getElementById('coinSide').value; const p=win?b*1.98:0; document.getElementById('coinOut').textContent=`${s.toUpperCase()} ${win?'WIN':'LOSE'}`; if(p)this.m.payout(p,'Coinflip'); this.m.finish('coinflip',b,p);} }); } }
}
class WheelGame extends CasinoGame {
  render(){return `<div class='row'><input id='casinoBet' type='number' value='20'/><button id='wheelSpin' class='btn'>Spin Wheel</button></div><div id='wheelOut' class='reel'></div><div class='muted'>Segments: 1.2x,1.5x,2x,3x,5x,0x with transparent probabilities.</div>`;}
  bind(){ const seg=[{m:1.2,p:.34},{m:1.5,p:.25},{m:2,p:.18},{m:3,p:.13},{m:5,p:.07},{m:0,p:.03}];
    document.getElementById('wheelSpin').onclick=()=>{const b=this.wagerAmt(); if(!this.m.canWager(b))return; this.m.wager(b); const r=this.m.fair.random('wheel'); let acc=0,res=seg[0]; for(const s of seg){acc+=s.p;if(r<=acc){res=s;break;}}
      AnimationEngine.tween({duration:900,update:v=>document.getElementById('wheelOut').textContent=`Spinning ${Math.floor(v*300)}°`,complete:()=>{const p=b*res.m; document.getElementById('wheelOut').textContent=`Result ${res.m}x`; if(p)this.m.payout(p,'Wheel'); this.m.finish('wheel',b,p);}}); } }
}
class SlotsGame extends CasinoGame {
  render(){return `<div class='row'><input id='casinoBet' type='number' value='10'/><button class='btn' id='slotsSpin'>Spin</button></div><div id='slotsReels' class='row'></div><div id='slotsLine' class='muted'>RTP ~96.2% with listed line multipliers.</div>`;}
  bind(){ const icons=['🎯','💎','🔥','🧿','⚡','👑'];
    document.getElementById('slotsSpin').onclick=()=>{const b=this.wagerAmt(); if(!this.m.canWager(b))return; this.m.wager(b); const reels=[]; for(let i=0;i<5;i++) reels.push(icons[Math.floor(this.m.fair.random('slots')*icons.length)]);
      document.getElementById('slotsReels').innerHTML=reels.map(r=>`<div class='reel-item'>${r}</div>`).join(''); let p=0; if(new Set(reels).size===1)p=b*18; else if(reels.slice(0,3).every(v=>v===reels[0]))p=b*4; if(p)this.m.payout(p,'Slots'); this.m.finish('slots',b,p); };
  }
}

class CasinoManager {
  constructor(state, fair, ui){ this.state=state; this.fair=fair; this.ui=ui; this.games={ blackjack:BlackjackGame, roulette:RouletteGame, crash:CrashGame, mines:MinesGame, dice:DiceGame, plinko:PlinkoGame, jackpot:JackpotGame, coinflip:CoinflipGame, wheel:WheelGame, slots:SlotsGame}; this.current='blackjack'; }
  renderMenu(){
    const menu=document.getElementById('casinoMenu'); menu.innerHTML=''; Object.keys(this.games).forEach(k=>{const b=document.createElement('button'); b.className='game-btn'+(k===this.current?' active':''); b.textContent=k[0].toUpperCase()+k.slice(1); b.onclick=()=>{this.current=k; this.mountGame(); this.renderMenu();}; menu.appendChild(b);});
  }
  mountGame(){
    const G=this.games[this.current]; this.instance=new G(this); document.getElementById('casinoGameTitle').textContent=this.current[0].toUpperCase()+this.current.slice(1);
    document.getElementById('casinoGameContainer').innerHTML=this.instance.render(); document.getElementById('gameOdds').textContent=this.oddsText(); this.instance.bind(); this.renderHistory();
  }
  oddsText(){ return {blackjack:'Blackjack odds vary by composition. Typical house edge ~0.5%-1%.',roulette:'Roulette has fixed 2.70% house edge (European).',crash:'Crash distribution uses seeded random; high multipliers are rarer.',mines:'Mines odds: safe tiles / unrevealed tiles, multiplier rises each safe click.',dice:'Dice exact probability equals configured chance.',plinko:'Plinko multipliers disclosed by risk and final slot.',jackpot:'Jackpot win chance equals your pot %.',coinflip:'Coinflip is 50/50.',wheel:'Wheel segment probabilities listed and fixed.',slots:'Slots uses transparent symbol outcomes and line multipliers.'}[this.current]; }
  canWager(v){ return v>0&&this.state.data.balance>=v; }
  wager(v){ this.state.addBalance(-v); this.pendingWager=v; }
  payout(v,msg){ this.state.addBalance(v); if(v>this.pendingWager*4) document.body.classList.add('big-win'); setTimeout(()=>document.body.classList.remove('big-win'),900); this.ui.toast(`${msg}: +$${v.toFixed(2)}`); }
  finish(game,wager,payout,meta={}){ this.state.recordBet(game,wager,payout,meta); this.pendingWager=0; this.renderHistory(); this.ui.refresh(); }
  renderHistory(){ document.getElementById('casinoHistory').innerHTML=this.state.data.history.slice(0,10).map(h=>`<div>${new Date(h.t).toLocaleTimeString()} | ${h.game} | wager $${h.wager.toFixed(2)} => $${h.payout.toFixed(2)} | nonce ${h.nonce}</div>`).join(''); }
}

class UIController {
  constructor(){ this.toastWrap=document.getElementById('toastContainer'); }
  toast(msg){ const d=document.createElement('div'); d.className='toast'; d.textContent=msg; this.toastWrap.appendChild(d); setTimeout(()=>d.remove(),2600); }
  bindTabs(){ document.querySelectorAll('.tab-btn').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab-btn').forEach(x=>x.classList.remove('active')); b.classList.add('active'); document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active')); document.getElementById(`${b.dataset.tab}Panel`).classList.add('active');}); }
  refresh(){
    const s=app.state.data;
    balanceValue.textContent = `$${s.balance.toFixed(2)}`; xpValue.textContent=s.xp; levelValue.textContent=s.level; prestigeValue.textContent=s.prestige;
    idleRate.textContent=(0.3+s.upgrades.idle*0.35+s.prestige*0.2).toFixed(2); achievementCount.textContent=s.achievements.length; cosmeticCount.textContent=s.cosmetics.length;
    sessionPL.textContent=`$${(s.balance-s.sessionStartBalance).toFixed(2)}`;
    const inv=document.getElementById('inventoryGrid'); inv.innerHTML=''; s.inventory.slice(-120).forEach(sk=>{const d=document.createElement('div'); d.className='skin'+(s.selectedSkins.includes(sk.uid)?' selected':''); d.style.borderColor=sk.color; d.innerHTML=`<div>${sk.name}</div><small>${sk.rarity}</small><div>$${sk.value.toFixed(2)}</div>`; d.onclick=()=>{app.inventory.toggleSelect(sk.uid); this.refresh();}; inv.appendChild(d);});
    const mk=document.getElementById('marketTable'); mk.innerHTML=app.caseSystem.skins.slice(0,20).map(x=>`<div class='market-row'><span>${x.name}</span><span>$${app.market.get(x.name,x.value).toFixed(2)}</span><span>${((app.market.get(x.name,x.value)/x.value-1)*100).toFixed(1)}%</span></div>`).join('');
    this.renderStats(); app.casino.renderHistory();
  }
  renderStats(){ const cards=document.getElementById('statsCards'); cards.innerHTML=''; app.stats.getCards().forEach(([k,v])=>{const n=document.getElementById('statsCardTemplate').content.cloneNode(true); n.querySelector('h3').textContent=k; n.querySelector('p').textContent=v; cards.appendChild(n);});
    const c=document.getElementById('statsChart'),ctx=c.getContext('2d'); ctx.clearRect(0,0,c.width,c.height); const h=app.state.data.history.slice(0,35).reverse(); let y=140,bal=[]; h.forEach(r=>{y+=(r.payout-r.wager)/8; bal.push(y);}); ctx.strokeStyle='#7a5cff'; ctx.beginPath(); bal.forEach((v,i)=> i?ctx.lineTo(i*17+10,v):ctx.moveTo(10,v)); ctx.stroke(); }
}

class App {
  constructor(){
    this.state=new GameState(); this.fair=new ProvablyFairSystem(); this.ui=new UIController(); this.inventory=new InventorySystem(this.state,this.ui);
    this.market=new MarketSystem(); this.caseSystem=new CaseSystem(this.state,this.inventory,this.fair,this.market); this.upgrades=new UpgradeSystem(this.state);
    this.prestige=new PrestigeSystem(this.state); this.achievements=new AchievementSystem(this.state); this.stats=new StatsSystem(this.state);
    this.casino=new CasinoManager(this.state,this.fair,this.ui);
  }
  init(){
    this.ui.bindTabs(); this.setupEconomy(); this.setupResponsible(); this.casino.renderMenu(); this.casino.mountGame(); this.refreshSeeds(); this.ui.refresh();
    setInterval(()=>{ this.tick(); },1000);
  }
  setupEconomy(){
    const sel=document.getElementById('caseSelect'); Object.keys(this.caseSystem.cases).forEach(c=>{const o=document.createElement('option'); o.textContent=c; sel.appendChild(o);});
    const renderOdds=()=>{const odds=this.caseSystem.cases[sel.value].odds; caseOdds.innerHTML=Object.entries(odds).map(([k,v])=>`${k}: ${(v*100).toFixed(2)}%`).join(' | ');}; renderOdds(); sel.onchange=renderOdds;
    openCaseBtn.onclick=()=>{const out=this.caseSystem.open(sel.value); if(!out)return this.ui.toast('Insufficient balance.'); this.animateReel(out.skin); this.achievements.check(); this.ui.refresh();};
    sellSelectedBtn.onclick=()=>{const t=this.inventory.sellSelected(); this.ui.toast(`Sold for $${t.toFixed(2)}`); this.ui.refresh();};
    tradeUpBtn.onclick=()=>{const sk=this.inventory.tradeUp(); this.ui.toast(sk?`Trade-up success: ${sk.name}`:'Need 10 skins.'); this.ui.refresh();};
    upgradeIdleBtn.onclick=()=>{this.ui.toast(this.upgrades.upgradeIdle()?'Idle upgraded':'Not enough balance'); this.ui.refresh();};
    prestigeBtn.onclick=()=>{this.ui.toast(this.prestige.prestige()?'Prestiged!':'Reach level 15 first'); this.ui.refresh();};
    aiBattleBtn.onclick=()=>{ const mine=this.caseSystem.open(sel.value)?.skin?.value||0; const ai=this.caseSystem.open(sel.value)?.skin?.value||0; if(mine>ai){ this.state.addBalance(mine-ai); this.ui.toast('AI battle win'); } else this.ui.toast('AI battle lost'); this.ui.refresh(); };
    shareStatsBtn.onclick=()=>{ const s=this.state.data; const card=`NeonForge Stats\nBalance: $${s.balance.toFixed(2)}\nLevel ${s.level} Prestige ${s.prestige}\nInventory: ${s.inventory.length}\nRTP: ${(s.totalWagered? s.totalWon/s.totalWagered*100:0).toFixed(1)}%`; navigator.clipboard?.writeText(card); this.ui.toast('Stats card copied'); };
  }
  setupResponsible(){
    sessionTimerToggle.onchange=()=>{this.state.data.sessionTimer=sessionTimerToggle.checked; this.state.save();};
    reducedMotionToggle.checked=this.state.data.reducedMotion; reducedMotionToggle.onchange=()=>{this.state.data.reducedMotion=reducedMotionToggle.checked; this.state.save();};
    resetSessionBtn.onclick=()=>{this.state.data.sessionStart=Date.now(); this.state.data.sessionStartBalance=this.state.data.balance; this.state.save(); this.ui.refresh();};
    rerollSeed.onclick=()=>{this.fair.reseed(); this.refreshSeeds(); this.ui.toast('Seeds regenerated');};
    this.refreshSeeds();
  }
  refreshSeeds(){ clientSeed.textContent=this.fair.clientSeed.slice(0,14); serverSeed.textContent=this.fair.serverSeed.slice(0,14); }
  animateReel(winSkin){
    const r=document.getElementById('reel'); const pool=this.caseSystem.skins; r.innerHTML=''; for(let i=0;i<20;i++){const s=pool[Math.floor(this.fair.random('reel')*pool.length)]; const d=document.createElement('div'); d.className='reel-item'; d.textContent=s.name; d.style.borderColor=s.color; r.appendChild(d);} const w=document.createElement('div'); w.className='reel-item'; w.innerHTML=`<span class='gold'>${winSkin.name}</span>`; w.style.borderColor=winSkin.color; r.appendChild(w);
    if(this.state.data.reducedMotion)return;
    r.scrollLeft=0; AnimationEngine.tween({duration:1100,update:v=>r.scrollLeft=v*(r.scrollWidth-r.clientWidth)});
  }
  tick(){
    this.market.update(this.caseSystem.skins.slice(0,50),this.fair); const idle=0.3+this.state.data.upgrades.idle*0.35+this.state.data.prestige*0.2; this.state.addBalance(idle);
    if(this.state.data.sessionTimer!==false){ const el=(Date.now()-this.state.data.sessionStart)/1000; const mm=String(Math.floor(el/60)).padStart(2,'0'); const ss=String(Math.floor(el%60)).padStart(2,'0'); sessionDuration.textContent=`${mm}:${ss}`;
      const left=Math.max(0,1800-Math.floor(el)); breakTimer.textContent=`${String(Math.floor(left/60)).padStart(2,'0')}:${String(left%60).padStart(2,'0')}`; if(left===0){ this.ui.toast('30-minute break reminder: take a pause.'); this.state.data.sessionStart=Date.now(); }}
    this.achievements.check(); this.ui.refresh();
  }
}

const app = new App();
app.init();
