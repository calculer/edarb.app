const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = 3000;

// ==============================
// إعدادات
// ==============================

const ADMIN_PASSWORD = "123456";
const JWT_SECRET = "darb-secret-2026";

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ==============================
// الملفات
// ==============================

if (!fs.existsSync("lessons.json")) {
    fs.writeFileSync("lessons.json", "[]");
}

if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
}

// ==============================
// رفع الملفات
// ==============================

const storage = multer.diskStorage({

    destination: function (req, file, cb) {
        cb(null, "uploads/");
    },

    filename: function (req, file, cb) {

        const safeName =
            file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");

        const filename =
            Date.now() + "-" + safeName;

        cb(null, filename);
    }

});

const upload = multer({
    storage: storage
});

// ==============================
// المستخدمون النشطون
// ==============================

const activeUsers = new Map();

app.post("/api/online", (req, res) => {

    const userId = req.body.userId;

    if (!userId) {
        return res.status(400).json({
            message: "userId مطلوب"
        });
    }

    activeUsers.set(userId, Date.now());

    res.json({
        success: true,
        count: activeUsers.size
    });
});

// تنظيف المستخدمين الذين لم يرسلوا إشارة منذ 30 ثانية
setInterval(() => {

    const now = Date.now();

    for (const [id, lastSeen] of activeUsers) {

        if (now - lastSeen > 30000) {
            activeUsers.delete(id);
        }

    }

}, 10000);

// عدد المستخدمين النشطين
app.get("/api/online", (req, res) => {

    res.json({
        count: activeUsers.size
    });

});

// ==============================
// تسجيل الدخول
// ==============================

app.post("/api/login", (req, res) => {

    const { password } = req.body;

    if (password !== ADMIN_PASSWORD) {

        return res.status(401).json({
            success: false,
            message: "كلمة المرور خاطئة"
        });

    }

    const token = jwt.sign(
        {
            role: "admin"
        },
        JWT_SECRET,
        {
            expiresIn: "8h"
        }
    );

    res.json({
        success: true,
        token: token
    });

});

// ==============================
// حماية الإدارة
// ==============================

function adminOnly(req, res, next) {

    const authHeader =
        req.headers.authorization;

    if (!authHeader) {

        return res.status(401).json({
            message: "غير مصرح"
        });

    }

    const token =
        authHeader.replace("Bearer ", "");

    try {

        const decoded =
            jwt.verify(token, JWT_SECRET);

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

// ==============================
// الحصول على جميع الدروس
// ==============================

app.get("/api/lessons", (req, res) => {

    const lessons =
        JSON.parse(
            fs.readFileSync("lessons.json", "utf8")
        );

    res.json(lessons);

});

// ==============================
// الحصول على دروس مادة معينة
// ==============================

app.get("/api/lessons/:subject", (req, res) => {

    const subject =
        decodeURIComponent(req.params.subject);

    const lessons =
        JSON.parse(
            fs.readFileSync("lessons.json", "utf8")
        );

    const filtered =
        lessons.filter(
            lesson => lesson.subject === subject
        );

    res.json(filtered);

});

// ==============================
// إضافة درس
// ==============================

app.post(
    "/api/lessons",
    adminOnly,
    upload.single("file"),
    (req, res) => {

        const {
            subject,
            title,
            description
        } = req.body;

        if (!subject) {

            return res.status(400).json({
                message: "المادة مطلوبة"
            });

        }

        if (!title) {

            return res.status(400).json({
                message: "عنوان الدرس مطلوب"
            });

        }

        const lessons =
            JSON.parse(
                fs.readFileSync("lessons.json", "utf8")
            );

        const lesson = {

            id: Date.now(),

            subject: subject,

            title: title,

            description:
                description || "",

            file:
                req.file
                    ? "/uploads/" + req.file.filename
                    : null,

            originalFileName:
                req.file
                    ? req.file.originalname
                    : null,

            createdAt:
                new Date().toISOString()

        };

        lessons.push(lesson);

        fs.writeFileSync(
            "lessons.json",
            JSON.stringify(lessons, null, 2)
        );

        res.json({
            success: true,
            lesson: lesson
        });

    }
);

// ==============================
// حذف درس
// ==============================

app.delete(
    "/api/lessons/:id",
    adminOnly,
    (req, res) => {

        const id =
            Number(req.params.id);

        const lessons =
            JSON.parse(
                fs.readFileSync("lessons.json", "utf8")
            );

        const lesson =
            lessons.find(
                item => item.id === id
            );

        if (!lesson) {

            return res.status(404).json({
                message: "الدرس غير موجود"
            });

        }

        // حذف الملف من uploads
        if (lesson.file) {

            const filename =
                path.basename(lesson.file);

            const filePath =
                path.join(
                    __dirname,
                    "uploads",
                    filename
                );

            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }

        }

        const newLessons =
            lessons.filter(
                item => item.id !== id
            );

        fs.writeFileSync(
            "lessons.json",
            JSON.stringify(newLessons, null, 2)
        );

        res.json({
            success: true,
            message: "تم حذف الدرس"
        });

    }
);

// ==============================
// الملفات
// ==============================

app.use(
    "/uploads",
    express.static(
        path.join(__dirname, "uploads")
    )
);

// ==============================
// تشغيل السيرفر
// ==============================

app.listen(PORT, () => {

    console.log(
        `Darb running on http://localhost:${PORT}`
    );

});