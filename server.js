require('dotenv').config();
const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ UPLOADS ============
const DATA_DIR = process.env.RENDER ? '/var/data' : __dirname;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files allowed'));
  }
});

// ============ DATABASE ============
const db = new sqlite3.Database(path.join(DATA_DIR, 'database.sqlite'));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    is_verified INTEGER DEFAULT 0,
    verify_token TEXT,
    verify_expires TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT,
    year INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    checkout_request_id TEXT UNIQUE,
    merchant_request_id TEXT,
    phone TEXT,
    amount REAL,
    status TEXT DEFAULT 'pending',
    receipt TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  )`);
});

// ============ DB HELPERS ============
const runQuery = (sql, params = []) => new Promise((res, rej) => {
  db.run(sql, params, function (err) {
    if (err) rej(err); else res({ id: this.lastID, changes: this.changes });
  });
});
const getQuery = (sql, params = []) => new Promise((res, rej) => {
  db.get(sql, params, (err, row) => err ? rej(err) : res(row));
});
const allQuery = (sql, params = []) => new Promise((res, rej) => {
  db.all(sql, params, (err, rows) => err ? rej(err) : res(rows));
});

// ============ EMAIL ============
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendVerifyEmail(to, name, token) {
  const link = `${process.env.APP_URL}/verify.html?token=${token}`;
  if (transporter) {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM,
        to,
        subject: 'Verify your MechRevision account',
        html: `<p>Hi ${name},</p>
               <p>Click below to verify your email:</p>
               <p><a href="${link}">${link}</a></p>
               <p>Or paste this token: <b>${token}</b></p>`
      });
      console.log(`✉️  Verification email sent to ${to}`);
    } catch (err) {
      console.error('Email send error:', err.message);
      console.log(`📧 [FALLBACK] Verification link for ${to}: ${link}`);
    }
  } else {
    console.log(`\n📧 [DEV MODE] Verification link for ${to}:\n   ${link}\n`);
  }
}

// ============ AUTH MIDDLEWARE ============
function authRequired(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Login required' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminRequired(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

function verifiedRequired(req, res, next) {
  if (!req.user?.is_verified && !req.user?.is_admin) {
    return res.status(403).json({ error: 'Please verify your email first', needs_verification: true });
  }
  next();
}

// ============ AUTH ROUTES ============
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });

    const existing = await getQuery('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 10);
    const isAdmin = email === process.env.ADMIN_EMAIL ? 1 : 0;
    const verifyToken = crypto.randomBytes(24).toString('hex');
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const result = await runQuery(
      `INSERT INTO users (name, email, password, is_admin, is_verified, verify_token, verify_expires)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, email, hashed, isAdmin, isAdmin ? 1 : 0, verifyToken, verifyExpires]
    );

    await sendVerifyEmail(email, name, verifyToken);

    res.json({
      success: true,
      needs_verification: !isAdmin,
      message: 'Account created. Please check your email to verify your account.'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/verify', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const user = await getQuery('SELECT * FROM users WHERE verify_token = ?', [token]);
    if (!user) return res.status(400).json({ error: 'Invalid token' });

    if (user.verify_expires && new Date(user.verify_expires) < new Date()) {
      return res.status(400).json({ error: 'Verification link expired. Please sign up again or request a new link.' });
    }

    await runQuery(
      `UPDATE users SET is_verified = 1, verify_token = NULL, verify_expires = NULL WHERE id = ?`,
      [user.id]
    );

    const jwtToken = jwt.sign(
      { id: user.id, email: user.email, name: user.name, is_admin: user.is_admin, is_verified: 1 },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token: jwtToken,
      user: { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin, is_verified: 1 }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.post('/api/auth/resend-verification', async (req, res) => {
  const { email } = req.body;
  const user = await getQuery('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) return res.json({ success: true });
  if (user.is_verified) return res.json({ success: true, already_verified: true });

  const verifyToken = crypto.randomBytes(24).toString('hex');
  const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await runQuery('UPDATE users SET verify_token = ?, verify_expires = ? WHERE id = ?',
    [verifyToken, verifyExpires, user.id]);

  await sendVerifyEmail(email, user.name, verifyToken);
  res.json({ success: true });
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await getQuery('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    if (!user.is_verified && !user.is_admin) {
      return res.status(403).json({
        error: 'Please verify your email before logging in.',
        needs_verification: true,
        email: user.email
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, is_admin: user.is_admin, is_verified: user.is_verified },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin, is_verified: user.is_verified }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  const user = await getQuery('SELECT id FROM users WHERE email = ?', [email]);
  res.json({ message: 'If that email exists, a reset link has been sent.' });
});

app.post('/api/auth/admin-login', (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect admin password' });
  }
  const token = jwt.sign(
    { id: 0, email: 'admin@system', name: 'Administrator', is_admin: 1, is_verified: 1 },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
  );
  res.json({ token, user: { name: 'Administrator', is_admin: 1, is_verified: 1 } });
});

// ============ DOCUMENTS ============
app.get('/api/documents', async (req, res) => {
  try {
    const { year } = req.query;
    let rows;
    if (year) {
      rows = await allQuery(
        'SELECT id, title, description, category, year, uploaded_at FROM documents WHERE year = ? ORDER BY id DESC',
        [year]);
    } else {
      rows = await allQuery(
        'SELECT id, title, description, category, year, uploaded_at FROM documents ORDER BY year, id DESC');
    }
    res.json(rows);
  } catch { res.status(500).json({ error: 'Failed to fetch documents' }); }
});

app.get('/api/documents/:id/view', authRequired, async (req, res) => {
  const doc = await getQuery('SELECT * FROM documents WHERE id = ?', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const filePath = path.join(UPLOAD_DIR, doc.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${doc.original_name}"`);
  fs.createReadStream(filePath).pipe(res);
});

app.get('/api/documents/:id/download', authRequired, verifiedRequired, async (req, res) => {
  const doc = await getQuery('SELECT * FROM documents WHERE id = ?', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Not found' });

  const paid = await getQuery(
    `SELECT id FROM payments WHERE user_id = ? AND status = 'completed' LIMIT 1`, [req.user.id]);
  if (!paid && !req.user.is_admin) {
    return res.status(402).json({ error: 'Payment required', price: process.env.PRICE_KES });
  }

  const filePath = path.join(UPLOAD_DIR, doc.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing' });
  res.download(filePath, doc.original_name);
});

// ============ USER PAYMENT HISTORY ============
app.get('/api/user/payments', authRequired, async (req, res) => {
  try {
    const rows = await allQuery(
      `SELECT id, checkout_request_id, phone, amount, status, receipt, created_at, completed_at
       FROM payments WHERE user_id = ? ORDER BY id DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch { res.status(500).json({ error: 'Failed to load payments' }); }
});

// ============ ADMIN UPLOAD / LIST / DELETE ============
app.post('/api/admin/upload',
  authRequired, adminRequired, upload.single('file'),
  async (req, res) => {
    try {
      const { title, description, category, year } = req.body;
      if (!title || !year) return res.status(400).json({ error: 'Title and year required' });
      if (!req.file) return res.status(400).json({ error: 'PDF file required' });

      const result = await runQuery(
        `INSERT INTO documents (title, description, category, year, filename, original_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [title, description || '', category || 'Other', year, req.file.filename, req.file.originalname]
      );
      res.json({ success: true, id: result.id });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Upload failed' });
    }
  }
);

app.get('/api/admin/documents', authRequired, adminRequired, async (req, res) => {
  const rows = await allQuery(
    'SELECT id, title, description, category, year, original_name, uploaded_at FROM documents ORDER BY year, id DESC');
  res.json(rows);
});

app.delete('/api/admin/documents/:id', authRequired, adminRequired, async (req, res) => {
  const doc = await getQuery('SELECT * FROM documents WHERE id = ?', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const filePath = path.join(UPLOAD_DIR, doc.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  await runQuery('DELETE FROM documents WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ============ ADMIN DASHBOARD: STATS + ALL PAYMENTS ============
app.get('/api/admin/stats', authRequired, adminRequired, async (req, res) => {
  try {
    const totalUsers = (await getQuery('SELECT COUNT(*) AS c FROM users')).c;
    const verifiedUsers = (await getQuery('SELECT COUNT(*) AS c FROM users WHERE is_verified = 1')).c;
    const totalDocs = (await getQuery('SELECT COUNT(*) AS c FROM documents')).c;
    const totalPayments = (await getQuery('SELECT COUNT(*) AS c FROM payments')).c;
    const completedPayments = (await getQuery(`SELECT COUNT(*) AS c FROM payments WHERE status = 'completed'`)).c;
    const totalRevenue = (await getQuery(`SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE status = 'completed'`)).s;
    const pendingPayments = (await getQuery(`SELECT COUNT(*) AS c FROM payments WHERE status = 'pending'`)).c;
    const failedPayments = (await getQuery(`SELECT COUNT(*) AS c FROM payments WHERE status = 'failed'`)).c;

    res.json({
      totalUsers, verifiedUsers, totalDocs,
      totalPayments, completedPayments, pendingPayments, failedPayments,
      totalRevenue
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

app.get('/api/admin/payments', authRequired, adminRequired, async (req, res) => {
  try {
    const rows = await allQuery(`
      SELECT p.id, p.phone, p.amount, p.status, p.receipt,
             p.created_at, p.completed_at,
             u.name AS user_name, u.email AS user_email
      FROM payments p
      LEFT JOIN users u ON u.id = p.user_id
      ORDER BY p.id DESC
      LIMIT 500
    `);
    res.json(rows);
  } catch { res.status(500).json({ error: 'Failed to load payments' }); }
});

// ============ MPESA ============
const MPESA_BASE = process.env.MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

async function getMpesaToken() {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');
  const res = await axios.get(`${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  return res.data.access_token;
}

function mpesaTimestamp() {
  const d = new Date();
  const pad = n => n.toString().padStart(2, '0');
  return d.getFullYear().toString() + pad(d.getMonth() + 1) + pad(d.getDate())
    + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

app.post('/api/mpesa/stkpush', authRequired, verifiedRequired, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });

    let normalized = phone.replace(/\D/g, '');
    if (normalized.startsWith('0')) normalized = '254' + normalized.slice(1);
    if (normalized.startsWith('7')) normalized = '254' + normalized;

    const token = await getMpesaToken();
    const timestamp = mpesaTimestamp();
    const password = Buffer.from(
      `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
    ).toString('base64');

    const amount = parseInt(process.env.PRICE_KES || '10');

    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: normalized,
      PartyB: process.env.MPESA_SHORTCODE,
      PhoneNumber: normalized,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: 'MechRevision',
      TransactionDesc: 'Revision document access'
    };

    const response = await axios.post(
      `${MPESA_BASE}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    await runQuery(
      `INSERT INTO payments (user_id, checkout_request_id, merchant_request_id, phone, amount, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [req.user.id, response.data.CheckoutRequestID, response.data.MerchantRequestID, normalized, amount]
    );

    res.json({
      success: true,
      checkoutRequestId: response.data.CheckoutRequestID,
      message: 'STK push sent. Enter your M-Pesa PIN.'
    });
  } catch (err) {
    console.error('STK error:', err.response?.data || err.message);
    res.status(500).json({ error: 'STK push failed', details: err.response?.data });
  }
});

app.get('/api/mpesa/status/:checkoutId', authRequired, async (req, res) => {
  const row = await getQuery(
    'SELECT status, receipt, amount FROM payments WHERE checkout_request_id = ? AND user_id = ?',
    [req.params.checkoutId, req.user.id]
  );
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const cb = req.body?.Body?.stkCallback;
    if (!cb) return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

    const checkoutId = cb.CheckoutRequestID;
    if (cb.ResultCode === 0) {
      const items = cb.CallbackMetadata?.Item || [];
      const receipt = items.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
      const amount = items.find(i => i.Name === 'Amount')?.Value;
      await runQuery(
        `UPDATE payments SET status = 'completed', receipt = ?, amount = ?, completed_at = CURRENT_TIMESTAMP
         WHERE checkout_request_id = ?`,
        [receipt, amount, checkoutId]
      );
      console.log(`✅ Payment completed: ${checkoutId} | Receipt: ${receipt}`);
    } else {
      await runQuery(
        `UPDATE payments SET status = 'failed' WHERE checkout_request_id = ?`,
        [checkoutId]
      );
      console.log(`❌ Payment failed: ${checkoutId} | ${cb.ResultDesc}`);
    }
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('Callback error:', err);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

// ============ SPA FALLBACK ============
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 MechRevision running on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.MPESA_ENV}`);
  console.log(`   Admin password is set (not shown)\n`);
});
