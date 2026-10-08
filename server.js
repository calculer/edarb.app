
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3000;

// في Render، اربط قرصًا دائمًا على /var/data
// ثم أضف متغير البيئة DATA_DIR=/var/data
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const LESSONS_FILE = path.join(DATA_DIR, "lessons.json");

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

if (!fs.existsSync(LESSONS_FILE)) {
    fs.writeFileSync(LESSONS_FILE, "[]", "utf8");
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_DIR));

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

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },

    filename: (req, file, cb) => {
        const safeName = path
            .basename(file.originalname)
            .replace(/[^a-zA-Z0-9._-]/g, "_");

        cb(null, Date.now() + "-" + safeName);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 50 * 1024 * 1024
    }
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
    (req, res, next) => {
        try {
            const { subject, title, description } = req.body;

            if (!subject || !title) {
                if (req.file) {
                    fs.unlinkSync(req.file.path);
                }

                return res.status(400).json({
                    message: "المادة وعنوان الدرس مطلوبان"
                });
            }

            const lessons = readLessons();

            const lesson = {
                id: Date.now(),
                subject,
                title,
                description: description || "",
                file: req.file
                    ? "/uploads/" + req.file.filename
                    : null,
                originalFileName: req.file
                    ? req.file.originalname
                    : null,
                createdAt: new Date().toISOString()
            };

            lessons.push(lesson);
            saveLessons(lessons);

            res.status(201).json({
                success: true,
                lesson
            });
        } catch (error) {
            next(error);
        }
    }
);

// حذف درس
app.delete("/api/lessons/:id", adminOnly, (req, res, next) => {
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

        if (lesson.file) {
            const filename = path.basename(lesson.file);
            const filePath = path.join(UPLOADS_DIR, filename);

            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }

        res.json({
            success: true,
            message: "تم حذف الدرس"
        });
    } catch (error) {
        next(error);
    }
});

// التعامل مع أخطاء الملفات والطلبات
app.use((err, req, res, next) => {
    console.error(err);

    if (res.headersSent) {
        return next(err);
    }

    if (err instanceof multer.MulterError) {
        return res.status(400).json({
            message: err.code === "LIMIT_FILE_SIZE"
                ? "حجم الملف أكبر من 50 ميغابايت"
                : "تعذر رفع الملف"
        });
    }

    res.status(500).json({
        message: "حدث خطأ داخلي في الخادم"
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Darb server running on port ${PORT}`);
});