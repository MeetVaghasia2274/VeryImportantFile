const { v4: uuidv4 } = require('uuid');

class RoomManager {
    constructor() {
        this.rooms = new Map();         // roomCode -> room object
        this.quickQueue = [];           // Players waiting for quick match
        this.playerRooms = new Map();   // playerId -> roomCode
    }

    generateCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code;
        do {
            code = '';
            for (let i = 0; i < 6; i++) {
                code += chars[Math.floor(Math.random() * chars.length)];
            }
        } while (this.rooms.has(code));
        return code;
    }

    createRoom(player) {
        // Remove from any existing room first
        this.leaveRoom(player.id);

        const code = this.generateCode();
        const room = {
            code,
            admin: player,
            players: [player],
            maxPlayers: 8,
            settings: {
                wickets: 1
            },
            status: 'waiting',       // waiting, playing
            currentMatch: null,
            matchQueue: [],           // For room-based 1v1 matches
            createdAt: Date.now()
        };

        this.rooms.set(code, room);
        this.playerRooms.set(player.id, code);

        return room;
    }

    joinRoom(code, player) {
        const room = this.rooms.get(code.toUpperCase());
        if (!room) return { error: 'Room not found. Check the code and try again.' };
        if (room.status !== 'waiting') return { error: 'Room is currently in a game.' };
        if (room.players.length >= room.maxPlayers) return { error: 'Room is full (max 8 players).' };
        if (room.players.find(p => p.id === player.id)) return { error: 'You are already in this room.' };

        // Remove from any existing room
        this.leaveRoom(player.id);

        room.players.push(player);
        this.playerRooms.set(player.id, code);

        return { success: true, room };
    }

    leaveRoom(playerId) {
        const code = this.playerRooms.get(playerId);
        if (!code) return null;

        const room = this.rooms.get(code);
        if (!room) {
            this.playerRooms.delete(playerId);
            return null;
        }

        room.players = room.players.filter(p => p.id !== playerId);
        this.playerRooms.delete(playerId);

        // If room is empty, delete it
        if (room.players.length === 0) {
            this.rooms.delete(code);
            return { roomDeleted: true, code };
        }

        // If admin left, transfer admin to next player
        if (room.admin.id === playerId) {
            room.admin = room.players[0];
            return { adminChanged: true, newAdmin: room.admin, code, room };
        }

        return { code, room };
    }

    getRoom(code) {
        return this.rooms.get(code?.toUpperCase());
    }

    getRoomByPlayerId(playerId) {
        const code = this.playerRooms.get(playerId);
        if (!code) return null;
        return this.rooms.get(code);
    }

    kickPlayer(adminId, targetPlayerId) {
        const code = this.playerRooms.get(adminId);
        if (!code) return { error: 'You are not in a room' };

        const room = this.rooms.get(code);
        if (!room) return { error: 'Room not found' };
        if (room.admin.id !== adminId) return { error: 'Only admin can kick players' };
        if (adminId === targetPlayerId) return { error: 'You cannot kick yourself' };

        const target = room.players.find(p => p.id === targetPlayerId);
        if (!target) return { error: 'Player not in room' };

        room.players = room.players.filter(p => p.id !== targetPlayerId);
        this.playerRooms.delete(targetPlayerId);

        return { success: true, kicked: target, code, room };
    }

    addCpuPlayer(adminId) {
        const code = this.playerRooms.get(adminId);
        if (!code) return { error: 'You are not in a room' };

        const room = this.rooms.get(code);
        if (!room) return { error: 'Room not found' };
        if (room.admin.id !== adminId) return { error: 'Only admin can add CPU' };
        if (room.players.length >= room.maxPlayers) return { error: 'Room is full' };

        const cpuCount = room.players.filter(p => p.id < 0).length;
        const cpuId = -(cpuCount + 1); // -1, -2, etc.

        const cpuPlayer = {
            id: cpuId,
            displayName: `CPU ${cpuCount + 1} 🤖`,
            avatarColor: '#64748b',
            isCpu: true,
            socketId: null
        };

        room.players.push(cpuPlayer);
        // We don't need playerRooms entry for CPU as they don't have sockets

        return { success: true, cpu: cpuPlayer, code, room };
    }

    updateSettings(adminId, newSettings) {
        const code = this.playerRooms.get(adminId);
        if (!code) return { error: 'Not in a room' };

        const room = this.rooms.get(code);
        if (!room) return { error: 'Room not found' };
        if (room.admin.id !== adminId) return { error: 'Only admin can change settings' };

        if (newSettings.wickets !== undefined) {
            room.settings.wickets = Math.max(1, Math.min(10, parseInt(newSettings.wickets) || 1));
        }

        return { success: true, room };
    }

    removeCpuPlayer(adminId, cpuId) {
        const code = this.playerRooms.get(adminId);
        if (!code) return { error: 'You are not in a room' };

        const room = this.rooms.get(code);
        if (!room) return { error: 'Room not found' };
        if (room.admin.id !== adminId) return { error: 'Only admin can remove CPU' };

        room.players = room.players.filter(p => p.id !== cpuId);
        return { success: true, code, room };
    }

    // Quick match queue
    joinQuickQueue(player) {
        // Remove if already in queue
        this.leaveQuickQueue(player.id);
        this.quickQueue.push(player);

        // Check if we can make a match
        if (this.quickQueue.length >= 2) {
            const p1 = this.quickQueue.shift();
            const p2 = this.quickQueue.shift();
            return { matched: true, player1: p1, player2: p2 };
        }

        return { matched: false, position: this.quickQueue.length };
    }

    leaveQuickQueue(playerId) {
        this.quickQueue = this.quickQueue.filter(p => p.id !== playerId);
    }

    getRoomSummary(room) {
        if (!room) return null;
        return {
            code: room.code,
            admin: {
                id: room.admin.id,
                displayName: room.admin.displayName
            },
            players: room.players.map(p => ({
                id: p.id,
                displayName: p.displayName,
                avatarColor: p.avatarColor,
                isCpu: !!p.isCpu,
                isAdmin: p.id === room.admin.id
            })),
            settings: room.settings,
            status: room.status,
            playerCount: room.players.length,
            maxPlayers: room.maxPlayers
        };
    }
}

module.exports = RoomManager;
