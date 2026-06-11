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

// ТВОЙ ОБНОВЛЕННЫЙ СПИСОК ПРОСТЫХ СЛОВ ВМЕСТО ЛОКАЦИЙ
const onlineLocations = [
    "Ложка", "Ручка", "Книга", "Стол", "Стул", "Окно", "Дверь", "Лампа", "Кошка", "Собака",
    "Чайник", "Чашка", "Тарелка", "Нож", "Кровать", "Подушка", "Ковёр", "Телефон", "Ключ", "Часы",
    "Шапка", "Обувь", "Носок", "Куртка", "Сумка", "Зонт", "Газета", "Зеркало", "Расчёска", "Мыло",
    "Щётка", "Полотенце", "Ведро", "Утюг", "Мяч", "Кукла", "Машина", "Автобус", "Поезд", "Самолёт",
    "Корабль", "Мост", "Дорога", "Дерево", "Цветок", "Трава", "Солнце", "Луна", "Звезда", "Небо",
    "Облако", "Дождь", "Снег", "Вода", "Река", "Море", "Гора", "Лес", "Хлеб", "Молоко",
    "Сыр", "Яблоко", "Банан", "Лимон", "Огурец", "Томат", "Картошка", "Торт", "Конфета", "Рыба",
    "Птица", "Лошадь", "Корова", "Медведь", "Заяц", "Мышь", "Дом", "Школа", "Магазин", "Парк",
    "Театр", "Кино", "Картина", "Письмо", "Деньги", "Кошелёк", "Очки", "Кольцо", "Гитара", "Краска",
    "Карандаш", "Тетрадь", "Рюкзак", "Шкаф", "Полка", "Коробка", "Забор", "Кирпич", "Топор"
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
    room.votes = {};        // Очищаем старые голоса перед новым голосованием
    room.votedPlayers = [];  // Очищаем список проголосовавших

    io.to(roomCode).emit('votingStarted', {
        players: room.players.map(p => ({ id: p.id, nickname: p.nickname }))
    });
}

function sendChatUpdate(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(roomCode).emit('chatUpdate', {
        history: room.history,
        step: room.step,
        round: room.round,
        activePlayerIdx: room.activePlayerIdx,
        players: room.players
    });
}

function sendVotingChatUpdate(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(roomCode).emit('votingChatUpdate', { votingHistory: room.votingHistory });
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
        const { roomCode } = data;
        const room = rooms[roomCode];
        if (!room) return;

        if (room.players.length < 3) {
            return socket.emit('errorMsg', 'Для игры нужно минимум 3 игрока!');
        }

        // ОБНУЛЕНИЕ ДАННЫХ ДЛЯ НОВОЙ ИГРЫ
        room.status = 'ingame';
        room.round = 1;
        room.step = 1;
        room.history = [];
        room.votes = {}; // Важно! Очищаем таблицу голосов прошлых игр
        room.votedPlayers = []; // И список проголосовавших

        // Выбираем случайную локацию
        const randomLoc = onlineLocations[Math.floor(Math.random() * onlineLocations.length)];
        room.location = randomLoc;

        // Распределяем роли (1 шпион, остальные мирные)
        const spyIdx = Math.floor(Math.random() * room.players.length);
        room.roles = room.players.map((p, idx) => {
            return {
                id: p.id,
                nickname: p.nickname,
                isSpy: idx === spyIdx
            };
        });

        // Назначаем первого ходящего
        room.activePlayerIdx = Math.floor(Math.random() * room.players.length);

        // Рассылаем старт игры
        io.to(roomCode).emit('gameStarted', {
            roles: room.roles,
            location: room.location
        });

        // Отправляем первое обновление чата
        sendChatUpdate(roomCode);
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

        room.votingHistory.push({ nickname: sender.nickname, text: data.text });
        sendVotingChatUpdate(data.roomCode);
    });

    socket.on('submitVote', (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.status !== 'voting') return;
        if (room.votedPlayers.has(socket.id)) return;

        room.votedPlayers.add(socket.id);
        room.votes[data.targetId] = (room.votes[data.targetId] || 0) + 1;

        io.to(data.roomCode).emit('playerVotedUpdate', { votedCount: room.votedPlayers.size });

        if (room.votedPlayers.size === room.players.length) {
            processVotingResults(data.roomCode);
        }
    });

    socket.on('spyGuessLocation', (data) => {
        const room = rooms[data.code];
        if (!room) return;
        
        const isCorrect = room.location.toLowerCase().trim() === data.location.toLowerCase().trim();
        if (isCorrect) {
            io.to(data.code).emit('gameOver', { status: 'spy_win_guess', kickedName: 'Шпион угадал секретное слово!', word: room.location });
        } else {
            io.to(data.code).emit('gameOver', { status: 'citizens_win_guess', kickedName: `Шпион ошибся! Было загадано слово: ${room.location}`, word: room.location });
        }
        room.status = 'lobby';
    });

    socket.on('disconnect', () => {
        console.log(`Пользователь отключился: ${socket.id}`);
        for (let code in rooms) {
            let room = rooms[code];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const wasHost = room.players[playerIndex].isHost;
                room.players.splice(playerIndex, 1);
                
                if (room.players.length === 0) {
                    delete rooms[code];
                } else {
                    if (wasHost) {
                        room.players[0].isHost = true;
                    }
                    io.to(code).emit('roomPlayersUpdate', { players: room.players });
                    if (room.status === 'ingame' || room.status === 'voting') {
                        io.to(code).emit('gameOver', { status: 'draw_disconnect', kickedName: 'Один из игроков вышел из сети.' });
                        room.status = 'lobby';
                    }
                }
                break;
            }
        }
    });
});

function processVotingResults(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    let maxVotes = -1;
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

    if (isTie || kickedId === 'skip') {
        room.round += 1;
        room.step = 1;
        room.status = 'ingame';
        room.history = []; 
        room.activePlayerIdx = Math.floor(Math.random() * room.players.length);
        room.votedPlayers.clear();
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
        room.votedPlayers.clear();
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
