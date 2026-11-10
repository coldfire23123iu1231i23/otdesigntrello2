'use strict';
/**
 * TrueWave – Tính điểm OT Design
 * Web server đọc Trello theo ngày và tính điểm design (0.5đ đơn giản / 1đ phức tạp).
 *
 * Nguồn dữ liệu:
 *   - Điểm "Hằng ngày"  = list tên "Done DD/MM"
 *   - Điểm "OT"         = list tên "OT DD/MM"
 * Mỗi card gắn 1 member (người làm) + 1 label sản phẩm → tra bảng phân loại ra điểm.
 *
 * Cấu hình qua biến môi trường (Railway → Variables):
 *   TRELLO_KEY, TRELLO_TOKEN   (bắt buộc)  — lấy ở https://trello.com/power-ups/admin
 *   TRELLO_BOARD               (bắt buộc)  — id ngắn của board, vd F9GPoy23
 *   PORT                       (Railway tự set)
 *   CONFIG_PATH                (tuỳ chọn)  — nơi lưu override phân loại, mặc định ./data/config.json
 *   BASIC_USER, BASIC_PASS     (tuỳ chọn)  — bật đăng nhập cơ bản nếu muốn khoá truy cập
 *   CRON_DAILY                 (tuỳ chọn)  — lịch cron tự quét, vd "30 22 * * *" (22:30 mỗi ngày)
 *   TZ                         (tuỳ chọn)  — vd Asia/Bangkok
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const KEY = process.env.TRELLO_KEY || '';
const TOKEN = process.env.TRELLO_TOKEN || '';
const BOARD = process.env.TRELLO_BOARD || '';
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'data', 'config.json');

// ---------- config (overrides phân loại + đổi tên người) ----------
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return { overrides: {}, personNames: {} };
  }
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return true;
  } catch (e) {
    console.error('Không lưu được config:', e.message);
    return false;
  }
}

// ---------- phân loại mặc định theo từ khoá ----------
const WORKFLOW_LABELS = new Set(['OT', 'Cần gấp']);
function defaultPoints(labelName) {
  // 0.5đ: ly/cốc/tumbler/tất/dép/keychain/metal sign phẳng; còn lại 1đ
  return /\bmug\b|whiskey glass|tumbler|\bsock|slipper|keychain|rectangle metal sign/i.test(labelName) ? 0.5 : 1;
}
function pointsFor(labelName, overrides) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, labelName)) return overrides[labelName];
  return defaultPoints(labelName);
}

// ---------- Trello client (cache nhẹ) ----------
const cache = {};
function cget(k) { const e = cache[k]; return e && e.exp > Date.now() ? e.v : null; }
function cset(k, v, ttlMs) { cache[k] = { v, exp: Date.now() + ttlMs }; }

async function trello(pathname, params) {
  const url = new URL('https://api.trello.com/1' + pathname);
  url.searchParams.set('key', KEY);
  url.searchParams.set('token', TOKEN);
  if (params) for (const k in params) url.searchParams.set(k, params[k]);
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('Trello ' + r.status + ': ' + t.slice(0, 200));
  }
  return r.json();
}

async function getLabels() {
  const c = cget('labels'); if (c) return c;
  const a = await trello('/boards/' + BOARD + '/labels', { fields: 'name,color', limit: '1000' });
  const byId = {};
  a.forEach(l => { byId[l.id] = { name: (l.name || '').trim(), color: l.color }; });
  cset('labels', byId, 5 * 60 * 1000);
  return byId;
}
async function getMembers() {
  const c = cget('members'); if (c) return c;
  const a = await trello('/boards/' + BOARD + '/members', { fields: 'fullName' });
  const byId = {};
  a.forEach(m => { byId[m.id] = m.fullName || m.id; });
  cset('members', byId, 5 * 60 * 1000);
  return byId;
}
async function getLists() {
  const c = cget('lists'); if (c) return c;
  const a = await trello('/boards/' + BOARD + '/lists', { fields: 'name', limit: '1000' });
  const out = a.map(l => ({ id: l.id, name: (l.name || '').trim() }));
  cset('lists', out, 60 * 1000);
  return out;
}
async function getCards(listId, fields) {
  return trello('/lists/' + listId + '/cards', { fields: fields || 'idMembers,idLabels', limit: '1000' });
}

// ---------- Template list: phát hiện sản phẩm / SKU mới ----------
function norm(s) { return String(s || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim(); }
function skuOf(name) {
  const parts = String(name || '').split(' - ');
  const last = (parts[parts.length - 1] || '').trim();
  if (last && last.length <= 20 && !/[a-z]/.test(last) && /[A-Z0-9]/.test(last)) return last.toUpperCase();
  const first = (parts[0] || '').trim();
  if (parts.length > 1 && /^[A-Z0-9]{2,12}$/.test(first)) return first.toUpperCase();
  return '';
}
async function getTemplateProducts(ctx) {
  const tl = ctx.lists.find(l => /^template$/i.test(l.name)) || ctx.lists.find(l => /template/i.test(l.name));
  if (!tl) return { listName: null, products: [] };
  const cards = await getCards(tl.id, 'name,idLabels');
  const labelArr = Object.values(ctx.labels).filter(l => l.name && !WORKFLOW_LABELS.has(l.name));
  function matchLabel(name) {
    const sk = skuOf(name), nn = norm(name);
    let m = null;
    if (sk) m = labelArr.find(l => skuOf(l.name) === sk);
    if (!m) m = labelArr.find(l => norm(l.name) === nn);
    return m;
  }
  const seen = {};
  const products = [];
  cards.forEach(c => {
    const nm = (c.name || '').trim();
    if (!nm || seen[nm]) return; seen[nm] = 1;
    const ml = matchLabel(nm);
    products.push({ name: nm, sku: skuOf(nm), label: ml ? ml.name : null, points: ml ? pointsFor(ml.name, ctx.cfg.overrides) : null });
  });
  return { listName: tl.name, products };
}

// ---------- scan 1 list → điểm theo người ----------
async function scanList(listId, ctx) {
  if (!listId) return {};
  const cards = await getCards(listId);
  const per = {}; // personKey -> {count, pts, items:{ident:count}, unknown:count}
  cards.forEach(c => {
    const mid = (c.idMembers || [])[0] || '__unassigned';
    const member = mid === '__unassigned' ? 'Chưa gán' : (ctx.members[mid] || mid);
    const person = (ctx.cfg.personNames && ctx.cfg.personNames[member]) || member;
    const prodLabId = (c.idLabels || []).find(id => {
      const l = ctx.labels[id];
      return l && l.name && !WORKFLOW_LABELS.has(l.name);
    });
    const lab = prodLabId ? ctx.labels[prodLabId] : null;
    const name = lab ? lab.name : '(không nhãn)';
    const pts = lab ? pointsFor(name, ctx.cfg.overrides) : 0;
    if (!per[person]) per[person] = { count: 0, pts: 0, items: {}, unknown: 0 };
    per[person].count += 1;
    per[person].pts += pts;
    if (!lab) per[person].unknown += 1;
    per[person].items[name] = (per[person].items[name] || 0) + 1;
  });
  return per;
}

function ddmm(dateStr) {
  // dateStr: YYYY-MM-DD -> "DD/MM"
  const p = dateStr.split('-');
  return p[2] + '/' + p[1];
}

async function buildContext() {
  const [labels, members, lists] = await Promise.all([getLabels(), getMembers(), getLists()]);
  return { labels, members, lists, cfg: loadConfig() };
}

// báo cáo 1 ngày
async function reportDay(dateStr) {
  const ctx = await buildContext();
  const tag = ddmm(dateStr);
  const doneList = ctx.lists.find(l => l.name === 'Done ' + tag);
  const otList = ctx.lists.find(l => l.name === 'OT ' + tag);
  const daily = await scanList(doneList && doneList.id, ctx);
  const ot = await scanList(otList && otList.id, ctx);

  const people = {};
  function add(src, field) {
    for (const person in src) {
      people[person] = people[person] || { person, dailyPts: 0, otPts: 0, dailyCount: 0, otCount: 0, items: {} };
      if (field === 'daily') { people[person].dailyPts += src[person].pts; people[person].dailyCount += src[person].count; }
      else { people[person].otPts += src[person].pts; people[person].otCount += src[person].count; }
      for (const it in src[person].items) people[person].items[it] = (people[person].items[it] || 0) + src[person].items[it];
    }
  }
  add(daily, 'daily'); add(ot, 'ot');
  const rows = Object.values(people).sort((a, b) => (b.dailyPts + b.otPts) - (a.dailyPts + a.otPts));
  return {
    date: dateStr, tag,
    doneFound: !!doneList, otFound: !!otList,
    rows: rows.map(r => ({
      person: r.person,
      dailyPts: round(r.dailyPts), otPts: round(r.otPts), totalPts: round(r.dailyPts + r.otPts),
      dailyCount: r.dailyCount, otCount: r.otCount,
      items: Object.keys(r.items).sort().map(k => ({ name: k, n: r.items[k] }))
    }))
  };
}

// báo cáo tháng: duyệt mọi list Done DD/MM và OT DD/MM của tháng
async function reportMonth(month) {
  const ctx = await buildContext();
  const mm = month.split('-')[1];
  const dayRe = new RegExp('^(Done|OT) (\\d{2})\\/' + mm + '$');
  const targets = ctx.lists.map(l => {
    const m = l.name.match(dayRe); return m ? { id: l.id, kind: m[1], day: m[2] } : null;
  }).filter(Boolean);

  const people = {}; const daysSet = {};
  for (const t of targets) {
    const per = await scanList(t.id, ctx);
    daysSet[t.day] = true;
    for (const person in per) {
      people[person] = people[person] || { person, dailyPts: 0, otPts: 0, days: {} };
      if (t.kind === 'Done') people[person].dailyPts += per[person].pts;
      else people[person].otPts += per[person].pts;
      people[person].days[t.day] = (people[person].days[t.day] || 0) + per[person].pts;
    }
  }
  const days = Object.keys(daysSet).sort();
  const rows = Object.values(people).sort((a, b) => (b.dailyPts + b.otPts) - (a.dailyPts + a.otPts)).map(r => ({
    person: r.person,
    dailyPts: round(r.dailyPts), otPts: round(r.otPts), totalPts: round(r.dailyPts + r.otPts),
    activeDays: Object.keys(r.days).filter(d => r.days[d] > 0).length,
    byDay: days.map(d => ({ day: d, pts: round(r.days[d] || 0) }))
  }));
  return { month, mm, days, rows };
}

function round(n) { return Math.round(n * 10) / 10; }

// ---------- app ----------
const app = express();
app.use(express.json());

// basic auth tuỳ chọn
if (process.env.BASIC_USER && process.env.BASIC_PASS) {
  app.use((req, res, next) => {
    const h = req.headers.authorization || '';
    const [, b64] = h.split(' ');
    const [u, p] = Buffer.from(b64 || '', 'base64').toString().split(':');
    if (u === process.env.BASIC_USER && p === process.env.BASIC_PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="OT"').status(401).send('Cần đăng nhập');
  });
}

app.get('/api/health', (req, res) => res.json({ ok: true, hasTrello: !!(KEY && TOKEN && BOARD) }));

app.get('/api/report', async (req, res) => {
  try {
    if (!(KEY && TOKEN && BOARD)) return res.status(400).json({ error: 'Chưa cấu hình TRELLO_KEY/TOKEN/BOARD' });
    const date = req.query.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date phải dạng YYYY-MM-DD' });
    res.json(await reportDay(date));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/month', async (req, res) => {
  try {
    if (!(KEY && TOKEN && BOARD)) return res.status(400).json({ error: 'Chưa cấu hình TRELLO_KEY/TOKEN/BOARD' });
    const month = req.query.month;
    if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month phải dạng YYYY-MM' });
    res.json(await reportMonth(month));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// danh sách label + điểm hiện tại (để chỉnh phân loại)
app.get('/api/labels', async (req, res) => {
  try {
    if (!(KEY && TOKEN && BOARD)) return res.status(400).json({ error: 'Chưa cấu hình TRELLO_KEY/TOKEN/BOARD' });
    const labels = await getLabels();
    const cfg = loadConfig();
    const out = Object.values(labels)
      .filter(l => l.name && !WORKFLOW_LABELS.has(l.name))
      .map(l => ({
        name: l.name, color: l.color,
        points: pointsFor(l.name, cfg.overrides),
        overridden: Object.prototype.hasOwnProperty.call(cfg.overrides || {}, l.name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ labels: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// lưu phân loại: body { name, points }  (points 0.5 | 1 | null để xoá override)
app.post('/api/classify', (req, res) => {
  const { name, points } = req.body || {};
  if (!name) return res.status(400).json({ error: 'thiếu name' });
  const cfg = loadConfig();
  cfg.overrides = cfg.overrides || {};
  if (points === null) delete cfg.overrides[name];
  else if (points === 0.5 || points === 1) cfg.overrides[name] = points;
  else return res.status(400).json({ error: 'points phải là 0.5, 1 hoặc null' });
  saveConfig(cfg);
  res.json({ ok: true, overrides: cfg.overrides });
});

// quét cột Template, phát hiện sản phẩm/SKU mới so với lần đã xem
app.get('/api/template', async (req, res) => {
  try {
    if (!(KEY && TOKEN && BOARD)) return res.status(400).json({ error: 'Chưa cấu hình TRELLO_KEY/TOKEN/BOARD' });
    const ctx = await buildContext();
    const t = await getTemplateProducts(ctx);
    const cfg = ctx.cfg;
    const names = t.products.map(p => p.name);
    let initialized = false;
    if (!Array.isArray(cfg.knownTemplate)) { cfg.knownTemplate = names; saveConfig(cfg); initialized = true; }
    const known = new Set(cfg.knownTemplate);
    const products = t.products.map(p => Object.assign({}, p, { isNew: initialized ? false : !known.has(p.name) }));
    res.json({
      listName: t.listName, total: products.length,
      newCount: products.filter(p => p.isNew).length,
      noLabelCount: products.filter(p => !p.label).length,
      initialized, products
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// đánh dấu đã xem toàn bộ Template hiện tại (reset cảnh báo SKU mới)
app.post('/api/template/ack', async (req, res) => {
  try {
    if (!(KEY && TOKEN && BOARD)) return res.status(400).json({ error: 'Chưa cấu hình TRELLO_KEY/TOKEN/BOARD' });
    const ctx = await buildContext();
    const t = await getTemplateProducts(ctx);
    const cfg = loadConfig();
    cfg.knownTemplate = t.products.map(p => p.name);
    saveConfig(cfg);
    res.json({ ok: true, total: cfg.knownTemplate.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log('OT Design server chạy ở cổng ' + PORT + (KEY && TOKEN && BOARD ? '' : '  (CHƯA cấu hình Trello)'));
});

// cron tự quét (chỉ để log/làm nóng cache; dữ liệu luôn lấy trực tiếp từ Trello khi mở web)
if (process.env.CRON_DAILY && KEY && TOKEN && BOARD) {
  cron.schedule(process.env.CRON_DAILY, async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const r = await reportDay(today);
      console.log('[cron] Quét ' + r.tag + ' xong:', r.rows.map(x => x.person + '=' + x.totalPts).join(', '));
      // quét Template xem có SKU mới
      const ctx = await buildContext();
      const tp = await getTemplateProducts(ctx);
      const known = new Set(Array.isArray(ctx.cfg.knownTemplate) ? ctx.cfg.knownTemplate : tp.products.map(p => p.name));
      const nw = tp.products.filter(p => !known.has(p.name)).map(p => p.name);
      console.log('[cron] Template: ' + tp.products.length + ' sản phẩm' + (nw.length ? ' · SKU MỚI (' + nw.length + '): ' + nw.join(' | ') : ' · không có SKU mới'));
    } catch (e) { console.error('[cron] lỗi:', e.message); }
  }, { timezone: process.env.TZ || 'Asia/Bangkok' });
  console.log('Cron tự quét bật:', process.env.CRON_DAILY);
}
