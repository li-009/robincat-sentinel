// 罗宾猫雷达 · 空投页（引擎这边）：截止日／领取日 TG 提醒、链上自动打勾、钱包交互统计
// 她 11/2 23:00。只读链上资料，不下单、不碰钱。结果写 data/air_state.json 给雷达画面看。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function startAir({ DIR, WALLETS, rpc, log, tgSay, radarSet }) {
  const F = join(DIR, 'data', 'air_state.json');
  let A = (() => { try { return JSON.parse(readFileSync(F, 'utf8')); } catch { return {}; } })();
  A.auto = A.auto || {}; A.days = A.days || {}; A.sent = A.sent || {};
  const save = () => { try { writeFileSync(F, JSON.stringify(A)); } catch {} };
  const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 10); };
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 10); };
  const tasks = () => (Array.isArray(radarSet().tasks) ? radarSet().tasks : []).filter((x) => x && x.id);
  const RH = 'https://rpc.mainnet.chain.robinhood.com';
  const rhRpc = async (m, p) => { const j = await (await fetch(RH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }), signal: AbortSignal.timeout(15000) })).json(); if (j.error) throw new Error(j.error.message); return j.result; };
  const R = (ch) => (ch === 'rh' ? rhRpc : rpc);

  // ① ⑤ 截止日前一天、领取日当天：早上 9 点后发一次 TG
  function remind() {
    const d = today(), h = new Date().getHours(); if (h < 9) return; const msg = [];
    for (const x of tasks()) {
      if (x.deadline && x.deadline === addDays(d, 1) && A.sent['dl' + x.id] !== d && !x.closed) { A.sent['dl' + x.id] = d; msg.push(`⏰ 明天截止：${x.name}${x.url ? '\n' + x.url : ''}`); }
      if (x.claimAt && x.claimAt === d && A.sent['cl' + x.id] !== d) { A.sent['cl' + x.id] = d; msg.push(`🎉 今天可以领：${x.name}${x.url ? '\n' + x.url : ''}`); }
    }
    if (msg.length) { save(); tgSay('🎁 空投提醒\n' + msg.join('\n\n')).catch(() => {}); }
  }
  // ② 链上自动打勾：任务填了合约，今天这个钱包有跟它互动（事件里出现这个钱包）就打勾
  let busy = 0;
  async function autoCheck() {
    if (busy) return; busy = 1;
    try {
      const d = today(); const T = tasks().filter((x) => x.daily && /^0x[0-9a-fA-F]{40}$/.test(x.contract || '')).slice(0, 20); if (!T.length) return;
      for (const x of T) {
        const ch = x.chain === 'rh' ? 'rh' : 'bsc'; const ws = (Array.isArray(x.wallets) && x.wallets.length ? x.wallets : WALLETS.map((w) => w.addr)).map((a) => String(a).toLowerCase()).slice(0, 5);
        const st = (A.auto[x.id] = A.auto[x.id]?.d === d ? A.auto[x.id] : { d, w: [], from: 0 }); const need = ws.filter((a) => !st.w.includes(a)); if (!need.length) continue;
        const head = parseInt(await R(ch)('eth_blockNumber', []), 16); const day0 = new Date(d + 'T00:00:00').getTime(); const bps = ch === 'rh' ? 4 : 2.2; /* 每秒约几个区块 */
        let from = Math.max(st.from || 0, head - Math.ceil(((Date.now() - day0) / 1000) * bps)); const pads = need.map((a) => '0x000000000000000000000000' + a.slice(2));
        for (let b = from; b <= head; b += 5000) { const to = Math.min(b + 4999, head); let L = []; try { L = await R(ch)('eth_getLogs', [{ address: x.contract.toLowerCase(), fromBlock: '0x' + b.toString(16), toBlock: '0x' + to.toString(16) }]); } catch { break; } for (const l of L || []) { const tp = (l.topics || []).map((t) => t.toLowerCase()); const dat = String(l.data || '').toLowerCase(); pads.forEach((p, i) => { if ((tp.includes(p) || dat.includes(p.slice(26))) && !st.w.includes(need[i])) st.w.push(need[i]); }); } st.from = to + 1; }
        save();
      }
    } catch (e) { log('空投自动打勾 ' + e.message); } finally { busy = 0; }
  }
  // ⑦ 钱包交互统计：每天记一次交易笔数，算活跃天数
  async function stats() {
    const d = today();
    for (const W of WALLETS) { const a = W.addr; const o = (A.days[a] = A.days[a] || { bsc: {}, rh: {} });
      for (const ch of ['bsc', 'rh']) { try { const n = parseInt(await R(ch)('eth_getTransactionCount', [a, 'latest']), 16); if (Number.isFinite(n)) o[ch][d] = n; } catch {} const ks = Object.keys(o[ch]).sort(); if (ks.length > 400) for (const k of ks.slice(0, ks.length - 400)) delete o[ch][k]; } }
    save();
  }
  setInterval(remind, 10 * 60e3); setTimeout(remind, 30e3);
  setInterval(() => autoCheck().catch(() => {}), 30 * 60e3); setTimeout(() => autoCheck().catch(() => {}), 60e3);
  setInterval(() => stats().catch(() => {}), 60 * 60e3); setTimeout(() => stats().catch(() => {}), 45e3);
  log('空投页：提醒、链上自动打勾、钱包统计已启动');
}
