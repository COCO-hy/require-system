const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// File upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowed = ['.md', '.txt', '.pdf', '.doc', '.docx', '.json', '.yaml', '.yml', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件类型，请上传: ' + allowed.join(', ')));
    }
  },
});

// Routes
const requirementsRouter = require('./routes/requirements');
const systemsRouter = require('./routes/systems');

// Wrap the router with multer middleware for the create route
app.use('/api/requirements', (req, res, next) => {
  if (req.method === 'POST') {
    upload.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, error: err.message });
      }
      next();
    });
  } else {
    next();
  }
}, requirementsRouter);

// Systems API
app.use('/api/systems', systemsRouter);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ success: false, error: err.message || '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║       需求管理系统已启动 🚀               ║
  ║                                           ║
  ║  本地访问: http://localhost:${PORT}        ║
  ║  API地址: http://localhost:${PORT}/api/requirements  ║
  ╚═══════════════════════════════════════════╝
  `);
});
