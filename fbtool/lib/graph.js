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
    this.subcode = err?.error_subcode;
    this.userMsg = err?.error_user_msg;
    this.transient = !!err?.is_transient;
    this.traceId = err?.fbtrace_id;
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
// Tải SDK sẵn (khi đã có App ID) để lúc bấm nút, FB.login chạy ngay trong thao tác click
// — nếu phải chờ tải mạng, trình duyệt sẽ chặn cửa sổ đăng nhập.
let sdkReady;
let sdkAppId;
export function loadSdk(appId) {
  if (window.FB && sdkAppId && sdkAppId !== appId) {
    window.FB.init({ appId, version: VERSION, cookie: false, xfbml: false });
    sdkAppId = appId;
  }
  sdkReady ??= new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId, version: VERSION, cookie: false, xfbml: false });
      sdkAppId = appId;
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
  // SDK đã sẵn sàng → gọi FB.login đồng bộ, không chờ gì trước đó.
  const FB = window.FB && sdkAppId ? (loadSdk(appId), window.FB) : await loadSdk(appId);
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
  fields: 'id,name,access_token,category,fan_count,followers_count,link,picture{url},tasks',
});

// Page mà tài khoản được phép đăng bài (cần task CREATE_CONTENT). Thiếu dữ liệu tasks → coi như được.
export const canPost = (page) => !Array.isArray(page.tasks) || page.tasks.includes('CREATE_CONTENT');

// Quyền cần để đăng bài mà người dùng đã từ chối / chưa cấp.
export async function missingScopes(userToken) {
  const { data = [] } = await get('me/permissions', { access_token: userToken });
  const granted = new Set(data.filter((p) => p.status === 'granted').map((p) => p.permission));
  return ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'].filter((s) => !granted.has(s));
}

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

// Cách xử lý khi đăng hàng loạt gặp lỗi:
//   'stop'  → các Page còn lại chắc chắn cũng lỗi (token hết hạn, vượt giới hạn App/tài khoản, bị chặn spam)
//   'retry' → lỗi tạm thời, thử lại 1 lần sau vài giây
//   'skip'  → lỗi riêng của Page này, chuyển sang Page tiếp theo
export function errorAction(err) {
  if (!(err instanceof GraphError)) return err instanceof TypeError ? 'retry' : 'skip';
  if (err.code === 190 && err.subcode === 492) return 'skip'; // mất vai trò trên riêng Page này
  if ([190, 102, 4, 17, 341, 368].includes(err.code)) return 'stop';
  if (err.transient || [1, 2, 32, 80001].includes(err.code)) return 'retry';
  return 'skip';
}

const TOKEN_SUBCODES = {
  463: 'Token đã hết hạn — hãy kết nối lại.',
  460: 'Mật khẩu Facebook vừa đổi nên token mất hiệu lực — hãy kết nối lại.',
  458: 'Bạn đã gỡ quyền của App — hãy kết nối lại và cấp quyền.',
  492: 'Tài khoản không còn vai trò trên Page này.',
};

export function explain(err) {
  if (err instanceof TypeError) return 'Mất kết nối mạng hoặc trình duyệt chặn yêu cầu tới Facebook — kiểm tra mạng rồi thử lại.';
  if (!(err instanceof GraphError)) return err.message;
  const map = {
    190: TOKEN_SUBCODES[err.subcode] || 'Token hết hạn hoặc không hợp lệ — hãy kết nối lại.',
    102: 'Phiên đăng nhập không hợp lệ — hãy kết nối lại.',
    200: 'Thiếu quyền đăng bài trên Page này (cần quyền pages_manage_posts và vai trò được tạo nội dung).',
    10: 'App chưa được cấp quyền này (cần là admin/tester của App hoặc qua App Review).',
    368: 'Facebook tạm chặn do nghi ngờ spam — dừng đăng và giảm tần suất.',
    4: 'Vượt giới hạn gọi API của App — đợi một lúc rồi thử lại.',
    17: 'Vượt giới hạn gọi API của tài khoản — đợi một lúc rồi thử lại.',
    341: 'App đã chạm giới hạn — đợi một lúc rồi thử lại.',
    32: 'Vượt giới hạn gọi API của Page — thử lại sau.',
    80001: 'Page này bị gọi API quá nhiều — thử lại sau.',
    1: 'Lỗi tạm thời phía Facebook — thử lại sau.',
    2: 'Facebook tạm thời gián đoạn — thử lại sau.',
    506: 'Nội dung trùng với bài vừa đăng trên Page này — Facebook không cho đăng lặp.',
    324: 'Không đọc được file ảnh — chọn ảnh JPG/PNG khác.',
    352: 'Định dạng video không được hỗ trợ — dùng MP4.',
    351: 'File video bị lỗi — thử xuất lại video (MP4).',
    6000: 'Upload video thất bại — thử lại hoặc dùng file nhỏ hơn.',
    100: 'Tham số không hợp lệ.',
  };
  const base = err.userMsg || map[err.code];
  const trace = err.traceId ? ` · mã tra cứu ${err.traceId}` : '';
  return base ? `${base} (${err.message}${trace})` : `${err.message}${trace}`;
}
