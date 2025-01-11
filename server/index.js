import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import cors from 'cors';
import 'dotenv/config';

// Constants
const POWER_UPS = Object.freeze({
  FREEZE: 'freeze',
  SHIELD: 'shield',
  TURN_SKIPPER: 'turnSkipper'
});

const MAX_BULLETS = 5;
const MAX_STAGE = 6;
const POWER_UP_DURATION = 2; // Duration in turns for power-ups

// Function to get power-up trigger number based on player count
function getPowerUpTriggerNumber(playerCount) {
  if (playerCount <= 2) return 3;
  if (playerCount === 3) return 4;
  if (playerCount === 4) return 5;
  return 6; // 5 or more players
}

// Server Setup
const app = express();
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
      ? [/https:\/\/.*\.netlify\.app$/]
      : ["http://localhost:5173"],
    methods: ["GET", "POST"]
}));

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: app.get('cors') });

// Game State Management
class GameStateManager {
  constructor() {
    this.rooms = new Map();
  }

  generateRoomId() {
    let roomId;
    do {
      roomId = Math.floor(100000 + Math.random() * 900000).toString();
    } while (this.rooms.has(roomId));
    return roomId;
  }

  generateId() {
    return Math.random().toString(36).substr(2, 9);
  }

  createRoom(socketId, maxPlayers, password, username) {
    const roomId = this.generateRoomId();
    const room = {
      id: roomId,
      leader: socketId,
      password: password || null,
      maxPlayers,
      players: [{
        id: socketId,
        username,
        ready: true,
        isLeader: true
      }],
      gameState: null,
      started: false
    };
    
    this.rooms.set(roomId, room);
    return room;
  }

  generateRandomPowerUp() {
    const powerUpTypes = Object.values(POWER_UPS);
    return {
      id: this.generateId(),
      type: powerUpTypes[Math.floor(Math.random() * powerUpTypes.length)],
      createdAt: Date.now()
    };
  }

  initializeGameState(players) {
    return {
      currentPlayer: 0,
      turnCount: 0, // Add global turn counter
      players: players.map(p => ({
        id: p.id,
        username: p.username,
        eliminated: false,
        firstMove: true,
        powerUps: [],
        cells: Array(Math.min(players.length, 5)).fill().map(() => ({
          id: this.generateId(),
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
        frozen: {}, // { cellId: { expiresAt: turnCount } }
        shielded: {}, // { playerId: { expiresAt: turnCount } }
        skippedTurns: {} // { playerId: { expiresAt: turnCount } }
      }
    };
  }

  processRoll(gameState, value, room) {
    const currentPlayer = gameState.players[gameState.currentPlayer];
    gameState.lastRoll = value;
      
    // Handle power-up roll based on player count
    const powerUpTrigger = getPowerUpTriggerNumber(room.players.length);
    if (value === powerUpTrigger) {
      const powerUp = this.generateRandomPowerUp();
      gameState.gameLog.push({
        type: 'powerUp',
        player: currentPlayer.username,
        powerUp: powerUp.type
      });
      currentPlayer.powerUps.push(powerUp);
      return gameState;
    }

    gameState.rolledCell = value - 1;
    const cellIndex = value - 1;
    const cell = currentPlayer.cells[cellIndex];

    // Handle first move
    if (currentPlayer.firstMove) {
      if (value !== 1) {
        gameState.gameLog.push({
          type: 'firstMove',
          player: currentPlayer.username,
          message: `${currentPlayer.username} didn't roll a 1. Next player's turn!`
        });
        gameState.canShoot = false;
        this.advanceToNextPlayer(gameState);
        return gameState;
      }
      currentPlayer.firstMove = false;
    }

    // Handle shooting check
    if (cell.isActive && cell.stage === MAX_STAGE && cell.bullets > 0) {
      gameState.canShoot = true;
      return gameState;
    }

    this.processCellUpdate(cell, currentPlayer, cellIndex, gameState);
    gameState.canShoot = false;
    this.advanceToNextPlayer(gameState);
    return gameState;
  }

  processCellUpdate(cell, player, cellIndex, gameState) {
    if (!cell.isActive) {
      cell.stage = 1;
      cell.isActive = true;
      cell.bullets = 0;
      gameState.gameLog.push({
        type: 'activate',
        player: player.username,
        cell: cellIndex + 1
      });
      return;
    }

    if (cell.stage < MAX_STAGE && !cell.isFrozen) {
      cell.stage += 1;
      if (cell.stage === MAX_STAGE) {
        cell.bullets = MAX_BULLETS;
        gameState.gameLog.push({
          type: 'maxLevel',
          player: player.username,
          cell: cellIndex + 1
        });
      }
      return;
    }

    if (cell.stage === MAX_STAGE && cell.bullets === 0) {
      cell.bullets = MAX_BULLETS;
      gameState.gameLog.push({
        type: 'reload',
        player: player.username,
        cell: cellIndex + 1
      });
    }
  }

  processPowerUp(gameState, powerUpId, targetPlayer, targetCell) {
    const currentPlayer = gameState.players[gameState.currentPlayer];
    const powerUpIndex = currentPlayer.powerUps.findIndex(p => p.id === powerUpId);
    if (powerUpIndex === -1) return gameState;

    const powerUp = currentPlayer.powerUps[powerUpIndex];
    currentPlayer.powerUps.splice(powerUpIndex, 1);
    const target = gameState.players[targetPlayer];

    const powerUpHandlers = {
      [POWER_UPS.FREEZE]: () => {
        if (!targetCell) return;
        const cell = target.cells.find(c => c.id === targetCell);
        if (cell?.isActive && !cell.isShielded) {
          cell.isFrozen = true;
          // Set expiration based on turn count
          gameState.powerUpState.frozen[targetCell] = {
            expiresAt: gameState.turnCount + POWER_UP_DURATION
          };
        }
      },
      [POWER_UPS.SHIELD]: () => {
        // Set expiration based on turn count
        gameState.powerUpState.shielded[target.id] = {
          expiresAt: gameState.turnCount + POWER_UP_DURATION
        };
        target.cells.forEach(cell => {
          if (cell.isActive) cell.isShielded = true;
        });
      },
      [POWER_UPS.TURN_SKIPPER]: () => {
        if (!target.eliminated) {
          // Set expiration based on turn count
          gameState.powerUpState.skippedTurns[target.id] = {
            expiresAt: gameState.turnCount + 1 // Skip only one turn
          };
        }
      }
    };

    powerUpHandlers[powerUp.type]?.();
            
    gameState.gameLog.push({
      type: 'usePowerUp',
      player: currentPlayer.username,
      target: target.username,
      powerUp: powerUp.type
    });

    return gameState;
  }

  advanceToNextPlayer(gameState) {
    this.processPowerUpEffects(gameState);
    gameState.turnCount++; // Increment turn counter
    
    do {
      gameState.currentPlayer = (gameState.currentPlayer + 1) % gameState.players.length;
    } while (gameState.players[gameState.currentPlayer].eliminated);

    const currentPlayerId = gameState.players[gameState.currentPlayer].id;

    // Check if current player's turn should be skipped
    const skipInfo = gameState.powerUpState.skippedTurns[currentPlayerId];
    if (skipInfo?.expiresAt > gameState.turnCount) {
      this.advanceToNextPlayer(gameState);
    }
  }

  processPowerUpEffects(gameState) {
    // Process shields
    Object.entries(gameState.powerUpState.shielded).forEach(([playerId, info]) => {
      if (info.expiresAt <= gameState.turnCount) {
        const player = gameState.players.find(p => p.id === playerId);
        if (player) {
          player.cells.forEach(cell => cell.isShielded = false);
        }
        delete gameState.powerUpState.shielded[playerId];
      }
    });

    // Process frozen cells
    Object.entries(gameState.powerUpState.frozen).forEach(([cellId, info]) => {
      if (info.expiresAt <= gameState.turnCount) {
        gameState.players.forEach(player => {
          player.cells.forEach(cell => {
            if (cell.id === cellId) cell.isFrozen = false;
          });
        });
        delete gameState.powerUpState.frozen[cellId];
      }
    });

    // Clean up expired turn skips
    Object.entries(gameState.powerUpState.skippedTurns).forEach(([playerId, info]) => {
      if (info.expiresAt <= gameState.turnCount) {
        delete gameState.powerUpState.skippedTurns[playerId];
      }
    });
  }

  handlePlayerDisconnect(socketId) {
    for (const [roomId, room] of this.rooms.entries()) {
      const playerIndex = room.players.findIndex(p => p.id === socketId);
      
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        
        if (room.players.length === 0) {
          this.rooms.delete(roomId);
          return null;
        }
        
        if (room.leader === socketId) {
          room.leader = room.players[0].id;
          room.players[0].isLeader = true;
        }
        
        return room;
      }
    }
    return null;
  }

  processShoot(gameState, targetPlayer, targetCell) {
    const currentPlayer = gameState.players[gameState.currentPlayer];
    const target = gameState.players[targetPlayer];
    const cell = target.cells.find(c => c.id === targetCell);

    if (!cell || !cell.isActive) {
      gameState.gameLog.push({
        type: 'blocked',
        shooter: currentPlayer.username,
        target: target.username,
        message: 'Cell is not active'
      });
      return gameState;
    }

    if (cell.isShielded) {
      gameState.gameLog.push({
        type: 'blocked',
        shooter: currentPlayer.username,
        target: target.username,
        message: 'Cell is shielded'
      });
      return gameState;
    }

    // Decrease bullet count
    const shooterCell = currentPlayer.cells[gameState.rolledCell];
    shooterCell.bullets--;

    // Handle hit
    cell.isActive = false;
    cell.stage = 0;
    cell.bullets = 0;
    cell.isShielded = false;
    cell.isFrozen = false;

    gameState.gameLog.push({
      type: 'shoot',
      shooter: currentPlayer.username,
      target: target.username,
      cell: target.cells.indexOf(cell) + 1
    });

    // Check if player is eliminated
    if (target.cells.every(c => !c.isActive)) {
      target.eliminated = true;
      gameState.gameLog.push({
        type: 'eliminate',
        shooter: currentPlayer.username,
        target: target.username
      });
    }

    gameState.canShoot = false;
    this.advanceToNextPlayer(gameState);
    return gameState;
  }
}

// Initialize game state manager
const gameManager = new GameStateManager();

// Socket event handlers
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('createRoom', ({ maxPlayers, password, username }) => {
    const room = gameManager.createRoom(socket.id, maxPlayers, password, username);
    socket.join(room.id);
    socket.emit('roomCreated', {
      roomId: room.id,
      room: { ...room, password: undefined }
    });
  });

  socket.on('joinRoom', ({ roomId, password, username }) => {
    const room = gameManager.rooms.get(roomId);
    
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
      room: { ...room, password: undefined }
    });
  });

  socket.on('toggleReady', ({ roomId }) => {
    const room = gameManager.rooms.get(roomId);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.ready = !player.ready;
      io.to(roomId).emit('roomUpdated', {
        room: { ...room, password: undefined }
      });
    }
  });

  socket.on('startGame', ({ roomId }) => {
    const room = gameManager.rooms.get(roomId);
    if (!room || room.leader !== socket.id) return;

    if (room.players.every(p => p.ready)) {
      room.started = true;
      room.gameState = gameManager.initializeGameState(room.players);
      io.to(roomId).emit('gameStarted', { gameState: room.gameState });
    }
  });

  socket.on('gameAction', ({ roomId, action, data }) => {
    const room = gameManager.rooms.get(roomId);
    if (!room?.started) return;

    const currentPlayerId = room.gameState.players[room.gameState.currentPlayer].id;
    if (currentPlayerId !== socket.id) return;

    let updatedGameState;
    switch (action) {
      case 'roll':
        updatedGameState = gameManager.processRoll(room.gameState, data.value, room);
        break;
      case 'usePowerUp':
        updatedGameState = gameManager.processPowerUp(room.gameState, data.powerUpId, data.targetPlayer, data.targetCell);
        break;
      case 'storePowerUp':
        room.gameState.players[room.gameState.currentPlayer].powerUps.push({
          id: gameManager.generateId(),
          type: data.powerUpType,
          createdAt: Date.now()
        });
        gameManager.advanceToNextPlayer(room.gameState);
        updatedGameState = room.gameState;
        break;
      case 'shoot':
        updatedGameState = gameManager.processShoot(
          room.gameState, 
          data.targetPlayer, 
          data.targetCell
        );
        break;
    }

    if (updatedGameState) {
      io.to(roomId).emit('gameStateUpdated', { gameState: updatedGameState });
    }
  });

  socket.on('disconnect', () => {
    const updatedRoom = gameManager.handlePlayerDisconnect(socket.id);
    if (updatedRoom) {
      io.to(updatedRoom.id).emit('playerLeft', {
        room: { ...updatedRoom, password: undefined }
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
