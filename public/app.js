const API = '';
const PRICE_KES = 10;

let token = localStorage.getItem('mech_token') || null;
let currentUser = JSON.parse(localStorage.getItem('mech_user') || 'null');
let currentYear = '1';
let hasPaid = false;
let isAdmin = false;

const $ = id => document.getElementById(id);
const toast = $('toast');
const toastText = $('toastText');
const authRow = $('authRow');
const appSection = $('appSection');
const docGrid = $('docGrid');
const yearTitle = $('yearTitle');
const userChip = $('userChip');
const userName = $('userName');
const adminPanel = $('adminPanel');
const viewerModal = $('viewerModal');
const pdfFrame = $('pdfFrame');
const viewerTitle = $('viewerTitle');
const downloadBtn = $('downloadBtn');
const viewerFooter = $('viewerFooter');
const viewDocs = $('viewDocs');
const viewPayments = $('viewPayments');
const navDocs = $('navDocs');
const navPayments = $('navPayments');

let toastTimer;
function showToast(msg, isError) {
  toastText.textContent = msg;
  toast.classList.toggle('error', !!isError);
  toast.querySelector('i').className = isError ? 'fas fa-exclamation-circle' : 'fas fa-info-circle';
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function authHeaders() { return token ? { 'Authorization': `Bearer ${token}` } : {}; }
function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
}

function statusBadge(status) {
  const colors = {
    completed: 'background:#dcfce7;color:#166534;',
    pending: 'background:#fef3c7;color:#92400e;',
    failed: 'background:#fee2e2;color:#991b1b;'
  };
  return `<span style="padding:3px 10px;border-radius:40px;font-size:0.7rem;font-weight:600;${colors[status] || ''}">${status}</span>`;
}

function setLoggedIn(user, tkn) {
  token = tkn;
  currentUser = user;
  localStorage.setItem('mech_token', tkn);
  localStorage.setItem('mech_user', JSON.stringify(user));
  authRow.style.display = 'none';
  appSection.style.display = 'block';
  userChip.style.display = 'flex';
  navDocs.style.display = 'flex';
  navPayments.style.display = 'flex';
  userName.textContent = user.name;
  showView('docs');
  loadDocuments();
}

function setLoggedOut() {
  token = null;
  currentUser = null;
  hasPaid = false;
  isAdmin = false;
  localStorage.removeItem('mech_token');
  localStorage.removeItem('mech_user');
  authRow.style.display = 'grid';
  appSection.style.display = 'none';
  userChip.style.display = 'none';
  navDocs.style.display = 'none';
  navPayments.style.display = 'none';
  adminPanel.classList.remove('active');
}

function showView(name) {
  viewDocs.style.display = name === 'docs' ? 'block' : 'none';
  viewPayments.style.display = name === 'payments' ? 'block' : 'none';
  navDocs.classList.toggle('active', name === 'docs');
  navPayments.classList.toggle('active', name === 'payments');
  if (name === 'payments') loadUserPayments();
}

navDocs.addEventListener('click', () => showView('docs'));
navPayments.addEventListener('click', () => showView('payments'));

$('loginBtn').addEventListener('click', async () => {
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value.trim();
  if (!email || !password) return showToast('Enter email and password', true);
  try {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.needs_verification) {
        showToast('Please verify your email. Check inbox/spam.', true);
        setTimeout(() => {
          if (confirm('Resend verification email?')) resendVerification(data.email || email);
        }, 800);
        return;
      }
      return showToast(data.error || 'Login failed', true);
    }
    setLoggedIn(data.user, data.token);
    showToast(`Welcome back, ${data.user.name}!`);
  } catch { showToast('Network error', true); }
});

async function resendVerification(email) {
  try {
    await fetch(`${API}/api/auth/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    showToast('Verification email resent. Check inbox/spam.');
  } catch { showToast('Failed to resend', true); }
}

$('signupBtn').addEventListener('click', async () => {
  const name = $('signupName').value.trim();
  const email = $('signupEmail').value.trim();
  const password = $('signupPassword').value.trim();
  if (!name || !email || !password) return showToast('All fields required', true);
  if (password.length < 6) return showToast('Password must be at least 6 characters', true);
  try {
    const res = await fetch(`${API}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || 'Signup failed', true);
    showToast('Account created! Check your email for the verification link.');
    $('signupName').value = '';
    $('signupEmail').value = '';
    $('signupPassword').value = '';
  } catch { showToast('Network error', true); }
});

$('forgotLink').addEventListener('click', async () => {
  const email = prompt('Enter your email to reset password:');
  if (!email) return;
  try {
    await fetch(`${API}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    showToast(`If ${email} exists, a reset link was sent.`);
  } catch { showToast('Network error', true); }
});

$('logoutBtn').addEventListener('click', () => {
  setLoggedOut();
  showToast('Logged out.');
});

async function loadDocuments() {
  try {
    const res = await fetch(`${API}/api/documents?year=${currentYear}`, { headers: authHeaders() });
    const docs = await res.json();
    renderDocs(docs);
  } catch { showToast('Failed to load documents', true); }
}

function renderDocs(docs) {
  yearTitle.innerHTML = `<i class="fas fa-file-pdf"></i> Year ${currentYear} · Revision notes`;
  if (!docs.length) {
    docGrid.innerHTML = `<div class="empty-state"><i class="fas fa-folder-open"></i>No documents in Year ${currentYear} yet.</div>`;
    return;
  }
  docGrid.innerHTML = docs.map(doc => {
    const locked = !hasPaid;
    return `
      <div class="doc-card" data-id="${doc.id}">
        <div class="lock-overlay ${locked ? '' : 'unlocked'}">
          <i class="fas fa-${locked ? 'lock' : 'unlock'}"></i>
          ${locked ? 'KES ' + PRICE_KES : 'Unlocked'}
        </div>
        <div class="doc-icon"><i class="fas fa-file-pdf"></i></div>
        <h4>${escapeHtml(doc.title)}</h4>
        <p>${escapeHtml(doc.description || doc.category || '')}</p>
      </div>`;
  }).join('');
}

$('yearTabs').addEventListener('click', e => {
  const btn = e.target.closest('.year-tab');
  if (!btn) return;
  document.querySelectorAll('.year-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentYear = btn.dataset.year;
  loadDocuments();
});

docGrid.addEventListener('click', e => {
  const card = e.target.closest('.doc-card');
  if (!card) return;
  const docId = card.dataset.id;
  const title = card.querySelector('h4').textContent;
  openViewer(docId, title);
});

async function openViewer(docId, title) {
  viewerTitle.innerHTML = `<i class="fas fa-file-pdf"></i> ${escapeHtml(title)}`;
  pdfFrame.src = `${API}/api/documents/${docId}/view?token=${token}`;
  viewerModal.classList.add('active');

  downloadBtn.disabled = !hasPaid;
  downloadBtn.onclick = () => {
    if (!hasPaid) return showToast('Payment required', true);
    window.location.href = `${API}/api/documents/${docId}/download?token=${token}`;
  };

  viewerFooter.classList.toggle('unlocked', hasPaid);
  viewerFooter.innerHTML = hasPaid
    ? '<i class="fas fa-check-circle"></i> Payment confirmed — download enabled'
    : '<i class="fas fa-lock"></i> Pay KES 10 to enable download';
}

$('viewerClose').addEventListener('click', () => {
  viewerModal.classList.remove('active');
  pdfFrame.src = '';
});

$('payNowBtn').addEventListener('click', async () => {
  if (hasPaid) return showToast('Already paid for this session.', false);
  const phone = prompt('Enter your M-Pesa phone number (e.g. 0712345678):');
  if (!phone) return;
  showToast('Sending STK push…');
  try {
    const res = await fetch(`${API}/api/mpesa/stkpush`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || 'STK failed', true);
    showToast('STK push sent! Enter your M-Pesa PIN.');
    pollPayment(data.checkoutRequestId);
  } catch { showToast('Network error', true); }
});

function pollPayment(checkoutId) {
  let attempts = 0;
  const iv = setInterval(async () => {
    attempts++;
    try {
      const res = await fetch(`${API}/api/mpesa/status/${checkoutId}`, { headers: authHeaders() });
      const data = await res.json();
      if (data.status === 'completed') {
        clearInterval(iv);
        hasPaid = true;
        showToast(`✅ Payment received! Receipt: ${data.receipt}`);
        loadDocuments();
      } else if (data.status === 'failed') {
        clearInterval(iv);
        showToast('Payment failed or cancelled.', true);
      } else if (attempts >= 20) {
        clearInterval(iv);
        showToast('Payment timeout. Try again.', true);
      }
    } catch {}
  }, 3000);
}

async function loadUserPayments() {
  try {
    const res = await fetch(`${API}/api/user/payments`, { headers: authHeaders() });
    const rows = await res.json();
    const tbody = $('paymentsTbody');
    const empty = $('paymentsEmpty');

    if (!rows.length) {
      tbody.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    tbody.innerHTML = rows.map(p => `
      <tr>
        <td>${formatDate(p.created_at)}</td>
        <td>${escapeHtml(p.phone || '—')}</td>
        <td>KES ${p.amount || 0}</td>
        <td>${statusBadge(p.status)}</td>
        <td>${escapeHtml(p.receipt || '—')}</td>
      </tr>
    `).join('');
  } catch { showToast('Failed to load payments', true); }
}

$('refreshPaymentsBtn').addEventListener('click', loadUserPayments);

$('adminToggleBtn').addEventListener('click', async () => {
  if (isAdmin) {
    adminPanel.classList.toggle('active');
    return;
  }
  const pwd = prompt('Enter admin password:');
  if (pwd === null) return;
  try {
    const res = await fetch(`${API}/api/auth/admin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || 'Incorrect password', true);

    isAdmin = true;
    token = data.token;
    currentUser = data.user;
    adminPanel.classList.add('active');
    showToast('Admin mode activated.');
    loadAdminDocs();
    loadAdminStats();
  } catch { showToast('Network error', true); }
});

$('adminCloseBtn').addEventListener('click', () => adminPanel.classList.remove('active'));

document.querySelectorAll('.admin-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.admin-tab-content').forEach(c => c.style.display = 'none');
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).style.display = 'block';

    if (tab.dataset.tab === 'dashboard') loadAdminStats();
    if (tab.dataset.tab === 'payments') loadAdminPayments();
    if (tab.dataset.tab === 'upload') loadAdminDocs();
  });
});

$('uploadDocBtn').addEventListener('click', async () => {
  if (!isAdmin) return showToast('Admin only', true);

  const title = $('docTitle').value.trim();
  const year = $('docYear').value;
  const category = $('docCategory').value;
  const description = $('docDesc').value.trim();
  const file = $('docFile').files[0];

  if (!title) return showToast('Enter a title', true);
  if (!file) return showToast('Choose a PDF', true);
  if (file.type !== 'application/pdf') return showToast('Only PDF allowed', true);
  if (file.size > 10 * 1024 * 1024) return showToast('Max 10MB', true);

  const fd = new FormData();
  fd.append('title', title);
  fd.append('year', year);
  fd.append('category', category);
  fd.append('description', description);
  fd.append('file', file);

  showToast('Uploading…');
  try {
    const res = await fetch(`${API}/api/admin/upload`, {
      method: 'POST',
      headers: authHeaders(),
      body: fd
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || 'Upload failed', true);

    showToast(`Uploaded "${title}"`);
    $('docTitle').value = '';
    $('docDesc').value = '';
    $('docFile').value = '';

    loadAdminDocs();
    if (currentYear === year) loadDocuments();
  } catch { showToast('Network error', true); }
});

async function loadAdminDocs() {
  try {
    const res = await fetch(`${API}/api/admin/documents`, { headers: authHeaders() });
    const docs = await res.json();
    const list = $('adminDocList');
    if (!docs.length) {
      list.innerHTML = `<div style="color:#8da3c2;font-size:0.78rem;padding:8px;">No documents uploaded yet.</div>`;
      return;
    }
    list.innerHTML = docs.map(d => `
      <div class="admin-doc-item">
        <span><i class="fas fa-file-pdf"></i> ${escapeHtml(d.title)}
          <span class="badge">Year ${d.year}</span>
        </span>
        <button data-id="${d.id}" title="Delete"><i class="fas fa-trash"></i></button>
      </div>
    `).join('');
  } catch {}
}

$('adminDocList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;
  if (!confirm('Delete this document?')) return;
  try {
    const res = await fetch(`${API}/api/admin/documents/${btn.dataset.id}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    if (res.ok) {
      showToast('Document deleted.');
      loadAdminDocs();
      loadDocuments();
    }
  } catch {}
});

async function loadAdminStats() {
  try {
    const res = await fetch(`${API}/api/admin/stats`, { headers: authHeaders() });
    const s = await res.json();
    $('statUsers').textContent = s.totalUsers;
    $('statVerified').textContent = s.verifiedUsers;
    $('statDocs').textContent = s.totalDocs;
    $('statPending').textContent = s.pendingPayments;
    $('statFailed').textContent = s.failedPayments;
    $('statCompleted').textContent = s.completedPayments;
    $('statRevenue').textContent = `KES ${s.totalRevenue}`;
  } catch {}
}

$('refreshStatsBtn').addEventListener('click', loadAdminStats);

async function loadAdminPayments() {
  try {
    const res = await fetch(`${API}/api/admin/payments`, { headers: authHeaders() });
    const rows = await res.json();
    const tbody = $('adminPaymentsTbody');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#8da3c2;padding:20px;">No payments yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(p => `
      <tr>
        <td>${escapeHtml(p.user_name || 'Unknown')}<br><span style="font-size:0.68rem;color:#8da3c2;">${escapeHtml(p.user_email || '')}</span></td>
        <td>${escapeHtml(p.phone || '—')}</td>
        <td>KES ${p.amount || 0}</td>
        <td>${statusBadge(p.status)}</td>
        <td>${formatDate(p.created_at)}</td>
      </tr>
    `).join('');
  } catch {}
}

$('refreshPaymentsAdminBtn').addEventListener('click', loadAdminPayments);

if (token && currentUser) {
  setLoggedIn(currentUser, token);
} else {
  setLoggedOut();
                      }
