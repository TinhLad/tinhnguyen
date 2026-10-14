// Phiên bản GitHub Pages không giữ API key AI trên trang công khai.
// Thay vào đó: tạo sẵn prompt kèm dữ liệu Page → người dùng dán vào Claude.ai → dán kết quả JSON trở lại.

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

export function writePrompt({ topic, goal, tone, length, cta, link, pages }) {
  return `Bạn là chuyên gia content Facebook tại Việt Nam. Viết bài đăng Facebook.
- Chủ đề / thông tin sản phẩm: ${topic}
- Mục tiêu: ${goal}
- Giọng văn: ${tone}
- Độ dài: ${length}
- Call-to-action: ${cta || 'tự chọn phù hợp mục tiêu'}
${link ? `- Link đính kèm: ${link}\n` : ''}
Viết một phiên bản riêng cho TỪNG Page dưới đây — điều chỉnh theo lĩnh vực và giọng văn của Page, mở bài khác nhau
(Facebook giảm phân phối nội dung trùng lặp giữa các Page). Emoji vừa phải, xuống dòng dễ đọc, 3-6 hashtag.
Kèm 3-6 câu ngắn (tối đa ~12 từ) để chèn lên từng cảnh video slideshow.

${RULES}
Cấu trúc JSON:
{"headline": "tiêu đề ngắn cho video",
 "variants": [{"page_id": "...", "message": "...", "hashtags": ["#..."]}],
 "video_slides": ["...", "..."]}

<pages>
${JSON.stringify(pages.map((p) => ({ page_id: p.id, name: p.name, category: p.category, sample_posts: p.samples || [] })))}
</pages>`;
}

// Lấy JSON từ câu trả lời (chấp nhận có/không có ```json).
export function parseAnswer(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Không đọc được kết quả — hãy copy nguyên phần JSON mà Claude trả về.');
  }
}
