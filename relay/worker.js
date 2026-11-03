// 罗宾猫雷达 · 手机转接站（Cloudflare Worker + Durable Object）
// 只做一件事：把「电脑雷达」和「手机页面」之间的加密讯息互相转送。
// 金钥只在电脑和手机上（QR 码里，网址 # 后面的部分不会送到伺服器），转接站看不到内容、也伪造不了指令。
import { DurableObject } from 'cloudflare:workers';
import PHONE from './phone.html';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

/* ── 邀请码核对（她 11/3 14:32：只有绑定了有效邀请码的雷达能用手机连结）──
   ① 名单：Nancy 的雷达发布到 GitHub radar-data/invites.json，有官方签名（Ed25519），这里核对签名才相信
   ② 本人：电脑雷达附上「钱包签的邀请绑定」（EIP-712），这里还原出签名的钱包，必须是名单里的钱包
   改自己电脑上的程式跳过邀请码画面，在这里还是过不了 */
const OFFICIAL_PUB = 'MCowBQYDK2VwAyEAMWj2tCjS9GNHCqNpx9v3+JOlkEG2yZWLrw1jfg7LhIw=';
const INV_URL = 'https://raw.githubusercontent.com/nancyc0813-maker/radar-data/main/invites.json';
const enc = new TextEncoder();
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
const kh = (s) => keccak_256(enc.encode(s));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const pad32 = (h) => unhex(h.padStart(64, '0'));
function bindDigest(kind, code, wallet) {
  const dom = keccak_256(cat(kh('EIP712Domain(string name,string version,uint256 chainId)'), kh('RobinCat Radar'), kh('1'), pad32((56).toString(16))));
  const st = keccak_256(cat(kh('Bind(string kind,string code,address wallet)'), kh(kind), kh(code), pad32(wallet.slice(2))));
  return keccak_256(cat(unhex('1901'), dom, st));
}
function recover(digest, sig, v) { const s = secp256k1.Signature.fromCompact(sig).addRecoveryBit(v); const pub = s.recoverPublicKey(digest).toRawBytes(false); return '0x' + hex(keccak_256(pub.slice(1)).slice(12)); }
let INV = { at: 0, rw: null };
async function members() {
  if (INV.rw && Date.now() - INV.at < 10 * 60e3) return INV.rw;
  try {
    const j = await (await fetch(INV_URL + '?t=' + Math.floor(Date.now() / 300e3), { cf: { cacheTtl: 120 } })).json();
    const key = await crypto.subtle.importKey('spki', Uint8Array.from(atob(OFFICIAL_PUB), (c) => c.charCodeAt(0)), { name: 'Ed25519' }, false, ['verify']);
    if (!(await crypto.subtle.verify({ name: 'Ed25519' }, key, Uint8Array.from(atob(j.sig), (c) => c.charCodeAt(0)), enc.encode(j.data)))) throw new Error('bad sig');
    const D = JSON.parse(j.data); if (Array.isArray(D.rw)) INV = { at: Date.now(), rw: new Set(D.rw) };
  } catch {}
  return INV.rw;
}
async function checkPc(u, env) {
  { const o = String(u.searchParams.get('o') || ''); if (o) { /* 她自己的雷达：用官方私钥（只在她电脑）签这个房间号 */ try { const room = u.pathname.split('/').pop(); const key = await crypto.subtle.importKey('spki', Uint8Array.from(atob(OFFICIAL_PUB), (c) => c.charCodeAt(0)), { name: 'Ed25519' }, false, ['verify']); const sg = Uint8Array.from(atob(o.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)); if (await crypto.subtle.verify({ name: 'Ed25519' }, key, sg, enc.encode('rcrelay1-owner:' + room))) return ''; } catch {} return '官方通行证核对不过'; } }
  const w = String(u.searchParams.get('w') || '').toLowerCase(), k = u.searchParams.get('k'), c = String(u.searchParams.get('c') || '').toLowerCase(), s = String(u.searchParams.get('s') || '').toLowerCase(), v = Number(u.searchParams.get('v'));
  if (!/^0x[0-9a-f]{40}$/.test(w) || !['join', 'code'].includes(k) || !/^[a-z0-9_]{3,10}$/.test(c) || !/^[0-9a-f]{128}$/.test(s)) return '这台雷达还没完成邀请码绑定（要先在雷达输入邀请码、用钱包签名绑定）';
  const rw = await members(); if (!rw) return '暂时读不到邀请名单，等一下再试';
  const h = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('rcrelay1:' + w))).slice(0, 12));
  if (!rw.has(h)) return '这个钱包的邀请码绑定还没生效（刚绑定的话等几分钟）';
  let ok = false; try { const d = bindDigest(k, c, w); for (const r of (v === 0 || v === 1) ? [v, 1 - v] : [0, 1]) if (recover(d, s, r) === w) { ok = true; break; } } catch {}
  return ok ? '' : '邀请绑定的签名核对不过';
}
function deny(why) { const [client, server] = Object.values(new WebSocketPair()); server.accept(); server.send(JSON.stringify({ sys: { deny: why } })); server.close(4003, 'denied'); return new Response(null, { status: 101, webSocket: client }); }


const ROOM_RE = /^[A-Za-z0-9_-]{32}$/;
const MAX_MSG = 600 * 1024; // 单则讯息上限（看盘资料约 50～150KB）
const MAX_PHONES = 3;

const SEC = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000',
};
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="40" fill="#0b0d11"/><circle cx="96" cy="96" r="70" fill="none" stroke="#22c55e" stroke-width="6" opacity=".55"/><circle cx="96" cy="96" r="44" fill="none" stroke="#22c55e" stroke-width="5" opacity=".8"/><path d="M96 96 L150 52" stroke="#22c55e" stroke-width="7" stroke-linecap="round"/><circle cx="96" cy="96" r="9" fill="#f0b90b"/></svg>`;
const MANIFEST = JSON.stringify({ name: '罗宾猫雷达', short_name: '罗宾猫雷达', scope: '/', display: 'standalone', background_color: '#0b0d11', theme_color: '#0b0d11', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] });

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method !== 'GET') return new Response('method', { status: 405 });
    if (u.pathname === '/' || u.pathname === '/index.html') return new Response(PHONE, { headers: { ...SEC, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': CSP } });
    if (u.pathname === '/manifest.webmanifest') return new Response(MANIFEST, { headers: { ...SEC, 'content-type': 'application/manifest+json', 'cache-control': 'max-age=3600' } });
    if (u.pathname === '/icon.svg') return new Response(ICON, { headers: { ...SEC, 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' } });
    if (u.pathname === '/health') return new Response('ok', { headers: SEC });
    const m = u.pathname.match(/^\/ws\/([^/]+)$/);
    if (m) {
      const role = u.searchParams.get('r');
      if (!ROOM_RE.test(m[1]) || (role !== 'pc' && role !== 'ph')) return new Response('bad room', { status: 400 });
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      if (role === 'pc') { const why = await checkPc(u, env); if (why) return deny(why); }
      return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
    }
    return new Response('not found', { status: 404, headers: SEC });
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // 心跳：回 pong 不会叫醒转接站，也不计费
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  sockets(role, skip) { return this.ctx.getWebSockets(role).filter((w) => w !== skip && w.readyState === 1); }
  sys(ws, o) { try { ws.send(JSON.stringify({ sys: o })); } catch {} }
  presence(skip) {
    const pcOn = this.sockets('pc', skip).length > 0, n = this.sockets('ph', skip).length;
    for (const w of this.sockets('ph', skip)) this.sys(w, { pc: pcOn });
    for (const w of this.sockets('pc', skip)) this.sys(w, { ph: n });
  }
  async fetch(req) {
    const role = new URL(req.url).searchParams.get('r');
    if (role === 'pc') for (const w of this.sockets('pc')) { try { w.close(4000, 'replaced'); } catch {} }
    if (role === 'ph') { const ph = this.sockets('ph'); for (let i = 0; i <= ph.length - MAX_PHONES; i++) { try { ph[i].close(4001, 'too many phones'); } catch {} } }
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    this.presence();
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > MAX_MSG || !msg.startsWith('{"e":"')) return; // 只转送加密封包，其他一律丢掉
    const role = this.ctx.getTags(ws)[0]; const to = role === 'pc' ? 'ph' : 'pc';
    for (const w of this.sockets(to)) { try { w.send(msg); } catch {} }
  }
  async webSocketClose(ws, code) { try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch {} this.presence(ws); }
  async webSocketError(ws) { try { ws.close(1011, 'error'); } catch {} this.presence(ws); }
}
