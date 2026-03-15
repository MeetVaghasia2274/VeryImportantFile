const { v4: uuidv4 } = require('uuid');

const OVERS_PER_INNINGS = 2;
const BALLS_PER_OVER = 6;
const TOTAL_BALLS = OVERS_PER_INNINGS * BALLS_PER_OVER;
const TURN_TIMEOUT_MS = 8000; // 8 seconds to pick a number

// Match states
const STATE = {
    TOSS_CHOICE: 'toss_choice',       // Both pick odd/even
    TOSS_NUMBER: 'toss_number',       // Both show a number
    BAT_BOWL_CHOICE: 'bat_bowl_choice', // Toss winner chooses
    PLAYING: 'playing',               // Ball-by-ball gameplay
    INNINGS_BREAK: 'innings_break',   // Between innings
    COMPLETED: 'completed'            // Match over
};

function createMatch(player1, player2, matchType = 'quick', roomCode = null, settings = { wickets: 1 }) {
    return {
        id: uuidv4(),
        matchType,
        roomCode,
        settings,
        player1: { ...player1, ready: false },
        player2: { ...player2, ready: false },
        state: STATE.TOSS_CHOICE,
        toss: {
            player1Choice: null, // 'odd' or 'even'
            player2Choice: null,
            player1Number: null,
            player2Number: null,
            winner: null,        // player1 or player2
            winnerBatFirst: null // true or false
        },
        innings: [
            createInnings(),
            createInnings()
        ],
        currentInnings: 0,
        currentBall: {
            batsmanPick: null,
            bowlerPick: null
        },
        batsman: null,  // Reference to player1 or player2
        bowler: null,
        winner: null,
        isTie: false,
        turnTimer: null,
        tournamentId: null,
        tournamentStage: null,
        createdAt: Date.now()
    };
}

function createInnings() {
    return {
        batsmanId: null,
        bowlerId: null,
        balls: [],          // Array of { batsmanPick, bowlerPick, runs, isWicket, over, ball }
        totalRuns: 0,
        wickets: 0,
        oversCompleted: 0,
        ballsInCurrentOver: 0,
        totalBallsFaced: 0,
        isComplete: false,
        target: null        // Set for 2nd innings
    };
}

function processTossChoice(match, playerId, choice) {
    if (match.state !== STATE.TOSS_CHOICE) return { error: 'Not in toss choice phase' };

    if (playerId === match.player1.id) {
        match.toss.player1Choice = choice;
        match.toss.player2Choice = choice === 'odd' ? 'even' : 'odd';
    } else if (playerId === match.player2.id) {
        match.toss.player2Choice = choice;
        match.toss.player1Choice = choice === 'odd' ? 'even' : 'odd';
    } else {
        return { error: 'Player not in this match' };
    }

    // First player to pick sets the choices, move to number picking
    match.state = STATE.TOSS_NUMBER;
    return {
        success: true,
        player1Choice: match.toss.player1Choice,
        player2Choice: match.toss.player2Choice,
        nextState: STATE.TOSS_NUMBER
    };
}

function processTossNumber(match, playerId, number) {
    if (match.state !== STATE.TOSS_NUMBER) return { error: 'Not in toss number phase' };
    if (number < 1 || number > 6) return { error: 'Number must be 1-6' };

    if (playerId === match.player1.id) {
        match.toss.player1Number = number;
    } else if (playerId === match.player2.id) {
        match.toss.player2Number = number;
    } else {
        return { error: 'Player not in this match' };
    }

    // Check if both have picked
    if (match.toss.player1Number !== null && match.toss.player2Number !== null) {
        const sum = match.toss.player1Number + match.toss.player2Number;
        const isOdd = sum % 2 !== 0;

        if (isOdd) {
            match.toss.winner = match.toss.player1Choice === 'odd' ? 'player1' : 'player2';
        } else {
            match.toss.winner = match.toss.player1Choice === 'even' ? 'player1' : 'player2';
        }

        match.state = STATE.BAT_BOWL_CHOICE;

        return {
            success: true,
            bothPicked: true,
            player1Number: match.toss.player1Number,
            player2Number: match.toss.player2Number,
            sum,
            isOdd,
            tossWinner: match.toss.winner,
            tossWinnerId: match.toss.winner === 'player1' ? match.player1.id : match.player2.id,
            nextState: STATE.BAT_BOWL_CHOICE
        };
    }

    return { success: true, bothPicked: false, waitingFor: 'other player' };
}

function processBatBowlChoice(match, playerId, choice) {
    if (match.state !== STATE.BAT_BOWL_CHOICE) return { error: 'Not in bat/bowl choice phase' };

    const tossWinnerId = match.toss.winner === 'player1' ? match.player1.id : match.player2.id;
    if (playerId !== tossWinnerId) return { error: 'Only toss winner can choose' };

    match.toss.winnerBatFirst = (choice === 'bat');

    // Set up first innings
    if (match.toss.winner === 'player1') {
        if (choice === 'bat') {
            match.batsman = match.player1;
            match.bowler = match.player2;
        } else {
            match.batsman = match.player2;
            match.bowler = match.player1;
        }
    } else {
        if (choice === 'bat') {
            match.batsman = match.player2;
            match.bowler = match.player1;
        } else {
            match.batsman = match.player1;
            match.bowler = match.player2;
        }
    }

    match.innings[0].batsmanId = match.batsman.id;
    match.innings[0].bowlerId = match.bowler.id;
    match.state = STATE.PLAYING;

    return {
        success: true,
        batsmanId: match.batsman.id,
        bowlerId: match.bowler.id,
        batsmanName: match.batsman.displayName,
        bowlerName: match.bowler.displayName,
        nextState: STATE.PLAYING
    };
}

function processPlayerPick(match, playerId, number) {
    if (match.state !== STATE.PLAYING) return { error: 'Not in playing phase' };
    if (number < 1 || number > 6) return { error: 'Number must be 1-6' };

    const innings = match.innings[match.currentInnings];

    if (playerId === match.batsman.id) {
        match.currentBall.batsmanPick = number;
    } else if (playerId === match.bowler.id) {
        match.currentBall.bowlerPick = number;
    } else {
        return { error: 'Player not in this match' };
    }

    // Check if both have picked
    if (match.currentBall.batsmanPick !== null && match.currentBall.bowlerPick !== null) {
        return resolveBall(match);
    }

    return { success: true, bothPicked: false, waitingFor: 'other player' };
}

function resolveBall(match) {
    const innings = match.innings[match.currentInnings];
    const batsmanPick = match.currentBall.batsmanPick;
    const bowlerPick = match.currentBall.bowlerPick;
    const isWicket = batsmanPick === bowlerPick;
    const runs = isWicket ? 0 : batsmanPick;

    // Calculate over and ball
    const ballNumber = innings.totalBallsFaced;
    const over = Math.floor(ballNumber / BALLS_PER_OVER);
    const ballInOver = ballNumber % BALLS_PER_OVER;

    const ballResult = {
        batsmanPick,
        bowlerPick,
        runs,
        isWicket,
        over,
        ball: ballInOver,
        ballLabel: `${over}.${ballInOver + 1}`
    };

    innings.balls.push(ballResult);
    innings.totalBallsFaced++;

    if (isWicket) {
        innings.wickets++;
    } else {
        innings.totalRuns += runs;
    }

    // Update over tracking
    innings.ballsInCurrentOver++;
    if (innings.ballsInCurrentOver >= BALLS_PER_OVER) {
        innings.oversCompleted++;
        innings.ballsInCurrentOver = 0;
    }

    // Reset current ball
    match.currentBall = { batsmanPick: null, bowlerPick: null };

    // Check if innings is complete
    let inningsComplete = false;
    let chaseResult = null;

    if (innings.wickets >= (match.settings.wickets || 1)) {
        inningsComplete = true;
    } else if (innings.totalBallsFaced >= TOTAL_BALLS) {
        inningsComplete = true;
    }

    // In 2nd innings, check if target chased
    if (match.currentInnings === 1 && !isWicket) {
        if (innings.totalRuns > innings.target) {
            inningsComplete = true;
            chaseResult = 'chased';
        }
    }

    if (inningsComplete) {
        innings.isComplete = true;

        if (match.currentInnings === 0) {
            // Move to 2nd innings
            match.currentInnings = 1;
            match.innings[1].target = innings.totalRuns;

            // Swap batsman and bowler
            const tempBatsman = match.batsman;
            match.batsman = match.bowler;
            match.bowler = tempBatsman;
            match.innings[1].batsmanId = match.batsman.id;
            match.innings[1].bowlerId = match.bowler.id;

            match.state = STATE.INNINGS_BREAK;

            return {
                success: true,
                bothPicked: true,
                ballResult,
                inningsComplete: true,
                matchComplete: false,
                inningsBreak: true,
                firstInningsScore: innings.totalRuns,
                firstInningsBalls: innings.totalBallsFaced,
                target: innings.totalRuns + 1,
                nextBatsmanId: match.batsman.id,
                nextBowlerId: match.bowler.id,
                nextBatsmanName: match.batsman.displayName,
                nextBowlerName: match.bowler.displayName
            };
        } else {
            // Match complete
            const result = calculateResult(match);
            match.state = STATE.COMPLETED;

            return {
                success: true,
                bothPicked: true,
                ballResult,
                inningsComplete: true,
                matchComplete: true,
                result
            };
        }
    }

    return {
        success: true,
        bothPicked: true,
        ballResult,
        inningsComplete: false,
        matchComplete: false,
        currentScore: innings.totalRuns,
        currentBalls: innings.totalBallsFaced,
        currentOver: `${innings.oversCompleted}.${innings.ballsInCurrentOver}`,
        target: innings.target,
        remainingBalls: TOTAL_BALLS - innings.totalBallsFaced
    };
}

function calculateResult(match) {
    const inn1 = match.innings[0];
    const inn2 = match.innings[1];

    let winner = null;
    let margin = '';
    let isTie = false;

    if (inn2.totalRuns > inn1.totalRuns) {
        // Chaser wins
        winner = match.innings[1].batsmanId;
        const maxWickets = match.settings.wickets || 1;
        const wicketsRemaining = maxWickets - inn2.wickets;
        margin = `by ${wicketsRemaining} wicket${wicketsRemaining !== 1 ? 's' : ''}`;
    } else if (inn1.totalRuns > inn2.totalRuns) {
        // First batsman wins
        winner = match.innings[0].batsmanId;
        const runMargin = inn1.totalRuns - inn2.totalRuns;
        margin = `by ${runMargin} run${runMargin > 1 ? 's' : ''}`;
    } else {
        isTie = true;
        margin = 'Match Tied!';
    }

    match.winner = winner;
    match.isTie = isTie;

    const winnerPlayer = winner ?
        (winner === match.player1.id ? match.player1 : match.player2) : null;

    return {
        winnerId: winner,
        winnerName: winnerPlayer ? winnerPlayer.displayName : null,
        isTie,
        margin,
        innings1: {
            batsmanId: inn1.batsmanId,
            score: inn1.totalRuns,
            balls: inn1.totalBallsFaced,
            wickets: inn1.wickets
        },
        innings2: {
            batsmanId: inn2.batsmanId,
            score: inn2.totalRuns,
            balls: inn2.totalBallsFaced,
            wickets: inn2.wickets
        }
    };
}

function startSecondInnings(match) {
    if (match.state !== STATE.INNINGS_BREAK) return { error: 'Not in innings break' };
    match.state = STATE.PLAYING;
    return { success: true };
}

function getMatchSummary(match) {
    const inn1 = match.innings[0];
    const inn2 = match.innings[1];

    return {
        id: match.id,
        state: match.state,
        player1: { id: match.player1.id, displayName: match.player1.displayName, avatarColor: match.player1.avatarColor },
        player2: { id: match.player2.id, displayName: match.player2.displayName, avatarColor: match.player2.avatarColor },
        toss: {
            winner: match.toss.winner,
            winnerId: match.toss.winner ? (match.toss.winner === 'player1' ? match.player1.id : match.player2.id) : null
        },
        batsman: match.batsman ? { id: match.batsman.id, displayName: match.batsman.displayName } : null,
        bowler: match.bowler ? { id: match.bowler.id, displayName: match.bowler.displayName } : null,
        currentInnings: match.currentInnings,
        innings1: {
            batsmanId: inn1.batsmanId,
            score: inn1.totalRuns,
            balls: inn1.totalBallsFaced,
            wickets: inn1.wickets,
            overs: `${inn1.oversCompleted}.${inn1.ballsInCurrentOver}`,
            isComplete: inn1.isComplete,
            target: inn1.target,
            ballLog: inn1.balls
        },
        innings2: {
            batsmanId: inn2.batsmanId,
            score: inn2.totalRuns,
            balls: inn2.totalBallsFaced,
            wickets: inn2.wickets,
            overs: `${inn2.oversCompleted}.${inn2.ballsInCurrentOver}`,
            isComplete: inn2.isComplete,
            target: inn2.target,
            ballLog: inn2.balls
        },
        totalBalls: TOTAL_BALLS,
        oversPerInnings: OVERS_PER_INNINGS
    };
}

module.exports = {
    STATE,
    TOTAL_BALLS,
    OVERS_PER_INNINGS,
    TURN_TIMEOUT_MS,
    createMatch,
    processTossChoice,
    processTossNumber,
    processBatBowlChoice,
    processPlayerPick,
    startSecondInnings,
    getMatchSummary,
    calculateResult
};
