// 罗宾猫雷达 · 桌面程式主程序
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, shell, clipboard, dialog } = require('electron');
let QR = null; try { QR = require('qrcode'); } catch {}
const qrCache = { url: '', img: '' };
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');               // 打狗工具资料夹（GangPaper）
const DATA = path.join(ROOT, 'data');
const SET = path.join(DATA, 'radar_settings.json');
const ICON = path.join(__dirname, 'ui', 'logo.png');
let win = null, tray = null, quitting = false;

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }

// 从打狗工具的状态档整理出看盘 / 持仓 / 状态
let cache = { at: 0, v: null };
function snapshot() {
  if (Date.now() - cache.at < 3000 && cache.v) return cache.v;
  const S = readJSON(path.join(DATA, 'watch_state.json'), {});
  const now = Date.now(), px = S.lastBnbUsd || 0;
  const TH = { go: Math.round(((S.thrNow?.go) || 0.6) * 100), ag: Math.round((S.thrNow?.ag) || 100) }; /* 11/3：用引擎实际门槛（以前画面写死 60%/100，引擎可能是 68%/110） */
  const board = Object.entries(S.paid || {}).filter(([c, P]) => now - (P.at || 0) < 172800e3).map(([c, P]) => {
    const prog = Math.round((P.progress || 0) * 100), ag = P.agents || 0, grp = Object.keys(S.grpHits?.[c]?.chats || {}).length;
    const done = Object.values(P.done || {}).some((x) => x === 'minted' || x === 'free');
    const why = String(P.lastReason || '');
    let verdict = 'watch', note = `进度要 ${TH.go}%、AI 钱包要 ${TH.ag} 个`;
    if (done) { verdict = 'done'; note = '已打'; }
    else if (/不打|騙|贔|貔貅|大量部署|黑名單|不是 Agent/.test(why)) { verdict = 'no'; note = why.replace(/，?照規則不打|，先不打.*$/, ''); }
    else if (/已经铸完/.test(why) || prog >= 100) { verdict = 'no'; note = '已经铸完，打不了'; }
    else if (prog >= TH.go && ag >= TH.ag) { verdict = 'ok'; note = '符合条件'; }
    return { c, name: P.name || c.slice(0, 8), prog, ag, grp, verdict, note, at: P.at || 0, col: done ? 'done' : prog >= 30 ? 'hot' : 'new' };
  }).filter((x) => x.verdict !== 'no' || x.grp > 0 || x.ag > 20).sort((a, b) => (b.ag + b.prog * 3 + b.grp * 30) - (a.ag + a.prog * 3 + a.grp * 30)).filter((x, i) => i < 90 || x.verdict === 'done');
  const WL = readJSON(path.join(DATA, 'radar_wallets.json'), { list: [] }).list || [];
  const hold = (S.dyn || []).filter((t) => !t.closed).map((t) => {
    const wn = (WL.find((w) => String(w.addr).toLowerCase() === String(t.only).toLowerCase()) || {}).name; const keyMe = (wn && S.tokens?.[wn + ':' + t.sym]) ? wn + ':' + t.sym : Object.keys(S.tokens || {}).find((k) => k === t.sym || k.endsWith(':' + t.sym)); /* 先找这个钱包自己的纪录 */
    const st = S.tokens?.[keyMe] || {};
    const dead = st.stage === 9 || !!st.gaveUp; /* 她 11/2：卖了好几次都卖不掉（池子没钱）= 实际价值 0，收进零头区 */
    const cv = S.curveVal?.[t.addr + ':' + t.only]; return { sym: t.sym, addr: t.addr, cost: t.cost || 0, value: dead ? 0 : (st.last?.v ?? (cv != null ? cv : null)), dead, curveOk: cv != null, done: !!st.done, stage: st.stage || 0, wallet: t.only, src: t.src === 'manual' || t.src === 'gen' ? 'manual' : 'ai', auto: t.src === 'gen' ? 1 : 0, tpsl: t.tpsl || null, autoSell: t.autoSell !== false, sells: t.autoSell !== false && !t.hold && (!(t.src === 'manual' || t.src === 'force') || !!t.tpsl), force: t.src === 'force' ? 1 : 0 } /* 11/3：止盈止损／单笔自动卖 */ /* 11/2 22:12：一般新币自动买归「一般代币」，标「自动买」 */;
  }).filter((h) => !h.done).slice(-40).reverse();
  for (const [c, P] of Object.entries(S.rh?.pos || {})) { const ws = Object.values(P.w || {}).filter((w) => !w.closed); if (!ws.length) continue; hold.unshift({ sym: P.sym, addr: c, chain: 'rh', cost: ws.reduce((a, w) => a + (w.cost || 0), 0), value: ws.some((w) => w.val != null) ? ws.reduce((a, w) => a + (w.val || 0), 0) : null, stage: Math.min(...ws.map((w) => w.stage || 0)), src: P.mint ? 'ai' : 'manual', auto: !P.mint && !P.manual ? 1 : 0, tpsl: P.tpsl || null, autoSell: P.autoSell !== false, sells: P.autoSell !== false && (!P.manual || !!P.tpsl) }); } /* Robinhood 持仓 */
  for (const h of hold) { try { const a = String(h.addr || '').toLowerCase(); h.plat = h.chain === 'rh' ? (V4R?.plat(a) || '') : (MK?.plat?.(a) || V4B?.plat(a) || (/(7777|8888)$/.test(a) ? 'flap' : '')); } catch {} } /* 11/2：持仓标发射台 */
  const hb = readText(path.join(DATA, 'watch_heartbeat.txt'));
  const login = readJSON(path.join(DATA, 'radar_login.json'), null); if (login && Date.now() - (login.at || 0) > 600e3) login.stale = 1;
  if (login?.state === 'qr' && login.url && qrCache.url === login.url) login.img = qrCache.img;
  const rhMint = Object.entries(S.rh?.mint || {}).filter(([, M]) => M.recent != null || Object.keys(M.m || {}).length >= 10).map(([c, M]) => ({ c, name: M.name || '', sym: M.sym || '', nft: !!M.nft, total: Object.keys(M.m || {}).length, recent: M.recent ?? null, real: M.real ?? null, fresh: M.freshPct ?? null, price: M.priceUsd ?? null, cost: M.costUsd ?? null, ok: !!M.ok, why: M.why || '还没检查', done: !!(M.done && Object.keys(M.done).length), age: Math.round((Date.now() - (M.first || Date.now())) / 60e3) })).sort((a, b) => (b.real || 0) - (a.real || 0) || b.total - a.total).slice(0, 60);
  const smart = { related: Object.entries(S.smartW?.related || {}).map(([a, r]) => ({ a, of: r.of, ch: r.ch })), events: (S.smartW?.events || []).slice(-30).reverse() };
  const bscNft = Object.entries(S.bscNft?.m || {}).filter(([, M]) => Object.keys(M.m || {}).length >= 10).map(([c, M]) => ({ c, name: M.name || '', sym: M.sym || '', nft: true, total: Object.keys(M.m || {}).length, recent: M.recent ?? null, real: M.real ?? null, fresh: M.freshPct ?? null, cost: M.costUsd ?? null, ok: !!M.ok, why: M.why || '还没检查', done: !!(M.done && Object.keys(M.done).length), age: Math.round((Date.now() - (M.first || Date.now())) / 60e3) })).sort((a, b) => (b.real || 0) - (a.real || 0) || b.total - a.total).slice(0, 60);
  recHist(board, rhMint, bscNft);
  const lookup = readJSON(path.join(DATA, 'radar_lookup.json'), null); const bal = readJSON(path.join(DATA, 'radar_bal.json'), null); const anal = readJSON(path.join(DATA, 'radar_analyze.json'), null), mhist = readJSON(path.join(DATA, 'radar_minthist.json'), null); const panels = (() => { try { const d = path.join(DATA, 'panels'); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).slice(0, 30).map((f) => readJSON(path.join(d, f), null)).filter(Boolean) : []; } catch { return []; } })();
  const myW = (readJSON(path.join(DATA, 'radar_wallets.json'), { list: [] }).list || [])[0]?.addr || ''; const v = { agc: S.agc || {}, share: readJSON(path.join(DATA, 'share_info.json'), {}), shareLast: readJSON(path.join(DATA, 'share_last.json'), null), forceLast: readJSON(path.join(DATA, 'force_last.json'), null), ver: String(readJSON(path.join(ROOT, 'version.json'), {}).version || ''), mineCand: S.mineCand || null, buyBlock: readJSON(path.join(DATA, 'buy_block.json'), null), health: readJSON(path.join(DATA, 'health.json'), null), remote: RMT, updRes: readJSON(path.join(DATA, 'update_result.json'), null), conflict: readJSON(path.join(DATA, 'conflict.json'), null), upd: readJSON(path.join(DATA, 'update_avail.json'), null), xw: { acc: (XW.acc || []).map((x) => ({ h: String(x.h || '').slice(0, 15), n: +x.n || 0 })) }, bind: (() => { const B = readJSON(path.join(DATA, 'bind.json'), {}); const o = {}; for (const k of ['join', 'code']) if (B[k]?.sig) o[k] = { code: B[k].code, wallet: B[k].wallet, sig: B[k].sig, v: B[k].v }; if (B.err) o.err = String(B.err).slice(0, 150); return o; })(), inv: { ...(() => { try { return invView(readJSON(SET, {}), readJSON(path.join(DATA, 'bind.json'), {}), (readJSON(path.join(DATA, 'radar_wallets.json'), { list: [] }).list || []).map((x) => String(x.addr || '').toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a))); } catch { return { at: INV.at, v4: INV.v4 ? 1 : 0, valid: [], codes: {}, w: {}, groups: INV.groups }; } })(), personal: fs.existsSync(path.join(ROOT, '.sign')), me: String(myW).toLowerCase(), code: /^0x[0-9a-fA-F]{40}$/.test(myW) ? myW.slice(2, 10).toLowerCase() : '' }, xheat: XH.items, board, hold, hb, bnbUsd: px, rhMint, bscNft, smart, lookup, bal, panels, anal, mhist, official: officialCheck(), set: readJSON(SET, {}), paused: fs.existsSync(path.join(DATA, 'pause_buy.txt')), wallets: readJSON(path.join(DATA, 'radar_wallets.json'), { list: [] }).list || [], login };
  cache = { at: Date.now(), v }; return v;
}

ipcMain.handle('snapshot', async () => { const v = snapshot(); const L = v.login; if (L?.state === 'qr' && L.url && /^https:\/\/app\.binance\.com\//.test(L.url) && qrCache.url !== L.url && QR) { qrCache.url = L.url; qrCache.img = await QR.toDataURL(L.url, { margin: 1, width: 220 }).catch(() => ''); L.img = qrCache.img; } return v; });
ipcMain.handle('login', (e, i) => { try { fs.unlinkSync(path.join(DATA, 'radar_login.json')); } catch {} fs.writeFileSync(path.join(DATA, 'radar_login_req.json'), JSON.stringify({ i: Number(i) || 0, at: Date.now() })); cache.at = 0; return true; });
ipcMain.handle('copyGuide', (e, extra) => { try { const g = fs.readFileSync(path.join(ROOT, 'AI说明书.md'), 'utf8'); const q = String(extra || '').trim().slice(0, 500); clipboard.writeText(q ? g + '\n\n---\n\n【我的需求】' + q + '\n（请照上面的说明书做：先用白话告诉我会改什么、有什么影响和风险，我说好你再做。如果你不能直接改我电脑里的档案，请照说明书第「零」节，回我一段 ###RADAR 开头的文字，我贴回雷达安装。罗宾猫雷达资料夹在：' + ROOT + '）' : g + '\n\n---\n\n（罗宾猫雷达资料夹在：' + ROOT + '。请先读完说明书，再问我想加什么功能。如果你不能直接改我电脑里的档案，就照说明书第「零」节回我 ###RADAR 格式。）'); return true; } catch { return false; } });
// 链上新池（BSC / Robinhood Chain）：GeckoTerminal 免费接口，2 分钟缓存，被限流就沿用旧资料
const POOLS = {};
async function pools(net) {
  if (!['bsc', 'robinhood'].includes(net)) return { list: [] };
  const c = POOLS[net]; if (c && Date.now() - c.at < 120e3) return c.v;
  const out = new Map(); let err = '';
  for (const k of ['trending_pools', 'new_pools']) {
    try { const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/${k}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) }); const j = await r.json(); if (!j.data) { err = '资料源忙，稍后自动更新'; continue; }
      for (const p of j.data) { const a = p.attributes || {}; const tok = String(p.relationships?.base_token?.data?.id || '').split('_').pop(); if (!/^0x[0-9a-fA-F]{40}$/.test(tok)) continue;
        const liq = +a.reserve_in_usd || 0; if (liq < 3000) continue; if (out.has(tok.toLowerCase())) continue;
        out.set(tok.toLowerCase(), { c: tok.toLowerCase(), sym: String(a.name || '').split(' / ')[0].slice(0, 20), pool: a.address, liq, mc: +(a.market_cap_usd || a.fdv_usd) || 0, age: a.pool_created_at ? Math.round((Date.now() - Date.parse(a.pool_created_at)) / 60e3) : null, h1: +(a.price_change_percentage?.h1) || 0, vol: +(a.volume_usd?.h24) || 0, buys: a.transactions?.h1?.buys || 0, sells: a.transactions?.h1?.sells || 0, nativeUsd: +a.quote_token_price_usd || 0, trend: k === 'trending_pools' }); }
    } catch (e) { err = '资料源连不上'; }
  }
  if (out.size < 5) { /* GeckoTerminal 被限流时，改用 DexScreener 补资料 */
    try { const seen = new Set(); for (const u of ['token-profiles/latest/v1', 'token-boosts/latest/v1', 'token-boosts/top/v1']) { const j = await (await fetch('https://api.dexscreener.com/' + u, { signal: AbortSignal.timeout(12000) })).json(); for (const x of j || []) if (x.chainId === net && /^0x[0-9a-fA-F]{40}$/.test(x.tokenAddress)) seen.add(x.tokenAddress.toLowerCase()); }
      const qs = await (await fetch(`https://api.dexscreener.com/latest/dex/search?q=${net === 'bsc' ? 'WBNB' : 'robinhood'}`, { signal: AbortSignal.timeout(12000) })).json().catch(() => ({}));
      for (const p of qs.pairs || []) if (p.chainId === net) seen.add(String(p.baseToken?.address || '').toLowerCase());
      const ids = [...seen].filter((a) => /^0x[0-9a-f]{40}$/.test(a) && !out.has(a)).slice(0, 30);
      if (ids.length) { const ps = await (await fetch(`https://api.dexscreener.com/tokens/v1/${net}/${ids.join(',')}`, { signal: AbortSignal.timeout(12000) })).json();
        for (const p of ps || []) { const tok = String(p.baseToken?.address || '').toLowerCase(); const liq = +(p.liquidity?.usd) || 0; if (!tok || out.has(tok) || liq < 3000) continue;
          out.set(tok, { c: tok, sym: String(p.baseToken?.symbol || '').slice(0, 20), pool: p.pairAddress, liq, mc: +(p.marketCap || p.fdv) || 0, age: p.pairCreatedAt ? Math.round((Date.now() - p.pairCreatedAt) / 60e3) : null, h1: +(p.priceChange?.h1) || 0, vol: +(p.volume?.h24) || 0, buys: p.txns?.h1?.buys || 0, sells: p.txns?.h1?.sells || 0, nativeUsd: 0, trend: (p.boosts?.active || 0) > 0 }); } }
      if (out.size) err = '';
    } catch (e) {}
  }
  const list = [...out.values()].sort((a, b) => (b.trend - a.trend) || (b.vol - a.vol)).slice(0, 60);
  const v = { list: list.length ? list : (c?.v.list || []), err: list.length ? '' : err, at: Date.now() };
  POOLS[net] = { at: list.length ? Date.now() : Date.now() - 90e3, v }; return v;
}
ipcMain.handle('pools', (e, net) => pools(net));
/* 11/2 她：热门代币要像 TMTN 一样三栏（新创建／即将发射／已迁移），可切时间、排序、筛选，官方 X 能点。
   资料：GeckoTerminal（Four.meme 曲线盘＋PancakeSwap 新池）、Four.meme 官方合约读进度、DexScreener 读官方 X／网站。都是公开免费接口，1 分钟缓存 */
const HB = {}, SOC = new Map();
/* 11/2 她：代币板要像 TMTN 一样列出全部 → BNB Chain 改成雷达自己读链（radar/market.cjs），第三方资料只用来补官方 X、头像、上池后的价格 */
let MK = null; try { MK = require('./market.cjs').startMarket({ DATA, log: () => {} }); } catch (e) { console.error('market', e); }
/* 她 11/2：Genius（BNB Chain）、Pons／Long（Robinhood）都是挂在 V4 交易池上的发射台 → radar/v4.cjs 自己读链 */
let V4B = null, V4R = null; try { const { startV4 } = require('./v4.cjs'); V4B = startV4('bsc', { DATA }); V4R = startV4('rh', { DATA }); } catch (e) { console.error('v4', e); }
const GTB = 'https://api.geckoterminal.com/api/v2/networks/';
async function gtj(u) { const r = await fetch(GTB + u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) }); if (r.status === 429) throw new Error('资料源忙'); return r.json(); }
function hbRow(p) { const a = p.attributes || {}; const tok = String(p.relationships?.base_token?.data?.id || '').split('_').pop().toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(tok)) return null; const nm = String(a.name || ''); const f = (o) => ({ m5: +(o?.m5) || 0, m15: +(o?.m15) || 0, h1: +(o?.h1) || 0, h6: +(o?.h6) || 0, h24: +(o?.h24) || 0 });
  const T = a.transactions || {}; const tx = {}; for (const k of ['m5', 'm15', 'h1', 'h6', 'h24']) tx[k] = { b: T[k]?.buys || 0, s: T[k]?.sells || 0, u: (T[k]?.buyers || 0) + (T[k]?.sellers || 0) };
  return { c: tok, pool: String(a.address || '').toLowerCase(), sym: nm.split(' / ')[0].slice(0, 24), q: (nm.split(' / ')[1] || '').slice(0, 8), dex: p.relationships?.dex?.data?.id || '', liq: +a.reserve_in_usd || 0, mc: +(a.market_cap_usd || a.fdv_usd) || 0, at: Date.parse(a.pool_created_at || '') || 0, chg: f(a.price_change_percentage), vol: f(a.volume_usd), tx }; }
async function bscBatch(calls) { if (!calls.length) return []; if (calls.length > 20) { const o = []; for (let i = 0; i < calls.length; i += 20) o.push(...(await bscBatch(calls.slice(i, i + 20))).concat(Array(Math.max(0, Math.min(20, calls.length - i) - 0)).fill('')).slice(0, Math.min(20, calls.length - i))); return o; } for (const u of ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed1.defibit.io']) { try { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls.map((d, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [d, 'latest'] }))), signal: AbortSignal.timeout(12000) }); const j = await r.json(); if (Array.isArray(j)) { const o = []; for (const x of j) o[x.id] = x.result || ''; return o; } } catch {} } return []; }
async function fourProg(list) { /* Four.meme 官方 TokenManagerHelper3.getTokenInfo：funds／maxFunds＝进度，liquidityAdded＝已迁移 */
  const res = await bscBatch(list.map((x) => ({ to: '0xF251F83e40a78868FcfA3FA4599Dad6494E46034', data: '0x1f69565f' + x.c.slice(2).padStart(64, '0') })));
  list.forEach((x, i) => { const r = res[i] || ''; if (r.length < 2 + 64 * 12) return; const w = (k) => BigInt('0x' + r.slice(2 + 64 * k, 2 + 64 * (k + 1))); const mf = w(10); if (mf > 0n) x.prog = Math.min(100, Number((w(9) * 10000n) / mf) / 100); x.grad = w(11) > 0n; }); }
/* 11/3 安全审查：项目方可以在 DexScreener 填任何网址（含 ' " \ 这类符号），以前只看开头是不是 https 就交给画面 → 可能被塞程式码。改成用标准网址解析，再挡掉怪符号 */
function safeUrl(u) { try { const x = new URL(String(u || '').trim()); if (x.protocol !== 'https:' || x.username || x.password) return ''; const h = x.href; return h.length <= 300 && !/['"\\<>`\s]/.test(h) ? h : ''; } catch { return ''; } }
async function socials(net, list) { const need = list.filter((x) => { const c = SOC.get(net + x.c); return !c || Date.now() - c.at > 15 * 60e3; }).map((x) => x.c);
  for (let i = 0; i < need.length && i < 90; i += 30) { try { const ps = await (await fetch(`https://api.dexscreener.com/tokens/v1/${net}/${need.slice(i, i + 30).join(',')}`, { signal: AbortSignal.timeout(12000) })).json();
      const got = new Set(); for (const p of (Array.isArray(ps) ? ps : []).sort((a, b) => (+b.liquidity?.usd || 0) - (+a.liquidity?.usd || 0))) { const t = String(p.baseToken?.address || '').toLowerCase(); if (!t || got.has(t)) continue; if (!p.info) { got.add(t); SOC.set(net + t, { at: Date.now(), ds: { mc: +(p.marketCap || p.fdv) || 0, liq: +p.liquidity?.usd || 0, pair: String(p.pairAddress || '').toLowerCase(), chg: p.priceChange || {}, vol: p.volume || {}, txns: p.txns || {} } }); continue; } const S = p.info?.socials || []; const tw = S.find((s) => /twitter|x\.com/i.test(s.type + ' ' + s.url)); const tg = S.find((s) => /telegram|t\.me/i.test(s.type + ' ' + s.url));
        if (!p.info) continue; got.add(t); SOC.set(net + t, { at: Date.now(), x: tw?.url || '', tg: tg?.url || '', web: (p.info.websites || [])[0]?.url || '', img: p.info.imageUrl || '', ds: { mc: +(p.marketCap || p.fdv) || 0, liq: +p.liquidity?.usd || 0, pair: String(p.pairAddress || '').toLowerCase(), chg: p.priceChange || {}, vol: p.volume || {}, txns: p.txns || {} } }); }
      for (const t of need.slice(i, i + 30)) if (!got.has(t)) SOC.set(net + t, { at: Date.now() }); } catch {} }
  for (const x of list) { const s = SOC.get(net + x.c); if (s) { x.x = /^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}(\/|\?|$)/i.test(safeUrl(s.x)) ? safeUrl(s.x) : ''; x.tg = /^https:\/\/t\.me\//.test(safeUrl(s.tg)) ? safeUrl(s.tg) : ''; x.web = safeUrl(s.web); x.img = safeUrl(s.img); if (s.ds && x.grad) { const d = s.ds; if (d.mc) x.mc = d.mc; if (d.liq) x.liq = d.liq; if (d.pair) x.pool = d.pair; const tv = (k) => ({ b: d.txns?.[k]?.buys || 0, s: d.txns?.[k]?.sells || 0, u: 0 }); x.vol = { m5: +d.vol?.m5 || 0, m15: +d.vol?.m5 || 0, h1: +d.vol?.h1 || 0, h6: +d.vol?.h6 || 0, h24: +d.vol?.h24 || 0 }; x.chg = { m5: +d.chg?.m5 || 0, m15: +d.chg?.m5 || 0, h1: +d.chg?.h1 || 0, h6: +d.chg?.h6 || 0, h24: +d.chg?.h24 || 0 }; x.tx = { m5: tv('m5'), m15: tv('m5'), h1: tv('h1'), h6: tv('h6'), h24: tv('h24') }; } else if (s.ds && !x.mc && s.ds.mc) x.mc = s.ds.mc; } } }
function applySoc(net, list) { for (const x of list) { const s = SOC.get(net + x.c); if (s) { x.x = /^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}(\/|\?|$)/i.test(safeUrl(s.x)) ? safeUrl(s.x) : ''; x.tg = /^https:\/\/t\.me\//.test(safeUrl(s.tg)) ? safeUrl(s.tg) : ''; x.web = safeUrl(s.web); x.img = safeUrl(s.img); if (s.ds && x.grad) { const d = s.ds; if (d.mc) x.mc = d.mc; if (d.liq) x.liq = d.liq; if (d.pair) x.pool = d.pair; const tv = (k) => ({ b: d.txns?.[k]?.buys || 0, s: d.txns?.[k]?.sells || 0, u: 0 }); x.vol = { m5: +d.vol?.m5 || 0, m15: +d.vol?.m5 || 0, h1: +d.vol?.h1 || 0, h6: +d.vol?.h6 || 0, h24: +d.vol?.h24 || 0 }; x.chg = { m5: +d.chg?.m5 || 0, m15: +d.chg?.m5 || 0, h1: +d.chg?.h1 || 0, h6: +d.chg?.h6 || 0, h24: +d.chg?.h24 || 0 }; x.tx = { m5: tv('m5'), m15: tv('m5'), h1: tv('h1'), h6: tv('h6'), h24: tv('h24') }; } else if (s.ds && !x.mc && s.ds.mc) x.mc = s.ds.mc; } } }
const SOCB = {}; function socialsBg(net, list) { applySoc(net, list); if (SOCB[net]) return; SOCB[net] = 1; socials(net, list.map((x) => ({ c: x.c, grad: x.grad }))).catch(() => {}).finally(() => { SOCB[net] = 0; }); } /* 她 11/2 22:46：币种数据更新慢 → 以前每 3 秒都要等社群／行情网站回来才回传看板；改成先回传、背景补 */
setInterval(() => { for (const n of ['bsc', 'robinhood']) if (Date.now() - (hotBoard['_t' + n] || 0) > 90e3) hotBoard(n).catch(() => {}); }, 60e3); /* 11/2 21:55：没开看板页也每分钟更新一次候选，交给引擎的自动买 */
async function hotBoard(net) { net = net === 'robinhood' ? 'robinhood' : 'bsc'; hotBoard['_t' + net] = Date.now();
  if (net === 'bsc' && MK) { const v = MK.board(); if (V4B) { try { const g = V4B.board(); v.cols.forEach((c, i) => { c.items = c.items.concat(g.cols[i]?.items || []); }); v.total = (v.total || 0) + (g.total || 0); } catch {} } const vis = v.cols.flatMap((c) => c.items.slice(0, 60)); socialsBg('bsc', vis);
    try { if (!hotBoard._bc || Date.now() - hotBoard._bc > 60e3) { hotBoard._bc = Date.now(); const L = v.cols.flatMap((c) => c.items).filter((x) => Date.now() - (x.at || 0) < 24 * 3600e3 && (x.tx?.h1?.b || 0) >= 3).sort((a, b) => (b.tx.h1.b + b.tx.h1.s) - (a.tx.h1.b + a.tx.h1.s)).slice(0, 40).map((x) => ({ c: x.c, sym: x.sym, liq: x.liq || 0, mc: x.mc || 0, at: x.at, plat: x.plat, b: x.tx.h1.b, s: x.tx.h1.s, x: x.x || '', tg: x.tg || '', curve: !x.grad })); fs.writeFileSync(path.join(DATA, 'bsc_cand.json'), JSON.stringify({ at: Date.now(), list: L })); } } catch {} /* 11/2 21:55：BNB Chain 一般新币候选 → 引擎「一般新币自动买」（预设关） */
    return v; }
  if (net === 'robinhood' && V4R) { const v = V4R.board(); if (v.total) { socialsBg('robinhood', v.cols.flatMap((c) => c.items.slice(0, 60)));
      /* 她 11/2：每个币标「会打／不打：原因」→ 用引擎真的检查过的结果；看板上的新币也交给引擎检查（以前引擎只看 GeckoTerminal 前 40 个池，会漏） */
      try { const seen = readJSON(path.join(DATA, 'watch_state.json'), {}).rh?.seen || {}; for (const c of v.cols) for (const x of c.items) { const e = seen[x.c]; if (e) x.ev = { ok: !!e.ok, why: String(e.why || '').slice(0, 80), at: e.at || 0 }; } } catch {}
      try { if (!hotBoard._rc || Date.now() - hotBoard._rc > 60e3) { hotBoard._rc = Date.now(); const L = v.cols.flatMap((c) => c.items).filter((x) => Date.now() - (x.at || 0) < 6 * 3600e3 && (x.tx?.h1?.b || 0) >= 3 && (x.liq || 0) > 0).sort((a, b) => (b.tx.h1.b + b.tx.h1.s) - (a.tx.h1.b + a.tx.h1.s)).slice(0, 30).map((x) => ({ c: x.c, sym: x.sym, liq: x.liq || 0, at: x.at, plat: x.plat, b: x.tx.h1.b, s: x.tx.h1.s })); fs.writeFileSync(path.join(DATA, 'rh_cand.json'), JSON.stringify({ at: Date.now(), list: L })); } } catch {}
      return v; } } /* 读链还没资料（刚开）才退回 GeckoTerminal */
  const c = HB[net]; if (c && Date.now() - c.at < 90e3) return c.v; if (HB.busy) return c?.v || { cols: [], err: '读取中…' }; HB.busy = 1; try { let err = '';
  /* 11/2：GeckoTerminal 免费版很容易被限流 → 一个一个查、中间停一下，被挡就等 2.5 秒再试一次 */
  const get = async (u) => { for (let i = 0; i < 2; i++) { try { if (i) await new Promise((r) => setTimeout(r, 2500)); const j = await gtj(u); await new Promise((r) => setTimeout(r, 700)); return (j.data || []).map(hbRow).filter(Boolean); } catch (e) { err = '资料源忙（被限流），稍后自动更新'; } } return []; };
  let v;
  if (net === 'bsc') {
    const n1 = await get('bsc/new_pools?page=1'), f1 = await get('bsc/dexes/four-meme/pools?sort=h24_volume_usd_desc&page=1'), f2 = await get('bsc/dexes/four-meme/pools?sort=h24_tx_count_desc&page=1'), tr = await get('bsc/trending_pools?page=1'); const n2 = [];
    const curve = new Map(); for (const x of [...n1, ...n2, ...f1, ...f2]) if (x.dex === 'four-meme' && !curve.has(x.c)) curve.set(x.c, x);
    const cl = [...curve.values()].slice(0, 90); await fourProg(cl);
    const fresh = cl.filter((x) => !x.grad && (x.prog ?? 0) < 30), soon = cl.filter((x) => !x.grad && (x.prog ?? 0) >= 30);
    const mig = new Map(); for (const x of [...n1, ...n2, ...tr]) { if (x.dex === 'four-meme' || mig.has(x.c)) continue; if (/(4444|7777|8888)$/.test(x.c) || cl.some((y) => y.c === x.c && y.grad)) mig.set(x.c, x); }
    v = { cols: [{ k: 'fresh', zh: '🆕 新创建', en: '🆕 New', items: fresh }, { k: 'soon', zh: '🚀 即将发射', en: '🚀 About to launch', items: soon }, { k: 'done', zh: '✅ 已迁移', en: '✅ Migrated', items: [...mig.values()] }], note: 'Four.meme' };
  } else {
    const n1 = await get('robinhood/new_pools?page=1'), tr = await get('robinhood/trending_pools?page=1'); const n2 = [];
    const seen = new Set(), fresh = [], old = []; for (const x of [...n1, ...n2]) { if (seen.has(x.c)) continue; seen.add(x.c); (Date.now() - x.at < 6 * 3600e3 ? fresh : old).push(x); }
    const hot = tr.filter((x) => !seen.has(x.c) || true);
    v = { cols: [{ k: 'fresh', zh: '🆕 新池（6 小时内）', en: '🆕 New pools (6h)', items: fresh }, { k: 'soon', zh: '🔥 热门', en: '🔥 Trending', items: hot }, { k: 'done', zh: '📈 较早的新池', en: '📈 Older new pools', items: old }] };
  }
  const all = v.cols.flatMap((c) => c.items); await socials(net, all.slice(0, 150));
  v.at = Date.now(); v.err = all.length ? '' : err; if (all.length) { HB[net] = { at: Date.now(), v }; return v; } if (c) { c.at = Date.now() - 30e3; return { ...c.v, err: err + '（先显示上一次的资料）' }; } HB[net] = { at: Date.now() - 30e3, v }; return v; } finally { HB.busy = 0; } }
/* 11/2：画面不能直接载外部图片（安全设定），头像／币的图示由这里代抓，只准 TG／DexScreener／GeckoTerminal 的图，最大 300KB，存在记忆体 */
const IMGC = new Map();
ipcMain.handle('imgData', async (e, u) => { u = String(u || ''); let h = ''; try { const x = new URL(u); if (x.protocol !== 'https:') return ''; h = x.hostname; } catch { return ''; } if (!/(^|\.)(telesco\.pe|dexscreener\.com|geckoterminal\.com|coingecko\.com)$/.test(h)) return '';
  const c = IMGC.get(u); if (c && Date.now() - c.at < 6 * 3600e3) return c.v; try { const r = await fetch(u, { signal: AbortSignal.timeout(10000) }); const ct = String(r.headers.get('content-type') || ''); if (!r.ok || !/^image\/(png|jpe?g|webp|gif)/.test(ct)) return ''; const b = Buffer.from(await r.arrayBuffer()); if (b.length > 300e3) return '';
    const v = 'data:' + ct.split(';')[0] + ';base64,' + b.toString('base64'); IMGC.set(u, { at: Date.now(), v }); if (IMGC.size > 400) IMGC.delete(IMGC.keys().next().value); return v; } catch { return ''; } });
/* 她 11/2：📣 信号页 — 喊单流＋车头榜。引擎记下每次频道／X 帐号喊单（S.callLog），这里补上币名、喊单时市值、现在市值、喊单后最高市值 */
const SIGP = path.join(DATA, 'sig_px.json'); let SIGB = false;
async function sigFill(L, P) { /* 1) 行情网站没有的 → 看板（Flap／Four／Genius 曲线、V4 新池）  2) 还没名字的 → 读合约 symbol() */
  const bd = new Map(); try { for (const B of [MK?.board?.(), V4B?.board?.()]) for (const c of B?.cols || []) for (const x of c.items || []) bd.set(String(x.c).toLowerCase(), x); } catch {}
  for (const x of L) { const o = P[x.c]; if (!o) continue; const b = bd.get(x.c); if (b && !(o.mc > 0) && b.mc > 0) { o.mc = b.mc; o.max = Math.max(o.max || 0, b.mc); if (!o.sym && b.sym) o.sym = String(b.sym).slice(0, 20); if (!o.img && /^https:\/\//.test(b.img || '')) o.img = b.img; } }
  const need = [...new Set(L.map((x) => x.c))].filter((c) => P[c] && !P[c].sym && P[c].oc == null).slice(0, 40); if (!need.length) return;
  const res = await bscBatch(need.map((c) => ({ to: c, data: '0x95d89b41' })));
  need.forEach((c, i) => { const r = String(res[i] || ''); let s = ''; try { if (r.length >= 130) { const n = parseInt(r.slice(66, 130), 16); s = Buffer.from(r.slice(130, 130 + n * 2), 'hex').toString('utf8'); } else if (r.length === 66) s = Buffer.from(r.slice(2), 'hex').toString('utf8').replace(/\0+$/, ''); } catch {} s = s.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20); P[c].oc = s; });
}
async function signals() { const S = readJSON(path.join(DATA, 'watch_state.json'), {}); const P = readJSON(SIGP, {});
  /* 她 11/2 22:45：信号页改版 → 三种来源合在一起（TG 频道、X、聪明钱／KOL 实买），同一个币合并成一行；1 小时内 2 个以上不同来源＝🔥共振 */
  const L = [...(S.callLog || []).slice(-300).map((x) => ({ c: x.c, src: x.src, at: x.at, ch: 'bsc', ty: /^𝕏/.test(x.src) ? 'x' : 'tg' })),
    ...(S.smartW?.events || []).filter((e) => e.dir === '买' && /^0x[0-9a-f]{40}$/.test(e.tok || '')).map((e) => ({ c: e.tok, src: '🐋 ' + String(e.names || '').slice(0, 30), at: e.at, ch: e.ch === 'robinhood' ? 'rh' : 'bsc', ty: 'smart' }))].sort((a, b) => b.at - a.at);
  const key = (x) => (x.ch === 'rh' ? 'rh:' : '') + x.c;
  if (!SIGB) { SIGB = true; try { for (const ch of ['bsc', 'rh']) { const need = [...new Set(L.filter((x) => x.ch === ch).map((x) => x.c))].filter((c) => { const o = P[(ch === 'rh' ? 'rh:' : '') + c]; return !o || Date.now() - (o.t || 0) > 120e3; }).slice(0, 90);
      for (let i = 0; i < need.length; i += 30) { try { const ps = await (await fetch('https://api.dexscreener.com/tokens/v1/' + (ch === 'rh' ? 'robinhood' : 'bsc') + '/' + need.slice(i, i + 30).join(','), { signal: AbortSignal.timeout(12000) })).json(); const best = {}; for (const p of Array.isArray(ps) ? ps : []) { const a = String(p.baseToken?.address || '').toLowerCase(); const lq = +p.liquidity?.usd || 0; if (!best[a] || lq > best[a].lq) best[a] = { lq, mc: +(p.marketCap || p.fdv) || 0, sym: String(p.baseToken?.symbol || '').slice(0, 20), img: p.info?.imageUrl || '', at: +p.pairCreatedAt || 0 }; }
          for (const c of need.slice(i, i + 30)) { const k = (ch === 'rh' ? 'rh:' : '') + c; const o = P[k] || (P[k] = { f: {} }); o.t = Date.now(); const b = best[c]; if (b) { o.sym = b.sym; o.mc = b.mc; o.liq = b.lq; o.born = b.at || o.born || 0; o.img = /^https:\/\//.test(b.img) ? b.img : ''; o.max = Math.max(o.max || 0, b.mc); } } } catch {} } }
      try { await sigFill(L.filter((x) => x.ch === 'bsc'), P); } catch {}
      for (const x of L) { const o = P[key(x)]; if (!o || !o.mc) continue; o.f = o.f || {}; if (o.f[x.src] == null) o.f[x.src] = { mc: o.mc, late: Date.now() - (x.at || 0) > 10 * 60e3 }; }
      const ks = Object.keys(P); if (ks.length > 1500) for (const k of ks.slice(0, ks.length - 1500)) delete P[k]; fs.writeFileSync(SIGP, JSON.stringify(P)); } catch {} finally { SIGB = false; } }
  const nm = (k, c) => P[k]?.sym || P[k]?.oc || c.slice(0, 8);
  const G = new Map(); for (const x of L) { const k = key(x); const g = G.get(k) || { k, c: x.c, ch: x.ch, srcs: [], first: x.at, last: x.at }; if (!g.srcs.some((s) => s.src === x.src)) g.srcs.push({ src: x.src, at: x.at, ty: x.ty }); g.first = Math.min(g.first, x.at); g.last = Math.max(g.last, x.at); G.set(k, g); }
  const feed = [...G.values()].map((g) => { const o = P[g.k] || {}; const f0 = g.srcs.slice().sort((a, b) => a.at - b.at).map((s) => o.f?.[s.src]).find(Boolean); g.srcs.sort((a, b) => a.at - b.at);
    const reso = g.srcs.some((s, i) => g.srcs.filter((y) => Math.abs(y.at - s.at) < 3600e3).length >= 2) && new Set(g.srcs.map((s) => s.ty)).size >= 1 && g.srcs.length >= 2;
    return { c: g.c, ch: g.ch, sym: nm(g.k, g.c), kind: g.ch === 'bsc' && S.paid?.[g.c] && !o.mc ? 'mint' : 'token', img: o.img || '', srcs: g.srcs.slice(0, 8), n: g.srcs.length, first: g.first, last: g.last, at: g.last, src: g.srcs[0].src, mc0: f0?.mc || 0, late: !!f0?.late, mc: o.mc || 0, max: o.max || 0, liq: o.liq || 0, born: o.born || 0, reso }; })
    .sort((a, b) => (Date.now() - b.last < 6 * 3600e3 && b.reso) - (Date.now() - a.last < 6 * 3600e3 && a.reso) || b.last - a.last).slice(0, 120);
  const by = {}; for (const x of L) { if (x.ty === 'smart') continue; const o = P[key(x)]; const f = o?.f?.[x.src]; const b = by[x.src] || (by[x.src] = { src: x.src, n: 0, rated: 0, win: 0, best: 0, sum: 0, last: 0 }); b.n++; b.last = Math.max(b.last, x.at || 0); if (f?.mc > 0 && o.max > 0 && !f.late) { const m = o.max / f.mc; b.rated++; b.sum += m; if (m >= 2) b.win++; if (m > b.best) { b.best = m; b.bestSym = nm(key(x), x.c); } } }
  const rank = Object.values(by).map((b) => ({ ...b, avg: b.rated ? b.sum / b.rated : 0, rate: b.rated ? b.win / b.rated : 0 })).sort((a, b) => (b.rate - a.rate) || (b.best - a.best) || (b.n - a.n)).slice(0, 50);
  return { feed, rank, at: Date.now() }; }
/* 她 11/2：错过分析 — AI 专属项目满了雷达却没打的，照原因分组，告诉用户可以怎么调 */
ipcMain.handle('missed', () => { const S = readJSON(path.join(DATA, 'watch_state.json'), {}); const cut = Date.now() - 7 * 86400e3; const L = Object.entries(S.missed || {}).map(([c, m]) => ({ c, name: String(m.name || '').slice(0, 30), why: String(m.why || '').slice(0, 90), at: Date.parse(String(m.at || '').replace(/\//g, '-').replace(' ', 'T')) || 0 })).filter((x) => x.at >= cut).sort((a, b) => b.at - a.at);
  const key = (w) => /找到能打|不會打|学打法|學打法/.test(w) ? 'learn' : /簽名|签名|白名單|白名单|賣完|卖完|關閉|关闭/.test(w) ? 'closed' : /餘額|余额|不夠|不够|BNB/.test(w) ? 'money' : /額度|额度|上限/.test(w) ? 'cap' : /進度|进度|錢包|钱包|熱度|热度/.test(w) ? 'rule' : 'other';
  const G = {}; for (const x of L) { const k = key(x.why); (G[k] = G[k] || []).push(x); } return { total: L.length, groups: Object.entries(G).map(([k, a]) => ({ k, n: a.length, items: a.slice(0, 6) })).sort((a, b) => b.n - a.n) }; });
/* 她 11/2：回测 — 用雷达读链存下来的 48 小时成交，照用户填的条件模拟买卖 */
ipcMain.handle('backtest', (e, o = {}) => { try { const net = o.net === 'robinhood' ? 'robinhood' : 'bsc'; const srcs = net === 'bsc' ? [MK, V4B] : [V4R]; const B = Math.max(1, +o.buys || 10), M = Math.max(1, +o.min || 10), MN = +o.mcMin || 0, MX = +o.mcMax || 0, TP = Math.max(1.05, +o.tp || 2), SL = Math.min(95, Math.max(1, +o.sl || 50)) / 100, HOLD = Math.max(5, +o.hold || 240) * 60, AMT = +o.amt || 10, plat = o.plat || 'all';
  const res = []; for (const S of srcs) { if (!S?.raw) continue; const R = S.raw(); for (const x of Object.values(R.tokens)) { if (!x.tr?.length || (plat !== 'all' && x.plat !== plat)) continue; const u = R.usd(x); if (!(u > 0)) continue; const sup = x.sup || R.sup || 1e9; const t0 = x.at ? x.at / 1000 : x.tr[0][0];
      let nb = 0, entry = null; for (let i = 0; i < x.tr.length; i++) { const r = x.tr[i]; if (r[0] - t0 > M * 60) break; if (r[1]) nb++; if (nb >= B) { const mc = r[3] * u * sup; if ((!MN || mc >= MN) && (!MX || mc <= MX)) entry = { i, t: r[0], p: r[3], mc }; break; } }
      if (!entry) continue; let out = null, peak = entry.p; for (let i = entry.i + 1; i < x.tr.length; i++) { const r = x.tr[i]; if (r[0] - entry.t > HOLD) break; peak = Math.max(peak, r[3]); if (r[3] >= entry.p * TP) { out = { p: entry.p * TP, why: 'tp', t: r[0] }; break; } if (r[3] <= entry.p * (1 - SL)) { out = { p: r[3], why: 'sl', t: r[0] }; break; } }
      if (!out) { const last = x.tr.filter((r) => r[0] - entry.t <= HOLD).pop() || x.tr[entry.i]; out = { p: last[3], why: Date.now() / 1000 - entry.t < HOLD ? 'open' : 'time', t: last[0] }; }
      const m = out.p / entry.p; res.push({ c: x.c, sym: x.sym || x.c.slice(0, 8), plat: x.plat, t: entry.t * 1000, mc: Math.round(entry.mc), m: +m.toFixed(3), peak: +(peak / entry.p).toFixed(2), why: out.why, pnl: +(AMT * (m - 1)).toFixed(2) }); } }
  res.sort((a, b) => b.t - a.t); const done = res.filter((r) => r.why !== 'open'); const win = done.filter((r) => r.m > 1).length; const pnl = done.reduce((a, r) => a + r.pnl, 0);
  return { n: res.length, done: done.length, win, rate: done.length ? win / done.length : 0, pnl: +pnl.toFixed(2), spent: +(done.length * AMT).toFixed(2), list: res.slice(0, 200), best: done.slice().sort((a, b) => b.m - a.m).slice(0, 5), worst: done.slice().sort((a, b) => a.m - b.m).slice(0, 5) }; } catch (er) { return { err: String(er.message || er).slice(0, 100) }; } });
ipcMain.handle('signals', () => signals().catch((e) => ({ feed: [], rank: [], err: String(e.message || e).slice(0, 80) })));
ipcMain.handle('hotBoard', (e, net) => hotBoard(net).catch((er) => ({ cols: [], err: String(er.message || er).slice(0, 80) })));
/* K 线：1 分～月线。资料源没有的（3 小时、6 小时、3 天、周、月）用小的 K 线合并 */
const CDL = new Map();
ipcMain.handle('candles', async (e, net, pool, tf) => { net = net === 'robinhood' ? 'robinhood' : 'bsc'; pool = String(pool || '').toLowerCase(); if (!/^0x[0-9a-f]{40,64}$/.test(pool)) return [];
  { const sec = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '3h': 10800, '6h': 21600, '12h': 43200, '1d': 86400, '3d': 259200, '1w': 604800, '1M': 2592000 }[tf] || 300;
    if (net === 'bsc' && MK && MK.has(pool)) return MK.candles(pool, sec); if (net === 'bsc' && V4B && V4B.has(pool)) return V4B.candles(pool, sec); if (net === 'robinhood' && V4R && V4R.has(pool)) return V4R.candles(pool, sec); }
  const M = { '1m': ['minute', 1, 1], '5m': ['minute', 5, 1], '15m': ['minute', 15, 1], '1h': ['hour', 1, 1], '3h': ['hour', 1, 3], '6h': ['hour', 1, 6], '12h': ['hour', 12, 1], '1d': ['day', 1, 1], '3d': ['day', 1, 3], '1w': ['day', 1, 7], '1M': ['day', 1, 30] }[tf] || ['minute', 5, 1];
  const k = net + pool + tf, c = CDL.get(k); if (c && Date.now() - c.at < 60e3) return c.v;
  try { const j = await gtj(`${net}/pools/${pool}/ohlcv/${M[0]}?aggregate=${M[1]}&limit=${Math.min(1000, 160 * M[2])}`); let L = (j.data?.attributes?.ohlcv_list || []).map((r) => ({ t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })).reverse();
    if (M[2] > 1) { const g = []; for (let i = L.length % M[2]; i < L.length; i += M[2]) { const s = L.slice(i, i + M[2]); g.push({ t: s[0].t, o: s[0].o, h: Math.max(...s.map((x) => x.h)), l: Math.min(...s.map((x) => x.l)), c: s[s.length - 1].c, v: s.reduce((a, x) => a + x.v, 0) }); } L = g; }
    L = L.slice(-160); CDL.set(k, { at: Date.now(), v: L }); if (CDL.size > 300) CDL.delete(CDL.keys().next().value); return L; } catch { return c?.v || []; } });
ipcMain.handle('schema', () => { const a = readJSON(path.join(__dirname, 'settings_schema.json'), { items: [], groups: [] }); const m = readJSON(path.join(DATA, 'plugins_meta.json'), {}); return { groups: [...(a.groups || []), ...(m.groups || [])], items: [...(a.items || []), ...(m.items || [])] }; });
function readJournal() { const t = readText(path.join(DATA, 'journal.jsonl')); const out = []; for (const l of t.split('\n').slice(-20000)) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch {} } return out; }
ipcMain.handle('journal', () => readJournal().reverse());
ipcMain.handle('exportJournal', async (e, rows) => { const r = await dialog.showSaveDialog(win, { defaultPath: '罗宾猫雷达_交易日记.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] }); if (r.canceled || !r.filePath) return false;
  const q = (x) => { let v = String(x ?? ''); if (typeof x === 'string' && /^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; }; /* 11/3：币名是项目方取的，=开头的会被 Excel 当公式执行 */ const H = ['时间', '链', '来源', '买卖', '币', '合约', '钱包', '金额(U)', '拿到', '备注'];
  const list = Array.isArray(rows) ? rows : readJournal(); fs.writeFileSync(r.filePath, '\ufeff' + [H.map(q).join(','), ...list.map((x) => [new Date(x.at).toLocaleString('zh-CN', { hour12: false }), x.chain, x.src, x.side, x.sym, x.token, x.wallet, x.usd, x.got, x.note].map(q).join(','))].join('\r\n')); return true; });

// 铸造进度走势：雷达自己每分钟记一笔（进度、AI 钱包、真人钱包），给详情页画图；只存在本机 data/radar_hist.json
const HISTF = path.join(DATA, 'radar_hist.json'); let HIST = null, histAt = 0;
function recHist(board, rhMint, bscNft) { try { if (!HIST) HIST = readJSON(HISTF, {}); const now = Date.now(); if (now - histAt < 60e3) return; histAt = now;
  const add = (k, pt) => { const a = HIST[k] = HIST[k] || []; const l = a[a.length - 1]; if (l && JSON.stringify({ ...l, t: 0 }) === JSON.stringify({ ...pt, t: 0 }) && now - l.t < 30 * 60e3) return; a.push({ t: now, ...pt }); if (a.length > 600) a.splice(0, a.length - 600); };
  for (const x of board || []) add('bsc:' + x.c, { p: x.prog, a: x.ag, g: x.grp });
  for (const x of rhMint || []) add('rh:' + x.c, { n: x.total, r: x.real });
  for (const x of bscNft || []) add('nft:' + x.c, { n: x.total, r: x.real });
  const ks = Object.keys(HIST); if (ks.length > 800) ks.sort((a, b) => (HIST[a].at(-1)?.t || 0) - (HIST[b].at(-1)?.t || 0)).slice(0, ks.length - 800).forEach((k) => delete HIST[k]);
  const tmp = HISTF + '.w'; fs.writeFileSync(tmp, JSON.stringify(HIST)); fs.renameSync(tmp, HISTF); } catch {} }
/* 她 11/2 04:59：新闻跑马灯，资料来自我们网站 nightshift.fans 的新闻页（同一个来源），雷达里直接播，不跳网页 */
let NEWS = { at: 0, items: [] };
/* 她 11/2 05:20：频道到底读不读得到——群组、私人频道、没开预览的，t.me/s/ 会被转走，雷达读不到 */
const TGCHK = {};
ipcMain.handle('tgCheck', async (e, name) => { name = String(name || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40); if (!name) return { ok: false }; const c = TGCHK[name]; if (c && Date.now() - c.at < 10 * 60e3) return c; let r = { ok: false, at: Date.now() }; try { const res = await fetch('https://t.me/s/' + name, { signal: AbortSignal.timeout(12000) }); const html = await res.text(); r.ok = /\/s\//.test(res.url) && /tgme_widget_message_text/.test(html); r.net = true; } catch { r.net = false; } TGCHK[name] = r; return r; });
/* 她 11/2 08:50：X 热度资料要用的两把金钥，只有个人版（有 .sign 资料夹）能存；只回「有没有」，绝不把金钥传回画面 */
const XKF = path.join(ROOT, '.sign', 'xdata_keys.json');
ipcMain.handle('xKeysStatus', () => { if (!fs.existsSync(path.join(ROOT, '.sign'))) return null; const k = readJSON(XKF, {}); return { gh: !!k.gh, gx: !!k.gx }; });
ipcMain.handle('saveXKeys', (e, gh, gx) => { if (!fs.existsSync(path.join(ROOT, '.sign'))) return { err: 'no' }; const k = readJSON(XKF, {}); gh = String(gh || '').trim(); gx = String(gx || '').trim(); if (gh) { if (!/^github_pat_[A-Za-z0-9_]{20,}$/.test(gh)) return { err: 'gh' }; k.gh = gh; } if (gx) { if (!/^[A-Za-z0-9_\-.]{16,200}$/.test(gx)) return { err: 'gx' }; k.gx = gx; } fs.writeFileSync(XKF, JSON.stringify(k)); return { ok: true, gh: !!k.gh, gx: !!k.gx }; });
/* 11/2：X 热度资料。个人版直接读本机 data/xheat.json；其他用户每 2 分钟从 GitHub radar-data 读，核对官方签名才用 */
let XH = { at: 0, items: {} };
async function xheatLoad() { try { const loc = path.join(DATA, 'xheat.json'); if (fs.existsSync(path.join(ROOT, '.sign')) && fs.existsSync(loc)) { const X = readJSON(loc, {}); XH = { at: Date.now(), items: X.items || {} }; return; }
  const r = await fetch('https://api.github.com/repos/nancyc0813-maker/radar-data/contents/xheat.json', { headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'robincat-radar' }, signal: AbortSignal.timeout(15000) }); if (!r.ok) return; const j = await r.json();
  const crypto = require('crypto'); const pub = crypto.createPublicKey({ key: Buffer.from(OFFICIAL_PUB, 'base64'), format: 'der', type: 'spki' }); if (!j?.data || !j?.sig || !crypto.verify(null, Buffer.from(j.data), pub, Buffer.from(j.sig, 'base64'))) return; const D = JSON.parse(j.data); if (Date.now() - (D.at || 0) > 6 * 3600e3) return; XH = { at: Date.now(), items: D.items || {} }; } catch {} }
setInterval(xheatLoad, 120e3); setTimeout(xheatLoad, 5e3);
/* 她 11/2：远端设定（紧急停买、公告、新发射台、备用节点）— 官方签名过才用，验过才写 data/remote.json 给引擎 */
let RMT = null;
async function remoteLoad() { try { const crypto = require('crypto'); const pub = crypto.createPublicKey({ key: Buffer.from(OFFICIAL_PUB, 'base64'), format: 'der', type: 'spki' }); let j = null; const loc = path.join(DATA, 'remote_pub.json');
  if (fs.existsSync(path.join(ROOT, '.sign')) && fs.existsSync(loc)) j = readJSON(loc, null); else { const r = await fetch('https://api.github.com/repos/nancyc0813-maker/radar-data/contents/remote.json', { headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'robincat-radar' }, signal: AbortSignal.timeout(15000) }); if (r.ok) j = await r.json(); }
  if (!j?.data || !j?.sig || !crypto.verify(null, Buffer.from(j.data), pub, Buffer.from(j.sig, 'base64'))) return; const D = JSON.parse(j.data); if (RMT && (+D.at || 0) < (+RMT.at || 0)) return; /* 不接受比手上旧的（防重放） */
  RMT = { at: +D.at || 0, kill: { buy: D.kill?.buy !== false, msg: String(D.kill?.msg || '').slice(0, 200) }, notice: { text: String(D.notice?.text || '').slice(0, 300), level: D.notice?.level === 'warn' ? 'warn' : 'info', below: /^\d+\.\d+\.\d+$/.test(D.notice?.below || '') ? D.notice.below : '' }, kol: (Array.isArray(D.kol) ? D.kol : []).filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x?.addr || '')).slice(0, 100).map((x) => ({ addr: String(x.addr).toLowerCase(), name: String(x.name || '').slice(0, 30), x: /^[A-Za-z0-9_]{1,15}$/.test(x.x || '') ? x.x : '', note: String(x.note || '').slice(0, 60) })), air: (Array.isArray(D.air) ? D.air : []).filter((x) => x && /^https:\/\/[^\s"'<>]+$/.test(x.url || '')).slice(0, 50).map((x) => ({ id: String(x.id || '').slice(0, 20), name: String(x.name || '').slice(0, 60), url: String(x.url).slice(0, 200), tag: String(x.tag || '').slice(0, 20), deadline: /^\d{4}-\d{2}-\d{2}$/.test(x.deadline || '') ? x.deadline : '' })), mine: (Array.isArray(D.mine) ? D.mine : []).filter((x) => x && /^https:\/\/[^\s"'<>]+$/.test(x.url || '')).slice(0, 50).map((x) => ({ name: String(x.name || '').slice(0, 40), url: String(x.url).slice(0, 200), note: String(x.note || '').slice(0, 120), c: /^0x[0-9a-f]{40}$/.test(x.c || '') ? x.c : '', at: +x.at || 0 })) }; /* 她 11/2 23:00：官方推荐空投 */
  fs.writeFileSync(path.join(DATA, 'remote.json'), JSON.stringify(RMT)); try { V4B?.extra(D.hooks?.bsc, D.rpcs?.bsc); V4R?.extra(D.hooks?.rh, D.rpcs?.rh); } catch {} } catch {} }
setInterval(remoteLoad, 10 * 60e3); setTimeout(remoteLoad, 4e3);
/* 11/2：邀请排行／热门社群（个人版读本机 data/invites_pub.json，其他人读 GitHub radar-data/invites.json），一样核对官方签名 */
let INV = { codes: {}, groups: [{ h: 'nancy_c0813', n: 0, top: 1 }] };
async function invLoad() { try { const crypto = require('crypto'); const pub = crypto.createPublicKey({ key: Buffer.from(OFFICIAL_PUB, 'base64'), format: 'der', type: 'spki' }); let j = null; const loc = path.join(DATA, 'invites_pub.json');
  if (fs.existsSync(path.join(ROOT, '.sign')) && fs.existsSync(loc)) j = readJSON(loc, null); else { const r = await fetch('https://api.github.com/repos/nancyc0813-maker/radar-data/contents/invites.json', { headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'robincat-radar' }, signal: AbortSignal.timeout(15000) }); if (r.ok) j = await r.json(); }
  if (!j?.data || !j?.sig || !crypto.verify(null, Buffer.from(j.data), pub, Buffer.from(j.sig, 'base64'))) return; const D = JSON.parse(j.data); INV = { at: +D.at || 0, codes: D.codes || {}, valid: Array.isArray(D.valid) ? D.valid : [], w: D.w && typeof D.w === 'object' ? D.w : {}, groups: Array.isArray(D.groups) ? D.groups.slice(0, 51) : INV.groups };
  if (+D.v >= 4 && /^[0-9a-f]{32}$/.test(D.salt || '')) INV.v4 = { salt: D.salt, it: Math.min(200000, Math.max(1000, +D.it || 40000)), vh: new Set(Array.isArray(D.vh) ? D.vh : []), ch: D.ch && typeof D.ch === 'object' ? D.ch : {}, wk: new Set(Array.isArray(D.wk) ? D.wk : []) }; } catch {} tgImgFix(); }
/* 11/3 群友提醒邀请码明码公开 → 官方清单只放指纹。雷达只拿「自己用得到的码」（自己填的、自己申请的、钱包前 8 码、刚输入要检查的）去算指纹比对，
   再还原成画面原本要的格式（valid／codes／w／社群的 code），画面其他地方不用改。算过的会记住，不会每 5 秒重算 */
const IHC = new Map(); const INVQ = new Set();
function invH(pre, v) { const V = INV.v4; const k = V.salt + pre + v; let h = IHC.get(k); if (!h) { h = require('crypto').pbkdf2Sync(String(v), pre + V.salt, V.it, 10, 'sha256').toString('hex'); IHC.set(k, h); if (IHC.size > 2000) IHC.clear(); } return h; }
const CODE_OK = (c) => /^[a-z0-9]{3,10}$/.test(c);
function invCheck(c) { c = String(c || '').trim().toLowerCase(); if (!CODE_OK(c)) return false; if (!INV.v4) return (INV.valid || []).includes(c); INVQ.add(c); if (INVQ.size > 40) INVQ.delete(INVQ.values().next().value); return INV.v4.vh.has(invH('rcv4:', c)); }
function invView(set, bind, wallets) { const V = INV.v4; if (!V) return INV; const crypto = require('crypto');
  const cand = [...new Set([...INVQ, set['ref.code'], set['ref.mine'], bind.join?.code, bind.code?.code, ...wallets.map((a) => a.slice(2, 10))].map((x) => String(x || '').toLowerCase()).filter(CODE_OK))].slice(0, 60);
  const valid = [], codes = {}; const hm = new Map(); for (const c of cand) { const h = invH('rcv4:', c); hm.set(h, c); if (V.vh.has(h)) valid.push(c); if (V.ch[h]) codes[c] = +V.ch[h] || 0; }
  const w = {}; for (const a of wallets) for (const c of cand) if (V.wk.has(invH('rcw4:', a + '|' + c))) { w[crypto.createHash('sha256').update('rcs1:' + a).digest('hex').slice(0, 20)] = c; break; }
  const groups = (INV.groups || []).map((g) => (g.ch ? { ...g, code: hm.get(g.ch) || '' } : g));
  return { at: INV.at, v4: 1, valid, codes, w, groups }; }
ipcMain.handle('invCheck', (e, c) => invCheck(c));
/* 她 11/2 23:00：头像不见了 → TG 头像网址会过期；自己去 t.me/群名 抓最新头像（6 小时更新一次） */
const TGI = new Map(); let TGIB = 0; function tgImgFix() { for (const g of INV.groups || []) { const c = TGI.get(g.h); if (c?.img) g.img = c.img; } if (TGIB) return; TGIB = 1; (async () => { try { for (const g of (INV.groups || []).slice(0, 51)) { if (!/^[A-Za-z0-9_]{4,32}$/.test(g.h || '')) continue; const c = TGI.get(g.h); if (c && Date.now() - c.at < 6 * 3600e3) continue; try { const t = await (await fetch('https://t.me/' + g.h, { signal: AbortSignal.timeout(10000) })).text(); const m = t.match(/<meta property="og:image" content="(https:\/\/[a-z0-9.-]*telesco\.pe\/[^"]+)"/); TGI.set(g.h, { at: Date.now(), img: m ? m[1] : '' }); if (m) g.img = m[1]; } catch { TGI.set(g.h, { at: Date.now() - 5 * 3600e3, img: c?.img || '' }); } } } finally { TGIB = 0; } })(); }
/* 11/2 官方黑名单：其他雷达回报过的诈骗合约／部署者（核对官方签名才用），引擎读 data/blacklist.json */
async function blLoad() { try { if (fs.existsSync(path.join(ROOT, '.sign'))) return; const crypto = require('crypto'); const pub = crypto.createPublicKey({ key: Buffer.from(OFFICIAL_PUB, 'base64'), format: 'der', type: 'spki' }); const r = await fetch('https://api.github.com/repos/nancyc0813-maker/radar-data/contents/blacklist.json', { headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'robincat-radar' }, signal: AbortSignal.timeout(15000) }); if (!r.ok) return; const j = await r.json(); if (!j?.data || !j?.sig || !crypto.verify(null, Buffer.from(j.data), pub, Buffer.from(j.sig, 'base64'))) return; fs.writeFileSync(path.join(DATA, 'blacklist.json'), j.data); } catch {} }
setInterval(blLoad, 30 * 60e3); setTimeout(blLoad, 15e3);
/* 11/2 X 帐号统一监测：官方查到被监测的 X 帐号贴了合约 → radar-data/xwatch.json（核对官方签名才用）→ data/xwatch.json，引擎当频道贴文加进追踪。用 raw 网址，不吃 GitHub API 次数 */
let XW = { acc: [] };
async function xwLoad() { try { if (fs.existsSync(path.join(ROOT, '.sign'))) { XW = readJSON(path.join(DATA, 'xwatch.json'), XW); return; } const crypto = require('crypto'); const pub = crypto.createPublicKey({ key: Buffer.from(OFFICIAL_PUB, 'base64'), format: 'der', type: 'spki' }); const r = await fetch('https://raw.githubusercontent.com/nancyc0813-maker/radar-data/main/xwatch.json?t=' + Math.floor(Date.now() / 120e3), { headers: { 'User-Agent': 'robincat-radar' }, signal: AbortSignal.timeout(15000) }); if (!r.ok) return; const j = await r.json(); if (!j?.data || !j?.sig || !crypto.verify(null, Buffer.from(j.data), pub, Buffer.from(j.sig, 'base64'))) return; const D = JSON.parse(j.data); XW = { acc: Array.isArray(D.acc) ? D.acc.slice(0, 60) : [], hits: Array.isArray(D.hits) ? D.hits.slice(-300) : [] }; fs.writeFileSync(path.join(DATA, 'xwatch.json'), JSON.stringify(XW)); } catch {} }
setInterval(xwLoad, 180e3); setTimeout(xwLoad, 12e3);
setInterval(invLoad, 5 * 60e3); ipcMain.handle('invReload', () => invLoad()); setTimeout(invLoad, 8e3);
ipcMain.handle('news', async () => { if (Date.now() - NEWS.at < 60e3 && NEWS.items.length) return NEWS.items; try { const j = await (await fetch('https://nightshift.fans/api/finance', { signal: AbortSignal.timeout(8000) })).json(); const items = (Array.isArray(j?.items) ? j.items : []).filter((x) => x && typeof x.title === 'string' && /^https:\/\//.test(String(x.link || ''))).slice(0, 150).map((x) => ({ title: String(x.title).slice(0, 200), link: String(x.link), source: String(x.source || '').slice(0, 40), cat: String(x.cat || ''), time: String(x.time || '') })); if (items.length) NEWS = { at: Date.now(), items }; } catch {} return NEWS.items; });
ipcMain.handle('hist', (e, k) => { if (!HIST) HIST = readJSON(HISTF, {}); return (HIST[String(k)] || []).slice(-600); });
// 代币详情：DexScreener 行情 + GeckoTerminal K 线 + 貔貅检查；都是公开免费接口，1 分钟缓存
const TD = new Map();
ipcMain.handle('tokenDetail', async (e, net, addr) => { net = net === 'robinhood' ? 'robinhood' : 'bsc'; addr = String(addr || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(addr)) return { err: '合约地址格式不对' };
  const k = net + addr, c = TD.get(k); if (c && Date.now() - c.at < 60e3) return c.v;
  const out = { net, addr, pair: null, candles: [], safety: null, err: '' };
  try { const ps = await (await fetch(`https://api.dexscreener.com/tokens/v1/${net}/${addr}`, { signal: AbortSignal.timeout(12000) })).json();
    const p = (Array.isArray(ps) ? ps : []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (p) out.pair = { addr: p.pairAddress, dex: p.dexId, base: p.baseToken, quote: p.quoteToken, price: Number(p.priceUsd) || null, priceNative: p.priceNative, liq: p.liquidity?.usd ?? null, fdv: p.fdv ?? null, mcap: p.marketCap ?? null, chg: p.priceChange || {}, txns: p.txns || {}, vol: p.volume || {}, created: p.pairCreatedAt || null, img: p.info?.imageUrl || '', sites: (p.info?.websites || []).map((w) => w.url).slice(0, 3), socials: (p.info?.socials || []).map((x) => ({ type: x.type, url: x.url })).slice(0, 4) };
    else out.err = '还没有交易池（可能还没上线，或资料源还没收录）'; } catch (e2) { out.err = '行情读取失败：' + e2.message.slice(0, 40); }
  const pool = out.pair?.addr || '';
  const gnet = net === 'bsc' ? 'bsc' : 'robinhood';
  const tasks = [];
  if (pool) tasks.push((async () => { try { const j = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/${gnet}/pools/${pool}/ohlcv/minute?aggregate=5&limit=144`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) })).json(); out.candles = (j.data?.attributes?.ohlcv_list || []).map((r) => ({ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] })).reverse(); } catch {} })());
  if (net === 'bsc') tasks.push((async () => { try { const j = await (await fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${addr}&chainID=56`, { signal: AbortSignal.timeout(12000) })).json(); out.safety = { honeypot: j.honeypotResult?.isHoneypot ?? null, buyTax: j.simulationResult?.buyTax ?? null, sellTax: j.simulationResult?.sellTax ?? null, ok: !!j.simulationSuccess, holders: j.token?.totalHolders ?? null }; } catch {} })());
  await Promise.all(tasks);
  if (out.pair || out.candles.length) TD.set(k, { at: Date.now(), v: out }); if (TD.size > 200) TD.delete(TD.keys().next().value);
  return out; });
// 反馈收件箱：只有 Nancy 的个人版有（要有 .sign/referral_bot.json），一般用户这里永远是空的
ipcMain.handle('feedback', () => { if (!fs.existsSync(path.join(ROOT, '.sign', 'referral_bot.json'))) return null; const done = readJSON(path.join(DATA, 'feedback_done.json'), {}); try { return fs.readFileSync(path.join(DATA, 'feedback.jsonl'), 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse().slice(0, 500).map((x) => ({ ...x, done: !!done[x.id] })); } catch { return []; } });
ipcMain.handle('fbDone', (e, id, v) => { const f = path.join(DATA, 'feedback_done.json'); const d = readJSON(f, {}); if (v) d[id] = Date.now(); else delete d[id]; fs.writeFileSync(f, JSON.stringify(d)); return true; });
// 监测的 TG 公开频道：data/tg_channels.txt 一行一个（打狗工具读 t.me/s/频道 网页版，不用登入 TG）
const TGCH = path.join(DATA, 'tg_channels.txt');
const chNorm = (x) => String(x || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?t\.me\/(s\/)?/i, '').replace(/[/?#].*$/, '');
ipcMain.handle('tgChannels', () => { try { return fs.readFileSync(TGCH, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#')).map(chNorm).filter((x) => /^[A-Za-z0-9_]{4,40}$/.test(x)); } catch { return []; } });
ipcMain.handle('tgChannelsSave', (e, list) => { const l = [...new Set((Array.isArray(list) ? list : []).map(chNorm).filter((x) => /^[A-Za-z0-9_]{4,40}$/.test(x)))].slice(0, 100); fs.writeFileSync(TGCH, '# 一行一个 TG 频道名称（例如 agentidcall），工具会自动监测，频道贴的合约加入追踪（雷达「设定 → 监测的 TG 频道」也能改）\n' + l.join('\n') + '\n'); return l; });
ipcMain.handle('checkToken', async (e, addr) => { addr = String(addr).toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(addr)) return { err: '合约地址格式不对' };
  try { const j = await (await fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${addr}&chainID=56`, { signal: AbortSignal.timeout(15000) })).json(); return { sym: j.token?.symbol || '', name: j.token?.name || '', honeypot: j.honeypotResult?.isHoneypot ?? null, buyTax: j.simulationResult?.buyTax ?? null, sellTax: j.simulationResult?.sellTax ?? null, ok: !!j.simulationSuccess }; } catch (e) { return { err: '查不到（' + e.message.slice(0, 40) + '）' }; } });
// 官方版检查：比对 Nancy 的数位签名，确认档案没被换掉（防假冒、防被植入）
const OFFICIAL_PUB = 'MCowBQYDK2VwAyEAMWj2tCjS9GNHCqNpx9v3+JOlkEG2yZWLrw1jfg7LhIw=';
let offi = { at: 0, v: null };
function officialCheck() { if (Date.now() - offi.at < 60e3 && offi.v) return offi.v; let v;
  try { const crypto = require('crypto'); const man = fs.readFileSync(path.join(__dirname, 'official.json')); const sig = Buffer.from(fs.readFileSync(path.join(__dirname, 'official.sig'), 'utf8').trim(), 'base64');
    const pub = crypto.createPublicKey({ key: Buffer.from(OFFICIAL_PUB, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, man, pub, sig)) v = { state: 'bad', why: '签名不对' };
    else { const M = JSON.parse(man); const changed = []; for (const [f, h] of Object.entries(M.files || {})) { let x = ''; try { x = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex'); } catch {} if (x !== h) changed.push(f); } v = changed.length ? { state: 'changed', files: changed, at: M.at } : { state: 'ok', at: M.at }; }
  } catch (e) { v = { state: 'unsigned', why: e.message.slice(0, 80) }; }
  offi = { at: Date.now(), v }; return v; }
const DONATE = '0x45d8c67067a5ca209ace41fe0aca86f82847d4a6'; /* Nancy 的打赏地址（EVM）。写死在程式里，官方版签名会保护它不被换掉 */
ipcMain.handle('donate', async () => ({ addr: DONATE, img: QR ? await QR.toDataURL(DONATE, { margin: 1, width: 220 }).catch(() => '') : '' }));
ipcMain.handle('copyText', (e, t) => { if (String(t) === DONATE) { clipboard.writeText(DONATE); return true; } return false; });
ipcMain.handle('plugins', () => readJSON(path.join(DATA, 'plugins_meta.json'), { found: [] }).found || []);
ipcMain.handle('approvePlugin', (e, file, hash) => { if (!/^[^\\/]+\.mjs$/.test(String(file)) || !/^[0-9a-f]{64}$/.test(String(hash))) return false; const f = path.join(DATA, 'plugins_ok.json'); const o = readJSON(f, {}); o[file] = hash; fs.writeFileSync(f, JSON.stringify(o)); try { const w = path.join(ROOT, 'watch.mjs'); const t = new Date(); fs.utimesSync(w, t, t); } catch {} return true; }); /* 允许后让打狗工具重新载入 */

// 贴上 AI 给的东西（11/2）：网页版 AI 碰不到玩家电脑里的档案 → AI 回一段 ###RADAR-… 文字，玩家贴进雷达，这里负责安全地存档
ipcMain.handle('importAI', (e, kind, name, body) => { try {
  if (kind === 'plugin') { const f = String(name || '').trim(); if (!/^[\w一-鿿-]{1,40}\.mjs$/.test(f)) return { err: '档名不对（只能用中英文、数字、-、_，结尾 .mjs）' }; const code = String(body || ''); if (code.length > 200000) return { err: '太大了' }; if (!/export\s+const\s+meta/.test(code) || !/export\s+async\s+function\s+tick/.test(code)) return { err: '这不是雷达小工具的格式（缺 meta 或 tick）' };
    if (['网格.mjs', '定投.mjs', '钱包总览.mjs'].includes(f)) return { err: '这是官方小工具的档名，不能覆盖。请叫 AI 换一个档名' }; const dir = path.join(ROOT, 'plugins'); const fp = path.join(dir, f); const existed = fs.existsSync(fp); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(fp, code); const trades = /\b(buy|sell|call|limitBuy|limitSell)\b/.test(code.replace(/\/\/[^\n]*/g, '')); if (!trades) try { const okf = path.join(DATA, 'plugins_ok.json'); const ok = readJSON(okf, {}); ok[f] = require('crypto').createHash('sha256').update(code).digest('hex'); fs.writeFileSync(okf, JSON.stringify(ok)); } catch {} /* 她 11/2：用户自己按「安装」就等于允许 → 11/3 安全审查：只限「只看不买」的；会花钱的外挂还要到「外挂」那里再按一次「允许」（跟安装时画面说的一样） */
    try { const w = path.join(ROOT, 'watch.mjs'); const now = new Date(); fs.utimesSync(w, now, now); } catch {} /* 让引擎重新载入，才看得到新小工具 */
    return { ok: true, file: f, existed, trades }; }
  if (kind === 'rules') { const add = JSON.parse(String(body || '[]')); if (!Array.isArray(add)) return { err: '格式不对' }; const F = ['name', 'liqUsd', 'liqBnb', 'agents', 'progress', 'buyTax', 'sellTax', 'realBuyers', 'bundlePct', 'top10Pct']; const ok = add.filter((r) => r && F.includes(r.field) && ['contains', '<', '>'].includes(r.op) && r.value != null).slice(0, 50).map((r) => ({ chain: ['all', 'bsc', 'robinhood'].includes(r.chain) ? r.chain : 'all', field: r.field, op: r.op, value: r.field === 'name' ? String(r.value).slice(0, 40) : Number(r.value), note: String(r.note || '').slice(0, 40) })).filter((r) => r.field === 'name' || Number.isFinite(r.value));
    const cur = readJSON(SET, {}); cur.rules = [...(Array.isArray(cur.rules) ? cur.rules : []), ...ok].slice(0, 50); fs.writeFileSync(SET, JSON.stringify({ ...cur, savedAt: Date.now() }, null, 1)); cache.at = 0; return { ok: true, n: ok.length, skipped: add.length - ok.length }; }
  return { err: '不认识的类型' }; } catch (er) { return { err: '读不懂：' + er.message.slice(0, 80) }; } });
ipcMain.handle('saveSettings', (e, s) => { fs.writeFileSync(SET, JSON.stringify({ ...readJSON(SET, {}), ...s, savedAt: Date.now() }, null, 1)); cache.at = 0; return true; });
/* 她 11/2 22:35：引擎当掉／电脑重开后没跑 → 你的持仓没人顾。雷达开着就每分钟看一次，停超过 5 分钟自动叫起来（10 分钟最多一次），并跳桌面通知 */
/* 她 11/3（Mac 用户回报引擎一直停着）：以前只有 Windows 能自动启动引擎 → Mac／Linux 用雷达内建的 Node 启动 */
function startEngine() { try { if (process.platform === 'win32') { const v = ['start_hidden.vbs', 'start_watch.vbs'].map((f) => path.join(ROOT, f)).find((f) => fs.existsSync(f)); if (!v) return false; require('child_process').spawn('wscript.exe', [v], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref(); return true; }
  const cp = require('child_process'); const lg = fs.openSync(path.join(DATA, 'watch_console.log'), 'a'); cp.spawn(process.execPath, [path.join(ROOT, 'watch.mjs')], { cwd: ROOT, detached: true, stdio: ['ignore', lg, lg], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).unref(); return true; } catch { return false; } }
function hbAgeSec() { const hb = readText(path.join(DATA, 'watch_heartbeat.txt')).trim(); const m = hb.match(/(\d{4}\/\d+\/\d+)\s+(\d+:\d+:\d+)/); return m ? (Date.now() - Date.parse(m[1] + ' ' + m[2])) / 1e3 : 1e9; }
/* 她 11/3：新版检查不靠引擎 —— 引擎停了也看得到「有新版」 */
async function updPeek() { try { const R = await fetch('https://raw.githubusercontent.com/nancyc0813-maker/robincat-sentinel/main/version.json?t=' + Date.now(), { signal: AbortSignal.timeout(15000) }); if (!R.ok) return; const v = await R.json(); const cur = String(readJSON(path.join(ROOT, 'version.json'), {}).version || ''); const gt = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) > (y[i] || 0)) return true; if ((x[i] || 0) < (y[i] || 0)) return false; } return false; }; const UF = path.join(DATA, 'update_avail.json'); if (cur && v.version && gt(v.version, cur)) fs.writeFileSync(UF, JSON.stringify({ version: String(v.version).slice(0, 20), cur, notes: (v.notes || []).slice(0, 12).map((x) => String(x).slice(0, 200)), at: Date.now() })); } catch {} }
if (fs.existsSync(path.join(ROOT, 'version.json'))) { setTimeout(updPeek, 20e3); setInterval(updPeek, 30 * 60e3); }
setTimeout(() => { try { if (!fs.existsSync(path.join(ROOT, 'WATCH_STOP')) && hbAgeSec() > 120) startEngine(); } catch {} }, 25e3); /* 打开雷达时引擎没在跑 → 自动启动 */
let engWatchAt = 0; setInterval(() => { try { if (fs.existsSync(path.join(ROOT, 'WATCH_STOP'))) return; const hb = readText(path.join(DATA, 'watch_heartbeat.txt')).trim(); const m = hb.match(/(\d{4}\/\d+\/\d+)\s+(\d+:\d+:\d+)/); const age = m ? (Date.now() - Date.parse(m[1] + ' ' + m[2])) / 1e3 : 1e9; try { const pf = path.join(DATA, 'update_pending.json'); if (fs.existsSync(pf)) { const P = JSON.parse(fs.readFileSync(pf, 'utf8')); const since = Date.now() - (P.at || 0); if (since > 3 * 60e3 && since < 30 * 60e3 && age > 150) { /* 她 11/3：新版装好后引擎起不来 → 自动换回旧版 */ const bk = path.join(DATA, String(P.bk || '')); let n = 0; for (const f of P.files || []) { const src = path.join(bk, f); if (P.bk && fs.existsSync(src)) { fs.copyFileSync(src, path.join(ROOT, f)); n++; } } fs.writeFileSync(path.join(DATA, 'update_rolledback.json'), JSON.stringify({ v: P.v, at: Date.now(), n })); try { fs.unlinkSync(pf); } catch {} fs.writeFileSync(path.join(DATA, 'update_result.json'), JSON.stringify({ at: Date.now(), msg: `⚠️ 新版 v${P.v} 启动不正常，已自动换回旧版（换回 ${n} 个档案，设定都在）` })); engWatchAt = 0; try { new Notification({ title: '罗宾猫雷达', body: `新版 v${P.v} 启动不正常，已自动换回旧版。`, icon: ICON }).show(); } catch {} if ((P.files || []).some((f) => /^radar\//.test(f))) fs.writeFileSync(path.join(DATA, 'relaunch.req'), String(Date.now())); } } } catch {} if (age < 300 || Date.now() - engWatchAt < 10 * 60e3) return; engWatchAt = Date.now(); startEngine(); try { new Notification({ title: '罗宾猫雷达', body: '引擎停了超过 5 分钟，已自动重新启动。持仓的止盈止损会恢复。', icon: ICON }).show(); } catch {} } catch {} }, 60e3);
let AIR = null; try { AIR = require('./air.cjs').startAir({ DATA }); } catch (e) { console.error('air', e); } /* 她 11/2 23:00：🎁 空投页 */
ipcMain.handle('airHot', async (e, force) => { if (force) await AIR?.refresh(true).catch(() => {}); return AIR?.hot() || { list: [] }; });
ipcMain.handle('airCheck', (e, u) => AIR?.checkUrl(String(u || '').slice(0, 300)) || { lvl: 0, why: [] });
ipcMain.handle('airState', () => readJSON(path.join(DATA, 'air_state.json'), {}));
/* 她 11/3：实时日志 — 用户在雷达里看后台在跑什么（只读最后一段，金钥类字串一律遮掉） */
ipcMain.handle('logTail', (e, n) => { try { const f = path.join(DATA, 'watch.log'); const st = fs.statSync(f); const len = Math.min(st.size, 160 * 1024); const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd);
  let L = b.toString('utf8').split(/\r?\n/).filter(Boolean); if (st.size > len) L.shift(); L = L.slice(-Math.max(20, Math.min(600, Number(n) || 300)));
  return L.map((x) => x.replace(/\b\d{8,10}:AA[\w-]{30,}\b/g, '[TG金钥]').replace(/github_pat_[\w]{20,}/g, '[金钥]').replace(/\b(sk|pk|api|key|token|secret)[-_]?[\w-]{16,}/gi, '[金钥]').replace(/0x[0-9a-fA-F]{64}\b/g, (h) => h.slice(0, 8) + '…' + h.slice(-4)).replace(/(私钥|私鑰|助记词|助記詞|mnemonic|private ?key)\S*/gi, '[已隐藏]')); } catch { return []; } });
ipcMain.handle('smartAuto', () => { const z = readJSON(path.join(DATA, 'smart_auto.json'), {}); return { bsc: { at: z.bsc?.at || 0, rank: z.bsc?.rank || [], n: Object.keys(z.bsc?.done || {}).length }, rh: { at: z.rh?.at || 0, rank: z.rh?.rank || [], n: Object.keys(z.rh?.done || {}).length } }; });
ipcMain.handle('restartEngine', () => startEngine()); /* 她 11/2 15:46：引擎停了，按一下重新启动（11/3 起 Mac 也可以） */
ipcMain.handle('pause', (e, on) => { const f = path.join(DATA, 'pause_buy.txt'); if (on) fs.writeFileSync(f, String(Date.now())); else try { fs.unlinkSync(f); } catch {} cache.at = 0; return on; });
ipcMain.handle('order', (e, o) => { // 交给打狗工具执行（它会照安全检查、每日额度处理）
  const q = path.join(DATA, 'radar_orders.json'); const arr = readJSON(q, []); arr.push({ ...o, at: Date.now(), id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }); const tmp = q + '.w' + process.pid; fs.writeFileSync(tmp, JSON.stringify(arr.slice(-30))); fs.renameSync(tmp, q); /* 先写暂存档再换名：引擎不会读到写一半的档 */ return true; });
ipcMain.handle('open', (e, url) => { try { const x = new URL(String(url || '')); if (x.protocol === 'https:' && !x.username && !x.password) shell.openExternal(x.href); } catch {} });
ipcMain.handle('notify', (e, t, b) => { try { new Notification({ title: t, body: b, icon: ICON }).show(); } catch {} });

/* 一键更新后：画面档案换了 → 重新整理；雷达外壳换了 → 自动重开一次（她 11/2） */
setInterval(() => { try { const rl = path.join(DATA, 'relaunch.req'), rd = path.join(DATA, 'reload.req'); if (fs.existsSync(rl)) { fs.unlinkSync(rl); try { if (fs.existsSync(rd)) fs.unlinkSync(rd); } catch {} app.relaunch(); app.exit(0); return; } if (fs.existsSync(rd)) { fs.unlinkSync(rd); if (win && !win.isDestroyed()) win.webContents.reload(); } } catch {} }, 3000);
function createWindow() {
  win = new BrowserWindow({ width: 1320, height: 840, minWidth: 1100, minHeight: 680, title: '罗宾猫雷达', icon: ICON, backgroundColor: '#0b0d11', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  /* 她 11/2 15:21：F5 要一定能重新整理（不管焦点在哪） */
  win.webContents.on('before-input-event', (e, inp) => { if (inp.type === 'keyDown' && (inp.key === 'F5' || ((inp.control || inp.meta) && String(inp.key).toLowerCase() === 'r'))) { e.preventDefault(); win.webContents.executeJavaScript("try{sessionStorage.setItem('goBoard','1')}catch{}").catch(() => {}).finally(() => win.webContents.reload()); } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));                 // 安全：不开任何新视窗
  win.webContents.on('will-navigate', (e) => e.preventDefault());                    // 安全：不允许跳到别的网站
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });   // 关视窗 = 缩到右下角，继续在背景跑
}
app.whenReady().then(() => {
  createWindow();
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('罗宾猫雷达 · 监控中');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开罗宾猫雷达', click: () => { win.show(); win.focus(); } }, { type: 'separator' }, { label: '结束', click: () => { quitting = true; app.quit(); } }]));
  tray.on('click', () => { win.show(); win.focus(); });
});
// 程式更新后自动套用：介面档改了就重新整理，主程式改了就自己重开（不用玩家手动重启）
let rlT = null; const watchFile = (f, full) => { try { fs.watchFile(f, { interval: 3000 }, (cur, prev) => { if (cur.mtimeMs === prev.mtimeMs) return; clearTimeout(rlT); rlT = setTimeout(() => { if (full) { app.relaunch(); quitting = true; app.exit(0); } else if (win) win.webContents.reloadIgnoringCache(); }, 1500); }); } catch {} }; /* 用定时比对修改时间（fs.watch 在共享资料夹收不到通知，改了不会更新） */
app.whenReady().then(() => { watchFile(path.join(__dirname, 'ui', 'index.html'), false); watchFile(path.join(__dirname, 'main.cjs'), true); watchFile(path.join(__dirname, 'preload.cjs'), true); watchFile(path.join(__dirname, 'settings_schema.json'), false); });
app.on('window-all-closed', (e) => e.preventDefault?.());

