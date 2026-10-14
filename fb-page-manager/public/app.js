// ================= Trạng thái =================
const S = {
  status: null,
  pages: [],          // danh sách Page (không có token)
  overview: null,     // dữ liệu quét
  targets: new Set(), // Page được chọn để đăng
  analyzeSel: new Set(),
  texts: {},          // pageId -> nội dung
  media: null,        // { name, url, type }
  videoSlides: [],
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('vi-VN'));
const fmtDate = (d) => (d ? new Date(d).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '–');
const pic = (p) => p.picture?.data?.url || '';

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ''), 4000);
}

async function api(url, opts = {}) {
  const init = { ...opts };
  if (opts.json) {
    init.method = init.method || 'POST';
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi HTTP ${res.status}`);
  return data;
}

// Khoá nút trong khi chờ, hiện spinner chữ.
async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = old; }
}

// ================= Điều hướng =================
$('#nav').addEventListener('click', (e) => {
  const tab = e.target.dataset.tab;
  if (!tab) return;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b === e.target));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${tab}`));
  if (tab === 'history') loadHistory();
});

// ================= 1. Kết nối =================
async function loadStatus() {
  S.status = await api('/api/status');
  $('#scopes').innerHTML = S.status.scopes.map((s) => `<code>${s}</code>`).join(' ');
  $('#oauthHint').classList.toggle('hidden', S.status.oauth);
  $('#btnOauth').classList.toggle('hidden', !S.status.oauth);
  $('#redirectHint').classList.toggle('hidden', !S.status.oauth);
  $('#redirectHint').innerHTML = `Valid OAuth Redirect URI cần khai báo trong Facebook App: <code>${esc(S.status.redirectUri)}</code>`;
  const u = S.status.user;
  $('#who').innerHTML = u
    ? `${u.picture?.data?.url ? `<img src="${esc(u.picture.data.url)}" alt="">` : ''}${esc(u.name)} · ${S.status.pageCount} Page <button class="btn sm" id="btnLogout">Thoát</button>`
    : '<span>Chưa kết nối</span>';
  $('#btnLogout')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    location.reload();
  });
  $('#connectState').innerHTML = S.status.connected
    ? `✅ Đã kết nối tài khoản <b>${esc(u.name)}</b> — quản lý <b>${S.status.pageCount}</b> Page. ${S.status.ai ? '' : '<br><span class="warn">⚠ Chưa có ANTHROPIC_API_KEY: phần AI sẽ không hoạt động.</span>'}`
    : '<span class="muted">Chưa kết nối.</span>';
  if (S.status.connected) await refreshPages(false);
}

$('#btnToken').addEventListener('click', (e) => busy(e.target, 'Đang kết nối…', async () => {
  await api('/api/connect-token', { json: { token: $('#tokenInput').value } });
  $('#tokenInput').value = '';
  toast('Kết nối thành công');
  await loadStatus();
}));

function fatal(msg) {
  $('#fatal').textContent = msg;
  $('#fatal').classList.remove('hidden');
}

const qErr = new URLSearchParams(location.search).get('error');
if (qErr) {
  fatal(qErr);
  history.replaceState(null, '', '/');
}

// ================= 2. Tổng quan =================
async function refreshPages(remote = true) {
  S.pages = remote
    ? (await api('/api/pages/refresh', { method: 'POST' })).pages
    : (await api('/api/pages')).pages;
  renderChips();
  renderEditors();
}

$('#btnRefreshPages').addEventListener('click', (e) => busy(e.target, 'Đang đồng bộ…', async () => {
  await refreshPages(true);
  toast(`Đã đồng bộ ${S.pages.length} Page`);
}));

$('#btnOverview').addEventListener('click', (e) => busy(e.target, 'Đang quét…', async () => {
  S.overview = await api(`/api/overview?limit=${$('#postLimit').value}`);
  renderOverview();
}));

function renderOverview() {
  const pages = S.overview.pages;
  const ok = pages.filter((p) => p.stats);
  const sum = (f) => ok.reduce((s, p) => s + (f(p) || 0), 0);
  const posts30 = sum((p) => p.stats.posts30d);
  const inactive = ok.filter((p) => !p.stats.lastPost || Date.now() - new Date(p.stats.lastPost) > 14 * 864e5).length;
  $('#kpis').innerHTML = [
    ['Tổng Page', pages.length],
    ['Tổng followers', fmt(sum((p) => p.followers_count ?? p.fan_count))],
    ['Bài đăng 30 ngày', fmt(posts30)],
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

// ================= 3. Phân tích AI =================
$('#btnAnalyze').addEventListener('click', (e) => busy(e.target, 'AI đang phân tích (1-2 phút)…', async () => {
  const r = await api('/api/ai/analyze', { json: { pageIds: [...S.analyzeSel] } });
  const name = (id) => S.pages.find((p) => p.id === id)?.name || id;
  $('#analysis').innerHTML = `
    <div class="card"><h3>Tổng quan</h3><p>${esc(r.summary)}</p></div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Page</th><th>Chủ đề chính</th><th>Giọng văn</th><th>Đang hiệu quả</th><th>Cần cải thiện</th></tr></thead>
      <tbody>${r.pages.map((p) => `<tr><td><b>${esc(name(p.page_id))}</b></td><td>${p.topics.map((t) => `<span class="badge">${esc(t)}</span>`).join(' ')}</td>
        <td>${esc(p.tone)}</td><td>${esc(p.what_works)}</td><td>${esc(p.what_to_improve)}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="card"><h3>Ý tưởng nội dung</h3>${r.content_ideas.map((i, k) => `
      <div class="idea"><b>${esc(i.title)}</b> <span class="badge">${esc(i.format)}</span>
        <div class="small muted">${esc(i.why)} — Page: ${i.target_page_ids.map((id) => esc(name(id))).join(', ')}</div>
        <button class="btn sm" data-idea="${k}">Dùng ý tưởng này →</button></div>`).join('')}</div>`;
  $('#analysis').onclick = (ev) => {
    const k = ev.target.dataset.idea;
    if (k == null) return;
    const idea = r.content_ideas[k];
    $('#topic').value = `${idea.title}\n${idea.why}`;
    S.targets = new Set(idea.target_page_ids.filter((id) => S.pages.some((p) => p.id === id)));
    const kind = ['text', 'link', 'photo', 'video'].includes(idea.format) ? idea.format : 'text';
    $(`input[name=kind][value=${kind}]`).checked = true;
    syncKind();
    renderChips();
    renderEditors();
    $('[data-tab=compose]').click();
  };
}));

// ================= 4. Soạn & đăng =================
function chip(p, on, attr) {
  return `<span class="chip ${on ? 'on' : ''}" data-${attr}="${p.id}">${pic(p) ? `<img src="${esc(pic(p))}" alt="">` : ''}${esc(p.name)}</span>`;
}

function renderChips() {
  const f = $('#pageFilter').value.toLowerCase();
  $('#targetPages').innerHTML = S.pages
    .filter((p) => !f || `${p.name} ${p.category}`.toLowerCase().includes(f))
    .map((p) => chip(p, S.targets.has(p.id), 'target')).join('') || '<span class="muted">Chưa có Page.</span>';
  $('#analyzePages').innerHTML = S.pages.map((p) => chip(p, S.analyzeSel.has(p.id), 'an')).join('');
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
  S.pages.filter((p) => !f || `${p.name} ${p.category}`.toLowerCase().includes(f)).forEach((p) => S.targets.add(p.id));
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

$('#btnWrite').addEventListener('click', (e) => busy(e.target, 'AI đang viết…', async () => {
  if (!S.targets.size) throw new Error('Chọn Page ở bước ① trước');
  const r = await api('/api/ai/write', {
    json: {
      topic: $('#topic').value, goal: $('#goal').value, tone: $('#tone').value,
      length: $('#length').value, cta: $('#cta').value, link: $('#link').value, pageIds: [...S.targets],
    },
  });
  for (const v of r.variants) {
    if (!S.targets.has(v.page_id)) continue;
    const tags = v.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ');
    S.texts[v.page_id] = `${v.message.trim()}\n\n${tags}`.trim();
  }
  $('#vTexts').value = r.video_slides.join('\n');
  $('#vTitle').value = r.headline;
  renderEditors();
  toast('Đã viết xong — hãy đọc lại trước khi đăng');
}));

// Loại media
function syncKind() {
  const k = $('input[name=kind]:checked').value;
  ['link', 'photo', 'video'].forEach((x) => $(`#kind-${x}`).classList.toggle('hidden', x !== k));
  const src = $('input[name=vsrc]:checked').value;
  $('#vsrc-upload').classList.toggle('hidden', src !== 'upload');
  $('#vsrc-make').classList.toggle('hidden', src !== 'make');
}
$$('input[name=kind], input[name=vsrc]').forEach((r) => r.addEventListener('change', () => {
  S.media = null;
  $('#mediaPreview').innerHTML = '';
  syncKind();
}));

function showMedia(m) {
  S.media = m;
  $('#mediaPreview').innerHTML = m.type.startsWith('video')
    ? `<video src="${esc(m.url)}" controls></video>`
    : `<img src="${esc(m.url)}" alt="">`;
}

async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  const r = await api('/api/upload', { method: 'POST', body: fd });
  showMedia(r);
  toast('Đã tải file lên');
}
$('#photoFile').addEventListener('change', (e) => e.target.files[0] && uploadFile(e.target.files[0]).catch((x) => toast(x.message, true)));
$('#videoFile').addEventListener('change', (e) => e.target.files[0] && uploadFile(e.target.files[0]).catch((x) => toast(x.message, true)));

$('#btnMakeVideo').addEventListener('click', (e) => busy(e.target, 'Đang dựng video…', async () => {
  const texts = $('#vTexts').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const imgs = $('#vImages').files;
  if (!texts.length && !imgs.length) throw new Error('Cần ít nhất ảnh hoặc chữ cho video');
  const fd = new FormData();
  [...imgs].forEach((f) => fd.append('images', f));
  if ($('#vAudio').files[0]) fd.append('audio', $('#vAudio').files[0]);
  fd.append('texts', JSON.stringify(texts));
  fd.append('format', $('#vFormat').value);
  fd.append('seconds', $('#vSeconds').value);
  fd.append('bgColor', $('#vBg').value);
  const r = await api('/api/video', { method: 'POST', body: fd });
  showMedia({ ...r, type: 'video/mp4' });
  toast(`Đã tạo video ${r.seconds}s`);
}));

// Hẹn giờ
$('#schedOn').addEventListener('change', (e) => ($('#schedAt').disabled = !e.target.checked));

// ĐĂNG 1 CLICK
$('#btnPublish').addEventListener('click', (e) => {
  const kind = $('input[name=kind]:checked').value;
  const ids = [...S.targets];
  if (!ids.length) return toast('Chưa chọn Page nào', true);
  const empty = ids.filter((id) => !(S.texts[id] || '').trim());
  if (empty.length && kind !== 'photo' && kind !== 'video') return toast(`${empty.length} Page chưa có nội dung`, true);
  if ((kind === 'photo' || kind === 'video') && !S.media) return toast('Chưa có ảnh/video', true);
  if (kind === 'link' && !$('#link').value) return toast('Chưa nhập link', true);
  const scheduledAt = $('#schedOn').checked && $('#schedAt').value ? new Date($('#schedAt').value).toISOString() : null;
  if (!confirm(`${scheduledAt ? 'Hẹn đăng' : 'Đăng ngay'} lên ${ids.length} Page?`)) return;

  busy(e.target, `Đang đăng… (${ids.length} Page)`, async () => {
    const r = await api('/api/publish', {
      json: {
        kind, media: S.media?.name, link: $('#link').value, title: $('#vTitle').value, scheduledAt,
        posts: ids.map((pageId) => ({ pageId, message: S.texts[pageId] || '' })),
      },
    });
    const ok = r.results.filter((x) => x.ok).length;
    $('#publishResult').innerHTML = `<div class="result"><b>Thành công ${ok}/${r.results.length}</b>${r.results.map((x) => `
      <div>${x.ok ? '<span class="badge ok">OK</span>' : '<span class="badge err">Lỗi</span>'} ${esc(x.pageName || x.pageId)}
      ${x.ok ? `<span class="muted small">${esc(x.postId)}</span>` : `— ${esc(x.error)}`}</div>`).join('')}</div>`;
    toast(`Đăng xong: ${ok}/${r.results.length} Page`, ok < r.results.length);
  });
});

// ================= 5. Lịch sử =================
async function loadHistory() {
  const h = await api('/api/history').catch(() => []);
  $('#historyList').innerHTML = h.length ? `<div class="card table-wrap"><table>
    <thead><tr><th>Thời gian</th><th>Loại</th><th>Nội dung</th><th>Kết quả</th></tr></thead>
    <tbody>${h.map((x) => `<tr>
      <td>${fmtDate(x.at)}${x.scheduledAt ? `<div class="small muted">Hẹn: ${fmtDate(x.scheduledAt)}</div>` : ''}</td>
      <td><span class="badge">${esc(x.kind)}</span></td>
      <td class="small">${esc(x.preview)}</td>
      <td>${x.results.map((r) => `<div class="small">${r.ok ? '✅' : '❌'} ${esc(r.pageName || r.pageId)}${r.ok ? '' : ` — ${esc(r.error)}`}</div>`).join('')}</td>
    </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Chưa có lịch sử.</p>';
}
$('#btnHistory').addEventListener('click', loadHistory);

// ================= Khởi động =================
syncKind();
if (location.protocol === 'file:') {
  fatal('Bạn đang mở trực tiếp file index.html — web sẽ không hoạt động.\nHãy mở cửa sổ lệnh trong thư mục fb-page-manager, chạy "npm start", rồi vào http://localhost:3000');
  $('#btnOauth').classList.add('hidden');
} else {
  loadStatus().catch((e) => fatal(`Không kết nối được server: ${e.message}\nKiểm tra cửa sổ lệnh "npm start" còn đang chạy không.`));
}
