const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { google } = require('googleapis');
const { Pool } = require('pg');
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

// Hardcoded prize codes for top 10 winners (always the same)
const PRIZE_CODES = [
  'FE32', 'BK47', 'MN89', 'QR56', 'WX12',
  'LZ34', 'DP78', 'GT91', 'HS23', 'VY65'
];

// Controller credentials
const CONTROLLER_USERNAME = 'GLC2026';
const CONTROLLER_PASSWORD = 'prize26box!';

// Authentication endpoint for controller
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  
  console.log('Login attempt:', username); // Debug log
  
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password required' });
  }
  
  if (username !== CONTROLLER_USERNAME || password !== CONTROLLER_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
  
  // Generate a simple session token
  const token = Buffer.from(`${username}:${Date.now()}`).toString('base64');
  
  console.log('Login successful:', username); // Debug log
  res.json({ success: true, token });
});

// PostgreSQL Setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ PostgreSQL connection error:', err);
  } else {
    console.log('✅ PostgreSQL connected');
  }
});

// Create tables if they don't exist
async function initializeDatabase() {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS participants (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(20),
      box_choice INTEGER NOT NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      won BOOLEAN DEFAULT FALSE,
      is_winner BOOLEAN DEFAULT FALSE,
      prize_location VARCHAR(255),
      prize_code VARCHAR(10),
      synced_to_sheets BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_user_id ON participants(user_id);
    CREATE INDEX IF NOT EXISTS idx_synced ON participants(synced_to_sheets);
    CREATE INDEX IF NOT EXISTS idx_email_lower ON participants(LOWER(email));
  `;
  
  try {
    await pool.query(createTableQuery);
    console.log('✅ Database tables initialized');
    
    // Add missing columns if they don't exist (migration)
    try {
      await pool.query('ALTER TABLE participants ADD COLUMN IF NOT EXISTS phone VARCHAR(20)');
      await pool.query('ALTER TABLE participants ADD COLUMN IF NOT EXISTS prize_code VARCHAR(10)');
      console.log('✅ Database columns migrated');
    } catch (migrationError) {
      console.log('⚠️ Column migration skipped (may already exist)');
    }
  } catch (error) {
    console.error('❌ Error creating tables:', error);
  }
}

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
    console.log('✅ Google Sheets connected (backup mode)');
  } catch (error) {
    console.error('⚠️  Google Sheets not available (backup disabled):', error.message);
  }
}

// Background sync queue
let syncQueue = [];
let isSyncing = false;
let sheetRowMap = new Map(); // Maps user_id to sheet row number

// Background job: Sync to Google Sheets every 10 seconds
setInterval(async () => {
  if (isSyncing || !sheetsClient) return;
  
  try {
    isSyncing = true;
    
    // Get unsynced records from database
    const result = await pool.query(
      'SELECT * FROM participants WHERE synced_to_sheets = FALSE ORDER BY created_at ASC LIMIT 50'
    );
    
    if (result.rows.length === 0) {
      isSyncing = false;
      return;
    }
    
    console.log(`📤 Syncing ${result.rows.length} records to Google Sheets...`);
    
    // Get current sheet data to find existing rows
    let existingRows = [];
    try {
      const sheetData = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Sheet1!A:H',
      });
      existingRows = sheetData.data.values || [];
    } catch (error) {
      console.log('No existing sheet data, will create new rows');
    }
    
    // Separate new records from updates
    const newRecords = [];
    const updateRecords = [];
    
    result.rows.forEach(row => {
      // Find if this user_id already exists in the sheet
      const existingRowIndex = existingRows.findIndex(sheetRow => sheetRow[1] === row.user_id);
      
      if (existingRowIndex === -1) {
        // New record - add to append batch
        newRecords.push(row);
      } else {
        // Existing record - add to update batch
        updateRecords.push({ row, sheetRowIndex: existingRowIndex + 1 }); // +1 for 1-based indexing
      }
    });
    
    // Append new records
    if (newRecords.length > 0) {
      const values = newRecords.map(row => [
        row.timestamp.toISOString(),
        row.user_id,
        row.email,
        row.phone || '',
        row.box_choice,
        row.won ? 'TRUE' : 'FALSE',
        row.prize_location || '',
        row.prize_code || ''
      ]);
      
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Sheet1!A:H',
        valueInputOption: 'USER_ENTERED',
        resource: { values }
      });
      
      console.log(`✅ Appended ${newRecords.length} new records`);
    }
    
    // Update existing records
    if (updateRecords.length > 0) {
      const updates = updateRecords.map(({ row, sheetRowIndex }) => ({
        range: `Sheet1!F${sheetRowIndex}:H${sheetRowIndex}`,
        values: [[
          row.won ? 'TRUE' : 'FALSE',
          row.prize_location || '',
          row.prize_code || ''
        ]]
      }));
      
      await sheetsClient.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          valueInputOption: 'USER_ENTERED',
          data: updates
        }
      });
      
      console.log(`✅ Updated ${updateRecords.length} existing records`);
    }
    
    // Mark all as synced
    const userIds = result.rows.map(row => row.user_id);
    await pool.query(
      'UPDATE participants SET synced_to_sheets = TRUE WHERE user_id = ANY($1)',
      [userIds]
    );
    
    console.log(`✅ Synced ${result.rows.length} total records to Google Sheets`);
    
  } catch (error) {
    console.error('❌ Error syncing to Sheets:', error.message);
  } finally {
    isSyncing = false;
  }
}, 10000); // Run every 10 seconds

// Game State (now just for active game, not storage)
let gameState = {
  correctBox: null,
  revealed: false,
  activeConnections: new Map(), // socketId -> email
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
    const { email, phone, boxChoice } = data;
    const userId = socket.id;
    const timestamp = new Date();
    
    console.log(`Guess received: ${email} (${phone}) chose Box ${boxChoice}`);
    
    try {
      // Check if this email has already been used
      const existingEmail = await pool.query(
        'SELECT user_id, email FROM participants WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [email]
      );
      
      if (existingEmail.rows.length > 0 && existingEmail.rows[0].user_id !== userId) {
        // This email is already used by a different user
        console.log(`Email already used: ${email}`);
        socket.emit('guessConfirmed', { 
          success: false, 
          error: 'This email address has already been used. Please use a different email.' 
        });
        return;
      }
      
      // Write to PostgreSQL (PRIMARY - fast!)
      await pool.query(
        `INSERT INTO participants (user_id, email, phone, box_choice, timestamp)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE 
         SET email = $2, phone = $3, box_choice = $4, timestamp = $5`,
        [userId, email, phone, boxChoice, timestamp]
      );
      
      // Track active connection
      gameState.activeConnections.set(userId, email);
      
      socket.emit('guessConfirmed', { success: true });
      
      // Send stats to controller
      const stats = await getGameStats();
      io.to('controller').emit('statsUpdate', stats);
      
    } catch (error) {
      console.error('Error saving guess:', error);
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
    
    try {
      // Update all participants with correct/incorrect
      // AND mark them as needing re-sync to update Google Sheets
      await pool.query(
        'UPDATE participants SET won = (box_choice = $1), synced_to_sheets = FALSE',
        [correctBox]
      );
      
      // Select winners (10 random from correct guesses) and assign prize codes
      const winnerIdsResult = await pool.query(
        `SELECT user_id FROM participants 
         WHERE box_choice = $1 AND is_winner = FALSE
         ORDER BY RANDOM()
         LIMIT 10`,
        [correctBox]
      );
      
      // Assign prize codes to each winner
      const updatePromises = winnerIdsResult.rows.map((row, index) => {
        return pool.query(
          `UPDATE participants 
           SET is_winner = TRUE, 
               prize_location = $1, 
               prize_code = $2,
               synced_to_sheets = FALSE
           WHERE user_id = $3
           RETURNING user_id, email, phone, timestamp, prize_code`,
          ['Section 101, Gate B', PRIZE_CODES[index], row.user_id]
        );
      });
      
      const winnersResults = await Promise.all(updatePromises);
      const winners = winnersResults.map(result => result.rows[0]);
      gameState.winners = winners;
      
      // Send reveal to videoboard
      io.to('videoboard').emit('showWinner', { correctBox });
      
      // Get all participants to send results
      const allParticipants = await pool.query(
        'SELECT user_id, email, phone, box_choice, won, is_winner, prize_location, prize_code FROM participants'
      );
      
      // Broadcast results to ALL audience members
      // Each client will filter based on their email
      const resultsMap = {};
      allParticipants.rows.forEach(participant => {
        resultsMap[participant.email.toLowerCase()] = {
          won: participant.won,
          correctBox,
          yourChoice: participant.box_choice,
          isWinner: participant.is_winner,
          prizeLocation: participant.is_winner ? participant.prize_location : null,
          prizeCode: participant.is_winner ? participant.prize_code : null
        };
      });
      
      // Send to all audience (they'll filter by their email)
      io.emit('results', { resultsMap, correctBox });
      
      // Send winner list to controller
      const totalCorrect = await pool.query(
        'SELECT COUNT(*) FROM participants WHERE box_choice = $1',
        [correctBox]
      );
      
      io.to('controller').emit('winnersList', {
        winners: winners.map(w => ({
          email: w.email,
          phone: w.phone,
          prizeCode: w.prize_code,
          timestamp: w.timestamp
        })),
        totalCorrect: parseInt(totalCorrect.rows[0].count)
      });
      
    } catch (error) {
      console.error('Error revealing winner:', error);
    }
  });

  // Controller launches the game (starts intro video)
  socket.on('launchGame', () => {
    if (socket.clientType !== 'controller') {
      return; // Only controller can launch
    }
    
    console.log('🚀 LAUNCH: Game started from controller');
    
    // Send launch signal to videoboard
    io.to('videoboard').emit('launchGame');
  });

  // Reset game (for testing)
  socket.on('resetGame', async () => {
    if (socket.clientType !== 'controller') {
      return;
    }
    
    console.log('🔄 Game reset');
    
    try {
      // Archive old data by marking it (don't delete - keep for records)
      // In production, you might want to move to an archive table
      await pool.query('DELETE FROM participants'); // For testing, clear it
      
      gameState = {
        correctBox: null,
        revealed: false,
        activeConnections: new Map(),
        winners: []
      };
      
      io.emit('gameReset');
    } catch (error) {
      console.error('Error resetting game:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    gameState.activeConnections.delete(socket.id);
  });
});

// Helper Functions
async function getGameStats() {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN box_choice = 1 THEN 1 END) as box1,
        COUNT(CASE WHEN box_choice = 2 THEN 1 END) as box2,
        COUNT(CASE WHEN box_choice = 3 THEN 1 END) as box3
      FROM participants
    `);
    
    const stats = result.rows[0];
    return {
      totalParticipants: parseInt(stats.total),
      box1Count: parseInt(stats.box1),
      box2Count: parseInt(stats.box2),
      box3Count: parseInt(stats.box3)
    };
  } catch (error) {
    console.error('Error getting stats:', error);
    return {
      totalParticipants: 0,
      box1Count: 0,
      box2Count: 0,
      box3Count: 0
    };
  }
}

// Health check endpoint
app.get('/', async (req, res) => {
  try {
    const stats = await getGameStats();
    const unsyncedCount = await pool.query(
      'SELECT COUNT(*) FROM participants WHERE synced_to_sheets = FALSE'
    );
    
    res.json({
      status: 'running',
      database: 'postgresql',
      participants: stats.totalParticipants,
      revealed: gameState.revealed,
      correctBox: gameState.correctBox,
      unsyncedToSheets: parseInt(unsyncedCount.rows[0].count),
      sheetsBackupEnabled: !!sheetsClient
    });
  } catch (error) {
    res.json({
      status: 'error',
      error: error.message
    });
  }
});

// Admin endpoint to view all participants (for debugging)
app.get('/admin/participants', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM participants ORDER BY timestamp DESC LIMIT 100'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin endpoint to manually trigger sheets sync
app.post('/admin/sync-sheets', async (req, res) => {
  try {
    if (!sheetsClient) {
      return res.status(400).json({ error: 'Google Sheets not configured' });
    }
    
    // Force a sync
    const result = await pool.query(
      'SELECT * FROM participants WHERE synced_to_sheets = FALSE ORDER BY created_at ASC'
    );
    
    res.json({
      message: 'Sync will run on next cycle',
      pendingRecords: result.rows.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;

async function startServer() {
  await initializeDatabase();
  await initializeSheets();
  
  httpServer.listen(PORT, () => {
    console.log(`🏀 Stadium Game Server running on port ${PORT}`);
    console.log(`📊 Database: PostgreSQL`);
    console.log(`📤 Google Sheets backup: ${sheetsClient ? 'ENABLED' : 'DISABLED'}`);
  });
}

startServer();
