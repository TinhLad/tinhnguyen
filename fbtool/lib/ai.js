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

export const PROVIDERS = {
  gemini: { label: 'Gemini (Google)', ask: askGemini, keyName: 'geminiKey', chat: 'https://gemini.google.com/app', placeholder: 'AIza…',
    help: 'Lấy key miễn phí: aistudio.google.com → Get API key → Create API key. Gói miễn phí có giới hạn lượt dùng mỗi ngày.' },
  claude: { label: 'Claude (Anthropic)', ask: askClaude, keyName: 'anthropicKey', chat: 'https://claude.ai/new', placeholder: 'sk-ant-…',
    help: 'Lấy key: console.anthropic.com → API Keys → Create Key (cần nạp tiền ở Billing; mỗi lần viết tốn khoảng vài trăm đồng).' },
};
