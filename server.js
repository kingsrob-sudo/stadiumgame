const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { google } = require('googleapis');
const cors = require('cors');
require('dotenv').config();

const app = express();
const httpServer = createServer(app);

// Enable CORS for your S3 bucket
const io = new Server(httpServer, {
  cors: {
    origin: "*", // In production, replace with your S3 bucket URL
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Google Sheets Setup
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

let sheetsClient;

// Initialize Google Sheets client
async function initializeSheets() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: './google-credentials.json',
      scopes: SCOPES,
    });
    
    const authClient = await auth.getClient();
    sheetsClient = google.sheets({ version: 'v4', auth: authClient });
    console.log('✅ Google Sheets connected');
  } catch (error) {
    console.error('❌ Error connecting to Google Sheets:', error.message);
  }
}

// Game State
let gameState = {
  correctBox: null,
  revealed: false,
  participants: new Map(), // userId -> {email, boxChoice, timestamp}
  winners: []
};

// Socket.IO Connection Handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Register client type (videoboard, controller, or audience)
  socket.on('register', (data) => {
    socket.clientType = data.type;
    console.log(`${data.type} registered:`, socket.id);
    
    if (data.type === 'videoboard') {
      socket.join('videoboard');
    } else if (data.type === 'controller') {
      socket.join('controller');
    } else if (data.type === 'audience') {
      socket.join('audience');
    }
    
    socket.emit('registered', { success: true });
  });

  // Audience member submits their guess
  socket.on('submitGuess', async (data) => {
    const { email, boxChoice } = data;
    const userId = socket.id;
    const timestamp = new Date().toISOString();
    
    console.log(`Guess received: ${email} chose Box ${boxChoice}`);
    
    // Store in memory
    gameState.participants.set(userId, {
      email,
      boxChoice,
      timestamp,
      socketId: userId
    });
    
    // Write to Google Sheets
    try {
      await appendToSheet({
        timestamp,
        userId,
        email,
        boxChoice,
        won: '', // Will be updated after reveal
        prizeLocation: ''
      });
      
      socket.emit('guessConfirmed', { success: true });
      
      // Send stats to controller
      io.to('controller').emit('statsUpdate', {
        totalParticipants: gameState.participants.size,
        box1Count: countBoxChoices(1),
        box2Count: countBoxChoices(2),
        box3Count: countBoxChoices(3)
      });
      
    } catch (error) {
      console.error('Error saving to sheets:', error);
      socket.emit('guessConfirmed', { success: false, error: 'Failed to save guess' });
    }
  });

  // Controller triggers the reveal
  socket.on('revealWinner', async (data) => {
    if (socket.clientType !== 'controller') {
      return; // Only controller can trigger reveal
    }
    
    const { correctBox } = data;
    console.log(`🎉 REVEAL: Correct box is ${correctBox}`);
    
    gameState.correctBox = correctBox;
    gameState.revealed = true;
    
    // Determine winners
    const winners = selectWinners(correctBox, 10); // Select 10 winners
    gameState.winners = winners;
    
    // Update Google Sheets with winners
    await updateWinnersInSheet(winners);
    
    // Send reveal to videoboard
    io.to('videoboard').emit('showWinner', { correctBox });
    
    // Send results to all audience members
    gameState.participants.forEach((participant, userId) => {
      const won = participant.boxChoice === correctBox;
      const isWinner = winners.some(w => w.userId === userId);
      
      io.to(userId).emit('result', {
        won,
        correctBox,
        yourChoice: participant.boxChoice,
        isWinner,
        prizeLocation: isWinner ? 'Section 101, Gate B' : null
      });
    });
    
    // Send winner list to controller
    io.to('controller').emit('winnersList', {
      winners: winners.map(w => ({
        email: w.email,
        timestamp: w.timestamp
      })),
      totalCorrect: countBoxChoices(correctBox)
    });
  });

  // Reset game (for testing)
  socket.on('resetGame', () => {
    if (socket.clientType !== 'controller') {
      return;
    }
    
    console.log('🔄 Game reset');
    gameState = {
      correctBox: null,
      revealed: false,
      participants: new Map(),
      winners: []
    };
    
    io.emit('gameReset');
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    // Don't remove from participants - they already submitted
  });
});

// Helper Functions
function countBoxChoices(boxNumber) {
  let count = 0;
  gameState.participants.forEach(p => {
    if (p.boxChoice === boxNumber) count++;
  });
  return count;
}

function selectWinners(correctBox, count) {
  // Get all participants who chose correctly
  const correctGuesses = [];
  gameState.participants.forEach((participant, userId) => {
    if (participant.boxChoice === correctBox) {
      correctGuesses.push({ ...participant, userId });
    }
  });
  
  // Randomly select winners
  const shuffled = correctGuesses.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

// Google Sheets Functions
async function appendToSheet(data) {
  if (!sheetsClient) {
    console.log('Sheets not initialized, skipping write');
    return;
  }
  
  const values = [[
    data.timestamp,
    data.userId,
    data.email,
    data.boxChoice,
    data.won,
    data.prizeLocation
  ]];
  
  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: { values }
    });
  } catch (error) {
    console.error('Error writing to sheet:', error.message);
    throw error;
  }
}

async function updateWinnersInSheet(winners) {
  if (!sheetsClient || winners.length === 0) return;
  
  try {
    // Get all rows to find the ones to update
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:F',
    });
    
    const rows = response.data.values || [];
    const updates = [];
    
    // Find and mark winners
    winners.forEach(winner => {
      const rowIndex = rows.findIndex(row => row[1] === winner.userId);
      if (rowIndex !== -1) {
        // Row index + 1 for 1-based indexing, +1 more for header
        updates.push({
          range: `Sheet1!E${rowIndex + 1}:F${rowIndex + 1}`,
          values: [['TRUE', 'Section 101, Gate B']]
        });
      }
    });
    
    if (updates.length > 0) {
      await sheetsClient.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          valueInputOption: 'USER_ENTERED',
          data: updates
        }
      });
    }
  } catch (error) {
    console.error('Error updating winners:', error.message);
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    participants: gameState.participants.size,
    revealed: gameState.revealed,
    correctBox: gameState.correctBox
  });
});

// Start server
const PORT = process.env.PORT || 3000;

initializeSheets().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`🏀 Stadium Game Server running on port ${PORT}`);
    console.log(`📊 Participants: ${gameState.participants.size}`);
  });
});
