import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import archiver from "archiver";

const app = express();
const PORT = process.env.PORT || 3000;

// Optional security: if set, require header x-worker-secret to match it.
const WORKER_API_SECRET = process.env.WORKER_API_SECRET || "";

// We now support BOTH:
// A) repo-root template.zip  (recommended for GitHub UI uploads)
// B) unzipped folder template/capacitor-kit/base (optional)
const TEMPLATE_ZIP_PATH = path.join(process.cwd(), "template.zip");
const TEMPLATE_BASE_DIR = path.join(process.cwd(), "template", "capacitor-kit", "base");

// Download links expire after 30 minutes
const DOWNLOAD_TTL_MS = 1000 * 60 * 30;

app.use(cors());
app.use(express.json({ limit: "8mb" }));

function nowISO() {
  return new Date().toISOString();
}
function makeId(prefix = "job") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}
function isValidUrl(u) {
  try {
    const url = new URL(u);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}
function requireWorkerSecret(req, res, next) {
  if (!WORKER_API_SECRET) return next();
  const provided = req.headers["x-worker-secret"];
  if (!provided || provided !== WORKER_API_SECRET) {
    return res.status(401).json({ status: "unauthorized" });
  }
  next();
}

app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.json({ status: "ok", time: nowISO() }));

// --------------------
// In-memory jobs & downloads
// --------------------
const JOBS = new Map(); // jobId -> job
const DOWNLOADS = new Map(); // jobId -> { filePath, token, expiresAt }

function addLog(job, message, level = "info") {
  job.logs.push({ ts: nowISO(), level, message });
}

function slugifyAppId(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 32) || "myapp";
}

function deriveIds(appName) {
  const base = slugifyAppId(appName);
  return {
    bundleId: `com.appstoreready.${base}`,
    packageName: `com.appstoreready.${base}`,
  };
}

// --------------------
// File helpers
// --------------------
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

function walkFiles(dir, cb) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, cb);
    else cb(full);
  }
}

function replaceTokensInTextFile(filePath, replacements) {
  const ext = path.extname(filePath).toLowerCase();
  const allowed = new Set([
    ".md", ".txt", ".json", ".xml", ".plist", ".gradle", ".properties", ".yaml", ".yml"
  ]);
  if (!allowed.has(ext)) return;

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    let out = raw;
    for (const [k, v] of Object.entries(replacements)) {
      out = out.split(k).join(v);
    }
    if (out !== raw) fs.writeFileSync(filePath, out, "utf8");
  } catch {
    // ignore binary/non-utf8
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

// Unzip using archiver's companion "unzipper" would require another dep.
// Instead: use system "unzip" if available (it is on Render & macOS linux base images).
function unzipWithSystem(zipPath, destDir) {
  // We avoid importing child_process at top to keep file simple.
  const { execSync } = require("child_process");
  fs.mkdirSync(destDir, { recursive: true });
  execSync(`unzip -qq "${zipPath}" -d "${destDir}"`);
}

// Determine where the base template exists after unzip.
// Your zip should contain a top-level "template/" folder (because you zipped the folder itself).
function resolveBaseFromUnzipped(unzippedRoot) {
  // Most common: unzippedRoot/template/capacitor-kit/base
  const p1 = path.join(unzippedRoot, "template", "capacitor-kit", "base");
  if (fs.existsSync(p1)) return p1;

  // Alternative: unzippedRoot/capacitor-kit/base (if someone zipped inner contents)
  const p2 = path.join(unzippedRoot, "capacitor-kit", "base");
  if (fs.existsSync(p2)) return p2;

  // Alternative: unzippedRoot/base
  const p3 = path.join(unzippedRoot, "base");
  if (fs.existsSync(p3)) return p3;

  return null;
}

function ensureTemplateAvailable() {
  const zipExists = fs.existsSync(TEMPLATE_ZIP_PATH);
  const dirExists = fs.existsSync(TEMPLATE_BASE_DIR);

  if (!zipExists && !dirExists) {
    throw new Error(
      `No template found. Upload template.zip to repo root OR provide folder template/capacitor-kit/base.`
    );
  }
}

// --------------------
// Build Kit processor (REAL: zip + download)
// --------------------
async function processBuildKitJob(jobId) {
  const job = JOBS.get(jobId);
  if (!job) return;

  job.status = "running";
  job.progress_step = "prepare";
  addLog(job, "Build kit started.");

  try {
    ensureTemplateAvailable();

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "appstoreready-"));
    let baseTemplatePath = null;

    // Prefer template.zip if present (best for GitHub UI)
    if (fs.existsSync(TEMPLATE_ZIP_PATH)) {
      job.progress_step = "unzip";
      addLog(job, "template.zip found. Unzipping…");

      const unzipDir = path.join(tmpRoot, "unzipped_template");
      unzipWithSystem(TEMPLATE_ZIP_PATH, unzipDir);

      baseTemplatePath = resolveBaseFromUnzipped(unzipDir);
      if (!baseTemplatePath) {
        throw new Error(
          `Unzipped template.zip but couldn't find base folder. Expected template/capacitor-kit/base inside the zip.`
        );
      }
    } else {
      // Fallback: unzipped template exists in repo
      baseTemplatePath = TEMPLATE_BASE_DIR;
      addLog(job, "Using unzipped template folder from repo.");
    }

    // Create a kit folder to modify
    job.progress_step = "copy";
    addLog(job, "Copying base scaffold…");

    const kitDirName = `${job.input.appName.replace(/\s+/g, "_")}_build_kit`;
    const kitDir = path.join(tmpRoot, kitDirName);
    copyDirRecursive(baseTemplatePath, kitDir);

    // Remove node_modules if present
    try {
      fs.rmSync(path.join(kitDir, "node_modules"), { recursive: true, force: true });
    } catch {}

    // Derive IDs
    const derived = deriveIds(job.input.appName);
    const bundleId = job.input.bundleId || derived.bundleId;
    const packageName = job.input.packageName || derived.packageName;

    job.progress_step = "personalize";
    addLog(job, `Personalizing: bundleId=${bundleId} packageName=${packageName}`);

    // Tokens your template files may include (optional — safe if none exist)
    const replacements = {
      "{{APP_NAME}}": job.input.appName,
      "{{APP_URL}}": job.input.appUrl,
      "{{BUNDLE_ID}}": bundleId,
      "{{PACKAGE_NAME}}": packageName,
    };

    walkFiles(kitDir, (file) => replaceTokensInTextFile(file, replacements));

    // Zip it
    job.progress_step = "zip";
    addLog(job, "Zipping build kit…");

    const zipPath = path.join(tmpRoot, `${kitDirName}.zip`);
    await zipDirectory(kitDir, zipPath);

    // Create secure download link
    const token = crypto.randomBytes(16).toString("hex");
    const expiresAt = Date.now() + DOWNLOAD_TTL_MS;
    DOWNLOADS.set(jobId, { filePath: zipPath, token, expiresAt });

    const baseUrl =
      process.env.RENDER_EXTERNAL_URL ||
      process.env.RENDER_SERVICE_URL ||
      `http://localhost:${PORT}`;

    const zipUrl = `${baseUrl}/download/${jobId}?token=${token}`;

    job.status = "complete";
    job.progress_step = "done";
    job.output = {
      generatedAt: nowISO(),
      zipUrl,
      message: "Build Kit ready for download.",
      derived: { bundleId, packageName },
    };

    addLog(job, "Build kit complete. Download URL generated.");
  } catch (err) {
    job.status = "error";
    job.progress_step = "error";
    job.error_message = err?.message ? String(err.message) : "Unknown error";
    addLog(job, `Error: ${job.error_message}`, "error");
  }
}

// Cleanup expired downloads
setInterval(() => {
  const now = Date.now();
  for (const [jobId, item] of DOWNLOADS.entries()) {
    if (item.expiresAt <= now) {
      try { fs.unlinkSync(item.filePath); } catch {}
      DOWNLOADS.delete(jobId);
    }
  }
}, 60_000);

// --------------------
// API endpoints
// --------------------
app.post("/build-kit", requireWorkerSecret, (req, res) => {
  const { appName, appUrl, platform, framework, notes, bundleId, packageName } = req.body || {};
  const errors = [];

  if (!appName || typeof appName !== "string" || appName.trim().length < 2) {
    errors.push("appName is required (min 2 chars).");
  }
  if (!appUrl || typeof appUrl !== "string" || !isValidUrl(appUrl)) {
    errors.push("appUrl must be a valid http(s) URL.");
  }

  const allowedPlatforms = ["ios", "android", "both"];
  if (!allowedPlatforms.includes(platform)) {
    errors.push(`platform must be one of: ${allowedPlatforms.join(", ")}.`);
  }

  const allowedFrameworks = ["lovable", "nextjs", "vite", "react", "other"];
  if (!allowedFrameworks.includes(framework)) {
    errors.push(`framework must be one of: ${allowedFrameworks.join(", ")}.`);
  }

  if (bundleId && typeof bundleId !== "string") errors.push("bundleId must be a string.");
  if (packageName && typeof packageName !== "string") errors.push("packageName must be a string.");

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
      packageName: packageName || null,
    },
    output: null,
    error_message: null,
    logs: [],
  };

  addLog(job, "Build kit job created.");
  JOBS.set(jobId, job);

  setTimeout(() => processBuildKitJob(jobId), 50);

  res.json({
    status: "accepted",
    jobId,
    message: "Build kit job created. Use GET /jobs/:jobId to check status.",
    next: { poll: `/jobs/${jobId}` },
  });
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

app.get("/jobs", requireWorkerSecret, (req, res) => {
  const list = Array.from(JOBS.values())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 25);
  res.json({ count: list.length, jobs: list });
});

app.use((req, res) => res.status(404).json({ status: "not_found" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Worker running on port ${PORT}`);
});

