// Gọi Claude trực tiếp từ trình duyệt bằng API key của chính người dùng.
// Key chỉ nằm trong localStorage của máy này, không gửi đi đâu ngoài api.anthropic.com.
const MODEL = 'claude-sonnet-5-5';

export async function askClaude(apiKey, prompt) {
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
    });
  } catch {
    throw new Error('Không kết nối được tới Claude — kiểm tra mạng rồi thử lại.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || res.statusText;
    if (res.status === 401) throw new Error('API key không đúng hoặc đã bị xoá — kiểm tra lại key.');
    if (res.status === 400 && /credit|balance/i.test(msg)) throw new Error('Tài khoản Claude API hết tiền — nạp thêm tại console.anthropic.com → Billing.');
    if (res.status === 429) throw new Error('Gọi quá nhanh / vượt hạn mức — đợi 1 phút rồi thử lại.');
    if (res.status === 529 || res.status >= 500) throw new Error('Claude đang quá tải — thử lại sau ít phút.');
    throw new Error(`Claude báo lỗi: ${msg}`);
  }
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  if (data.stop_reason === 'max_tokens') throw new Error('Câu trả lời quá dài bị cắt — hãy chọn ít Page hơn rồi thử lại.');
  return text;
}

// Gemini (Google AI Studio). Có gói miễn phí (giới hạn số lượt/phút & /ngày).
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash'];

export async function askGemini(apiKey, prompt) {
  let lastErr;
  for (const model of GEMINI_MODELS) {
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 16000 } }),
      });
    } catch {
      throw new Error('Không kết nối được tới Gemini — kiểm tra mạng rồi thử lại.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) { lastErr = new Error(`Gemini không có model ${model}`); continue; }
    if (!res.ok) {
      const msg = data.error?.message || res.statusText;
      if (res.status === 400 && /API key/i.test(msg)) throw new Error('Gemini API key không đúng — kiểm tra lại key.');
      if (res.status === 403) throw new Error('Gemini từ chối key này (key bị khoá hoặc chưa bật Gemini API).');
      if (res.status === 429) throw new Error('Đã hết lượt miễn phí của Gemini (theo phút hoặc theo ngày) — đợi một lúc hoặc sang ngày mai thử lại.');
      if (res.status >= 500) throw new Error('Gemini đang quá tải — thử lại sau ít phút.');
      throw new Error(`Gemini báo lỗi: ${msg}`);
    }
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('\n');
    if (cand?.finishReason === 'MAX_TOKENS') throw new Error('Câu trả lời quá dài bị cắt — hãy chọn ít Page hơn rồi thử lại.');
    if (!text) throw new Error('Gemini không trả về nội dung (có thể bị bộ lọc an toàn chặn) — thử đổi cách viết chủ đề.');
    return text;
  }
  throw lastErr;
}

// ================= Web trung gian (API proxy / reseller) =================
// Hỗ trợ 2 chuẩn phổ biến: OpenAI (/chat/completions) và Anthropic (/messages).
// cfg = { base, model, format: 'openai' | 'anthropic' }

// Chuẩn hoá địa chỉ: bỏ "/" cuối và đuôi endpoint nếu người dùng dán thừa; thiếu đường dẫn thì thêm /v1.
export function normalizeBase(raw) {
  let url = String(raw || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/(chat\/completions|messages|models)$/i, '');
  try {
    const u = new URL(url);
    // Dán nhầm link trang quản lý (VD .../dashboard/models?model=...) → về gốc tên miền.
    if (u.pathname === '/' || u.pathname === '' || /^\/(dashboard|console|keys|docs|pricing|account)\b/i.test(u.pathname)) return `${u.origin}/v1`;
    url = `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    throw new Error('Địa chỉ API không hợp lệ — dán dạng https://ten-web.com/v1');
  }
  return url;
}

function customHeaders(key, format) {
  if (format === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  return { Authorization: `Bearer ${key}` };
}

// Lỗi kèm thông tin để biết có nên thử địa chỉ API khác không:
// apiLike = máy chủ trả lời đúng kiểu API (JSON) → địa chỉ đúng, lỗi nằm ở key/model/tiền.
function apiError(message, status, apiLike) {
  return Object.assign(new Error(message), { status, apiLike });
}

// Gọi API trực tiếp, hoặc qua "cầu nối" Google Apps Script (bridge) khi web trung gian chặn trình duyệt (CORS).
async function customFetch(url, init = {}, bridge = '') {
  const res = bridge ? await viaBridge(bridge, url, init) : await direct(url, init);
  let data = null;
  try { data = JSON.parse(res.text); } catch { /* không phải JSON */ }
  const ok = res.status >= 200 && res.status < 300;
  if (ok && !data) throw apiError('Địa chỉ này trả về một trang web chứ không phải API — kiểm tra lại "Địa chỉ API" trong mục API / Docs của web trung gian.', 404, false);
  if (!ok) throw httpError(res, data || {}, !!data);
  return data;
}

async function direct(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw apiError('Không kết nối được Web trung gian. Có 3 khả năng: (1) sai địa chỉ API, (2) mạng lỗi, (3) web đó không cho gọi trực tiếp từ trình duyệt (CORS) — khi đó hãy dùng "Cầu nối" bên dưới.', 0, false);
  }
  return { status: res.status, statusText: res.statusText, text: await res.text() };
}

// Gửi dạng text/plain (không kích hoạt kiểm tra CORS "preflight"); Apps Script gọi API thay trình duyệt.
async function viaBridge(bridge, url, init) {
  let res;
  try {
    res = await fetch(bridge, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body || null }),
    });
  } catch {
    throw apiError('Không kết nối được Cầu nối — kiểm tra lại link Cầu nối (phải là link "Ứng dụng web" kết thúc bằng /exec, quyền truy cập "Bất kỳ ai").', 0, false);
  }
  let out;
  try { out = JSON.parse(await res.text()); } catch {
    throw apiError('Cầu nối trả về trang lạ — thường do chưa chọn quyền truy cập "Bất kỳ ai" (Anyone) khi triển khai Apps Script.', 0, false);
  }
  if (out.error) throw apiError(`Cầu nối báo lỗi: ${out.error}`, 0, false);
  return { status: out.status, statusText: '', text: out.body || '' };
}

// Mã Apps Script để người dùng dán vào script.google.com (chỉ cho phép gọi tới tên miền API đã nhập).
export function bridgeScript(base) {
  let host = 'api.xkiro.com';
  try { host = new URL(normalizeBase(base)).hostname || host; } catch { /* dùng mặc định */ }
  return `// Cầu nối FB Page Manager → web trung gian. Dán toàn bộ vào script.google.com rồi Triển khai → Ứng dụng web.
const ALLOWED_HOSTS = ['${host}']; // chỉ cho phép gọi tới các tên miền này

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const m = String(req.url).match(/^https:\\/\\/([^\\/:]+)/);
    if (!m || ALLOWED_HOSTS.indexOf(m[1]) < 0) return out({ error: 'Cầu nối không cho phép gọi ' + req.url + ' — thêm tên miền vào ALLOWED_HOSTS.' });
    const headers = Object.assign({}, req.headers || {});
    const contentType = headers['content-type'];
    delete headers['content-type'];
    const opt = { method: String(req.method || 'GET').toLowerCase(), headers: headers, muteHttpExceptions: true };
    if (req.body) { opt.payload = req.body; opt.contentType = contentType || 'application/json'; }
    const res = UrlFetchApp.fetch(req.url, opt);
    return out({ status: res.getResponseCode(), body: res.getContentText() });
  } catch (err) {
    return out({ error: String(err) });
  }
}

function doGet() { return out({ ok: true, message: 'Cầu nối đang chạy' }); }

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
`;
}

function httpError(res, data, apiLike) {
  const fail = (m) => apiError(m, res.status, apiLike);
  const msg = data.error?.message || data.message || (typeof data.error === 'string' ? data.error : '') || res.statusText;
  if (res.status === 401 || res.status === 403) return fail(`API key không đúng / hết hạn / không có quyền dùng model này (${msg}).`);
  if (res.status === 402 || /quota|balance|credit|insufficient|余额/i.test(msg)) return fail(`Tài khoản trên web trung gian hết tiền / hết hạn mức — nạp thêm rồi thử lại (${msg}).`);
  if (res.status === 404) return fail(`Sai địa chỉ API hoặc sai tên model (${msg}). Kiểm tra lại "Địa chỉ API" (thường kết thúc bằng /v1) và tên model.`);
  if (res.status === 429) return fail('Gọi quá nhanh / vượt hạn mức — đợi 1 phút rồi thử lại.');
  if (res.status >= 500) return fail(`Web trung gian đang lỗi hoặc quá tải (mã ${res.status}) — thử lại sau, hoặc đổi model khác.`);
  return fail(`Web trung gian báo lỗi (mã ${res.status}): ${msg}`);
}

// Các địa chỉ API hay gặp của web trung gian, thử lần lượt khi người dùng không chắc.
export function baseCandidates(raw) {
  const first = normalizeBase(raw);
  if (!first) return [];
  const u = new URL(first);
  const host = u.hostname.replace(/^(www|api)\./, '');
  return [...new Set([first, `${u.origin}/v1`, `${u.origin}/api/v1`, `https://api.${host}/v1`, `${u.origin}/openai/v1`])];
}

// Gửi 1 câu hỏi ngắn tới từng địa chỉ cho tới khi có địa chỉ trả lời đúng kiểu API.
export async function probeCustom(key, cfg = {}) {
  let firstErr;
  const unreachable = [];
  for (const base of baseCandidates(cfg.base)) {
    try {
      const reply = await askCustom(key, 'Trả lời đúng 1 từ: OK', { ...cfg, base });
      return { base, reply };
    } catch (err) {
      if (err.apiLike) throw Object.assign(err, { base }); // địa chỉ đúng, lỗi do key/model/tiền
      if (err.status === 0) unreachable.push(base);
      firstErr ??= err;
    }
  }
  // Mọi địa chỉ đều "không kết nối được": phân biệt máy chủ CÓ tồn tại nhưng chặn trình duyệt (CORS)
  // với máy chủ KHÔNG tồn tại, bằng 1 yêu cầu no-cors (trình duyệt cho gửi nhưng không cho đọc kết quả).
  for (const base of cfg.bridge ? [] : unreachable) {
    if (await reachable(`${base}/models`)) {
      throw Object.assign(new Error(`Đã tìm thấy máy chủ API tại ${base} nhưng web trung gian CHẶN gọi trực tiếp từ trình duyệt (lỗi CORS), nên chưa kiểm tra được key và model. Cách khắc phục: làm "🌉 Cầu nối" theo hướng dẫn ngay bên dưới (khoảng 3 phút, miễn phí).`), { base, cors: true });
    }
  }
  if (unreachable.length && !cfg.bridge) throw new Error('Không tìm thấy máy chủ API ở các địa chỉ phổ biến — hãy tìm đúng "Base URL / Endpoint" trong trang API Keys hoặc Tài liệu (Docs) của web trung gian rồi dán vào.');
  throw firstErr || new Error('Chưa nhập "Địa chỉ API" của web trung gian.');
}

async function reachable(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    await fetch(url, { mode: 'no-cors', signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Tên hiển thị ("Mistral Large 4") thay vì mã model ("mistral/mistral-large-4").
export function modelIdProblem(model) {
  if (/\s/.test(String(model).trim())) {
    return `"${model}" là TÊN HIỂN THỊ, chưa phải mã model. Hãy copy dòng chữ nhỏ màu xám ngay dưới tên model trên web trung gian (dạng nhà-cung-cấp/tên-model, không có dấu cách), hoặc bấm "Tải danh sách model" để chọn.`;
  }
  return '';
}

export async function askCustom(key, prompt, cfg = {}) {
  const base = normalizeBase(cfg.base);
  if (!base) throw new Error('Chưa nhập "Địa chỉ API" của web trung gian.');
  if (!cfg.model) throw new Error('Chưa nhập tên model (bấm "Tải danh sách model" để chọn).');
  if (modelIdProblem(cfg.model)) throw new Error(modelIdProblem(cfg.model));
  const format = cfg.format === 'anthropic' ? 'anthropic' : 'openai';
  const headers = { 'content-type': 'application/json', ...customHeaders(key, format) };

  if (format === 'anthropic') {
    const data = await customFetch(`${base}/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: cfg.model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
    }, cfg.bridge);
    if (data.stop_reason === 'max_tokens') throw new Error('Câu trả lời quá dài bị cắt — hãy chọn ít Page hơn rồi thử lại.');
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (!text) throw new Error('Model không trả về nội dung — thử lại hoặc đổi model.');
    return text;
  }

  const data = await customFetch(`${base}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: cfg.model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
  }, cfg.bridge);
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('Câu trả lời quá dài bị cắt — hãy chọn ít Page hơn rồi thử lại.');
  const content = choice?.message?.content;
  const text = Array.isArray(content) ? content.map((c) => c.text || '').join('\n') : content || '';
  if (!text) throw new Error('Model không trả về nội dung — thử lại hoặc đổi model.');
  return text;
}

// Lấy danh sách model mà web trung gian cung cấp (GET /models).
export async function listCustomModels(key, cfg = {}) {
  const base = normalizeBase(cfg.base);
  if (!base) throw new Error('Chưa nhập "Địa chỉ API" của web trung gian.');
  // Nhiều web (VD xKiro) cho xem danh sách model công khai: thử không kèm key trước (không bị kiểm tra CORS preflight).
  let data;
  try {
    data = await customFetch(`${base}/models`, {}, cfg.bridge);
  } catch {
    data = await customFetch(`${base}/models`, { headers: customHeaders(key, cfg.format) }, cfg.bridge);
  }
  const ids = (data.data || data.models || []).map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  return [...new Set(ids)].sort();
}

export const PROVIDERS = {
  gemini: { label: 'Gemini (Google)', ask: askGemini, keyName: 'geminiKey', chat: 'https://gemini.google.com/app', placeholder: 'AIza…',
    help: 'Lấy key miễn phí: aistudio.google.com → Get API key → Create API key. Gói miễn phí có giới hạn lượt dùng mỗi ngày.' },
  claude: { label: 'Claude (Anthropic)', ask: askClaude, keyName: 'anthropicKey', chat: 'https://claude.ai/new', placeholder: 'sk-ant-…',
    help: 'Lấy key: console.anthropic.com → API Keys → Create Key (cần nạp tiền ở Billing; mỗi lần viết tốn khoảng vài trăm đồng).' },
  custom: { label: 'Web trung gian', ask: askCustom, keyName: 'customKey', chat: null, placeholder: 'sk-… (API key của web trung gian)',
    help: 'Dán Địa chỉ API (Base URL), API key và tên model lấy trong trang quản lý của web trung gian. Lưu ý: web trung gian đọc được toàn bộ nội dung bạn gửi — chỉ dùng bên uy tín.' },
};

// ================= Tạo ảnh =================
const SIZES = { '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1280, 720], '9:16': [1080, 1920] };
const NO_TEXT = ' No text, no letters, no watermark in the image. Photorealistic, high quality, suitable for a Facebook post.';

// Miễn phí, không cần key (Pollinations.ai — dịch vụ cộng đồng, có thể chậm hoặc tạm ngừng).
// Web trung gian: tạo ảnh theo chuẩn OpenAI (POST /images/generations), đi qua Cầu nối nếu có.
const OPENAI_SIZES = { '1:1': '1024x1024', '4:5': '1024x1536', '9:16': '1024x1536', '16:9': '1536x1024' };
export async function imageCustom(key, cfg, model, prompt, ratio = '1:1') {
  const base = normalizeBase(cfg.base);
  if (!base) throw new Error('Chưa cài web trung gian — điền ở khung "🤖 Cài đặt AI" (tab 1).');
  if (!model) throw new Error('Nhập tên model tạo ảnh của web trung gian (VD: openai/gpt-image-2.5).');
  const data = await customFetch(`${base}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...customHeaders(key, 'openai') },
    body: JSON.stringify({ model, prompt: prompt + NO_TEXT, n: 1, size: OPENAI_SIZES[ratio] || '1024x1024' }),
  }, cfg.bridge);
  const item = data.data?.[0] || {};
  if (item.b64_json) {
    const bytes = Uint8Array.from(atob(item.b64_json), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: 'image/png' });
  }
  if (item.url) {
    const res = await fetch(item.url).catch(() => null);
    if (res?.ok) return res.blob();
    throw new Error('Web trung gian trả về link ảnh nhưng trình duyệt không tải được — thử model ảnh khác.');
  }
  throw new Error('Web trung gian không trả về ảnh — kiểm tra tên model tạo ảnh (model chat không vẽ được ảnh).');
}

export async function imageFree(prompt, ratio = '1:1') {
  const [w, h] = SIZES[ratio] || SIZES['1:1'];
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt + NO_TEXT)}?width=${w}&height=${h}&nologo=true&seed=${Date.now() % 1e6}`;
  let res;
  try { res = await fetch(url); } catch { throw new Error('Không kết nối được dịch vụ tạo ảnh miễn phí — thử lại hoặc chọn Gemini.'); }
  if (!res.ok) throw new Error(`Dịch vụ tạo ảnh miễn phí đang bận (mã ${res.status}) — đợi 1 phút rồi thử lại, hoặc chọn Gemini.`);
  const blob = await res.blob();
  if (!blob.type.startsWith('image/')) throw new Error('Dịch vụ tạo ảnh miễn phí không trả về ảnh — thử lại sau.');
  return blob;
}

// Gemini tạo ảnh — Google KHÔNG cho dùng miễn phí, cần bật thanh toán (Billing) cho key.
let imageModel;
async function findImageModel(apiKey) {
  if (imageModel) return imageModel;
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { headers: { 'x-goog-api-key': apiKey } }).catch(() => null);
  const data = res && (await res.json().catch(() => ({})));
  if (!res?.ok) throw new Error(data?.error?.message ? `Gemini báo lỗi: ${data.error.message}` : 'Không kết nối được tới Gemini.');
  const ids = (data.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace('models/', '')).filter((n) => /flash.*image|image.*flash/.test(n));
  // Ưu tiên bản mới nhất; cùng phiên bản thì bản đầy đủ trước bản lite/preview.
  const ver = (n) => parseFloat(n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] || 0);
  const rank = (n) => ver(n) * 10 - (n.includes('lite') ? 2 : 0) - (n.includes('preview') ? 1 : 0);
  ids.sort((a, b) => rank(b) - rank(a));
  if (!ids.length) throw new Error('Key Gemini này chưa dùng được model tạo ảnh.');
  return (imageModel = ids[0]);
}

export async function imageGemini(apiKey, prompt, ratio = '1:1') {
  const model = await findImageModel(apiKey);
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `Create an image, aspect ratio ${ratio}. ${prompt}.${NO_TEXT}` }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: ratio } },
    }),
  }).catch(() => { throw new Error('Không kết nối được tới Gemini.'); });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || res.statusText;
    if (res.status === 429 || /free tier|billing|quota/i.test(msg)) throw new Error('Gemini chỉ cho tạo ảnh khi key đã bật thanh toán (aistudio.google.com → Billing). Hoặc chọn "Miễn phí" để tạo ảnh không cần key.');
    throw new Error(`Gemini báo lỗi: ${msg}`);
  }
  const part = (data.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
  if (!part) throw new Error('Gemini không tạo được ảnh cho mô tả này (có thể bị bộ lọc an toàn chặn) — thử viết mô tả khác.');
  const bin = atob(part.inlineData.data);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: part.inlineData.mimeType || 'image/png' });
}
