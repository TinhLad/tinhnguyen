'use strict';
/* Chấm công — trang tĩnh, 2 chế độ dữ liệu:
 *  - demo:   lưu localStorage trên máy, để thử nhanh (giờ lấy theo điện thoại).
 *  - sheets: gọi Google Apps Script (apps-script/Code.gs); máy chủ quyết định giờ và kiểm tra vị trí.
 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
  del(k) { localStorage.removeItem(k); },
};
const K = { mode: 'cc_mode', url: 'cc_api_url', session: 'cc_session', device: 'cc_device', demo: 'cc_demo', admin: 'cc_admin' };

// ===== Quy tắc chấm công — giống hệt phần "Quy tắc" trong apps-script/Code.gs =====
function toMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function fmtDist(m) {
  return m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(m) + ' m';
}
// Trễ khi HH:mm vào > hạn + ân hạn; số phút trễ tính từ hạn gốc (08:00).
function evalIn(hhmm, s) {
  const late = toMin(hhmm) - toMin(s.checkinDeadline);
  return late > Number(s.graceMinutes || 0) ? { status: 'Trễ', minutes: late } : { status: 'Đúng giờ', minutes: 0 };
}
// Về sớm khi HH:mm ra < giờ hết làm.
function evalOut(hhmm, s) {
  const early = toMin(s.checkoutTime) - toMin(hhmm);
  return early > 0 ? { status: 'Về sớm', minutes: early } : { status: 'Đúng giờ', minutes: 0 };
}
function checkLocation(loc, lat, lng, acc, maxAccuracy, locations) {
  const distance = Math.round(haversine(lat, lng, loc.lat, loc.lng));
  if (!isFinite(acc)) return { ok: false, distance, reason: 'Không đọc được độ chính xác GPS — hãy thử lại.' };
  if (acc > maxAccuracy) {
    return { ok: false, distance, reason: `GPS chưa đủ chính xác (sai số ±${Math.round(acc)} m, cho phép tối đa ${maxAccuracy} m). Bật Wi-Fi/định vị chính xác cao, ra chỗ thoáng rồi thử lại.` };
  }
  if (distance > loc.radius) {
    const near = locations.find(l => l.active && l.id !== loc.id && haversine(lat, lng, l.lat, l.lng) <= l.radius);
    return {
      ok: false, distance,
      reason: `Sai địa điểm: bạn đang cách "${loc.name}" ${fmtDist(distance)} (cho phép trong ${loc.radius} m).` +
        (near ? ` Bạn đang ở "${near.name}" — hãy chọn đúng địa điểm.` : ''),
    };
  }
  return { ok: true, distance };
}
// ===== Hết phần quy tắc =====

const pad = n => String(n).padStart(2, '0');
function nowParts(d = new Date()) {
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` };
}
const t5 = s => (s ? String(s).slice(0, 5) : '—');
const fmtDate = d => { const [y, m, dd] = String(d).split('-'); return dd ? `${dd}/${m}/${y}` : d; };
const fmtMin = m => (m >= 60 ? `${Math.floor(m / 60)} giờ ${m % 60} phút` : `${m} phút`);

function deviceId() {
  let id = store.get(K.device);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    store.set(K.device, id);
  }
  return id;
}

// ===== Backend Demo (localStorage) =====
const DEMO_SEED = () => ({
  settings: { checkinDeadline: '08:00', checkoutTime: '17:00', graceMinutes: 0, maxAccuracy: 100, adminPassword: 'admin123' },
  locations: [{ id: 'VP01', name: 'Văn phòng mẫu (Q1, TP.HCM)', lat: 10.776889, lng: 106.700806, radius: 100, active: true }],
  employees: [{ code: 'NV01', name: 'Nguyễn Văn A', pin: '1234', active: true }],
  attendance: [],
  log: [],
});

const demo = {
  db() { return store.get(K.demo) || DEMO_SEED(); },
  save(db) { db.log = db.log.slice(-2000); store.set(K.demo, db); },
  auth(db, code, pin) {
    const e = db.employees.find(x => x.code.toUpperCase() === String(code || '').trim().toUpperCase());
    if (!e || e.pin !== String(pin || '').trim()) throw new Error('Sai Mã NV hoặc PIN');
    if (!e.active) throw new Error('Tài khoản đã bị khóa — liên hệ quản lý');
    return e;
  },
  async config() {
    const db = this.db();
    return { settings: db.settings, locations: db.locations.filter(l => l.active), serverTime: Date.now() };
  },
  async login({ code, pin }) {
    const db = this.db();
    const e = this.auth(db, code, pin);
    const today = db.attendance.find(r => r.date === nowParts().date && r.code === e.code) || null;
    return { employee: { code: e.code, name: e.name }, today };
  },
  async punch(req) {
    const db = this.db();
    const { date, time } = nowParts();
    const type = req.type === 'out' ? 'out' : 'in';
    const ctx = { time: `${date} ${time}`, code: String(req.code || '').toUpperCase(), type: type === 'in' ? 'Check-in' : 'Check-out', loc: '', distance: '', accuracy: Math.round(req.accuracy), gps: `${req.lat},${req.lng}` };
    const reject = reason => { db.log.push({ ...ctx, result: 'TỪ CHỐI', reason }); this.save(db); return { accepted: false, reason }; };

    let emp;
    try { emp = this.auth(db, req.code, req.pin); } catch (e) { return reject(e.message); }
    ctx.code = emp.code;
    const loc = db.locations.find(l => l.id === req.locationId && l.active);
    if (!loc) return reject('Địa điểm không hợp lệ hoặc đã ngừng hoạt động');
    ctx.loc = loc.name;
    const chk = checkLocation(loc, req.lat, req.lng, req.accuracy, db.settings.maxAccuracy, db.locations);
    ctx.distance = chk.distance;
    if (!chk.ok) return reject(chk.reason);

    let rec = db.attendance.find(r => r.date === date && r.code === emp.code);
    const hhmm = time.slice(0, 5);
    let ev;
    if (type === 'in') {
      if (rec?.inTime) return reject(`Bạn đã check-in hôm nay lúc ${t5(rec.inTime)}`);
      ev = evalIn(hhmm, db.settings);
      rec = { date, code: emp.code, name: emp.name, inLoc: loc.name, inTime: time, inStatus: ev.status, lateMin: ev.minutes, inDist: chk.distance, inGps: ctx.gps, outLoc: '', outTime: '', outStatus: '', earlyMin: '', outDist: '', outGps: '' };
      db.attendance.push(rec);
    } else {
      if (!rec?.inTime) return reject('Bạn chưa check-in hôm nay');
      ev = evalOut(hhmm, db.settings);
      Object.assign(rec, { outLoc: loc.name, outTime: time, outStatus: ev.status, earlyMin: ev.minutes, outDist: chk.distance, outGps: ctx.gps });
    }
    db.log.push({ ...ctx, result: 'CHẤP NHẬN', reason: ev.status + (ev.minutes ? ` ${ev.minutes} phút` : '') });
    this.save(db);
    return { accepted: true, type, time, status: ev.status, minutes: ev.minutes, distance: chk.distance, locName: loc.name, today: rec };
  },
  async history({ code, pin }) {
    const db = this.db();
    const e = this.auth(db, code, pin);
    return { rows: db.attendance.filter(r => r.code === e.code).slice(-62).reverse() };
  },
  async report({ adminPassword, from, to }) {
    const db = this.db();
    if (adminPassword !== db.settings.adminPassword) throw new Error('Sai mật khẩu quản lý');
    const inRange = d => d >= from && d <= to;
    return {
      rows: db.attendance.filter(r => inRange(r.date)),
      employees: db.employees.filter(e => e.active).map(({ code, name }) => ({ code, name })),
      rejects: db.log.filter(l => l.result === 'TỪ CHỐI' && inRange(l.time.slice(0, 10))),
    };
  },
};

// ===== Backend Google Sheets (Apps Script) =====
const remote = {
  async call(action, payload = {}) {
    const url = store.get(K.url, '');
    if (!url) throw new Error('Chưa nhập link Google Apps Script (tab Cài đặt).');
    let res;
    try {
      // text/plain để không bị CORS preflight — Apps Script không hỗ trợ OPTIONS.
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, deviceId: deviceId(), ...payload }) });
    } catch {
      throw new Error('Không kết nối được máy chủ. Kiểm tra mạng, hoặc link Apps Script phải triển khai quyền "Bất kỳ ai".');
    }
    let data;
    try { data = await res.json(); } catch { throw new Error('Máy chủ trả dữ liệu lạ — kiểm tra link phải kết thúc bằng /exec và quyền "Bất kỳ ai".'); }
    if (!data.ok) throw new Error(data.error || 'Lỗi máy chủ');
    return data;
  },
  config() { return this.call('config'); },
  login(p) { return this.call('login', p); },
  punch(p) { return this.call('punch', p); },
  history(p) { return this.call('history', p); },
  report(p) { return this.call('report', p); },
};

const mode = () => store.get(K.mode, 'demo');
const api = () => (mode() === 'sheets' ? remote : demo);

// ===== Trạng thái & tiện ích giao diện =====
const state = { config: null, session: store.get(K.session, null), today: null, pos: null, watchId: null, clockOffset: 0, manualLoc: false, report: null };

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 2600);
}
function showResult(kind, html) {
  const el = $('#result');
  el.className = 'result ' + kind; el.innerHTML = html; el.hidden = false;
}
function badge(status, min) {
  if (!status) return '';
  const cls = status === 'Đúng giờ' ? 'ok' : 'warn';
  return `<span class="pill ${cls}">${esc(status)}${Number(min) ? ' ' + Number(min) + 'p' : ''}</span>`;
}
function table(el, headers, rows) {
  el.innerHTML = `<thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map(r => `<tr>${r.join('')}</tr>`).join('')}</tbody>`;
}
const td = (v, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${v}</td>`;
const kpi = (label, value, cls = '') => `<div class="kpi ${cls}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
}

// ===== Tabs =====
function showTab(name) {
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'history') loadHistory();
  if (name === 'admin') renderAdmin();
  if (name === 'settings') renderSettings();
}
$('#nav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });

// ===== Cấu hình & đồng hồ =====
async function loadConfig() {
  try {
    const c = await api().config();
    state.config = c;
    state.clockOffset = mode() === 'sheets' ? c.serverTime - Date.now() : 0;
    renderRules(); renderLocations();
  } catch (e) {
    state.config = null;
    showResult('bad', '❌ ' + esc(e.message));
    toast(e.message);
  }
}

function renderRules() {
  const s = state.config?.settings;
  if (!s) return;
  $('#rules').textContent = `Hạn check-in ${s.checkinDeadline}${Number(s.graceMinutes) ? ` (ân hạn ${s.graceMinutes} phút)` : ''} · Giờ hết làm ${s.checkoutTime}`;
}

function nowInTz() {
  const tz = state.config?.settings?.timezone;
  const now = new Date(Date.now() + state.clockOffset);
  const opt = tz ? { timeZone: tz } : {};
  try {
    return {
      time: new Intl.DateTimeFormat('en-GB', { ...opt, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now),
      date: new Intl.DateTimeFormat('en-CA', { ...opt, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now),
      label: new Intl.DateTimeFormat('vi-VN', { ...opt, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(now),
    };
  } catch {
    const p = nowParts(now);
    return { time: p.time, date: p.date, label: fmtDate(p.date) };
  }
}

function tick() {
  if ($('#punchArea').hidden) return;
  const n = nowInTz();
  $('#clock').textContent = n.time;
  $('#clockDate').textContent = n.label;
  if (state.today && state.today.date !== n.date) { state.today = null; renderToday(); }
  const s = state.config?.settings;
  if (!s) return;
  const cur = toMin(n.time.slice(0, 5));
  const t = state.today;
  let hint;
  if (!t?.inTime) {
    const d = toMin(s.checkinDeadline) - cur;
    hint = d >= 0 ? `Còn ${fmtMin(d)} đến hạn check-in ${s.checkinDeadline}` : `Đã quá hạn check-in ${s.checkinDeadline} ${fmtMin(-d)}`;
  } else if (!t.outTime) {
    const d = toMin(s.checkoutTime) - cur;
    hint = d > 0 ? `Còn ${fmtMin(d)} đến giờ về ${s.checkoutTime}` : 'Đã đến giờ về — nhớ check-out';
  } else {
    hint = 'Bạn đã hoàn tất chấm công hôm nay 👍';
  }
  $('#timeHint').textContent = hint;
}
setInterval(tick, 1000);

// ===== Đăng nhập =====
const creds = () => ({ code: state.session?.code, pin: state.session?.pin });

function renderAuth() {
  const logged = !!state.session;
  $('#loginCard').hidden = logged;
  $('#punchArea').hidden = !logged;
  $('#loginHint').textContent = mode() === 'demo' ? 'Chế độ Demo: thử với Mã NV01 / PIN 1234.' : 'Nhập Mã NV và PIN do quản lý cấp.';
  if (logged) {
    $('#empName').textContent = state.session.name;
    $('#empCode').textContent = `(${state.session.code})`;
    $('#btnDemoLoc').hidden = mode() !== 'demo';
    renderToday(); startWatch(); tick();
  }
}

async function doLogin(code, pin, silent) {
  try {
    const r = await api().login({ code, pin });
    state.session = { code: r.employee.code, name: r.employee.name, pin };
    store.set(K.session, state.session);
    state.today = r.today;
    renderAuth();
  } catch (e) {
    // Lỗi mạng: giữ phiên để thử lại; lỗi tài khoản (sai PIN, bị khóa, khác máy): đăng xuất.
    if (silent && /kết nối|máy chủ/i.test(e.message)) { showResult('bad', '❌ ' + esc(e.message)); return; }
    if (silent) logout();
    toast(e.message);
  }
}

$('#btnLogin').addEventListener('click', async () => {
  const code = $('#code').value.trim(), pin = $('#pin').value.trim();
  if (!code || !pin) return toast('Nhập Mã NV và PIN');
  $('#btnLogin').disabled = true;
  await doLogin(code, pin);
  $('#btnLogin').disabled = false;
});
$('#pin').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnLogin').click(); });

function logout() {
  state.session = null; state.today = null;
  store.del(K.session);
  $('#result').hidden = true;
  renderAuth();
}
$('#btnLogout').addEventListener('click', logout);

// ===== Hôm nay =====
function renderToday() {
  const t = state.today;
  $('#inTime').textContent = t5(t?.inTime);
  $('#outTime').textContent = t5(t?.outTime);
  $('#inBadge').innerHTML = badge(t?.inStatus, t?.lateMin);
  $('#outBadge').innerHTML = badge(t?.outStatus, t?.earlyMin);
  $('#btnIn').disabled = !!t?.inTime;
  $('#btnOut').disabled = !t?.inTime;
  $('#btnOut').textContent = t?.outTime ? 'CHECK-OUT LẠI' : 'CHECK-OUT';
}

// ===== GPS =====
function geoErrMsg(err) {
  if (err.code === 1) return 'Bạn đã chặn quyền vị trí. Vào cài đặt trình duyệt → cho phép Vị trí cho trang này rồi tải lại.';
  if (err.code === 3) return 'Định vị quá lâu. Bật GPS/Wi-Fi và thử lại.';
  return 'Không xác định được vị trí — hãy bật định vị (GPS) trên điện thoại.';
}
function onPos(p) {
  state.pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() };
  renderLocations();
}
function startWatch() {
  if (!navigator.geolocation) { $('#gpsStatus').textContent = 'Trình duyệt không hỗ trợ định vị'; return; }
  if (state.watchId != null) return;
  state.watchId = navigator.geolocation.watchPosition(onPos, err => { $('#gpsStatus').textContent = geoErrMsg(err); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
function freshPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Trình duyệt không hỗ trợ định vị'));
    navigator.geolocation.getCurrentPosition(p => { onPos(p); resolve(state.pos); }, e => reject(new Error(geoErrMsg(e))),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  });
}
// Dùng vị trí theo dõi nếu mới ≤ 10 giây; nếu không thì lấy vị trí mới, lỗi thì lùi về vị trí ≤ 30 giây.
async function positionForPunch() {
  if (state.pos && Date.now() - state.pos.at < 10000) return state.pos;
  try { return await freshPosition(); } catch (e) {
    if (state.pos && Date.now() - state.pos.at < 30000) return state.pos;
    throw e;
  }
}
$('#btnRefreshGps').addEventListener('click', () => {
  $('#gpsStatus').textContent = 'Đang định vị…';
  freshPosition().catch(e => { $('#gpsStatus').textContent = e.message; });
});

function renderLocations() {
  const sel = $('#loc');
  const locs = state.config?.locations || [];
  const pos = state.pos;
  const prev = sel.value;
  if (!locs.length) {
    sel.innerHTML = '<option value="">— Chưa có địa điểm —</option>';
  } else {
    const items = locs.map(l => ({ l, d: pos ? haversine(pos.lat, pos.lng, l.lat, l.lng) : null }));
    sel.innerHTML = '<option value="">— Chọn địa điểm —</option>' + items.map(({ l, d }) => {
      const tag = d == null ? '' : d <= l.radius ? ` — ${fmtDist(d)} ✓` : ` — cách ${fmtDist(d)}`;
      return `<option value="${esc(l.id)}">${esc(l.name)}${tag}</option>`;
    }).join('');
    if (prev && locs.some(l => l.id === prev)) sel.value = prev;
    // Gợi ý địa điểm gần nhất nằm trong bán kính nếu người dùng chưa tự chọn.
    if (!state.manualLoc && pos) {
      const inside = items.filter(x => x.d <= x.l.radius).sort((a, b) => a.d - b.d)[0];
      if (inside) sel.value = inside.l.id;
    }
  }
  if (pos) {
    const s = state.config?.settings;
    const poor = s && pos.accuracy > s.maxAccuracy;
    $('#gpsStatus').innerHTML = `Vị trí của bạn: sai số ±${Math.round(pos.accuracy)} m` + (poor ? ' <span class="pill bad">chưa đủ chính xác</span>' : '');
  }
}
$('#loc').addEventListener('change', () => { state.manualLoc = true; });

$('#btnDemoLoc').addEventListener('click', async () => {
  try {
    const p = await freshPosition();
    const db = demo.db();
    const id = 'DD' + Date.now().toString(36).toUpperCase();
    db.locations.push({ id, name: `Vị trí demo ${db.locations.length + 1}`, lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6), radius: 100, active: true });
    demo.save(db);
    await loadConfig();
    $('#loc').value = id;
    toast('Đã thêm địa điểm demo tại vị trí hiện tại (bán kính 100 m)');
  } catch (e) { toast(e.message); }
});

// ===== Chấm công =====
async function punch(type) {
  const locationId = $('#loc').value;
  if (!locationId) return showResult('bad', 'Hãy chọn địa điểm chấm công.');
  $('#btnIn').disabled = $('#btnOut').disabled = true;
  showResult('info', '📡 Đang lấy vị trí GPS…');
  try {
    const pos = await positionForPunch();
    showResult('info', '⏳ Đang gửi chấm công…');
    const r = await api().punch({ ...creds(), type, locationId, lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy });
    if (!r.accepted) {
      showResult('bad', `❌ <b>Không chấp nhận.</b> ${esc(r.reason)}`);
    } else {
      state.today = r.today;
      const label = type === 'in' ? 'Check-in' : 'Check-out';
      const st = r.status + (r.minutes ? ` ${r.minutes} phút` : '');
      showResult(r.minutes ? 'warn' : 'ok', `${r.minutes ? '⚠️' : '✅'} <b>${label} lúc ${t5(r.time)}</b> tại ${esc(r.locName)} (cách ${fmtDist(r.distance)}) — <b>${esc(st)}</b>`);
    }
  } catch (e) {
    showResult('bad', '❌ ' + esc(e.message));
  } finally {
    renderToday(); tick();
  }
}
$('#btnIn').addEventListener('click', () => punch('in'));
$('#btnOut').addEventListener('click', () => punch('out'));

// ===== Lịch sử =====
async function loadHistory() {
  const tbl = $('#histTable'), msg = $('#histMsg');
  if (!state.session) { tbl.innerHTML = ''; $('#histSummary').innerHTML = ''; msg.textContent = 'Đăng nhập ở tab Chấm công để xem lịch sử.'; return; }
  msg.textContent = 'Đang tải…';
  try {
    const { rows } = await api().history(creds());
    const month = nowInTz().date.slice(0, 7), today = nowInTz().date;
    const m = rows.filter(r => r.date.startsWith(month));
    const late = m.filter(r => r.inStatus === 'Trễ');
    const early = m.filter(r => r.outStatus === 'Về sớm');
    const sum = (arr, k) => arr.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    $('#histSummary').innerHTML = kpi('Ngày công', m.length, 'ok') +
      kpi('Lần trễ', late.length, late.length ? 'warn' : '') + kpi('Phút trễ', sum(late, 'lateMin'), late.length ? 'warn' : '') +
      kpi('Lần về sớm', early.length, early.length ? 'warn' : '') +
      kpi('Quên check-out', m.filter(r => !r.outTime && r.date < today).length);
    table(tbl, ['Ngày', 'Vào', '', 'Ra', ''], rows.map(r => [
      td(fmtDate(r.date)), td(t5(r.inTime)), td(badge(r.inStatus, r.lateMin)), td(t5(r.outTime)), td(badge(r.outStatus, r.earlyMin)),
    ]));
    msg.textContent = rows.length ? '' : 'Chưa có dữ liệu chấm công.';
  } catch (e) { msg.textContent = '❌ ' + e.message; }
}

// ===== Quản lý =====
const adminPass = () => sessionStorage.getItem(K.admin);

function renderAdmin() {
  const logged = !!adminPass();
  $('#adminLogin').hidden = logged;
  $('#adminArea').hidden = !logged;
  $('#adminHint').textContent = mode() === 'demo' ? 'Chế độ Demo: mật khẩu mặc định admin123.' : 'Mật khẩu nằm ở trang CauHinh (adminPassword) của Google Sheet.';
  $('#demoManage').hidden = mode() !== 'demo';
  $('#sheetsManage').hidden = mode() !== 'sheets';
  if (!logged) return;
  if (!$('#rFrom').value) setRange('today');
  if (mode() === 'demo') renderDemoManage();
  if (!state.report) loadReport();
}

$('#btnAdminLogin').addEventListener('click', async () => {
  const pw = $('#adminPass').value;
  if (!pw) return toast('Nhập mật khẩu');
  const d = nowInTz().date;
  try {
    await api().report({ adminPassword: pw, from: d, to: d });
    sessionStorage.setItem(K.admin, pw);
    $('#adminPass').value = '';
    state.report = null;
    renderAdmin();
  } catch (e) { toast(e.message); }
});
$('#adminPass').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnAdminLogin').click(); });
$('#btnAdminLogout').addEventListener('click', () => { sessionStorage.removeItem(K.admin); state.report = null; renderAdmin(); });

function setRange(kind) {
  const d = nowInTz().date;
  $('#rTo').value = d;
  $('#rFrom').value = kind === 'month' ? d.slice(0, 8) + '01' : d;
}
$$('[data-range]').forEach(b => b.addEventListener('click', () => { setRange(b.dataset.range); loadReport(); }));
$('#btnReport').addEventListener('click', loadReport);

async function loadReport() {
  const from = $('#rFrom').value, to = $('#rTo').value;
  if (!from || !to || from > to) return toast('Khoảng ngày không hợp lệ');
  $('#reportMsg').textContent = 'Đang tải…';
  try {
    const data = await api().report({ adminPassword: adminPass(), from, to });
    state.report = { ...data, from, to };
    renderReport();
    $('#reportMsg').textContent = '';
  } catch (e) {
    $('#reportMsg').textContent = '❌ ' + e.message;
    if (/mật khẩu/i.test(e.message)) { sessionStorage.removeItem(K.admin); renderAdmin(); }
  }
}

function renderReport() {
  const { rows, employees, rejects, from, to } = state.report;
  const n = v => Number(v) || 0;
  const late = rows.filter(r => r.inStatus === 'Trễ');
  const early = rows.filter(r => r.outStatus === 'Về sớm');
  const singleDay = from === to;
  const present = new Set(rows.map(r => String(r.code).toUpperCase()));
  const absent = employees.filter(e => !present.has(String(e.code).toUpperCase()));

  $('#kpis').innerHTML =
    kpi('Lượt chấm công', rows.length) +
    kpi('Vào đúng giờ', rows.length - late.length, 'ok') +
    kpi(`Trễ (${late.reduce((a, r) => a + n(r.lateMin), 0)} phút)`, late.length, late.length ? 'warn' : '') +
    kpi(`Về sớm (${early.reduce((a, r) => a + n(r.earlyMin), 0)} phút)`, early.length, early.length ? 'warn' : '') +
    kpi('Chưa/thiếu check-out', rows.filter(r => !r.outTime).length) +
    (singleDay ? kpi('Chưa check-in', absent.length, absent.length ? 'bad' : '') : '') +
    kpi('Lượt bị từ chối', rejects.length, rejects.length ? 'bad' : '');

  // Tổng hợp theo nhân viên
  const by = new Map(employees.map(e => [String(e.code).toUpperCase(), { code: e.code, name: e.name, days: 0, late: 0, lateMin: 0, early: 0, earlyMin: 0, noOut: 0, rej: 0 }]));
  const get = (code, name) => {
    const k = String(code).toUpperCase();
    if (!by.has(k)) by.set(k, { code, name: name || '', days: 0, late: 0, lateMin: 0, early: 0, earlyMin: 0, noOut: 0, rej: 0 });
    return by.get(k);
  };
  rows.forEach(r => {
    const s = get(r.code, r.name);
    s.days++;
    if (r.inStatus === 'Trễ') { s.late++; s.lateMin += n(r.lateMin); }
    if (r.outStatus === 'Về sớm') { s.early++; s.earlyMin += n(r.earlyMin); }
    if (!r.outTime) s.noOut++;
  });
  rejects.forEach(r => { if (r.code) get(r.code).rej++; });
  const list = [...by.values()].sort((a, b) => b.lateMin + b.earlyMin - (a.lateMin + a.earlyMin) || String(a.code).localeCompare(String(b.code)));
  table($('#tblEmp'), ['Mã', 'Họ tên', 'Ngày công', 'Trễ', 'Phút trễ', 'Về sớm', 'Phút sớm', 'Thiếu ra', 'Bị từ chối'],
    list.map(s => [td(esc(s.code)), td(esc(s.name)), td(s.days), td(s.late), td(s.lateMin), td(s.early), td(s.earlyMin), td(s.noOut), td(s.rej)]));

  $('#absentBox').hidden = !singleDay;
  $('#absentList').textContent = absent.length ? absent.map(e => `${e.code} – ${e.name}`).join(', ') : 'Tất cả nhân viên đã check-in.';

  table($('#tblDetail'), ['Ngày', 'Mã', 'Họ tên', 'Vào', 'TT vào', 'Ra', 'TT ra', 'Địa điểm'],
    rows.slice().reverse().map(r => [
      td(fmtDate(r.date)), td(esc(r.code)), td(esc(r.name)), td(t5(r.inTime)), td(badge(r.inStatus, r.lateMin)),
      td(t5(r.outTime)), td(badge(r.outStatus, r.earlyMin)), td(esc(r.inLoc + (r.outLoc && r.outLoc !== r.inLoc ? ' → ' + r.outLoc : ''))),
    ]));

  table($('#tblReject'), ['Thời gian', 'Mã', 'Loại', 'Địa điểm', 'Cách', 'Lý do'],
    rejects.slice(-100).reverse().map(r => [
      td(esc(r.time)), td(esc(r.code)), td(esc(r.type)), td(esc(r.loc)), td(r.distance === '' || r.distance == null ? '' : esc(fmtDist(Number(r.distance)))), td(esc(r.reason), 'wrap'),
    ]));
}

$('#btnCsv').addEventListener('click', () => {
  if (!state.report) return toast('Hãy xem báo cáo trước');
  const head = ['Ngày', 'Mã NV', 'Họ tên', 'Địa điểm vào', 'Giờ vào', 'TT vào', 'Trễ (phút)', 'Cách (m) vào', 'Địa điểm ra', 'Giờ ra', 'TT ra', 'Về sớm (phút)', 'Cách (m) ra'];
  const keys = ['date', 'code', 'name', 'inLoc', 'inTime', 'inStatus', 'lateMin', 'inDist', 'outLoc', 'outTime', 'outStatus', 'earlyMin', 'outDist'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [head.map(q).join(','), ...state.report.rows.map(r => keys.map(k => q(r[k])).join(','))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `cham-cong_${state.report.from}_${state.report.to}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ----- Quản lý dữ liệu Demo -----
function renderDemoManage() {
  const db = demo.db();
  $('#sIn').value = db.settings.checkinDeadline;
  $('#sOut').value = db.settings.checkoutTime;
  $('#sGrace').value = db.settings.graceMinutes;
  $('#sAcc').value = db.settings.maxAccuracy;
  $('#sPass').value = db.settings.adminPassword;
  table($('#tblLoc'), ['Tên', 'Tọa độ', 'Bán kính', ''], db.locations.map(l => [
    td(esc(l.name)), td(`${l.lat}, ${l.lng}`), td(l.radius + ' m'), td(`<button class="link" data-del-loc="${esc(l.id)}">Xóa</button>`),
  ]));
  table($('#tblEmpList'), ['Mã', 'Họ tên', 'PIN', ''], db.employees.map(e => [
    td(esc(e.code)), td(esc(e.name)), td(esc(e.pin)), td(`<button class="link" data-del-emp="${esc(e.code)}">Xóa</button>`),
  ]));
}

function updateDemo(fn) {
  const db = demo.db();
  fn(db);
  demo.save(db);
  renderDemoManage();
  loadConfig();
}

$('#btnSaveSettings').addEventListener('click', () => {
  const s = { checkinDeadline: $('#sIn').value, checkoutTime: $('#sOut').value, graceMinutes: Math.max(0, Number($('#sGrace').value) || 0), maxAccuracy: Math.max(10, Number($('#sAcc').value) || 100), adminPassword: $('#sPass').value.trim() };
  if (!/^\d{2}:\d{2}$/.test(s.checkinDeadline) || !/^\d{2}:\d{2}$/.test(s.checkoutTime)) return toast('Giờ không hợp lệ');
  if (!s.adminPassword) return toast('Mật khẩu quản lý không được để trống');
  updateDemo(db => { db.settings = s; });
  sessionStorage.setItem(K.admin, s.adminPassword);
  toast('Đã lưu quy định');
});

$('#btnLocHere').addEventListener('click', async () => {
  try {
    const p = await freshPosition();
    $('#lLat').value = p.lat.toFixed(6); $('#lLng').value = p.lng.toFixed(6);
    toast(`Đã lấy tọa độ (sai số ±${Math.round(p.accuracy)} m)`);
  } catch (e) { toast(e.message); }
});

$('#btnAddLoc').addEventListener('click', () => {
  const name = $('#lName').value.trim();
  const lat = parseFloat($('#lLat').value.replace(',', '.')), lng = parseFloat($('#lLng').value.replace(',', '.'));
  const radius = Number($('#lRadius').value) || 100;
  if (!name) return toast('Nhập tên địa điểm');
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) return toast('Tọa độ không hợp lệ');
  updateDemo(db => db.locations.push({ id: 'DD' + Date.now().toString(36).toUpperCase(), name, lat, lng, radius: Math.max(20, radius), active: true }));
  $('#lName').value = $('#lLat').value = $('#lLng').value = '';
  toast('Đã thêm địa điểm');
});

$('#btnAddEmp').addEventListener('click', () => {
  const code = $('#eCode').value.trim().toUpperCase(), name = $('#eName').value.trim(), pin = $('#ePin').value.trim();
  if (!code || !name || !pin) return toast('Nhập đủ Mã NV, Họ tên, PIN');
  if (demo.db().employees.some(e => e.code === code)) return toast('Mã NV đã tồn tại');
  updateDemo(db => db.employees.push({ code, name, pin, active: true }));
  $('#eCode').value = $('#eName').value = $('#ePin').value = '';
  toast('Đã thêm nhân viên');
});

$('#demoManage').addEventListener('click', e => {
  const loc = e.target.dataset.delLoc, emp = e.target.dataset.delEmp;
  if (loc && confirm('Xóa địa điểm này?')) updateDemo(db => { db.locations = db.locations.filter(l => l.id !== loc); });
  if (emp && confirm(`Xóa nhân viên ${emp}? (dữ liệu chấm công cũ vẫn giữ)`)) updateDemo(db => { db.employees = db.employees.filter(x => x.code !== emp); });
});

$('#btnResetDemo').addEventListener('click', () => {
  if (!confirm('Xóa toàn bộ dữ liệu demo trên máy này?')) return;
  store.del(K.demo);
  sessionStorage.removeItem(K.admin);
  state.report = null;
  logout(); loadConfig(); renderAdmin();
  toast('Đã xóa dữ liệu demo');
});

$('#btnCoord').addEventListener('click', async () => {
  $('#coordOut').textContent = 'Đang định vị…';
  try {
    const p = await freshPosition();
    const lat = p.lat.toFixed(6), lng = p.lng.toFixed(6);
    $('#coordOut').innerHTML = `Vĩ độ <code>${lat}</code> · Kinh độ <code>${lng}</code> (sai số ±${Math.round(p.accuracy)} m) — <button class="link" id="btnCopyCoord">copy</button>`;
    $('#btnCopyCoord').onclick = () => copyText(`${lat}\t${lng}`).then(() => toast('Đã copy — dán vào ô Vĩ độ, Kinh độ tự tràn sang cột bên'));
  } catch (e) { $('#coordOut').textContent = e.message; }
});

// ===== Cài đặt =====
function renderSettings() {
  $$('input[name=mode]').forEach(r => { r.checked = r.value === mode(); });
  $('#sheetsBox').hidden = mode() !== 'sheets';
  $('#apiUrl').value = store.get(K.url, '');
  $('#devId').textContent = deviceId();
}

function applyMode(m) {
  if (m === mode()) return;
  store.set(K.mode, m);
  sessionStorage.removeItem(K.admin);
  state.report = null; state.config = null;
  logout();
  $('#modeBadge').textContent = m === 'sheets' ? 'Google Sheets' : 'Demo';
  renderSettings();
  if (m === 'demo' || store.get(K.url, '')) loadConfig();
}
$$('input[name=mode]').forEach(r => r.addEventListener('change', () => applyMode(r.value)));

$('#btnSaveUrl').addEventListener('click', async () => {
  const url = $('#apiUrl').value.trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
    $('#connStatus').textContent = '❌ Link phải có dạng https://script.google.com/macros/s/…/exec';
    return;
  }
  store.set(K.url, url);
  $('#connStatus').textContent = 'Đang kiểm tra…';
  try {
    const c = await remote.config();
    $('#connStatus').textContent = `✅ Kết nối thành công — ${c.locations.length} địa điểm, hạn check-in ${c.settings.checkinDeadline}, hết giờ ${c.settings.checkoutTime}.`;
    await loadConfig();
  } catch (e) { $('#connStatus').textContent = '❌ ' + e.message; }
});

$('#btnShareLink').addEventListener('click', () => {
  const url = store.get(K.url, '');
  if (!url) return toast('Lưu link Apps Script trước');
  const link = location.origin + location.pathname + '?api=' + encodeURIComponent(url);
  copyText(link).then(() => toast('Đã copy link — gửi cho nhân viên qua Zalo/Email'));
});

$('#btnCopyCode').addEventListener('click', async () => {
  try {
    const res = await fetch('apps-script/Code.gs', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    await copyText(await res.text());
    toast('Đã copy mã Apps Script');
  } catch { toast('Không tải được mã — bấm "xem mã" rồi copy thủ công'); }
});

// ===== Khởi động =====
(function init() {
  // Link nhân viên dạng ?api=<url /exec> → tự chuyển sang chế độ Google Sheets.
  const qApi = new URLSearchParams(location.search).get('api');
  if (qApi && /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(qApi)) {
    if (store.get(K.url, '') !== qApi || mode() !== 'sheets') store.del(K.session);
    store.set(K.url, qApi);
    store.set(K.mode, 'sheets');
    state.session = store.get(K.session, null);
    history.replaceState(null, '', location.pathname);
  }
  $('#modeBadge').textContent = mode() === 'sheets' ? 'Google Sheets' : 'Demo';
  renderAuth();
  if (mode() === 'sheets' && !store.get(K.url, '')) {
    showTab('settings');
    return;
  }
  loadConfig().then(() => { if (state.session) doLogin(state.session.code, state.session.pin, true); });
})();
