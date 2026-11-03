// 罗宾猫雷达 · AVE 资料（她 11/3 15:20：跟 AVE 合作，用 AVE 的资料让看盘更丰富）
// 只在有 .sign/ave_key.txt 的电脑跑（Nancy 的雷达）；金钥不会离开这台电脑，也不会写进任何档案或日志
// ① 每 5 分钟抓一轮清单（约 50 单位）② 每 2 分钟把看盘上 AVE 清单没有的新币批次补查（50 个 100 单位）
// 整理成 data/ave_board.json；用量记在 data/ave_usage.json，一天超过 3 万单位自动放慢并提醒一次
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://prod.ave-api.com';
const LISTS = [
  ['platform', 'tag=flap_in_new&limit=100', 10], ['platform', 'tag=flap_in_almost&limit=100', 10], ['platform', 'tag=flap_in_hot&limit=100', 10],
  ['platform', 'tag=flap_out_new&limit=100', 10], ['platform', 'tag=flap_out_hot&limit=100', 10],
  ['trending', 'chain=bsc&page_size=100', 5], ['trending', 'chain=robinhood&page_size=100', 5],
];
const DAY_SOFT = 30000; // 一天超过这么多单位就放慢
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const okUrl = (u) => (/^https:\/\/[^\s"'<>]{4,300}$/.test(String(u || '')) ? String(u) : '');
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

export function addAveUsage(DIR, cu) { /* 雷达视窗那边（合约分析、K 线）也会呼叫，所以单独汇出 */
  const f = join(DIR, 'data', 'ave_usage.json'); let u = {}; try { u = JSON.parse(readFileSync(f, 'utf8')); } catch {}
  if (u.d !== today()) u = { d: today(), cu: 0, calls: 0, prev: u.d ? { d: u.d, cu: u.cu } : u.prev };
  u.cu += cu; u.calls = (u.calls || 0) + 1; u.at = Date.now(); try { writeFileSync(f, JSON.stringify(u)); } catch {} return u.cu;
}

export function startAve({ DIR, log, tg }) {
  const KF = join(DIR, '.sign', 'ave_key.txt'); if (!existsSync(KF)) return null;
  const key = () => { try { return readFileSync(KF, 'utf8').trim(); } catch { return ''; } };
  const OUT = join(DIR, 'data', 'ave_board.json'), WANT = join(DIR, 'data', 'ave_want.json');
  let B = { at: 0, m: { bsc: {}, rh: {} }, cols: {} }; try { const o = JSON.parse(readFileSync(OUT, 'utf8')); if (o?.m) B = { ...B, ...o }; } catch {}
  const usedToday = () => { try { const u = JSON.parse(readFileSync(join(DIR, 'data', 'ave_usage.json'), 'utf8')); return u.d === today() ? u.cu : 0; } catch { return 0; } };
  let warned = '', busy = false, busy2 = false, fails = 0, lastList = 0; const ASKED = new Map(); /* 查过但 AVE 还没收录的币，10 分钟内不重查 */
  const save = () => { B.at = Date.now(); const tmp = OUT + '.w'; try { writeFileSync(tmp, JSON.stringify(B)); renameSync(tmp, OUT); } catch {} };
  async function call(path, cu, body) {
    const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { 'X-API-KEY': key(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    addAveUsage(DIR, cu); const j = await r.json().catch(() => null); if (!r.ok || !j || j.status !== 1) throw new Error(`AVE ${r.status} ${String(j?.msg || '').slice(0, 60)}`); return j.data;
  }
  function pack(t) {
    const [addr, chain] = String(t.token_id || '').split('-'); if (!/^0x[0-9a-fA-F]{40}$/.test(addr || '')) return null;
    const v = {
      n: String(t.name || '').slice(0, 40), s: String(t.symbol || '').slice(0, 20), h: num(t.holders), bt: num(t.buy_tax), st: num(t.sell_tax),
      rs: num(t.risk_score), rl: num(t.ave_risk_level), hp: t.is_honeypot === true || t.is_honeypot === '1' || t.is_honeypot === 1 ? 1 : 0, mint: t.is_mintable === '1' || t.has_mint_method === 1 || t.has_mint_method === '1' ? 1 : 0,
      lg: okUrl(t.logo_url), tx: num(t.tx_count_24h), v24: num(t.tx_volume_u_24h ?? t.token_tx_volume_usd_24h), mc: num(t.market_cap), tvl: num(t.main_pair_tvl ?? t.tvl),
      lp: num(t.launch_price), cp: num(t.current_price_usd), ca: num(t.created_at), pl: String(t.issue_platform || '').slice(0, 20),
      bv1: num(t.token_buy_tx_volume_usd_1h), sv1: num(t.token_sell_tx_volume_usd_1h), bv24: num(t.token_buy_tx_volume_usd_24h), sv24: num(t.token_sell_tx_volume_usd_24h), hi24: num(t.token_price_24h_high), lo24: num(t.token_price_24h_low), u: Date.now(),
    };
    for (const k of Object.keys(v)) if (v[k] === null || v[k] === '') delete v[k];
    return [chain === 'robinhood' ? 'rh' : chain, addr.toLowerCase(), v];
  }
  const put = (p) => { if (!p) return; const M = (B.m[p[0]] = B.m[p[0]] || {}); M[p[1]] = { ...(M[p[1]] || {}), ...p[2] }; };
  function prune() { const now = Date.now(); for (const M of Object.values(B.m)) for (const [a, v] of Object.entries(M)) if (now - (v.u || 0) > 3 * 3600e3) delete M[a]; }
  function slowCheck() { const cu = usedToday(); if (cu < DAY_SOFT) return false; if (warned !== today()) { warned = today(); log(`[AVE] 今天已用 ${cu} 单位，自动放慢`); tg?.(`📊 AVE 额度提醒：今天已用 ${cu} 单位（超过 ${DAY_SOFT}），雷达已自动放慢更新（清单改 15 分钟一次、新币不补查）。额度不够可以找 AVE 加。`).catch?.(() => {}); } return true; }
  async function listTick() {
    if (busy) return; const slow = slowCheck(); if (slow && Date.now() - lastList < 15 * 60e3) return; busy = true; lastList = Date.now();
    try { let n = 0;
      for (const [kind, q, cu] of LISTS) {
        try { const d = await call(kind === 'platform' ? '/v2/tokens/platform?' + q : '/v2/tokens/trending?' + q, cu);
          const arr = Array.isArray(d) ? d : d?.tokens || []; const k = kind === 'platform' ? q.match(/tag=([a-z_]+)/)[1] : 'trend_' + q.match(/chain=([a-z]+)/)[1];
          B.cols[k] = []; for (const t of arr) { const p = pack(t); if (!p) continue; put(p); B.cols[k].push(p[1]); n++; } } catch (e) { log('[AVE] ' + kind + ' ' + e.message); }
        await new Promise((r) => setTimeout(r, 400)); }
      if (n) { prune(); save(); fails = 0; } else if (++fails === 3) log('[AVE] 连续 3 轮读不到资料（金钥过期或额度用完？）');
    } finally { busy = false; }
  }
  async function wantTick() { /* 看盘上 AVE 清单没有的币（多半是刚开盘的新币），直接查 */
    if (busy2 || slowCheck()) return; busy2 = true;
    try { let W = {}; try { W = JSON.parse(readFileSync(WANT, 'utf8')); } catch { return; } if (Date.now() - (+W.at || 0) > 10 * 60e3) return;
      const ids = []; const now = Date.now();
      for (const [ch, list] of [['bsc', W.bsc], ['rh', W.rh]]) for (const a of Array.isArray(list) ? list : []) { const x = String(a).toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(x)) continue; const have = B.m[ch]?.[x]; if (have && now - (have.u || 0) < 30 * 60e3) continue; if (now - (ASKED.get(x) || 0) < 30 * 60e3) continue; ids.push(x + '-' + (ch === 'rh' ? 'robinhood' : 'bsc')); }
      let n = 0; for (let i = 0; i < Math.min(ids.length, 100); i += 50) { try { const part = ids.slice(i, i + 50); for (const id of part) ASKED.set(id.split('-')[0], Date.now()); if (ASKED.size > 5000) ASKED.clear(); const d = await call('/v2/tokens/search', 100, { token_ids: part }); for (const t of Array.isArray(d) ? d : d?.tokens || []) { put(pack(t)); n++; } } catch (e) { log('[AVE] 补查 ' + e.message); break; } }
      if (n) save();
    } finally { busy2 = false; }
  }
  setTimeout(listTick, 15e3); setInterval(listTick, 5 * 60e3).unref(); setInterval(wantTick, 2 * 60e3).unref();
  log('[AVE] 资料同步启动（清单每 5 分钟、新币补查每 2 分钟）');
  return { listTick, wantTick };
}
