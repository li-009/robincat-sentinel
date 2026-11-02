// 罗宾猫雷达：代币板的行情资料（她 11/2：要像 TMTN／GMGN 一样列出全部的币）。
// 雷达自己读 BNB Chain 链上：Four.meme、Flap 两个发射台的「新币建立／买／卖／进度／上 PancakeSwap」事件，
// 自己算价格、市值、进度、成交量、买卖笔数。只读公开节点，不用金钥、不花钱、不碰钱包。
// 资料只留最近 48 小时，存在 data/market_bsc.json，重开不用重抓。
const fs = require('fs');
const path = require('path');

const FOUR = '0x5c952063c7fc8610ffdb798152d69f0b9550762b';           // Four.meme TokenManager2
const FOUR_HELPER = '0xf251f83e40a78868fcfa3fa4599dad6494e46034';    // Four.meme TokenManagerHelper3（读进度用）
const FLAP = '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0';           // Flap Portal
const T = {
  fCreate: '0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20',
  fBuy: '0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942',
  fSell: '0x0a5575b3648bae2210cee56bf33254cc1ddfbc7bf637c0af2ac18b14fb1bae19',
  fLiq: '0xc18aa71171b358b706fe3dd345299685ba21a5316c66ffa9e319268b033c44b0',
  pCreate: '0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603',
  pBuy: '0xa800a2038683844fac66747f771bfdfae862eb28b16bcfa387afa9fbacce8ff7',
  pSell: '0x03a4693e592f5e75dc7c136acb39b146d2b4966c0e509c34f362dee02b3b861a',
  pProg: '0x4c35e20d1e9bce377c7d9ec1572d934e46d62961f4da8af5beb8002d5906742d',
  pQuote: '0x3ceb902d3c555c21c3415b6aa839104b18e4825b2f8324011ff979089a507a8c',
  pDex: '0x6e4f47630b8745b8cacbd44f42a8a33e7eea7cc08ef22fc7630f4f385784ff7d',
};
const TOPICS = Object.values(T);
const STABLE = new Set(['0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409']); // USDT USDC USD1 FDUSD
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const KEEP_MS = 48 * 3600e3, MAX_TRADES = 1500;

const RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed2.ninicoin.io'];
let ri = 0;
async function rpc(method, params) {
  let err;
  for (let k = 0; k < RPCS.length; k++) {
    const u = RPCS[(ri + k) % RPCS.length];
    try { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) }); const j = await r.json(); if (j.error) throw new Error(j.error.message || 'rpc error'); ri = (ri + k) % RPCS.length; return j.result; } catch (e) { err = e; }
  }
  throw err;
}
const W = (d, i) => d.slice(2 + 64 * i, 2 + 64 * (i + 1));
const A = (w) => '0x' + String(w).slice(24).toLowerCase();
const N = (w) => { try { return BigInt('0x' + (w || '0')); } catch { return 0n; } };
const F = (b, dec = 18) => Number(b) / 10 ** dec;
function S(d, i) { try { const off = Number(N(W(d, i))) * 2; const len = Number(N(d.slice(2 + off, 2 + off + 64))); return Buffer.from(d.slice(2 + off + 64, 2 + off + 64 + len * 2), 'hex').toString('utf8').replace(/[\u0000-\u001f]/g, '').slice(0, 40); } catch { return ''; } }

function startMarket({ DATA, log = () => {} }) {
  const FILE = path.join(DATA, 'market_bsc.json');
  let D = { block: 0, tokens: {} };
  try { D = { ...D, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
  const st = { ok: false, err: '', lastAt: 0, blockMs: 450, head: 0, headAt: 0 };
  let bnbUsd = 0, bnbAt = 0;
  const quoteUsd = {}; // 其他报价币（像 BNCB）的美金价，从 DexScreener 补
  async function bnb() { if (Date.now() - bnbAt < 60e3 && bnbUsd) return bnbUsd; try { const j = await (await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT', { signal: AbortSignal.timeout(8000) })).json(); if (+j.price > 0) { bnbUsd = +j.price; bnbAt = Date.now(); } } catch {} if (!bnbUsd) try { const j = await (await fetch('https://api.dexscreener.com/tokens/v1/bsc/' + WBNB, { signal: AbortSignal.timeout(8000) })).json(); const p = (j || []).find((x) => +x.priceUsd > 0); if (p) { bnbUsd = +p.priceUsd; bnbAt = Date.now(); } } catch {} return bnbUsd; }
  const qUsd = (q) => (!q || q === WBNB ? bnbUsd : STABLE.has(q) ? 1 : quoteUsd[q] || 0);
  const xUsd = (x) => (x.qk ? qUsd(x.q) : 0); /* 报价币还不确定（在补抓范围之前就建立的币）→ 先不算美金，免得市值乱跳 */
  const tok = (c) => (D.tokens[c] = D.tokens[c] || { c, tr: [] });
  const tsOf = (blk) => (st.headAt ? st.headAt - (st.head - blk) * st.blockMs : Date.now());
  const needInfo = new Set();

  function trade(c, t, buy, qAmt, price, who, q) {
    const x = D.tokens[c]; if (!x) return; /* 存报价币数量，显示时才换美金（报价币价钱晚到也算得对） */
    x.tr.push([Math.round(t / 1000), buy ? 1 : 0, +qAmt.toPrecision(6), +price.toPrecision(6), who.slice(2, 10)]); if (x.tr.length > MAX_TRADES) x.tr.splice(0, x.tr.length - MAX_TRADES);
    x.p = price; x.lt = t;
  }
  function onLog(l) {
    const t0 = l.topics[0], d = l.data, a = l.address.toLowerCase(), blk = parseInt(l.blockNumber, 16), t = tsOf(blk);
    if (a === FOUR) {
      if (t0 === T.fCreate) { const c = A(W(d, 1)); const x = tok(c); Object.assign(x, { plat: 'four', at: x.at || t, dev: A(W(d, 0)), nm: S(d, 3), sym: S(d, 4), sup: F(N(W(d, 5))) }); needInfo.add(c); }
      else if (t0 === T.fBuy || t0 === T.fSell) { const c = A(W(d, 0)); if (!D.tokens[c]) { tok(c).plat = 'four'; needInfo.add(c); } const x = D.tokens[c]; x.funds = F(N(W(d, 7))); if (x.maxF) x.prog = Math.min(100, (x.funds / x.maxF) * 100); { const qa = F(N(W(d, 4))), ta = F(N(W(d, 3))); trade(c, t, t0 === T.fBuy, qa, ta > 0 ? qa / ta : F(N(W(d, 2))), A(W(d, 1))); } }
      else if (t0 === T.fLiq) { const c = A(W(d, 0)); const x = D.tokens[c]; if (x) { x.grad = 1; x.gradAt = t; x.prog = 100; } }
    } else if (a === FLAP) {
      if (t0 === T.pCreate) { const c = A(W(d, 3)); const x = tok(c); Object.assign(x, { plat: 'flap', at: x.at || t, dev: A(W(d, 1)), nm: S(d, 4), sym: S(d, 5), sup: 1e9, qk: 1 }); }
      else if (t0 === T.pBuy || t0 === T.pSell) { const c = A(W(d, 1)); const x = D.tokens[c] || Object.assign(tok(c), { plat: 'flap', sup: 1e9 }); { const qa = F(N(W(d, 4))), ta = F(N(W(d, 3))); if (ta > 0) trade(c, t, t0 === T.pBuy, qa, qa / ta, A(W(d, 2))); } }
      else if (t0 === T.pProg) { const x = D.tokens[A(W(d, 0))]; if (x) x.prog = Math.min(100, F(N(W(d, 1)), 16)); }
      else if (t0 === T.pQuote) { const x = tok(A(W(d, 0))); const q = A(W(d, 1)); if (q !== '0x0000000000000000000000000000000000000000') x.q = q; }
      else if (t0 === T.pDex) { const x = D.tokens[A(W(d, 0))]; if (x) { x.grad = 1; x.gradAt = t; x.prog = 100; x.pool = A(W(d, 1)); } }
    }
  }
  async function info() { /* Four 的进度上限、报价币：每个新币问一次官方 Helper 合约 */
    const L = [...needInfo].slice(0, 40); if (!L.length) return; L.forEach((c) => needInfo.delete(c));
    for (let i = 0; i < L.length; i += 20) { const part = L.slice(i, i + 20); let res = [];
      for (const u of RPCS.slice(0, 2)) { try { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(part.map((c, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call', params: [{ to: FOUR_HELPER, data: '0x1f69565f' + c.slice(2).padStart(64, '0') }, 'latest'] }))), signal: AbortSignal.timeout(12000) }); const j = await r.json(); if (Array.isArray(j)) { res = []; for (const x of j) res[x.id] = x.result || ''; break; } } catch {} }
      part.forEach((c, k) => { const r = res[k] || '', x = D.tokens[c]; if (!x || r.length < 2 + 64 * 12) return; const q = A(W(r, 2)); x.q = q === '0x0000000000000000000000000000000000000000' ? '' : q; x.qk = 1; x.maxF = F(N(W(r, 10))); x.funds = F(N(W(r, 9))); if (x.maxF > 0) x.prog = Math.min(100, (x.funds / x.maxF) * 100); if (N(W(r, 11)) > 0n) { x.grad = 1; x.prog = 100; x.gradAt = x.gradAt || Date.now(); } }); }
  }
  async function names() { /* 在补抓范围之前就建立的币，读不到名字 → 直接问合约 symbol() */
    const L = Object.values(D.tokens).filter((x) => !x.sym && !x.nmTried).slice(0, 20); if (!L.length) return; L.forEach((x) => (x.nmTried = 1));
    let res = []; try { const r = await fetch(RPCS[0], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(L.map((x, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call', params: [{ to: x.c, data: '0x95d89b41' }, 'latest'] }))), signal: AbortSignal.timeout(12000) }); const j = await r.json(); if (Array.isArray(j)) for (const x of j) res[x.id] = x.result || ''; } catch {}
    L.forEach((x, k) => { const r = res[k] || ''; if (r.length >= 130) x.sym = S(r, 0); }); }
  let qAt = 0;
  async function qPrices() { if (Date.now() - qAt < 120e3) return; qAt = Date.now(); const L = [...new Set(Object.values(D.tokens).map((x) => x.q).filter((q) => q && q !== WBNB && !STABLE.has(q)))].slice(0, 30); if (!L.length) return;
    try { const ps = await (await fetch('https://api.dexscreener.com/tokens/v1/bsc/' + L.join(','), { signal: AbortSignal.timeout(10000) })).json(); const best = {}; for (const p of Array.isArray(ps) ? ps : []) { const a = String(p.baseToken?.address || '').toLowerCase(); const lq = +p.liquidity?.usd || 0; if (+p.priceUsd > 0 && (!best[a] || lq > best[a].lq)) best[a] = { v: +p.priceUsd, lq }; } for (const [a, b] of Object.entries(best)) quoteUsd[a] = b.v; } catch {} }
  async function head() { const b = await rpc('eth_getBlockByNumber', ['latest', false]); const n = parseInt(b.number, 16), ts = parseInt(b.timestamp, 16) * 1000; if (st.head && n > st.head && st.headTs) st.blockMs = Math.max(200, Math.min(3000, (ts - st.headTs) / (n - st.head) || st.blockMs)); st.head = n; st.headTs = ts; st.headAt = Math.min(Date.now(), ts + 300); return n; }
  async function pull(from, to) { const L = await rpc('eth_getLogs', [{ address: [FLAP], /* 她 11/2 17:59：Four.meme 已经没人玩，拿掉 */ topics: [TOPICS], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]); for (const l of L) { try { onLog(l); } catch {} } return L.length; }
  let busy = false, SPAN = 1500;
  async function tick() {
    if (busy) return; busy = true;
    try { await bnb(); const n = await head();
      let from = D.block ? D.block + 1 : n - 16000; if (n - from > 16000) from = n - 16000; /* 关很久再开：最多补 2 小时 */
      while (from <= n) { const to = Math.min(n, from + (n - from > 100 ? SPAN : 200)); try { await pull(from, to); } catch (e) { if (/limit|range|too many|exceed/i.test(String(e.message)) && SPAN > 50) { SPAN = Math.max(50, Math.floor(SPAN / 2)); continue; } throw e; } D.block = to; from = to + 1; } if (SPAN < 1500) SPAN = Math.min(1500, SPAN + 50); /* 她 11/2 19:17：公用节点回「limit exceeded」→ 每次查的范围自动缩小，之后慢慢放大 */
      await info(); await names(); await qPrices(); st.ok = true; st.err = ''; st.lastAt = Date.now();
    } catch (e) { st.ok = false; st.err = String(e.message || e).slice(0, 120); } finally { busy = false; }
  }
  function prune() { const cut = Date.now() - KEEP_MS; for (const [c, x] of Object.entries(D.tokens)) { if ((x.at || x.lt || 0) < cut && (x.lt || 0) < cut) delete D.tokens[c]; else if (x.tr.length && x.tr[0][0] * 1000 < cut) x.tr = x.tr.filter((r) => r[0] * 1000 >= cut); } }
  function save() { try { prune(); fs.writeFileSync(FILE, JSON.stringify(D)); } catch {} }
  setInterval(tick, 2500); setTimeout(tick, 500); setInterval(save, 60e3);

  /* 给画面用：每个币算好各时间段的成交、涨跌、买卖笔数 */
  const TF = { m1: 60, m5: 300, m15: 900, h1: 3600, h6: 21600, h24: 86400 };
  function view(x) { const now = Date.now() / 1000, u = xUsd(x); const out = { c: x.c, plat: x.plat, sym: x.sym || x.nm || x.c.slice(0, 8), nm: x.nm || '', at: x.at || (x.tr[0] ? x.tr[0][0] * 1000 : 0), dev: x.dev || '', prog: x.prog ?? (x.plat === 'flap' ? null : null), grad: !!x.grad, gradAt: x.gradAt || 0, pool: x.pool || (x.plat === 'four' ? x.c : ''), q: x.q || '', chg: {}, vol: {}, tx: {} };
    const px = x.p || 0; out.price = px * u; out.mc = px * (x.sup || 1e9) * u; out.liq = x.plat === 'four' && x.funds ? x.funds * u : 0;
    for (const [k, s] of Object.entries(TF)) { const R = x.tr.filter((r) => r[0] >= now - s); let b = 0, se = 0, v = 0; const w = new Set(); for (const r of R) { r[1] ? b++ : se++; v += r[2]; w.add(r[4]); } out.vol[k] = Math.round(v * u); out.tx[k] = { b, s: se, u: w.size }; const p0 = R[0]?.[3]; out.chg[k] = p0 && px ? ((px / p0 - 1) * 100) : 0; }
    out.n = x.tr.length; return out; }
  function board() {
    const all = Object.values(D.tokens).filter((x) => x.plat && x.plat !== 'four' && (x.at || x.tr.length)); const V = all.map(view);
    const fresh = V.filter((x) => !x.grad && (x.prog ?? 0) < 50).sort((a, b) => b.at - a.at).slice(0, 300);
    const soon = V.filter((x) => !x.grad && (x.prog ?? 0) >= 50).sort((a, b) => (b.prog || 0) - (a.prog || 0)).slice(0, 200);
    const done = V.filter((x) => x.grad).sort((a, b) => (b.gradAt || b.at) - (a.gradAt || a.at)).slice(0, 200);
    return { cols: [{ k: 'fresh', zh: '🆕 新创建', en: '🆕 New', items: fresh }, { k: 'soon', zh: '🚀 即将发射', en: '🚀 About to launch', items: soon }, { k: 'done', zh: '✅ 已迁移', en: '✅ Migrated', items: done }],
      src: 'chain', at: st.lastAt, total: all.length, err: (st.ok || (st.lastAt && Date.now() - st.lastAt < 60e3)) ? '' : (st.err ? '读链暂时不顺：' + st.err : '读取中…'), lagMs: st.lastAt ? Date.now() - st.lastAt : null }; }
  /* 曲线上的币没有交易池可以画 K 线 → 用链上成交自己画 */
  function candles(c, sec) { const x = D.tokens[String(c || '').toLowerCase()]; if (!x || !x.tr.length) return []; const u = xUsd(x) || 1; const out = []; let cur = null;
    for (const r of x.tr) { const t = Math.floor(r[0] / sec) * sec, p = r[3] * u; if (!cur || cur.t !== t * 1000) { cur = { t: t * 1000, o: p, h: p, l: p, c: p, v: 0 }; out.push(cur); } cur.h = Math.max(cur.h, p); cur.l = Math.min(cur.l, p); cur.c = p; cur.v += r[2] * u; }
    return out.slice(-160); }
  function setQuoteUsd(q, v) { if (v > 0) quoteUsd[q] = v; }
  function quotes() { return [...new Set(Object.values(D.tokens).map((x) => x.q).filter((q) => q && q !== WBNB && !STABLE.has(q)))].slice(0, 30); }
  return { board, candles, raw: () => ({ tokens: D.tokens, usd: (x) => xUsd(x) }), plat: (c) => D.tokens[String(c || '').toLowerCase()]?.plat || '', has: (c) => !!D.tokens[String(c || '').toLowerCase()], setQuoteUsd, quotes, status: () => ({ ...st, total: Object.keys(D.tokens).length }) };
}
module.exports = { startMarket };
