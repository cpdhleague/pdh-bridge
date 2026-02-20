// =============================================================
// database.js - SQLite database for moderation & LFG tracking
// =============================================================
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'pdh-bridge.db');
let db;

function initDatabase() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_strikes (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      strike_count INTEGER DEFAULT 0,
      suspended_until TEXT DEFAULT NULL,
      permanent_ban INTEGER DEFAULT 0,
      last_strike_date TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS strike_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT,
      channel_type TEXT,
      guild_id TEXT,
      flagged_content TEXT,
      strike_number INTEGER,
      action_taken TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  
  // LFG posts - now PDH-specific with game_type and notes
  db.exec(`
    CREATE TABLE IF NOT EXISTS lfg_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id TEXT NOT NULL,
      creator_name TEXT,
      game_type TEXT NOT NULL DEFAULT 'casual',
      notes TEXT DEFAULT '',
      max_players INTEGER DEFAULT 4,
      current_players INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      expired INTEGER DEFAULT 0
    )
  `);
  
  // NEW: Track individual players in each LFG post
  // The UNIQUE constraint prevents double-joining
  db.exec(`
    CREATE TABLE IF NOT EXISTS lfg_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lfg_post_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      joined_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (lfg_post_id) REFERENCES lfg_posts(id),
      UNIQUE(lfg_post_id, user_id)
    )
  `);
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS lfg_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lfg_post_id INTEGER NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      FOREIGN KEY (lfg_post_id) REFERENCES lfg_posts(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_articles (
      url TEXT PRIMARY KEY,
      title TEXT,
      posted_at TEXT DEFAULT (datetime('now'))
    )
  `);

  console.log('[Database] Initialized successfully');
}

// =============================================================
// STRIKE / MODERATION FUNCTIONS
// =============================================================

function getUser(userId) {
  return db.prepare('SELECT * FROM user_strikes WHERE user_id = ?').get(userId);
}

function addStrike(userId, username, channelType, guildId, flaggedContent) {
  const transaction = db.transaction(() => {
    let user = getUser(userId);
    if (!user) {
      db.prepare(`INSERT INTO user_strikes (user_id, username, strike_count, last_strike_date) VALUES (?, ?, 0, datetime('now'))`).run(userId, username);
      user = getUser(userId);
    }
    const newCount = user.strike_count + 1;
    let suspendedUntil = null;
    let actionTaken = 'warning';
    if (newCount >= 2) {
      const now = new Date();
      let suspensionDays;
      switch (newCount) {
        case 2: suspensionDays = 7; actionTaken = 'suspended_1_week'; break;
        case 3: suspensionDays = 30; actionTaken = 'suspended_1_month'; break;
        case 4: suspensionDays = 60; actionTaken = 'suspended_2_months'; break;
        case 5: suspensionDays = 90; actionTaken = 'suspended_3_months'; break;
        default: suspensionDays = (newCount - 2) * 30; actionTaken = `suspended_${newCount - 2}_months`; break;
      }
      suspendedUntil = new Date(now.getTime() + suspensionDays * 24 * 60 * 60 * 1000).toISOString();
    }
    db.prepare(`UPDATE user_strikes SET strike_count = ?, suspended_until = ?, username = ?, last_strike_date = datetime('now') WHERE user_id = ?`).run(newCount, suspendedUntil, username, userId);
    db.prepare(`INSERT INTO strike_history (user_id, username, channel_type, guild_id, flagged_content, strike_number, action_taken) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, username, channelType, guildId, flaggedContent, newCount, actionTaken);
    return { strikeCount: newCount, suspendedUntil, actionTaken };
  });
  return transaction();
}

function isUserSuspended(userId) {
  const user = getUser(userId);
  if (!user) return false;
  if (user.permanent_ban) return true;
  if (!user.suspended_until) return false;
  return new Date(user.suspended_until) > new Date();
}

function permanentBan(userId, username) {
  const user = getUser(userId);
  if (!user) {
    db.prepare(`INSERT INTO user_strikes (user_id, username, permanent_ban, last_strike_date) VALUES (?, ?, 1, datetime('now'))`).run(userId, username);
  } else {
    db.prepare('UPDATE user_strikes SET permanent_ban = 1, username = ? WHERE user_id = ?').run(username, userId);
  }
}

function removeBan(userId) {
  db.prepare('UPDATE user_strikes SET permanent_ban = 0, suspended_until = NULL WHERE user_id = ?').run(userId);
}

function getStrikeHistory(userId) {
  return db.prepare('SELECT * FROM strike_history WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

// =============================================================
// LFG FUNCTIONS (with individual player tracking)
// =============================================================

function createLfgPost(creatorId, creatorName, gameType, notes, maxPlayers, expiresAt) {
  const result = db.prepare(`
    INSERT INTO lfg_posts (creator_id, creator_name, game_type, notes, max_players, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(creatorId, creatorName, gameType, notes, maxPlayers, expiresAt);
  const postId = result.lastInsertRowid;
  // Auto-add the creator as player #1
  addLfgPlayer(postId, creatorId, creatorName);
  return postId;
}

function addLfgPlayer(postId, userId, username) {
  // CRITICAL: Check the cap BEFORE inserting.
  // Without this check, multiple people clicking "Join" simultaneously
  // can all get inserted, exceeding the player limit.
  //
  // LEARNING NOTE ON RACE CONDITIONS:
  // Even with this check, there's a tiny window where two players
  // could both read "3 players" and both try to insert as player #4.
  // SQLite's write lock prevents true simultaneous writes, but we
  // add a post-insert recount as a safety net. If we detect we've
  // gone over the cap, we roll back the insert.

  try {
    const post = getLfgPost(postId);
    if (!post) return { success: false, reason: 'post_not_found' };

    // PRE-CHECK: Is the lobby already full?
    const currentCount = db.prepare('SELECT COUNT(*) as cnt FROM lfg_players WHERE lfg_post_id = ?').get(postId).cnt;
    if (currentCount >= post.max_players) {
      return { success: false, reason: 'lobby_full' };
    }

    // Attempt the insert (UNIQUE constraint prevents duplicate joins)
    db.prepare(`INSERT INTO lfg_players (lfg_post_id, user_id, username) VALUES (?, ?, ?)`).run(postId, userId, username);

    // POST-CHECK: Recount to catch any race condition
    const newCount = db.prepare('SELECT COUNT(*) as cnt FROM lfg_players WHERE lfg_post_id = ?').get(postId).cnt;

    if (newCount > post.max_players) {
      // We went over — roll back this player's join
      db.prepare('DELETE FROM lfg_players WHERE lfg_post_id = ? AND user_id = ?').run(postId, userId);
      const correctedCount = db.prepare('SELECT COUNT(*) as cnt FROM lfg_players WHERE lfg_post_id = ?').get(postId).cnt;
      db.prepare('UPDATE lfg_posts SET current_players = ? WHERE id = ?').run(correctedCount, postId);
      return { success: false, reason: 'lobby_full' };
    }

    // Update the cached count on the post
    db.prepare('UPDATE lfg_posts SET current_players = ? WHERE id = ?').run(newCount, postId);
    return { success: true, currentPlayers: newCount, maxPlayers: post.max_players };
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return { success: false, reason: 'already_joined' };
    }
    throw err;
  }
}

function removeLfgPlayer(postId, userId) {
  const result = db.prepare('DELETE FROM lfg_players WHERE lfg_post_id = ? AND user_id = ?').run(postId, userId);
  if (result.changes > 0) {
    const count = db.prepare('SELECT COUNT(*) as cnt FROM lfg_players WHERE lfg_post_id = ?').get(postId).cnt;
    db.prepare('UPDATE lfg_posts SET current_players = ? WHERE id = ?').run(count, postId);
    return { success: true, currentPlayers: count };
  }
  return { success: false, reason: 'not_in_game' };
}

function getLfgPlayers(postId) {
  return db.prepare('SELECT user_id, username FROM lfg_players WHERE lfg_post_id = ? ORDER BY joined_at').all(postId);
}

function addLfgMessage(lfgPostId, guildId, channelId, messageId) {
  db.prepare(`INSERT INTO lfg_messages (lfg_post_id, guild_id, channel_id, message_id) VALUES (?, ?, ?, ?)`).run(lfgPostId, guildId, channelId, messageId);
}

function getExpiredLfgPosts() {
  return db.prepare(`SELECT * FROM lfg_posts WHERE expired = 0 AND expires_at <= datetime('now')`).all();
}

function getLfgMessages(lfgPostId) {
  return db.prepare('SELECT * FROM lfg_messages WHERE lfg_post_id = ?').all(lfgPostId);
}

function markLfgExpired(lfgPostId) {
  db.prepare('UPDATE lfg_posts SET expired = 1 WHERE id = ?').run(lfgPostId);
}

function getLfgPost(lfgPostId) {
  return db.prepare('SELECT * FROM lfg_posts WHERE id = ? AND expired = 0').get(lfgPostId);
}

// =============================================================
// RSS FUNCTIONS
// =============================================================

function hasSeenArticle(url) {
  return !!db.prepare('SELECT 1 FROM seen_articles WHERE url = ?').get(url);
}

function markArticleSeen(url, title) {
  db.prepare('INSERT OR IGNORE INTO seen_articles (url, title) VALUES (?, ?)').run(url, title);
}

/**
 * Count how many articles we've tracked. Used to detect first run
 * (if 0, we've never polled before → seed without posting).
 */
function countSeenArticles() {
  return db.prepare('SELECT COUNT(*) as cnt FROM seen_articles').get().cnt;
}

module.exports = {
  initDatabase, getUser, addStrike, isUserSuspended, permanentBan, removeBan, getStrikeHistory,
  createLfgPost, addLfgPlayer, removeLfgPlayer, getLfgPlayers,
  addLfgMessage, getExpiredLfgPosts, getLfgMessages, markLfgExpired, getLfgPost,
  hasSeenArticle, markArticleSeen, countSeenArticles,
};
