// ================================================================
//  medbot_firebase.js  —  MedBot Dashboard · Project PRAKALP
//  Firebase Compat SDK v10  |  No imports needed — SDK loaded in HTML
// ================================================================
//
//  WHAT THIS FILE DOES (section by section):
//  1.  Firebase config + initialization
//  2.  Login / Logout
//  3.  Tab switching
//  4.  Dashboard startup (called once after login)
//  5.  Firebase connection status indicator
//  6.  Chart.js setup for HR and SpO₂
//  7.  Live vitals listener  →  patients/p1/live/
//  8.  Patient info listener →  patients/p1/info/
//  9.  Patients-tab card updater
//  10. AI Risk Assessment  (Z-score + gauge animation)
//  11. Buzzer button       →  Commands/robot/buzzer
//  12. Robot joystick      →  Commands/robot/
//  13. Keyboard arrow keys →  Commands/robot/
//  14. Speed slider        →  Commands/robot/speed
//  15. Camera feed (ESP32-CAM stream)
//  16. Speaker / Microphone toggles  →  Commands/audio/
//  17. Topbar "Connect" button
// ================================================================


// ── 1. FIREBASE CONFIG & INITIALIZATION ─────────────────────────
//
// WHY: These 7 values identify YOUR specific Firebase project.
//      Without them the SDK doesn't know which database to connect to.
//
const firebaseConfig = {
  apiKey           : "AIzaSyCWx1wzzQ19LO72uKg5mnZwcMJMcYVSSRk",
  authDomain       : "medbot-b8077.firebaseapp.com",
  databaseURL      : "https://medbot-b8077-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId        : "medbot-b8077",
  storageBucket    : "medbot-b8077.firebasestorage.app",
  messagingSenderId: "762532076786",
  appId            : "1:762532076786:web:c0ba31ef8819b01abc446b"
};

// Initialize Firebase and get a reference to the Realtime Database
firebase.initializeApp(firebaseConfig);
const db = firebase.database();


// ── GLOBAL STATE ─────────────────────────────────────────────────
let isLoggedIn       = false;
let joystickActive   = false;
let currentDirection = 'stop';   // tracks last sent robot command
let speakerOn        = false;
let micOn            = false;

// Chart.js chart instances (created in initCharts)
let hrChartInstance   = null;
let spo2ChartInstance = null;

// Rolling data for the live charts (last MAX_POINTS readings)
const MAX_POINTS = 20;
const hrData   = { labels: [], values: [] };
const spo2Data = { labels: [], values: [] };

// Rolling data for Z-score statistics (last Z_WINDOW readings)
const Z_WINDOW    = 15;
const hrRolling   = [];
const spo2Rolling = [];


// ================================================================
//  2. LOGIN / LOGOUT
// ================================================================
//
// WHY: The login overlay is displayed by default in the HTML.
//      doLogin() validates credentials and then hides the overlay,
//      revealing the dashboard and starting all Firebase listeners.
//
function doLogin() {
  const id   = document.getElementById('doctorID').value.trim();
  const pass = document.getElementById('doctorPass').value;
  const err  = document.getElementById('loginError');

  // Hardcoded demo credentials — replace with Firebase Auth later
  if (id === 'DOC001' && pass === 'medbot2024') {
    err.textContent = '';
    document.getElementById('loginOverlay').style.display = 'none';
    isLoggedIn = true;
    initDashboard(); // ← everything starts here after login
  } else {
    err.textContent = '✖  Invalid credentials. Try DOC001 / medbot2024';
  }
}

function doLogout() {
  // Show login screen again and reset state
  document.getElementById('loginOverlay').style.display = 'flex';
  isLoggedIn = false;
  // Stop robot on logout for safety
  sendRobotCommand('stop');
}


// ================================================================
//  3. TAB SWITCHING
// ================================================================
//
// WHY: The HTML has tab-panel divs that are hidden by default.
//      switchTab() shows the selected one and highlights its button.
//
function switchTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
}


// ================================================================
//  4. DASHBOARD INIT  —  called once immediately after login
// ================================================================
//
// WHY: We only start Firebase listeners AFTER login so we don't
//      waste reads before the user authenticates.
//
function initDashboard() {
  initCharts();           // build Chart.js instances
  watchConnection();      // watch Firebase online/offline state
  watchLiveVitals();      // listen for ESP32 sensor data
  watchPatientInfo();     // listen for patient profile fields
  loadSavedCamIP();       // pre-fill camera IP from Firebase
  initJoystick();         // wire up joystick drag events
  initKeyboard();         // wire up arrow-key robot control
  initSpeedSlider();      // wire up speed slider → Firebase
}


// ================================================================
//  5. FIREBASE CONNECTION STATUS INDICATOR
// ================================================================
//
// WHY: Firebase has a special path ".info/connected" that becomes
//      true when the SDK has a live connection and false when offline.
//      We use this to update the green/red dot in the topbar.
//
function watchConnection() {
  db.ref('.info/connected').on('value', (snap) => {
    const online = snap.val() === true;
    const dot    = document.getElementById('simDot');
    const label  = document.getElementById('simLabel');

    if (online) {
      dot.style.background = 'var(--accent)';     // green
      dot.style.boxShadow  = '0 0 8px var(--accent)';
      label.textContent    = 'Firebase Live';
    } else {
      dot.style.background = 'var(--danger)';     // red
      dot.style.boxShadow  = '0 0 8px var(--danger)';
      label.textContent    = 'Reconnecting...';
    }
  });
}


// ================================================================
//  6. CHART.JS SETUP
// ================================================================
//
// WHY: Chart.js needs a canvas element and a config object to draw.
//      We create two separate line chart instances — one for HR
//      (red) and one for SpO₂ (green) — using the canvas IDs
//      already present in your HTML.
//
function initCharts() {
  // Shared options for both charts
  const sharedOptions = {
    responsive        : true,
    maintainAspectRatio: false,
    animation         : { duration: 400 },
    plugins           : { legend: { display: false } },
    scales: {
      x: { display: false },  // hide x-axis labels for clean look
      y: {
        display: true,
        grid    : { color: 'rgba(255,255,255,0.04)' },
        ticks   : { color: '#8090b8', font: { size: 10 }, maxTicksLimit: 4 }
      }
    }
  };

  // Heart Rate chart — red theme
  hrChartInstance = new Chart(
    document.getElementById('hrChart').getContext('2d'),
    {
      type: 'line',
      data: {
        labels  : hrData.labels,
        datasets: [{
          data           : hrData.values,
          borderColor    : 'rgba(255,64,96,0.85)',
          backgroundColor: 'rgba(255,64,96,0.08)',
          borderWidth    : 2,
          pointRadius    : 0,   // no dots on line — cleaner look
          tension        : 0.4, // smooth curve
          fill           : true
        }]
      },
      options: sharedOptions
    }
  );

  // SpO₂ chart — green theme
  spo2ChartInstance = new Chart(
    document.getElementById('spo2Chart').getContext('2d'),
    {
      type: 'line',
      data: {
        labels  : spo2Data.labels,
        datasets: [{
          data           : spo2Data.values,
          borderColor    : 'rgba(0,229,160,0.85)',
          backgroundColor: 'rgba(0,229,160,0.08)',
          borderWidth    : 2,
          pointRadius    : 0,
          tension        : 0.4,
          fill           : true
        }]
      },
      options: sharedOptions
    }
  );
}

// Add one data point to a rolling chart, then re-render it
function pushChartPoint(store, chart, label, value, max) {
  store.labels.push(label);
  store.values.push(value);
  // Remove oldest point once we exceed the display window
  if (store.labels.length > max) {
    store.labels.shift();
    store.values.shift();
  }
  chart.update();
}

// Add one value to a rolling statistics window
function pushRolling(arr, value, max) {
  arr.push(value);
  if (arr.length > max) arr.shift();
}


// ================================================================
//  7. LIVE VITALS LISTENER
// ================================================================
//
// WHY: db.ref('patients/p1/live').on('value', ...) is a REAL-TIME
//      listener. Firebase pushes data to this callback the instant
//      your ESP32 writes a new reading. No polling, no refresh.
//      This is what makes the numbers update live.
//
function watchLiveVitals() {
  db.ref('patients/p1/live').on('value', (snap) => {
    const data = snap.val();
    if (!data) return; // no data yet — wait for ESP32

    // Parse incoming values (support both 'heartRate' and 'hr' field names)
    const hr   = Number(data.heartRate ?? data.hr   ?? 0);
    const spo2 = Number(data.spo2      ?? data.SpO2 ?? 0);
    const time = data.time ?? new Date().toLocaleTimeString();

    // ── Update the big numbers on HR and SpO₂ cards ──────────
    document.getElementById('hrVal').textContent   = hr;
    document.getElementById('spo2Val').textContent = spo2;

    // Hide the "awaiting sensor data" messages
    document.getElementById('hrConnect').style.display   = 'none';
    document.getElementById('spo2Connect').style.display = 'none';

    // ── Read alert thresholds from Settings tab ───────────────
    const hrThresh   = Number(document.getElementById('hrThresh').value)   || 110;
    const spo2Thresh = Number(document.getElementById('spo2Thresh').value) || 94;

    // Show normal range below the big number
    document.getElementById('hrBase').textContent   = `Normal: 60 – ${hrThresh} bpm`;
    document.getElementById('spo2Base').textContent = `Normal: ≥ ${spo2Thresh}%`;

    // ── Update the Patients tab list card for P001 ────────────
    updatePatientListCard(hr, spo2, hrThresh, spo2Thresh);

    // ── Push to rolling chart data ────────────────────────────
    // Use only the time portion of the timestamp string as the label
    const timeLabel = String(time).slice(-8);
    pushChartPoint(hrData,   hrChartInstance,   timeLabel, hr,   MAX_POINTS);
    pushChartPoint(spo2Data, spo2ChartInstance, timeLabel, spo2, MAX_POINTS);

    // ── Update rolling stats arrays for Z-score ───────────────
    pushRolling(hrRolling,   hr,   Z_WINDOW);
    pushRolling(spo2Rolling, spo2, Z_WINDOW);

    // ── Run AI risk assessment ────────────────────────────────
    updateAIRisk(hr, spo2, hrThresh, spo2Thresh);
  });
}


// ================================================================
//  8. PATIENT INFO LISTENER
// ================================================================
//
// WHY: The patient card on the Home tab shows name, age, gender etc.
//      These come from patients/p1/info/ — a separate node from vitals.
//      When Firebase has this data, we hide the "awaiting" skeleton
//      and show the actual patient profile.
//
function watchPatientInfo() {
  db.ref('patients/p1/info').on('value', (snap) => {
    const info = snap.val();

    // If no info node exists yet, leave the skeleton/awaiting view
    if (!info) return;

    // Helper: if value is empty string or missing, show a dash instead
    const val = (v) => (v !== undefined && v !== null && String(v).trim() !== '') ? v : '—';

    // Fill in every field in the patient card
    document.getElementById('piName').textContent   = val(info.name);
    document.getElementById('piID').textContent     = 'Patient · P001';
    document.getElementById('piAge').textContent    = val(info.age);
    document.getElementById('piGender').textContent = val(info.gender);
    document.getElementById('piEmail').textContent  = val(info.email);
    document.getElementById('piDate').textContent   = val(info.date ?? info.admissionDate);
    document.getElementById('piBed').textContent    = val(info.bed);

    // Switch from skeleton/awaiting state → active patient display
    document.getElementById('patientAwaiting').style.display      = 'none';
    document.getElementById('patientOfflineStatus').style.display = 'none';
    document.getElementById('patientActive').style.display        = 'flex';
  });
}


// ================================================================
//  9. PATIENTS TAB — update the P001 vitals card
// ================================================================
//
// WHY: The Patients tab has small cards showing HR, SpO₂, and
//      status for each patient. We update p1's card every time
//      a new live reading comes in.
//
function updatePatientListCard(hr, spo2, hrThresh, spo2Thresh) {
  document.getElementById('p1hr').textContent   = hr;
  document.getElementById('p1spo2').textContent = spo2 + '%';

  // Classify status
  let status = 'NORMAL';
  let color  = 'var(--accent)'; // green

  if (hr > hrThresh || spo2 < spo2Thresh) {
    status = 'CRITICAL';
    color  = 'var(--danger)'; // red
  } else if (hr > 100 || spo2 < 96) {
    status = 'WARNING';
    color  = 'var(--warn)';   // yellow
  }

  const el        = document.getElementById('p1status');
  el.textContent  = status;
  el.style.color  = color;
}


// ================================================================
//  10. AI RISK ASSESSMENT
// ================================================================
//
// WHY: A raw HR number alone doesn't tell you much without context.
//      Z-score measures HOW FAR the current value has deviated from
//      the patient's own recent history. Z > 2 = warning, Z > 3 = danger.
//      This catches slow drift that threshold rules would miss.
//
function updateAIRisk(hr, spo2, hrThresh, spo2Thresh) {
  const hrZ   = calcZScore(hr,   hrRolling);
  const spo2Z = calcZScore(spo2, spo2Rolling);

  // Show Z-scores in the stats row
  document.getElementById('hrZ').textContent   = hrZ.toFixed(2);
  document.getElementById('spo2Z').textContent = spo2Z.toFixed(2);

  // Risk score: map max Z-score (0–3) linearly onto 0–100
  const maxZ      = Math.max(hrZ, spo2Z);
  const riskScore = Math.min(100, Math.round((maxZ / 3) * 100));

  // Animate the SVG gauge
  updateGauge(riskScore);

  // Update the risk badge, confidence label, and anomaly text
  const badge     = document.getElementById('riskBadge');
  const riskLabel = document.getElementById('riskLabel');
  const confLabel = document.getElementById('confLabel');
  const anomaly   = document.getElementById('anomaly');
  const aiCard    = document.getElementById('aiCard');

  // Also consider hard threshold violations regardless of Z-score
  const thresholdBreach = (hr > hrThresh || spo2 < spo2Thresh);

  // Reset badge class before setting new one
  badge.className = 'risk-badge ';

  if (maxZ >= 2 || thresholdBreach) {
    // ── DANGER ───────────────────────────────────────────────
    badge.className      += 'danger';
    riskLabel.textContent = 'HIGH RISK';
    confLabel.textContent = `Z-score: ${maxZ.toFixed(2)} — Significant anomaly detected`;
    anomaly.textContent   = 'YES';
    anomaly.style.color   = 'var(--danger)';
    aiCard.classList.add('danger-pulse');
    // Trigger auto-buzzer if the setting is enabled
    if (document.getElementById('autoBuzzer').checked) {
      soundBuzzer();
    }

  } else if (maxZ >= 1) {
    // ── WARNING ──────────────────────────────────────────────
    badge.className      += 'warning';
    riskLabel.textContent = 'ELEVATED';
    confLabel.textContent = `Z-score: ${maxZ.toFixed(2)} — Mild deviation, monitor closely`;
    anomaly.textContent   = 'MILD';
    anomaly.style.color   = 'var(--warn)';
    aiCard.classList.remove('danger-pulse');

  } else {
    // ── NORMAL ───────────────────────────────────────────────
    badge.className      += 'normal';
    riskLabel.textContent = 'NORMAL';
    confLabel.textContent = `Z-score: ${maxZ.toFixed(2)} — All vitals within acceptable range`;
    anomaly.textContent   = 'NO';
    anomaly.style.color   = 'var(--accent)';
    aiCard.classList.remove('danger-pulse');
  }
}

// Calculate how many standard deviations the current value is
// from the mean of the recent rolling window.
// Returns 0 if there is not enough data yet.
function calcZScore(value, history) {
  if (history.length < 3) return 0;
  const mean     = history.reduce((a, b) => a + b, 0) / history.length;
  const variance = history.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / history.length;
  const stddev   = Math.sqrt(variance);
  if (stddev < 0.01) return 0; // flat signal — no meaningful deviation
  return Math.abs((value - mean) / stddev);
}

// Animate the SVG semicircle gauge and its needle.
// score: 0 (safe / left) → 100 (danger / right)
function updateGauge(score) {
  const s   = Math.min(100, Math.max(0, score));
  // Angle: 180° at score=0 (left), 0° at score=100 (right)
  const rad = (1 - s / 100) * Math.PI;

  const ex = 110 + 90 * Math.cos(rad); // arc endpoint X
  const ey = 110 - 90 * Math.sin(rad); // arc endpoint Y
  const nx = 110 + 80 * Math.cos(rad); // needle tip X (slightly shorter)
  const ny = 110 - 80 * Math.sin(rad); // needle tip Y

  // Color zones: green → yellow → red
  const arcColor = s > 66 ? 'var(--danger)' : s > 33 ? 'var(--warn)' : 'var(--accent)';

  // Build SVG arc path. Avoid degenerate path when score ≈ 0
  const arcD = s < 1
    ? 'M 20 110 A 90 90 0 0 1 20.5 109.7'
    : `M 20 110 A 90 90 0 0 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;

  document.getElementById('gaugeArc').setAttribute('d', arcD);
  document.getElementById('gaugeArc').setAttribute('stroke', arcColor);
  document.getElementById('gaugeNeedle').setAttribute('x2', nx.toFixed(2));
  document.getElementById('gaugeNeedle').setAttribute('y2', ny.toFixed(2));
  document.getElementById('gaugeLabelVal').innerHTML = `${s}<small>RISK SCORE</small>`;
}


// ================================================================
//  11. BUZZER
// ================================================================
//
// WHY: Writes a buzzer:true flag to Firebase. The ESP32 watches this
//      path and activates the physical buzzer when it becomes true.
//      We reset it to false after 2 seconds automatically.
//
function soundBuzzer() {
  db.ref('Commands/robot/buzzer').set(true);

  // Visual feedback on the button
  const btn = document.getElementById('buzzerBtn');
  btn.style.background = 'rgba(255,183,0,0.35)';
  btn.style.boxShadow  = '0 0 24px rgba(255,183,0,0.5)';

  setTimeout(() => {
    btn.style.background = '';
    btn.style.boxShadow  = '';
    db.ref('Commands/robot/buzzer').set(false); // auto-reset
  }, 2000);
}


// ================================================================
//  12. ROBOT JOYSTICK
// ================================================================
//
// WHY: The joystick is a draggable UI element. As the user drags it,
//      we calculate the angle of the drag to determine direction
//      (forward/backward/left/right), then write that to Firebase.
//      The ESP32 reads Commands/robot/ and drives the motors.
//
//      We only write to Firebase when the direction CHANGES — not on
//      every pixel of movement. This avoids hitting Firebase rate limits.
//

function initJoystick() {
  // Mouse and touch event listeners are added dynamically below.
  // This function exists so initDashboard() has a consistent call to make.
}

// Called by onmousedown on the joystick div in HTML
function joystickStart(e) {
  e.preventDefault();
  joystickActive = true;
  document.addEventListener('mousemove', joystickMove);
  document.addEventListener('mouseup',   joystickEnd);
  joystickMove(e); // process the initial press position immediately
}

// Called by ontouchstart on the joystick div in HTML
function joystickTouchStart(e) {
  e.preventDefault();
  joystickActive = true;
  document.addEventListener('touchmove', joystickTouchMove, { passive: false });
  document.addEventListener('touchend',  joystickTouchEnd);
  if (e.touches[0]) joystickProcess(e.touches[0].clientX, e.touches[0].clientY);
}

function joystickMove(e) {
  if (!joystickActive) return;
  joystickProcess(e.clientX, e.clientY);
}

function joystickTouchMove(e) {
  e.preventDefault();
  if (!joystickActive || !e.touches[0]) return;
  joystickProcess(e.touches[0].clientX, e.touches[0].clientY);
}

// Core joystick logic: convert drag position → direction → Firebase
function joystickProcess(clientX, clientY) {
  const outer = document.getElementById('joystickOuter');
  const rect  = outer.getBoundingClientRect();
  const cx    = rect.left + rect.width  / 2;
  const cy    = rect.top  + rect.height / 2;
  const dx    = clientX - cx;
  const dy    = clientY - cy;
  const dist  = Math.sqrt(dx * dx + dy * dy);
  const maxR  = 50; // max pixels the knob can move from center

  // Clamp the knob visually to the edge of the circle
  const cX = dist > maxR ? (dx / dist) * maxR : dx;
  const cY = dist > maxR ? (dy / dist) * maxR : dy;

  const knob = document.getElementById('joystickKnob');
  knob.style.transform = `translate(calc(-50% + ${cX}px), calc(-50% + ${cY}px))`;
  knob.classList.add('active');

  // Dead zone: if drag is tiny, treat as STOP (avoids jitter)
  let dir = 'stop';
  if (dist > 20) {
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    // Divide the circle into 4 quadrants
    if      (angle > -45  && angle <=  45)  dir = 'right';
    else if (angle > 45   && angle <= 135)  dir = 'backward';
    else if (angle > 135  || angle <= -135) dir = 'left';
    else                                    dir = 'forward';
  }

  // Highlight the active direction arrow in the joystick UI
  ['jTop', 'jBot', 'jLft', 'jRgt'].forEach(id =>
    document.getElementById(id).classList.remove('active'));
  const zoneMap = { forward: 'jTop', backward: 'jBot', left: 'jLft', right: 'jRgt' };
  if (zoneMap[dir]) document.getElementById(zoneMap[dir]).classList.add('active');

  // Only send to Firebase when direction actually changes (rate limiting)
  if (dir !== currentDirection) {
    currentDirection = dir;
    sendRobotCommand(dir);
  }
}

// Clean up when the mouse / touch is released
function joystickEnd() {
  joystickActive = false;
  document.removeEventListener('mousemove', joystickMove);
  document.removeEventListener('mouseup',   joystickEnd);
  resetJoystick();
}

function joystickTouchEnd() {
  joystickActive = false;
  document.removeEventListener('touchmove', joystickTouchMove);
  document.removeEventListener('touchend',  joystickTouchEnd);
  resetJoystick();
}

// Return knob to center and send STOP command
function resetJoystick() {
  const knob = document.getElementById('joystickKnob');
  knob.style.transform = 'translate(-50%, -50%)';
  knob.classList.remove('active');
  ['jTop', 'jBot', 'jLft', 'jRgt'].forEach(id =>
    document.getElementById(id).classList.remove('active'));
  stopRobot();
}

// Called by the STOP button in the HTML
function stopRobot() {
  currentDirection = 'stop';
  sendRobotCommand('stop');
}

// Write direction + speed + timestamp to Commands/robot/ in Firebase
function sendRobotCommand(direction) {
  const speed = Number(document.getElementById('speedSlider').value) || 5;
  db.ref('Commands/robot').update({
    direction : direction,
    speed     : speed,
    timestamp : Date.now()  // ESP32 uses this to detect stale commands
  });
}


// ================================================================
//  13. KEYBOARD ARROW-KEY CONTROL
// ================================================================
//
// WHY: Gives the operator an alternative to the joystick.
//      Arrow keys map directly to robot directions.
//      Releasing a key sends STOP.
//
function initKeyboard() {
  const arrowMap = {
    ArrowUp   : 'forward',
    ArrowDown : 'backward',
    ArrowLeft : 'left',
    ArrowRight: 'right'
  };

  document.addEventListener('keydown', (e) => {
    if (arrowMap[e.key]) {
      e.preventDefault(); // stop page from scrolling
      if (arrowMap[e.key] !== currentDirection) {
        currentDirection = arrowMap[e.key];
        sendRobotCommand(arrowMap[e.key]);
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    if (arrowMap[e.key]) {
      stopRobot();
    }
  });
}


// ================================================================
//  14. SPEED SLIDER
// ================================================================
//
// WHY: The slider controls motor speed (1–10). If the robot is
//      currently moving we update Firebase immediately so the ESP32
//      can adjust PWM in real-time without waiting for the next
//      direction command.
//
function initSpeedSlider() {
  document.getElementById('speedSlider').addEventListener('input', function () {
    document.getElementById('speedVal').textContent = this.value;
    if (currentDirection !== 'stop') {
      // Live-update speed in Firebase while robot is moving
      db.ref('Commands/robot/speed').set(Number(this.value));
    }
  });
}


// ================================================================
//  15. CAMERA FEED (ESP32-CAM)
// ================================================================
//
// WHY: The ESP32-CAM runs a tiny web server that streams MJPEG video.
//      We set the stream URL as the src of an <img> tag — the browser
//      knows how to display MJPEG streams natively.
//
//      IMPORTANT: This only works if your laptop and ESP32-CAM are
//      on the SAME WiFi network.
//

function connectCam() {
  const ip = document.getElementById('camIP').value.trim();
  if (!ip) {
    alert('Please enter the ESP32-CAM IP address first.');
    return;
  }

  // Standard ESP32-CAM stream endpoint
  const streamURL = `http://${ip}/stream`;

  const img      = document.getElementById('camStream');
  const noStream = document.getElementById('camNoStream');

  img.src               = streamURL;
  img.style.display     = 'block';
  noStream.style.display = 'none';

  // Save IP to Firebase so it auto-loads next time
  db.ref('devices/cam/ip').set(ip);
}

function disconnectCam() {
  const img      = document.getElementById('camStream');
  const noStream = document.getElementById('camNoStream');

  img.src               = '';
  img.style.display     = 'none';
  noStream.style.display = 'flex';
}

// On login, read the last-saved camera IP from Firebase and pre-fill the input
function loadSavedCamIP() {
  db.ref('devices/cam/ip').once('value', (snap) => {
    const ip = snap.val();
    if (ip && ip !== '0.0.0.0') {
      document.getElementById('camIP').value = ip;
    }
  });
}


// ================================================================
//  16. AUDIO — Speaker and Microphone toggles
// ================================================================
//
// WHY: Toggling speaker or mic writes a command to Firebase.
//      The ESP32 watches Commands/audio/ and activates the
//      corresponding hardware (speaker module / mic circuit).
//
function setAudio(device, on) {
  if (device === 'spk') {
    speakerOn = on;
    const badge = document.getElementById('spkState');
    const icon  = document.getElementById('spkIcon');
    const btn   = document.getElementById('spkOnBtn');

    badge.textContent = on ? 'ON' : 'OFF';
    badge.className   = 'audio-state-badge' + (on ? ' on-spk' : '');
    icon.className    = on ? 'fas fa-volume-up' : 'fas fa-volume-mute';
    btn.className     = 'btn-audio-on'         + (on ? ' active-spk' : '');

    db.ref('Commands/audio/speaker').set(on);

  } else if (device === 'mic') {
    micOn = on;
    const badge = document.getElementById('micState');
    const icon  = document.getElementById('micIcon');
    const btn   = document.getElementById('micOnBtn');

    badge.textContent = on ? 'ON' : 'OFF';
    badge.className   = 'audio-state-badge' + (on ? ' on-mic' : '');
    icon.className    = on ? 'fas fa-microphone' : 'fas fa-microphone-slash';
    btn.className     = 'btn-audio-on'          + (on ? ' active-mic' : '');

    db.ref('Commands/audio/mic').set(on);
  }
}


// ================================================================
//  17. TOPBAR "CONNECT SERVER" BUTTON
// ================================================================
//
// WHY: The topbar has a server-IP input and Connect button — likely
//      intended for a future Flask/local server. Since we now use
//      Firebase directly, this button just confirms the connection.
//
function connectServer() {
  document.getElementById('simLabel').textContent = 'Using Firebase ✓';
}


// ================================================================
//  END OF medbot_firebase.js
// ================================================================
//
//  NEXT STEPS:
//  - Add a second patient (p2) by duplicating the watchLiveVitals
//    and watchPatientInfo calls with the p2 path
//  - Replace the hardcoded DOC001 login with Firebase Authentication
//    for proper security before any real hospital use
//  - Add a logs chart section by reading patients/p1/logs/ with
//    db.ref('patients/p1/logs').limitToLast(50).once('value', ...)
//
