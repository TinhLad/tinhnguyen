import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fb from './lib/facebook.js';
import * as ai from './lib/ai.js';
import { makeSlideshow } from './lib/video.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, 'data');
const MEDIA = path.join(here, 'media');
const STORE = path.join(DATA, 'store.json');
const HISTORY = path.join(DATA, 'history.json');
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const REDIRECT = `${BASE_URL}/auth/callback`;
const PUBLISH_DELAY = Number(process.env.PUBLISH_DELAY_MS || 3000);

await fs.mkdir(DATA, { recursive: true });
await fs.mkdir(MEDIA, { recursive: true });

// ---------- Lưu trữ đơn giản (ứng dụng 1 người dùng, chạy local) ----------
const readJSON = async (f, d) => JSON.parse(await fs.readFile(f, 'utf8').catch(() => JSON.stringify(d)));
const writeJSON = (f, v) => fs.writeFile(f, JSON.stringify(v, null, 2));
let store = await readJSON(STORE, {}); // { userToken, user, pages: [{id, name, access_token, ...}] }
const saveStore = () => writeJSON(STORE, store);
const pageById = (id) => store.pages?.find((p) => p.id === id);
const publicPage = ({ access_token, ...rest }) => rest; // không bao giờ trả token ra trình duyệt
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = express();
app.use(express.json({ limit: '2mb' }));

// Bảo vệ bằng mật khẩu nếu deploy lên server công khai.
if (process.env.APP_PASSWORD) {
  app.use((req, res, next) => {
    const [, b64 = ''] = (req.headers.authorization || '').split(' ');
    const pass = Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':');
    if (pass === process.env.APP_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="FB Page Manager"').status(401).send('Cần đăng nhập');
  });
}

app.use(express.static(path.join(here, 'public')));
app.use('/media', express.static(MEDIA));

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error(e);
    res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e instanceof fb.GraphError ? fb.explain(e) : e.message });
  }
};
const needLogin = (req, res, next) => (store.userToken ? next() : res.status(401).json({ error: 'Chưa kết nối Facebook' }));

// ---------- Kết nối Facebook ----------
async function connect(userToken) {
  const user = await fb.me(userToken);
  const pages = await fb.listPages(userToken);
  store = { userToken, user, pages, connectedAt: new Date().toISOString() };
  await saveStore();
  return { user, pages: pages.map(publicPage) };
}

let oauthState = '';
app.get('/auth/login', (req, res) => {
  if (!process.env.FB_APP_ID || !process.env.FB_APP_SECRET) {
    return res.redirect('/?error=' + encodeURIComponent('Chưa điền FB_APP_ID và FB_APP_SECRET trong file .env (xem README mục 2), sau đó tắt và chạy lại npm start. Hoặc dùng Cách 2 — dán Access Token.'));
  }
  oauthState = crypto.randomBytes(12).toString('hex');
  res.redirect(fb.loginUrl(process.env.FB_APP_ID, REDIRECT, oauthState, process.env.FB_LOGIN_CONFIG_ID));
});

app.get('/auth/callback', async (req, res) => {
  try {
    await handleCallback(req, res);
  } catch (e) {
    console.error(e);
    res.redirect('/?error=' + encodeURIComponent('Đăng nhập Facebook thất bại: ' + (e instanceof fb.GraphError ? fb.explain(e) : e.message)));
  }
});

async function handleCallback(req, res) {
  if (req.query.error) return res.redirect('/?error=' + encodeURIComponent(req.query.error_description || req.query.error));
  if (!req.query.state || req.query.state !== oauthState) {
    return res.redirect('/?error=' + encodeURIComponent('Phiên đăng nhập không hợp lệ (có thể do server vừa khởi động lại). Bấm "Đăng nhập với Facebook" lần nữa.'));
  }
  const token = await fb.exchangeCode({
    appId: process.env.FB_APP_ID, appSecret: process.env.FB_APP_SECRET, redirectUri: REDIRECT, code: req.query.code,
  });
  await connect(token);
  res.redirect('/');
}

// Cách nhanh: dán User Access Token lấy từ Graph API Explorer.
app.post('/api/connect-token', wrap(async (req, res) => {
  const raw = String(req.body.token || '').trim();
  if (!raw) return res.status(400).json({ error: 'Thiếu token' });
  const token = await fb.toLongLived({ appId: process.env.FB_APP_ID, appSecret: process.env.FB_APP_SECRET, token: raw });
  res.json(await connect(token));
}));

app.post('/api/logout', wrap(async (req, res) => {
  store = {};
  await saveStore();
  res.json({ ok: true });
}));

app.get('/api/status', (req, res) => res.json({
  connected: Boolean(store.userToken),
  user: store.user || null,
  pageCount: store.pages?.length || 0,
  ai: ai.aiEnabled(),
  oauth: Boolean(process.env.FB_APP_ID && process.env.FB_APP_SECRET),
  redirectUri: REDIRECT,
  scopes: fb.REQUIRED_SCOPES,
}));

// ---------- Đọc & thống kê Page ----------
function stats(posts) {
  const since = Date.now() - 30 * 864e5;
  const recent = posts.filter((p) => new Date(p.created_time).getTime() >= since);
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, p) => s + p.engagement, 0) / arr.length) : 0);
  const byType = {};
  for (const p of posts) (byType[p.type || 'khác'] ??= []).push(p);
  const byHour = {};
  for (const p of posts) (byHour[new Date(p.created_time).getHours()] ??= []).push(p);
  const bestHour = Object.entries(byHour).filter(([, v]) => v.length >= 2).sort((a, b) => avg(b[1]) - avg(a[1]))[0];
  const top = [...posts].sort((a, b) => b.engagement - a.engagement)[0];
  return {
    analyzed: posts.length,
    posts30d: recent.length,
    avgEngagement: avg(posts),
    avgEngagement30d: avg(recent),
    lastPost: posts[0]?.created_time || null,
    byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { count: v.length, avg: avg(v) }])),
    bestHour: bestHour ? Number(bestHour[0]) : null,
    topPost: top || null,
  };
}

async function loadPage(page, limit) {
  try {
    const posts = (await fb.pagePosts(page.id, page.access_token, limit)).map(fb.normalizePost);
    return { ...publicPage(page), posts, stats: stats(posts) };
  } catch (e) {
    return { ...publicPage(page), posts: [], stats: null, error: e instanceof fb.GraphError ? fb.explain(e) : e.message };
  }
}

app.get('/api/pages', needLogin, (req, res) => res.json({ pages: store.pages.map(publicPage) }));

app.post('/api/pages/refresh', needLogin, wrap(async (req, res) => {
  store.pages = await fb.listPages(store.userToken);
  await saveStore();
  res.json({ pages: store.pages.map(publicPage) });
}));

app.get('/api/overview', needLogin, wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const out = [];
  // Chạy theo lô 5 Page để không vượt giới hạn API.
  for (let i = 0; i < store.pages.length; i += 5) {
    out.push(...await Promise.all(store.pages.slice(i, i + 5).map((p) => loadPage(p, limit))));
  }
  res.json({ pages: out, fetchedAt: new Date().toISOString() });
}));

// ---------- AI ----------
const needAI = (req, res, next) => (ai.aiEnabled() ? next() : res.status(400).json({ error: 'Chưa cấu hình ANTHROPIC_API_KEY trong file .env' }));

app.post('/api/ai/analyze', needLogin, needAI, wrap(async (req, res) => {
  const ids = req.body.pageIds?.length ? req.body.pageIds : store.pages.map((p) => p.id);
  const pages = await Promise.all(ids.map(pageById).filter(Boolean).map((p) => loadPage(p, 25)));
  res.json(await ai.analyzePages(pages.filter((p) => !p.error)));
}));

app.post('/api/ai/write', needLogin, needAI, wrap(async (req, res) => {
  const { topic, goal, tone, length, cta, link, pageIds = [] } = req.body;
  if (!topic) return res.status(400).json({ error: 'Nhập chủ đề / thông tin bài viết' });
  const pages = pageIds.map(pageById).filter(Boolean);
  if (!pages.length) return res.status(400).json({ error: 'Chọn ít nhất 1 Page' });
  // Lấy vài bài cũ làm mẫu giọng văn cho từng Page.
  const withSamples = await Promise.all(pages.map(async (p) => {
    const posts = await fb.pagePosts(p.id, p.access_token, 5).catch(() => []);
    return { ...p, samples: posts.map((x) => (x.message || '').slice(0, 300)).filter(Boolean).slice(0, 3) };
  }));
  res.json(await ai.writePost({ topic, goal, tone, length, cta, link, pages: withSamples }));
}));

// ---------- Upload & video ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA,
    filename: (req, file, cb) => cb(null, `up-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(image|video|audio)\//.test(file.mimetype)
    || /\.(jpe?g|png|webp|gif|mp4|mov|m4v|webm|mp3|m4a|aac|wav|ogg)$/i.test(file.originalname)),
});

// Chỉ chấp nhận tên file trong thư mục media (chống path traversal).
const mediaPath = (name) => {
  const base = path.basename(String(name || ''));
  return base ? path.join(MEDIA, base) : null;
};

app.post('/api/upload', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File không hợp lệ (chỉ nhận ảnh/video/audio)' });
  res.json({ name: req.file.filename, url: `/media/${req.file.filename}`, type: req.file.mimetype });
}));

app.post('/api/video', upload.fields([{ name: 'images', maxCount: 20 }, { name: 'audio', maxCount: 1 }]), wrap(async (req, res) => {
  const texts = JSON.parse(req.body.texts || '[]').map(String);
  const images = (req.files?.images || []).map((f) => f.path);
  const audio = req.files?.audio?.[0]?.path;
  const result = await makeSlideshow({
    images, texts, audio, outDir: MEDIA,
    format: req.body.format, seconds: Number(req.body.seconds), bgColor: req.body.bgColor,
  });
  await Promise.all([...images, audio].filter(Boolean).map((f) => fs.rm(f, { force: true })));
  const name = path.basename(result.file);
  res.json({ name, url: `/media/${name}`, seconds: result.seconds });
}));

// ---------- Đăng bài 1 click ----------
/**
 * body: {
 *   kind: 'text'|'link'|'photo'|'video', media?: tên file trong /media, link?, title?, scheduledAt?,
 *   posts: [{ pageId, message }]
 * }
 */
app.post('/api/publish', needLogin, wrap(async (req, res) => {
  const { kind = 'text', media, link, title, scheduledAt, posts = [] } = req.body;
  if (!posts.length) return res.status(400).json({ error: 'Chọn ít nhất 1 Page' });
  const filePath = mediaPath(media);
  if (['photo', 'video'].includes(kind)) {
    if (!filePath || !(await fs.stat(filePath).catch(() => null))) return res.status(400).json({ error: 'Thiếu file ảnh/video' });
  }
  if (scheduledAt) {
    const diff = new Date(scheduledAt).getTime() - Date.now();
    if (!(diff >= 10 * 60e3 && diff <= 30 * 864e5)) return res.status(400).json({ error: 'Lịch đăng phải cách hiện tại từ 10 phút đến 30 ngày' });
  }

  const results = [];
  for (const [i, item] of posts.entries()) {
    const page = pageById(item.pageId);
    if (!page) {
      results.push({ pageId: item.pageId, ok: false, error: 'Page không tồn tại / không có quyền' });
      continue;
    }
    try {
      const r = await fb.publish({
        pageId: page.id, pageToken: page.access_token, kind, message: item.message, link, filePath, title, scheduledAt,
      });
      results.push({ pageId: page.id, pageName: page.name, ok: true, postId: r.postId });
    } catch (e) {
      results.push({ pageId: page.id, pageName: page.name, ok: false, error: e instanceof fb.GraphError ? fb.explain(e) : e.message });
    }
    if (i < posts.length - 1) await sleep(PUBLISH_DELAY); // giãn cách để tránh bị đánh dấu spam
  }

  const history = await readJSON(HISTORY, []);
  history.unshift({
    at: new Date().toISOString(), kind, media: media || null, link: link || null, scheduledAt: scheduledAt || null,
    preview: posts[0]?.message?.slice(0, 160) || '', results,
  });
  await writeJSON(HISTORY, history.slice(0, 500));
  res.json({ results });
}));

app.get('/api/history', wrap(async (req, res) => res.json(await readJSON(HISTORY, []))));

app.listen(PORT, () => {
  console.log(`FB Page Manager đang chạy: ${BASE_URL}`);
  if (!process.env.FB_APP_ID || !process.env.FB_APP_SECRET) console.log('⚠ Chưa có FB_APP_ID / FB_APP_SECRET → nút "Đăng nhập với Facebook" chưa dùng được (vẫn dùng được cách dán token).');
  else console.log(`ℹ Valid OAuth Redirect URI cần khai báo trong Facebook App: ${REDIRECT}`);
  if (!ai.aiEnabled()) console.log('⚠ Chưa có ANTHROPIC_API_KEY → tính năng AI viết bài/phân tích sẽ tắt.');
});
