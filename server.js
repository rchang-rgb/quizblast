const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// Send the server's real local IP to the client
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}
app.get('/server-info', (req, res) => {
  const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://${getLocalIP()}:${PORT}`;
  res.json({ url: publicUrl });
});

const games = {}; // gamePin -> game state

function generatePin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function calcPoints(timeLeft, totalTime) {
  const base = 1000;
  const bonus = Math.round((timeLeft / totalTime) * 500);
  return base + bonus;
}

io.on('connection', (socket) => {

  // HOST creates a game
  socket.on('host:create', ({ questions, playerLimit }) => {
    const pin = generatePin();
    games[pin] = {
      pin,
      hostSocket: socket.id,
      players: {},
      questions: questions || [],
      currentQ: -1,
      phase: 'lobby',    // lobby | question | results | podium
      questionTimer: null,
      playerLimit: playerLimit || 100,
    };
    socket.join(pin);
    socket.emit('host:created', { pin });
  });

  // HOST starts the game
  socket.on('host:start', ({ pin }) => {
    const game = games[pin];
    if (!game || socket.id !== game.hostSocket) return;
    game.phase = 'starting';
    io.to(pin).emit('game:starting');
    setTimeout(() => nextQuestion(pin), 3000);
  });

  // HOST moves to next question (after reviewing results)
  socket.on('host:next', ({ pin }) => {
    const game = games[pin];
    if (!game || socket.id !== game.hostSocket) return;
    nextQuestion(pin);
  });

  // PLAYER joins
  socket.on('player:join', ({ pin, name }) => {
    const game = games[pin];
    if (!game) return socket.emit('player:error', 'Game not found');
    if (game.phase !== 'lobby') return socket.emit('player:error', 'Game already started');
    if (Object.keys(game.players).length >= game.playerLimit)
      return socket.emit('player:error', 'Lobby is full');
    if (Object.values(game.players).find(p => p.name === name))
      return socket.emit('player:error', 'Name already taken');

    game.players[socket.id] = { id: socket.id, name, score: 0, answers: [] };
    socket.join(pin);
    socket.emit('player:joined', { name, pin });
    io.to(pin).emit('lobby:update', { players: Object.values(game.players) });
  });

  // PLAYER submits answer
  socket.on('player:answer', ({ pin, answerIndex }) => {
    const game = games[pin];
    if (!game || game.phase !== 'question') return;
    const player = game.players[socket.id];
    if (!player) return;
    const q = game.questions[game.currentQ];
    if (!q) return;

    // Ignore duplicate answers
    if (player.answers[game.currentQ] !== undefined) return;

    const timeLeft = game.timeLeft || 0;
    const correct = answerIndex === q.correct;
    const points = correct ? calcPoints(timeLeft, q.time || 20) : 0;

    player.answers[game.currentQ] = { answerIndex, correct, points };
    if (correct) player.score += points;

    // Tell the player if they were correct
    socket.emit('player:answered', { correct, points });

    // Tell host how many answered
    const answered = Object.values(game.players).filter(p => p.answers[game.currentQ] !== undefined).length;
    io.to(game.hostSocket).emit('host:answer_count', { answered, total: Object.keys(game.players).length });

    // Auto-end if everyone answered
    if (answered === Object.keys(game.players).length) {
      endQuestion(pin);
    }
  });

  socket.on('disconnect', () => {
    // Remove from any game
    for (const pin in games) {
      const game = games[pin];
      if (socket.id === game.hostSocket) {
        io.to(pin).emit('game:ended', { reason: 'Host disconnected' });
        clearTimeout(game.questionTimer);
        delete games[pin];
      } else if (game.players[socket.id]) {
        delete game.players[socket.id];
        io.to(pin).emit('lobby:update', { players: Object.values(game.players) });
      }
    }
  });
});

function nextQuestion(pin) {
  const game = games[pin];
  if (!game) return;
  game.currentQ++;

  if (game.currentQ >= game.questions.length) {
    game.phase = 'podium';
    const sorted = Object.values(game.players).sort((a, b) => b.score - a.score).slice(0, 10);
    io.to(pin).emit('game:podium', { leaderboard: sorted });
    return;
  }

  const q = game.questions[game.currentQ];
  const duration = q.time || 20;
  game.phase = 'question';
  game.timeLeft = duration;

  // Send question to host (with correct answer)
  io.to(game.hostSocket).emit('host:question', {
    question: q,
    index: game.currentQ,
    total: game.questions.length,
    duration,
  });

  // Send question to players (WITHOUT correct answer)
  const playerQ = { text: q.text, options: q.options, image: q.image || null };
  Object.keys(game.players).forEach(sid => {
    if (sid !== game.hostSocket) {
      io.to(sid).emit('player:question', { question: playerQ, index: game.currentQ, duration });
    }
  });

  // Tick timer
  const tick = setInterval(() => {
    game.timeLeft--;
    io.to(pin).emit('game:tick', { timeLeft: game.timeLeft, duration });
    if (game.timeLeft <= 0) {
      clearInterval(tick);
      endQuestion(pin);
    }
  }, 1000);
  game.questionTimer = tick;
}

function endQuestion(pin) {
  const game = games[pin];
  if (!game || game.phase !== 'question') return;
  game.phase = 'results';
  if (game.questionTimer) clearInterval(game.questionTimer);

  const q = game.questions[game.currentQ];
  const stats = q.options.map((_, i) => ({
    count: Object.values(game.players).filter(p => p.answers[game.currentQ]?.answerIndex === i).length,
    correct: i === q.correct,
  }));
  const sorted = Object.values(game.players).sort((a, b) => b.score - a.score).slice(0, 5);

  io.to(pin).emit('game:results', {
    correct: q.correct,
    explanation: q.explanation || null,
    stats,
    leaderboard: sorted,
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`QuizBlast running at http://localhost:${PORT}`));
