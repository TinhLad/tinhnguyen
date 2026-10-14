// Tạo video slideshow (ảnh + chữ + nhạc nền) bằng ffmpeg.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const FONT = process.env.VIDEO_FONT || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FORMATS = {
  '9:16': [1080, 1920], // Reels / Story
  '1:1': [1080, 1080],  // Feed vuông
  '16:9': [1920, 1080], // Ngang
};

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error(`Không chạy được ffmpeg: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg lỗi: ${err.slice(-800)}`))));
  });
}

// drawtext không tự xuống dòng → tự ngắt theo số ký tự.
function wrap(text, maxChars) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if ((line + ' ' + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/**
 * @param {object} o
 * @param {string[]} o.images  đường dẫn ảnh (có thể rỗng → nền màu)
 * @param {string[]} o.texts   chữ cho từng cảnh
 * @param {string}  [o.audio]  file nhạc nền
 * @param {string}  o.format   '9:16' | '1:1' | '16:9'
 * @param {number}  o.seconds  thời lượng mỗi cảnh
 * @param {string}  o.outDir
 */
export async function makeSlideshow({ images = [], texts = [], audio, format = '9:16', seconds = 3, outDir, bgColor = '#1e3a8a' }) {
  const [W, H] = FORMATS[format] || FORMATS['9:16'];
  const n = Math.max(images.length, texts.length, 1);
  const dur = Math.min(Math.max(Number(seconds) || 3, 1), 15);
  const fps = 30;
  const id = crypto.randomBytes(6).toString('hex');
  const work = path.join(outDir, `tmp-${id}`);
  await fs.mkdir(work, { recursive: true });

  try {
    const fontSize = Math.round(W / 15);
    const segments = [];
    for (let i = 0; i < n; i++) {
      const seg = path.join(work, `seg${i}.mp4`);
      const textFile = path.join(work, `t${i}.txt`);
      const text = texts[i] ? wrap(texts[i], Math.floor(W / (fontSize * 0.62))) : '';
      await fs.writeFile(textFile, text);

      const img = images.length ? images[i % images.length] : null;
      const input = img
        ? ['-loop', '1', '-t', String(dur), '-i', img]
        : ['-f', 'lavfi', '-t', String(dur), '-i', `color=c=${bgColor.replace('#', '0x')}:s=${W}x${H}:r=${fps}`];

      // Ảnh: phủ kín khung (crop) + zoom nhẹ kiểu Ken Burns. Chữ: hộp nền mờ ở 2/3 dưới khung.
      const frames = dur * fps;
      const filters = [
        img && `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2}`,
        img && `zoompan=z='min(zoom+0.0008,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${fps}`,
        text && `drawtext=fontfile=${FONT}:textfile=${textFile}:fontcolor=white:fontsize=${fontSize}:line_spacing=${Math.round(fontSize / 3)}:box=1:boxcolor=black@0.45:boxborderw=${Math.round(fontSize / 2)}:x=(w-text_w)/2:y=h*0.68-text_h/2`,
        `fade=t=in:st=0:d=0.4,fade=t=out:st=${dur - 0.4}:d=0.4`,
        'format=yuv420p',
      ].filter(Boolean).join(',');

      await run([...input, '-vf', filters, '-r', String(fps), '-t', String(dur),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', seg]);
      segments.push(seg);
    }

    const list = path.join(work, 'list.txt');
    await fs.writeFile(list, segments.map((s) => `file '${s}'`).join('\n'));
    const out = path.join(outDir, `video-${id}.mp4`);
    const total = n * dur;

    if (audio) {
      await run(['-f', 'concat', '-safe', '0', '-i', list, '-i', audio,
        '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
        '-af', `afade=t=out:st=${Math.max(total - 1.5, 0)}:d=1.5`, '-t', String(total),
        '-movflags', '+faststart', out]);
    } else {
      await run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
    }
    return { file: out, seconds: total, width: W, height: H };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
