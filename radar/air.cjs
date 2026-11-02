// 罗宾猫雷达 · 空投页（雷达这边）：热门空投（airdrops.io）、网址防钓鱼检查
// 她 11/2 23:00：空投独立成一页，11 个功能全做。这里只做「读」，不碰钱包、不下单。
const fs = require('fs'), path = require('path');
function startAir({ DATA }) {
  const HOTF = path.join(DATA, 'air_hot.json');
  let HOT = (() => { try { return JSON.parse(fs.readFileSync(HOTF, 'utf8')); } catch { return { at: 0, list: [] }; } })(), busy = 0;
  const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&#039;/g, "'").replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();
  function parse(html, kind) {
    const out = [];
    for (const part of String(html).split('<article ').slice(1)) {
      if (!/airdrop-click/.test(part.slice(0, 400))) continue;
      const a = (n) => (part.match(new RegExp(n + '="([^"]*)"')) || [])[1] || '';
      const url = (part.match(/<a href=["']?(https:\/\/airdrops\.io\/[a-z0-9-]+\/)["']?>\s*<h3>/i) || [])[1] || '';
      const name = strip((part.match(/<h3>([\s\S]*?)<\/h3>/) || [])[1]);
      if (!url || !name) continue;
      const img = (part.match(/data-src="(https:\/\/airdrops\.io\/wp-content\/[^"]+)"/) || [])[1] || '';
      const act = strip((part.match(/Actions:\s*<span>([\s\S]*?)<\/span>/) || [])[1]).slice(0, 120);
      const d = (s) => (/^\d{8}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : '');
      out.push({ name: name.slice(0, 60), url, img, heat: +a('data-temperature') || 0, ends: d(a('data-ends')), start: d(a('data-start')), confirmed: /\bconfirmed\b/.test(part.slice(0, 400)), kyc: a('data-kyc-required') === '1', act, kind });
    }
    return out;
  }
  async function refresh(force) {
    if (busy || (!force && Date.now() - (HOT.at || 0) < 6 * 3600e3 && HOT.list?.length)) return; busy = 1;
    try {
      const got = [];
      for (const [k, u] of [['hot', 'https://airdrops.io/hot/'], ['latest', 'https://airdrops.io/latest/']]) {
        try { const t = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 RobinCatRadar' }, signal: AbortSignal.timeout(20000) })).text(); got.push(...parse(t, k)); } catch {}
      }
      const m = new Map(); for (const x of got) { const o = m.get(x.url); if (!o || x.heat > o.heat) m.set(x.url, { ...(o || {}), ...x, kind: o ? 'hot' : x.kind }); }
      const list = [...m.values()].sort((a, b) => b.heat - a.heat).slice(0, 40);
      if (list.length) { HOT = { at: Date.now(), list }; try { fs.writeFileSync(HOTF, JSON.stringify(HOT)); } catch {} }
    } finally { busy = 0; }
  }
  setTimeout(() => refresh().catch(() => {}), 20e3); setInterval(() => refresh().catch(() => {}), 60 * 60e3);

  // ── 防钓鱼：看网址长相＋网域多新（RDAP，公开免费），只给提醒，不会挡 ──
  const BRAND = ['binance', 'pancakeswap', 'metamask', 'trustwallet', 'okx', 'bybit', 'bitget', 'coinbase', 'uniswap', 'opensea', 'galxe', 'layer3', 'zealy', 'robinhood', 'gmgn', 'dexscreener', 'four', 'flap', 'telegram', 'twitter', 'airdrops', 'debank', 'zksync', 'arbitrum', 'optimism', 'base', 'linea', 'scroll', 'blast', 'jupiter', 'phantom', 'rabby', 'safepal', 'tokenpocket', 'ledger', 'trezor'];
  const OFFICIAL = new Set(['binance.com', 'pancakeswap.finance', 'metamask.io', 'trustwallet.com', 'okx.com', 'bybit.com', 'bitget.com', 'coinbase.com', 'uniswap.org', 'opensea.io', 'galxe.com', 'app.galxe.com', 'layer3.xyz', 'zealy.io', 'robinhood.com', 'gmgn.ai', 'dexscreener.com', 'four.meme', 'flap.sh', 't.me', 'telegram.org', 'x.com', 'twitter.com', 'airdrops.io', 'debank.com', 'zksync.io', 'arbitrum.io', 'optimism.io', 'base.org', 'linea.build', 'scroll.io', 'blast.io', 'jup.ag', 'phantom.app', 'rabby.io', 'safepal.com', 'tokenpocket.pro', 'ledger.com', 'trezor.io', 'bscscan.com', 'etherscan.io', 'github.com', 'discord.com', 'discord.gg', 'medium.com', 'youtube.com', 'google.com', 'notion.so', 'gitbook.io']);
  const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
  const RDAP = new Map();
  async function checkUrl(u) {
    const why = []; let lvl = 0; let host = '';
    try { const x = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u); host = x.hostname.toLowerCase(); if (x.protocol !== 'https:') { why.push('不是 https 加密连线'); lvl = Math.max(lvl, 1); } if (x.username || x.password) { why.push('网址里藏了帐号密码（常见骗术）'); lvl = 2; } } catch { return { lvl: 2, why: ['网址格式不对'], host: '' }; }
    const parts = host.split('.'); const root = parts.slice(-2).join('.'); const name = parts.slice(-2, -1)[0] || '';
    if (OFFICIAL.has(host) || OFFICIAL.has(root)) return { lvl: 0, why: ['常见的官方网域'], host };
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) { why.push('直接用 IP，不是网域'); lvl = 2; }
    if (host.includes('xn--')) { why.push('用了长得像英文的特殊字（xn--）'); lvl = 2; }
    if (/\.(zip|mov|xyz|top|click|live|site|online|icu|buzz|rest|monster|cfd|sbs)$/.test(host)) { why.push('后缀常被拿来做钓鱼站'); lvl = Math.max(lvl, 1); }
    if (parts.length >= 5) { why.push('子网域很长'); lvl = Math.max(lvl, 1); }
    const COMMON = new Set(['finance', 'network', 'protocol', 'airdrop', 'claim', 'wallet', 'chain', 'swap', 'labs', 'token', 'money', 'games', 'space', 'trade', 'basic', 'based']);
    for (const b of BRAND) { const seg = host.replace(/\./g, '-').split('-').filter((x) => !COMMON.has(x)); if (seg.some((s) => s === b) || (b.length >= 6 && seg.some((s) => s !== b && s.length >= 5 && lev(s, b) <= (b.length >= 8 ? 2 : 1)))) { why.push(`像在模仿「${b}」但不是官方网域`); lvl = 2; break; } }
    let age = null; try { let r = RDAP.get(root); if (!r || Date.now() - r.at > 86400e3) { const j = await (await fetch('https://rdap.org/domain/' + root, { signal: AbortSignal.timeout(10000) })).json(); const ev = (j.events || []).find((e) => /registration/i.test(e.eventAction)); r = { at: Date.now(), reg: ev ? Date.parse(ev.eventDate) : 0 }; RDAP.set(root, r); } if (r.reg) { age = Math.floor((Date.now() - r.reg) / 86400e3); if (age < 30) { why.push(`网域才注册 ${age} 天`); lvl = Math.max(lvl, age < 7 ? 2 : 1); } } } catch {}
    if (!why.length) why.push(age != null ? `网域已注册 ${age} 天，没看到可疑的地方` : '没看到可疑的地方（查不到注册日期）');
    return { lvl, why, host, age };
  }
  return { hot: () => HOT, refresh, checkUrl };
}
module.exports = { startAir };
