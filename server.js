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
    "Орбитальная станция", "Подводная лодка", "Киностудия", "Банк", 
    "Пиратский корабль", "Театр", "Полярная станция", "Павильон Марвел", 
    "Красная дорожка", "Гримерная", "Бухгалтерия", "Кабинет директора", 
    "Пляжный бар", "Яхта олигарха", "Аквапарк"
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
    room.votingHistory = [];
    room.votes = {};
    room.votedPlayers.clear();

    io.to(roomCode).emit('votingStarted', { players: room.players });
}

io.on('connection', (socket) => {
    console.log(`Пользователь подключился: ${socket.id}`);

    socket.on('createRoom', (data) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            id: roomCode,
            players: [{ id: socket.id, nickname: data.nickname, isHost: true }],
            status: 'lobby',
            location: "",
            history: [],
            round: 1,
            step: 1,
            activePlayerIdx: 0,
            votingHistory: [],
            votes: {}, 
            votedPlayers: new Set()
        };
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, playerId: socket.id });
        io.to(roomCode).emit('roomPlayersUpdate', { players: rooms[roomCode].players });
    });

    socket.on('joinRoom', (data) => {
        const code = data.roomCode.toUpperCase();
        if (!rooms[code]) {
            socket.emit('errorMsg', 'Комната не найдена!');
            return;
        }
        if (rooms[code].status !== 'lobby') {
            socket.emit('errorMsg', 'Игра в этой комнате уже началась!');
            return;
        }
        rooms[code].players.push({ id: socket.id, nickname: data.nickname, isHost: false });
        socket.join(code);
        socket.emit('roomJoined', { roomCode: code, playerId: socket.id });
        io.to(code).emit('roomPlayersUpdate', { players: rooms[code].players });
    });

    socket.on('startGame', (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.players.length < 3) {
            socket.emit('errorMsg', 'Для игры нужно минимум 3 игрока!');
            return;
        }

        room.status = 'ingame';
        room.location = onlineLocations[Math.floor(Math.random() * onlineLocations.length)];
        
        const spyIdx = Math.floor(Math.random() * room.players.length);
        const roles = room.players.map((p, idx) => ({
            id: p.id,
            nickname: p.nickname,
            isSpy: idx === spyIdx
        }));

        room.roles = roles;
        room.history = [];
        room.round = 1;
        room.step = 1;
        room.activePlayerIdx = Math.floor(Math.random() * room.players.length);

        io.to(data.roomCode).emit('gameStarted', { roles, location: room.location });
        sendChatUpdate(data.roomCode);
    });

    socket.on('chatWord', (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.status !== 'ingame') return;

        const activePlayer = room.players[room.activePlayerIdx];
        if (socket.id !== activePlayer.id) return; 

        room.history.push({ nickname: activePlayer.nickname, word: data.text });
        
        room.activePlayerIdx = (room.activePlayerIdx + 1) % room.players.length;
        room.step++;

        if (room.step > room.players.length) {
            sendChatUpdate(data.roomCode); 
            setTimeout(() => {
                activateVoting(data.roomCode); 
            }, 1500);
        } else {
            sendChatUpdate(data.roomCode);
        }
    });

    socket.on('startVoting', (data) => {
        activateVoting(data.roomCode);
    });

    socket.on('votingChatMsg', (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.status !== 'voting') return;

        const sender = room.players.find(p => p.id === socket.id);
        if (!sender) return;

        room.votingHistory.push({ nickname: sender.nickname, msg: data.msg });
        io.to(data.roomCode).emit('votingChatUpdate', room.votingHistory);
    });

    socket.on('submitVote', (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.status !== 'voting') return;
        if (room.votedPlayers.has(socket.id)) return; 

        room.votedPlayers.add(socket.id);
        const target = data.suspectId; 
        room.votes[target] = (room.votes[target] || 0) + 1;

        if (room.votedPlayers.size === room.players.length) {
            processVotes(data.roomCode);
        }
    });

    socket.on('disconnect', () => {
        for (let code in rooms) {
            rooms[code].players = rooms[code].players.filter(p => p.id !== socket.id);
            if (rooms[code].players.length === 0) {
                delete rooms[code];
            } else {
                io.to(code).emit('roomPlayersUpdate', { players: rooms[code].players });
            }
        }
    });
});

function sendChatUpdate(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    const activePlayer = room.players[room.activePlayerIdx];
    io.to(roomCode).emit('chatUpdate', {
        round: room.round,
        step: room.step,
        history: room.history,
        activePlayerId: activePlayer ? activePlayer.id : null,
        activePlayerName: activePlayer ? activePlayer.nickname : ""
    });
}

function processVotes(roomCode) {
    const room = rooms[roomCode];
    let maxVotes = 0;
    let kickedId = null;
    let isTie = false;

    for (let target in room.votes) {
        if (room.votes[target] > maxVotes) {
            maxVotes = room.votes[target];
            kickedId = target;
            isTie = false;
        } else if (room.votes[target] === maxVotes) {
            isTie = true;
        }
    }

    // ЛОГИКА ПРОДОЛЖЕНИЯ ИГРЫ ПРИ СКИПЕ / НИЧЬЕЙ
    if (isTie || kickedId === 'skip') {
        room.round += 1;
        room.step = 1;
        room.status = 'ingame';
        room.history = []; // Очищаем историю старого раунда под новые слова
        room.activePlayerIdx = Math.floor(Math.random() * room.players.length);

        io.to(roomCode).emit('gameContinuedNextRound', { round: room.round });
        sendChatUpdate(roomCode);
        return;
    }

    const kickedPlayer = room.players.find(p => p.id === kickedId);
    const kickedRole = room.roles.find(r => r.id === kickedId);

    if (!kickedPlayer || !kickedRole) {
        room.round += 1;
        room.step = 1;
        room.status = 'ingame';
        room.history = [];
        io.to(roomCode).emit('gameContinuedNextRound', { round: room.round });
        sendChatUpdate(roomCode);
        return;
    }

    if (kickedRole.isSpy) {
        io.to(roomCode).emit('gameOver', { status: 'citizens_win', reason: 'spy_caught', kickedName: kickedPlayer.nickname });
        delete rooms[roomCode];
    } else {
        io.to(roomCode).emit('gameOver', { status: 'spy_win', reason: 'wrong_vote', kickedName: kickedPlayer.nickname });
        delete rooms[roomCode];
    }
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Сервер шпиона запущен на порту ${PORT}`);
});
