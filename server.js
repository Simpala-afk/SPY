const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '/'))); // Отдает твой index.html

// База локаций для распределения ролей
const LOCATIONS = ["Орбитальная станция", "Подводная лодка", "Киностудия", "Банк", "Пиратский корабль", "Театр", "Полярная станция"];

let rooms = {}; // Хранилище всех комнат

io.on('connection', (socket) => {
    
    // 1. Свободный чат обсуждения во время голосования
    socket.on('votingChatMsg', ({ roomCode, msg }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        // Рассылаем сообщение всем в комнате
        io.to(roomCode).emit('votingChatBroadcast', {
            nickname: player.nickname,
            msg: msg
        });
    });

    // 2. Создание комнаты
    socket.on('createRoom', ({ nickname }) => {
        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomCode] = {
            roomCode,
            players: [{ id: socket.id, nickname }],
            started: false,
            round: 1,
            turnIndex: 0,
            chatCount: 0,
            votes: {}, // id_кто -> id_кого или 'skip'
            location: ""
        };
        socket.join(roomCode);
        socket.emit('roomData', rooms[roomCode]);
    });

    // 3. Вход в существующую комнату
    socket.on('joinRoom', ({ roomCode, nickname }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('error', 'Комната не найдена!');
        if (room.started) return socket.emit('error', 'Игра в этой комнате уже началась!');
        
        room.players.push({ id: socket.id, nickname });
        socket.join(roomCode);
        io.to(roomCode).emit('roomData', room);
    });

    // 4. Запуск игры Хостом
    socket.on('startGame', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.players.length < 3) return socket.emit('error', 'Для игры нужно минимум 3 игрока!');
        
        room.started = true;
        room.round = 1;
        room.chatCount = 0;
        room.turnIndex = 0;
        room.location = LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)];

        // Выбираем шпиона
        const spyIndex = Math.floor(Math.random() * room.players.length);
        const roles = room.players.map((p, idx) => ({
            id: p.id,
            isSpy: idx === spyIndex
        }));

        room.roles = roles;
        io.to(roomCode).emit('gameStarted', { location: room.location, roles });

        // Автоматически шлем первый статус раунда для инициализации пошагового чата
        io.to(roomCode).emit('roundUpdate', {
            round: room.round,
            turnIndex: room.turnIndex,
            players: room.players
        });
    });

    // 5. Обработка пошагового чата (отправка ОДНОГО слова)
    socket.on('chatWord', ({ roomCode, word }) => {
        const room = rooms[roomCode];
        if (!room || !room.started) return;

        const activePlayer = room.players[room.turnIndex];
        if (socket.id !== activePlayer.id) return; // Защита: не твой ход

        // Пересылаем новое слово всем игрокам
        io.to(roomCode).emit('newWord', {
            nickname: activePlayer.nickname,
            word: word
        });

        // Сдвигаем очередь к следующему игроку
        room.chatCount++;
        room.turnIndex = (room.turnIndex + 1) % room.players.length;

        // Если круг завершился (каждый написал слово) — автоматически кидает всех на экран голосования
        if (room.chatCount >= room.players.length) {
            room.votes = {}; // Сброс старых голосов перед голосованием
            io.to(roomCode).emit('votingStarted');
        } else {
            // Иначе продолжаем круг обсуждения
            io.to(roomCode).emit('roundUpdate', {
                round: room.round,
                turnIndex: room.turnIndex,
                players: room.players
            });
        }
    });

    // 6. Досрочный переход к голосованию (если кто-то нажал кнопку на экране)
    socket.on('startVoting', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;
        room.votes = {}; 
        io.to(roomCode).emit('votingStarted');
    });

    // 7. Прием голосов от игроков (Синхронизировано с фронтендом)
    socket.on('votePlayer', ({ roomCode, suspectId }) => {
        const room = rooms[roomCode];
        if (!room || !room.started) return;

        room.votes[socket.id] = suspectId; // suspectId может быть ID игрока или строкой 'skip'

        // Если проголосовали абсолютно все участники комнаты
        if (Object.keys(room.votes).length === room.players.length) {
            processVotingResults(roomCode);
        }
    });

    // 8. Отключение пользователя
    socket.on('disconnect', () => {
        for (const code in rooms) {
            const room = rooms[code];
            const pIdx = room.players.findIndex(p => p.id === socket.id);
            if (pIdx !== -1) {
                room.players.splice(pIdx, 1);
                if (room.players.length === 0) {
                    delete rooms[code];
                } else {
                    io.to(code).emit('roomData', room);
                }
                break;
            }
        }
    });
});

// Подсчет результатов голосования на основе правила большинства
function processVotingResults(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const voteCounts = {};
    
    // Считаем голоса (включая 'skip')
    Object.values(room.votes).forEach(targetId => {
        if (targetId) {
            voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
        }
    });

    // Находим максимум набранных голосов
    let maxVotes = 0;
    let candidates = [];

    for (const [id, count] of Object.entries(voteCounts)) {
        if (count > maxVotes) {
            maxVotes = count;
            candidates = [id];
        } else if (count === maxVotes && maxVotes > 0) {
            candidates.push(id);
        }
    }

    // Если большинство выбрало 'skip' ИЛИ произошла ничья ИЛИ лидер не набрал строго больше половины голосов
    if (candidates.includes('skip') || candidates.length > 1 || maxVotes <= (room.players.length / 2)) {
        // Ничья / Пропуск -> Переход на следующий круг обсуждения
        room.round++;
        room.chatCount = 0;
        room.turnIndex = 0;
        room.votes = {}; // Очищаем таблицу для нового раунда

        io.to(roomCode).emit('votingResult', {
            status: 'draw',
            nextRound: room.round
        });
        
        // Перезапускаем пошаговые ходы в чате
        io.to(roomCode).emit('roundUpdate', {
            round: room.round,
            turnIndex: room.turnIndex,
            players: room.players
        });
    } else {
        // Если один конкретный игрок набрал абсолютное большинство голосов
        const kickedId = candidates[0];
        const kickedPlayer = room.players.find(p => p.id === kickedId);
        const roleInfo = room.roles.find(r => r.id === kickedId);

        io.to(roomCode).emit('votingResult', {
            status: 'kick',
            kickedName: kickedPlayer ? kickedPlayer.nickname : "Неизвестный игрок",
            wasSpy: roleInfo ? roleInfo.isSpy : false
        });
        
        delete rooms[roomCode]; // Игра завершена, удаляем комнату из памяти
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер шпиона запущен на порту ${PORT}`));