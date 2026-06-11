const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ТУТ МЫ РАЗРЕШАЕМ ЛЮБЫЕ ПОДКЛЮЧЕНИЯ ИЗ ИНТЕРНЕТА
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// Отдаем файлы игры из корня
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// База локаций для сетевой игры
const onlineLocations = [
    "Орбитальная станция", "Подводная лодка", "Киностудия", "Банк", 
    "Пиратский корабль", "Театр", "Полярная станция", "Павильон Марвел", 
    "Красная дорожка", "Гримерная", "Бухгалтерия", "Кабинет директора", 
    "Пляжный бар", "Яхта олигарха", "Аквапарк"
];

let rooms = {};

// Генерация случайного кода комнаты (5 букв)
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

io.on('connection', (socket) => {
    console.log(`Пользователь подключился: ${socket.id}`);

    // 1. Создание комнаты
    socket.on('createRoom', (data) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            id: roomCode,
            players: [{ id: socket.id, nickname: data.nickname, isHost: true }],
            status: 'lobby', // lobby, ingame, voting
            location: "",
            history: [],
            round: 1,
            step: 1,
            activePlayerIdx: 0,
            votingHistory: [],
            votes: {}, // targetPlayerId -> count или 'skip' -> count
            votedPlayers: new Set()
        };
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, playerId: socket.id });
        io.to(roomCode).emit('roomPlayersUpdate', { players: rooms[roomCode].players });
    });

    // 2. Вход в комнату
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

    // 3. Старт игры
    socket.on('startGame', (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.players.length < 3) {
            socket.emit('errorMsg', 'Для игры нужно минимум 3 игрока!');
            return;
        }

        room.status = 'ingame';
        room.location = onlineLocations[Math.floor(Math.random() * onlineLocations.length)];
        
        // Назначаем одного случайного шпиона
        const spyIdx = Math.floor(Math.random() * room.players.length);
        const roles = room.players.map((p, idx) => ({
            id: p.id,
            nickname: p.nickname,
            isSpy: idx === spyIdx
        }));

        room.roles = roles;
        room.history = [];
        room.step = 1;
        room.activePlayerIdx = Math.floor(Math.random() * room.players.length);

        io.to(data.roomCode).emit('gameStarted', { roles, location: room.location });
        
        // Отправляем первый пустой апдейт чата, чтобы передать ход первому игроку
        sendChatUpdate(data.roomCode);
    });

    // 4. Отправка слова по цепочке
    socket.on('chatWord', (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.status !== 'ingame') return;

        const activePlayer = room.players[room.activePlayerIdx];
        if (socket.id !== activePlayer.id) return; // Ход не этого игрока

        room.history.push({ nickname: activePlayer.nickname, word: data.word });
        
        // Передаем ход следующему по кругу
        room.activePlayerIdx = (room.activePlayerIdx + 1) % room.players.length;
        room.step++;

        sendChatUpdate(data.roomCode);
    });

    // 5. Переход к голосованию
    socket.on('startVoting', (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.status !== 'ingame') return;

        room.status = 'voting';
        room.votingHistory = [];
        room.votes = {};
        room.votedPlayers.clear();

        io.to(data.roomCode).emit('votingStarted', { players: room.players });
    });

    // Чат обсуждения на этапе голосования
    socket.on('votingChatMsg', (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.status !== 'voting') return;

        const sender = room.players.find(p => p.id === socket.id);
        if (!sender) return;

        room.votingHistory.push({ nickname: sender.nickname, msg: data.msg });
        io.to(data.roomCode).emit('votingChatUpdate', room.votingHistory);
    });

    // 6. Прием голосов
    socket.on('submitVote', (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.status !== 'voting') return;
        if (room.votedPlayers.has(socket.id)) return; // Уже голосовал

        room.votedPlayers.add(socket.id);
        const target = data.suspectId; // ID игрока или 'skip'
        room.votes[target] = (room.votes[target] || 0) + 1;

        // Если проголосовали все
        if (room.votedPlayers.size === room.players.length) {
            processVotes(data.roomCode);
        }
    });

    socket.on('disconnect', () => {
        console.log(`Пользователь отключился: ${socket.id}`);
        // Чистим пустые комнаты при выходе игроков
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
    const activePlayer = room.players[room.activePlayerIdx];
    io.to(roomCode).emit('chatUpdate', {
        round: room.round,
        step: room.step,
        history: room.history,
        activePlayerId: activePlayer.id,
        activePlayerName: activePlayer.nickname
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

    // Если ничья по голосам или победил вариант 'skip'
    if (isTie || kickedId === 'skip') {
        io.to(roomCode).emit('gameOver', { status: 'draw' });
        delete rooms[roomCode];
        return;
    }

    const kickedPlayer = room.players.find(p => p.id === kickedId);
    const kickedRole = room.roles.find(r => r.id === kickedId);

    if (kickedRole.isSpy) {
        // Мирные выиграли, так как поймали шпиона
        io.to(roomCode).emit('gameOver', { status: 'citizens_win', reason: 'spy_caught', kickedName: kickedPlayer.nickname });
    } else {
        // Шпион выиграл, так как выгнали мирного
        io.to(roomCode).emit('gameOver', { status: 'spy_win', reason: 'wrong_vote', kickedName: kickedPlayer.nickname });
    }

    delete rooms[roomCode]; // Удаляем комнату после завершения игры
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Сервер шпиона запущен на порту ${PORT}`);
});
