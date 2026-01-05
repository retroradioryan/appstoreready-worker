import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import archiver from "archiver";

const app = express();
const PORT = process.env.PORT || 3000;
const WORKER_API_SECRET = process.env.WORKER_API_SECRET || "";

const TEMPLATE_BASE_DIR = path.join(process.cwd(), "template", "capacitor-kit", "base");
const DOWNLOAD_TTL_MS = 1000 * 60 * 30;

app.use(cors());
app.use(express.json({ limit: "5mb" }));

function nowISO() { return new Date().toISOString(); }
function makeId(prefix = "job") { return `${prefix}_${crypto.randomBytes(8).toString("hex")}`; }

function isValidUrl(u) {
  try { const url = new URL(u); return ["http:", "https:"].includes(url.protocol); }
  catch { return false; }
}

function requireWorkerSecret(req, res, next) {
  if (!WORKER_API_SECRET) return next();
  const provided = req.headers["x-worker-secret"];
  if (!provided || provided !== WORKER_API_SECRET) return res.status(401).json({ status: "unauthorized" });
  next();
}

app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.json({ status: "ok", time: nowISO() }));

const JOBS = new Map();
const DOWNLOADS = new Map();

function addLog(job, message, level = "info") { job.logs.push({ ts: nowISO(), level, message }); }

function slugifyAppId(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 32) || "myapp";
}
function deriveBundleIds(appName) {
  const base = slugifyAppId(appName);
  return { bundleId: `com.appstoreready.${base}`, packageName: `com.appstoreready.${base}` };
}

function ensureTemplateExists() {
  if (!fs.existsSync(TEMPLATE_BASE_DIR)) {
    throw new Error(`Template not found at ${TEMPLATE_BASE_DIR}. You must add template/capacitor-kit/base with ios/ and android/.`);
  }
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function replacePlaceholdersInFile(filePath, replacements) {
  const raw = fs.readFileSync(filePath, "utf8");
  let out = raw;
  for (const [k, v] of Object.entries(replacements)) out = out.split(k).join(v);
  fs.writeFileSync(filePath, out, "utf8");
}

function walkFiles(dir, cb) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, cb);
    else cb(full);
  }
}

async function zipDirectory(sourceDir, outZipPath) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function processBuildKitJob(jobId) {
  const job = JOBS.get(jobId);
  if (!job) return;

  job.status = "running";
  job.progress_step = "package";

  try {
    ensureTemplateExists();
    addLog(job, "Template found. Copying base kit…");

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "appstoreready-"));
    const kitDirName = `${job.input.appName.replace(/\s+/g, "_")}_build_kit`;
    const kitDir = path.join(tmpRoot, kitDirName);

    copyDirRecursive(TEMPLATE_BASE_DIR, kitDir);

    const derived = deriveBundleIds(job.input.appName);
    const bundleId = job.input.bundleId || derived.bundleId;
    const packageName = job.input.packageName || derived.packageName;

    addLog(job, `Using bundleId=${bundleId} packageName=${packageName}`);

    const replacements = {
      "{{APP_NAME}}": job.input.appName,
      "{{APP_URL}}": job.input.appUrl,
      "{{BUNDLE_ID}}": bundleId,
      "{{PACKAGE_NAME}}": packageName
    };

    walkFiles(kitDir, (file) => {
      const lower = file.toLowerCase();
      if (
        lower.endsWith(".md") || lower.endsWith(".json") || lower.endsWith(".txt") ||
        lower.endsWith(".xml") || lower.endsWith(".gradle") || lower.endsWith(".plist")
      ) {
        try { replacePlaceholdersInFile(file, replacements); } catch {}
      }
    });

    // Remove node_modules if it exists (just in case)
    try { fs.rmSync(path.join(kitDir, "node_modules"), { recursive: true, force: true }); } catch {}

    addLog(job, "Zipping build kit…");
    const zipPath = path.join(tmpRoot, `${kitDirName}.zip`);
    await zipDirectory(kitDir, zipPath);

    const token = crypto.randomBytes(16).toString("hex");
    const expiresAt = Date.now() + DOWNLOAD_TTL_MS;
    DOWNLOADS.set(jobId, { filePath: zipPath, token, expiresAt });

    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const zipUrl = `${baseUrl}/download/${jobId}?token=${token}`;

    job.status = "complete";
    job.progress_step = "done";
    job.output = { generatedAt: nowISO(), zipUrl, message: "Build Kit ready for download." };
    addLog(job, "Build kit complete. Download URL generated.");
  } catch (err) {
    job.status = "error";
    job.progress_step = "error";
    job.error_message = err?.message ? String(err.message) : "Unknown error";
    addLog(job, `Error: ${job.error_message}`, "error");
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [jobId, item] of DOWNLOADS.entries()) {
    if (item.expiresAt <= now) {
      try { fs.unlinkSync(item.filePath); } catch {}
      DOWNLOADS.delete(jobId);
    }
  }
}, 60_000);

app.post("/build-kit", requireWorkerSecret, (req, res) => {
  const { appName, appUrl, platform, framework, notes, bundleId, packageName } = req.body || {};
  const errors = [];

  if (!appName || typeof appName !== "string" || appName.trim().length < 2) errors.push("appName is required (min 2 chars).");
  if (!appUrl || typeof appUrl !== "string" || !isValidUrl(appUrl)) errors.push("appUrl must be a valid http(s) URL.");
  const allowedPlatforms = ["ios", "android", "both"];
  if (!allowedPlatforms.includes(platform)) errors.push(`platform must be one of: ${allowedPlatforms.join(", ")}.`);
  const allowedFrameworks = ["lovable", "nextjs", "vite", "react", "other"];
  if (!allowedFrameworks.includes(framework)) errors.push(`framework must be one of: ${allowedFrameworks.join(", ")}.`);

  if (errors.length) return res.status(400).json({ status: "error", errors });

  const jobId = makeId("kit");
  const job = {
    jobId,
    type: "build_kit",
    status: "queued",
    progress_step: "init",
    createdAt: nowISO(),
    input: {
      appName: appName.trim(),
      appUrl: appUrl.trim(),
      platform,
      framework,
      notes: typeof notes === "string" ? notes.trim() : "",
      bundleId: bundleId || null,
      packageName: packageName || null
    },
    output: null,
    error_message: null,
    logs: []
  };

  addLog(job, "Build kit job created.");
  JOBS.set(jobId, job);
  setTimeout(() => processBuildKitJob(jobId), 50);

  return res.json({ status: "accepted", jobId, next: { poll: `/jobs/${jobId}` } });
});

app.get("/download/:jobId", (req, res) => {
  const { jobId } = req.params;
  const token = req.query.token;

  const item = DOWNLOADS.get(jobId);
  if (!item) return res.status(404).json({ status: "not_found" });
  if (!token || token !== item.token) return res.status(401).json({ status: "unauthorized" });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${jobId}.zip"`);

  fs.createReadStream(item.filePath).pipe(res);
});

app.get("/jobs/:jobId", requireWorkerSecret, (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: "not_found" });
  res.json(job);
});

app.use((req, res) => res.status(404).json({ status: "not_found" }));

app.listen(PORT, "0.0.0.0", () => console.log(`Worker running on port ${PORT}`));
