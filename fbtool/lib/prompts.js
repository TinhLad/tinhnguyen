// Hai cách dùng prompt: (1) miễn phí — copy sang Claude.ai rồi dán kết quả JSON trở lại;
// (2) "AI viết trực tiếp" — gọi Claude API bằng key riêng của người dùng (lib/ai.js).

const RULES = `Viết tiếng Việt tự nhiên, đúng chính tả. Không bịa số liệu, giá, khuyến mãi hay cam kết mà tôi không cung cấp.
Tuân thủ Tiêu chuẩn cộng đồng Facebook (không clickbait "share để nhận quà", không gây hiểu lầm về sức khoẻ/tài chính).
CHỈ trả về đúng 1 khối JSON hợp lệ (bọc trong \`\`\`json ... \`\`\`), không giải thích thêm.`;

export function analyzePrompt(pages) {
  const data = pages.map((p) => ({
    page_id: p.id,
    name: p.name,
    category: p.category,
    followers: p.followers_count ?? p.fan_count,
    stats: p.stats && { posts30d: p.stats.posts30d, avgEngagement: p.stats.avgEngagement, bestHour: p.stats.bestHour, byType: p.stats.byType },
    posts: p.posts.slice(0, 15).map((x) => ({
      date: x.created_time?.slice(0, 10), type: x.type, engagement: x.engagement, text: x.message.slice(0, 400),
    })),
  }));
  return `Bạn là chuyên gia content & performance marketing Facebook tại Việt Nam.
Dưới đây là dữ liệu các Facebook Page tôi quản lý và các bài gần đây (engagement = reactions + comments + shares).
Hãy phân tích: chủ đề chính, giọng văn, loại nội dung đang hiệu quả (dựa trên engagement, không suy đoán vượt dữ liệu),
điểm cần cải thiện, và đề xuất 6-10 ý tưởng nội dung mới gán cho Page phù hợp.

${RULES}
Cấu trúc JSON:
{"summary": "3-5 câu tổng quan",
 "pages": [{"page_id": "...", "topics": ["..."], "tone": "...", "what_works": "...", "what_to_improve": "..."}],
 "content_ideas": [{"title": "...", "format": "text|photo|video|link", "why": "...", "target_page_ids": ["..."]}]}

<data>
${JSON.stringify(data)}
</data>`;
}

// source: bài viral làm cảm hứng { text, page, engagement, external } — AI phải VIẾT LẠI, không chép.
function sourceBlock(source) {
  if (!source?.text) return '';
  const from = source.external ? 'một nguồn bên ngoài (do tôi tự sưu tầm)' : `Page "${source.page}" của tôi`;
  return `
BÀI VIRAL LÀM CẢM HỨNG (từ ${from}${source.engagement ? `, ${source.engagement} lượt tương tác` : ''}):
<source>
${String(source.text).slice(0, 3000)}
</source>
Yêu cầu khi dùng bài này:
- Phân tích VÌ SAO bài này hút tương tác (chủ đề, góc nhìn, cảm xúc, cách mở bài) rồi áp dụng lại — KHÔNG chép nguyên văn, không giữ câu chữ gốc quá 1 câu ngắn.
- Viết lại bằng góc nhìn mới, thêm giá trị (mẹo, ví dụ, câu hỏi gợi bình luận), hợp giọng từng Page.
- Không dùng tên người, số liệu, hình ảnh riêng của bài gốc nếu không chắc chắn đúng.${source.external ? '\n- Nếu nhắc tới ý tưởng/thông tin cụ thể của nguồn ngoài, ghi "Nguồn: tổng hợp" ở cuối bài.' : ''}
`;
}

export function writePrompt({ topic, goal, tone, length, cta, link, pages, source }) {
  return `Bạn là chuyên gia content Facebook tại Việt Nam. Viết bài đăng Facebook.
- Chủ đề / thông tin sản phẩm: ${topic || (source?.text ? 'theo bài viral bên dưới' : '')}
- Mục tiêu: ${goal}
- Giọng văn: ${tone}
- Độ dài: ${length}
- Call-to-action: ${cta || 'tự chọn phù hợp mục tiêu'}
${link ? `- Link đính kèm: ${link}\n` : ''}
Viết một phiên bản riêng cho TỪNG Page dưới đây — điều chỉnh theo lĩnh vực và giọng văn của Page, mở bài khác nhau
(Facebook giảm phân phối nội dung trùng lặp giữa các Page). Emoji vừa phải, xuống dòng dễ đọc, 3-6 hashtag.
Kèm kịch bản video ngắn 4-6 cảnh (video_scenes): mỗi cảnh có caption tiếng Việt ngắn (tối đa ~12 từ) hiện trên màn hình
và image_prompt tiếng Anh mô tả hình ảnh của cảnh đó (chủ thể, bối cảnh, ánh sáng, phong cách; không chứa chữ trong ảnh);
các cảnh nối tiếp nhau thành 1 câu chuyện: mở đầu gây chú ý → nội dung chính → kêu gọi hành động.
Và 1 mô tả ảnh minh hoạ chính bằng tiếng Anh (image_prompt) cho bài đăng dạng ảnh.
${sourceBlock(source)}
${RULES}
Cấu trúc JSON:
{"headline": "tiêu đề ngắn cho video",
 "variants": [{"page_id": "...", "page_name": "...", "message": "...", "hashtags": ["#..."]}],
 "video_slides": ["...", "..."],
 "video_scenes": [{"caption": "...", "image_prompt": "..."}],
 "image_prompt": "..."}

<pages>
${JSON.stringify(pages.map((p) => ({ page_id: p.id, name: p.name, category: p.category, sample_posts: p.samples || [] })))}
</pages>`;
}

const PASTE_HELP = 'Hãy dán CÂU TRẢ LỜI mà AI viết ra (bấm nút Copy dưới câu trả lời trên Gemini/Claude), không phải prompt hay mẫu định dạng.';

// Đoạn JSON "mẫu" trong prompt (giá trị "...") — người dùng hay dán nhầm cái này.
const isTemplate = (o) => JSON.stringify(o).includes('"..."');

// Tìm mọi khối {...} cân bằng ngoặc trong văn bản (bỏ qua ngoặc trong chuỗi).
function jsonCandidates(text) {
  const out = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) out.push(m[1]);
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    let depth = 0, str = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
      if (c === '"') str = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { out.push(text.slice(i, j + 1)); i = j; break; }
    }
  }
  return out;
}

// Lấy JSON từ câu trả lời: chấp nhận có/không có ```json, có chữ giải thích trước/sau.
// key: trường bắt buộc phải có (VD 'variants' cho viết bài, 'summary' cho phân tích).
export function parseAnswer(text, key) {
  text = (text || '').trim();
  if (!text) throw new Error(`Ô kết quả đang trống. ${PASTE_HELP}`);
  if (text.includes('<pages>') || text.includes('<data>')) throw new Error(`Bạn đang dán lại PROMPT. ${PASTE_HELP}`);
  let sawTemplate = false;
  for (const raw of jsonCandidates(text)) {
    let o;
    try { o = JSON.parse(raw.trim()); } catch { continue; }
    if (!o || typeof o !== 'object' || (key && !(key in o))) continue;
    if (isTemplate(o)) { sawTemplate = true; continue; }
    return o;
  }
  if (sawTemplate) throw new Error(`Đây là MẪU ĐỊNH DẠNG (toàn dấu "..."), chưa phải bài viết. ${PASTE_HELP}`);
  throw new Error(`Không đọc được kết quả — có thể câu trả lời bị thiếu đoạn cuối. ${PASTE_HELP}`);
}
