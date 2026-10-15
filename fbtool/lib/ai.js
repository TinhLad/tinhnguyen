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
