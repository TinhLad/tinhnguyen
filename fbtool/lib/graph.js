// Facebook Graph API chạy trực tiếp trên trình duyệt (Graph API hỗ trợ CORS).
// Chỉ thao tác trên các Page mà tài khoản đang quản lý.
const VERSION = 'v24.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const GRAPH_VIDEO = `https://graph-video.facebook.com/${VERSION}`;

export const SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_posts',
  'business_management',
];

export class GraphError extends Error {
  constructor(err, status) {
    super(err?.message || `Graph API lỗi (HTTP ${status})`);
    this.code = err?.code;
  }
}

async function call(url, { method = 'GET', params = {}, body } = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  const res = await fetch(u, { method, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new GraphError(json.error, res.status);
  return json;
}

const get = (p, params) => call(`${GRAPH}/${p}`, { params });

async function getAll(p, params, max = 500) {
  let out = [];
  let page = await get(p, params);
  while (true) {
    out = out.concat(page.data || []);
    if (!page.paging?.next || out.length >= max) break;
    page = await call(page.paging.next);
  }
  return out.slice(0, max);
}

// ---------- Facebook JavaScript SDK ----------
let sdkReady;
export function loadSdk(appId) {
  sdkReady ??= new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId, version: VERSION, cookie: false, xfbml: false });
      resolve(window.FB);
    };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/vi_VN/sdk.js';
    s.async = true;
    s.onerror = () => reject(new Error('Không tải được Facebook SDK (kiểm tra mạng / trình chặn quảng cáo).'));
    document.head.appendChild(s);
  });
  return sdkReady;
}

export async function sdkLogin(appId, configId) {
  const FB = await loadSdk(appId);
  return new Promise((resolve, reject) => {
    const opts = configId ? { config_id: configId } : { scope: SCOPES.join(','), auth_type: 'rerequest' };
    FB.login((r) => {
      const a = r.authResponse;
      if (a?.accessToken) resolve({ token: a.accessToken, expiresAt: a.expiresIn ? Date.now() + a.expiresIn * 1000 : null });
      else reject(new Error('Bạn đã huỷ đăng nhập hoặc chưa cấp quyền.'));
    }, opts);
  });
}

// Đổi token ngắn hạn (1–2 giờ) sang token dài hạn (~60 ngày). App Secret chỉ dùng cho lần gọi này.
export async function exchangeLongLived(appId, appSecret, token) {
  const r = await get('oauth/access_token', {
    grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: token,
  });
  return { token: r.access_token, expiresAt: r.expires_in ? Date.now() + r.expires_in * 1000 : null };
}

// Thời điểm hết hạn của token: số ms, 0 = không hết hạn, null = không rõ.
export async function tokenExpiry(token) {
  try {
    const { data } = await get('debug_token', { input_token: token, access_token: token });
    return data.expires_at ? data.expires_at * 1000 : 0;
  } catch {
    return null;
  }
}

export const me = (token) => get('me', { access_token: token, fields: 'id,name,picture{url}' });

export const listPages = (userToken) => getAll('me/accounts', {
  access_token: userToken,
  limit: 100,
  fields: 'id,name,access_token,category,fan_count,followers_count,link,picture{url}',
});

export const pagePosts = (pageId, pageToken, limit = 25) => getAll(`${pageId}/posts`, {
  access_token: pageToken,
  limit: Math.min(limit, 100),
  fields: [
    'id', 'message', 'created_time', 'permalink_url', 'full_picture', 'status_type',
    'shares', 'reactions.summary(total_count).limit(0)', 'comments.summary(total_count).limit(0)',
  ].join(','),
}, limit);

export function normalizePost(p) {
  const reactions = p.reactions?.summary?.total_count ?? 0;
  const comments = p.comments?.summary?.total_count ?? 0;
  const shares = p.shares?.count ?? 0;
  return {
    id: p.id, message: p.message || '', created_time: p.created_time, permalink_url: p.permalink_url,
    picture: p.full_picture, type: p.status_type, reactions, comments, shares, engagement: reactions + comments + shares,
  };
}

// ---------- Đăng bài ----------
export async function publish({ pageId, pageToken, kind, message, link, file, fileName, title, scheduledAt }) {
  const sched = scheduledAt
    ? { published: 'false', scheduled_publish_time: String(Math.floor(new Date(scheduledAt).getTime() / 1000)) }
    : {};

  if (kind === 'text' || kind === 'link') {
    const body = new URLSearchParams({ access_token: pageToken, message: message || '', ...sched });
    if (kind === 'link' && link) body.set('link', link);
    return { postId: (await call(`${GRAPH}/${pageId}/feed`, { method: 'POST', body })).id };
  }

  const form = new FormData();
  form.set('access_token', pageToken);
  for (const [k, v] of Object.entries(sched)) form.set(k, v);
  form.set('source', file, fileName);

  if (kind === 'photo') {
    form.set('caption', message || '');
    const r = await call(`${GRAPH}/${pageId}/photos`, { method: 'POST', body: form });
    return { postId: r.post_id || r.id };
  }
  if (kind === 'video') {
    form.set('description', message || '');
    if (title) form.set('title', title);
    return { postId: (await call(`${GRAPH_VIDEO}/${pageId}/videos`, { method: 'POST', body: form })).id };
  }
  throw new Error(`Loại bài không hỗ trợ: ${kind}`);
}

export function explain(err) {
  const map = {
    190: 'Token hết hạn hoặc không hợp lệ — hãy kết nối lại.',
    200: 'Thiếu quyền (permission). Kiểm tra pages_manage_posts / pages_read_engagement.',
    10: 'App chưa được cấp quyền này (cần là admin/tester của App hoặc qua App Review).',
    368: 'Facebook tạm chặn do nghi ngờ spam — giảm tần suất đăng.',
    4: 'Vượt giới hạn gọi API — thử lại sau.',
    17: 'Vượt giới hạn gọi API của tài khoản — thử lại sau.',
    32: 'Vượt giới hạn gọi API của Page — thử lại sau.',
    100: 'Tham số không hợp lệ (vd: lịch đăng phải cách hiện tại 10 phút – 30 ngày).',
  };
  return err instanceof GraphError && map[err.code] ? `${map[err.code]} (${err.message})` : err.message;
}
