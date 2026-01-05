import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import archiver from "archiver";
import { createRequire } from "module";
const require = createRequire(import.meta.url);


const app = express();

// --------------------
// Config
// --------------------
const PORT = process.env.PORT || 3000;

// Optional security header: x-worker-secret
const WORKER_API_SECRET = process.env.WORKER_API_SECRET || "";

// Base URL for download links (Render public URL)
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://appstoreready-worker.onrender.com";

// Where generated zip files are stored (ephemeral on Render, fine for now)
const KIT_DIR = process.env.KIT_DIR || path.join(os.tmpdir(), "appstoreready_kits");

// Where template zip is expected to exist in repo
const TEMPLATE_ZIP_PATH =
  process.env.TEMPLATE_ZIP_PATH || path.join(process.cwd(), "template.zip");

// --------------------
// Middleware
// --------------------
app.use(cors());
app.use(express.json({ limit: "10mb" }));

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

// --------------------
// Jobs (in-memory)
// --------------------
const JOBS = new Map(); // jobId -> job

function addLog(job, message, level = "info") {
  job.logs.push({ ts: nowISO(), level, message });
}

function safeText(s, max = 5000) {
  if (!s) return "";
  const str = String(s);
  return str.length > max ? str.slice(0, max) : str;
}

// --------------------
// HTML parsing helpers
// --------------------
function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasTag(html, regex) {
  return regex.test(String(html || ""));
}

function extractTitle(html) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1]).slice(0, 200) : "";
}

function extractMetaDescription(html) {
  const s = String(html || "");
  const m =
    s.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    s.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i);
  return m ? m[1].trim().slice(0, 240) : "";
}

function extractLinks(html) {
  const links = [];
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  const s = String(html || "");
  let m;
  while ((m = re.exec(s)) !== null) {
    links.push(m[1]);
    if (links.length > 500) break;
  }
  return links;
}

function classify(status, message) {
  return { status, message };
}

async function fetchWithTimeout(url, ms = 9000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "AppStoreReadyWorker/1.0 (+https://appstoreready-worker.onrender.com)",
      },
    });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(t);
  }
}

// --------------------
// Readiness report
// --------------------
function buildReadinessReport({ input, fetched }) {
  const { appUrl, hasLogin, hasPayments } = input;

  const sections = [];
  const finalUrl = fetched?.finalUrl || appUrl;

  const finalUsesHttps = (() => {
    try {
      return new URL(finalUrl).protocol === "https:";
    } catch {
      return false;
    }
  })();

  const html = fetched?.html || "";
  const title = fetched?.title || "";
  const desc = fetched?.description || "";

  const hasViewport = hasTag(html, /<meta[^>]+name=["']viewport["']/i);
  const hasManifest = hasTag(html, /<link[^>]+rel=["']manifest["']/i);
  const hasAppleTouchIcon = hasTag(html, /<link[^>]+rel=["']apple-touch-icon["']/i);
  const hasFavicon =
    hasTag(html, /<link[^>]+rel=["']icon["']/i) ||
    hasTag(html, /<link[^>]+rel=["']shortcut icon["']/i);

  const links = extractLinks(html).map((l) => String(l).toLowerCase());
  const hasPrivacyLink = links.some((l) => l.includes("privacy"));
  const hasTermsLink = links.some((l) => l.includes("terms") || l.includes("conditions"));

  // Identity
  {
    const items = [];
    items.push(
      title
        ? classify("PASS", `Page title detected: “${title}”`)
        : classify("WARN", "No <title> detected on the homepage. Add a clear title.")
    );
    items.push(
      desc
        ? classify("PASS", "Meta description detected (good for store listing clarity).")
        : classify("WARN", "No meta description found. Add a short description.")
    );
    items.push(
      hasViewport
        ? classify("PASS", "Viewport meta tag found (mobile-friendly signal).")
        : classify("WARN", "No viewport meta tag found (could hurt mobile layout).")
    );
    sections.push({ id: "identity", title: "App Identity", items });
  }

  // Media
  {
    const items = [];
    items.push(classify("WARN", "Store screenshots are not verified yet. You’ll need screenshots."));
    items.push(classify("PASS", "Fast Track can generate placeholder screenshots (optional) later."));
    sections.push({ id: "media", title: "Screenshots & Media", items });
  }

  // Privacy
  {
    const items = [];
    items.push(
      finalUsesHttps
        ? classify("PASS", `HTTPS confirmed (final URL: ${finalUrl}).`)
        : classify("FAIL", "Your app is not loading over HTTPS (common submission blocker).")
    );
    items.push(
      hasPrivacyLink
        ? classify("PASS", "A “Privacy” link appears on the homepage.")
        : classify("WARN", "No obvious “Privacy” link detected. Ensure a public Privacy Policy URL exists.")
    );
    items.push(
      hasTermsLink
        ? classify("PASS", "A “Terms” link appears on the homepage.")
        : classify("WARN", "No obvious “Terms” link detected. Terms are recommended.")
    );
    items.push(
      hasPayments
        ? classify("WARN", "Payments detected: ensure Apple/Google compliant implementation.")
        : classify("PASS", "No payments flagged (simpler compliance path).")
    );
    sections.push({ id: "privacy", title: "Privacy & Compliance", items });
  }

  // Functionality
  {
    const items = [];
    items.push(
      classify("WARN", "If this is a pure web wrapper, add native polish (splash/loading/error states).")
    );
    items.push(
      hasManifest
        ? classify("PASS", "Web manifest detected (PWA readiness).")
        : classify("WARN", "No web manifest detected (not required, but helps).")
    );
    items.push(
      hasFavicon
        ? classify("PASS", "Icon/favicons detected.")
        : classify("WARN", "No obvious icons detected. You’ll need app icons.")
    );
    items.push(
      hasAppleTouchIcon
        ? classify("PASS", "Apple touch icon detected.")
        : classify("WARN", "No apple-touch-icon detected.")
    );
    sections.push({ id: "functionality", title: "Functionality Expectations", items });
  }

  // Reviewer
  {
    const items = [];
    if (hasLogin) {
      items.push(classify("WARN", "Login detected: you must provide reviewer access / demo account."));
      items.push(classify("WARN", "If using social login, Apple may require Sign in with Apple."));
    } else {
      items.push(classify("PASS", "No login flagged (simpler review access)."));
    }
    items.push(classify("PASS", "Fast Track can generate Reviewer Notes template later."));
    sections.push({ id: "reviewer", title: "Reviewer Clarity", items });
  }

  const allItems = sections.flatMap((s) => s.items);
  const hasFail = allItems.some((i) => i.status === "FAIL");
  const hasWarn = allItems.some((i) => i.status === "WARN");

  const readiness = hasFail ? "High Risk" : hasWarn ? "Minor Risk" : "Ready";

  const topRisks = [];
  if (!finalUsesHttps) topRisks.push("Not loading over HTTPS (common blocker).");
  if (!hasPrivacyLink) topRisks.push("Privacy Policy link not detected (must be publicly accessible).");
  if (hasLogin) topRisks.push("Login requires reviewer access (demo account) for review.");

  const nextSteps = [];
  if (!hasPrivacyLink) nextSteps.push("Add a clear Privacy Policy link and ensure it’s publicly accessible.");
  nextSteps.push("Prepare App Store / Google Play screenshots (placeholders later if needed).");

  return {
    readiness,
    summary: {
      appTitle: title || null,
      finalUrl,
      usesHttps: finalUsesHttps,
      detected: {
        viewportMeta: hasViewport,
        manifest: hasManifest,
        appleTouchIcon: hasAppleTouchIcon,
        favicon: hasFavicon,
        privacyLinkLikely: hasPrivacyLink,
        termsLinkLikely: hasTermsLink,
      },
    },
    topRisks: topRisks.slice(0, 3),
    nextSteps: nextSteps.slice(0, 6),
    sections,
  };
}

// --------------------
// Build Kit helpers
// --------------------
function slugifyAppName(appName) {
  return String(appName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "myapp";
}

function deriveIds(appName) {
  const slug = slugifyAppName(appName);
  // simple deterministic defaults
  const bundleId = `com.appstoreready.${slug}`;
  const packageName = `com.appstoreready.${slug.replace(/-/g, "")}`;
  return { bundleId, packageName };
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

function tryUnzipWithSystem(zipPath, outDir) {
  // node:18-slim may or may not have `unzip` installed.
  // We'll try it anyway. If it fails, we fall back.
  const r = spawnSync("unzip", ["-q", zipPath, "-d", outDir], { stdio: "pipe" });
  return r.status === 0;
}

async function unzipTemplate(zipPath, outDir) {
  // 1) Try system unzip
  const ok = tryUnzipWithSystem(zipPath, outDir);
  if (ok) return;

  // 2) Fallback to adm-zip if installed
  try {
    const mod = await import("adm-zip"); // only works if dependency installed
    const AdmZip = mod.default || mod;
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(outDir, true);
    return;
  } catch (e) {
    throw new Error(
      `Could not unzip template.zip. System 'unzip' not available AND adm-zip not installed. ` +
      `Fix: install 'adm-zip' OR add 'unzip' to the Docker image. Original: ${e?.message || e}`
    );
  }
}

async function zipDirectory(sourceDir, outZipPath) {
  await ensureDir(path.dirname(outZipPath));

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    output.on("error", (err) => reject(err));
    archive.on("error", (err) => reject(err));

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function writeAppConfigFiles(rootDir, input) {
  // This is where we make the kit usable:
  // - write a simple CONFIG.json
  // - patch capacitor.config.json if present

  const { appName, appUrl } = input;
  const { bundleId, packageName } = input;

  const config = {
    appName,
    appUrl,
    bundleId,
    packageName,
    generatedAt: nowISO(),
  };

  await fsp.writeFile(
    path.join(rootDir, "APPSTORE_READY_CONFIG.json"),
    JSON.stringify(config, null, 2),
    "utf8"
  );

  const capPath = path.join(rootDir, "capacitor.config.json");
  try {
    const raw = await fsp.readFile(capPath, "utf8");
    const parsed = JSON.parse(raw);

    // common capacitor config fields
    parsed.appName = appName;
    parsed.appId = bundleId; // capacitor uses appId for bundle identifier on iOS/Android
    parsed.server = parsed.server || {};
    parsed.server.url = appUrl;
    parsed.server.cleartext = false;

    await fsp.writeFile(capPath, JSON.stringify(parsed, null, 2), "utf8");
  } catch {
    // ignore if not present or invalid json
  }
}

// --------------------
// Job processors
// --------------------
async function processReadinessJob(jobId) {
  const job = JOBS.get(jobId);
  if (!job) return;

  job.status = "running";
  job.progress_step = "analyze";
  addLog(job, "Job started. Fetching app URL…");

  try {
    const { appUrl } = job.input;
    const start = Date.now();

    const { res, text } = await fetchWithTimeout(appUrl, 9000);
    addLog(job, `Fetched URL (status ${res.status}) in ${Date.now() - start}ms`);

    const finalUrl = res.url || appUrl;
    const html = safeText(text, 300000);

    const title = extractTitle(html);
    const description = extractMetaDescription(html);

    job.progress_step = "readiness";
    addLog(job, "Generating readiness report…");

    const report = buildReadinessReport({
      input: job.input,
      fetched: { finalUrl, html, title, description },
    });

    job.output = { generatedAt: nowISO(), report };
    job.status = "complete";
    job.progress_step = "done";
    addLog(job, `Readiness complete: ${report.readiness}`);
  } catch (err) {
    job.status = "error";
    job.progress_step = "error";
    const msg = `Error: ${err?.name || "UnknownError"} - ${err?.message || "Unknown message"}`;
    addLog(job, msg, "error");
    job.error_message = err?.message ? String(err.message) : "Unknown error";
  }
}

async function processBuildKitJob(jobId) {
  const job = JOBS.get(jobId);
  if (!job) return;

  job.status = "running";
  job.progress_step = "init";
  addLog(job, "Build kit started.");

  try {
    // Ensure template.zip exists
    const exists = fs.existsSync(TEMPLATE_ZIP_PATH);
    if (!exists) {
      throw new Error(
        `template.zip not found at ${TEMPLATE_ZIP_PATH}. Place template.zip at repo root or set TEMPLATE_ZIP_PATH.`
      );
    }

    job.progress_step = "unzip";
    addLog(job, "template.zip found. Unzipping…");

    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `kit_${jobId}_`));
    const extractedDir = path.join(workDir, "extracted");
    await ensureDir(extractedDir);

    await unzipTemplate(TEMPLATE_ZIP_PATH, extractedDir);

    // If your template zip contains a single folder, we want that folder as root
    // Otherwise use extractedDir as root.
    const children = await fsp.readdir(extractedDir, { withFileTypes: true });
    const topFolders = children.filter((d) => d.isDirectory()).map((d) => d.name);
    const kitRoot =
      topFolders.length === 1 && children.length >= 1
        ? path.join(extractedDir, topFolders[0])
        : extractedDir;

    job.progress_step = "configure";
    addLog(job, "Applying app config (appName/appUrl/bundleId)…");

    await writeAppConfigFiles(kitRoot, job.input);

    job.progress_step = "zip";
    addLog(job, "Creating Build Kit zip…");

    await ensureDir(KIT_DIR);
    const zipPath = path.join(KIT_DIR, `${jobId}.zip`);
    await zipDirectory(kitRoot, zipPath);

    const downloadPath = `/download/${jobId}`;
    const downloadUrl = `${PUBLIC_BASE_URL}${downloadPath}`;

    job.output = {
      generatedAt: nowISO(),
      zipUrl: downloadUrl,
      downloadPath,
      message: "Build Kit ready. Use zipUrl to download.",
    };

    job.status = "complete";
    job.progress_step = "done";
    addLog(job, "Build kit complete.");
  } catch (err) {
    job.status = "error";
    job.progress_step = "error";
    const msg = err?.message ? String(err.message) : "Unknown error";
    addLog(job, `Error: ${msg}`, "error");
    job.error_message = msg;
  }
}

// --------------------
// Routes
// --------------------
app.get("/", (req, res) => res.status(200).send("ok"));

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: nowISO() });
});

// Download the generated kit
app.get("/download/:jobId", requireWorkerSecret, async (req, res) => {
  const { jobId } = req.params;

  // Only allow download for build_kit jobs that completed
  const job = JOBS.get(jobId);
  if (!job || job.type !== "build_kit") return res.status(404).json({ status: "not_found" });
  if (job.status !== "complete") {
    return res.status(400).json({ status: "not_ready", jobStatus: job.status });
  }

  const zipPath = path.join(KIT_DIR, `${jobId}.zip`);
  if (!fs.existsSync(zipPath)) return res.status(404).json({ status: "zip_missing" });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${job.input.appName || "build_kit"}.zip"`);
  fs.createReadStream(zipPath).pipe(res);
});

// Create readiness job
app.post("/prepare-app", requireWorkerSecret, (req, res) => {
  const { appName, appUrl, platform, framework, notes, hasLogin, hasPayments } = req.body || {};
  const errors = [];

  if (!appName || typeof appName !== "string" || appName.trim().length < 2) {
    errors.push("appName is required (min 2 chars).");
  }
  if (!appUrl || typeof appUrl !== "string" || !isValidUrl(appUrl)) {
    errors.push("appUrl must be a valid http(s) URL to your web app.");
  }

  const allowedPlatforms = ["ios", "android", "both"];
  if (!allowedPlatforms.includes(platform)) errors.push(`platform must be one of: ${allowedPlatforms.join(", ")}.`);

  const allowedFrameworks = ["lovable", "nextjs", "vite", "react", "other"];
  if (!allowedFrameworks.includes(framework)) errors.push(`framework must be one of: ${allowedFrameworks.join(", ")}.`);

  if (typeof hasLogin !== "boolean") errors.push("hasLogin must be true or false.");
  if (typeof hasPayments !== "boolean") errors.push("hasPayments must be true or false.");

  if (errors.length) return res.status(400).json({ status: "error", errors });

  const jobId = makeId("prep");

  const job = {
    jobId,
    type: "submission_readiness",
    status: "queued",
    progress_step: "input",
    createdAt: nowISO(),
    input: {
      appName: appName.trim(),
      appUrl: appUrl.trim(),
      platform,
      framework,
      notes: typeof notes === "string" ? notes.trim() : "",
      hasLogin,
      hasPayments,
    },
    output: null,
    error_message: null,
    logs: [],
  };

  addLog(job, "Job created.");
  JOBS.set(jobId, job);
  setTimeout(() => processReadinessJob(jobId), 50);

  return res.json({
    status: "accepted",
    jobId,
    message: "Job created. Use GET /jobs/:jobId to check status.",
    next: { poll: `/jobs/${jobId}` },
  });
});

// Create build kit job (real zip)
app.post("/build-kit", requireWorkerSecret, (req, res) => {
  const { appName, appUrl, platform, framework, notes, bundleId, packageName } = req.body || {};
  const errors = [];

  if (!appName || typeof appName !== "string" || appName.trim().length < 2) {
    errors.push("appName is required (min 2 chars).");
  }
  if (!appUrl || typeof appUrl !== "string" || !isValidUrl(appUrl)) {
    errors.push("appUrl must be a valid http(s) URL to your web app.");
  }

  const allowedPlatforms = ["ios", "android", "both"];
  if (!allowedPlatforms.includes(platform)) errors.push(`platform must be one of: ${allowedPlatforms.join(", ")}.`);

  const allowedFrameworks = ["lovable", "nextjs", "vite", "react", "other"];
  if (!allowedFrameworks.includes(framework)) errors.push(`framework must be one of: ${allowedFrameworks.join(", ")}.`);

  if (bundleId && typeof bundleId !== "string") errors.push("bundleId must be a string.");
  if (packageName && typeof packageName !== "string") errors.push("packageName must be a string.");

  if (errors.length) return res.status(400).json({ status: "error", errors });

  const derived = deriveIds(appName.trim());

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
      bundleId: (bundleId || derived.bundleId).trim(),
      packageName: (packageName || derived.packageName).trim(),
    },
    output: null,
    error_message: null,
    logs: [],
  };

  addLog(job, "Build kit job created.");
  JOBS.set(jobId, job);

  setTimeout(() => processBuildKitJob(jobId), 50);

  return res.json({
    status: "accepted",
    jobId,
    message: "Build kit job created. Use GET /jobs/:jobId to check status.",
    next: { poll: `/jobs/${jobId}` },
  });
});

// Job polling
app.get("/jobs/:jobId", requireWorkerSecret, (req, res) => {
  const { jobId } = req.params;
  const job = JOBS.get(jobId);
  if (!job) return res.status(404).json({ status: "not_found" });
  res.json(job);
});

// Recent jobs
app.get("/jobs", requireWorkerSecret, (req, res) => {
  const list = Array.from(JOBS.values())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 25);

  res.json({ count: list.length, jobs: list });
});

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ status: "not_found" });
});

// Start server
app.listen(PORT, "0.0.0.0", async () => {
  try {
    await ensureDir(KIT_DIR);
  } catch {}
  console.log(`Worker running on port ${PORT}`);
  console.log(`Template zip path: ${TEMPLATE_ZIP_PATH}`);
  console.log(`Kit output dir: ${KIT_DIR}`);
});


