const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const onlineLocations = [
    "Ложка", "Ручка", "Книга", "Стол", "Стул", "Окно", "Дверь", "Лампа", "Кошка", "Собака",
    "Чайник", "Чашка", "Тарелка", "Нож", "Кровать", "Подушка", "Ковёр", "Телефон", "Ключ", "Часы",
    "Шапка", "Обувь", "Носок", "Куртка", "Сумка", "Зонт", "Газета", "Зеркало", "Расчёска", "Мыло",
    "Щётка", "Полотенце", "Ведро", "Утюг", "Мяч", "Кукла", "Машина", "Автобус", "Поезд", "Самолёт"
];

let rooms = {};

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function activateVoting(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.status = 'voting';
    room.votes = {};
    room.votedPlayers = [];

    io.to(roomCode).emit('votingStarted', {
        players: room.players.map(p => ({ id: p.id, nickname: p.nickname }))
    });
}

function sendChatUpdate(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(roomCode).emit('chatUpdate', {
        round: room.round,
        step: room.step,
        history: room.history,
        players: room.players,
        activePlayerIdx: room.activePlayerIdx
    });
}

io.on('connection', (socket) => {
    console.log(`Пользователь подключен: ${socket.id}`);

    socket.on('createRoom', (data) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            status: 'lobby',
            players: [{ id: socket.id, nickname: data.nickname, isHost: true }],
            roles: [],
            location: "",
            history: [],
            round: 1,
            step: 1,
            activePlayerIdx: 0,
            votes: {},
            votedPlayers: []
        };
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode: roomCode, playerId: socket.id });
        io.to(roomCode).emit('roomPlayersUpdate', { players: rooms[roomCode].players });
    });

    socket.on('joinRoom', (data) => {
        const { roomCode, nickname } = data;
        const room = rooms[roomCode];
        
        if (!room) return socket.emit('errorMsg', 'Комната не найдена!');
        if (room.status !== 'lobby') return socket.emit('errorMsg', 'Игра уже идет!');

        room.players.push({ id: socket.id, nickname: nickname, isHost: false });
        socket.join(roomCode);
        socket.emit('roomJoined', { roomCode: roomCode, playerId: socket.id });
        io.to(roomCode).emit('roomPlayersUpdate', { players: room.players });
    });

    socket.on('startGame', (data) => {
        const { roomCode } = data;
        const room = rooms[roomCode];
        if (!room) return;

        if (room.players.length < 3) {
            return socket.emit('errorMsg', 'Для игры нужно минимум 3 игрока!');
        }

        room.status = 'ingame';
        room.round = 1;
        room.step = 1;
        room.history = [];
        room.votes = {};
        room.votedPlayers = []; 

        const randomLoc = onlineLocations[Math.floor(Math.random() * onlineLocations.length)];
        room.location = randomLoc;

        const spyIdx = Math.floor(Math.random() * room.players.length);
        room.roles = room.players.map((p, idx) => ({
            id: p.id,
            nickname: p.nickname,
            isSpy: idx === spyIdx
        }));

        room.activePlayerIdx = Math.floor(Math.random() * room.players.length);

        io.to(roomCode).emit('gameStarted', {
            roles: room.roles,
            location: room.location
        });

        sendChatUpdate(roomCode);
    });

    socket.on('chatWord', (data) => {
        const { roomCode, text } = data;
        const room = rooms[roomCode];
        if (!room || room.status !== 'ingame') return;

        const activePlayer = room.players[room.activePlayerIdx];
        if (activePlayer.id !== socket.id) return;

        room.history.push({ nickname: activePlayer.nickname, word: text });
        room.activePlayerIdx = (room.activePlayerIdx + 1) % room.players.length;

        if (room.history.length === room.players.length) {
            activateVoting(roomCode);
        } else {
            room.step += 1;
            sendChatUpdate(roomCode);
        }
    });

    socket.on('submitVote', (data) => {
        const { roomCode, targetId } = data;
        const room = rooms[roomCode];
        if (!room || room.status !== 'voting') return;

        if (room.votedPlayers.includes(socket.id)) return;

        room.votedPlayers.push(socket.id);
        room.votes[targetId] = (room.votes[targetId] || 0) + 1;

        if (room.votedPlayers.length === room.players.length) {
            let maxVotes = -1;
            let kickedId = null;
            let isTie = false;

            for (const target in room.votes) {
                if (room.votes[target] > maxVotes) {
                    maxVotes = room.votes[target];
                    kickedId = target;
                    isTie = false;
                } else if (room.votes[target] === maxVotes) {
                    isTie = true;
                }
            }

            if (isTie || kickedId === 'skip') {
                room.round += 1;
                room.step = 1;
                room.status = 'ingame';
                room.history = []; 
                room.activePlayerIdx = Math.floor(Math.random() * room.players.length);
                room.votedPlayers = []; 
                room.votes = {};

                io.to(roomCode).emit('gameContinuedNextRound', { round: room.round });
                sendChatUpdate(roomCode);
                return;
            }

            const kickedPlayer = room.players.find(p => p.id === kickedId);
            const kickedRole = room.roles ? room.roles.find(r => r.id === kickedId) : null;

            if (!kickedPlayer || !kickedRole) {
                room.round += 1;
                room.step = 1;
                room.status = 'ingame';
                room.history = [];
                room.votedPlayers = [];
                room.votes = {};
                io.to(roomCode).emit('gameContinuedNextRound', { round: room.round });
                sendChatUpdate(roomCode);
                return;
            }

            if (kickedRole.isSpy) {
                io.to(roomCode).emit('gameOver', { status: 'citizens_win', kickedName: kickedPlayer.nickname, word: room.location });
            } else {
                io.to(roomCode).emit('gameOver', { status: 'spy_win', kickedName: kickedPlayer.nickname, word: room.location });
            }
            room.status = 'lobby';
        }
    });

    socket.on('spyGuessLocation', (data) => {
        const { code, location } = data;
        const room = rooms[code];
        if (!room || room.status === 'lobby') return;

        const senderRole = room.roles.find(r => r.id === socket.id);
        if (!senderRole || !senderRole.isSpy) return;

        const isCorrect = room.location.trim().toLowerCase() === location.trim().toLowerCase();

        if (isCorrect) {
            io.to(code).emit('gameOver', { status: 'spy_win_guess', kickedName: senderRole.nickname, word: room.location });
        } else {
            io.to(code).emit('gameOver', { status: 'citizens_win_guess', kickedName: senderRole.nickname, word: room.location });
        }
        room.status = 'lobby';
    });

    socket.on('disconnect', () => {
        console.log(`Пользователь отключился: ${socket.id}`);
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                const wasHost = room.players[idx].isHost;
                room.players.splice(idx, 1);
                
                if (room.players.length === 0) {
                    delete rooms[roomCode];
                } else {
                    if (wasHost) {
                        room.players[0].isHost = true;
                    }
                    io.to(roomCode).emit('roomPlayersUpdate', { players: room.players });
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
