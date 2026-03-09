// ─────────────────────────────────────────────
//  Tournament Engine  –  IPL-style knockout
//  Stages: QF → SF → Final (4+ players)
//         SF → Final      (3 players)
//         Final only      (2 players)
// ─────────────────────────────────────────────

const { v4: uuidv4 } = require('uuid');

// ── In-memory store (keyed by tournament code / room code)
const tournaments = new Map();

// ── Status enum
const STATUS = {
    PENDING: 'pending',
    QUARTERFINAL: 'quarterfinal',
    SEMIFINAL: 'semifinal',
    FINAL: 'final',
    COMPLETED: 'completed'
};

// ── Match status
const MATCH_STATUS = {
    UPCOMING: 'upcoming',
    PREDICTION: 'prediction',   // lobby voting window
    LIVE: 'live',
    DONE: 'done'
};

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ─── Create a bracket from a list of players ─────────────────────────────────
function createTournament(roomCode, adminId, players) {
    const n = players.length;
    if (n < 2) throw new Error('Need at least 2 players');

    const shuffled = shuffle(players);
    const id = uuidv4();

    let stage, matches;

    if (n >= 4) {
        stage = STATUS.QUARTERFINAL;
        matches = buildRound(shuffled, stage, 1);
    } else if (n === 3) {
        stage = STATUS.SEMIFINAL;
        // give the 3rd player a bye — they auto-advance to final
        matches = buildRound(shuffled.slice(0, 2), stage, 1);
        matches[0].byePlayer = shuffled[2]; // carried forward
    } else {
        stage = STATUS.FINAL;
        matches = buildRound(shuffled, stage, 1);
    }

    const t = {
        id,
        roomCode,
        adminId,
        status: stage,
        players: shuffled,
        matches,          // all matches across all rounds
        currentRoundMatchIds: matches.map(m => m.id),
        pendingWinners: [],
        champion: null,
        predictions: {},  // matchId -> { userId -> predictedPlayerId }
        createdAt: Date.now()
    };

    tournaments.set(roomCode, t);
    return t;
}

function buildRound(players, stage, roundNum) {
    const matches = [];
    for (let i = 0; i < players.length - 1; i += 2) {
        matches.push({
            id: uuidv4(),
            stage,
            roundNum,
            player1: players[i],
            player2: players[i + 1],
            winner: null,
            status: MATCH_STATUS.UPCOMING,
            matchId: null  // filled when actual game starts
        });
    }
    return matches;
}

// ─── Get tournament by roomCode ───────────────────────────────────────────────
function getTournament(roomCode) {
    return tournaments.get(roomCode) || null;
}

// ─── Open prediction window for a bracket match ───────────────────────────────
function openPredictions(roomCode, bracketMatchId) {
    const t = getTournament(roomCode);
    if (!t) return { error: 'Tournament not found' };

    const bm = findBracketMatch(t, bracketMatchId);
    if (!bm) return { error: 'Match not found' };

    bm.status = MATCH_STATUS.PREDICTION;
    return { success: true, match: bm };
}

// ─── Save a player's prediction ───────────────────────────────────────────────
function savePrediction(roomCode, bracketMatchId, userId, predictedPlayerId) {
    const t = getTournament(roomCode);
    if (!t) return { error: 'Tournament not found' };

    if (!t.predictions[bracketMatchId]) t.predictions[bracketMatchId] = {};
    t.predictions[bracketMatchId][userId] = predictedPlayerId;

    return { success: true };
}

// ─── Start the actual game for a bracket match (move from PREDICTION → LIVE) ──
function startBracketMatch(roomCode, bracketMatchId, gameMatchId) {
    const t = getTournament(roomCode);
    if (!t) return { error: 'Tournament not found' };

    const bm = findBracketMatch(t, bracketMatchId);
    if (!bm) return { error: 'Match not found' };

    bm.status = MATCH_STATUS.LIVE;
    bm.matchId = gameMatchId;
    return { success: true, match: bm };
}

// ─── Record result and advance bracket ────────────────────────────────────────
function recordResult(roomCode, bracketMatchId, winnerId) {
    const t = getTournament(roomCode);
    if (!t) return { error: 'Tournament not found' };

    const bm = findBracketMatch(t, bracketMatchId);
    if (!bm) return { error: 'Match not found' };

    const winner = bm.player1.id === winnerId ? bm.player1 : bm.player2;
    bm.winner = winner;
    bm.status = MATCH_STATUS.DONE;

    t.pendingWinners.push(winner);

    // Check if current round is complete
    const roundMatches = t.matches.filter(m => m.stage === t.status);
    const allDone = roundMatches.every(m => m.status === MATCH_STATUS.DONE);

    if (!allDone) {
        return { success: true, roundComplete: false, tournament: t };
    }

    // Collect winners + byes
    const winners = roundMatches.map(m => m.winner);

    // carry forward bye player (3-player brackets)
    const byePlayer = roundMatches.find(m => m.byePlayer)?.byePlayer;
    if (byePlayer) winners.push(byePlayer);

    t.pendingWinners = [];

    // ─── Advance to next stage ───
    const nextStage = nextRound(t.status, winners.length);

    if (!nextStage) {
        // Tournament done
        t.champion = winners[0];
        t.status = STATUS.COMPLETED;
        return { success: true, roundComplete: true, tournamentComplete: true, champion: winners[0], tournament: t };
    }

    const newMatches = buildRound(winners, nextStage, (roundMatches[0]?.roundNum || 0) + 1);
    t.matches = [...t.matches, ...newMatches];
    t.currentRoundMatchIds = newMatches.map(m => m.id);
    t.status = nextStage;

    return { success: true, roundComplete: true, tournamentComplete: false, nextMatches: newMatches, tournament: t };
}

function nextRound(current, winnerCount) {
    if (winnerCount <= 1) return null;  // final was played

    const order = [STATUS.QUARTERFINAL, STATUS.SEMIFINAL, STATUS.FINAL];
    const idx = order.indexOf(current);

    if (idx === -1 || idx === order.length - 1) return null;
    return order[idx + 1];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function findBracketMatch(t, bracketMatchId) {
    return t.matches.find(m => m.id === bracketMatchId) || null;
}

function getUpcomingMatches(roomCode) {
    const t = getTournament(roomCode);
    if (!t) return [];
    return t.matches.filter(m => m.status === MATCH_STATUS.UPCOMING || m.status === MATCH_STATUS.PREDICTION);
}

function getBracketSummary(roomCode) {
    const t = getTournament(roomCode);
    if (!t) return null;
    return {
        id: t.id,
        status: t.status,
        players: t.players,
        champion: t.champion,
        matches: t.matches.map(m => ({
            id: m.id,
            stage: m.stage,
            player1: { id: m.player1.id, displayName: m.player1.displayName, avatarColor: m.player1.avatarColor },
            player2: { id: m.player2.id, displayName: m.player2.displayName, avatarColor: m.player2.avatarColor },
            winner: m.winner ? { id: m.winner.id, displayName: m.winner.displayName } : null,
            status: m.status,
            predictions: t.predictions[m.id] || {}
        }))
    };
}

function deleteTournament(roomCode) {
    tournaments.delete(roomCode);
}

module.exports = {
    STATUS,
    MATCH_STATUS,
    createTournament,
    getTournament,
    openPredictions,
    savePrediction,
    startBracketMatch,
    recordResult,
    getUpcomingMatches,
    getBracketSummary,
    deleteTournament
};
