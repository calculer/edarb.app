const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const LESSONS_FILE = path.join(DATA_DIR, "lessons.json");
const CONTENT_FILE = path.join(DATA_DIR, "content.json");
const TABLE = "darb_records";
const BUCKET = process.env.SUPABASE_BUCKET || "darb-files";
const CONTENT_TYPES = new Set(["summary", "exercise", "quiz", "exam", "resource"]);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (Boolean(supabaseUrl) !== Boolean(supabaseKey)) {
    throw new Error("Set SUPABASE_URL and SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY), or neither.");
}
const SUPABASE_ENABLED = Boolean(supabaseUrl && supabaseKey);
const supabase = SUPABASE_ENABLED
    ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV !== "production" ? "123456" : "");
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV !== "production" ? "local-development-secret-change-me" : "");
if (!ADMIN_PASSWORD || !JWT_SECRET) {
    console.error("Set ADMIN_PASSWORD and JWT_SECRET environment variables.");
    process.exit(1);
}

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(LESSONS_FILE)) fs.writeFileSync(LESSONS_FILE, "[]", "utf8");
if (!fs.existsSync(CONTENT_FILE)) fs.writeFileSync(CONTENT_FILE, "[]", "utf8");

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
// Retain access to old locally stored files while old links still exist.
app.use("/uploads", express.static(UPLOADS_DIR));
app.get("/files", async (req, res, next) => {
    try {
        let key = typeof req.query.key === "string" ? req.query.key : "";
        // Older public pages call encodeURI() on this URL, which double-encodes %2F.
        if (key.includes("%")) {
            try { key = decodeURIComponent(key); } catch { return res.status(404).end(); }
        }
        if (!SUPABASE_ENABLED || !key.startsWith("uploads/") || key.split("/").some(part => !part || part === "." || part === "..")) {
            return res.status(404).end();
        }
        const [lessons, content] = await Promise.all([readCollection("lesson"), readCollection("content")]);
        if (![...lessons, ...content].some(item => item.storageProvider === "supabase" && item.storageKey === key)) {
            return res.status(404).end();
        }
        const result = checkSupabase(await supabase.storage.from(BUCKET).createSignedUrl(key, 60, { download: false }));
        res.setHeader("Cache-Control", "no-store");
        res.redirect(302, result.signedUrl);
    } catch (error) { next(error); }
});

function readLocal(filename) {
    const value = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!Array.isArray(value)) throw new Error(`${path.basename(filename)} must contain an array`);
    return value;
}

function writeLocal(filename, items) {
    fs.writeFileSync(filename, JSON.stringify(items, null, 2), "utf8");
}

function checkSupabase(result) {
    if (result.error) throw result.error;
    return result.data;
}

async function readCollection(collection) {
    if (!SUPABASE_ENABLED) return readLocal(collection === "lesson" ? LESSONS_FILE : CONTENT_FILE);
    const data = checkSupabase(await supabase.from(TABLE).select("payload").eq("collection", collection).order("created_at", { ascending: true }));
    return data.map(row => row.payload);
}

async function addRecord(collection, item) {
    if (!SUPABASE_ENABLED) {
        const filename = collection === "lesson" ? LESSONS_FILE : CONTENT_FILE;
        const items = readLocal(filename);
        items.push(item);
        writeLocal(filename, items);
        return;
    }
    checkSupabase(await supabase.from(TABLE).insert({ collection, id: String(item.id), payload: item }));
}

async function deleteRecord(collection, item) {
    if (!SUPABASE_ENABLED) {
        const filename = collection === "lesson" ? LESSONS_FILE : CONTENT_FILE;
        writeLocal(filename, readLocal(filename).filter(entry => String(entry.id) !== String(item.id)));
        return;
    }
    checkSupabase(await supabase.from(TABLE).delete().eq("collection", collection).eq("id", String(item.id)));
}

function safeFilename(originalname) {
    return path.basename(originalname).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-160) || "file";
}

async function storeUploadedFile(file) {
    if (!file) return null;
    const safeName = safeFilename(file.originalname);
    if (!SUPABASE_ENABLED) {
        const filename = `${Date.now()}-${crypto.randomUUID()}-${safeName}`;
        fs.writeFileSync(path.join(UPLOADS_DIR, filename), file.buffer, { flag: "wx" });
        return { file: `/uploads/${filename}`, storageKey: null, storageProvider: "local" };
    }
    const key = `uploads/${crypto.randomUUID()}-${safeName}`;
    checkSupabase(await supabase.storage.from(BUCKET).upload(key, file.buffer, {
        contentType: file.mimetype || "application/octet-stream",
        upsert: false
    }));
    return { file: `/files?key=${encodeURIComponent(key)}`, storageKey: key, storageProvider: "supabase" };
}

async function removeUploadedFile(item) {
    if (!item?.file) return;
    if (item.storageProvider === "supabase" && item.storageKey && SUPABASE_ENABLED) {
        checkSupabase(await supabase.storage.from(BUCKET).remove([item.storageKey]));
        return;
    }
    if (item.file.startsWith("/uploads/")) {
        const filename = path.basename(item.file);
        const filePath = path.join(UPLOADS_DIR, filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
}

async function initializeSupabase() {
    if (!SUPABASE_ENABLED) {
        console.warn("Supabase is not configured; using local JSON and uploads (not persistent on Render Free).");
        return;
    }
    const markerId = "json-seed-v1";
    const marker = checkSupabase(await supabase.from(TABLE).select("id").eq("collection", "migration").eq("id", markerId).maybeSingle());
    if (!marker) {
        for (const [collection, filename] of [["lesson", LESSONS_FILE], ["content", CONTENT_FILE]]) {
            for (const item of readLocal(filename)) {
                checkSupabase(await supabase.from(TABLE).upsert({ collection, id: String(item.id), payload: item }, { onConflict: "collection,id", ignoreDuplicates: true }));
            }
        }
        checkSupabase(await supabase.from(TABLE).insert({ collection: "migration", id: markerId, payload: { completedAt: new Date().toISOString() } }));
    }

    // Move available legacy local files into the permanent bucket and update their records.
    for (const collection of ["lesson", "content"]) {
        const rows = checkSupabase(await supabase.from(TABLE).select("id,payload").eq("collection", collection));
        for (const row of rows) {
            const item = row.payload;
            if (!item.file?.startsWith("/uploads/") || item.storageProvider === "supabase") continue;
            const localPath = path.join(UPLOADS_DIR, path.basename(item.file));
            if (!fs.existsSync(localPath)) continue;
            const buffer = fs.readFileSync(localPath);
            const key = `uploads/${crypto.randomUUID()}-${safeFilename(item.originalFileName || path.basename(localPath))}`;
            checkSupabase(await supabase.storage.from(BUCKET).upload(key, buffer, { contentType: "application/octet-stream", upsert: false }));
            item.file = `/files?key=${encodeURIComponent(key)}`;
            item.storageKey = key;
            item.storageProvider = "supabase";
            checkSupabase(await supabase.from(TABLE).update({ payload: item }).eq("collection", collection).eq("id", row.id));
        }
    }
    console.log("Supabase storage and database are ready.");
}

function adminOnly(req, res, next) {
    const match = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ message: "غير مصرح" });
    try {
        const decoded = jwt.verify(match[1], JWT_SECRET);
        if (decoded.role !== "admin") return res.status(403).json({ message: "ممنوع" });
        next();
    } catch {
        return res.status(401).json({ message: "جلسة الإدارة غير صالحة" });
    }
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.get("/api/health", (req, res) => res.json({ success: true, message: "Darb server is running", storage: SUPABASE_ENABLED ? "supabase" : "local" }));

const activeUsers = new Map();
app.post("/api/online", (req, res) => {
    const userId = req.body?.userId;
    if (!userId) return res.status(400).json({ message: "userId مطلوب" });
    activeUsers.set(String(userId), Date.now());
    res.json({ success: true, count: activeUsers.size });
});
app.get("/api/online", (req, res) => res.json({ count: activeUsers.size }));
setInterval(() => {
    const now = Date.now();
    for (const [id, lastSeen] of activeUsers) if (now - lastSeen > 30000) activeUsers.delete(id);
}, 10000).unref();

app.post("/api/login", (req, res) => {
    const { password } = req.body || {};
    if (typeof password !== "string" || password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: "كلمة المرور خاطئة" });
    res.json({ success: true, token: jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "8h" }) });
});

app.get("/api/lessons", async (req, res, next) => {
    try { res.json(await readCollection("lesson")); } catch (error) { next(error); }
});
app.get("/api/lessons/:subject", async (req, res, next) => {
    try { res.json((await readCollection("lesson")).filter(item => item.subject === req.params.subject)); } catch (error) { next(error); }
});
app.post("/api/lessons", adminOnly, upload.single("file"), async (req, res, next) => {
    let stored = null;
    try {
        const { subject, title, description } = req.body;
        if (!subject || !title) return res.status(400).json({ message: "المادة وعنوان الدرس مطلوبان" });
        stored = await storeUploadedFile(req.file);
        const lesson = {
            id: Date.now(), subject, title, description: description || "",
            file: stored?.file || null, storageKey: stored?.storageKey || null,
            storageProvider: stored?.storageProvider || null,
            originalFileName: req.file ? req.file.originalname : null,
            createdAt: new Date().toISOString()
        };
        await addRecord("lesson", lesson);
        res.status(201).json({ success: true, lesson });
    } catch (error) {
        if (stored?.storageProvider === "supabase" && stored.storageKey) {
            try { await supabase.storage.from(BUCKET).remove([stored.storageKey]); } catch { console.error("Upload cleanup failed"); }
        }
        next(error);
    }
});
app.delete("/api/lessons/:id", adminOnly, async (req, res, next) => {
    try {
        const lesson = (await readCollection("lesson")).find(item => String(item.id) === String(req.params.id));
        if (!lesson) return res.status(404).json({ message: "الدرس غير موجود" });
        await deleteRecord("lesson", lesson);
        try { await removeUploadedFile(lesson); } catch (error) { console.error("Could not remove stored lesson file:", error?.name || "Error"); }
        res.json({ success: true, message: "تم حذف الدرس" });
    } catch (error) { next(error); }
});

app.get("/api/content", async (req, res, next) => {
    try {
        const { subject, type } = req.query;
        if (type && !CONTENT_TYPES.has(type)) return res.status(400).json({ message: "نوع المحتوى غير صالح" });
        res.json((await readCollection("content")).filter(item => (!subject || item.subject === subject) && (!type || item.type === type)));
    } catch (error) { next(error); }
});
app.post("/api/content", adminOnly, upload.single("file"), async (req, res, next) => {
    let stored = null;
    try {
        const { type, subject, title, description } = req.body;
        if (!CONTENT_TYPES.has(type) || !subject || !title) return res.status(400).json({ message: "اختر نوع المحتوى والمادة واكتب العنوان" });
        stored = await storeUploadedFile(req.file);
        const item = {
            id: Date.now(), type, subject, title, description: description || "",
            file: stored?.file || null, storageKey: stored?.storageKey || null,
            storageProvider: stored?.storageProvider || null,
            originalFileName: req.file ? req.file.originalname : null,
            createdAt: new Date().toISOString()
        };
        await addRecord("content", item);
        res.status(201).json({ success: true, item });
    } catch (error) {
        if (stored?.storageProvider === "supabase" && stored.storageKey) {
            try { await supabase.storage.from(BUCKET).remove([stored.storageKey]); } catch { console.error("Upload cleanup failed"); }
        }
        next(error);
    }
});
app.delete("/api/content/:id", adminOnly, async (req, res, next) => {
    try {
        const item = (await readCollection("content")).find(entry => String(entry.id) === String(req.params.id));
        if (!item) return res.status(404).json({ message: "المحتوى غير موجود" });
        await deleteRecord("content", item);
        try { await removeUploadedFile(item); } catch (error) { console.error("Could not remove stored content file:", error?.name || "Error"); }
        res.json({ success: true, message: "تم حذف المحتوى" });
    } catch (error) { next(error); }
});

app.use((err, req, res, next) => {
    console.error("Request failed:", err?.name || "Error");
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) return res.status(400).json({ message: err.code === "LIMIT_FILE_SIZE" ? "حجم الملف أكبر من 50 ميغابايت" : "تعذر رفع الملف" });
    res.status(500).json({ message: "حدث خطأ داخلي في الخادم" });
});

initializeSupabase().then(() => {
    app.listen(PORT, "0.0.0.0", () => console.log(`Darb server running on port ${PORT}`));
}).catch(error => {
    const safeMessage = typeof error?.message === "string"
        ? error.message.replaceAll(supabaseKey || "\u0000", "[redacted]").slice(0, 300)
        : "Unknown startup error";
    console.error("Could not initialize Supabase.", {
        name: error?.name || "Error",
        code: error?.code || null,
        status: error?.status || null,
        message: safeMessage
    });
    process.exit(1);
});
