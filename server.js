const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Log incoming API calls
app.use('/api', (req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url} - Body:`, JSON.stringify(req.body));
  next();
});

// Serve built Parent Web Dashboard directly from root URL
const distPath = path.join(__dirname, '../parent-dashboard/dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

// Data Store File Path
const DATA_FILE = path.join(__dirname, 'data_store.json');

// Initialize empty DB structure for real child data
let db = {
  deviceStatus: {
    deviceId: 'child-device',
    childName: 'جهاز الطفل',
    deviceModel: 'بانتظار توصيل هاتف الطفل...',
    androidVersion: '-',
    batteryLevel: 0,
    isCharging: false,
    isOnline: false,
    lastSeen: new Date().toISOString()
  },
  locations: [],
  calls: [],
  appUsage: [],
  webHistory: [],
  blockedRules: {
    websites: [],
    apps: []
  }
};

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Error saving data:', e);
  }
}

// Create HTTP Server & WebSocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcastToParents(type, payload) {
  const message = JSON.stringify({ type, payload });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

wss.on('connection', (ws) => {
  console.log('Parent Dashboard WebSocket connected');
  ws.send(JSON.stringify({ type: 'INIT_STATE', payload: db }));
});

// --- TELEMETRY ROUTES (CALLED BY CHILD ANDROID APP) ---

app.post('/api/telemetry/device-ping', (req, res) => {
  const { deviceId, batteryLevel, isCharging, deviceModel, androidVersion } = req.body;
  db.deviceStatus = {
    ...db.deviceStatus,
    deviceId: deviceId || db.deviceStatus.deviceId,
    batteryLevel: batteryLevel !== undefined ? batteryLevel : db.deviceStatus.batteryLevel,
    isCharging: isCharging !== undefined ? isCharging : db.deviceStatus.isCharging,
    deviceModel: deviceModel || db.deviceStatus.deviceModel,
    androidVersion: androidVersion || db.deviceStatus.androidVersion,
    isOnline: true,
    lastSeen: new Date().toISOString()
  };
  saveData();
  broadcastToParents('DEVICE_STATUS_UPDATE', db.deviceStatus);
  res.json({ status: 'ok', blockedRules: db.blockedRules });
});

app.post('/api/telemetry/location', (req, res) => {
  const { lat, lng, speed, batteryLevel, address } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

  const newLoc = {
    id: db.locations.length + 1,
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    speed: speed || 0,
    address: address || `الموقع الحالي (${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)})`,
    batteryLevel: batteryLevel || db.deviceStatus.batteryLevel,
    timestamp: new Date().toISOString()
  };

  db.locations.unshift(newLoc);
  if (db.locations.length > 500) db.locations.pop();

  db.deviceStatus.lastSeen = newLoc.timestamp;
  db.deviceStatus.isOnline = true;
  saveData();

  broadcastToParents('NEW_LOCATION', newLoc);
  res.json({ status: 'ok' });
});

app.post('/api/telemetry/calls', (req, res) => {
  const { phoneNumber, contactName, type, durationSeconds } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'Missing phoneNumber' });

  const mins = Math.floor((durationSeconds || 0) / 60);
  const secs = (durationSeconds || 0) % 60;
  const durationStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  const newCall = {
    id: db.calls.length + 1,
    phoneNumber,
    contactName: contactName || 'غير معروف',
    type: type || 'INCOMING',
    duration: durationStr,
    durationSeconds: durationSeconds || 0,
    timestamp: new Date().toISOString()
  };

  db.calls.unshift(newCall);
  saveData();

  broadcastToParents('NEW_CALL', newCall);
  res.json({ status: 'ok' });
});

app.post('/api/telemetry/app-usage', (req, res) => {
  const { apps } = req.body;
  if (Array.isArray(apps)) {
    db.appUsage = apps;
    saveData();
    broadcastToParents('APP_USAGE_UPDATE', db.appUsage);
  }
  res.json({ status: 'ok' });
});

app.post('/api/telemetry/web-history', (req, res) => {
  const { url, title, browser } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing URL' });

  const domain = new URL(url).hostname.replace('www.', '');
  const isBlocked = db.blockedRules.websites.some(b => domain.includes(b));

  const newWebItem = {
    id: db.webHistory.length + 1,
    url,
    title: title || domain,
    browser: browser || 'Chrome',
    timestamp: new Date().toISOString(),
    isBlocked
  };

  db.webHistory.unshift(newWebItem);
  saveData();

  broadcastToParents('NEW_WEB_VISIT', newWebItem);
  res.json({ status: 'ok', isBlocked });
});

// --- PARENT DASHBOARD REST API ENDPOINTS ---

app.get('/api/parent/all-data', (req, res) => {
  res.json(db);
});

app.post('/api/parent/clear-data', (req, res) => {
  db.locations = [];
  db.calls = [];
  db.appUsage = [];
  db.webHistory = [];
  saveData();
  broadcastToParents('INIT_STATE', db);
  res.json({ status: 'ok' });
});

app.post('/api/parent/blocked-rules', (req, res) => {
  const { action, type, value } = req.body;
  if (action === 'add' && !db.blockedRules[type].includes(value)) {
    db.blockedRules[type].push(value);
  } else if (action === 'remove') {
    db.blockedRules[type] = db.blockedRules[type].filter(item => item !== value);
  }
  saveData();
  broadcastToParents('BLOCKED_RULES_UPDATE', db.blockedRules);
  res.json({ status: 'ok', blockedRules: db.blockedRules });
});

// Fallback to serve index.html for single-page dashboard app
if (fs.existsSync(distPath)) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// Start Server on 0.0.0.0 (all network interfaces)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Parental Control Backend & UI running on http://0.0.0.0:${PORT}`);
  console.log(`WebSocket Server ready on ws://0.0.0.0:${PORT}`);
});
