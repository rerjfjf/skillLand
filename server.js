const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { execFileSync } = require('child_process');

const PORT = 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PATH = '/secret-admin-panel-x7k9';
const DB_FILE = path.join(__dirname, 'skillland.db');

// ── SQLite: node:sqlite для новых Node, sqlite3 CLI для Node 20 ─────
function createDatabase(file) {
  if (!process.env.FORCE_SQLITE_CLI) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const native = new DatabaseSync(file);
      native.__driver = 'node:sqlite';
      return native;
    } catch {
      // Node 20 не имеет node:sqlite, ниже используем системный sqlite3.
    }
  }

  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
  } catch {
    console.error('\n❌  Не найден SQLite.');
    console.error('   Установи Node.js 22+ или sqlite3, затем запусти сервер снова.\n');
    process.exit(1);
  }

  function value(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0';
    return `'${String(v).replace(/'/g, "''")}'`;
  }

  function fill(sql, params) {
    if (!params.length) return sql;
    if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
      const data = params[0];
      return sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, key) => value(data[key]));
    }
    let i = 0;
    return sql.replace(/\?/g, () => value(params[i++]));
  }

  function runSql(sql, jsonMode = false) {
    const args = jsonMode ? ['-json', file, sql] : [file, sql];
    const out = execFileSync('sqlite3', args, { encoding: 'utf8' }).trim();
    return jsonMode ? (out ? JSON.parse(out) : []) : out;
  }

  return {
    __driver: 'sqlite3-cli',
    exec(sql) { runSql(sql); },
    close() {},
    prepare(sql) {
      return {
        all(...params) {
          return runSql(fill(sql, params), true);
        },
        get(...params) {
          return this.all(...params)[0];
        },
        run(...params) {
          const finalSql = fill(sql, params);
          const rows = runSql(`BEGIN; ${finalSql}; SELECT last_insert_rowid() AS lastInsertRowid, changes() AS changes; COMMIT;`, true);
          return rows[0] || { lastInsertRowid: 0, changes: 0 };
        },
      };
    },
  };
}

// ── Инициализация БД ────────────────────────────────────────
const db = createDatabase(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nick      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password  TEXT    NOT NULL,
    created_at TEXT   DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS scores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nick        TEXT    NOT NULL COLLATE NOCASE,
    game        TEXT    NOT NULL,
    score       INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT    DEFAULT (datetime('now','localtime')),
    UNIQUE(nick, game)
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    nick       TEXT    NOT NULL,
    game       TEXT    NOT NULL,
    stars      INTEGER NOT NULL,
    text       TEXT    NOT NULL,
    date       TEXT    NOT NULL,
    created_at TEXT    DEFAULT (datetime('now','localtime')),
    UNIQUE(nick, game)
  );
`);

// Мигрируем существующие отзывы из reviews.json если есть
const reviewsJson = path.join(__dirname, 'reviews.json');
if (fs.existsSync(reviewsJson)) {
  try {
    const old = JSON.parse(fs.readFileSync(reviewsJson, 'utf-8'));
    const ins = db.prepare(
      `INSERT OR IGNORE INTO reviews (nick, game, stars, text, date)
       VALUES (@nick, @game, @stars, @text, @date)`
    );
    transaction(() => {
      old
        .filter(r => r.nick && r.game && r.stars && r.text)
        .forEach(r => ins.run({
          nick: r.nick,
          game: r.game,
          stars: r.stars,
          text: r.text,
          date: r.date || new Date().toLocaleDateString('ru-RU'),
        }));
    });
    fs.renameSync(reviewsJson, reviewsJson + '.migrated');
    console.log('✅  Отзывы перенесены из reviews.json в SQLite.');
  } catch (e) {
    console.warn('⚠  Не удалось мигрировать reviews.json:', e.message);
  }
}

console.log(`✅  База данных: ${DB_FILE}`);

// ── Prepared statements ────────────────────────────────────
const stmts = {
  // Accounts
  findAccount:    db.prepare('SELECT * FROM accounts WHERE nick = ? COLLATE NOCASE'),
  createAccount:  db.prepare('INSERT INTO accounts (nick, password) VALUES (?, ?)'),
  updateAccount:  db.prepare('UPDATE accounts SET nick = ?, password = ? WHERE nick = ? COLLATE NOCASE'),
  allAccounts:    db.prepare('SELECT id, nick, created_at FROM accounts ORDER BY id DESC'),
  deleteAccount:  db.prepare('DELETE FROM accounts WHERE nick = ? COLLATE NOCASE'),

  // Scores
  getScore:       db.prepare('SELECT score FROM scores WHERE nick = ? COLLATE NOCASE AND game = ?'),
  upsertScore:    db.prepare(`
    INSERT INTO scores (nick, game, score, updated_at)
    VALUES (?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(nick, game) DO UPDATE SET
      score      = MAX(excluded.score, scores.score),
      updated_at = excluded.updated_at
  `),
  getScoresForNick: db.prepare('SELECT game, score FROM scores WHERE nick = ? COLLATE NOCASE'),
  allScores:      db.prepare('SELECT * FROM scores ORDER BY updated_at DESC'),
  renameScores:   db.prepare('UPDATE scores SET nick = ? WHERE nick = ? COLLATE NOCASE'),
  deleteScores:   db.prepare('DELETE FROM scores WHERE nick = ? COLLATE NOCASE'),

  // Reviews
  allReviews:     db.prepare('SELECT * FROM reviews ORDER BY id DESC'),
  insertReview:   db.prepare(
    'INSERT INTO reviews (nick, game, stars, text, date) VALUES (?, ?, ?, ?, ?)'
  ),
  checkReview:    db.prepare(
    'SELECT id FROM reviews WHERE nick = ? COLLATE NOCASE AND game = ?'
  ),
  allReviewsAdmin: db.prepare('SELECT * FROM reviews ORDER BY id DESC'),
  renameReviews:   db.prepare('UPDATE reviews SET nick = ? WHERE nick = ? COLLATE NOCASE'),
  deleteReviewsByNick: db.prepare('DELETE FROM reviews WHERE nick = ? COLLATE NOCASE'),
  deleteReview:   db.prepare('DELETE FROM reviews WHERE id = ?'),
};

// ── Вспомогательные ────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
};

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s)); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

function sanitizeScore(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

const VALID_GAMES = new Set(['programmer','economist','chef','miner','medic']);

function transaction(fn) {
  if (db.__driver === 'sqlite3-cli') return fn();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── Маршрутизатор ──────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname.replace(/\/$/, '') || '/';
  const method   = req.method;

  try {
    // ── ADMIN PAGE ──────────────────────────────────────────
    if (pathname === ADMIN_PATH) {
      serveStatic(res, path.join(__dirname, 'admin.html'));
      return;
    }

    // ── API: AUTH ───────────────────────────────────────────

    // POST /api/auth/login  — вход / регистрация
    if (pathname === '/api/auth/login' && method === 'POST') {
      const { nick, password } = await readBody(req);
      if (!nick || !password) return json(res, 400, { error: 'Введите ник и пароль' });
      if (nick.trim().length < 3)     return json(res, 400, { error: 'Ник минимум 3 символа' });
      if (password.trim().length < 4) return json(res, 400, { error: 'Пароль минимум 4 символа' });

      const existing = stmts.findAccount.get(nick.trim());
      if (existing) {
        if (existing.password !== password.trim())
          return json(res, 401, { error: 'Неверный пароль' });
        const scores = buildScoresMap(nick.trim());
        return json(res, 200, { nick: existing.nick, scores });
      }

      // Регистрация
      stmts.createAccount.run(nick.trim(), password.trim());
      return json(res, 201, { nick: nick.trim(), scores: defaultScores() });
    }

    // PUT /api/auth/profile  — изменить ник/пароль
    if (pathname === '/api/auth/profile' && method === 'PUT') {
      const { nick, newNick, newPassword } = await readBody(req);
      if (!nick) return json(res, 400, { error: 'Не указан текущий ник' });

      const account = stmts.findAccount.get(nick.trim());
      if (!account) return json(res, 404, { error: 'Аккаунт не найден' });

      const finalNick = (newNick || '').trim() || account.nick;
      const finalPass = (newPassword || '').trim() || account.password;

      if (finalNick.length < 3) return json(res, 400, { error: 'Ник минимум 3 символа' });
      if (finalPass.length < 4) return json(res, 400, { error: 'Пароль минимум 4 символа' });

      if (finalNick.toLowerCase() !== account.nick.toLowerCase()) {
        const taken = stmts.findAccount.get(finalNick);
        if (taken) return json(res, 409, { error: 'Ник уже занят' });
      }

      const updateProfile = () => transaction(() => {
        stmts.updateAccount.run(finalNick, finalPass, account.nick);
        if (finalNick.toLowerCase() !== account.nick.toLowerCase()) {
          stmts.renameScores.run(finalNick, account.nick);
          stmts.renameReviews.run(finalNick, account.nick);
        }
      });
      updateProfile();
      return json(res, 200, { nick: finalNick });
    }

    // GET /api/auth/profile?nick=...  — получить профиль
    if (pathname === '/api/auth/profile' && method === 'GET') {
      const nick = (parsed.query.nick || '').trim();
      if (!nick) return json(res, 400, { error: 'Не указан ник' });
      const account = stmts.findAccount.get(nick);
      if (!account) return json(res, 404, { error: 'Не найден' });
      const scores = buildScoresMap(account.nick);
      return json(res, 200, { nick: account.nick, scores });
    }

    // ── API: SCORES ─────────────────────────────────────────

    // POST /api/scores  — сохранить результат
    if (pathname === '/api/scores' && method === 'POST') {
      const { nick, game, score } = await readBody(req);
      if (!nick || !game) return json(res, 400, { error: 'Нет ника или игры' });
      if (!VALID_GAMES.has(game)) return json(res, 400, { error: 'Неверная игра' });
      stmts.upsertScore.run(nick.trim(), game, sanitizeScore(score));
      return json(res, 200, { ok: true });
    }

    // ── API: REVIEWS ────────────────────────────────────────

    if (pathname === '/api/reviews' && method === 'GET') {
      return json(res, 200, stmts.allReviews.all());
    }

    if (pathname === '/api/reviews' && method === 'POST') {
      const review = await readBody(req);
      if (!review.nick || !review.text || !review.game || !review.stars)
        return json(res, 400, { error: 'Заполни все поля' });
      if (stmts.checkReview.get(review.nick, review.game))
        return json(res, 409, { error: 'Ты уже оставил отзыв на эту игру' });

      const row = {
        nick:  String(review.nick).slice(0, 32),
        game:  String(review.game),
        stars: Math.min(5, Math.max(1, parseInt(review.stars))),
        text:  String(review.text).slice(0, 500),
        date:  new Date().toLocaleDateString('ru-RU'),
      };
      const info = stmts.insertReview.run(row.nick, row.game, row.stars, row.text, row.date);
      return json(res, 201, { id: info.lastInsertRowid, ...row });
    }

    // ── API: ADMIN ──────────────────────────────────────────

    if (pathname === '/api/admin/stats' && method === 'GET') {
      const accounts = stmts.allAccounts.all();
      const scores   = stmts.allScores.all();
      const reviews  = stmts.allReviewsAdmin.all();
      return json(res, 200, { accounts, scores, reviews });
    }

    if (pathname === '/api/admin/delete-account' && method === 'DELETE') {
      const { nick } = await readBody(req);
      if (!nick) return json(res, 400, { error: 'Ник не указан' });
      const deleteAccount = () => transaction(() => {
        stmts.deleteScores.run(nick);
        stmts.deleteReviewsByNick.run(nick);
        stmts.deleteAccount.run(nick);
      });
      deleteAccount();
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/admin/delete-review' && method === 'DELETE') {
      const { id } = await readBody(req);
      if (!id) return json(res, 400, { error: 'ID не указан' });
      stmts.deleteReview.run(id);
      return json(res, 200, { ok: true });
    }

    // ── STATIC ──────────────────────────────────────────────
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
    serveStatic(res, filePath);

  } catch (err) {
    console.error('Server error:', err);
    json(res, 500, { error: 'Внутренняя ошибка сервера' });
  }
});

// ── Утилиты ────────────────────────────────────────────────
function defaultScores() {
  return { programmer: 0, economist: 0, chef: 0, miner: 0, medic: 0 };
}

function buildScoresMap(nick) {
  const rows = stmts.getScoresForNick.all(nick);
  const map  = defaultScores();
  rows.forEach(r => { if (map.hasOwnProperty(r.game)) map[r.game] = r.score; });
  return map;
}

// ── Запуск ─────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log(`\n✅  SkillLand запущен: http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') console.log('📱  Для телефона открой: http://IP-адрес-компьютера:3000');
  console.log(`🔒  Панель администратора: http://localhost:${PORT}${ADMIN_PATH}\n`);
  const { exec } = require('child_process');
  const open =
    process.platform === 'darwin' ? `open http://localhost:${PORT}` :
    process.platform === 'win32'  ? `start http://localhost:${PORT}` :
                                    `xdg-open http://localhost:${PORT}`;
  exec(open);
});

process.on('SIGINT', () => {
  db.close();
  console.log('\n👋  Сервер остановлен. База данных закрыта.');
  process.exit(0);
});




// Старый ⬇️

// const http = require('http');
// const fs = require('fs');
// const path = require('path');
// const url = require('url');

// const PORT = 3000;
// const REVIEWS_FILE = path.join(__dirname, 'reviews.json');

// // Создать файл отзывов если не существует
// if (!fs.existsSync(REVIEWS_FILE)) {
//   fs.writeFileSync(REVIEWS_FILE, '[]', 'utf-8');
// }

// function readReviews() {
//   try {
//     const data = fs.readFileSync(REVIEWS_FILE, 'utf-8');
//     return JSON.parse(data);
//   } catch {
//     return [];
//   }
// }

// function saveReviews(reviews) {
//   fs.writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2), 'utf-8');
// }

// const MIME = {
//   '.html': 'text/html; charset=utf-8',
//   '.css':  'text/css',
//   '.js':   'application/javascript',
//   '.png':  'image/png',
//   '.jpg':  'image/jpeg',
//   '.ico':  'image/x-icon',
//   '.json': 'application/json',
// };

// function serveStatic(res, filePath) {
//   fs.readFile(filePath, (err, data) => {
//     if (err) {
//       res.writeHead(404);
//       res.end('Not found');
//       return;
//     }
//     const ext = path.extname(filePath);
//     res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
//     res.end(data);
//   });
// }

// const server = http.createServer((req, res) => {
//   // CORS — чтобы работало с file:// тоже
//   res.setHeader('Access-Control-Allow-Origin', '*');
//   res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
//   res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

//   if (req.method === 'OPTIONS') {
//     res.writeHead(204);
//     res.end();
//     return;
//   }

//   const parsed = url.parse(req.url, true);
//   const pathname = parsed.pathname;

//   // ── API: GET /api/reviews ──────────────────────────────────────────
//   if (pathname === '/api/reviews' && req.method === 'GET') {
//     const reviews = readReviews();
//     res.writeHead(200, { 'Content-Type': 'application/json' });
//     res.end(JSON.stringify(reviews));
//     return;
//   }

//   // ── API: POST /api/reviews ─────────────────────────────────────────
//   if (pathname === '/api/reviews' && req.method === 'POST') {
//     let body = '';
//     req.on('data', chunk => { body += chunk; });
//     req.on('end', () => {
//       try {
//         const review = JSON.parse(body);

//         // Валидация
//         if (!review.nick || !review.text || !review.game || !review.stars) {
//           res.writeHead(400, { 'Content-Type': 'application/json' });
//           res.end(JSON.stringify({ error: 'Заполни все поля' }));
//           return;
//         }

//         const reviews = readReviews();

//         // Один отзыв на игру на пользователя
//         const exists = reviews.find(
//           r => r.nick.toLowerCase() === review.nick.toLowerCase() &&
//                r.game === review.game
//         );
//         if (exists) {
//           res.writeHead(409, { 'Content-Type': 'application/json' });
//           res.end(JSON.stringify({ error: 'Ты уже оставил отзыв на эту игру' }));
//           return;
//         }

//         const newReview = {
//           id: Date.now(),
//           nick: String(review.nick).slice(0, 32),
//           game: String(review.game),
//           stars: Math.min(5, Math.max(1, parseInt(review.stars))),
//           text: String(review.text).slice(0, 500),
//           date: new Date().toLocaleDateString('ru-RU'),
//         };

//         reviews.unshift(newReview); // новые сверху
//         saveReviews(reviews);

//         res.writeHead(201, { 'Content-Type': 'application/json' });
//         res.end(JSON.stringify(newReview));
//       } catch {
//         res.writeHead(400, { 'Content-Type': 'application/json' });
//         res.end(JSON.stringify({ error: 'Неверный формат' }));
//       }
//     });
//     return;
//   }

//   // ── Статика ────────────────────────────────────────────────────────
//   let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);

//   // Защита от path traversal
//   if (!filePath.startsWith(__dirname)) {
//     res.writeHead(403);
//     res.end('Forbidden');
//     return;
//   }

//   serveStatic(res, filePath);
// });

// server.listen(PORT, '127.0.0.1', () => {
//   console.log(`\n✅  SkillLand запущен: http://localhost:${PORT}\n`);
//   // Открыть браузер автоматически
//   const { exec } = require('child_process');
//   const open =
//     process.platform === 'darwin' ? `open http://localhost:${PORT}` :
//     process.platform === 'win32'  ? `start http://localhost:${PORT}` :
//                                     `xdg-open http://localhost:${PORT}`;
//   exec(open);
// });

// // Graceful shutdown
// process.on('SIGINT', () => {
//   console.log('\n👋  Сервер остановлен.');
//   process.exit(0);
// });
