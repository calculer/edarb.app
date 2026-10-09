
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const PORT = process.env.PORT || 3000;

// في Render، اربط قرصًا دائمًا على /var/data
// ثم أضف متغير البيئة DATA_DIR=/var/data
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const LESSONS_FILE = path.join(DATA_DIR, "lessons.json");
const CONTENT_FILE = path.join(DATA_DIR, "content.json");
const R2_ENV = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"];
const configuredR2 = R2_ENV.filter(name => Boolean(process.env[name]));
if (configuredR2.length > 0 && configuredR2.length !== R2_ENV.length) {
    throw new Error("R2 configuration is incomplete. Set all R2 environment variables or none.");
}
const R2_ENABLED = configuredR2.length === R2_ENV.length;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const r2 = R2_ENABLED ? new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
}) : null;
const CONTENT_TYPES = new Set(["summary", "exercise", "quiz", "exam", "resource"]);
const CONTENT_LABELS = {
    summary: "ملخص",
    exercise: "تمرين",
    quiz: "سؤال أو اختبار",
    exam: "امتحان سابق",
    resource: "ملف أو مورد"
};

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD ||
    (process.env.NODE_ENV !== "production" ? "123456" : "");

const JWT_SECRET =
    process.env.JWT_SECRET ||
    (process.env.NODE_ENV !== "production"
        ? "local-development-secret-change-me"
        : "");

if (!ADMIN_PASSWORD || !JWT_SECRET) {
    console.error(
        "Set ADMIN_PASSWORD and JWT_SECRET environment variables."
    );
    process.exit(1);
}

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Seed a newly attached Render disk once, preserving lessons and uploads already in Git.
if (path.resolve(DATA_DIR) !== path.resolve(__dirname)) {
    const seedMarker = path.join(DATA_DIR, ".darb-seeded");
    if (!fs.existsSync(seedMarker)) {
        for (const filename of ["lessons.json", "content.json"]) {
            const destination = path.join(DATA_DIR, filename);
            const source = path.join(__dirname, filename);
            if (!fs.existsSync(destination)) fs.copyFileSync(source, destination);
        }
        const sourceUploads = path.join(__dirname, "uploads");
        if (fs.existsSync(sourceUploads)) {
            for (const filename of fs.readdirSync(sourceUploads)) {
                const source = path.join(sourceUploads, filename);
                const destination = path.join(UPLOADS_DIR, filename);
                if (fs.statSync(source).isFile() && !fs.existsSync(destination)) {
                    fs.copyFileSync(source, destination);
                }
            }
        }
        fs.writeFileSync(seedMarker, new Date().toISOString(), "utf8");
    }
}

if (!fs.existsSync(LESSONS_FILE)) fs.writeFileSync(LESSONS_FILE, "[]", "utf8");
if (!fs.existsSync(CONTENT_FILE)) fs.writeFileSync(CONTENT_FILE, "[]", "utf8");

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_DIR));
app.get("/files", async (req, res, next) => {
    if (!R2_ENABLED) return res.status(404).end();
    try {
        const key = typeof req.query.key === "string" ? req.query.key : "";
        if (!key.startsWith("uploads/") || key.split("/").some(part => !part || part === "." || part === "..")) {
            return res.status(400).end();
        }
        const result = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
        res.setHeader("X-Content-Type-Options", "nosniff");
        const contentType = result.ContentType || "application/octet-stream";
        const inlineTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"]);
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Disposition", inlineTypes.has(contentType) ? "inline" : "attachment");
        res.setHeader("Cache-Control", "public, max-age=3600");
        if (result.ContentLength != null) res.setHeader("Content-Length", result.ContentLength);
        result.Body.pipe(res);
    } catch (error) {
        if (error.name === "NoSuchKey" || error.name === "NotFound") return res.status(404).end();
        next(error);
    }
});

function readLessons() {
    const data = fs.readFileSync(LESSONS_FILE, "utf8");
    const lessons = JSON.parse(data);

    if (!Array.isArray(lessons)) {
        throw new Error("lessons.json must contain an array");
    }

    return lessons;
}

function saveLessons(lessons) {
    fs.writeFileSync(
        LESSONS_FILE,
        JSON.stringify(lessons, null, 2),
        "utf8"
    );
}

function readContent() {
    const content = JSON.parse(fs.readFileSync(CONTENT_FILE, "utf8"));
    if (!Array.isArray(content)) throw new Error("content.json must contain an array");
    return content;
}

function saveContent(content) {
    fs.writeFileSync(CONTENT_FILE, JSON.stringify(content, null, 2), "utf8");
}

async function storeUploadedFile(file) {
    if (!file) return null;
    if (!R2_ENABLED) {
        const filename = `${Date.now()}-${crypto.randomUUID()}-${path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const filePath = path.join(UPLOADS_DIR, filename);
        fs.writeFileSync(filePath, file.buffer, { flag: "wx" });
        return { file: `/uploads/${filename}`, storageKey: null };
    }
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180) || "file";
    const key = `uploads/${crypto.randomUUID()}-${safeName}`;
    await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: file.buffer,
        ContentLength: file.size,
        ContentType: file.mimetype || "application/octet-stream"
    }));
    return { file: `/files?key=${encodeURIComponent(key)}`, storageKey: key };
}

async function removeUploadedFile(item) {
    if (!item?.file) return;
    const key = item.storageKey || (item.file.startsWith("/files/")
        ? decodeURIComponent(item.file.slice("/files/".length))
        : null);
    if (key && R2_ENABLED) {
        await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
        return;
    }
    if (item.file.startsWith("/uploads/")) {
        const filename = path.basename(item.file);
        const filePath = path.join(UPLOADS_DIR, filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
}

async function discardUploadedFile(stored) {
    if (!stored) return;
    await removeUploadedFile(stored);
}

function adminOnly(req, res, next) {
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);

    if (!match) {
        return res.status(401).json({
            message: "غير مصرح"
        });
    }

    try {
        const decoded = jwt.verify(match[1], JWT_SECRET);

        if (decoded.role !== "admin") {
            return res.status(403).json({
                message: "ممنوع"
            });
        }

        next();
    } catch (error) {
        return res.status(401).json({
            message: "جلسة الإدارة غير صالحة"
        });
    }
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }
});

// اختبار حالة الخادم
app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        message: "Darb server is running"
    });
});

// المستخدمون النشطون
const activeUsers = new Map();

app.post("/api/online", (req, res) => {
    const userId = req.body?.userId;

    if (!userId) {
        return res.status(400).json({
            message: "userId مطلوب"
        });
    }

    activeUsers.set(String(userId), Date.now());

    res.json({
        success: true,
        count: activeUsers.size
    });
});

app.get("/api/online", (req, res) => {
    res.json({
        count: activeUsers.size
    });
});

setInterval(() => {
    const now = Date.now();

    for (const [id, lastSeen] of activeUsers) {
        if (now - lastSeen > 30000) {
            activeUsers.delete(id);
        }
    }
}, 10000);

// تسجيل دخول الإدارة
app.post("/api/login", (req, res) => {
    const { password } = req.body || {};

    if (
        typeof password !== "string" ||
        password !== ADMIN_PASSWORD
    ) {
        return res.status(401).json({
            success: false,
            message: "كلمة المرور خاطئة"
        });
    }

    const token = jwt.sign(
        { role: "admin" },
        JWT_SECRET,
        { expiresIn: "8h" }
    );

    res.json({
        success: true,
        token
    });
});

// جميع الدروس
app.get("/api/lessons", (req, res, next) => {
    try {
        res.json(readLessons());
    } catch (error) {
        next(error);
    }
});

// دروس مادة معينة
app.get("/api/lessons/:subject", (req, res, next) => {
    try {
        const subject = req.params.subject;
        const lessons = readLessons();

        res.json(
            lessons.filter(lesson => lesson.subject === subject)
        );
    } catch (error) {
        next(error);
    }
});

// إضافة درس
app.post(
    "/api/lessons",
    adminOnly,
    upload.single("file"),
    async (req, res, next) => {
        let stored = null;
        try {
            const { subject, title, description } = req.body;

            if (!subject || !title) {
                return res.status(400).json({
                    message: "المادة وعنوان الدرس مطلوبان"
                });
            }

            const lessons = readLessons();

            stored = await storeUploadedFile(req.file);
            const lesson = {
                id: Date.now(), subject, title, description: description || "",
                file: stored?.file || null, storageKey: stored?.storageKey || null,
                originalFileName: req.file ? req.file.originalname : null,
                createdAt: new Date().toISOString()
            };

            lessons.push(lesson);
            saveLessons(lessons);

            res.status(201).json({
                success: true,
                lesson
            });
        } catch (error) {
            try { await discardUploadedFile(stored); } catch (cleanupError) { console.error("Upload cleanup failed"); }
            next(error);
        }
    }
);

// حذف درس
app.delete("/api/lessons/:id", adminOnly, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const lessons = readLessons();
        const lesson = lessons.find(item => item.id === id);

        if (!lesson) {
            return res.status(404).json({
                message: "الدرس غير موجود"
            });
        }

        const updatedLessons = lessons.filter(
            item => item.id !== id
        );

        saveLessons(updatedLessons);

        await removeUploadedFile(lesson);

        res.json({
            success: true,
            message: "تم حذف الدرس"
        });
    } catch (error) {
        next(error);
    }
});

// محتوى المواد: ملخصات وتمارين واختبارات وامتحانات وموارد
app.get("/api/content", (req, res, next) => {
    try {
        const { subject, type } = req.query;
        if (type && !CONTENT_TYPES.has(type)) {
            return res.status(400).json({ message: "نوع المحتوى غير صالح" });
        }
        const content = readContent().filter(item =>
            (!subject || item.subject === subject) && (!type || item.type === type)
        );
        res.json(content);
    } catch (error) {
        next(error);
    }
});

app.post("/api/content", adminOnly, upload.single("file"), async (req, res, next) => {
    let stored = null;
    try {
        const { type, subject, title, description } = req.body;
        if (!CONTENT_TYPES.has(type) || !subject || !title) {
            return res.status(400).json({ message: "اختر نوع المحتوى والمادة واكتب العنوان" });
        }
        stored = await storeUploadedFile(req.file);
        const content = readContent();
        const item = {
            id: Date.now(), type, subject, title, description: description || "",
            file: stored?.file || null, storageKey: stored?.storageKey || null,
            originalFileName: req.file ? req.file.originalname : null,
            createdAt: new Date().toISOString()
        };
        content.push(item);
        saveContent(content);
        res.status(201).json({ success: true, item });
    } catch (error) {
        try { await discardUploadedFile(stored); } catch (cleanupError) { console.error("Upload cleanup failed"); }
        next(error);
    }
});

app.delete("/api/content/:id", adminOnly, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const content = readContent();
        const item = content.find(entry => entry.id === id);
        if (!item) return res.status(404).json({ message: "المحتوى غير موجود" });
        saveContent(content.filter(entry => entry.id !== id));
        await removeUploadedFile(item);
        res.json({ success: true, message: "تم حذف المحتوى" });
    } catch (error) {
        next(error);
    }
});

// Error middleware must be registered after every route.
app.use((err, req, res, next) => {
    console.error("Request failed:", err?.name || "Error");
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) {
        return res.status(400).json({
            message: err.code === "LIMIT_FILE_SIZE" ? "حجم الملف أكبر من 50 ميغابايت" : "تعذر رفع الملف"
        });
    }
    res.status(500).json({ message: "حدث خطأ داخلي في الخادم" });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Darb server running on port ${PORT}`);
});
