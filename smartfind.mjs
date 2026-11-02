// 罗宾猫雷达 · 雷达自己找聪明钱（她 11/2 22:49）：GMGN 那种「哪些钱包常常很早买到后来大涨的币」，全部本地算、只读链上
// 做法：从雷达自己读链的看板资料挑「后来涨 5 倍以上」和「没涨起来」的新币 → 查开盘头几分钟买进的真人钱包 → 统计每个钱包近 7 天的命中次数和胜率
// BNB Chain、Robinhood Chain 分开算（两条链会赚钱的通常不是同一批人）。结果写 data/smart_auto.json 给雷达画面看。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000', DEAD = '0x000000000000000000000000000000000000dead';
export function startSmartFind({ DIR, rpc, log }) {
  const F = join(DIR, 'data', 'smart_auto.json');
  let Z = (() => { try { return JSON.parse(readFileSync(F, 'utf8')); } catch { return {}; } })();
  for (const ch of ['bsc', 'rh']) { Z[ch] = Z[ch] || { done: {}, w: {} }; }
  const save = () => { try { writeFileSync(F, JSON.stringify(Z)); } catch {} };
  const RHU = ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org'];
  const rhRpc = async (m, p) => { let e; for (const u of RHU) { try { const j = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }), signal: AbortSignal.timeout(20000) })).json(); if (j.error) throw new Error(j.error.message); return j.result; } catch (x) { e = x; } } throw e; };
  const R = { bsc: rpc, rh: rhRpc };
  const FILES = { bsc: ['market_bsc.json', 'market_bsc_v4.json'], rh: ['market_rh.json'] };
  const WEEK = 7 * 86400e3;
  async function blockAt(ch, ms) { /* 用两个区块的时间推算这个时间点大约是第几块 */
    const h = await R[ch]('eth_getBlockByNumber', ['latest', false]); const head = parseInt(h.number, 16), ht = parseInt(h.timestamp, 16);
    const back = ch === 'bsc' ? 100000 : 200000; const o = await R[ch]('eth_getBlockByNumber', ['0x' + (head - back).toString(16), false]); const spb = (ht - parseInt(o.timestamp, 16)) / back;
    return { blk: Math.max(1, Math.round(head - (ht - ms / 1000) / spb)), spb, head };
  }
  async function earlyBuyers(ch, c, t0) {
    const { blk, spb, head } = await blockAt(ch, t0); const span = Math.min(6000, Math.ceil(600 / spb)); /* 开盘后约 10 分钟 */
    const from = Math.max(1, blk - Math.ceil(60 / spb)), to = Math.min(head, blk + span);
    const L = await R[ch]('eth_getLogs', [{ address: c, topics: [T], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
    if (!Array.isArray(L) || !L.length) return [];
    const snd = {}; for (const l of L) { const f = '0x' + l.topics[1].slice(26); snd[f] = (snd[f] || 0) + 1; }
    const pool = Object.entries(snd).filter(([a]) => a !== ZERO).sort((a, b) => b[1] - a[1])[0]?.[0]; /* 送出最多笔的通常是池子／曲线 */
    const out = []; for (const l of L) { const f = '0x' + l.topics[1].slice(26), to2 = '0x' + l.topics[2].slice(26); if (f !== pool || [ZERO, DEAD, c, pool].includes(to2) || out.includes(to2)) continue; out.push(to2); if (out.length >= 30) break; }
    const eoa = []; for (const a of out) { try { const code = await R[ch]('eth_getCode', [a, 'latest']); if (code === '0x' || code === '0x0') eoa.push(a); } catch {} }
    return eoa;
  }
  let busy = 0;
  async function run() {
    if (busy) return; busy = 1;
    try {
      for (const ch of ['bsc', 'rh']) {
        const S = Z[ch]; const now = Date.now(); const toks = [];
        for (const f of FILES[ch]) { try { const j = JSON.parse(readFileSync(join(DIR, 'data', f), 'utf8')); for (const x of Object.values(j.tokens || {})) toks.push(x); } catch {} }
        const win = [], lose = [];
        for (const x of toks) { const tr = Array.isArray(x.tr) ? x.tr : []; if (tr.length < 20 || tr.length >= 1500) continue; /* 太少看不出来；满 1500 笔代表开头被裁掉，看不到开盘 */
          const c = String(x.c || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(c) || S.done[c]) continue; const t0 = tr[0][0] * 1000; if (now - t0 > WEEK || now - t0 < 3 * 3600e3) continue; /* 开盘 3 小时后才判断涨没涨 */
          const p0 = +tr[0][3]; let mx = 0; for (const r of tr) if (+r[3] > mx) mx = +r[3]; if (!(p0 > 0)) continue; const m = mx / p0;
          if (m >= 5) win.push({ c, t0, m, sym: String(x.sym || '').slice(0, 20) }); else if (m < 1.5) lose.push({ c, t0, m, sym: String(x.sym || '').slice(0, 20) }); }
        win.sort((a, b) => b.m - a.m); lose.sort(() => Math.random() - 0.5);
        const pick = [...win.slice(0, 12).map((x) => ({ ...x, w: 1 })), ...lose.slice(0, 12).map((x) => ({ ...x, w: 0 }))];
        for (const x of pick) {
          let B = []; try { B = await earlyBuyers(ch, x.c, x.t0); } catch (e) { continue; } S.done[x.c] = now;
          for (const a of B) { const o = (S.w[a] = S.w[a] || { win: [], lose: [] }); if (x.w) { if (!o.win.some((y) => y.c === x.c)) o.win.push({ c: x.c, sym: x.sym, x: +x.m.toFixed(1), t: x.t0 }); } else if (!o.lose.some((y) => y.c === x.c)) o.lose.push({ c: x.c, t: x.t0 }); o.last = Math.max(o.last || 0, x.t0); }
          save();
        }
        /* 只留 7 天内的纪录 */
        for (const [a, o] of Object.entries(S.w)) { o.win = o.win.filter((y) => now - y.t < WEEK); o.lose = o.lose.filter((y) => now - y.t < WEEK); if (!o.win.length && !o.lose.length) delete S.w[a]; }
        for (const [c, t] of Object.entries(S.done)) if (now - t > WEEK) delete S.done[c];
        S.rank = Object.entries(S.w).filter(([, o]) => o.win.length >= 2).map(([a, o]) => ({ a, win: o.win.length, tries: o.win.length + o.lose.length, rate: +(o.win.length / (o.win.length + o.lose.length)).toFixed(2), best: o.win.slice().sort((p, q) => q.x - p.x)[0], last: o.last })).sort((p, q) => q.win - p.win || q.rate - p.rate).slice(0, 50);
        S.at = now; save();
      }
    } catch (e) { log('找聪明钱 ' + e.message); } finally { busy = 0; }
  }
  setTimeout(() => run().catch(() => {}), 90e3); setInterval(() => run().catch(() => {}), 60 * 60e3);
  log('雷达自己找聪明钱：每小时算一次（BNB Chain、Robinhood 分开）');
}
