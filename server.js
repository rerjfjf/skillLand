const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const OPEN_BROWSER = process.env.SKILLLAND_NO_BROWSER !== '1' && !process.env.RENDER;
const ADMIN_PATH = '/secret-admin-panel-x7k9';
const DB_FILE = process.env.SKILLLAND_DB_FILE || (process.env.RENDER ? path.join('/tmp', 'skillland.db') : path.join(__dirname, 'skillland.db'));

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

  CREATE TABLE IF NOT EXISTS friends (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner      TEXT    NOT NULL COLLATE NOCASE,
    friend     TEXT    NOT NULL COLLATE NOCASE,
    created_at TEXT    DEFAULT (datetime('now','localtime')),
    UNIQUE(owner, friend)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sender     TEXT    NOT NULL COLLATE NOCASE,
    receiver   TEXT    NOT NULL COLLATE NOCASE,
    text       TEXT    NOT NULL,
    game       TEXT,
    type       TEXT    NOT NULL DEFAULT 'text',
    read_at    TEXT,
    created_at TEXT    DEFAULT (datetime('now','localtime'))
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
  searchAccounts: db.prepare(`
    SELECT nick, created_at FROM accounts
    WHERE nick LIKE ? COLLATE NOCASE AND nick <> ? COLLATE NOCASE
    ORDER BY nick COLLATE NOCASE
    LIMIT 12
  `),
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

  // Friends
  getFriends: db.prepare(`
    SELECT f.friend AS nick, f.created_at
    FROM friends f
    WHERE f.owner = ? COLLATE NOCASE
    ORDER BY f.created_at DESC
  `),
  checkFriend: db.prepare('SELECT id FROM friends WHERE owner = ? COLLATE NOCASE AND friend = ? COLLATE NOCASE'),
  addFriend: db.prepare('INSERT OR IGNORE INTO friends (owner, friend) VALUES (?, ?)'),
  deleteFriend: db.prepare('DELETE FROM friends WHERE owner = ? COLLATE NOCASE AND friend = ? COLLATE NOCASE'),
  renameFriendsOwner: db.prepare('UPDATE friends SET owner = ? WHERE owner = ? COLLATE NOCASE'),
  renameFriendsFriend: db.prepare('UPDATE friends SET friend = ? WHERE friend = ? COLLATE NOCASE'),
  deleteFriendsForNick: db.prepare('DELETE FROM friends WHERE owner = ? COLLATE NOCASE OR friend = ? COLLATE NOCASE'),

  // Messages
  getMessagesBetween: db.prepare(`
    SELECT id, sender, receiver, text, game, type, read_at, created_at
    FROM messages
    WHERE (sender = ? COLLATE NOCASE AND receiver = ? COLLATE NOCASE)
       OR (sender = ? COLLATE NOCASE AND receiver = ? COLLATE NOCASE)
    ORDER BY id ASC
    LIMIT 200
  `),
  insertMessage: db.prepare(`
    INSERT INTO messages (sender, receiver, text, game, type)
    VALUES (?, ?, ?, ?, ?)
  `),
  markMessagesRead: db.prepare(`
    UPDATE messages
    SET read_at = datetime('now','localtime')
    WHERE receiver = ? COLLATE NOCASE AND sender = ? COLLATE NOCASE AND read_at IS NULL
  `),
  unreadMessages: db.prepare(`
    SELECT sender, COUNT(*) AS count
    FROM messages
    WHERE receiver = ? COLLATE NOCASE AND read_at IS NULL
    GROUP BY sender
    ORDER BY MAX(id) DESC
  `),
  renameMessagesSender: db.prepare('UPDATE messages SET sender = ? WHERE sender = ? COLLATE NOCASE'),
  renameMessagesReceiver: db.prepare('UPDATE messages SET receiver = ? WHERE receiver = ? COLLATE NOCASE'),
  deleteMessagesForNick: db.prepare('DELETE FROM messages WHERE sender = ? COLLATE NOCASE OR receiver = ? COLLATE NOCASE'),
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
    if (res.req && res.req.method === 'HEAD') { res.end(); return; }
    res.end(data);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function isAllowedOrigin(origin) {
  if (!origin || origin === 'null') return true;
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    );
  } catch {
    return false;
  }
}

function writeCors(req, res) {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
  writeCors(req, res);

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

    if (pathname === '/healthz' && method === 'GET') {
      return json(res, 200, { ok: true, service: 'skillland' });
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
          stmts.renameFriendsOwner.run(finalNick, account.nick);
          stmts.renameFriendsFriend.run(finalNick, account.nick);
          stmts.renameMessagesSender.run(finalNick, account.nick);
          stmts.renameMessagesReceiver.run(finalNick, account.nick);
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
    if (pathname === '/api/users/search' && method === 'GET') {
      const q = String(parsed.query.q || '').trim();
      const me = String(parsed.query.me || '').trim();
      if (q.length < 1) return json(res, 200, []);
      const safeQ = q.replace(/[%_]/g, '');
      const rows = stmts.searchAccounts.all(`%${safeQ}%`, me);
      return json(res, 200, rows.map((row) => publicProfile(row.nick)).filter(Boolean));
    }

    if (pathname === '/api/users/profile' && method === 'GET') {
      const nick = String(parsed.query.nick || '').trim();
      if (!nick) return json(res, 400, { error: 'Ник не указан' });
      const profile = publicProfile(nick);
      if (!profile) return json(res, 404, { error: 'Пользователь не найден' });
      return json(res, 200, profile);
    }

    if (pathname === '/api/friends' && method === 'GET') {
      const nick = String(parsed.query.nick || '').trim();
      if (!nick) return json(res, 400, { error: 'Ник не указан' });
      if (!stmts.findAccount.get(nick)) return json(res, 404, { error: 'Аккаунт не найден' });
      const list = stmts.getFriends.all(nick).map((row) => publicProfile(row.nick)).filter(Boolean);
      return json(res, 200, list);
    }

    if (pathname === '/api/friends' && method === 'POST') {
      const { nick, friendNick } = await readBody(req);
      const owner = String(nick || '').trim();
      const friend = String(friendNick || '').trim();
      if (!owner || !friend) return json(res, 400, { error: 'Ник не указан' });
      if (owner.toLowerCase() === friend.toLowerCase()) return json(res, 400, { error: 'Нельзя добавить самого себя' });
      const ownerAccount = stmts.findAccount.get(owner);
      const friendAccount = stmts.findAccount.get(friend);
      if (!ownerAccount || !friendAccount) return json(res, 404, { error: 'Пользователь не найден' });
      transaction(() => {
        stmts.addFriend.run(ownerAccount.nick, friendAccount.nick);
        stmts.addFriend.run(friendAccount.nick, ownerAccount.nick);
      });
      return json(res, 200, { ok: true, friend: publicProfile(friendAccount.nick) });
    }

    if (pathname === '/api/friends' && method === 'DELETE') {
      const { nick, friendNick } = await readBody(req);
      const owner = String(nick || '').trim();
      const friend = String(friendNick || '').trim();
      if (!owner || !friend) return json(res, 400, { error: 'Ник не указан' });
      transaction(() => {
        stmts.deleteFriend.run(owner, friend);
        stmts.deleteFriend.run(friend, owner);
      });
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/messages' && method === 'GET') {
      const nick = String(parsed.query.nick || '').trim();
      const friend = String(parsed.query.friend || '').trim();
      if (!nick || !friend) return json(res, 400, { error: 'Ник не указан' });
      if (!friendshipExists(nick, friend)) return json(res, 403, { error: 'Чат доступен только друзьям' });
      stmts.markMessagesRead.run(nick, friend);
      const messages = stmts.getMessagesBetween.all(nick, friend, friend, nick);
      return json(res, 200, messages);
    }

    if (pathname === '/api/messages' && method === 'POST') {
      const { from, to, text, game, type } = await readBody(req);
      const sender = String(from || '').trim();
      const receiver = String(to || '').trim();
      const cleanText = String(text || '').trim().slice(0, 600);
      const cleanType = type === 'gift' ? 'gift' : 'text';
      const cleanGame = game && VALID_GAMES.has(game) ? game : null;
      if (!sender || !receiver || !cleanText) return json(res, 400, { error: 'Сообщение пустое' });
      if (!stmts.findAccount.get(sender) || !stmts.findAccount.get(receiver)) return json(res, 404, { error: 'Пользователь не найден' });
      if (!friendshipExists(sender, receiver)) return json(res, 403, { error: 'Сначала добавьте друг друга в друзья' });
      const info = stmts.insertMessage.run(sender, receiver, cleanText, cleanGame, cleanType);
      return json(res, 201, { id: info.lastInsertRowid, sender, receiver, text: cleanText, game: cleanGame, type: cleanType });
    }

    if (pathname === '/api/notifications' && method === 'GET') {
      const nick = String(parsed.query.nick || '').trim();
      if (!nick) return json(res, 400, { error: 'Ник не указан' });
      const rows = stmts.unreadMessages.all(nick);
      const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
      return json(res, 200, { total, bySender: rows });
    }

    if (pathname === '/api/ai/chat' && method === 'POST') {
      const body = await readBody(req);
      const message = String(body.message || '').trim().slice(0, 4000);
      if (!message) return json(res, 400, { error: 'Напиши вопрос для AI' });
      const files = normalizeAiFiles(body.projectFiles);
      const user = String(body.user || 'Гость').trim().slice(0, 40);
      const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
      const prompt = buildAiPrompt({ message, files, user, history });
      const ollamaReply = await askLocalOllama(prompt);
      const reply = ollamaReply || buildLocalAiReply({ message, files, user });
      return json(res, 200, {
        reply,
        provider: ollamaReply ? 'ollama-local' : 'skillland-local',
      });
    }

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
      const friends  = db.prepare('SELECT * FROM friends ORDER BY created_at DESC').all();
      const messages = db.prepare('SELECT id, sender, receiver, type, game, created_at, read_at FROM messages ORDER BY id DESC').all();
      return json(res, 200, { accounts, scores, reviews, friends, messages });
    }

    if (pathname === '/api/admin/delete-account' && method === 'DELETE') {
      const { nick } = await readBody(req);
      if (!nick) return json(res, 400, { error: 'Ник не указан' });
      const deleteAccount = () => transaction(() => {
        stmts.deleteScores.run(nick);
        stmts.deleteReviewsByNick.run(nick);
        stmts.deleteFriendsForNick.run(nick, nick);
        stmts.deleteMessagesForNick.run(nick, nick);
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
    let safePath;
    try {
      safePath = decodeURIComponent(pathname === '/' ? 'index.html' : pathname);
    } catch {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }
    const relativePath = safePath.replace(/^\/+/, '');
    let filePath = path.resolve(__dirname, relativePath);
    if (!filePath.startsWith(`${__dirname}${path.sep}`) && filePath !== path.join(__dirname, 'index.html')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
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

const GAME_LABELS = {
  programmer: 'Программист',
  economist: 'Экономист',
  chef: 'Повар',
  miner: 'Шахтер',
  medic: 'Медик',
};

function bestGameFromScores(scores) {
  let best = 'programmer';
  let value = -1;
  Object.keys(defaultScores()).forEach((game) => {
    const score = sanitizeScore(scores[game]);
    if (score > value) {
      best = game;
      value = score;
    }
  });
  return { game: best, progress: Math.max(0, value), focus: GAME_LABELS[best] || 'SkillLand' };
}

function publicProfile(nick) {
  const account = stmts.findAccount.get(nick);
  if (!account) return null;
  const scores = buildScoresMap(account.nick);
  const reviews = stmts.allReviews.all().filter((review) => String(review.nick).toLowerCase() === String(account.nick).toLowerCase());
  const best = bestGameFromScores(scores);
  return {
    nick: account.nick,
    created_at: account.created_at,
    scores,
    reviews,
    focus: best.focus,
    game: best.game,
    progress: best.progress,
  };
}

function friendshipExists(a, b) {
  return Boolean(stmts.checkFriend.get(a, b) || stmts.checkFriend.get(b, a));
}

function normalizeAiFiles(projectFiles) {
  if (!Array.isArray(projectFiles)) return [];
  return projectFiles.slice(0, 14).map((file) => {
    const name = String(file && file.name || 'file.txt').replace(/[<>:"|?*\u0000-\u001f]/g, '').slice(0, 120) || 'file.txt';
    const text = String(file && file.text || '').slice(0, 24000);
    return { name, text };
  }).filter((file) => file.text.trim() || file.name.trim());
}

function fileExt(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : 'txt';
}

function summarizeAiFiles(files) {
  if (!files.length) return 'Проект пока не загружен.';
  const extCounts = files.reduce((map, file) => {
    const ext = fileExt(file.name);
    map[ext] = (map[ext] || 0) + 1;
    return map;
  }, {});
  const stack = Object.entries(extCounts).map(([ext, count]) => `${ext}: ${count}`).join(', ');
  const names = files.slice(0, 8).map((file) => file.name).join(', ');
  return `Загружено файлов: ${files.length}. Типы: ${stack}. Видимые файлы: ${names}${files.length > 8 ? '...' : ''}`;
}

function buildAiPrompt({ message, files, user, history }) {
  const compactHistory = history.map((item) => {
    const role = item && item.role === 'user' ? 'user' : 'assistant';
    const text = String(item && item.text || '').slice(0, 700);
    return `${role}: ${text}`;
  }).join('\n');
  const fileBlock = files.map((file) => {
    const text = file.text.slice(0, 3500);
    return `### ${file.name}\n${text}`;
  }).join('\n\n').slice(0, 18000);
  return [
    'Ты SkillLand AI внутри образовательного приложения SkillLand.',
    'Отвечай по-русски, кратко, понятно для школьников 5-9 классов.',
    'Не выдумывай доступ к интернету. Если видишь код или текст проекта, анализируй только переданные файлы.',
    `Пользователь: ${user || 'Гость'}`,
    compactHistory ? `История:\n${compactHistory}` : '',
    fileBlock ? `Файлы проекта:\n${fileBlock}` : 'Файлы проекта не загружены.',
    `Вопрос:\n${message}`,
  ].filter(Boolean).join('\n\n');
}

async function askLocalOllama(prompt) {
  if (typeof fetch !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(process.env.SKILLLAND_OLLAMA_URL || 'http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.SKILLLAND_OLLAMA_MODEL || 'llama3.2',
        prompt,
        stream: false,
        options: { temperature: 0.35, num_predict: 700 },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = String(data.response || '').trim();
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildLocalAiReply({ message, files, user }) {
  const lower = message.toLowerCase();
  const hasCode = files.some((file) => /\.(js|ts|jsx|tsx|html|css|json|py|java|cs|cpp|c|h)$/i.test(file.name));
  const lines = [];

  lines.push(`${user || 'Гость'}, я отвечу в локальном режиме SkillLand без отправки данных во внешний сервис.`);
  lines.push(summarizeAiFiles(files));

  if (lower.includes('ошиб') || lower.includes('баг') || lower.includes('не работает')) {
    lines.push('Похоже, ты разбираешь ошибку. Самый быстрый порядок: 1. повторить действие, 2. открыть консоль, 3. найти первое красное сообщение, 4. проверить файл и строку, 5. менять по одному месту за раз.');
    if (hasCode) lines.push('По загруженному проекту начни с файлов, где есть события кнопок, запросы к серверу и селекторы: там чаще всего ломается интерфейс.');
  } else if (lower.includes('упрост') || lower.includes('задани') || lower.includes('школь')) {
    lines.push('Для 5-9 классов лучше делать задания через логику: выбрать порядок действий, найти лишний шаг, собрать алгоритм из карточек, объяснить почему решение работает.');
    lines.push('Хороший уровень сложности: одна цель, 3-5 вариантов ответа, понятная подсказка и короткая обратная связь после попытки.');
  } else if (lower.includes('проект') || files.length) {
    lines.push('По проекту можно двигаться так: сначала цель экрана, потом список кнопок, затем данные, которые сохраняются, и только после этого красота и анимации.');
    if (hasCode) lines.push('Если хочешь, спроси конкретнее: "найди баг в кнопке", "объясни этот файл", "как упростить интерфейс" или "сделай план правок".');
  } else if (lower.includes('проф') || lower.includes('игр')) {
    lines.push('Для профориентации лучше начинать с интереса: что нравится делать, как человек решает задачи, комфортнее ли ему помогать людям, считать, готовить, проектировать или чинить.');
    lines.push('После этого SkillLand может предложить игру: программист, экономист, повар, медик или шахтер.');
  } else {
    lines.push('Я могу помочь с проектом, текстом, идеей игры, разбором кода или профориентационным вопросом. Напиши задачу простыми словами, а если есть файлы, добавь их через плюс или "Открыть проект".');
  }

  return lines.join('\n\n');
}

// ── Запуск ─────────────────────────────────────────────────
server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.warn(`⚠️  SkillLand API уже запущен на http://${HOST}:${PORT}`);
    return;
  }
  console.error(error);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`\n✅  SkillLand запущен: http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') console.log('📱  Для телефона открой: http://IP-адрес-компьютера:3000');
  console.log(`🔒  Панель администратора: http://localhost:${PORT}${ADMIN_PATH}\n`);
  if (!OPEN_BROWSER) return;
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
