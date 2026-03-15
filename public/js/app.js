/* ═══════════════════════════════════════════════════════
   HAND CRICKET — Client Application
   ═══════════════════════════════════════════════════════ */

// ─── State ───
let currentUser = null;
let authToken = null;
let socket = null;
let currentRoom = null;
let currentMatch = null;
let selectedOpponentId = null;
let myRole = null;           // 'batsman' or 'bowler'
let isSpectator = false;
let timerInterval = null;
let timerStartTime = null;
let roomMode = '1v1';        // '1v1' or 'tournament'
let isCpuMatch = false;
let currentTournament = null;         // live bracket state
let activeBracketMatchId = null;      // which bracket match is in prediction/launch mode
const TURN_TIME = 8000;
const CPU_ID = -1;

// ─── Screens ───
const screens = {
    auth: document.getElementById('auth-screen'),
    dashboard: document.getElementById('dashboard-screen'),
    room: document.getElementById('room-screen'),
    tournament: document.getElementById('tournament-screen'),
    game: document.getElementById('game-screen')
};

// ─── Initialization ───
window.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('handcricket_auth');
    if (saved) {
        try {
            const data = JSON.parse(saved);
            authToken = data.token;
            currentUser = data.user;
            connectSocket();
            showScreen('dashboard');
            updateDashboardUI();
        } catch (e) {
            localStorage.removeItem('handcricket_auth');
        }
    }
    hideLoading();
});

function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.add('fade-out');
    setTimeout(() => overlay.classList.add('hidden'), 500);
}

// ═══════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════
function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.add('hidden'));
    screens[name].classList.remove('hidden');
}

function hideModals() {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

function closePanel() {
    document.getElementById('stats-panel').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════
function switchAuthTab(tab) {
    document.getElementById('login-tab').classList.toggle('active', tab === 'login');
    document.getElementById('register-tab').classList.toggle('active', tab === 'register');
    document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
    document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
    document.getElementById('auth-error').classList.add('hidden');
}

async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('auth-error');
    const btn = document.getElementById('login-btn');

    btn.disabled = true;
    btn.querySelector('span').textContent = 'Signing in...';

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (!res.ok) {
            errorEl.textContent = data.error;
            errorEl.classList.remove('hidden');
            return;
        }

        authToken = data.token;
        currentUser = data.user;
        localStorage.setItem('handcricket_auth', JSON.stringify({ token: authToken, user: currentUser }));

        connectSocket();
        showScreen('dashboard');
        updateDashboardUI();
        showToast('Welcome back, ' + currentUser.displayName + '!', 'success');
    } catch (err) {
        errorEl.textContent = 'Connection error. Please try again.';
        errorEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.querySelector('span').textContent = 'Sign In';
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const displayName = document.getElementById('reg-display').value.trim();
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const errorEl = document.getElementById('auth-error');
    const btn = document.getElementById('register-btn');

    btn.disabled = true;
    btn.querySelector('span').textContent = 'Creating account...';

    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, displayName })
        });
        const data = await res.json();

        if (!res.ok) {
            errorEl.textContent = data.error;
            errorEl.classList.remove('hidden');
            return;
        }

        authToken = data.token;
        currentUser = data.user;
        localStorage.setItem('handcricket_auth', JSON.stringify({ token: authToken, user: currentUser }));

        connectSocket();
        showScreen('dashboard');
        updateDashboardUI();
        showToast('Account created! Welcome, ' + currentUser.displayName + '! 🎉', 'success');
    } catch (err) {
        errorEl.textContent = 'Connection error. Please try again.';
        errorEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.querySelector('span').textContent = 'Create Account';
    }
}

function logout() {
    if (socket) socket.disconnect();
    socket = null;
    currentUser = null;
    authToken = null;
    currentRoom = null;
    currentMatch = null;
    isCpuMatch = false;
    localStorage.removeItem('handcricket_auth');
    showScreen('auth');
}

// ═══════════════════════════════════════════════════════
// SOCKET CONNECTION
// ═══════════════════════════════════════════════════════
function connectSocket() {
    if (socket) socket.disconnect();

    socket = io({ auth: { token: authToken } });

    socket.on('connect', () => {
        console.log('🟢 Connected to server');
    });

    socket.on('connect_error', (err) => {
        console.error('Connection error:', err.message);
        if (err.message.includes('Authentication') || err.message.includes('token')) {
            logout();
            showToast('Session expired. Please login again.', 'error');
        }
    });

    // Room events
    socket.on('room-updated', (room) => {
        currentRoom = room;
        updateRoomUI();
    });

    socket.on('admin-changed', (data) => {
        showToast(`${data.newAdmin.displayName} is now the admin`, 'info');
    });

    socket.on('kicked-from-room', () => {
        currentRoom = null;
        showScreen('dashboard');
        showToast('You were removed from the room', 'error');
    });

    // Match events
    socket.on('match-start', (matchData) => {
        currentMatch = matchData;
        isCpuMatch = matchData.player2.id === CPU_ID;
        hideModals();
        showScreen('game');
        initGameUI(matchData);
    });

    socket.on('toss-choices', (data) => {
        handleTossChoices(data);
    });

    socket.on('toss-number-waiting', () => {
        document.getElementById('toss-number-btns').classList.add('hidden');
        document.getElementById('toss-waiting').classList.remove('hidden');
    });

    socket.on('toss-result', (data) => {
        handleTossResult(data);
    });

    socket.on('cpu-chose', (data) => {
        showToast(`CPU chose to ${data.choice} first`, 'info');
    });

    socket.on('innings-start', (data) => {
        handleInningsStart(data);
    });

    socket.on('super-over-start', (matchData) => {
        currentMatch = matchData;
        showToast('🔥 MATCH TIED! SUPER OVER INITIATED! 🔥', 'warning');
        
        // Short delay to let the result notification pass
        setTimeout(() => {
            // Re-init partial game UI without toss because Super Over skips toss
            hideAllPhases();
            document.getElementById('innings-label').textContent = 'Super Over';
            
            // Wait for server to send 'innings-start' via processSuperOver,
            // Actually the server already sets state to PLAYING but we need to tell clients to prepare for it.
            // When Super Over starts, we need to know who is batting. It's in the matchData.
            const inn1 = matchData.innings1;
            handleInningsStart({
                batsmanId: inn1.batsmanId,
                batsmanName: inn1.batsmanId === matchData.player1.id ? matchData.player1.displayName : matchData.player2.displayName,
                innings: 1,
                target: null
            });
        }, 3000);
    });

    socket.on('ball-result', (data) => {
        handleBallResult(data);
    });

    socket.on('pick-waiting', () => {
        showPickWaiting();
    });

    socket.on('auto-pick', (data) => {
        showToast(`Time's up! Auto-picked ${data.number}`, 'info');
    });

    socket.on('innings-break', (data) => {
        handleInningsBreak(data);
    });

    socket.on('match-end', (data) => {
        handleMatchEnd(data);
    });

    socket.on('match-forfeit', (data) => {
        handleMatchForfeit(data);
    });

    // ─── Tournament Events ───
    socket.on('tournament-started', (tournament) => {
        currentTournament = tournament;
        showScreen('tournament');
        renderBracket(tournament);
        document.getElementById('tournament-stage-badge').textContent = stageName(tournament.status);
        showToast('🏆 Tournament started!', 'success');
    });

    socket.on('predictions-open', ({ bracketMatchId, match, tournament }) => {
        currentTournament = tournament;
        activeBracketMatchId = bracketMatchId;
        renderBracket(tournament);
        openPredictionPanel(match, bracketMatchId);
        showToast('🗳️ Place your prediction!', 'info');
    });

    socket.on('predictions-updated', ({ bracketMatchId, tournament }) => {
        currentTournament = tournament;
        renderBracket(tournament);
        if (activeBracketMatchId === bracketMatchId) {
            updateVoteTally(tournament, bracketMatchId);
        }
    });

    socket.on('tournament-match-started', ({ bracketMatchId, matchId, bracket }) => {
        currentTournament = bracket;
        renderBracket(bracket);
        document.getElementById('prediction-panel').classList.add('hidden');
        
        // Auto-spectate if not playing
        if (currentMatch && currentMatch.id === matchId) return; // already joined via match-start

        socket.emit('spectate-match', { matchId }, (res) => {
            if (res.success) {
                currentMatch = res.match;
                isCpuMatch = currentMatch.player2.id === CPU_ID;
                hideModals();
                showScreen('game');
                initGameUI(res.match);
            } else {
                showToast(res.error, 'error');
            }
        });
    });

    socket.on('tournament-bracket-updated', ({ bracket, nextMatches }) => {
        currentTournament = bracket;
        renderBracket(bracket);
        document.getElementById('tournament-stage-badge').textContent = stageName(bracket.status);
        if (nextMatches && nextMatches.length > 0) {
            showToast(`Next up: ${nextMatches[0].player1.displayName} vs ${nextMatches[0].player2.displayName}`, 'info');
        }
    });

    socket.on('tournament-complete', ({ champion, bracket }) => {
        currentTournament = bracket;
        renderBracket(bracket);
        showChampionBanner(champion);
    });
}

// ═══════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════
function updateDashboardUI() {
    if (!currentUser) return;
    document.getElementById('user-display-name').textContent = currentUser.displayName;
    document.getElementById('welcome-name').textContent = currentUser.displayName;

    const avatar = document.getElementById('user-avatar');
    avatar.style.background = currentUser.avatarColor;
    avatar.textContent = currentUser.displayName.charAt(0);
}

function showCreateRoom() {
    socket.emit('create-room', (response) => {
        if (response.error) {
            showToast(response.error, 'error');
            return;
        }
        currentRoom = response.room;
        showScreen('room');
        updateRoomUI();
        showToast('Room created! Share the code with friends.', 'success');
    });
}

function showJoinRoom() {
    document.getElementById('join-room-modal').classList.remove('hidden');
    document.getElementById('join-code-input').value = '';
    document.getElementById('join-code-input').focus();
    document.getElementById('join-error').classList.add('hidden');
}

function joinRoom() {
    const code = document.getElementById('join-code-input').value.trim().toUpperCase();
    const errorEl = document.getElementById('join-error');

    if (code.length !== 6) {
        errorEl.textContent = 'Please enter a 6-character code';
        errorEl.classList.remove('hidden');
        return;
    }

    socket.emit('join-room', code, (response) => {
        if (response.error) {
            errorEl.textContent = response.error;
            errorEl.classList.remove('hidden');
            return;
        }
        currentRoom = response.room;
        hideModals();
        showScreen('room');
        updateRoomUI();
        showToast('Joined the room!', 'success');
    });
}

// ─── CPU Match ───
function startCpuMatch() {
    socket.emit('start-cpu-match', (response) => {
        if (response.error) {
            showToast(response.error, 'error');
            return;
        }
        showToast('CPU match starting!', 'success');
    });
}

// ─── Stats ───
async function showProfile() {
    const panel = document.getElementById('stats-panel');
    const content = document.getElementById('stats-content');
    panel.classList.remove('hidden');
    content.innerHTML = '<div class="waiting-msg"><div class="mini-spinner"></div><span>Loading stats...</span></div>';

    try {
        const [profileRes, historyRes] = await Promise.all([
            fetch(`/api/profile/${currentUser.id}`),
            fetch(`/api/history/${currentUser.id}`)
        ]);
        const profile = await profileRes.json();
        const history = await historyRes.json();

        const stats = profile.stats;
        const winRate = stats.totalMatches > 0 ?
            ((stats.totalWins / stats.totalMatches) * 100).toFixed(1) : '0.0';
        const avgScore = stats.totalMatches > 0 ?
            (stats.totalRunsScored / stats.totalMatches).toFixed(1) : '0';

        let html = `
      <div class="stats-grid">
        <div class="stat-item">
          <div class="stat-value">${stats.totalMatches}</div>
          <div class="stat-label">Matches</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">${stats.totalWins}</div>
          <div class="stat-label">Wins</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">${winRate}%</div>
          <div class="stat-label">Win Rate</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">${stats.totalRunsScored}</div>
          <div class="stat-label">Total Runs</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">${stats.highestScore || 0}</div>
          <div class="stat-label">Highest Score</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">${avgScore}</div>
          <div class="stat-label">Avg Score</div>
        </div>
      </div>
    `;

        if (history.length > 0) {
            html += '<h4 style="margin-bottom:0.75rem;color:var(--text-secondary);">Recent Matches</h4>';
            html += '<div class="match-history-list">';
            history.forEach(m => {
                const isP1 = m.player1_id === currentUser.id;
                const myScore = isP1 ? m.player1_score : m.player2_score;
                const oppScore = isP1 ? m.player2_score : m.player1_score;
                const oppName = isP1 ? m.player2_name : m.player1_name;
                const won = m.winner_id === currentUser.id;
                const tied = m.is_tie;
                const resultClass = tied ? 'tie' : (won ? 'win' : 'loss');
                const resultText = tied ? 'T' : (won ? 'W' : 'L');
                const matchType = m.match_type === 'cpu' ? '🤖' : (m.match_type === 'room' ? '🏠' : '⚔️');

                html += `
          <div class="history-item clickable" onclick="showMatchDetail(${m.id})">
            <div class="history-result ${resultClass}">${resultText}</div>
            <div class="history-detail">
              <div>${matchType} vs ${oppName}</div>
              <div class="history-score">${myScore} - ${oppScore}</div>
            </div>
            <span class="history-arrow">→</span>
          </div>
        `;
            });
            html += '</div>';
        } else {
            html += '<p style="color:var(--text-muted);text-align:center;margin-top:1rem;">No matches played yet</p>';
        }

        content.innerHTML = html;
    } catch (err) {
        content.innerHTML = '<p style="color:var(--accent-red);">Error loading stats</p>';
    }
}

// ─── Match Detail ───
async function showMatchDetail(matchId) {
    const modal = document.getElementById('match-detail-modal');
    const content = document.getElementById('match-detail-content');
    modal.classList.remove('hidden');
    content.innerHTML = '<div class="waiting-msg"><div class="mini-spinner"></div><span>Loading...</span></div>';

    try {
        const res = await fetch(`/api/match/${matchId}`);
        const match = await res.json();

        if (res.status === 404) {
            content.innerHTML = '<p style="color:var(--accent-red);">Match not found</p>';
            return;
        }

        const p1 = match.player1;
        const p2 = match.player2;
        const iWon = match.winnerId === currentUser.id;
        const isTie = match.isTie;

        let resultText = isTie ? '🤝 Match Tied' : (iWon ? '🏆 Victory!' : '😔 Defeat');
        let resultClass = isTie ? 'tied' : (iWon ? 'won' : 'lost');

        let html = `
      <div class="match-detail-header">
        <div class="match-detail-players">
          <div class="match-detail-player">
            <div class="avatar-md" style="background:${p1.avatarColor}">${p1.displayName.charAt(0)}</div>
            <span class="match-detail-player-name">${p1.displayName}</span>
          </div>
          <span class="vs-text" style="font-size:0.9rem">VS</span>
          <div class="match-detail-player">
            <div class="avatar-md" style="background:${p2.avatarColor}">${p2.displayName.charAt(0)}</div>
            <span class="match-detail-player-name">${p2.displayName}</span>
          </div>
        </div>
        <div class="match-detail-result ${resultClass}">${resultText}</div>
        <div class="match-detail-type">${match.matchType} match • ${new Date(match.playedAt).toLocaleDateString()}</div>
      </div>
    `;

        // Scorecard summary
        html += `
      <div class="scorecard-row ${match.winnerId === p1.id ? 'winner-row' : 'loser-row'}">
        <span class="scorecard-player">${p1.displayName} ${match.winnerId === p1.id ? '🏆' : ''}</span>
        <span class="scorecard-score">${p1.score}/${p1.wickets} (${formatBalls(p1.balls)})</span>
      </div>
      <div class="scorecard-row ${match.winnerId === p2.id ? 'winner-row' : 'loser-row'}" style="margin-bottom:1.5rem">
        <span class="scorecard-player">${p2.displayName} ${match.winnerId === p2.id ? '🏆' : ''}</span>
        <span class="scorecard-score">${p2.score}/${p2.wickets} (${formatBalls(p2.balls)})</span>
      </div>
    `;

        // Ball-by-ball log
        if (match.ballLog) {
            html += renderInningsDetail('1st Innings', match.ballLog.innings1);
            html += renderInningsDetail('2nd Innings', match.ballLog.innings2);
        }

        content.innerHTML = html;
    } catch (err) {
        content.innerHTML = '<p style="color:var(--accent-red);">Error loading match details</p>';
    }
}

function renderInningsDetail(title, innings) {
    if (!innings || !innings.balls || innings.balls.length === 0) {
        return `<div class="innings-detail">
      <div class="innings-detail-header">
        <span class="innings-detail-title">${title}</span>
        <span class="innings-detail-score">DNP</span>
      </div>
    </div>`;
    }

    let html = `
    <div class="innings-detail">
      <div class="innings-detail-header">
        <span class="innings-detail-title">${title} — ${innings.batsmanName} batting</span>
        <span class="innings-detail-score">${innings.totalRuns}/${innings.wickets}</span>
      </div>
      <div class="innings-detail-meta">
        ${innings.totalBalls} balls bowled by ${innings.bowlerName}
        ${innings.target !== undefined && innings.target !== null ? ` • Target: ${innings.target + 1}` : ''}
      </div>
      <div class="ball-log-detail">
  `;

    innings.balls.forEach((ball, i) => {
        // Add over separator
        if (ball.ball === 0 && ball.over > 0) {
            html += '<div class="over-separator" style="height:30px"></div>';
        }

        if (ball.isWicket) {
            html += `<div class="ball-indicator wicket" title="Ball ${ball.ballLabel}: ${ball.batsmanPick} vs ${ball.bowlerPick} — OUT!">W</div>`;
        } else {
            html += `<div class="ball-indicator runs-${ball.runs}" title="Ball ${ball.ballLabel}: ${ball.batsmanPick} vs ${ball.bowlerPick} — ${ball.runs} runs">${ball.runs}</div>`;
        }
    });

    html += '</div></div>';
    return html;
}

// ═══════════════════════════════════════════════════════
// ROOM
// ═══════════════════════════════════════════════════════
function setRoomMode(mode) {
    roomMode = mode;
    document.getElementById('mode-1v1-btn').classList.toggle('active', mode === '1v1');
    document.getElementById('mode-tournament-btn').classList.toggle('active', mode === 'tournament');
    updateRoomUI();
}

function updateRoomUI() {
    if (!currentRoom) return;

    document.getElementById('room-code-text').textContent = currentRoom.code;
    document.getElementById('room-code-big').textContent = currentRoom.code;
    document.getElementById('room-player-count').textContent = `${currentRoom.playerCount}/${currentRoom.maxPlayers} Players`;

    const grid = document.getElementById('players-grid');
    grid.innerHTML = '';

    const isAdmin = currentRoom.admin.id === currentUser.id;

    currentRoom.players.forEach(p => {
        const card = document.createElement('div');
        card.className = 'player-card';
        if (p.isAdmin) card.classList.add('is-admin');
        if (p.id === currentUser.id) card.classList.add('is-you');
        if (p.id === selectedOpponentId) card.classList.add('selected');

        const isMe = p.id === currentUser.id;
        const isCpu = p.id < 0;

        card.innerHTML = `
      <div class="player-avatar" style="background:${p.avatarColor}">${isCpu ? '🤖' : p.displayName.charAt(0)}</div>
      <div class="player-card-name">${p.displayName}${isMe ? ' (You)' : ''}</div>
      <div class="player-card-tag">${p.isAdmin ? '👑 Admin' : (isCpu ? 'Bot' : 'Player')}</div>
      ${isAdmin && !isMe ? `<button class="kick-btn" onclick="${isCpu ? `removeCpu(${p.id})` : `kickPlayer(${p.id})`}" title="${isCpu ? 'Remove CPU' : 'Kick Player'}">✕</button>` : ''}
    `;

        if (isAdmin && !isMe && roomMode === '1v1') {
            card.addEventListener('click', () => selectOpponent(p));
        }

        grid.appendChild(card);
    });

    // Show/hide Admin Management section
    const adminMgmt = document.getElementById('admin-management-btns');
    if (isAdmin) {
        adminMgmt.classList.remove('hidden');
    } else {
        adminMgmt.classList.add('hidden');
    }

    // Sync Settings UI
    const wicketsSelect = document.getElementById('setting-wickets');
    wicketsSelect.value = currentRoom.settings.wickets.toString();
    wicketsSelect.disabled = !isAdmin;

    // Show/hide controls based on mode and admin status
    const adminControls1v1 = document.getElementById('room-admin-controls');
    const adminControlsTournament = document.getElementById('tournament-admin-controls');
    const waitingMsg = document.getElementById('room-waiting-msg');

    adminControls1v1.classList.add('hidden');
    adminControlsTournament.classList.add('hidden');
    waitingMsg.classList.add('hidden');

    if (isAdmin) {
        if (roomMode === '1v1') {
            adminControls1v1.classList.remove('hidden');
        } else {
            adminControlsTournament.classList.remove('hidden');
            const btn = document.getElementById('start-tournament-btn');
            const hint = document.getElementById('tournament-hint');
            if (currentRoom.playerCount >= 4) {
                btn.disabled = false;
                hint.textContent = `${currentRoom.playerCount} players ready! Start the tournament.`;
            } else {
                btn.disabled = true;
                hint.textContent = `Need at least 4 players (${currentRoom.playerCount}/4)`;
            }
        }
    } else {
        waitingMsg.classList.remove('hidden');
    }
}

function updateRoomSettings() {
    if (!currentRoom || currentRoom.admin.id !== currentUser.id) return;
    const wickets = document.getElementById('setting-wickets').value;
    socket.emit('update-room-settings', { wickets });
}

function selectOpponent(player) {
    selectedOpponentId = player.id;
    updateRoomUI();
    const panel = document.getElementById('selected-opponent-panel');
    document.getElementById('selected-opponent-info').textContent = player.displayName;
    panel.classList.remove('hidden');
}

function deselectOpponent() {
    selectedOpponentId = null;
    updateRoomUI();
    document.getElementById('selected-opponent-panel').classList.add('hidden');
}

function startRoomMatch() {
    if (!selectedOpponentId) return;

    socket.emit('start-room-match', { opponentId: selectedOpponentId }, (response) => {
        if (response.error) {
            showToast(response.error, 'error');
            return;
        }
    });
}

function addCpu() {
    socket.emit('add-cpu', (response) => {
        if (response.error) {
            showToast(response.error, 'error');
        } else {
            showToast('CPU player added! 🤖', 'success');
        }
    });
}

function removeCpu(cpuId) {
    socket.emit('remove-cpu', cpuId, (response) => {
        if (response.error) {
            showToast(response.error, 'error');
        } else {
            showToast('CPU player removed', 'info');
        }
    });
}

function kickPlayer(playerId) {
    if (!confirm('Are you sure you want to kick this player?')) return;
    socket.emit('kick-player', playerId, (response) => {
        if (response.error) {
            showToast(response.error, 'error');
        }
    });
}

function startTournament() {
    socket.emit('start-tournament', (response) => {
        if (response.error) {
            showToast(response.error, 'error');
        }
    });
}

function leaveRoom() {
    socket.emit('leave-room', () => {
        currentRoom = null;
        selectedOpponentId = null;
        showScreen('dashboard');
    });
}

function copyRoomCode() {
    if (!currentRoom) return;
    navigator.clipboard.writeText(currentRoom.code).then(() => {
        showToast('Room code copied! 📋', 'success');
    }).catch(() => {
        showToast('Code: ' + currentRoom.code, 'info');
    });
}

// ═══════════════════════════════════════════════════════
// GAME — UI INITIALIZATION
// ═══════════════════════════════════════════════════════
function initGameUI(match) {
    currentMatch = match;
    myRole = null;
    isSpectator = (match.player1.id !== currentUser.id && match.player2.id !== currentUser.id);

    if (isSpectator) {
        showToast('You are spectating this match 👀', 'info');
    }

    // Player headers
    const p1 = match.player1;
    const p2 = match.player2;

    document.getElementById('game-p1-avatar').style.background = p1.avatarColor;
    document.getElementById('game-p1-avatar').textContent = p1.displayName.charAt(0);
    document.getElementById('game-p1-name').textContent = p1.displayName;

    document.getElementById('game-p2-avatar').style.background = p2.avatarColor;
    document.getElementById('game-p2-avatar').textContent = p2.displayName.charAt(0);
    document.getElementById('game-p2-name').textContent = p2.displayName;

    // Hide all phases
    hideAllPhases();

    // Show toss phase
    showTossPhase();
}

function hideAllPhases() {
    document.querySelectorAll('.game-phase').forEach(p => p.classList.add('hidden'));
}

// ═══════════════════════════════════════════════════════
// GAME — TOSS
// ═══════════════════════════════════════════════════════
function handlePlayPhase(data) {
    hideAllPhases();
    const phase = document.getElementById('playing-phase'); // Corrected to 'playing-phase'
    phase.classList.remove('hidden');
    
    if (isSpectator) {
        disableNumberPicker();
        document.getElementById('pick-waiting-indicator').classList.remove('hidden');
        document.getElementById('pick-waiting-indicator').innerHTML = '<div class="spinner"></div> Spectating match...';
    } else {
        enableNumberPicker(); // Changed from resetNumberPicker() to enableNumberPicker()
        startTimer();
    }
}

function showTossPhase() {
    hideAllPhases();
    const phase = document.getElementById('toss-phase');
    phase.classList.remove('hidden');

    // Reset toss UI
    if (isSpectator) {
        document.getElementById('toss-instruction').textContent = "Spectating toss...";
        document.getElementById('toss-choice-btns').classList.add('hidden');
        document.getElementById('toss-number-btns').classList.add('hidden');
        document.getElementById('toss-waiting').classList.add('hidden');
    } else {
        document.getElementById('toss-instruction').textContent = "Call the Toss:";
        document.getElementById('toss-choice-btns').classList.remove('hidden');
        document.getElementById('toss-number-btns').classList.add('hidden');
        document.getElementById('toss-waiting').classList.add('hidden');
    }
    document.getElementById('toss-result-display').classList.add('hidden');
    document.getElementById('toss-instruction').textContent = 'Choose Odd or Even';
}

function pickTossChoice(choice) {
    socket.emit('toss-choice', choice, (response) => {
        if (response.error) {
            showToast(response.error, 'error');
        }
    });
}

function handleTossChoices(data) {
    if (isSpectator) {
        document.getElementById('toss-instruction').textContent = "Spectating number pick...";
        return;
    }

    const myChoice = currentUser.id === currentMatch.player1.id
        ? data.player1Choice : data.player2Choice;

    document.getElementById('toss-instruction').textContent = `You chose ${myChoice.toUpperCase()}. Now pick a number!`;
    document.getElementById('toss-choice-btns').classList.add('hidden');
    document.getElementById('toss-number-btns').classList.remove('hidden');
}

function pickTossNumber(number) {
    document.getElementById('toss-number-btns').classList.add('hidden');
    document.getElementById('toss-waiting').classList.remove('hidden');

    socket.emit('toss-number', number, (response) => {
        if (response.error) {
            showToast(response.error, 'error');
            document.getElementById('toss-number-btns').classList.remove('hidden');
            document.getElementById('toss-waiting').classList.add('hidden');
        }
    });
}

function handleTossResult(data) {
    document.getElementById('toss-waiting').classList.add('hidden');
    document.getElementById('toss-number-btns').classList.add('hidden');
    document.getElementById('toss-choice-btns').classList.add('hidden');

    const resultDisplay = document.getElementById('toss-result-display');
    const isWinner = isSpectator ? false : data.tossWinnerId === currentUser.id;
    const winnerName = data.tossWinner === 'player1'
        ? currentMatch.player1.displayName
        : currentMatch.player2.displayName;

    resultDisplay.innerHTML = `
    <div class="toss-numbers">
      <div class="hand-display">
        <div class="toss-num-display">${data.player1Number}</div>
        <span class="hand-label">${currentMatch.player1.displayName}</span>
      </div>
      <span class="toss-plus">+</span>
      <div class="hand-display">
        <div class="toss-num-display">${data.player2Number}</div>
        <span class="hand-label">${currentMatch.player2.displayName}</span>
      </div>
    </div>
    <div class="toss-sum">Sum: ${data.sum} (${data.isOdd ? 'Odd' : 'Even'})</div>
    <div class="toss-winner-text">${winnerName} wins the toss! 🎉</div>
  `;
    resultDisplay.classList.remove('hidden');

    // After a short delay, show bat/bowl choice
    setTimeout(() => {
        if (isWinner) {
            showChoicePhase();
        } else {
            // If CPU won the toss, tell server to make CPU choose
            if (isCpuMatch && data.tossWinnerId === CPU_ID) {
                socket.emit('cpu-toss-won', (response) => {
                    if (response.error) showToast(response.error, 'error');
                });
            } else {
                showChoiceWaitingPhase();
            }
        }
    }, 2500);
}

// ═══════════════════════════════════════════════════════
// GAME — BAT/BOWL CHOICE
// ═══════════════════════════════════════════════════════
function showChoicePhase() {
    hideAllPhases();
    document.getElementById('choice-phase').classList.remove('hidden');
}

function showChoiceWaitingPhase() {
    hideAllPhases();
    document.getElementById('choice-waiting-phase').classList.remove('hidden');
}

function pickBatBowl(choice) {
    socket.emit('bat-bowl-choice', choice, (response) => {
        if (response.error) {
            showToast(response.error, 'error');
        }
    });
}

// ═══════════════════════════════════════════════════════
// GAME — INNINGS
// ═══════════════════════════════════════════════════════
function handleInningsStart(data) {
    hideAllPhases();

    myRole = data.batsmanId === currentUser.id ? 'batsman' : 'bowler';

    // Update scoreboard
    document.getElementById('batting-name').textContent = data.batsmanName;
    document.getElementById('current-score').textContent = '0';
    document.getElementById('current-wickets').textContent = '0';
    document.getElementById('current-overs').textContent = '(0.0 ov)';

    const inningsLabel = document.getElementById('innings-label');
    inningsLabel.textContent = data.innings === 1 ? '1st Innings' : '2nd Innings';

    const targetDisplay = document.getElementById('target-display');
    const remainingDisplay = document.getElementById('remaining-display');

    if (data.target) {
        targetDisplay.classList.remove('hidden');
        document.getElementById('target-value').textContent = data.target;
        remainingDisplay.classList.remove('hidden');
        document.getElementById('runs-needed').textContent = data.target;
        document.getElementById('balls-remaining').textContent = '12';
    } else {
        targetDisplay.classList.add('hidden');
        remainingDisplay.classList.add('hidden');
    }

    // Update role badge
    const roleBadge = document.getElementById('your-role');
    if (isSpectator) {
        roleBadge.textContent = 'SPECTATING 👁️';
        roleBadge.className = 'role-badge spectator';
    } else if (myRole === 'batsman') {
        roleBadge.textContent = 'You are BATTING 🏏';
        roleBadge.className = 'role-badge batting';
    } else {
        roleBadge.textContent = 'You are BOWLING 🎯';
        roleBadge.className = 'role-badge bowling';
    }

    // Clear ball log
    document.getElementById('over-balls').innerHTML = '';

    // Show playing phase
    document.getElementById('playing-phase').classList.remove('hidden');

    // Handle number buttons for players vs spectators
    if (isSpectator) {
        disableNumberPicker();
        document.getElementById('pick-waiting-indicator').classList.remove('hidden');
        document.getElementById('pick-waiting-indicator').innerHTML = '<div class="spinner"></div> Spectating match...';
    } else {
        enableNumberPicker();
        startTimer();
    }
}

function enableNumberPicker() {
    const section = document.getElementById('number-picker-section');
    section.classList.remove('hidden');
    for (let i = 1; i <= 6; i++) {
        const btn = document.getElementById(`pick-${i}`);
        btn.disabled = false;
        btn.classList.remove('picked');
    }
    document.getElementById('pick-waiting-indicator').classList.add('hidden');
}

function disableNumberPicker() {
    for (let i = 1; i <= 6; i++) {
        document.getElementById(`pick-${i}`).disabled = true;
    }
}

// ─── Timer ───
function startTimer() {
    clearTimerInterval();
    timerStartTime = Date.now();
    const fill = document.getElementById('timer-fill');
    fill.style.width = '100%';
    fill.classList.remove('warning');

    timerInterval = setInterval(() => {
        const elapsed = Date.now() - timerStartTime;
        const pct = Math.max(0, 100 - (elapsed / TURN_TIME * 100));
        fill.style.width = pct + '%';

        if (pct < 30) {
            fill.classList.add('warning');
        }

        if (pct <= 0) {
            clearTimerInterval();
        }
    }, 50);
}

function clearTimerInterval() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

// ═══════════════════════════════════════════════════════
// GAME — PICK NUMBER
// ═══════════════════════════════════════════════════════
function pickNumber(number) {
    disableNumberPicker();
    clearTimerInterval();

    const btn = document.getElementById(`pick-${number}`);
    btn.classList.add('picked');

    socket.emit('pick-number', number, (response) => {
        if (response.error) {
            showToast(response.error, 'error');
            enableNumberPicker();
            startTimer();
        }
    });
}

function showPickWaiting() {
    disableNumberPicker();
    document.getElementById('pick-waiting-indicator').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════
// GAME — BALL RESULT
// ═══════════════════════════════════════════════════════
function handleBallResult(data) {
    const ball = data.ballResult;
    clearTimerInterval();

    // Show result popup
    showBallResultPopup(ball);

    // Update scoreboard after popup
    setTimeout(() => {
        if (data.currentScore !== undefined) {
            document.getElementById('current-score').textContent = data.currentScore;
        }
        if (data.currentOver) {
            document.getElementById('current-overs').textContent = `(${data.currentOver} ov)`;
        }
        if (ball.isWicket) {
            const w = document.getElementById('current-wickets');
            w.textContent = parseInt(w.textContent) + 1;
        }

        // Update chase info
        if (data.target && data.remainingBalls !== undefined) {
            const runsNeeded = data.target + 1 - data.currentScore;
            document.getElementById('runs-needed').textContent = Math.max(0, runsNeeded);
            document.getElementById('balls-remaining').textContent = data.remainingBalls;
        }

        // Update ball log
        addBallToLog(ball);

        // If innings/match not complete, re-enable picker
        if (!data.inningsComplete && !data.matchComplete && !isSpectator) {
            enableNumberPicker();
            startTimer();
        }
    }, 1500);
}

function showBallResultPopup(ball) {
    const popup = document.getElementById('ball-result-popup');
    const content = document.getElementById('result-content');

    let outcomeClass = ball.isWicket ? 'wicket-out' : 'runs';
    let outcomeText = ball.isWicket ? 'OUT! 🔴' : `+${ball.runs} Run${ball.runs !== 1 ? 's' : ''}`;

    if (!ball.isWicket && ball.runs === 6) {
        outcomeClass = 'six-runs';
        outcomeText = 'SIX! 🔥';
    } else if (!ball.isWicket && ball.runs === 4) {
        outcomeText = 'FOUR! 💥';
    }

    let batsmanLabel = myRole === 'batsman' ? 'You' : (isCpuMatch ? 'CPU' : 'Opponent');
    let bowlerLabel = myRole === 'bowler' ? 'You' : (isCpuMatch ? 'CPU' : 'Opponent');

    if (isSpectator) {
        batsmanLabel = currentMatch.player1.id === currentMatch.innings[currentMatch.currentInnings].batsmanId 
            ? currentMatch.player1.displayName : currentMatch.player2.displayName;
        bowlerLabel = currentMatch.player1.id === currentMatch.innings[currentMatch.currentInnings].bowlerId 
            ? currentMatch.player1.displayName : currentMatch.player2.displayName;
    }

    content.innerHTML = `
    <div class="result-hands">
      <div class="hand-display">
        <div class="hand-number ${ball.isWicket ? 'wicket' : ''}">${ball.batsmanPick}</div>
        <span class="hand-label">🏏 ${batsmanLabel}</span>
      </div>
      <span class="result-vs">vs</span>
      <div class="hand-display">
        <div class="hand-number ${ball.isWicket ? 'wicket' : ''}">${ball.bowlerPick}</div>
        <span class="hand-label">🎯 ${bowlerLabel}</span>
      </div>
    </div>
    <div class="result-outcome ${outcomeClass}">${outcomeText}</div>
  `;

    popup.classList.remove('hidden');

    setTimeout(() => {
        popup.classList.add('hidden');
    }, 1400);
}

function addBallToLog(ball) {
    const container = document.getElementById('over-balls');

    // Add over separator if needed
    if (ball.ball === 0 && ball.over > 0) {
        const sep = document.createElement('div');
        sep.className = 'over-separator';
        container.appendChild(sep);
    }

    const indicator = document.createElement('div');
    if (ball.isWicket) {
        indicator.className = 'ball-indicator wicket';
        indicator.textContent = 'W';
    } else {
        indicator.className = `ball-indicator runs-${ball.runs}`;
        indicator.textContent = ball.runs;
    }

    container.appendChild(indicator);
}

// ═══════════════════════════════════════════════════════
// GAME — INNINGS BREAK
// ═══════════════════════════════════════════════════════
function handleInningsBreak(data) {
    hideAllPhases();
    clearTimerInterval();

    const phase = document.getElementById('innings-break-phase');
    const info = document.getElementById('innings-break-info');

    info.innerHTML = `
    <div class="innings-break-score">1st Innings: ${data.firstInningsScore}/${data.firstInningsBalls > 0 ? '1' : '0'}</div>
    <div class="innings-break-target">Target: ${data.target} runs</div>
    <div class="innings-break-detail">
      ${data.nextBatsmanName} will bat, ${data.nextBowlerName} will bowl
    </div>
  `;

    phase.classList.remove('hidden');
}

function readyForSecondInnings() {
    socket.emit('start-second-innings', (response) => {
        if (response.error) {
            showToast(response.error, 'error');
        }
    });
}

// ═══════════════════════════════════════════════════════
// GAME — MATCH END
// ═══════════════════════════════════════════════════════
function handleMatchEnd(result) {
    hideAllPhases();
    clearTimerInterval();

    const phase = document.getElementById('result-phase');
    const titleEl = document.getElementById('result-title');
    const marginEl = document.getElementById('result-margin');
    const scorecardEl = document.getElementById('final-scorecard');

    const iWon = result.winnerId === currentUser.id;
    const isTie = result.isTie;

    if (isTie) {
        titleEl.textContent = '🤝 Match Tied!';
        titleEl.className = 'result-title draw';
    } else if (iWon) {
        titleEl.textContent = '🏆 You Won!';
        titleEl.className = 'result-title victory';
        spawnConfetti();
    } else {
        titleEl.textContent = '😔 You Lost';
        titleEl.className = 'result-title defeat';
    }

    marginEl.textContent = result.margin;

    // Scorecard
    const inn1 = result.innings1;
    const inn2 = result.innings2;

    const p1Name = currentMatch.player1.displayName;
    const p2Name = currentMatch.player2.displayName;

    const inn1BatsmanName = inn1.batsmanId === currentMatch.player1.id ? p1Name : p2Name;
    const inn2BatsmanName = inn2.batsmanId === currentMatch.player1.id ? p1Name : p2Name;

    const inn1Winner = result.winnerId === inn1.batsmanId;
    const inn2Winner = result.winnerId === inn2.batsmanId;

    scorecardEl.innerHTML = `
    <div class="scorecard-row ${inn1Winner ? 'winner-row' : 'loser-row'}">
      <span class="scorecard-player">${inn1BatsmanName} ${inn1Winner ? '🏆' : ''}</span>
      <span class="scorecard-score">${inn1.score}/${inn1.wickets} (${formatBalls(inn1.balls)})</span>
    </div>
    <div class="scorecard-row ${inn2Winner ? 'winner-row' : 'loser-row'}">
      <span class="scorecard-player">${inn2BatsmanName} ${inn2Winner ? '🏆' : ''}</span>
      <span class="scorecard-score">${inn2.score}/${inn2.wickets} (${formatBalls(inn2.balls)})</span>
    </div>
  `;

    phase.classList.remove('hidden');
}

function handleMatchForfeit(data) {
    hideAllPhases();
    clearTimerInterval();

    const phase = document.getElementById('result-phase');
    const titleEl = document.getElementById('result-title');
    const marginEl = document.getElementById('result-margin');
    const scorecardEl = document.getElementById('final-scorecard');

    titleEl.textContent = '🏆 You Won!';
    titleEl.className = 'result-title victory';
    marginEl.textContent = data.reason + ' — Match forfeited';
    scorecardEl.innerHTML = '';

    phase.classList.remove('hidden');
    spawnConfetti();
}

function leaveMatch() {
    socket.emit('leave-match', () => {
        currentMatch = null;
        myRole = null;
        isCpuMatch = false;
        clearTimerInterval();

        if (currentRoom) {
            showScreen('room');
            updateRoomUI();
        } else {
            showScreen('dashboard');
        }
    });
}

// ═══════════════════════════════════════════════════════
// TOURNAMENT
// ═══════════════════════════════════════════════════════
function leaveTournamentView() {
    showScreen('room');
    updateRoomUI();
}

function renderBracket(tournament) {
    const container = document.getElementById('bracket-container');
    container.innerHTML = '';

    const rounds = {};
    tournament.matches.forEach(m => {
        if (!rounds[m.stage]) rounds[m.stage] = [];
        rounds[m.stage].push(m);
    });

    const stageOrder = ['quarterfinal', 'semifinal', 'final'];
    stageOrder.forEach(stage => {
        if (!rounds[stage]) return;

        const roundDiv = document.createElement('div');
        roundDiv.className = 'bracket-round';
        roundDiv.innerHTML = `<div class="bracket-round-label">${stageName(stage)}</div>`;

        rounds[stage].forEach(m => {
            const matchDiv = document.createElement('div');
            matchDiv.className = `bracket-match ${m.status === 'live' ? 'is-live' : (m.status === 'done' ? 'is-done' : (m.status === 'prediction' ? 'is-prediction' : ''))}`;

            const isAdmin = currentRoom && currentRoom.admin.id === currentUser.id;

            matchDiv.innerHTML = `
                <div class="bracket-players">
                    <div class="bracket-player ${m.winner && m.winner.id === m.player1.id ? 'is-winner' : ''}">
                        <div class="avatar-xs" style="background:${m.player1.avatarColor || '#64748b'}">${m.player1.displayName.charAt(0)}</div>
                        <span class="player-name">${m.player1.displayName}</span>
                    </div>
                    <div class="bracket-divider">vs</div>
                    <div class="bracket-player ${m.winner && m.winner.id === m.player2.id ? 'is-winner' : ''}">
                        <div class="avatar-xs" style="background:${m.player2.avatarColor || '#64748b'}">${m.player2.displayName.charAt(0)}</div>
                        <span class="player-name">${m.player2.displayName}</span>
                    </div>
                </div>
                <div class="bracket-status status-${m.status}">${m.status.toUpperCase()}</div>
                ${isAdmin && m.status === 'upcoming' ? '<button class="btn-micro" title="Open Predictions">🗳️</button>' : ''}
            `;

            if (isAdmin && m.status === 'upcoming') {
                matchDiv.querySelector('.btn-micro').addEventListener('click', (e) => {
                    e.stopPropagation();
                    openPredictions(m.id);
                });
            }

            matchDiv.addEventListener('click', () => {
                if (m.status === 'prediction') {
                    openPredictionPanel(m, m.id);
                }
            });

            roundDiv.appendChild(matchDiv);
        });

        container.appendChild(roundDiv);
    });
}

function openPredictions(bracketMatchId) {
    socket.emit('open-predictions', { bracketMatchId }, (res) => {
        if (res.error) showToast(res.error, 'error');
    });
}

async function openPredictionPanel(match, bracketMatchId) {
    activeBracketMatchId = bracketMatchId;
    const panel = document.getElementById('prediction-panel');
    panel.classList.remove('hidden');

    const p1 = match.player1;
    const p2 = match.player2;

    // Fill UI
    document.getElementById('pred-player1').innerHTML = `
        <div class="pred-player-avatar" style="background:${p1.avatarColor || '#64748b'}">${p1.displayName.charAt(0)}</div>
        <span class="pred-player-name">${p1.displayName}</span>
    `;
    document.getElementById('pred-player2').innerHTML = `
        <div class="pred-player-avatar" style="background:${p2.avatarColor || '#64748b'}">${p2.displayName.charAt(0)}</div>
        <span class="pred-player-name">${p2.displayName}</span>
    `;

    // Admin controls
    const isAdmin = currentRoom && currentRoom.admin.id === currentUser.id;
    document.getElementById('launch-match-wrap').classList.toggle('hidden', !isAdmin);

    // Initial predictions
    updateVoteTally(currentTournament, bracketMatchId);

    // Vote buttons
    const voteBtnContainer = document.getElementById('vote-btns');
    voteBtnContainer.innerHTML = '';
    [p1, p2].forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'vote-btn';
        if (currentTournament.matches.find(m => m.id === bracketMatchId)?.predictions[currentUser.id] === p.id) {
            btn.classList.add('voted');
        }
        btn.innerHTML = `Win: ${p.displayName}`;
        btn.onclick = () => submitPrediction(bracketMatchId, p.id);
        voteBtnContainer.appendChild(btn);
    });

    // Fetch H2H
    updateHeadToHeadStats(p1.id, p2.id);
}

async function updateHeadToHeadStats(p1Id, p2Id) {
    try {
        const res = await fetch(`/api/h2h/${p1Id}/${p2Id}`);
        const stats = await res.json();

        const wrap = document.getElementById('h2h-wrap');
        const summary = document.getElementById('h2h-summary');

        if (stats.totalMatches === 0) {
            wrap.classList.add('hidden');
            summary.textContent = "First time these two meet!";
        } else {
            wrap.classList.remove('hidden');
            const p1Rate = (stats.p1Wins / stats.totalMatches) * 100;
            document.getElementById('h2h-fill').style.width = `${p1Rate}%`;
            document.getElementById('h2h-p1-label').textContent = `${stats.p1Wins}W`;
            document.getElementById('h2h-p2-label').textContent = `${stats.p2Wins}W`;
            summary.textContent = `${stats.totalMatches} matches played. ${stats.p1TotalRuns} runs vs ${stats.p2TotalRuns} runs.`;
        }
    } catch (e) {
        console.error("H2H error:", e);
    }
}

function submitPrediction(bracketMatchId, predictedPlayerId) {
    socket.emit('submit-prediction', { bracketMatchId, predictedPlayerId }, (res) => {
        if (res.error) showToast(res.error, 'error');
    });
}

function updateVoteTally(tournament, bracketMatchId) {
    const m = tournament.matches.find(m => m.id === bracketMatchId);
    if (!m) return;

    const tally = m.predictions || {};
    const total = Object.keys(tally).length;
    if (total === 0) {
        document.getElementById('vote-tally').textContent = 'No votes yet';
        return;
    }

    const p1Votes = Object.values(tally).filter(pid => pid === m.player1.id).length;
    const p1Percent = Math.round((p1Votes / total) * 100);
    document.getElementById('vote-tally').textContent = `${p1Percent}% favor ${m.player1.displayName} to win.`;
}

function launchTournamentMatch() {
    if (!activeBracketMatchId) return;
    socket.emit('launch-tournament-match', { bracketMatchId: activeBracketMatchId }, (res) => {
        if (res.error) showToast(res.error, 'error');
    });
}

function stageName(stage) {
    switch (stage) {
        case 'quarterfinal': return 'Quarter Finals';
        case 'semifinal': return 'Semi Finals';
        case 'final': return 'Final';
        default: return stage.toUpperCase();
    }
}

function showChampionBanner(champion) {
    const banner = document.getElementById('champion-banner');
    document.getElementById('champion-avatar').style.background = champion.avatarColor || '#fbbf24';
    document.getElementById('champion-avatar').textContent = champion.displayName.charAt(0);
    document.getElementById('champion-name').textContent = champion.displayName;

    banner.classList.remove('hidden');
    spawnConfetti();
}
function formatBalls(balls) {
    const overs = Math.floor(balls / 6);
    const remaining = balls % 6;
    return `${overs}.${remaining} ov`;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        if (toast.parentNode) toast.remove();
    }, 3000);
}

function spawnConfetti() {
    const container = document.getElementById('result-celebration');
    container.innerHTML = '';
    const colors = ['#fbbf24', '#00d4ff', '#a855f7', '#4ade80', '#ec4899', '#f97316'];

    for (let i = 0; i < 60; i++) {
        const piece = document.createElement('div');
        piece.className = 'confetti-piece';
        piece.style.left = Math.random() * 100 + '%';
        piece.style.background = colors[Math.floor(Math.random() * colors.length)];
        piece.style.animationDelay = Math.random() * 2 + 's';
        piece.style.animationDuration = (2 + Math.random() * 2) + 's';
        container.appendChild(piece);
    }
}
