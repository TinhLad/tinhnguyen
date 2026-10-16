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
    if (u.pathname === '/' || u.pathname === '') return `${u.origin}/v1`;
  } catch {
    throw new Error('Địa chỉ API không hợp lệ — dán dạng https://ten-web.com/v1');
  }
  return url;
}

function customHeaders(key, format) {
  if (format === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  return { Authorization: `Bearer ${key}` };
}

async function customFetch(url, init, label = 'Web trung gian') {
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error(`Không kết nối được ${label}. Có 3 khả năng: (1) sai địa chỉ API, (2) mạng lỗi, (3) web đó không cho gọi trực tiếp từ trình duyệt (CORS) — hỏi bên bán API có hỗ trợ "gọi từ trình duyệt / CORS" không.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || data.message || (typeof data.error === 'string' ? data.error : '') || res.statusText;
    if (res.status === 401 || res.status === 403) throw new Error(`API key không đúng / hết hạn / không có quyền dùng model này (${msg}).`);
    if (res.status === 402 || /quota|balance|credit|insufficient|余额/i.test(msg)) throw new Error(`Tài khoản trên web trung gian hết tiền / hết hạn mức — nạp thêm rồi thử lại (${msg}).`);
    if (res.status === 404) throw new Error(`Sai địa chỉ API hoặc sai tên model (${msg}). Kiểm tra lại "Địa chỉ API" (thường kết thúc bằng /v1) và tên model.`);
    if (res.status === 429) throw new Error('Gọi quá nhanh / vượt hạn mức — đợi 1 phút rồi thử lại.');
    if (res.status >= 500) throw new Error(`Web trung gian đang lỗi hoặc quá tải (mã ${res.status}) — thử lại sau, hoặc đổi model khác.`);
    throw new Error(`Web trung gian báo lỗi (mã ${res.status}): ${msg}`);
  }
  return data;
}

export async function askCustom(key, prompt, cfg = {}) {
  const base = normalizeBase(cfg.base);
  if (!base) throw new Error('Chưa nhập "Địa chỉ API" của web trung gian.');
  if (!cfg.model) throw new Error('Chưa nhập tên model (bấm "Tải danh sách model" để chọn).');
  const format = cfg.format === 'anthropic' ? 'anthropic' : 'openai';
  const headers = { 'content-type': 'application/json', ...customHeaders(key, format) };

  if (format === 'anthropic') {
    const data = await customFetch(`${base}/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: cfg.model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
    });
    if (data.stop_reason === 'max_tokens') throw new Error('Câu trả lời quá dài bị cắt — hãy chọn ít Page hơn rồi thử lại.');
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (!text) throw new Error('Model không trả về nội dung — thử lại hoặc đổi model.');
    return text;
  }

  const data = await customFetch(`${base}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: cfg.model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
  });
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
  const data = await customFetch(`${base}/models`, { headers: customHeaders(key, cfg.format) });
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
