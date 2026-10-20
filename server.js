const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG = process.env.FFMPEG_LOCATION || undefined;
const ALLOWED_HOSTS = [
  "youtube.com", "youtu.be", "youtube-nocookie.com",
  "tiktok.com", "instagram.com", "facebook.com", "fb.watch",
  "x.com", "twitter.com", "vimeo.com"
];

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

function validateUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw new Error("Masukkan URL yang valid."); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("URL harus menggunakan HTTP atau HTTPS.");
  const host = u.hostname.toLowerCase();
  const allowed = ALLOWED_HOSTS.some(d => host === d || host.endsWith("." + d));
  if (!allowed) throw new Error("Domain ini belum didukung LinkDrop.");
  if (u.username || u.password) throw new Error("URL dengan kredensial tidak diizinkan.");
  return u.toString();
}

function runYtDlp(url, format, dir) {
  return new Promise((resolve, reject) => {
    const output = path.join(dir, "%(title).100B-%(id)s.%(ext)s");
    const args = [
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--restrict-filenames",
      "--no-part",
      "--max-filesize", "500M",
      "-o", output
    ];
    if (FFMPEG) args.push("--ffmpeg-location", FFMPEG);
    if (format === "mp3") {
      args.push("-x", "--audio-format", "mp3", "--audio-quality", "192K");
    } else {
      args.push("-f", "bv*+ba/b", "--merge-output-format", "mp4");
    }
    args.push(url);

    const child = spawn(YTDLP, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) { settled = true; reject(new Error("Proses terlalu lama. Coba lagi atau gunakan tautan lain.")); }
    }, 180000);

    child.stderr.on("data", chunk => { stderr += chunk.toString(); if (stderr.length > 5000) stderr = stderr.slice(-5000); });
    child.on("error", err => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(new Error("yt-dlp belum terpasang atau tidak ditemukan. Ikuti README untuk memasangnya.")); }
    });
    child.on("close", async code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const message = /ffmpeg/i.test(stderr)
          ? "FFmpeg diperlukan untuk menggabungkan video/audio atau membuat MP3."
          : "Unduhan gagal. Konten mungkin tidak tersedia untuk umum, dibatasi platform, atau tautannya tidak didukung.";
        reject(new Error(message));
        return;
      }
      try {
        const files = (await fsp.readdir(dir)).filter(f => !f.endsWith(".part") && !f.endsWith(".ytdl"));
        if (!files.length) throw new Error("File hasil unduhan tidak ditemukan.");
        const full = path.join(dir, files[0]);
        const stat = await fsp.stat(full);
        if (!stat.isFile() || stat.size === 0) throw new Error("File hasil unduhan kosong.");
        resolve({ full, name: files[0] });
      } catch (e) { reject(e); }
    });
  });
}

app.post("/api/download", async (req, res) => {
  let url;
  try {
    url = validateUrl(req.body?.url);
    const format = req.body?.format;
    if (!["mp4", "mp3"].includes(format)) return res.status(400).json({ error: "Pilih format MP4 atau MP3." });
    const dir = path.join(os.tmpdir(), "linkdrop-" + crypto.randomBytes(8).toString("hex"));
    await fsp.mkdir(dir, { recursive: true });
    try {
      const result = await runYtDlp(url, format, dir);
      const ext = format === "mp3" ? "mp3" : path.extname(result.name).slice(1) || "mp4";
      const safeName = result.name.replace(/[\r\n"]/g, "_");
      res.setHeader("Content-Type", format === "mp3" ? "audio/mpeg" : (ext === "mp4" ? "video/mp4" : "application/octet-stream"));
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.setHeader("Content-Length", String((await fsp.stat(result.full)).size));
      const stream = fs.createReadStream(result.full);
      stream.on("error", () => { if (!res.headersSent) res.status(500); res.end(); });
      stream.on("close", async () => { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); });
      stream.pipe(res);
      req.on("close", () => { if (!res.writableEnded) stream.destroy(); });
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      if (!res.headersSent) res.status(422).json({ error: err.message || "Unduhan gagal." });
    }
  } catch (err) {
    res.status(400).json({ error: err.message || "Permintaan tidak valid." });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`LinkDrop berjalan di http://localhost:${PORT}`));
