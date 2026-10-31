/**
 * Máy chủ chấm công — Google Apps Script + Google Sheets.
 *
 * Cài đặt:
 *  1) Tạo Google Sheet mới → Tiện ích mở rộng → Apps Script → xóa mã mẫu, dán toàn bộ file này → Lưu.
 *  2) Chọn hàm "setup" trên thanh công cụ → Chạy (cấp quyền lần đầu). Sheet sẽ có 5 trang tính:
 *     CauHinh, DiaDiem, NhanVien, ChamCong, NhatKy.
 *  3) Triển khai → Tùy chọn triển khai mới → Loại: Ứng dụng web
 *     - Thực thi với tư cách: Tôi
 *     - Người có quyền truy cập: Bất kỳ ai
 *  4) Copy URL kết thúc bằng /exec → dán vào app (tab Cài đặt).
 *  Sửa mã sau này: Triển khai → Quản lý triển khai → Chỉnh sửa → Phiên bản mới.
 *
 * Giờ chấm công lấy theo đồng hồ MÁY CHỦ (không tin giờ trên điện thoại).
 */

const SHEETS = { config: 'CauHinh', locations: 'DiaDiem', employees: 'NhanVien', attendance: 'ChamCong', log: 'NhatKy' };

const ATT_HEADERS = ['Ngày', 'Mã NV', 'Họ tên', 'Địa điểm vào', 'Giờ vào', 'TT vào', 'Trễ (phút)', 'Cách (m) vào', 'GPS vào',
  'Địa điểm ra', 'Giờ ra', 'TT ra', 'Về sớm (phút)', 'Cách (m) ra', 'GPS ra'];
const ATT_KEYS = ['date', 'code', 'name', 'inLoc', 'inTime', 'inStatus', 'lateMin', 'inDist', 'inGps',
  'outLoc', 'outTime', 'outStatus', 'earlyMin', 'outDist', 'outGps'];
const LOG_HEADERS = ['Thời gian', 'Mã NV', 'Loại', 'Địa điểm', 'Kết quả', 'Lý do', 'Khoảng cách (m)', 'Sai số GPS (m)', 'GPS', 'Thiết bị'];

const DEFAULT_CONFIG = [
  ['checkinDeadline', '08:00', 'Hạn check-in. Sau giờ này = Trễ'],
  ['checkoutTime', '17:00', 'Giờ hết làm. Check-out trước giờ này = Về sớm'],
  ['graceMinutes', '0', 'Số phút ân hạn cho check-in (0 = không ân hạn)'],
  ['maxAccuracy', '100', 'Sai số GPS tối đa chấp nhận (mét)'],
  ['timezone', 'Asia/Ho_Chi_Minh', 'Múi giờ'],
  ['bindDevice', 'TRUE', 'TRUE = mỗi nhân viên chỉ chấm trên 1 điện thoại. Đổi máy: xóa ô "Thiết bị" ở trang NhanVien'],
  ['adminPassword', 'admin123', 'Mật khẩu xem báo cáo trong app — HÃY ĐỔI NGAY'],
];

// ===== Quy tắc chấm công — giống hệt phần "Quy tắc" trong app.js =====
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

function doGet() {
  return json_({ ok: true, message: 'API chấm công đang chạy' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Dữ liệu gửi lên không hợp lệ' });
  }
  try {
    const fn = ACTIONS[req.action];
    if (!fn) throw new Error('Hành động không hợp lệ: ' + req.action);
    return json_(Object.assign({ ok: true }, fn(req)));
  } catch (err) {
    return json_({ ok: false, error: err.message || String(err) });
  }
}

const ACTIONS = {
  config() {
    const cfg = getConfig_();
    return {
      settings: { checkinDeadline: cfg.checkinDeadline, checkoutTime: cfg.checkoutTime, graceMinutes: cfg.graceMinutes, maxAccuracy: cfg.maxAccuracy, timezone: cfg.timezone },
      locations: getLocations_().filter(l => l.active).map(l => ({ id: l.id, name: l.name, lat: l.lat, lng: l.lng, radius: l.radius })),
      serverTime: Date.now(),
    };
  },

  login(req) {
    return withLock_(() => {
      const cfg = getConfig_();
      const emp = auth_(req, cfg);
      const found = findTodayRow_(today_(cfg), emp.code);
      return { employee: emp, today: found ? found.obj : null };
    });
  },

  punch(req) {
    return withLock_(() => punch_(req));
  },

  history(req) {
    const cfg = getConfig_();
    const emp = auth_(req, cfg);
    const rows = allAttendance_().filter(r => norm_(r.code) === norm_(emp.code));
    return { rows: rows.slice(-62).reverse() };
  },

  report(req) {
    const cfg = getConfig_();
    if (!cfg.adminPassword || String(req.adminPassword || '') !== cfg.adminPassword) throw new Error('Sai mật khẩu quản lý');
    const from = String(req.from || ''), to = String(req.to || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('Ngày không hợp lệ');
    const rows = allAttendance_().filter(r => r.date >= from && r.date <= to);
    const employees = getEmployees_().filter(e => e.active).map(e => ({ code: e.code, name: e.name }));
    const logVals = sheet_(SHEETS.log).getDataRange().getDisplayValues().slice(1);
    const rejects = logVals
      .filter(r => r[4] === 'TỪ CHỐI' && r[0].slice(0, 10) >= from && r[0].slice(0, 10) <= to)
      .map(r => ({ time: r[0], code: r[1], type: r[2], loc: r[3], result: r[4], reason: r[5], distance: r[6], accuracy: r[7], gps: r[8] }));
    return { rows, employees, rejects };
  },
};

function punch_(req) {
  const cfg = getConfig_();
  const now = new Date();
  const date = Utilities.formatDate(now, cfg.timezone, 'yyyy-MM-dd');
  const time = Utilities.formatDate(now, cfg.timezone, 'HH:mm:ss');
  const type = req.type === 'out' ? 'out' : 'in';
  const lat = Number(req.lat), lng = Number(req.lng), acc = Number(req.accuracy);
  const ctx = {
    time: date + ' ' + time, code: String(req.code || '').trim(), type: type === 'in' ? 'Check-in' : 'Check-out',
    loc: '', distance: '', accuracy: isFinite(acc) ? Math.round(acc) : '', gps: lat + ',' + lng, device: String(req.deviceId || ''),
  };
  const reject = reason => {
    log_(ctx, 'TỪ CHỐI', reason);
    return { accepted: false, reason, distance: ctx.distance === '' ? null : ctx.distance };
  };

  let emp;
  try { emp = auth_(req, cfg); } catch (err) { return reject(err.message); }
  ctx.code = emp.code;

  const locations = getLocations_();
  const loc = locations.find(l => l.id === String(req.locationId) && l.active);
  if (!loc) return reject('Địa điểm không hợp lệ hoặc đã ngừng hoạt động');
  ctx.loc = loc.name;
  if (!isFinite(lat) || !isFinite(lng)) return reject('Không nhận được vị trí GPS');

  const chk = checkLocation(loc, lat, lng, acc, cfg.maxAccuracy, locations);
  ctx.distance = chk.distance;
  if (!chk.ok) return reject(chk.reason);

  const sh = sheet_(SHEETS.attendance);
  const found = findTodayRow_(date, emp.code);
  const hhmm = time.slice(0, 5);
  let ev, today;
  if (type === 'in') {
    if (found && found.obj.inTime) return reject('Bạn đã check-in hôm nay lúc ' + found.obj.inTime.slice(0, 5));
    ev = evalIn(hhmm, cfg);
    const row = [date, emp.code, emp.name, loc.name, time, ev.status, ev.minutes, chk.distance, ctx.gps, '', '', '', '', '', ''];
    sh.appendRow(row);
    today = rowToObj_(row);
  } else {
    if (!found || !found.obj.inTime) return reject('Bạn chưa check-in hôm nay');
    ev = evalOut(hhmm, cfg);
    const out = [loc.name, time, ev.status, ev.minutes, chk.distance, ctx.gps];
    sh.getRange(found.row, 10, 1, out.length).setValues([out]);
    today = Object.assign(found.obj, { outLoc: loc.name, outTime: time, outStatus: ev.status, earlyMin: ev.minutes, outDist: chk.distance, outGps: ctx.gps });
  }
  log_(ctx, 'CHẤP NHẬN', ev.status + (ev.minutes ? ' ' + ev.minutes + ' phút' : ''));
  return { accepted: true, type, time, status: ev.status, minutes: ev.minutes, distance: chk.distance, locName: loc.name, today };
}

// ----- Xác thực nhân viên -----
function auth_(req, cfg) {
  const code = norm_(req.code), pin = String(req.pin || '').trim();
  if (!code || !pin) throw new Error('Nhập Mã NV và PIN');
  const sh = sheet_(SHEETS.employees);
  const vals = sh.getDataRange().getDisplayValues();
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (norm_(r[0]) !== code) continue;
    if (String(r[2]).trim() !== pin) throw new Error('Sai Mã NV hoặc PIN');
    if (!isActive_(r[3])) throw new Error('Tài khoản đã bị khóa — liên hệ quản lý');
    if (cfg.bindDevice) {
      const dev = String(req.deviceId || '').trim();
      const bound = String(r[4] || '').trim();
      if (!dev) throw new Error('Thiếu mã thiết bị');
      if (!bound) sh.getRange(i + 1, 5).setValue(dev);
      else if (bound !== dev) throw new Error('Tài khoản đã gắn với điện thoại khác. Nếu bạn đổi máy, nhờ quản lý xóa ô "Thiết bị" của bạn.');
    }
    return { code: String(r[0]).trim(), name: String(r[1]).trim() };
  }
  throw new Error('Sai Mã NV hoặc PIN');
}

// ----- Đọc dữ liệu -----
function getConfig_() {
  const vals = sheet_(SHEETS.config).getDataRange().getDisplayValues();
  const map = {};
  vals.slice(1).forEach(r => { if (r[0]) map[String(r[0]).trim()] = String(r[1]).trim(); });
  return {
    checkinDeadline: hhmm_(map.checkinDeadline, '08:00'),
    checkoutTime: hhmm_(map.checkoutTime, '17:00'),
    graceMinutes: num_(map.graceMinutes, 0),
    maxAccuracy: num_(map.maxAccuracy, 100),
    timezone: map.timezone || 'Asia/Ho_Chi_Minh',
    bindDevice: isTrue_(map.bindDevice),
    adminPassword: map.adminPassword || '',
  };
}

function getLocations_() {
  return sheet_(SHEETS.locations).getDataRange().getValues().slice(1)
    .filter(r => String(r[0]).trim() !== '')
    .map(r => ({ id: String(r[0]).trim(), name: String(r[1]).trim(), lat: num_(r[2]), lng: num_(r[3]), radius: num_(r[4], 100), active: isActive_(r[5]) }))
    .filter(l => isFinite(l.lat) && isFinite(l.lng));
}

function getEmployees_() {
  return sheet_(SHEETS.employees).getDataRange().getDisplayValues().slice(1)
    .filter(r => String(r[0]).trim() !== '')
    .map(r => ({ code: String(r[0]).trim(), name: String(r[1]).trim(), active: isActive_(r[3]) }));
}

function allAttendance_() {
  return sheet_(SHEETS.attendance).getDataRange().getDisplayValues().slice(1)
    .filter(r => r[0] && r[1])
    .map(rowToObj_);
}

// Hàng chấm công hôm nay nằm ở cuối sheet → chỉ quét 1000 dòng cuối, từ dưới lên.
function findTodayRow_(date, code) {
  const sh = sheet_(SHEETS.attendance);
  const last = sh.getLastRow();
  if (last < 2) return null;
  const start = Math.max(2, last - 999);
  const vals = sh.getRange(start, 1, last - start + 1, ATT_HEADERS.length).getDisplayValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i][0] === date && norm_(vals[i][1]) === norm_(code)) return { row: start + i, obj: rowToObj_(vals[i]) };
  }
  return null;
}

function rowToObj_(r) {
  const o = {};
  ATT_KEYS.forEach((k, i) => { o[k] = r[i] === undefined ? '' : r[i]; });
  return o;
}

function log_(ctx, result, reason) {
  sheet_(SHEETS.log).appendRow([ctx.time, ctx.code, ctx.type, ctx.loc, result, reason, ctx.distance, ctx.accuracy, ctx.gps, ctx.device]);
}

// ----- Tiện ích -----
function today_(cfg) { return Utilities.formatDate(new Date(), cfg.timezone, 'yyyy-MM-dd'); }
function norm_(v) { return String(v || '').trim().toUpperCase(); }
function num_(v, def) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(',', '.'));
  return isFinite(n) ? n : def;
}
function hhmm_(v, def) {
  const m = String(v || '').match(/(\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : def;
}
function isTrue_(v) { return ['TRUE', 'ĐÚNG', '1', 'YES', 'CÓ', 'X'].indexOf(norm_(v)) >= 0; }
// Ô trống = đang hoạt động; chỉ khóa khi ghi rõ FALSE/SAI/0/KHÔNG.
function isActive_(v) { return v !== false && ['FALSE', 'SAI', '0', 'NO', 'KHÔNG', 'KHONG'].indexOf(norm_(v)) < 0; }
function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Thiếu trang tính "' + name + '" — hãy chạy hàm setup() trong Apps Script');
  return sh;
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ----- Chạy 1 lần để tạo các trang tính -----
function setup() {
  const ss = SpreadsheetApp.getActive();
  ensureSheet_(ss, SHEETS.config, ['Khóa', 'Giá trị', 'Ghi chú'], ['B'], DEFAULT_CONFIG);
  // Cột tọa độ để dạng văn bản: tránh Sheets tiếng Việt hiểu "10.776889" thành số 10776889.
  ensureSheet_(ss, SHEETS.locations, ['ID', 'Tên địa điểm', 'Vĩ độ (lat)', 'Kinh độ (lng)', 'Bán kính (m)', 'Hoạt động'], ['A', 'C', 'D'],
    [['VP01', 'Văn phòng chính (sửa lại tọa độ)', '10.776889', '106.700806', 100, true]]);
  ensureSheet_(ss, SHEETS.employees, ['Mã NV', 'Họ tên', 'PIN', 'Hoạt động', 'Thiết bị'], ['A', 'C', 'E'],
    [['NV01', 'Nguyễn Văn A', '1234', true, '']]);
  ensureSheet_(ss, SHEETS.attendance, ATT_HEADERS, ['A', 'E', 'I', 'K', 'O'], []);
  ensureSheet_(ss, SHEETS.log, LOG_HEADERS, ['A', 'I'], []);
}

function ensureSheet_(ss, name, headers, textCols, sample) {
  let sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  textCols.forEach(c => sh.getRange(c + ':' + c).setNumberFormat('@'));
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#d9f2ee');
  sh.setFrozenRows(1);
  if (sample.length) sh.getRange(2, 1, sample.length, sample[0].length).setValues(sample);
  sh.autoResizeColumns(1, headers.length);
  return sh;
}
