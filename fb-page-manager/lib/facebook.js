// Facebook Graph API helpers — chỉ dùng API chính thức, chỉ thao tác trên các Page mà tài khoản đang quản lý.
import fs from 'node:fs/promises';
import path from 'node:path';

const VERSION = process.env.FB_GRAPH_VERSION || 'v24.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const GRAPH_VIDEO = `https://graph-video.facebook.com/${VERSION}`;

export const REQUIRED_SCOPES = [
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
    this.subcode = err?.error_subcode;
    this.status = status;
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

export const get = (p, params) => call(`${GRAPH}/${p}`, { params });

// Gom toàn bộ kết quả qua các trang (paging.next).
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

// ---------- Đăng nhập ----------
// App loại Business dùng "Facebook Login for Business" → truyền config_id; app thường dùng scope.
export function loginUrl(appId, redirectUri, state, configId) {
  const u = new URL(`https://www.facebook.com/${VERSION}/dialog/oauth`);
  u.searchParams.set('client_id', appId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('response_type', 'code');
  if (configId) u.searchParams.set('config_id', configId);
  else u.searchParams.set('scope', REQUIRED_SCOPES.join(','));
  return u.toString();
}

export async function exchangeCode({ appId, appSecret, redirectUri, code }) {
  const short = await get('oauth/access_token', {
    client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code,
  });
  return toLongLived({ appId, appSecret, token: short.access_token });
}

// Đổi token ngắn hạn (1–2h) thành token dài hạn (~60 ngày). Page token lấy từ token dài hạn sẽ không hết hạn.
export async function toLongLived({ appId, appSecret, token }) {
  if (!appId || !appSecret) return token;
  const r = await get('oauth/access_token', {
    grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: token,
  });
  return r.access_token;
}

export const me = (token) => get('me', { access_token: token, fields: 'id,name,picture{url}' });

// ---------- Đọc dữ liệu Page ----------
export async function listPages(userToken) {
  return getAll('me/accounts', {
    access_token: userToken,
    limit: 100,
    fields: 'id,name,access_token,category,tasks,fan_count,followers_count,link,about,picture{url}',
  });
}

export async function pagePosts(pageId, pageToken, limit = 25) {
  return getAll(`${pageId}/posts`, {
    access_token: pageToken,
    limit: Math.min(limit, 100),
    fields: [
      'id', 'message', 'created_time', 'permalink_url', 'full_picture', 'status_type',
      'shares', 'reactions.summary(total_count).limit(0)', 'comments.summary(total_count).limit(0)',
    ].join(','),
  }, limit);
}

export function normalizePost(p) {
  const reactions = p.reactions?.summary?.total_count ?? 0;
  const comments = p.comments?.summary?.total_count ?? 0;
  const shares = p.shares?.count ?? 0;
  return {
    id: p.id,
    message: p.message || '',
    created_time: p.created_time,
    permalink_url: p.permalink_url,
    picture: p.full_picture,
    type: p.status_type,
    reactions, comments, shares,
    engagement: reactions + comments + shares,
  };
}

// ---------- Đăng bài ----------
async function fileBlob(filePath) {
  const buf = await fs.readFile(filePath);
  return new Blob([buf]);
}

function scheduleParams(scheduledAt) {
  if (!scheduledAt) return {};
  const ts = Math.floor(new Date(scheduledAt).getTime() / 1000);
  return { published: 'false', scheduled_publish_time: String(ts) };
}

/**
 * Đăng 1 bài lên 1 Page.
 * kind: 'text' | 'link' | 'photo' | 'video'
 */
export async function publish({ pageId, pageToken, kind, message, link, filePath, title, scheduledAt }) {
  const sched = scheduleParams(scheduledAt);

  if (kind === 'text' || kind === 'link') {
    const body = new URLSearchParams({ access_token: pageToken, message: message || '', ...sched });
    if (kind === 'link' && link) body.set('link', link);
    const r = await call(`${GRAPH}/${pageId}/feed`, { method: 'POST', body });
    return { postId: r.id };
  }

  const form = new FormData();
  form.set('access_token', pageToken);
  for (const [k, v] of Object.entries(sched)) form.set(k, v);

  if (kind === 'photo') {
    form.set('caption', message || '');
    form.set('source', await fileBlob(filePath), path.basename(filePath));
    const r = await call(`${GRAPH}/${pageId}/photos`, { method: 'POST', body: form });
    return { postId: r.post_id || r.id };
  }

  if (kind === 'video') {
    form.set('description', message || '');
    if (title) form.set('title', title);
    form.set('source', await fileBlob(filePath), path.basename(filePath));
    const r = await call(`${GRAPH_VIDEO}/${pageId}/videos`, { method: 'POST', body: form });
    return { postId: r.id };
  }

  throw new Error(`Loại bài không hỗ trợ: ${kind}`);
}

// Diễn giải các lỗi Graph hay gặp sang tiếng Việt cho dễ xử lý.
export function explain(err) {
  const map = {
    190: 'Token hết hạn hoặc không hợp lệ — hãy đăng nhập lại.',
    200: 'Thiếu quyền (permission). Kiểm tra pages_manage_posts / pages_read_engagement.',
    10: 'App chưa được cấp quyền này (cần App Review hoặc tài khoản là admin/tester của App).',
    368: 'Facebook tạm chặn hành động do nghi ngờ spam — giảm tần suất đăng.',
    4: 'Vượt giới hạn gọi API của App — thử lại sau.',
    17: 'Vượt giới hạn gọi API của tài khoản — thử lại sau.',
    32: 'Vượt giới hạn gọi API của Page — thử lại sau.',
    100: 'Tham số không hợp lệ (vd: lịch đăng phải cách hiện tại 10 phút – 30 ngày).',
  };
  return map[err.code] ? `${map[err.code]} (${err.message})` : err.message;
}
