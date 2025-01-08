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
    frozen: {},    // cellId -> turnsLeft
    shielded: {},  // playerId -> turnsLeft
    skippedTurns: {} // playerId -> boolean (true means skip next turn)
  }
});

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
          advanceToNextPlayer(gameState);
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
      advanceToNextPlayer(gameState);
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
      advanceToNextPlayer(gameState);
      break;
    }

    case 'usePowerUp': {
      const { powerUpId, targetPlayer, targetCell } = data;
      const powerUpIndex = currentPlayer.powerUps.findIndex(p => p.id === powerUpId);
      
      // For immediate use power-ups, powerUpIndex might be -1
      const powerUp = powerUpIndex !== -1 
        ? currentPlayer.powerUps[powerUpIndex]
        : { id: powerUpId, type: data.type };

      if (powerUpIndex !== -1) {
        currentPlayer.powerUps.splice(powerUpIndex, 1);
      }

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
            // Mark the target player to skip their next turn
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
      advanceToNextPlayer(gameState);
      break;
    }

    case 'continueAfterPowerUp': {
      // Don't advance to next player, allow another roll
      break;
    }

    case 'endTurn': {
      advanceToNextPlayer(gameState);
      break;
    }
  }

  return gameState;
};

const advanceToNextPlayer = (gameState) => {
  // Process power-up effects
  for (const [playerId, turnsLeft] of Object.entries(gameState.powerUpState.shielded)) {
    if (turnsLeft <= 0) {
      // Remove shield from all cells
