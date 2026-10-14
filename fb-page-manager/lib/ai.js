// Phân tích nội dung Page & viết bài bằng Claude.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.CLAUDE_EFFORT || 'medium';

let client;
export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);
const getClient = () => (client ??= new Anthropic());

async function askJSON({ system, prompt, schema }) {
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error('AI từ chối yêu cầu này. Hãy điều chỉnh chủ đề/nội dung.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Kết quả AI quá dài, bị cắt. Hãy thu hẹp yêu cầu.');
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

const SYSTEM = `Bạn là chuyên gia content & performance marketing trên Facebook tại Việt Nam.
Viết tiếng Việt tự nhiên, đúng chính tả, phù hợp văn hoá. Không bịa số liệu, giá, khuyến mãi hay cam kết mà người dùng không cung cấp.
Tuân thủ Tiêu chuẩn cộng đồng Facebook: không clickbait kiểu "share để nhận quà", không ngôn từ gây hiểu lầm về sức khoẻ/tài chính.`;

// ---------- Phân tích Page ----------
const analysisSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'pages', 'content_ideas'],
  properties: {
    summary: { type: 'string', description: 'Tổng quan toàn bộ danh mục Page, 3-5 câu' },
    pages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['page_id', 'topics', 'tone', 'what_works', 'what_to_improve'],
        properties: {
          page_id: { type: 'string' },
          topics: { type: 'array', items: { type: 'string' } },
          tone: { type: 'string' },
          what_works: { type: 'string' },
          what_to_improve: { type: 'string' },
        },
      },
    },
    content_ideas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'format', 'why', 'target_page_ids'],
        properties: {
          title: { type: 'string' },
          format: { type: 'string', enum: ['text', 'photo', 'video', 'link'] },
          why: { type: 'string' },
          target_page_ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

export async function analyzePages(pagesWithPosts) {
  const data = pagesWithPosts.map((p) => ({
    page_id: p.id,
    name: p.name,
    category: p.category,
    followers: p.followers_count,
    stats: p.stats,
    posts: p.posts.slice(0, 15).map((x) => ({
      date: x.created_time?.slice(0, 10),
      type: x.type,
      engagement: x.engagement,
      text: x.message.slice(0, 400),
    })),
  }));
  return askJSON({
    system: SYSTEM,
    schema: analysisSchema,
    prompt: `Dưới đây là dữ liệu các Facebook Page tôi quản lý cùng các bài gần đây (kèm engagement = reactions + comments + shares).
Hãy phân tích: chủ đề chính, giọng văn, loại nội dung nào đang hiệu quả (dựa trên engagement, không suy đoán vượt dữ liệu), điểm cần cải thiện,
và đề xuất 6-10 ý tưởng nội dung mới, gán cho Page phù hợp.

<data>
${JSON.stringify(data)}
</data>`,
  });
}

// ---------- Viết bài ----------
const writeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'variants', 'video_slides'],
  properties: {
    headline: { type: 'string', description: 'Tiêu đề ngắn dùng làm title video' },
    variants: {
      type: 'array',
      description: 'Mỗi Page một phiên bản riêng để tránh nội dung trùng lặp',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['page_id', 'message', 'hashtags'],
        properties: {
          page_id: { type: 'string' },
          message: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    video_slides: {
      type: 'array',
      description: '3-6 câu ngắn (tối đa ~12 từ) để chèn lên từng cảnh video',
      items: { type: 'string' },
    },
  },
};

export async function writePost({ topic, goal, tone, length, cta, link, pages }) {
  return askJSON({
    system: SYSTEM,
    schema: writeSchema,
    prompt: `Viết bài đăng Facebook.
- Chủ đề / thông tin sản phẩm: ${topic}
- Mục tiêu: ${goal || 'tăng tương tác'}
- Giọng văn: ${tone || 'thân thiện, gần gũi'}
- Độ dài: ${length || 'vừa (80-150 từ)'}
- Call-to-action: ${cta || 'tự chọn phù hợp mục tiêu'}
${link ? `- Link đính kèm: ${link}` : ''}

Viết một phiên bản riêng cho TỪNG Page dưới đây — điều chỉnh theo lĩnh vực và giọng văn của Page đó, mở bài khác nhau
(Facebook giảm phân phối nội dung trùng lặp giữa các Page). Có emoji vừa phải, xuống dòng dễ đọc, 3-6 hashtag.
Đồng thời viết các câu ngắn cho video slideshow.

<pages>
${JSON.stringify(pages.map((p) => ({ page_id: p.id, name: p.name, category: p.category, sample_posts: p.samples || [] })))}
</pages>`,
  });
}
