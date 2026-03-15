const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./db');
const RoomManager = require('./roomManager');
const gameLogic = require('./gameLogic');
const tournamentEngine = require('./tournament');

// ─── Setup ───
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = 'hand-cricket-secret-' + Date.now();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Initialize database
db.initialize();

// Room and match management
const roomManager = new RoomManager();
const activeMatches = new Map();   // matchId -> match
const playerMatches = new Map();   // playerId -> matchId
const playerSockets = new Map();   // playerId -> socket

// CPU player constant
const CPU_PLAYER = { id: -1, displayName: 'CPU 🤖', avatarColor: '#64748b', socketId: null };

// ─── Auth Routes ───
app.post('/api/register', (req, res) => {
    const { username, password, displayName } = req.body;

    if (!username || !password || !displayName) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    if (username.length < 3 || username.length > 20) {
        return res.status(400).json({ error: 'Username must be 3-20 characters' });
    }
    if (password.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    if (displayName.length < 2 || displayName.length > 20) {
        return res.status(400).json({ error: 'Display name must be 2-20 characters' });
    }

    const user = db.createUser(username, password, displayName);
    if (!user) {
        return res.status(409).json({ error: 'Username already taken' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = db.authenticateUser(username, password);
    if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
});

app.get('/api/profile/:id', (req, res) => {
    const user = db.getUserById(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
});

app.get('/api/history/:id', (req, res) => {
    const history = db.getMatchHistory(parseInt(req.params.id));
    res.json(history);
});

app.get('/api/match/:id', (req, res) => {
    const match = db.getMatchById(parseInt(req.params.id));
    if (!match) return res.status(404).json({ error: 'Match not found' });
    res.json(match);
});

app.get('/api/leaderboard', (req, res) => {
    const leaderboard = db.getLeaderboard();
    res.json(leaderboard);
});

app.get('/api/h2h/:p1/:p2', (req, res) => {
    const p1Id = parseInt(req.params.p1);
    const p2Id = parseInt(req.params.p2);
    if (isNaN(p1Id) || isNaN(p2Id)) return res.status(400).json({ error: 'Invalid player IDs' });
    const stats = db.getHeadToHeadStats(p1Id, p2Id);
    res.json(stats);
});

// ─── Socket.IO ───
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = db.getUserById(decoded.id);
        if (!user) return next(new Error('User not found'));
        socket.user = user;
        next();
    } catch (err) {
        next(new Error('Invalid token'));
    }
});

io.on('connection', (socket) => {
    const user = socket.user;
    console.log(`🟢 ${user.displayName} connected (${user.id})`);

    playerSockets.set(user.id, socket);

    socket.on('disconnect', () => {
        console.log(`🔴 ${user.displayName} disconnected`);
        playerSockets.delete(user.id);

        // Handle disconnection from rooms
        const result = roomManager.leaveRoom(user.id);
        if (result && result.room) {
            io.to(`room:${result.code}`).emit('room-updated', roomManager.getRoomSummary(result.room));
            if (result.adminChanged) {
                io.to(`room:${result.code}`).emit('admin-changed', {
                    newAdmin: { id: result.newAdmin.id, displayName: result.newAdmin.displayName }
                });
            }
        }
        socket.leave(`room:${result?.code}`);

        // Handle disconnection from active match
        const matchId = playerMatches.get(user.id);
        if (matchId) {
            const match = activeMatches.get(matchId);
            if (match && match.state !== gameLogic.STATE.COMPLETED) {
                if (match.isCpuMatch) {
                    // Just clean up CPU matches
                    cleanupMatch(matchId);
                } else {
                    // Forfeit the match
                    const opponent = match.player1.id === user.id ? match.player2 : match.player1;
                    match.state = gameLogic.STATE.COMPLETED;
                    match.winner = opponent.id;

                    const opponentSocket = playerSockets.get(opponent.id);
                    if (opponentSocket) {
                        opponentSocket.emit('match-forfeit', {
                            reason: `${user.displayName} disconnected`,
                            winnerId: opponent.id,
                            winnerName: opponent.displayName
                        });
                    }
                    cleanupMatch(matchId);
                }
            }
        }
    });

    // ─── Tournament Socket Events ───

    socket.on('start-tournament', (callback) => {
        const room = roomManager.getRoomByPlayerId(user.id);
        if (!room) return callback({ error: 'Not in a room' });
        if (room.admin.id !== user.id) return callback({ error: 'Only admin can start tournament' });
        if (room.players.length < 2) return callback({ error: 'Need at least 2 players' });

        const players = room.players.map(p => ({
            id: p.id, displayName: p.displayName, avatarColor: p.avatarColor, socketId: p.socketId || null
        }));

        const t = tournamentEngine.createTournament(room.code, user.id, players);
        const summary = tournamentEngine.getBracketSummary(room.code);

        io.to(`room:${room.code}`).emit('tournament-started', summary);
        callback({ success: true, tournament: summary });
    });

    socket.on('get-bracket', (callback) => {
        const room = roomManager.getRoomByPlayerId(user.id);
        if (!room) return callback({ error: 'Not in a room' });
        const summary = tournamentEngine.getBracketSummary(room.code);
        if (!summary) return callback({ error: 'No active tournament' });
        callback({ success: true, tournament: summary });
    });

    socket.on('open-predictions', ({ bracketMatchId }, callback) => {
        const room = roomManager.getRoomByPlayerId(user.id);
        if (!room) return callback({ error: 'Not in a room' });
        if (room.admin.id !== user.id) return callback({ error: 'Admin only' });

        const result = tournamentEngine.openPredictions(room.code, bracketMatchId);
        if (result.error) return callback({ error: result.error });

        const summary = tournamentEngine.getBracketSummary(room.code);
        io.to(`room:${room.code}`).emit('predictions-open', { bracketMatchId, match: result.match, tournament: summary });
        callback({ success: true });
    });

    socket.on('submit-prediction', ({ bracketMatchId, predictedPlayerId }, callback) => {
        const room = roomManager.getRoomByPlayerId(user.id);
        if (!room) return callback({ error: 'Not in a room' });

        const result = tournamentEngine.savePrediction(room.code, bracketMatchId, user.id, predictedPlayerId);
        if (result.error) return callback({ error: result.error });

        // Broadcast updated prediction tallies
        const summary = tournamentEngine.getBracketSummary(room.code);
        io.to(`room:${room.code}`).emit('predictions-updated', { bracketMatchId, tournament: summary });
        callback({ success: true });
    });

    socket.on('launch-tournament-match', ({ bracketMatchId }, callback) => {
        const room = roomManager.getRoomByPlayerId(user.id);
        if (!room) return callback({ error: 'Not in a room' });
        if (room.admin.id !== user.id) return callback({ error: 'Admin only' });

        const t = tournamentEngine.getTournament(room.code);
        if (!t) return callback({ error: 'No active tournament' });

        const bm = t.matches.find(m => m.id === bracketMatchId);
        if (!bm) return callback({ error: 'Match not found' });

        const p1 = bm.player1;
        const p2 = bm.player2;

        // Skip if either player is already in a match
        if (p1.id > 0 && playerMatches.has(p1.id)) return callback({ error: `${p1.displayName} is already in a match` });
        if (p2.id > 0 && playerMatches.has(p2.id)) return callback({ error: `${p2.displayName} is already in a match` });

        const match = gameLogic.createMatch(p1, p2, 'tournament', room.code);
        match.tournamentId = t.id;
        match.tournamentRoomCode = room.code;
        match.bracketMatchId = bracketMatchId;
        if (p2.id < 0) match.isCpuMatch = true;

        activeMatches.set(match.id, match);
        playerMatches.set(p1.id, match.id);
        playerMatches.set(p2.id, match.id);

        if (p1.id > 0) {
            const s1 = playerSockets.get(p1.id);
            if (s1) s1.join(`match:${match.id}`);
        }
        if (p2.id > 0) {
            const s2 = playerSockets.get(p2.id);
            if (s2) s2.join(`match:${match.id}`);
        }

        tournamentEngine.startBracketMatch(room.code, bracketMatchId, match.id);

        const summary = gameLogic.getMatchSummary(match);
        io.to(`match:${match.id}`).emit('match-start', summary);

        // Notify the whole room so spectators can follow
        const bracketSummary = tournamentEngine.getBracketSummary(room.code);
        io.to(`room:${room.code}`).emit('tournament-match-started', { bracketMatchId, matchId: match.id, bracket: bracketSummary });

        callback({ success: true, matchId: match.id });
    });

    // ─── Room Events ───
    socket.on('create-room', (callback) => {
        const room = roomManager.createRoom({
            id: user.id,
            displayName: user.displayName,
            avatarColor: user.avatarColor,
            socketId: socket.id
        });

        socket.join(`room:${room.code}`);
        callback({ success: true, room: roomManager.getRoomSummary(room) });
    });

    socket.on('join-room', (code, callback) => {
        const result = roomManager.joinRoom(code, {
            id: user.id,
            displayName: user.displayName,
            avatarColor: user.avatarColor,
            socketId: socket.id
        });

        if (result.error) {
            return callback({ error: result.error });
        }

        socket.join(`room:${code.toUpperCase()}`);
        const summary = roomManager.getRoomSummary(result.room);
        io.to(`room:${code.toUpperCase()}`).emit('room-updated', summary);
        callback({ success: true, room: summary });
    });

    socket.on('leave-room', (callback) => {
        const result = roomManager.leaveRoom(user.id);
        if (result?.code) {
            socket.leave(`room:${result.code}`);
            if (result.room) {
                io.to(`room:${result.code}`).emit('room-updated', roomManager.getRoomSummary(result.room));
            }
        }
        if (callback) callback({ success: true });
    });

    socket.on('kick-player', (targetPlayerId, callback) => {
        const result = roomManager.kickPlayer(user.id, targetPlayerId);
        if (result.error) return callback({ error: result.error });

        const targetSocket = playerSockets.get(targetPlayerId);
        if (targetSocket) {
            targetSocket.emit('kicked-from-room');
            targetSocket.leave(`room:${result.code}`);
        }

        io.to(`room:${result.code}`).emit('room-updated', roomManager.getRoomSummary(result.room));
        callback({ success: true });
    });

    socket.on('add-cpu', (callback) => {
        const result = roomManager.addCpuPlayer(user.id);
        if (result.error) return callback({ error: result.error });

        io.to(`room:${result.code}`).emit('room-updated', roomManager.getRoomSummary(result.room));
        callback({ success: true });
    });

    socket.on('remove-cpu', (cpuId, callback) => {
        const result = roomManager.removeCpuPlayer(user.id, cpuId);
        if (result.error) return callback({ error: result.error });

        io.to(`room:${result.code}`).emit('room-updated', roomManager.getRoomSummary(result.room));
        callback({ success: true });
    });

    socket.on('update-room-settings', (newSettings, callback) => {
        const result = roomManager.updateSettings(user.id, newSettings);
        if (result.error) return callback({ error: result.error });

        io.to(`room:${result.code}`).emit('room-updated', roomManager.getRoomSummary(result.room));
        if (callback) callback({ success: true });
    });

    // ─── Start Match in Room (1v1) ───
    socket.on('start-room-match', ({ opponentId }, callback) => {
        const room = roomManager.getRoomByPlayerId(user.id);
        if (!room) return callback({ error: 'You are not in a room' });
        if (room.admin.id !== user.id) return callback({ error: 'Only admin can start matches' });

        const opponent = room.players.find(p => p.id === opponentId);
        if (!opponent) return callback({ error: 'Opponent not found in room' });

        // Check if either player is already in a match
        if (playerMatches.has(user.id)) return callback({ error: 'You are already in a match' });
        if (playerMatches.has(opponentId)) return callback({ error: 'Opponent is already in a match' });

        const match = gameLogic.createMatch(
            { id: user.id, displayName: user.displayName, avatarColor: user.avatarColor, socketId: socket.id },
            { id: opponent.id, displayName: opponent.displayName, avatarColor: opponent.avatarColor, socketId: opponent.socketId },
            'room',
            room.code
        );

        if (opponent.id < 0) {
            match.isCpuMatch = true;
        }

        activeMatches.set(match.id, match);
        playerMatches.set(user.id, match.id);
        playerMatches.set(opponentId, match.id);

        socket.join(`match:${match.id}`);
        const opponentSocket = playerSockets.get(opponentId);
        if (opponentSocket) opponentSocket.join(`match:${match.id}`);

        const summary = gameLogic.getMatchSummary(match);
        io.to(`match:${match.id}`).emit('match-start', summary);
        callback({ success: true, matchId: match.id });
    });

    // ─── CPU Match ───
    socket.on('start-cpu-match', (callback) => {
        if (playerMatches.has(user.id)) return callback({ error: 'You are already in a match' });

        const match = gameLogic.createMatch(
            { id: user.id, displayName: user.displayName, avatarColor: user.avatarColor, socketId: socket.id },
            { ...CPU_PLAYER },
            'cpu'
        );
        match.isCpuMatch = true;

        activeMatches.set(match.id, match);
        playerMatches.set(user.id, match.id);
        socket.join(`match:${match.id}`);

        const summary = gameLogic.getMatchSummary(match);
        socket.emit('match-start', summary);
        callback({ success: true, matchId: match.id });
    });

    // ─── Game Events ───
    socket.on('toss-choice', (choice, callback) => {
        const matchId = playerMatches.get(user.id);
        if (!matchId) return callback({ error: 'Not in a match' });

        const match = activeMatches.get(matchId);
        if (!match) return callback({ error: 'Match not found' });

        const result = gameLogic.processTossChoice(match, user.id, choice);
        if (result.error) return callback({ error: result.error });

        io.to(`match:${matchId}`).emit('toss-choices', {
            player1Choice: result.player1Choice,
            player2Choice: result.player2Choice
        });

        // CPU auto-picks toss number after a delay
        if (match.isCpuMatch) {
            setTimeout(() => {
                const cpuId = getCpuPlayerId(match);
                const cpuNum = Math.floor(Math.random() * 6) + 1;
                const tossResult = gameLogic.processTossNumber(match, cpuId, cpuNum);
                // Don't emit yet; wait for human to also pick
                if (tossResult.bothPicked) {
                    io.to(`match:${matchId}`).emit('toss-result', {
                        player1Number: tossResult.player1Number,
                        player2Number: tossResult.player2Number,
                        sum: tossResult.sum,
                        isOdd: tossResult.isOdd,
                        tossWinner: tossResult.tossWinner,
                        tossWinnerId: tossResult.tossWinnerId
                    });
                }
            }, 500);
        }

        callback({ success: true });
    });

    socket.on('toss-number', (number, callback) => {
        const matchId = playerMatches.get(user.id);
        if (!matchId) return callback({ error: 'Not in a match' });

        const match = activeMatches.get(matchId);
        if (!match) return callback({ error: 'Match not found' });

        const result = gameLogic.processTossNumber(match, user.id, number);
        if (result.error) return callback({ error: result.error });

        if (result.bothPicked) {
            io.to(`match:${matchId}`).emit('toss-result', {
                player1Number: result.player1Number,
                player2Number: result.player2Number,
                sum: result.sum,
                isOdd: result.isOdd,
                tossWinner: result.tossWinner,
                tossWinnerId: result.tossWinnerId
            });
        } else {
            socket.emit('toss-number-waiting');

            // CPU already picked, so if not bothPicked the human hasn't
            // But if CPU match and CPU hasn't picked yet, pick now
            if (match.isCpuMatch && match.toss.player2Number === null) {
                setTimeout(() => {
                    const cpuNum = Math.floor(Math.random() * 6) + 1;
                    const cpuId = getCpuPlayerId(match);
                    const tossResult = gameLogic.processTossNumber(match, cpuId, cpuNum);
                    if (tossResult.bothPicked) {
                        io.to(`match:${matchId}`).emit('toss-result', {
                            player1Number: tossResult.player1Number,
                            player2Number: tossResult.player2Number,
                            sum: tossResult.sum,
                            isOdd: tossResult.isOdd,
                            tossWinner: tossResult.tossWinner,
                            tossWinnerId: tossResult.tossWinnerId
                        });
                    }
                }, 800);
            }
        }

        callback({ success: true });
    });

    socket.on('bat-bowl-choice', (choice, callback) => {
        const matchId = playerMatches.get(user.id);
        if (!matchId) return callback({ error: 'Not in a match' });

        const match = activeMatches.get(matchId);
        if (!match) return callback({ error: 'Match not found' });

        const result = gameLogic.processBatBowlChoice(match, user.id, choice);
        if (result.error) return callback({ error: result.error });

        io.to(`match:${matchId}`).emit('innings-start', {
            batsmanId: result.batsmanId,
            bowlerId: result.bowlerId,
            batsmanName: result.batsmanName,
            bowlerName: result.bowlerName,
            innings: 1
        });

        callback({ success: true });
    });

    // For CPU matches where CPU wins toss
    socket.on('cpu-toss-won', (callback) => {
        const matchId = playerMatches.get(user.id);
        if (!matchId) return callback({ error: 'Not in a match' });

        const match = activeMatches.get(matchId);
        if (!match || !match.isCpuMatch) return callback({ error: 'Not a CPU match' });

        // CPU randomly chooses bat or bowl
        const cpuChoice = Math.random() > 0.5 ? 'bat' : 'bowl';
        const cpuId = getCpuPlayerId(match);
        const result = gameLogic.processBatBowlChoice(match, cpuId, cpuChoice);
        if (result.error) return callback({ error: result.error });

        socket.emit('cpu-chose', { choice: cpuChoice });
        io.to(`match:${matchId}`).emit('innings-start', {
            batsmanId: result.batsmanId,
            bowlerId: result.bowlerId,
            batsmanName: result.batsmanName,
            bowlerName: result.bowlerName,
            innings: 1
        });

        callback({ success: true });
    });

    socket.on('pick-number', (number, callback) => {
        const matchId = playerMatches.get(user.id);
        if (!matchId) return callback({ error: 'Not in a match' });

        const match = activeMatches.get(matchId);
        if (!match) return callback({ error: 'Match not found' });

        // Clear any existing timer
        if (match.turnTimer) {
            clearTimeout(match.turnTimer);
            match.turnTimer = null;
        }

        const result = gameLogic.processPlayerPick(match, user.id, number);
        if (result.error) return callback({ error: result.error });

        // Update learning patterns for the human player
        updateBehaviorPatterns(user.id, number);

        if (result.bothPicked) {
            handleBallResult(matchId, match, result);
        } else {
            if (match.isCpuMatch) {
                // CPU picks after a small delay
                setTimeout(() => {
                    const cpuNum = cpuPickNumber(match);
                    const cpuId = getCpuPlayerId(match);
                    const cpuResult = gameLogic.processPlayerPick(match, cpuId, cpuNum);
                    if (cpuResult.bothPicked) {
                        handleBallResult(matchId, match, cpuResult);
                    }
                }, 200 + Math.random() * 300);
            } else {
                socket.emit('pick-waiting');

                // Set timer for the other player
                match.turnTimer = setTimeout(() => {
                    const randomNum = Math.floor(Math.random() * 6) + 1;
                    const otherPlayerId = match.currentBall.batsmanPick === null ?
                        match.batsman.id : match.bowler.id;

                    const autoResult = gameLogic.processPlayerPick(match, otherPlayerId, randomNum);
                    if (autoResult.bothPicked) {
                        const otherSocket = playerSockets.get(otherPlayerId);
                        if (otherSocket) otherSocket.emit('auto-pick', { number: randomNum });
                        handleBallResult(matchId, match, autoResult);
                    }
                }, gameLogic.TURN_TIMEOUT_MS);
            }
        }

        callback({ success: true });
    });

    socket.on('start-second-innings', (callback) => {
        const matchId = playerMatches.get(user.id);
        if (!matchId) return callback({ error: 'Not in a match' });

        const match = activeMatches.get(matchId);
        if (!match) return callback({ error: 'Match not found' });

        const result = gameLogic.startSecondInnings(match);
        if (result.error) return callback({ error: result.error });

        io.to(`match:${matchId}`).emit('innings-start', {
            batsmanId: match.batsman.id,
            bowlerId: match.bowler.id,
            batsmanName: match.batsman.displayName,
            bowlerName: match.bowler.displayName,
            innings: 2,
            target: match.innings[1].target + 1
        });

        callback({ success: true });
    });

    socket.on('leave-match', (callback) => {
        const matchId = playerMatches.get(user.id);
        if (matchId) {
            socket.leave(`match:${matchId}`);
            playerMatches.delete(user.id);
        }
        if (callback) callback({ success: true });
    });
});

// ─── Behavior Tracking ───
function updateBehaviorPatterns(userId, pick) {
    if (userId < 0) return; // Don't track CPU

    const patterns = db.getUserPatterns(userId);
    if (!patterns.frequency) patterns.frequency = {};
    if (!patterns.transitions) patterns.transitions = {};

    // Update frequency
    patterns.frequency[pick] = (patterns.frequency[pick] || 0) + 1;

    // Update transitions
    if (patterns.lastPick !== undefined) {
        if (!patterns.transitions[patterns.lastPick]) {
            patterns.transitions[patterns.lastPick] = {};
        }
        patterns.transitions[patterns.lastPick][pick] = (patterns.transitions[patterns.lastPick][pick] || 0) + 1;
    }

    patterns.lastPick = pick;
    db.updateUserPatterns(userId, patterns);
}

// ─── CPU AI ───
function cpuPickNumber(match) {
    const isCpuBatting = match.batsman.id < 0;
    const opponentId = isCpuBatting ? match.bowler.id : match.batsman.id;
    const opponentPatterns = opponentId > 0 ? db.getUserPatterns(opponentId) : null;

    let weights = [1, 1, 1, 1, 1, 1]; // Weights for numbers 1-6

    if (opponentPatterns) {
        if (isCpuBatting) {
            // CPU Batting: Avoid numbers the opponent bowls most often
            const freq = opponentPatterns.frequency || {};
            for (let i = 1; i <= 6; i++) {
                const count = freq[i] || 0;
                weights[i - 1] -= Math.min(0.8, count * 0.05); // Reduce weight for common picks
            }
        } else {
            // CPU Bowling: Try to match the number the opponent bats most often
            const freq = opponentPatterns.frequency || {};
            const transitions = opponentPatterns.transitions || {};
            const lastOpponentPick = opponentPatterns.lastPick;

            // Basic frequency weight
            for (let i = 1; i <= 6; i++) {
                const count = freq[i] || 0;
                weights[i - 1] += Math.min(2.0, count * 0.1);
            }

            // Transition weight (stronger)
            if (lastOpponentPick && transitions[lastOpponentPick]) {
                const nextOptions = transitions[lastOpponentPick];
                for (const num in nextOptions) {
                    weights[parseInt(num) - 1] += nextOptions[num] * 0.5;
                }
            }
        }
    }

    // Add some randomness/bias based on game state
    if (isCpuBatting) {
        // Favor 4, 5, 6 naturally when batting
        weights[3] += 0.5; // 4
        weights[4] += 0.5; // 5
        weights[5] += 0.5; // 6
    }

    // Ensure weights are positive
    weights = weights.map(w => Math.max(0.1, w));

    // Weighted random selection
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let random = Math.random() * totalWeight;

    for (let i = 0; i < 6; i++) {
        if (random < weights[i]) return i + 1;
        random -= weights[i];
    }
    return Math.floor(Math.random() * 6) + 1;
}

// ─── AI Helper ───
function getCpuPlayerId(match) {
    if (match.player1.id < 0) return match.player1.id;
    if (match.player2.id < 0) return match.player2.id;
    return -1; // Fallback
}

// ─── Helper Functions ───
function handleBallResult(matchId, match, result) {
    io.to(`match:${matchId}`).emit('ball-result', {
        ballResult: result.ballResult,
        currentScore: result.currentScore,
        currentBalls: result.currentBalls,
        currentOver: result.currentOver,
        target: result.target,
        remainingBalls: result.remainingBalls,
        inningsComplete: result.inningsComplete,
        matchComplete: result.matchComplete
    });

    if (result.inningsComplete && !result.matchComplete) {
        // Innings break
        io.to(`match:${matchId}`).emit('innings-break', {
            firstInningsScore: result.firstInningsScore,
            firstInningsBalls: result.firstInningsBalls,
            target: result.target,
            nextBatsmanId: result.nextBatsmanId,
            nextBowlerId: result.nextBowlerId,
            nextBatsmanName: result.nextBatsmanName,
            nextBowlerName: result.nextBowlerName
        });
    }

    if (result.matchComplete) {
        io.to(`match:${matchId}`).emit('match-end', result.result);

        // Save to database
        saveMatchToDB(match, result.result);
        cleanupMatch(matchId);
    }
}

function saveMatchToDB(match, result) {
    try {
        const inn1 = match.innings[0];
        const inn2 = match.innings[1];

        // Build ball log
        const ballLog = {
            innings1: {
                batsmanId: inn1.batsmanId,
                batsmanName: inn1.batsmanId === match.player1.id ? match.player1.displayName : match.player2.displayName,
                bowlerName: inn1.bowlerId === match.player1.id ? match.player1.displayName : match.player2.displayName,
                balls: inn1.balls,
                totalRuns: inn1.totalRuns,
                wickets: inn1.wickets,
                totalBalls: inn1.totalBallsFaced
            },
            innings2: {
                batsmanId: inn2.batsmanId,
                batsmanName: inn2.batsmanId === match.player1.id ? match.player1.displayName : match.player2.displayName,
                bowlerName: inn2.bowlerId === match.player1.id ? match.player1.displayName : match.player2.displayName,
                balls: inn2.balls,
                totalRuns: inn2.totalRuns,
                wickets: inn2.wickets,
                totalBalls: inn2.totalBallsFaced,
                target: inn2.target
            }
        };

        // Determine who batted in which innings for p1/p2 scores
        const p1IsInn1Batsman = match.player1.id === inn1.batsmanId;

        db.saveMatch({
            matchType: match.matchType,
            roomCode: match.roomCode,
            player1Id: match.player1.id,
            player2Id: match.player2.id,
            player1Name: match.player1.displayName,
            player2Name: match.player2.displayName,
            player1Score: p1IsInn1Batsman ? inn1.totalRuns : inn2.totalRuns,
            player1Balls: p1IsInn1Batsman ? inn1.totalBallsFaced : inn2.totalBallsFaced,
            player1Wickets: p1IsInn1Batsman ? inn1.wickets : inn2.wickets,
            player2Score: p1IsInn1Batsman ? inn2.totalRuns : inn1.totalRuns,
            player2Balls: p1IsInn1Batsman ? inn2.totalBallsFaced : inn1.totalBallsFaced,
            player2Wickets: p1IsInn1Batsman ? inn2.wickets : inn1.wickets,
            winnerId: result.winnerId,
            isTie: result.isTie,
            ballLog: ballLog,
            tournamentId: match.tournamentId,
            tournamentStage: match.tournamentStage
        });

        // Update player stats (skip CPU)
        if (match.player1.id > 0) {
            const p1BattingInnings = match.player1.id === inn1.batsmanId ? inn1 : inn2;
            const p1BowlingInnings = match.player1.id === inn1.bowlerId ? inn1 : inn2;
            db.updateUserStats(
                match.player1.id,
                p1BattingInnings.totalRuns,
                p1BowlingInnings.totalRuns,
                p1BattingInnings.totalBallsFaced,
                p1BowlingInnings.totalBallsFaced,
                result.winnerId === match.player1.id
            );
        }

        if (match.player2.id > 0) {
            const p2BattingInnings = match.player2.id === inn1.batsmanId ? inn1 : inn2;
            const p2BowlingInnings = match.player2.id === inn1.bowlerId ? inn1 : inn2;
            db.updateUserStats(
                match.player2.id,
                p2BattingInnings.totalRuns,
                p2BowlingInnings.totalRuns,
                p2BattingInnings.totalBallsFaced,
                p2BowlingInnings.totalBallsFaced,
                result.winnerId === match.player2.id
            );
        }

        console.log(`💾 Match saved: ${match.player1.displayName} vs ${match.player2.displayName}`);

        // ─── Advance tournament bracket ───
        if (match.bracketMatchId && match.tournamentRoomCode) {
            const advance = tournamentEngine.recordResult(
                match.tournamentRoomCode,
                match.bracketMatchId,
                result.winnerId
            );

            if (advance.success) {
                const summary = tournamentEngine.getBracketSummary(match.tournamentRoomCode);

                if (advance.tournamentComplete) {
                    // Record trophy & notify room
                    if (advance.champion.id > 0) db.recordTournamentWin(advance.champion.id);
                    io.to(`room:${match.tournamentRoomCode}`).emit('tournament-complete', {
                        champion: advance.champion,
                        bracket: summary
                    });
                    tournamentEngine.deleteTournament(match.tournamentRoomCode);
                } else if (advance.roundComplete) {
                    io.to(`room:${match.tournamentRoomCode}`).emit('tournament-bracket-updated', {
                        bracket: summary,
                        nextMatches: advance.nextMatches
                    });
                } else {
                    io.to(`room:${match.tournamentRoomCode}`).emit('tournament-bracket-updated', { bracket: summary });
                }
            }
        }
    } catch (err) {
        console.error('Error saving match:', err);
    }
}

function cleanupMatch(matchId) {
    const match = activeMatches.get(matchId);
    if (match) {
        if (match.turnTimer) clearTimeout(match.turnTimer);
        playerMatches.delete(match.player1.id);
        playerMatches.delete(match.player2.id);
        activeMatches.delete(matchId);
    }
}

// ─── Start Server ───
server.listen(PORT, () => {
    console.log(`\n🏏 Hand Cricket Server running on http://localhost:${PORT}\n`);
});
