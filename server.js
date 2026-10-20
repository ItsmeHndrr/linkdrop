
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const TERABOX_RESOLVER_URL = (process.env.TERABOX_RESOLVER_URL || '').trim();
const TERABOX_API_KEY = (process.env.TERABOX_API_KEY || '').trim();
const MAX_BODY = 16 * 1024;

const allowedHosts = new Set([
  'terabox.com', 'www.terabox.com',
  'teraboxapp.com', 'www.teraboxapp.com',
  '1024tera.com', 'www.1024tera.com',
  '1024terabox.com', 'www.1024terabox.com',
  '4funbox.com', 'www.4funbox.com',
  'teraboxlink.com', 'www.teraboxlink.com',
  'terabox.app', 'www.terabox.app',
  'freeterabox.com', 'www.freeterabox.com',
  'terasharelink.com', 'www.terasharelink.com',
  'terasharefile.com', 'www.terasharefile.com',
  'terafileshare.com', 'www.terafileshare.com',
  'teraboxshare.com', 'www.teraboxshare.com'
]);

// Mengirim respons hanya satu kali.
function send(res, status, data, headers = {}) {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    return;
  }

  const isText = typeof data === 'string';
  const body = isText ? data : JSON.stringify(data);

  res.writeHead(status, {
    'content-type': isText
      ? 'text/plain; charset=utf-8'
      : 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    ...headers
  });

  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let finished = false;

    req.on('data', chunk => {
      if (finished) return;

      body += chunk;

      if (body.length > MAX_BODY) {
        finished = true;
        reject(new Error('Body terlalu besar'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (finished) return;

      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('JSON tidak valid'));
      }
    });

    req.on('error', error => {
      if (!finished) reject(error);
    });
  });
}

function isTeraBox(raw) {
  try {
    const url = new URL(raw);

    return (
      ['http:', 'https:'].includes(url.protocol) &&
      allowedHosts.has(url.hostname.toLowerCase()) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function safeFileName(name) {
  return String(name || 'terabox-video')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .slice(0, 180) || 'terabox-video';
}

const server = http.createServer(async (req, res) => {
  const base = `http://${req.headers.host || 'localhost'}`;
  let url;

  try {
    url = new URL(req.url, base);
  } catch {
    return send(res, 400, { error: 'URL permintaan tidak valid' });
  }

  // Cek status server.
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      teraboxConfigured: Boolean(TERABOX_RESOLVER_URL),
      message: TERABOX_RESOLVER_URL
        ? 'Resolver TeraBox terkonfigurasi'
        : 'Resolver TeraBox belum dikonfigurasi'
    });
  }

  // Unduhan MP4 dan MP3.
  if (req.method === 'POST' && url.pathname === '/api/download') {
    let body;

    try {
      body = await readBody(req);
    } catch (error) {
      return send(res, 400, { error: error.message });
    }

    const mediaUrl = String(body.url || '').trim();
    const format = String(body.format || '').toLowerCase();

    let target;

    try {
      target = new URL(mediaUrl);
    } catch {
      return send(res, 400, { error: 'URL tidak valid.' });
    }

    if (
      !['http:', 'https:'].includes(target.protocol) ||
      target.username ||
      target.password
    ) {
      return send(res, 400, {
        error: 'Gunakan tautan HTTP/HTTPS yang valid tanpa informasi login.'
      });
    }

    if (!['mp4', 'mp3'].includes(format)) {
      return send(res, 400, {
        error: 'Format harus MP4 atau MP3.'
      });
    }

    const host = target.hostname.toLowerCase().replace(/^www\./, '');

    const supported =
      /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|vimeo\.com|dailymotion\.com|twitter\.com|x\.com|soundcloud\.com|reddit\.com|twitch\.tv)$/.test(host);

    if (!supported) {
      return send(res, 400, {
        error: 'Domain ini belum didukung oleh pengunduh. Gunakan tautan dari platform yang didukung atau tautan file langsung.'
      });
    }

    const dir = path.join(
      os.tmpdir(),
      'linkdrop-' + crypto.randomBytes(12).toString('hex')
    );

    try {
      await fs.promises.mkdir(dir, { recursive: true });

      const args = [
        '--no-playlist',
        '--no-warnings',
        '--restrict-filenames',
        '--max-filesize', '1G',
        '--socket-timeout', '20',
        '-o', path.join(dir, '%(title).120B.%(ext)s')
      ];

      if (format === 'mp4') {
        args.push(
          '-f',
          'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio/best',
          '--merge-output-format',
          'mp4'
        );
      } else {
        args.push(
          '-x',
          '--audio-format', 'mp3',
          '--audio-quality', '0'
        );
      }

      args.push('--', mediaUrl);

      await execFileAsync(
        process.env.YTDLP_BIN || 'yt-dlp',
        args,
        {
          timeout: 240000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true
        }
      );

      const files = await fs.promises.readdir(dir);

      const candidates = files
        .map(name => ({
          name,
          full: path.join(dir, name)
        }))
        .filter(file => fs.existsSync(file.full));

      if (!candidates.length) {
        throw new Error('Pengunduh tidak menghasilkan file.');
      }

      const selected = candidates.sort(
        (a, b) =>
          fs.statSync(b.full).size - fs.statSync(a.full).size
      )[0];

      const extension = format === 'mp3'
        ? '.mp3'
        : path.extname(selected.name) || '.mp4';

      const safeName = path
        .basename(selected.name, path.extname(selected.name))
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 120) || 'linkdrop';

      const stat = fs.statSync(selected.full);

      res.writeHead(200, {
        'content-type': format === 'mp3'
          ? 'audio/mpeg'
          : 'video/mp4',
        'content-disposition':
          `attachment; filename="${safeName}${extension}"`,
        'content-length': String(stat.size),
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store'
      });

      const stream = fs.createReadStream(selected.full);

      stream.on('error', () => {
        if (!res.headersSent) {
          send(res, 500, {
            error: 'Gagal membaca file hasil unduhan.'
          });
        } else {
          res.destroy();
        }
      });

      stream.on('close', () => {
        fs.promises.rm(dir, {
          recursive: true,
          force: true
        }).catch(() => {});
      });

      // Jangan membatalkan unduhan hanya karena request selesai.
      res.on('close', () => {
        if (!res.writableEnded) {
          stream.destroy();
        }
      });

      stream.pipe(res);

    } catch (error) {
      await fs.promises.rm(dir, {
        recursive: true,
        force: true
      }).catch(() => {});

      const missing = error.code === 'ENOENT';
      const timeout = error.killed || error.code === 'ETIMEDOUT';

      return send(res, 502, {
        error: missing
          ? 'yt-dlp belum terpasang di server. Pasang yt-dlp dan FFmpeg (wajib untuk MP3), lalu coba lagi.'
          : timeout
            ? 'Proses unduhan terlalu lama atau koneksi sumber terputus. Coba lagi dengan koneksi stabil.'
            : 'Unduhan gagal. Pastikan tautan publik, media dapat diakses, dan yt-dlp/FFmpeg versi terbaru terpasang.',
        detail: process.env.NODE_ENV === 'development'
          ? String(error.message).slice(0, 500)
          : undefined
      });
    }
  }

  // Resolver TeraBox eksternal.
  if (
    req.method === 'POST' &&
    url.pathname === '/api/terabox/resolve'
  ) {
    let body;

    try {
      body = await readBody(req);
    } catch (error) {
      return send(res, 400, { error: error.message });
    }

    const shareUrl = String(body.url || '').trim();

    if (!isTeraBox(shareUrl)) {
      return send(res, 400, {
        error: 'Masukkan tautan berbagi TeraBox yang valid.'
      });
    }

    if (!TERABOX_RESOLVER_URL) {
      return send(res, 503, {
        error: 'Backend TeraBox belum dikonfigurasi. Atur TERABOX_RESOLVER_URL ke resolver TeraBox yang kamu host/percaya. Frontend saja tidak dapat mengekstrak tautan unduhan.'
      });
    }

    try {
      const endpoint = new URL(TERABOX_RESOLVER_URL);

      if (
        endpoint.protocol !== 'https:' &&
        !['localhost', '127.0.0.1'].includes(endpoint.hostname)
      ) {
        return send(res, 500, {
          error: 'Resolver eksternal harus menggunakan HTTPS.'
        });
      }

      endpoint.searchParams.set('url', shareUrl);

      const headers = { accept: 'application/json' };

      if (TERABOX_API_KEY) {
        headers['x-api-key'] = TERABOX_API_KEY;
      }

      const upstream = await fetch(endpoint, {
        headers,
        signal: AbortSignal.timeout(25000)
      });

      const raw = await upstream.text();
      let data;

      try {
        data = JSON.parse(raw);
      } catch {
        data = { raw: raw.slice(0, 1000) };
      }

      if (!upstream.ok) {
        return send(res, 502, {
          error: `Resolver TeraBox merespons HTTP ${upstream.status}.`,
          detail: data?.error || data?.message ||
            'Periksa konfigurasi resolver.'
        });
      }

      const files = Array.isArray(data)
        ? data
        : (
          data.files ||
          data.list ||
          data.data?.files ||
          data.data?.list ||
          (data.data ? [data.data] : [])
        );

      const normalized = files.map((file, index) => ({
        id: String(
          file.id ??
          file.fs_id ??
          file.fid ??
          file.file_id ??
          index
        ),
        name: safeFileName(
          file.name ??
          file.filename ??
          file.server_filename ??
          file.title ??
          `File ${index + 1}`
        ),
        size: Number(
          file.size ?? file.filesize ?? 0
        ) || null,
        url:
          file.download_url ??
          file.dlink ??
          file.direct_link ??
          file.url ??
          file.downloadUrl ??
          null,
        type: file.mime_type ?? file.type ?? null
      })).filter(file =>
        file.url && /^https:\/\//i.test(String(file.url))
      );

      if (!normalized.length) {
        return send(res, 502, {
          error: 'Resolver tidak mengembalikan tautan unduhan langsung yang dikenali.',
          detail: data?.message ||
            data?.error ||
            'Coba resolver lain atau periksa format respons API.'
        });
      }

      return send(res, 200, {
        ok: true,
        files: normalized,
        source: 'TeraBox resolver'
      });

    } catch (error) {
      return send(res, 502, {
        error: 'Tidak dapat menghubungi resolver TeraBox.',
        detail: error.name === 'TimeoutError'
          ? 'Permintaan ke resolver melewati batas waktu.'
          : 'Periksa URL resolver dan koneksi server.'
      });
    }
  }

  // Menyajikan frontend dari folder public.
  if (req.method === 'GET' || req.method === 'HEAD') {
    let pathname;

    try {
      pathname = url.pathname === '/'
        ? '/index.html'
        : decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, 'URL file tidak valid');
    }

    const file = path.resolve(PUBLIC_DIR, '.' + pathname);

    if (
      !file.startsWith(PUBLIC_DIR + path.sep) &&
      file !== path.join(PUBLIC_DIR, 'index.html')
    ) {
      return send(res, 403, 'Forbidden');
    }

    fs.readFile(file, (error, buffer) => {
      if (error) {
        return send(res, 404, 'Not found');
      }

      const extension = path.extname(file);

      const types = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.svg': 'image/svg+xml'
      };

      res.writeHead(200, {
        'content-type':
          types[extension] || 'application/octet-stream',
        'x-content-type-options': 'nosniff'
      });

      res.end(req.method === 'HEAD' ? undefined : buffer);
    });

    return;
  }

  return send(res, 404, {
    error: 'Endpoint tidak ditemukan'
  });
});

server.listen(PORT, HOST, () => {
  console.log(`LinkDrop berjalan di http://${HOST}:${PORT}`);
});
