import * as fb from './lib/graph.js?v=7';
import { analyzePrompt, writePrompt, parseAnswer } from './lib/prompts.js?v=7';
import { makeSlideshow } from './lib/video.js?v=7';
import { PROVIDERS } from './lib/ai.js?v=7';

// ================= Trạng thái =================
const S = {
  token: null,        // user token
  expiresAt: null,    // ms; 0 = không hết hạn; null = không rõ
  user: null,
  pages: [],          // có access_token của Page — giữ trong localStorage tới khi bấm Thoát
  overview: null,
  targets: new Set(),
  analyzeSel: new Set(),
  texts: {},
  media: null,        // { file: Blob, name, url, type }
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('vi-VN'));
const fmtDate = (d) => (d ? new Date(d).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '–');
const pic = (p) => p.picture?.data?.url || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageById = (id) => S.pages.find((p) => p.id === id);
const postable = (id) => { const p = pageById(id); return !!p && fb.canPost(p); };

// Lưu trữ an toàn (có thể bị chặn ở chế độ ẩn danh).
const store = {
  get(area, k, d) { try { return JSON.parse(window[area].getItem(k)) ?? d; } catch { return d; } },
  set(area, k, v) { try { window[area].setItem(k, JSON.stringify(v)); } catch { /* bỏ qua */ } },
  del(area, k) { try { window[area].removeItem(k); } catch { /* bỏ qua */ } },
};

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ''), 4000);
}

function fatal(msg) {
  $('#fatal').textContent = msg;
  $('#fatal').classList.toggle('hidden', !msg);
}

async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); } catch (e) { toast(fb.explain(e), true); } finally { btn.disabled = false; btn.textContent = old; }
}

const requireLogin = () => {
  if (!S.token) throw new Error('Chưa kết nối Facebook (tab 1)');
};

// Phiên lưu trên máy đã hết hạn / bị thu hồi → xoá và báo kết nối lại.
function sessionExpired() {
  clearSession();
  Object.assign(S, { token: null, expiresAt: null, user: null, pages: [] });
  renderWho();
  renderChips();
  renderEditors();
  fatal('Phiên đăng nhập Facebook đã hết hạn hoặc bị thu hồi — hãy bấm "Đăng nhập với Facebook" ở tab 1.');
  autoLogin();
}

// Tự đăng nhập khi mở trang (không cần bấm) — bỏ qua nếu người dùng vừa bấm Thoát.
async function autoLogin() {
  const appId = $('#appId').value.trim();
  if (autoLogin.running || S.token || store.get('localStorage', 'loggedOut', false)) return;
  if (!/^\d{5,}$/.test(appId) || location.protocol !== 'https:') return;
  autoLogin.running = true;
  try {
    const r = await fb.silentLogin(appId);
    if (r && !S.token) await connect(r.token, r.expiresAt);
  } catch { /* không tự đăng nhập được → người dùng bấm nút */ } finally {
    autoLogin.running = false;
  }
}

// ================= Điều hướng =================
$('#nav').addEventListener('click', (e) => {
  const tab = e.target.dataset.tab;
  if (!tab) return;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b === e.target));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${tab}`));
  if (tab === 'history') renderHistory();
});

// ================= 1. Kết nối =================
$('#scopes').innerHTML = fb.SCOPES.map((s) => `<code>${s}</code>`).join(' ');
$('#domainHint').textContent = location.hostname || 'tên miền của trang';
$('#domainHint2').textContent = location.origin;
// App ID gắn sẵn cho trang này (mã công khai, không phải bí mật) — để trống thì dùng App ID nhập ở "Cài đặt App".
const DEFAULT_APP_ID = '1882486536464902';
$('#appId').value = store.get('localStorage', 'fbAppId', '') || DEFAULT_APP_ID;
$('#appSettings').open = !$('#appId').value;
$('#configId').value = store.get('localStorage', 'fbConfigId', '');

// Tải sẵn Facebook SDK khi đã có App ID, để cửa sổ đăng nhập không bị trình duyệt chặn.
function preloadSdk() {
  const appId = $('#appId').value.trim();
  if (/^\d{5,}$/.test(appId) && location.protocol === 'https:') fb.loadSdk(appId).catch(() => {});
}
$('#appId').addEventListener('change', preloadSdk);
preloadSdk();

const SESSION = 'session';
const saveSession = () => store.set('localStorage', SESSION, { token: S.token, expiresAt: S.expiresAt, user: S.user, pages: S.pages, missing: S.missing });
const clearSession = () => { store.del('localStorage', SESSION); store.del('sessionStorage', SESSION); };

async function connect(token, expiresAt) {
  const appId = $('#appId').value.trim();
  const secret = $('#appSecret').value.trim();
  if (secret) {
    if (!/^\d{5,}$/.test(appId)) throw new Error('Nhập Facebook App ID (Cách 1) để đổi sang token dài hạn');
    ({ token, expiresAt } = await fb.exchangeLongLived(appId, secret, token));
    $('#appSecret').value = '';
  }
  const user = await fb.me(token);
  const pages = await fb.listPages(token);
  if (secret || expiresAt == null) expiresAt = (await fb.tokenExpiry(token)) ?? expiresAt;
  const missing = await fb.missingScopes(token).catch(() => []);
  Object.assign(S, { token, expiresAt, user, pages, missing });
  store.del('localStorage', 'loggedOut');
  S.targets = new Set([...S.targets].filter(postable));
  saveSession();
  renderWho();
  renderChips();
  renderEditors();
  fatal('');
  toast(`Đã kết nối ${pages.length} Page`);
}

function expiryText() {
  if (S.expiresAt === 0) return 'Phiên đăng nhập không hết hạn.';
  if (!S.expiresAt) return 'Không rõ thời hạn token.';
  const left = S.expiresAt - Date.now();
  const when = left > 864e5 ? `còn ${Math.floor(left / 864e5)} ngày` : `còn ${Math.max(1, Math.round(left / 6e4))} phút`;
  return `Phiên đăng nhập hết hạn lúc ${fmtDate(S.expiresAt)} (${when}).${left < 3 * 3600e3 ? ' Nhập App Secret rồi kết nối lại để giữ đăng nhập ~60 ngày.' : ''}`;
}

function permWarning() {
  const blocked = S.pages.filter((p) => !fb.canPost(p)).length;
  return [
    S.missing?.length ? `<div class="warn">Chưa cấp quyền: ${S.missing.map((m) => `<code>${esc(m)}</code>`).join(' ')} — sẽ không đăng bài được. Bấm kết nối lại và tick đủ quyền.</div>` : '',
    blocked ? `<div class="warn">${blocked} Page bạn không có vai trò tạo nội dung — đã ẩn khỏi danh sách đăng bài.</div>` : '',
  ].join('');
}

function renderWho() {
  const u = S.user;
  $('#who').innerHTML = u
    ? `${u.picture?.data?.url ? `<img src="${esc(u.picture.data.url)}" alt="">` : ''}${esc(u.name)} · ${S.pages.length} Page <button class="btn sm" id="btnLogout">Thoát</button>`
    : '<span>Chưa kết nối</span>';
  $('#connectState').innerHTML = u
    ? `✅ Đã kết nối tài khoản <b>${esc(u.name)}</b> — quản lý <b>${S.pages.length}</b> Page.${S.pages.length ? '' : ' <span class="warn">Không thấy Page nào: kiểm tra lại quyền pages_show_list / business_management.</span>'}${permWarning()}<div class="small muted">${esc(expiryText())}</div>`
    : '<span class="muted">Chưa kết nối.</span>';
  $('#btnLogout')?.addEventListener('click', () => {
    clearSession();
    store.set('localStorage', 'loggedOut', true);
    location.reload();
  });
}

$('#btnToken').addEventListener('click', (e) => busy(e.target, 'Đang kết nối…', async () => {
  const token = $('#tokenInput').value.trim();
  if (!token) throw new Error('Dán Access Token vào ô trước');
  await connect(token);
  $('#tokenInput').value = '';
}));

$('#btnFbLogin').addEventListener('click', (e) => busy(e.target, 'Đang mở Facebook…', async () => {
  const appId = $('#appId').value.trim();
  const configId = $('#configId').value.trim();
  if (!/^\d{5,}$/.test(appId)) throw new Error('Nhập Facebook App ID (dãy số) trước');
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
    throw new Error('Đăng nhập Facebook chỉ chạy trên trang https:// — hãy mở bằng link GitHub Pages, hoặc dùng Cách 2.');
  }
  store.set('localStorage', 'fbAppId', appId);
  store.set('localStorage', 'fbConfigId', configId);
  try {
    const { token, expiresAt } = await fb.sdkLogin(appId, configId);
    await connect(token, expiresAt);
  } catch (err) {
    fatal(`Đăng nhập Facebook thất bại: ${fb.explain(err)}\nKiểm tra mục "Cần cài đặt gì trong Facebook App?" ở trên, hoặc dùng Cách 2 — dán Access Token.`);
    throw err;
  }
}));

// ================= 2. Tổng quan =================
function stats(posts) {
  const since = Date.now() - 30 * 864e5;
  const recent = posts.filter((p) => new Date(p.created_time).getTime() >= since);
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, p) => s + p.engagement, 0) / arr.length) : 0);
  const byType = {};
  for (const p of posts) (byType[p.type || 'khác'] ??= []).push(p);
  const byHour = {};
  for (const p of posts) (byHour[new Date(p.created_time).getHours()] ??= []).push(p);
  const bestHour = Object.entries(byHour).filter(([, v]) => v.length >= 2).sort((a, b) => avg(b[1]) - avg(a[1]))[0];
  return {
    posts30d: recent.length,
    avgEngagement: avg(posts),
    avgEngagement30d: avg(recent),
    lastPost: posts[0]?.created_time || null,
    byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { count: v.length, avg: avg(v) }])),
    bestHour: bestHour ? Number(bestHour[0]) : null,
  };
}

async function loadPage(page, limit) {
  try {
    const posts = (await fb.pagePosts(page.id, page.access_token, limit)).map(fb.normalizePost);
    return { ...page, posts, stats: stats(posts) };
  } catch (e) {
    return { ...page, posts: [], stats: null, error: fb.explain(e) };
  }
}

async function loadPages(pages, limit) {
  const out = [];
  for (let i = 0; i < pages.length; i += 5) {
    out.push(...await Promise.all(pages.slice(i, i + 5).map((p) => loadPage(p, limit))));
  }
  return out;
}

$('#btnRefreshPages').addEventListener('click', (e) => busy(e.target, 'Đang đồng bộ…', async () => {
  requireLogin();
  await connect(S.token, S.expiresAt);
}));

$('#btnOverview').addEventListener('click', (e) => busy(e.target, 'Đang quét…', async () => {
  requireLogin();
  S.overview = { pages: await loadPages(S.pages, Number($('#postLimit').value)) };
  renderOverview();
}));

function renderOverview() {
  const pages = S.overview.pages;
  const ok = pages.filter((p) => p.stats);
  const sum = (f) => ok.reduce((s, p) => s + (f(p) || 0), 0);
  const inactive = ok.filter((p) => !p.stats.lastPost || Date.now() - new Date(p.stats.lastPost) > 14 * 864e5).length;
  $('#kpis').innerHTML = [
    ['Tổng Page', pages.length],
    ['Tổng followers', fmt(sum((p) => p.followers_count ?? p.fan_count))],
    ['Bài đăng 30 ngày', fmt(sum((p) => p.stats.posts30d))],
    ['TB tương tác/bài', fmt(ok.length ? Math.round(sum((p) => p.stats.avgEngagement) / ok.length) : 0)],
    ['Page >14 ngày chưa đăng', inactive],
    ['Page lỗi quyền', pages.length - ok.length],
  ].map(([k, v]) => `<div class="kpi"><b>${v}</b><span>${k}</span></div>`).join('');

  const rows = [...pages].sort((a, b) => (b.stats?.avgEngagement30d || 0) - (a.stats?.avgEngagement30d || 0));
  $('#pageTable tbody').innerHTML = rows.map((p) => `
    <tr>
      <td><div class="pg">${pic(p) ? `<img src="${esc(pic(p))}" alt="">` : ''}<a href="${esc(p.link || '#')}" target="_blank" rel="noopener">${esc(p.name)}</a></div></td>
      <td>${esc(p.category || '')}</td>
      <td class="num">${fmt(p.followers_count ?? p.fan_count)}</td>
      ${p.stats ? `
        <td class="num">${p.stats.posts30d}</td>
        <td class="num">${fmt(p.stats.avgEngagement)}</td>
        <td class="num">${fmt(p.stats.avgEngagement30d)}</td>
        <td>${p.stats.bestHour != null ? `${p.stats.bestHour}h` : '–'}</td>
        <td>${fmtDate(p.stats.lastPost)}</td>
        <td><button class="btn sm" data-detail="${p.id}">Xem bài</button></td>`
      : `<td colspan="6"><span class="badge err">${esc(p.error)}</span></td>`}
    </tr>`).join('');
}

$('#pageTable').addEventListener('click', (e) => {
  const id = e.target.dataset.detail;
  if (!id) return;
  const p = S.overview.pages.find((x) => x.id === id);
  const types = Object.entries(p.stats.byType).map(([k, v]) => `<span class="badge">${esc(k)}: ${v.count} bài · TB ${fmt(v.avg)}</span>`).join(' ');
  $('#postDetail').innerHTML = `
    <div class="card">
      <div class="row between"><h3>${esc(p.name)} — ${p.posts.length} bài gần nhất</h3><span>${types}</span></div>
      <div class="posts">${p.posts.map((x) => `
        <div class="post">
          ${x.picture ? `<img src="${esc(x.picture)}" alt="" loading="lazy">` : ''}
          <div class="muted small">${fmtDate(x.created_time)} · ${esc(x.type || '')}</div>
          <div class="msg">${esc(x.message) || '<i class="muted">(không có chữ)</i>'}</div>
          <div class="small">👍 ${fmt(x.reactions)} · 💬 ${fmt(x.comments)} · ↗ ${fmt(x.shares)} · <a href="${esc(x.permalink_url)}" target="_blank" rel="noopener">Mở</a></div>
        </div>`).join('')}</div>
    </div>`;
  $('#postDetail').scrollIntoView({ behavior: 'smooth' });
});

// ================= Copy prompt → Claude =================
document.addEventListener('click', async (e) => {
  const id = e.target.dataset?.copy;
  if (!id) return;
  const text = $(`#${id}`).value;
  try {
    await navigator.clipboard.writeText(text);
    toast(`Đã copy prompt — dán (Ctrl+V) vào ${provider().label.split(' ')[0]}`);
  } catch {
    $(`#${id}`).select();
    toast('Hãy bấm Ctrl+C để copy prompt', true);
  }
  window.open(provider().chat, '_blank', 'noopener');
});

// ================= 3. Phân tích AI =================
$('#btnAnalyzePrompt').addEventListener('click', (e) => busy(e.target, 'Đang quét dữ liệu…', async () => {
  requireLogin();
  const ids = S.analyzeSel.size ? [...S.analyzeSel] : S.pages.map((p) => p.id);
  const pages = (await loadPages(ids.map(pageById).filter(Boolean), 25)).filter((p) => !p.error);
  if (!pages.length) throw new Error('Không đọc được dữ liệu Page nào (kiểm tra quyền)');
  $('#analyzePrompt').value = analyzePrompt(pages);
  $('#analyzeFlow').classList.remove('hidden');
  $('#analyzeFlow').scrollIntoView({ behavior: 'smooth' });
}));

$('#btnAnalyzeShow').addEventListener('click', () => {
  try {
    renderAnalysis(parseAnswer($('#analyzeAnswer').value, 'summary'));
  } catch (err) {
    toast(err.message, true);
  }
});

function renderAnalysis(r) {
  const name = (id) => pageById(id)?.name || id;
  const ideas = r.content_ideas || [];
  $('#analysis').innerHTML = `
    <div class="card"><h3>Tổng quan</h3><p>${esc(r.summary)}</p></div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Page</th><th>Chủ đề chính</th><th>Giọng văn</th><th>Đang hiệu quả</th><th>Cần cải thiện</th></tr></thead>
      <tbody>${(r.pages || []).map((p) => `<tr><td><b>${esc(name(p.page_id))}</b></td><td>${(p.topics || []).map((t) => `<span class="badge">${esc(t)}</span>`).join(' ')}</td>
        <td>${esc(p.tone)}</td><td>${esc(p.what_works)}</td><td>${esc(p.what_to_improve)}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="card"><h3>Ý tưởng nội dung</h3>${ideas.map((i, k) => `
      <div class="idea"><b>${esc(i.title)}</b> <span class="badge">${esc(i.format)}</span>
        <div class="small muted">${esc(i.why)} — Page: ${(i.target_page_ids || []).map((id) => esc(name(id))).join(', ')}</div>
        <button class="btn sm" data-idea="${k}">Dùng ý tưởng này →</button></div>`).join('')}</div>`;
  $('#analysis').onclick = (ev) => {
    const k = ev.target.dataset.idea;
    if (k == null) return;
    const idea = ideas[k];
    $('#topic').value = `${idea.title}\n${idea.why}`;
    S.targets = new Set((idea.target_page_ids || []).filter(postable));
    const kind = ['text', 'link', 'photo', 'video'].includes(idea.format) ? idea.format : 'text';
    $(`input[name=kind][value=${kind}]`).checked = true;
    syncKind();
    renderChips();
    renderEditors();
    $('[data-tab=compose]').click();
  };
}

// ================= 4. Soạn & đăng =================
const chip = (p, on, attr) => `<span class="chip ${on ? 'on' : ''}" data-${attr}="${p.id}">${pic(p) ? `<img src="${esc(pic(p))}" alt="">` : ''}${esc(p.name)}</span>`;

function renderChips() {
  const f = $('#pageFilter').value.toLowerCase();
  $('#targetPages').innerHTML = S.pages
    .filter((p) => fb.canPost(p) && (!f || `${p.name} ${p.category}`.toLowerCase().includes(f)))
    .map((p) => chip(p, S.targets.has(p.id), 'target')).join('') || '<span class="muted">Chưa có Page — hãy kết nối ở tab 1.</span>';
  $('#analyzePages').innerHTML = S.pages.map((p) => chip(p, S.analyzeSel.has(p.id), 'an')).join('') || '<span class="muted">Chưa có Page.</span>';
  $('#btnPublish').textContent = `🚀 Đăng lên ${S.targets.size} Page`;
}

$('#targetPages').addEventListener('click', (e) => {
  const id = e.target.closest('[data-target]')?.dataset.target;
  if (!id) return;
  S.targets.has(id) ? S.targets.delete(id) : S.targets.add(id);
  renderChips();
  renderEditors();
});
$('#analyzePages').addEventListener('click', (e) => {
  const id = e.target.closest('[data-an]')?.dataset.an;
  if (!id) return;
  S.analyzeSel.has(id) ? S.analyzeSel.delete(id) : S.analyzeSel.add(id);
  renderChips();
});
$('#pageFilter').addEventListener('input', renderChips);
$('#selAll').addEventListener('click', () => {
  const f = $('#pageFilter').value.toLowerCase();
  S.pages.filter((p) => fb.canPost(p) && (!f || `${p.name} ${p.category}`.toLowerCase().includes(f))).forEach((p) => S.targets.add(p.id));
  renderChips();
  renderEditors();
});
$('#selNone').addEventListener('click', () => { S.targets.clear(); renderChips(); renderEditors(); });

function renderEditors() {
  const sel = S.pages.filter((p) => S.targets.has(p.id));
  if (!sel.length) {
    $('#editors').innerHTML = '<p class="muted">Chọn Page ở bước ① để soạn nội dung.</p>';
    return;
  }
  $('#editors').innerHTML = sel.map((p) => `
    <div class="editor">
      <div class="meta"><b>${esc(p.name)}</b><span data-count="${p.id}">${(S.texts[p.id] || '').length} ký tự</span></div>
      <textarea data-text="${p.id}" placeholder="Nội dung cho ${esc(p.name)}…">${esc(S.texts[p.id] || '')}</textarea>
    </div>`).join('');
}

$('#editors').addEventListener('input', (e) => {
  const id = e.target.dataset.text;
  if (!id) return;
  S.texts[id] = e.target.value;
  $(`[data-count="${id}"]`).textContent = `${e.target.value.length} ký tự`;
});

$('#btnSameText').addEventListener('click', () => {
  const first = [...S.targets].map((id) => S.texts[id]).find(Boolean);
  if (!first) return toast('Hãy viết nội dung cho ít nhất 1 Page trước', true);
  S.targets.forEach((id) => (S.texts[id] = first));
  renderEditors();
});

async function buildWritePrompt() {
  requireLogin();
  if (!$('#topic').value.trim()) throw new Error('Nhập chủ đề / thông tin bài viết');
  const pages = [...S.targets].map(pageById).filter(Boolean);
  if (!pages.length) throw new Error('Chọn Page ở bước ① trước');
  // Lấy vài bài cũ làm mẫu giọng văn cho từng Page.
  const withSamples = await Promise.all(pages.map(async (p) => {
    const posts = await fb.pagePosts(p.id, p.access_token, 5).catch(() => []);
    return { ...p, samples: posts.map((x) => (x.message || '').slice(0, 300)).filter(Boolean).slice(0, 3) };
  }));
  $('#writePrompt').value = writePrompt({
    topic: $('#topic').value, goal: $('#goal').value, tone: $('#tone').value,
    length: $('#length').value, cta: $('#cta').value, link: $('#link').value, pages: withSamples,
  });
  $('#writeFlow').classList.remove('hidden');
}

$('#btnWritePrompt').addEventListener('click', (e) => busy(e.target, 'Đang chuẩn bị…', buildWritePrompt));

// Khớp kết quả với Page: theo page_id, nếu không có thì theo tên Page.
const norm = (s = '') => String(s).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
function matchPage(v) {
  const byId = pageById(String(v.page_id ?? '').trim());
  if (byId) return byId;
  const name = norm(v.page_name || v.name);
  return name ? S.pages.find((p) => norm(p.name) === name) || S.pages.find((p) => norm(p.name).includes(name) || name.includes(norm(p.name))) : null;
}

function applyWrite() {
  const r = parseAnswer($('#writeAnswer').value, 'variants');
  const variants = r.variants || [];
  // Chỉ 1 Page được chọn và 1 phiên bản → dùng luôn dù không khớp id/tên.
  const only = S.targets.size === 1 && variants.length === 1 ? pageById([...S.targets][0]) : null;
  let n = 0;
  for (const v of variants) {
    const p = matchPage(v) || only;
    if (!p || !postable(p.id)) continue;
    S.targets.add(p.id);
    const tags = (v.hashtags || []).map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ');
    S.texts[p.id] = `${(v.message || '').trim()}\n\n${tags}`.trim();
    n++;
  }
  if (r.video_slides?.length) $('#vTexts').value = r.video_slides.join('\n');
  if (r.headline) $('#vTitle').value = r.headline;
  renderChips();
  renderEditors();
  if (!n) throw new Error('Kết quả không có bài nào khớp với Page đã chọn — hãy tạo prompt mới (nút ✨) rồi gửi lại cho Claude.');
  toast(`Đã điền nội dung cho ${n} Page — hãy đọc lại trước khi đăng`);
  $('#editors').scrollIntoView({ behavior: 'smooth' });
}

$('#btnWriteApply').addEventListener('click', () => {
  try { applyWrite(); } catch (err) { toast(err.message, true); }
});

// ================= AI viết trực tiếp (Gemini hoặc Claude, key riêng của người dùng) =================
const provider = () => PROVIDERS[store.get('localStorage', 'aiProvider', 'gemini')] || PROVIDERS.gemini;
const aiKey = () => store.get('localStorage', provider().keyName, '');
function syncAiBox() {
  const pv = provider();
  $$('.aiProvider').forEach((s) => (s.value = store.get('localStorage', 'aiProvider', 'gemini')));
  $$('.aiKey').forEach((i) => { i.value = aiKey(); i.placeholder = pv.placeholder; });
  $$('.aiHelp').forEach((h) => (h.textContent = pv.help));
}
syncAiBox();
document.addEventListener('change', (e) => {
  if (!e.target.classList?.contains('aiProvider')) return;
  store.set('localStorage', 'aiProvider', e.target.value);
  syncAiBox();
});
document.addEventListener('input', (e) => {
  if (!e.target.classList?.contains('aiKey')) return;
  const v = e.target.value.trim();
  v ? store.set('localStorage', provider().keyName, v) : store.del('localStorage', provider().keyName);
  $$('.aiKey').forEach((i) => i !== e.target && (i.value = v));
});
document.addEventListener('click', (e) => {
  if (!e.target.classList?.contains('aiKeyClear')) return;
  store.del('localStorage', provider().keyName);
  syncAiBox();
  toast('Đã xoá API key khỏi máy này');
});

async function runAi(btn, promptId, answerId, then, prepare) {
  const key = aiKey();
  if (!key) {
    btn.closest('.card').querySelector('details.aiBox').open = true;
    return toast(`Chọn AI và dán ${provider().label} API key vào ô bên dưới trước (có hướng dẫn lấy key)`, true);
  }
  await busy(btn, '🤖 AI đang viết… (10-60 giây)', async () => {
    if (prepare) await prepare();
    $(`#${answerId}`).value = await provider().ask(key, $(`#${promptId}`).value);
    then();
  });
}
$('#btnWriteAi').addEventListener('click', (e) => runAi(e.target, 'writePrompt', 'writeAnswer', applyWrite, buildWritePrompt));
$('#btnAnalyzeAi').addEventListener('click', (e) => runAi(e.target, 'analyzePrompt', 'analyzeAnswer',
  () => renderAnalysis(parseAnswer($('#analyzeAnswer').value, 'summary'))));

// Loại media
function syncKind() {
  const k = $('input[name=kind]:checked').value;
  ['link', 'photo', 'video'].forEach((x) => $(`#kind-${x}`).classList.toggle('hidden', x !== k));
  const src = $('input[name=vsrc]:checked').value;
  $('#vsrc-upload').classList.toggle('hidden', src !== 'upload');
  $('#vsrc-make').classList.toggle('hidden', src !== 'make');
}
$$('input[name=kind], input[name=vsrc]').forEach((r) => r.addEventListener('change', () => {
  setMedia(null);
  syncKind();
}));

function setMedia(m) {
  if (S.media?.url) URL.revokeObjectURL(S.media.url);
  S.media = m;
  $('#mediaPreview').innerHTML = !m ? '' : m.type.startsWith('video')
    ? `<video src="${esc(m.url)}" controls></video><div><a class="btn sm" href="${esc(m.url)}" download="${esc(m.name)}">⬇ Tải video về máy</a></div>`
    : `<img src="${esc(m.url)}" alt="">`;
}

const fromFile = (f) => f && setMedia({ file: f, name: f.name, type: f.type, url: URL.createObjectURL(f) });
$('#photoFile').addEventListener('change', (e) => fromFile(e.target.files[0]));
$('#videoFile').addEventListener('change', (e) => fromFile(e.target.files[0]));

$('#btnMakeVideo').addEventListener('click', (e) => busy(e.target, 'Đang dựng video…', async () => {
  const texts = $('#vTexts').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const images = $('#vImages').files;
  if (!texts.length && !images.length) throw new Error('Cần ít nhất ảnh hoặc chữ cho video');
  const r = await makeSlideshow({
    images, texts, audio: $('#vAudio').files[0], format: $('#vFormat').value,
    seconds: $('#vSeconds').value, bgColor: $('#vBg').value,
    onProgress: (p) => (e.target.textContent = `Đang dựng video… ${Math.round(p * 100)}%`),
  });
  setMedia({ file: r.blob, name: `video.${r.ext}`, type: r.blob.type, url: URL.createObjectURL(r.blob) });
  toast(`Đã tạo video ${r.seconds}s`);
}));

$('#schedOn').addEventListener('change', (e) => ($('#schedAt').disabled = !e.target.checked));

// ĐĂNG 1 CLICK
$('#btnPublish').addEventListener('click', (e) => {
  if (!S.token) return toast('Chưa kết nối Facebook (tab 1)', true);
  const kind = $('input[name=kind]:checked').value;
  const ids = [...S.targets];
  if (!ids.length) return toast('Chưa chọn Page nào', true);
  const empty = ids.filter((id) => !(S.texts[id] || '').trim());
  if (empty.length && kind !== 'photo' && kind !== 'video') return toast(`${empty.length} Page chưa có nội dung`, true);
  if ((kind === 'photo' || kind === 'video') && !S.media) return toast('Chưa có ảnh/video', true);
  if (kind === 'link' && !$('#link').value) return toast('Chưa nhập link', true);
  const scheduledAt = $('#schedOn').checked && $('#schedAt').value ? new Date($('#schedAt').value).toISOString() : null;
  if (scheduledAt) {
    const diff = new Date(scheduledAt) - Date.now();
    if (!(diff >= 10 * 60e3 && diff <= 30 * 864e5)) return toast('Lịch đăng phải cách hiện tại từ 10 phút đến 30 ngày', true);
  }
  if (!confirm(`${scheduledAt ? 'Hẹn đăng' : 'Đăng ngay'} lên ${ids.length} Page?`)) return;

  busy(e.target, `Đang đăng… (${ids.length} Page)`, async () => {
    // Kiểm tra phiên trước khi đăng, tránh mọi Page cùng lỗi token.
    try {
      await fb.me(S.token);
    } catch (err) {
      if (err.code === 190 || err.code === 102) sessionExpired();
      throw err;
    }
    const post = (page) => fb.publish({
      pageId: page.id, pageToken: page.access_token, kind, message: S.texts[page.id] || '', link: $('#link').value,
      file: S.media?.file, fileName: S.media?.name, title: $('#vTitle').value, scheduledAt,
    });
    const why = (err) => fb.explain(err) + (scheduledAt && err.code === 100 ? ' Lưu ý: lịch đăng phải cách hiện tại 10 phút – 30 ngày.' : '');
    const results = [];
    let stopped = null;
    for (const [i, pageId] of ids.entries()) {
      const page = pageById(pageId);
      if (stopped) {
        results.push({ pageId, pageName: page.name, ok: false, error: `Chưa đăng — đã dừng vì: ${stopped}` });
        continue;
      }
      e.target.textContent = `Đang đăng ${i + 1}/${ids.length}: ${page.name}`;
      try {
        let r;
        try {
          r = await post(page);
        } catch (err) {
          if (fb.errorAction(err) !== 'retry') throw err;
          e.target.textContent = `Thử lại ${i + 1}/${ids.length}: ${page.name}`;
          await sleep(8000);
          r = await post(page);
        }
        results.push({ pageId, pageName: page.name, ok: true, postId: r.postId });
      } catch (err) {
        results.push({ pageId, pageName: page.name, ok: false, error: why(err) });
        if (fb.errorAction(err) === 'stop') {
          stopped = fb.explain(err);
          continue;
        }
      }
      if (i < ids.length - 1) await sleep(3000); // giãn cách để tránh bị đánh dấu spam
    }
    const ok = results.filter((x) => x.ok).length;
    $('#publishResult').innerHTML = `<div class="result"><b>Thành công ${ok}/${results.length}</b>${results.map((x) => `
      <div>${x.ok ? '<span class="badge ok">OK</span>' : '<span class="badge err">Lỗi</span>'} ${esc(x.pageName)}
      ${x.ok ? `<span class="muted small">${esc(x.postId)}</span>` : `— ${esc(x.error)}`}</div>`).join('')}</div>`;
    const history = store.get('localStorage', 'history', []);
    history.unshift({ at: new Date().toISOString(), kind, scheduledAt, preview: (S.texts[ids[0]] || '').slice(0, 160), results });
    store.set('localStorage', 'history', history.slice(0, 300));
    toast(`Đăng xong: ${ok}/${results.length} Page`, ok < results.length);
  });
});

// ================= 5. Lịch sử =================
function renderHistory() {
  const h = store.get('localStorage', 'history', []);
  $('#historyList').innerHTML = h.length ? `<div class="card table-wrap"><table>
    <thead><tr><th>Thời gian</th><th>Loại</th><th>Nội dung</th><th>Kết quả</th></tr></thead>
    <tbody>${h.map((x) => `<tr>
      <td>${fmtDate(x.at)}${x.scheduledAt ? `<div class="small muted">Hẹn: ${fmtDate(x.scheduledAt)}</div>` : ''}</td>
      <td><span class="badge">${esc(x.kind)}</span></td>
      <td class="small">${esc(x.preview)}</td>
      <td>${x.results.map((r) => `<div class="small">${r.ok ? '✅' : '❌'} ${esc(r.pageName)}${r.ok ? '' : ` — ${esc(r.error)}`}</div>`).join('')}</td>
    </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Chưa có lịch sử.</p>';
}
$('#btnClearHistory').addEventListener('click', () => {
  if (!confirm('Xoá toàn bộ lịch sử trên trình duyệt này?')) return;
  store.del('localStorage', 'history');
  renderHistory();
});

// ================= Khởi động =================
syncKind();
const saved = store.get('localStorage', SESSION, null) || store.get('sessionStorage', SESSION, null);
if (saved?.token) {
  if (saved.expiresAt && saved.expiresAt < Date.now()) {
    sessionExpired();
  } else {
    Object.assign(S, saved);
    saveSession();
    store.del('sessionStorage', SESSION);
    renderWho();
    renderEditors();
    // Kiểm tra token còn sống; chỉ xoá phiên khi Facebook báo token không hợp lệ (190).
    fb.me(S.token).catch((e) => { if (e.code === 190) sessionExpired(); });
  }
}
renderChips();
if (!S.token) autoLogin();
if (location.protocol === 'file:') {
  fatal('Bạn đang mở file trực tiếp từ máy. Hãy mở bằng link GitHub Pages (https://…github.io/…/fbtool/) để web hoạt động đầy đủ.');
}
