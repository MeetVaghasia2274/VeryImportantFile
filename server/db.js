const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'cricket.db');

let db;

function initialize() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_color TEXT DEFAULT '#00d4ff',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      total_matches INTEGER DEFAULT 0,
      total_wins INTEGER DEFAULT 0,
      total_losses INTEGER DEFAULT 0,
      total_runs_scored INTEGER DEFAULT 0,
      total_runs_conceded INTEGER DEFAULT 0,
      total_balls_faced INTEGER DEFAULT 0,
      total_balls_bowled INTEGER DEFAULT 0,
      highest_score INTEGER DEFAULT 0,
      best_bowling INTEGER DEFAULT 999,
      tournaments_won INTEGER DEFAULT 0,
      patterns TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_type TEXT CHECK(match_type IN ('quick', 'room', 'tournament', 'cpu')) NOT NULL,
      room_code TEXT,
      player1_id INTEGER NOT NULL,
      player2_id INTEGER NOT NULL,
      player1_name TEXT,
      player2_name TEXT,
      player1_score INTEGER DEFAULT 0,
      player1_balls INTEGER DEFAULT 0,
      player1_wickets INTEGER DEFAULT 0,
      player2_score INTEGER DEFAULT 0,
      player2_balls INTEGER DEFAULT 0,
      player2_wickets INTEGER DEFAULT 0,
      winner_id INTEGER,
      is_tie INTEGER DEFAULT 0,
      ball_log TEXT,
      tournament_id INTEGER REFERENCES tournaments(id),
      tournament_stage TEXT,
      played_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      room_code TEXT,
      admin_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT CHECK(status IN ('pending', 'round_robin', 'semifinals', 'finals', 'completed')) DEFAULT 'pending',
      winner_id INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS tournament_participants (
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      points INTEGER DEFAULT 0,
      matches_played INTEGER DEFAULT 0,
      matches_won INTEGER DEFAULT 0,
      runs_scored INTEGER DEFAULT 0,
      runs_conceded INTEGER DEFAULT 0,
      PRIMARY KEY (tournament_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER,
      tournament_id INTEGER REFERENCES tournaments(id),
      user_id INTEGER REFERENCES users(id),
      predicted_winner_id INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tournament_id, user_id, match_id)
    );
  `);

  console.log('✅ Database initialized');
  return db;
}

// ─── User Operations ───
function createUser(username, password, displayName) {
  const hash = bcrypt.hashSync(password, 10);
  const colors = ['#00d4ff', '#ffd700', '#a855f7', '#ff6b6b', '#4ade80', '#f472b6', '#fb923c', '#38bdf8'];
  const avatarColor = colors[Math.floor(Math.random() * colors.length)];
  try {
    const stmt = db.prepare(
      'INSERT INTO users (username, password_hash, display_name, avatar_color) VALUES (?, ?, ?, ?)'
    );
    const result = stmt.run(username, hash, displayName, avatarColor);
    return { id: result.lastInsertRowid, username, displayName, avatarColor };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return null; // Username taken
    }
    throw err;
  }
}

function authenticateUser(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password_hash)) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    avatarColor: user.avatar_color
  };
}

function getUserById(id) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    avatarColor: user.avatar_color,
    stats: {
      totalMatches: user.total_matches,
      totalWins: user.total_wins,
      totalLosses: user.total_losses,
      totalRunsScored: user.total_runs_scored,
      totalRunsConceded: user.total_runs_conceded,
      totalBallsFaced: user.total_balls_faced,
      totalBallsBowled: user.total_balls_bowled,
      highestScore: user.highest_score,
      bestBowling: user.best_bowling === 999 ? null : user.best_bowling,
      tournamentsWon: user.tournaments_won
    },
    patterns: JSON.parse(user.patterns || '{}'),
    createdAt: user.created_at
  };
}

function updateUserPatterns(userId, patterns) {
  db.prepare('UPDATE users SET patterns = ? WHERE id = ?').run(
    JSON.stringify(patterns),
    userId
  );
}

function getUserPatterns(userId) {
  const row = db.prepare('SELECT patterns FROM users WHERE id = ?').get(userId);
  return JSON.parse(row?.patterns || '{}');
}

function updateUserStats(userId, runsScored, runsConceded, ballsFaced, ballsBowled, won) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return;

  const newHighest = Math.max(user.highest_score, runsScored);
  const newBestBowling = Math.min(user.best_bowling, runsConceded);

  db.prepare(`
    UPDATE users SET
      total_matches = total_matches + 1,
      total_wins = total_wins + ?,
      total_losses = total_losses + ?,
      total_runs_scored = total_runs_scored + ?,
      total_runs_conceded = total_runs_conceded + ?,
      total_balls_faced = total_balls_faced + ?,
      total_balls_bowled = total_balls_bowled + ?,
      highest_score = ?,
      best_bowling = ?
    WHERE id = ?
  `).run(
    won ? 1 : 0,
    won ? 0 : 1,
    runsScored,
    runsConceded,
    ballsFaced,
    ballsBowled,
    newHighest,
    newBestBowling,
    userId
  );
}

// ─── Match Operations ───
function saveMatch(matchData) {
  const stmt = db.prepare(`
    INSERT INTO matches (match_type, room_code, player1_id, player2_id,
      player1_name, player2_name,
      player1_score, player1_balls, player1_wickets,
      player2_score, player2_balls, player2_wickets,
      winner_id, is_tie, ball_log, tournament_id, tournament_stage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    matchData.matchType,
    matchData.roomCode || null,
    matchData.player1Id,
    matchData.player2Id,
    matchData.player1Name || null,
    matchData.player2Name || null,
    matchData.player1Score,
    matchData.player1Balls,
    matchData.player1Wickets || 0,
    matchData.player2Score,
    matchData.player2Balls,
    matchData.player2Wickets || 0,
    matchData.winnerId || null,
    matchData.isTie ? 1 : 0,
    matchData.ballLog ? JSON.stringify(matchData.ballLog) : null,
    matchData.tournamentId || null,
    matchData.tournamentStage || null
  );
  return result.lastInsertRowid;
}

function getMatchById(matchId) {
  const m = db.prepare(`
    SELECT m.*,
      u1.display_name as p1_display_name, u1.avatar_color as p1_avatar_color,
      u2.display_name as p2_display_name, u2.avatar_color as p2_avatar_color
    FROM matches m
    LEFT JOIN users u1 ON m.player1_id = u1.id
    LEFT JOIN users u2 ON m.player2_id = u2.id
    WHERE m.id = ?
  `).get(matchId);
  if (!m) return null;

  return {
    id: m.id,
    matchType: m.match_type,
    roomCode: m.room_code,
    player1: {
      id: m.player1_id,
      displayName: m.p1_display_name || m.player1_name || 'Player 1',
      avatarColor: m.p1_avatar_color || '#00d4ff',
      score: m.player1_score,
      balls: m.player1_balls,
      wickets: m.player1_wickets
    },
    player2: {
      id: m.player2_id,
      displayName: m.p2_display_name || m.player2_name || 'Player 2',
      avatarColor: m.p2_avatar_color || '#a855f7',
      score: m.player2_score,
      balls: m.player2_balls,
      wickets: m.player2_wickets
    },
    winnerId: m.winner_id,
    isTie: m.is_tie,
    ballLog: m.ball_log ? JSON.parse(m.ball_log) : null,
    playedAt: m.played_at
  };
}

function getMatchHistory(userId, limit = 20) {
  return db.prepare(`
    SELECT m.*,
      u1.display_name as p1_display_name, u1.avatar_color as player1_color,
      u2.display_name as p2_display_name, u2.avatar_color as player2_color,
      w.display_name as winner_name
    FROM matches m
    LEFT JOIN users u1 ON m.player1_id = u1.id
    LEFT JOIN users u2 ON m.player2_id = u2.id
    LEFT JOIN users w ON m.winner_id = w.id
    WHERE m.player1_id = ? OR m.player2_id = ?
    ORDER BY m.played_at DESC
    LIMIT ?
  `).all(userId, userId, limit).map(m => ({
    ...m,
    player1_name: m.p1_display_name || m.player1_name || 'CPU',
    player2_name: m.p2_display_name || m.player2_name || 'CPU'
  }));
}

function getLeaderboard(limit = 20) {
  return db.prepare(`
    SELECT id, display_name, avatar_color, total_matches, total_wins,
      total_runs_scored, highest_score, tournaments_won,
      CASE WHEN total_matches > 0
        THEN ROUND(CAST(total_wins AS REAL) / total_matches * 100, 1)
        ELSE 0 END as win_rate
    FROM users
    WHERE total_matches > 0
    ORDER BY total_wins DESC, win_rate DESC
    LIMIT ?
  `).all(limit);
}

function getHeadToHeadStats(p1Id, p2Id) {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_matches,
      SUM(CASE WHEN winner_id = ? THEN 1 ELSE 0 END) as p1_wins,
      SUM(CASE WHEN winner_id = ? THEN 1 ELSE 0 END) as p2_wins,
      SUM(CASE WHEN is_tie = 1 THEN 1 ELSE 0 END) as ties
    FROM matches
    WHERE (player1_id = ? AND player2_id = ?)
       OR (player1_id = ? AND player2_id = ?)
  `).get(p1Id, p2Id, p1Id, p2Id, p2Id, p1Id);

  const runs = db.prepare(`
    SELECT
      SUM(CASE WHEN player1_id = ? THEN player1_score ELSE player2_score END) as p1_total_runs,
      SUM(CASE WHEN player1_id = ? THEN player1_score ELSE player2_score END) as p2_total_runs
    FROM matches
    WHERE (player1_id = ? AND player2_id = ?)
       OR (player1_id = ? AND player2_id = ?)
  `).get(p1Id, p2Id, p1Id, p2Id, p2Id, p1Id);

  return {
    totalMatches: stats.total_matches || 0,
    p1Wins: stats.p1_wins || 0,
    p2Wins: stats.p2_wins || 0,
    ties: stats.ties || 0,
    p1TotalRuns: runs.p1_total_runs || 0,
    p2TotalRuns: runs.p2_total_runs || 0
  };
}

function savePrediction(tournamentId, matchId, userId, predictedWinnerId) {
  db.prepare(`
    INSERT OR REPLACE INTO predictions (tournament_id, match_id, user_id, predicted_winner_id)
    VALUES (?, ?, ?, ?)
  `).run(tournamentId, matchId, userId, predictedWinnerId);
}

function getPredictionsForMatch(matchId) {
  return db.prepare(`
    SELECT p.*, u.display_name as username, pw.display_name as predicted_winner_name
    FROM predictions p
    JOIN users u ON p.user_id = u.id
    JOIN users pw ON p.predicted_winner_id = pw.id
    WHERE p.match_id = ?
  `).all(matchId);
}

function recordTournamentWin(userId) {
  db.prepare('UPDATE users SET tournaments_won = tournaments_won + 1 WHERE id = ?').run(userId);
}

module.exports = {
  initialize,
  createUser,
  authenticateUser,
  getUserById,
  updateUserStats,
  saveMatch,
  getMatchById,
  getMatchHistory,
  getLeaderboard,
  updateUserPatterns,
  getUserPatterns,
  getHeadToHeadStats,
  savePrediction,
  getPredictionsForMatch,
  recordTournamentWin
};
