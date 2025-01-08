import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? [/https:\/\/.*\.netlify\.app$/]
      : ["http://localhost:5173"],
    methods: ["GET", "POST"]
  }
});

const rooms = new Map();

// AI player names
const aiNames = [
  'AlphaBot', 'OmegaAI', 'NeuralKnight', 'QuantumMind', 'CyberGenius',
  'SiliconSage', 'BinaryBrain', 'LogicPrime', 'DataLord', 'TechTitan'
];

const generateRoomId = () => {
  let roomId;
  do {
    roomId = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(roomId));
  return roomId;
};

const generateRandomPowerUp = () => {
  const powerUps = ['freeze', 'shield', 'turnSkipper'];
  const randomIndex = Math.floor(Math.random() * powerUps.length);
  return {
    id: Math.random().toString(36).substr(2, 9),
    type: powerUps[randomIndex],
    createdAt: Date.now()
  };
};

const initializeGameState = (players) => ({
  currentPlayer: 0,
  players: players.map(p => ({
    id: p.id,
    username: p.username,
    eliminated: false,
    firstMove: true,
    powerUps: [],
    cells: Array(Math.min(players.length, 5)).fill().map(() => ({
      id: Math.random().toString(36).substr(2, 9),
      stage: 0,
      isActive: false,
      bullets: 0,
      isShielded: false,
      isFrozen: false
    }))
  })),
  lastRoll: null,
  gameLog: [],
  canShoot: false,
  rolledCell: null,
  powerUpState: {
    frozen: {},
    shielded: {},
    skippedTurns: {}
  }
});

// AI logic for making moves
const makeAIMove = (room, playerId) => {
  const gameState = room.gameState;
  const currentPlayer = gameState.players[gameState.currentPlayer];
  
  // Delay AI moves to make them feel more natural
  setTimeout(() => {
    if (currentPlayer.firstMove) {
      // Roll until we get a 1
      processGameAction(room, 'roll', { value: 1 });
    } else if (gameState.canShoot) {
      // Find a valid target to shoot
      const validTargets = gameState.players
        .map((p, i) => ({ player: p, index: i }))
        .filter(({ player, index }) => 
          index !== gameState.currentPlayer && 
          !player.eliminated &&
          player.cells.some(c => c.isActive)
        );

      if (validTargets.length > 0) {
        const target = validTargets[Math.floor(Math.random() * validTargets.length)];
        const validCells = target.player.cells
          .map((c, i) => ({ cell: c, index: i }))
          .filter(({ cell }) => cell.isActive);
        
        if (validCells.length > 0) {
          const targetCell = validCells[Math.floor(Math.random() * validCells.length)];
          processGameAction(room, 'shoot', {
            targetPlayer: target.index,
            targetCell: targetCell.index
          });
        }
      }
    } else {
      // Roll a random number
      const roll = Math.floor(Math.random() * Math.min(room.players.length, 6)) + 1;
      processGameAction(room, 'roll', { value: roll });
    }
  }, 1000); // 1 second delay for AI moves
};

const processGameAction = (room, action, data) => {
  const { gameState } = room;
  const currentPlayer = gameState.players[gameState.currentPlayer];

  switch (action) {
    case 'roll': {
      const { value } = data;
      gameState.lastRoll = value;
      
      // Special handling for 6 in 5+ player games
      if (room.players.length >= 5 && value === 6) {
        const powerUp = generateRandomPowerUp();
        gameState.gameLog.push({
          type: 'powerUp',
          player: currentPlayer.username,
          powerUp: powerUp.type
        });
        currentPlayer.powerUps.push(powerUp);
        return gameState;
      }

      gameState.rolledCell = value - 1;

      // First move rule - one attempt per turn
      if (currentPlayer.firstMove) {
        if (value !== 1) {
          gameState.gameLog.push({
            type: 'firstMove',
            player: currentPlayer.username,
            message: `${currentPlayer.username} didn't roll a 1. Next player's turn!`
          });
          gameState.canShoot = false;
          advanceToNextPlayer(room);
          break;
        } else {
          currentPlayer.firstMove = false;
        }
      }

      const cellIndex = value - 1;
      const cell = currentPlayer.cells[cellIndex];

      // Check if the cell has a gun with bullets
      if (cell.isActive && cell.stage === 6 && cell.bullets > 0) {
        gameState.canShoot = true;
        return gameState;
      }

      if (!cell.isActive) {
        currentPlayer.cells[cellIndex] = {
          ...cell,
          stage: 1,
          isActive: true,
          bullets: 0
        };
        gameState.gameLog.push({
          type: 'activate',
          player: currentPlayer.username,
          cell: cellIndex + 1
        });
      } else if (cell.stage < 6) {
        if (!cell.isFrozen) {
          cell.stage += 1;
          if (cell.stage === 6) {
            cell.bullets = 5;
            gameState.gameLog.push({
              type: 'maxLevel',
              player: currentPlayer.username,
              cell: cellIndex + 1
            });
          }
        }
      } else if (cell.bullets === 0) {
        cell.bullets = 5;
        gameState.gameLog.push({
          type: 'reload',
          player: currentPlayer.username,
          cell: cellIndex + 1
        });
      }

      gameState.canShoot = false;
      advanceToNextPlayer(room);
      break;
    }

    case 'shoot': {
      const { targetPlayer, targetCell } = data;
      const sourceCell = currentPlayer.cells[gameState.rolledCell];
      const target = gameState.players[targetPlayer];

      if (sourceCell.bullets > 0) {
        const targetCellObj = target.cells[targetCell];
        
        // Check if the target cell is shielded
        if (!targetCellObj.isShielded) {
          targetCellObj.stage = 0;
          targetCellObj.isActive = false;
          targetCellObj.bullets = 0;
          targetCellObj.isFrozen = false; // Reset frozen state when destroyed

          sourceCell.bullets -= 1;

          gameState.gameLog.push({
            type: 'shoot',
            shooter: currentPlayer.username,
            target: target.username,
            cell: targetCell + 1
          });

          // Remove any power-up effects on the destroyed cell
          delete gameState.powerUpState.frozen[targetCellObj.id];

          target.eliminated = target.cells.every(cell => !cell.isActive);
          if (target.eliminated) {
            gameState.gameLog.push({
              type: 'eliminate',
              player: target.username
            });
          }
        } else {
          gameState.gameLog.push({
            type: 'blocked',
            shooter: currentPlayer.username,
            target: target.username,
            cell: targetCell + 1
          });
          sourceCell.bullets -= 1; // Still consume a bullet even if blocked
        }
      }

      gameState.canShoot = false;
      advanceToNextPlayer(room);
      break;
    }

    case 'usePowerUp': {
      const { powerUpId, targetPlayer, targetCell } = data;
      const powerUpIndex = currentPlayer.powerUps.findIndex(p => p.id === powerUpId);
      if (powerUpIndex === -1) return gameState;

      const powerUp = currentPlayer.powerUps[powerUpIndex];
      currentPlayer.powerUps.splice(powerUpIndex, 1);

      const target = gameState.players[targetPlayer];

      switch (powerUp.type) {
        case 'freeze': {
          if (targetCell) {
            const cell = target.cells.find(c => c.id === targetCell);
            if (cell && cell.isActive && !cell.isShielded) {
              cell.isFrozen = true;
              gameState.powerUpState.frozen[targetCell] = 2; // Freeze for 2 turns
              
              gameState.gameLog.push({
                type: 'usePowerUp',
                player: currentPlayer.username,
                target: target.username,
                powerUp: 'freeze'
              });
            }
          }
          break;
        }
        case 'shield': {
          // Shield all cells of the target player
          gameState.powerUpState.shielded[target.id] = 2; // Shield for 2 turns
          target.cells.forEach(cell => {
            if (cell.isActive) {
              cell.isShielded = true;
            }
          });
          
          gameState.gameLog.push({
            type: 'usePowerUp',
            player: currentPlayer.username,
            target: target.username,
            powerUp: 'shield'
          });
          break;
        }
        case 'turnSkipper': {
          if (!target.eliminated) {
            // Mark the target player to skip their next turn only
            gameState.powerUpState.skippedTurns[target.id] = true;
            
            gameState.gameLog.push({
              type: 'usePowerUp',
              player: currentPlayer.username,
              target: target.username,
              powerUp: 'turnSkipper'
            });
          }
          break;
        }
      }

      break;
    }

    case 'storePowerUp': {
      const { powerUpType } = data;
      const powerUp = {
        id: Math.random().toString(36).substr(2, 9),
        type: powerUpType,
        createdAt: Date.now()
      };
      currentPlayer.powerUps.push(powerUp);
      advanceToNextPlayer(room);
      break;
    }

    case 'continueAfterPowerUp': {
      // Don't advance to next player, allow another roll
      break;
    }

    case 'endTurn': {
      advanceToNextPlayer(room);
      break;
    }
  }

  return gameState;
};

const advanceToNextPlayer = (room) => {
  const gameState = room.gameState;
  
  // Process power-up effects
  for (const [playerId, turnsLeft] of Object.entries(gameState.powerUpState.shielded)) {
    if (turnsLeft <= 0) {
      // Remove shield from all cells
      const player = gameState.players.find(p => p.id === playerId);
      if (player) {
        player.cells.forEach(cell => {
          cell.isShielded = false;
        });
      }
      delete gameState.powerUpState.shielded[playerId];
    } else {
      gameState.powerUpState.shielded[playerId]--;
    }
  }

  for (const [cellId, turnsLeft] of Object.entries(gameState.powerUpState.frozen)) {
    if (turnsLeft <= 0) {
      // Find and unfreeze the cell
      gameState.players.forEach(player => {
        player.cells.forEach(cell => {
          if (cell.id === cellId) {
            cell.isFrozen = false;
          }
        });
      });
      delete gameState.powerUpState.frozen[cellId];
    } else {
      gameState.powerUpState.frozen[cellId]--;
    }
  }

  // Move to next player
  do {
    gameState.currentPlayer = (gameState.currentPlayer + 1) % gameState.players.length;
  } while (gameState.players[gameState.currentPlayer].eliminated);

  // Check if current player should skip their turn
  const currentPlayerId = gameState.players[gameState.currentPlayer].id;
  if (gameState.powerUpState.skippedTurns[currentPlayerId]) {
  // Check if current player should skip their turn
  const currentPlayerId = gameState.players[gameState.currentPlayer].id;
  if (gameState.powerUpState.skippedTurns[currentPlayerId]) {
    // Remove the skip status and skip to next player
    delete gameState.powerUpState.skippedTurns[currentPlayerId];
    // Recursively call to move to next player
    advanceToNextPlayer(room);
    return;
  }

  // If it's an AI player's turn, make their move
  const currentPlayer = room.players[gameState.currentPlayer];
  if (currentPlayer.isAI) {
    makeAIMove(room, currentPlayer.id);
  }
};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('createRoom', ({ maxPlayers, password, username }) => {
    const roomId = generateRoomId();
    const room = {
      id: roomId,
      leader: socket.id,
      password: password || null,
      maxPlayers,
      players: [{
        id: socket.id,
        username,
        ready: true,
        isLeader: true
      }],
      gameState: null,
      started: false
    };
    
    rooms.set(roomId, room);
    socket.join(roomId);
    
    socket.emit('roomCreated', {
      roomId,
      room: {
        ...room,
        password: undefined
      }
    });
  });

  socket.on('createAIGame', ({ totalPlayers, username }) => {
    const roomId = generateRoomId();
    const shuffledAiNames = [...aiNames].sort(() => Math.random() - 0.5);
    
    const room = {
      id: roomId,
      leader: socket.id,
      password: null,
      maxPlayers: totalPlayers,
      players: [
        {
          id: socket.id,
          username,
          ready: true,
          isLeader: true
        },
        ...Array(totalPlayers - 1).fill(null).map((_, i) => ({
          id: `ai-${i}`,
          username: shuffledAiNames[i],
          ready: true,
          isLeader: false,
          isAI: true
        }))
      ],
      gameState: null,
      started: false
    };
    
    rooms.set(roomId, room);
    socket.join(roomId);
    
    // Start the game immediately since all AI players are ready
    room.started = true;
    room.gameState = initializeGameState(room.players);
    
    socket.emit('roomCreated', {
      roomId,
      room: {
        ...room,
        password: undefined
      }
    });
    
    socket.emit('gameStarted', { gameState: room.gameState });
  });

  socket.on('joinRoom', ({ roomId, password, username }) => {
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    if (room.password && room.password !== password) {
      socket.emit('error', { message: 'Incorrect password' });
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }

    if (room.started) {
      socket.emit('error', { message: 'Game already in progress' });
      return;
    }

    room.players.push({
      id: socket.id,
      username,
      ready: false,
      isLeader: false
    });

    socket.join(roomId);
    
    io.to(roomId).emit('playerJoined', {
      room: {
        ...room,
        password: undefined
      }
    });
  });

  socket.on('toggleReady', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.ready = !player.ready;
      io.to(roomId).emit('roomUpdated', {
        room: {
          ...room,
          password: undefined
        }
      });
    }
  });

  socket.on('startGame', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.leader !== socket.id) return;

    if (room.players.every(p => p.ready)) {
      room.started = true;
      room.gameState = initializeGameState(room.players);
      io.to(roomId).emit('gameStarted', { gameState: room.gameState });
      
      // If the first player is AI, make their move
      if (room.players[0].isAI) {
        makeAIMove(room, room.players[0].id);
      }
    }
  });

  socket.on('gameAction', ({ roomId, action, data }) => {
    const room = rooms.get(roomId);
    if (!room || !room.started) return;

    const currentPlayerId = room.gameState.players[room.gameState.currentPlayer].id;
    if (currentPlayerId !== socket.id) return;

    const updatedGameState = processGameAction(room, action, data);
    io.to(roomId).emit('gameStateUpdated', { gameState: updatedGameState });
  });

  socket.on('disconnect', () => {
    for (const [roomId, room] of rooms.entries()) {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        
        if (room.players.length === 0) {
          rooms.delete(roomId);
        } else if (room.leader === socket.id) {
          room.leader = room.players[0].id;
          room.players[0].isLeader = true;
        }

        io.to(roomId).emit('playerLeft', {
          room: {
            ...room,
            password: undefined
          }
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
