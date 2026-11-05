// Sounds & Fog — Customer Feedback System
// نقطة تشغيل الخادم: يجمع المسارات، الجلسات، الملفات الثابتة، والمهام الدورية.
import http from 'node:http';
import { config, warnInsecureDefaults } from './src/config.js';
import { ensureDefaultBranch, closeDb } from './src/db.js';
import { SESSION_COOKIE, bootstrapAdmin, getSessionUser, purgeExpiredSessions } from './src/auth.js';
import {
  createRouter,
  parseCookies,
  applySecurityHeaders,
  serveStatic,
  sendJson,
  sendHtml,
  HttpError,
  notFound,
} from './src/http.js';
import { registerPublicRoutes } from './src/routes/public.js';
import { registerAuthRoutes } from './src/routes/auth.js';
import { registerApiRoutes } from './src/routes/api.js';
import { purgeSubmissionGuard } from './src/responses.js';
import { runBackup } from './src/backup.js';

const router = createRouter();
registerPublicRoutes(router);
registerAuthRoutes(router);
registerApiRoutes(router);

const notFoundPage = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>الصفحة غير موجودة — Sounds &amp; Fog</title>
<link rel="stylesheet" href="/css/app.css"></head>
<body class="public-page"><main class="survey-shell thanks-shell"><div class="card thanks-card">
<h1>الصفحة غير موجودة</h1>
<p class="thanks-body">الرابط الذي فتحته غير صحيح أو لم يعد متاحًا.</p>
<div class="thanks-actions"><a class="btn-primary" href="/">صفحة الاستبيان</a></div>
</div></main></body></html>`;

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    res.writeHead(400).end();
    return;
  }

  applySecurityHeaders(res);

  try {
    // الملفات الثابتة أولًا (CSS/JS/صور)
    if (req.method === 'GET' && /^\/(css|js|img)\//.test(url.pathname)) {
      if (serveStatic(req, res, url.pathname)) return;
    }

    const match = router.match(req.method, url.pathname);
    if (!match) {
      if (url.pathname.startsWith('/api/')) throw notFound('المسار غير موجود');
      throw notFound();
    }

    const cookies = parseCookies(req);
    const sessionId = cookies[SESSION_COOKIE] ?? null;
    const user = sessionId ? getSessionUser(sessionId) : null;

    await match.handler({
      req,
      res,
      url,
      params: match.params,
      user,
      sessionId,
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) {
      console.error('[error]', req.method, url.pathname, error);
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    const message = status >= 500 ? 'حدث خطأ في الخادم' : error.message;
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, status, { ok: false, message, details: error.details ?? null });
    } else if (status === 404) {
      sendHtml(res, 404, notFoundPage);
    } else {
      sendHtml(res, status, notFoundPage.replace('الصفحة غير موجودة', message));
    }
  } finally {
    if (config.env !== 'production' && !url.pathname.startsWith('/css')) {
      const ms = Date.now() - started;
      if (ms > 200) console.log(`[slow] ${req.method} ${url.pathname} — ${ms}ms`);
    }
  }
});

// ── الإقلاع / Bootstrap ───────────────────────────────────────────────────
ensureDefaultBranch();
const created = bootstrapAdmin();

for (const warning of warnInsecureDefaults()) console.warn(`[تحذير] ${warning}`);

// مهام دورية خفيفة: تنظيف الجلسات وبصمات الإرسال، ونسخة احتياطية تلقائية
const HOUR = 3_600_000;
const maintenance = setInterval(() => {
  try {
    purgeExpiredSessions();
    purgeSubmissionGuard();
  } catch (error) {
    console.error('[maintenance]', error);
  }
}, HOUR);
maintenance.unref?.();

let backupTimer = null;
if (config.autoBackupEveryHours > 0) {
  backupTimer = setInterval(() => {
    try {
      const file = runBackup();
      console.log(`[backup] تم إنشاء نسخة احتياطية: ${file}`);
    } catch (error) {
      console.error('[backup]', error);
    }
  }, config.autoBackupEveryHours * HOUR);
  backupTimer.unref?.();
}

server.listen(config.port, config.host, () => {
  console.log('');
  console.log('  Sounds & Fog — نظام آراء العملاء');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  صفحة الاستبيان : ${config.publicBaseUrl}/`);
  console.log(`  لوحة التحكم    : ${config.publicBaseUrl}/admin`);
  console.log(`  قاعدة البيانات : ${config.databasePath}`);
  console.log(`  البيئة         : ${config.env}`);
  if (created) {
    console.log('');
    console.log(`  تم إنشاء حساب المدير الأول: ${created.email}`);
    console.log('  كلمة المرور من ملف .env — سيُطلب تغييرها عند أول دخول.');
  }
  console.log('');
});

function shutdown(signal) {
  console.log(`\n[${signal}] إيقاف الخادم…`);
  clearInterval(maintenance);
  if (backupTimer) clearInterval(backupTimer);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
