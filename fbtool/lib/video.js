// Dựng video slideshow ngay trên trình duyệt: vẽ từng khung lên <canvas> rồi ghi lại bằng MediaRecorder.
const FORMATS = { '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] };

const loadImage = (file) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error(`Không đọc được ảnh ${file.name}`));
  img.src = URL.createObjectURL(file);
});

function pickMime() {
  const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return list.find((m) => window.MediaRecorder?.isTypeSupported(m));
}

function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

// Ảnh phủ kín khung (cover) + zoom nhẹ kiểu Ken Burns.
function drawCover(ctx, img, W, H, zoom) {
  const scale = Math.max(W / img.width, H / img.height) * zoom;
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

function drawCaption(ctx, text, W, H) {
  if (!text) return;
  const size = Math.round(W / 15);
  ctx.font = `bold ${size}px system-ui, "Segoe UI", Roboto, Arial, sans-serif`;
  const lines = wrapLines(ctx, text, W * 0.82);
  const lh = size * 1.3;
  const pad = size * 0.5;
  const boxH = lines.length * lh + pad * 2;
  const top = H * 0.68 - boxH / 2;
  const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect((W - boxW) / 2, top, boxW, boxH);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, W / 2, top + pad + lh * i + lh / 2));
}

/**
 * @returns {Promise<{blob: Blob, seconds: number, ext: string}>}
 */
export async function makeSlideshow({ images = [], texts = [], audio, format = '9:16', seconds = 3, bgColor = '#1e3a8a', onProgress }) {
  const mime = pickMime();
  if (!mime) throw new Error('Trình duyệt không hỗ trợ ghi video — hãy dùng Chrome hoặc Edge bản mới.');
  const [W, H] = FORMATS[format] || FORMATS['9:16'];
  // Phần tử null = cảnh không có ảnh (chỉ nền màu + chữ), giữ đúng thứ tự cảnh.
  const imgs = await Promise.all([...images].map((f) => (f ? loadImage(f) : null)));
  const n = Math.max(imgs.length, texts.length, 1);
  const dur = Math.min(Math.max(Number(seconds) || 3, 1), 15);
  const total = n * dur;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(30);

  let audioCtx;
  let audioEl;
  if (audio) {
    audioCtx = new AudioContext();
    audioEl = new Audio(URL.createObjectURL(audio));
    audioEl.loop = true;
    const src = audioCtx.createMediaElementSource(audioEl);
    const gain = audioCtx.createGain();
    const dest = audioCtx.createMediaStreamDestination();
    src.connect(gain).connect(dest);
    gain.gain.setValueAtTime(1, audioCtx.currentTime + Math.max(total - 1.5, 0));
    gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + total);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  }

  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => (rec.onstop = r));

  const draw = (t) => {
    const i = Math.min(Math.floor(t / dur), n - 1);
    const local = t - i * dur;
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);
    const im = imgs.length ? imgs[i % imgs.length] : null;
    if (im) drawCover(ctx, im, W, H, 1 + 0.12 * (local / dur));
    drawCaption(ctx, texts[i], W, H);
    // Hiệu ứng mờ dần đầu/cuối mỗi cảnh
    const fade = Math.min(local / 0.4, (dur - local) / 0.4, 1);
    if (fade < 1) {
      ctx.fillStyle = `rgba(0,0,0,${1 - Math.max(fade, 0)})`;
      ctx.fillRect(0, 0, W, H);
    }
  };

  draw(0);
  rec.start(250);
  if (audioEl) await audioEl.play();
  const start = performance.now();
  await new Promise((resolve) => {
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      if (t >= total) return resolve();
      draw(t);
      onProgress?.(t / total);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  rec.stop();
  await done;
  audioEl?.pause();
  audioCtx?.close();
  stream.getTracks().forEach((t) => t.stop());
  imgs.forEach((im) => im && URL.revokeObjectURL(im.src));

  const type = mime.split(';')[0];
  return { blob: new Blob(chunks, { type }), seconds: total, ext: type === 'video/mp4' ? 'mp4' : 'webm' };
}
