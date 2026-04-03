// ============================================================
//  MEDBOT DASHBOARD — Firebase Realtime Database Integration
//  Complete JavaScript — Paste this inside a <script> tag
//  at the BOTTOM of your index.html (before </body>)
// ============================================================

// ──────────────────────────────────────────────────────────────
//  BEFORE PASTING THIS SCRIPT, ADD THESE TWO CDN LINES TO YOUR
//  <head> TAG (or just before this <script> block):
//
//  <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>
//  <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js"></script>
//
//  These load the Firebase SDK from Google's CDN.
//  "compat" version is used so you can write firebase.database()
//  instead of the newer modular syntax — easier for beginners.
// ──────────────────────────────────────────────────────────────


// ════════════════════════════════════════════════════════════
//  SECTION 1 — FIREBASE CONFIGURATION
//
//  How to get these values:
//  1. Go to https://console.firebase.google.com
//  2. Create a project (or open existing)
//  3. Click the gear icon → Project Settings
//  4. Scroll down to "Your apps" → click Web (</>)
//  5. Register app → copy the firebaseConfig object below
// ════════════════════════════════════════════════════════════
const firebaseConfig = {
  apiKey:            "REPLACE_WITH_YOUR_API_KEY",            // ← from Firebase Console
  authDomain:        "REPLACE_WITH_YOUR_AUTH_DOMAIN",        // ← e.g. medbot-xyz.firebaseapp.com
  databaseURL:       "REPLACE_WITH_YOUR_DATABASE_URL",       // ← e.g. https://medbot-xyz-default-rtdb.firebaseio.com
  projectId:         "REPLACE_WITH_YOUR_PROJECT_ID",         // ← e.g. medbot-xyz
  storageBucket:     "REPLACE_WITH_YOUR_STORAGE_BUCKET",     // ← e.g. medbot-xyz.appspot.com
  messagingSenderId: "REPLACE_WITH_YOUR_MESSAGING_SENDER_ID",// ← 12-digit number
  appId:             "REPLACE_WITH_YOUR_APP_ID"              // ← starts with "1:..."
};

// Initialize Firebase — this must run before anything else
firebase.initializeApp(firebaseConfig);

// Get the Realtime Database instance — we'll use this everywhere
const db = firebase.database();


// ════════════════════════════════════════════════════════════
//  SECTION 2 — DATABASE PATH CONSTANTS
//
//  These are the paths (like folders) inside your Firebase
//  Realtime Database. You can rename them, but keep them
//  consistent with what your ESP32 firmware also uses.
//
//  Expected Firebase database tree structure:
//
//  medbot/
//  ├── vitals/
//  │   ├── P001/
//  │   │   ├── hr:   75          ← ESP32 writes here
//  │   │   └── spo2: 98.5        ← ESP32 writes here
//  │   └── P002/
//  │       ├── hr:   80
//  │       └── spo2: 97.0
//  ├── robot/
//  │   ├── direction: "F"        ← Dashboard writes, ESP32 reads
//  │   ├── speed:     5
//  │   └── timestamp: 1718000000
//  ├── audio/
//  │   ├── speaker:    true      ← Dashboard writes, ESP32 reads
//  │   └── microphone: false
//  ├── buzzer/
//  │   ├── active:    true       ← Dashboard writes, ESP32 reads
//  │   └── timestamp: 1718000000
//  ├── camera/
//  │   ├── ip:        "192.168.1.20"
//  │   └── connected: true
//  ├── patients/
//  │   └── P001/
//  │       ├── name:       "Ravi Kumar"
//  │       ├── age:        34
//  │       ├── gender:     "Male"
//  │       ├── email:      "ravi@gmail.com"
//  │       ├── bed:        "Ward A · Bed 1"
//  │       ├── ward:       "Ward A"
//  │       └── riskStatus: "NORMAL"
//  ├── settings/
//  │   ├── refreshRateSeconds: 2
//  │   ├── hrWarningThreshold: 110
//  │   └── spo2AlertThreshold: 94
//  └── server/
//      └── ip: "192.168.1.5:5000"
// ════════════════════════════════════════════════════════════
const DB_PATHS = {
  vitals:   "medbot/vitals",     // ← REPLACE if your ESP32 uses a different path
  robot:    "medbot/robot",      // ← REPLACE to match your ESP32 listener path
  audio:    "medbot/audio",      // ← REPLACE to match your ESP32 I2S audio path
  buzzer:   "medbot/buzzer",     // ← REPLACE to match your ESP32 buzzer path
  camera:   "medbot/camera",     // ← REPLACE if using a different cam path
  patients: "medbot/patients",   // ← REPLACE if you store patients elsewhere
  settings: "medbot/settings",   // ← REPLACE if you rename this
  server:   "medbot/server"      // ← REPLACE if you rename this
};


// ════════════════════════════════════════════════════════════
//  SECTION 3 — DOCTOR LOGIN CREDENTIALS
//
//  For a real hospital deployment, replace this with
//  Firebase Authentication (Email/Password method).
//  This simple object is fine for demos and testing.
//
//  To add more doctors: add more "DOCID": "password" lines.
// ════════════════════════════════════════════════════════════
const VALID_DOCTORS = {
  "DOC001": "medbot2024",   // ← REPLACE with your Doctor ID and password
  "DOC002": "nurse5678"     // ← Add or remove entries as needed
};


// ════════════════════════════════════════════════════════════
//  SECTION 4 — GLOBAL STATE VARIABLES
//  These track runtime state of the dashboard in memory.
// ════════════════════════════════════════════════════════════

let activePatientId  = "P001";  // Which patient is shown on the Home tab
let hrHistory        = [];       // Rolling array of last 30 HR readings (for Z-score)
let spo2History      = [];       // Rolling array of last 30 SpO₂ readings
let hrBaseline       = null;     // Calculated baseline HR (set after 10 readings)
let spo2Baseline     = null;     // Calculated baseline SpO₂
let hrChartObj       = null;     // Chart.js sparkline for heart rate
let spo2ChartObj     = null;     // Chart.js sparkline for SpO₂
let vitalsListener   = null;     // Firebase off-reference for vitals listener
let patientsListener = null;     // Firebase off-reference for patients listener
let spkOn    = false;            // Is speaker currently ON?
let micOn    = false;            // Is microphone currently ON?
let micStream = null;            // MediaStream from browser getUserMedia API
let joystickActive = false;      // Is the joystick currently being dragged?
let currentDir     = 'S';        // Current robot direction (S = stop)


// ════════════════════════════════════════════════════════════
//  SECTION 5 — LOGIN & LOGOUT
// ════════════════════════════════════════════════════════════

/**
 * doLogin() — Validates doctor credentials and starts dashboard.
 * Called when "SECURE LOGIN" button is clicked.
 */
function doLogin() {
  const id  = document.getElementById('doctorID').value.trim();
  const pw  = document.getElementById('doctorPass').value;
  const err = document.getElementById('loginError');

  // Validate fields are not empty
  if (!id || !pw) {
    err.textContent = 'Please enter both Doctor ID and password.';
    return;
  }

  // Check credentials against our VALID_DOCTORS map
  if (VALID_DOCTORS[id] && VALID_DOCTORS[id] === pw) {
    document.getElementById('loginOverlay').style.display = 'none'; // Hide login screen
    initDashboard(); // Start everything
  } else {
    err.textContent = '⚠ Invalid Doctor ID or password.';
    document.getElementById('doctorPass').value = ''; // Clear wrong password for security
  }
}

/**
 * doLogout() — Cleans up all listeners and shows login screen.
 * Called when "Logout" button is clicked.
 */
function doLogout() {
  if (!confirm('Log out of MedBot Dashboard?')) return;

  // ── Detach Firebase real-time listeners to stop all data sync
  // Using .off() stops the listener from firing on future changes
  if (vitalsListener) {
    db.ref(`${DB_PATHS.vitals}/${activePatientId}`).off('value', vitalsListener);
    vitalsListener = null;
  }
  if (patientsListener) {
    db.ref(DB_PATHS.patients).off('value', patientsListener);
    patientsListener = null;
  }

  // ── Destroy Chart.js instances (frees memory)
  if (hrChartObj)   { hrChartObj.destroy();   hrChartObj   = null; }
  if (spo2ChartObj) { spo2ChartObj.destroy(); spo2ChartObj = null; }

  // ── Reset all state arrays and baselines
  hrHistory    = [];
  spo2History  = [];
  hrBaseline   = null;
  spo2Baseline = null;

  // ── Reset all vitals display elements to default "—" state
  document.getElementById('hrVal').textContent   = '—';
  document.getElementById('spo2Val').textContent = '—';
  document.getElementById('hrBase').textContent  = '';
  document.getElementById('spo2Base').textContent = '';
  document.getElementById('hrConnect').style.display   = 'block';
  document.getElementById('spo2Connect').style.display = 'block';

  // ── Clear login form and show login overlay
  document.getElementById('doctorID').value        = '';
  document.getElementById('doctorPass').value      = '';
  document.getElementById('loginError').textContent = '';
  document.getElementById('loginOverlay').style.display = 'flex';
}

// Allow pressing Enter in the password field to submit login
document.getElementById('doctorPass')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});


// ════════════════════════════════════════════════════════════
//  SECTION 6 — TAB NAVIGATION
// ════════════════════════════════════════════════════════════

/**
 * switchTab() — Shows one tab panel and hides the others.
 * @param {string}      name - Tab name: 'home' | 'patients' | 'help' | 'settings'
 * @param {HTMLElement} btn  - The clicked <button> element (to mark as active)
 */
function switchTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
}


// ════════════════════════════════════════════════════════════
//  SECTION 7 — CHART.JS SPARKLINES
// ════════════════════════════════════════════════════════════

/**
 * makeLineChart() — Creates a gradient sparkline chart.
 * @param {string} canvasId - The <canvas> element ID in HTML
 * @param {string} color    - Hex color string (e.g. '#ff4060')
 * @returns {Chart}           A Chart.js instance
 */
function makeLineChart(canvasId, color) {
  const ctx  = document.getElementById(canvasId).getContext('2d');

  // Create a vertical gradient fill under the line
  const grad = ctx.createLinearGradient(0, 0, 0, 80);
  grad.addColorStop(0, color + '55'); // Top = semi-transparent color
  grad.addColorStop(1, color + '00'); // Bottom = fully transparent

  return new Chart(ctx, {
    type: 'line',
    data: {
      labels:   Array(30).fill(''),       // 30 empty labels (no x-axis text)
      datasets: [{
        data:            Array(30).fill(null), // Start with 30 empty points
        borderColor:     color,
        borderWidth:     2,
        backgroundColor: grad,
        fill:            true,
        tension:         0.4,             // Smooth curve (0 = straight lines)
        pointRadius:     0,               // No dots on data points
        pointHoverRadius: 0
      }]
    },
    options: {
      animation:        { duration: 200 },
      responsive:       true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales:  { x: { display: false }, y: { display: false, grace: '5%' } }
    }
  });
}

/**
 * pushChart() — Adds a new value to a chart, keeping only the last 30.
 * @param {Chart}  chartObj - The Chart.js instance
 * @param {number} val      - New numeric value to add
 */
function pushChart(chartObj, val) {
  const ds = chartObj.data.datasets[0];
  ds.data.push(val);
  if (ds.data.length > 30) ds.data.shift(); // Drop the oldest value
  chartObj.update('none');                  // Redraw instantly (no animation delay)
}


// ════════════════════════════════════════════════════════════
//  SECTION 8 — SVG GAUGE (AI Risk Meter)
// ════════════════════════════════════════════════════════════

/**
 * setGauge() — Updates the semicircular gauge SVG to reflect a risk score.
 * Score 0–33 = green (safe), 34–66 = yellow (warn), 67–100 = red (danger).
 * @param {number} score - Risk score, 0 to 100
 */
function setGauge(score) {
  const pct      = Math.min(Math.max(score, 0), 100) / 100; // Clamp 0–1
  const sweepDeg = pct * 180;                                 // Gauge covers 180°
  const endAngle = (180 - sweepDeg) * Math.PI / 180;         // Convert to radians

  // Calculate the arc endpoint on the SVG circle
  const ex = 110 + 90 * Math.cos(endAngle); // X coordinate
  const ey = 110 - 90 * Math.sin(endAngle); // Y coordinate
  const large = sweepDeg > 180 ? 1 : 0;     // SVG large-arc-flag

  // Choose color based on risk level
  const color = score < 34 ? '#00e5a0'  // Green = safe
              : score < 67 ? '#ffb700'  // Yellow = warning
              :               '#ff4060'; // Red = danger

  // Update the filled arc path
  const arc = document.getElementById('gaugeArc');
  arc.setAttribute('d', `M 20 110 A 90 90 0 ${large} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`);
  arc.setAttribute('stroke', color);

  // Move the needle to point to the current score
  const nX = 110 + 78 * Math.cos(endAngle);
  const nY = 110 - 78 * Math.sin(endAngle);
  document.getElementById('gaugeNeedle').setAttribute('x2', nX.toFixed(2));
  document.getElementById('gaugeNeedle').setAttribute('y2', nY.toFixed(2));

  // Update the numeric score label below the gauge
  document.getElementById('gaugeLabelVal').childNodes[0].textContent =
    score === 0 ? '—' : Math.round(score);
}


// ════════════════════════════════════════════════════════════
//  SECTION 9 — STATISTICS HELPERS
// ════════════════════════════════════════════════════════════

/** mean() — Returns the average of a numeric array */
function mean(arr) {
  return arr.reduce((acc, val) => acc + val, 0) / arr.length;
}

/** std() — Returns the standard deviation of a numeric array */
function std(arr) {
  const avg = mean(arr);
  return Math.sqrt(arr.reduce((acc, val) => acc + (val - avg) ** 2, 0) / arr.length);
}


// ════════════════════════════════════════════════════════════
//  SECTION 10 — AI RISK ASSESSMENT ENGINE
//
//  How Z-score based anomaly detection works:
//  - Z-score = (current value - historical mean) / std deviation
//  - Z-score > 2 = moderately unusual → WARNING
//  - Z-score > 3 = extremely unusual  → DANGER
//  - Also checks hard thresholds (HR too high, SpO₂ too low)
// ════════════════════════════════════════════════════════════

/**
 * updateRisk() — Runs AI risk logic and updates the dashboard.
 * @param {number} hr   - Current heart rate (bpm)
 * @param {number} spo2 - Current SpO₂ (%)
 */
function updateRisk(hr, spo2) {
  // Calculate Z-scores (only meaningful after 5+ readings in history)
  const hrZN   = hrHistory.length   > 5
    ? (hr   - mean(hrHistory))   / (std(hrHistory)   || 1)
    : 0;
  const spo2ZN = spo2History.length > 5
    ? (spo2 - mean(spo2History)) / (std(spo2History) || 1)
    : 0;

  // Display Z-scores in the AI stats boxes
  document.getElementById('hrZ').textContent   = hrHistory.length   > 5 ? hrZN.toFixed(2)   : '—';
  document.getElementById('spo2Z').textContent = spo2History.length > 5 ? spo2ZN.toFixed(2) : '—';

  // Read alert thresholds from Settings tab inputs
  // These can be changed by the doctor in real-time
  const hrThr   = parseInt(document.getElementById('hrThresh')?.value   || 110); // Default: 110 bpm
  const spo2Thr = parseInt(document.getElementById('spo2Thresh')?.value || 94);  // Default: 94%

  // Grab UI elements we'll update
  const badge   = document.getElementById('riskBadge');
  const lbl     = document.getElementById('riskLabel');
  const anomEl  = document.getElementById('anomaly');
  const aiCard  = document.getElementById('aiCard');
  const confLbl = document.getElementById('confLabel');

  const hrDev   = Math.abs(hrZN);
  const spo2Dev = Math.abs(spo2ZN);
  let score = 0; // Risk score 0–100 for the gauge

  // ── DANGER CONDITION ──────────────────────────────────────
  // HR above threshold, OR SpO₂ below threshold, OR extreme Z-scores
  if (hr > hrThr || spo2 < spo2Thr || hrDev > 3 || spo2Dev > 3) {
    badge.className    = 'risk-badge danger';
    lbl.textContent    = 'DANGER';
    anomEl.textContent = 'Yes';
    anomEl.style.color = 'var(--danger)';
    aiCard.classList.add('danger-pulse');     // Adds red pulsing glow to card border
    confLbl.textContent = 'Confidence — HIGH';
    score = 75 + Math.min(hrDev, 3) * 8;    // Score range: 75–99

    // Auto-buzzer: sound buzzer automatically if enabled in settings
    if (document.getElementById('autoBuzzer')?.checked) soundBuzzer();

    // Write DANGER trigger to Firebase — ESP32 will read this and buzz
    db.ref(DB_PATHS.buzzer).set({
      active:    true,
      reason:    'auto_danger_detected',      // ← Useful for audit logs
      timestamp: Date.now()
    }).catch(err => console.error('Buzzer write error:', err));

  // ── WARNING CONDITION ──────────────────────────────────────
  // Approaching threshold or moderately unusual Z-scores
  } else if (hr > hrThr - 10 || spo2 < spo2Thr + 2 || hrDev > 2 || spo2Dev > 2) {
    badge.className    = 'risk-badge warning';
    lbl.textContent    = 'WARNING';
    anomEl.textContent = 'Maybe';
    anomEl.style.color = 'var(--warn)';
    aiCard.classList.remove('danger-pulse');
    confLbl.textContent = 'Confidence — MEDIUM';
    score = 40 + Math.min(hrDev, 2) * 10;  // Score range: 40–60

  // ── NORMAL CONDITION ───────────────────────────────────────
  // Everything within safe range
  } else {
    badge.className    = 'risk-badge normal';
    lbl.textContent    = 'NORMAL';
    anomEl.textContent = 'No';
    anomEl.style.color = 'var(--text2)';
    aiCard.classList.remove('danger-pulse');
    confLbl.textContent = 'Confidence — LOW RISK';
    score = Math.max(5, hrDev * 8 + spo2Dev * 6); // Score range: 5–30

    // Clear buzzer state in Firebase (patient is safe)
    db.ref(DB_PATHS.buzzer).update({ active: false })
      .catch(err => console.error('Buzzer clear error:', err));
  }

  // Update the gauge SVG with calculated score
  setGauge(Math.min(score, 100));

  // Update the status badge in the Patients List tab
  const status = lbl.textContent; // 'NORMAL', 'WARNING', or 'DANGER'
  const p1s = document.getElementById('p1status');
  if (p1s) {
    p1s.textContent = status;
    p1s.style.color = status === 'NORMAL'  ? 'var(--accent)'
                    : status === 'WARNING' ? 'var(--warn)'
                    : 'var(--danger)';
  }

  // Write the computed risk status back to this patient's Firebase node
  // ESP32 or nurses' app can read this to know the patient's current condition
  db.ref(`${DB_PATHS.patients}/${activePatientId}/riskStatus`).set(status)
    .catch(err => console.error('Risk status write error:', err));
}

/**
 * pushReading() — Processes one incoming HR+SpO₂ pair from Firebase.
 * Updates all display elements: big numbers, charts, baseline, risk.
 * @param {number} hr   - Heart rate value from ESP32
 * @param {number} spo2 - SpO₂ value from ESP32
 */
function pushReading(hr, spo2) {
  // Update the large vital value displays
  document.getElementById('hrVal').textContent   = hr;
  document.getElementById('spo2Val').textContent = parseFloat(spo2).toFixed(1);

  // Hide the "Awaiting sensor data..." blinking message
  document.getElementById('hrConnect').style.display   = 'none';
  document.getElementById('spo2Connect').style.display = 'none';

  // Mirror values in the Patients List tab card
  const p1hr   = document.getElementById('p1hr');
  const p1spo2 = document.getElementById('p1spo2');
  if (p1hr)   p1hr.textContent   = hr;
  if (p1spo2) p1spo2.textContent = parseFloat(spo2).toFixed(1);

  // Push to the rolling sparkline charts
  pushChart(hrChartObj,   hr);
  pushChart(spo2ChartObj, spo2);

  // Add to history arrays (keep only last 30 readings)
  hrHistory.push(hr);
  spo2History.push(spo2);
  if (hrHistory.length   > 30) hrHistory.shift();   // Remove oldest reading
  if (spo2History.length > 30) spo2History.shift();

  // After 10 stable readings, lock in a baseline for this patient
  if (hrHistory.length >= 10 && !hrBaseline) {
    hrBaseline   = mean(hrHistory).toFixed(0);
    spo2Baseline = mean(spo2History).toFixed(1);
    document.getElementById('hrBase').textContent   = `Baseline: ${hrBaseline} bpm`;
    document.getElementById('spo2Base').textContent = `Baseline: ${spo2Baseline}%`;
  }

  // Run the AI risk assessment with the new values
  updateRisk(hr, spo2);
}


// ════════════════════════════════════════════════════════════
//  SECTION 11 — FIREBASE VITALS LISTENER
//
//  This is the core of the real-time connection.
//  Firebase fires this callback every time the ESP32 writes
//  a new reading to: medbot/vitals/{patientId}
//
//  Your ESP32 Arduino code should do something like:
//    Firebase.setFloat(fbdo, "/medbot/vitals/P001/hr",   heartRate);
//    Firebase.setFloat(fbdo, "/medbot/vitals/P001/spo2", spO2);
// ════════════════════════════════════════════════════════════

/**
 * listenToVitals() — Attaches a real-time Firebase listener for a patient.
 * @param {string} patientId - Patient ID to listen to (e.g. 'P001')
 */
function listenToVitals(patientId) {
  // Detach previous listener before attaching a new one
  // (Important when switching between patients)
  if (vitalsListener) {
    db.ref(`${DB_PATHS.vitals}/${activePatientId}`).off('value', vitalsListener);
  }

  const vitalsRef = db.ref(`${DB_PATHS.vitals}/${patientId}`);
  // ↑ REPLACE: if your ESP32 writes to a different path, update DB_PATHS.vitals

  // .on('value') fires immediately with current DB state,
  // then fires again every time the data changes
  vitalsListener = vitalsRef.on('value', (snapshot) => {
    const data = snapshot.val(); // null if no data exists yet at this path

    if (data && data.hr !== undefined && data.spo2 !== undefined) {
      // Valid reading received — process it
      pushReading(Number(data.hr), Number(data.spo2));
      updateConnectionStatus('live'); // Show green dot in topbar
    } else {
      // Path exists but no data written yet — wait for ESP32
      document.getElementById('hrConnect').style.display   = 'block';
      document.getElementById('spo2Connect').style.display = 'block';
    }
  },
  (error) => {
    // Firebase security rules denied read, or network error
    console.error('Vitals listener error:', error.message);
    updateConnectionStatus('failed');
  });
}


// ════════════════════════════════════════════════════════════
//  SECTION 12 — FIREBASE PATIENTS LIST LISTENER
//
//  Reads all patient records and renders them in the
//  Patients tab grid. Also populates the active patient's
//  info card in the Home tab.
// ════════════════════════════════════════════════════════════

/**
 * listenToPatients() — Attaches a real-time listener to all patient records.
 */
function listenToPatients() {
  const patientsRef = db.ref(DB_PATHS.patients);
  // ↑ REPLACE DB_PATHS.patients if you store patients elsewhere

  patientsListener = patientsRef.on('value', (snapshot) => {
    const patients = snapshot.val();
    if (!patients) {
      // No patients in database yet — this is fine, just log it
      console.warn('No patient records found in Firebase at:', DB_PATHS.patients);
      return;
    }

    // Populate the active patient's detail card on the Home tab
    const active = patients[activePatientId];
    if (active) {
      document.getElementById('piName').textContent   = active.name   || '—';
      document.getElementById('piID').textContent     = `PID · ${activePatientId}`;
      document.getElementById('piAge').textContent    = active.age    ? `${active.age} yrs` : '—';
      document.getElementById('piGender').textContent = active.gender || '—';
      document.getElementById('piEmail').textContent  = active.email  || '—';
      document.getElementById('piBed').textContent    = active.bed    || '—';
    }

    // Re-render the Patients tab grid with fresh data
    renderPatientsGrid(patients);
  },
  (error) => {
    console.error('Patients listener error:', error.message);
  });
}

/**
 * renderPatientsGrid() — Dynamically builds patient cards in the Patients tab.
 * @param {Object} patients - Key-value object of patient data from Firebase
 */
function renderPatientsGrid(patients) {
  const grid = document.getElementById('patientsGrid');
  if (!grid) return;

  // Remove old patient cards but keep the "Add Patient" button (last element)
  const addBtn = grid.lastElementChild; // Save reference to "Add Patient" button
  while (grid.children.length > 1) grid.removeChild(grid.firstChild);

  // Create a card for each patient in Firebase
  Object.entries(patients).forEach(([pid, p]) => {
    const div = document.createElement('div');
    div.className = 'patient-card-list';

    // Color the status label based on risk level
    const statusColor =
      p.riskStatus === 'DANGER'  ? 'var(--danger)' :
      p.riskStatus === 'WARNING' ? 'var(--warn)'   :
      p.riskStatus === 'NORMAL'  ? 'var(--accent)'
                                 : 'var(--muted)';

    div.innerHTML = `
      <div class="p-id">${pid}</div>
      <div class="p-name">${p.name   || 'Unknown Patient'}</div>
      <div class="p-bed">${p.ward || '—'} · ${p.bed || '—'}</div>
      <div class="patient-vitals">
        <div class="patient-vital">
          <div class="pv-label">HR</div>
          <div class="pv-val" style="color:var(--accent2)">
            ${p.hr ? Number(p.hr).toFixed(0) : '—'}
          </div>
        </div>
        <div class="patient-vital">
          <div class="pv-label">SpO₂</div>
          <div class="pv-val" style="color:var(--accent)">
            ${p.spo2 ? Number(p.spo2).toFixed(1) : '—'}
          </div>
        </div>
        <div class="patient-vital">
          <div class="pv-label">Status</div>
          <div class="pv-val" style="color:${statusColor};font-size:0.78rem">
            ${p.riskStatus || '—'}
          </div>
        </div>
      </div>
    `;

    // Clicking a patient card makes them the active patient
    div.addEventListener('click', () => switchActivePatient(pid));

    // Insert before the "Add Patient" button
    grid.insertBefore(div, addBtn);
  });
}

/**
 * switchActivePatient() — Changes which patient the Home tab monitors.
 * @param {string} patientId - The patient ID to switch to
 */
function switchActivePatient(patientId) {
  activePatientId = patientId;

  // Reset all history and baselines since this is a new patient
  hrHistory    = [];
  spo2History  = [];
  hrBaseline   = null;
  spo2Baseline = null;

  // Show "waiting" state while Firebase sends new patient's data
  document.getElementById('hrVal').textContent    = '—';
  document.getElementById('spo2Val').textContent  = '—';
  document.getElementById('hrBase').textContent   = '';
  document.getElementById('spo2Base').textContent = '';
  document.getElementById('hrConnect').style.display   = 'block';
  document.getElementById('spo2Connect').style.display = 'block';
  setGauge(0); // Reset gauge to zero

  // Attach the Firebase listener to the new patient's vitals path
  listenToVitals(patientId);

  // Navigate to Home tab to view the new patient's data
  const homeBtn = document.querySelector('.tab-btn');
  if (homeBtn) switchTab('home', homeBtn);
}


// ════════════════════════════════════════════════════════════
//  SECTION 13 — CONNECTION STATUS (Topbar Indicator)
// ════════════════════════════════════════════════════════════

/**
 * updateConnectionStatus() — Changes the dot color and label in the topbar.
 * @param {string} status - 'live' | 'connecting' | 'failed'
 */
function updateConnectionStatus(status) {
  const dot   = document.getElementById('simDot');
  const label = document.getElementById('simLabel');

  if (status === 'live') {
    dot.style.background = 'var(--accent)';       // Green dot
    dot.style.boxShadow  = '0 0 8px var(--accent)';
    label.textContent    = 'Firebase Live';
  } else if (status === 'connecting') {
    dot.style.background = 'var(--warn)';          // Yellow dot
    dot.style.boxShadow  = '0 0 8px var(--warn)';
    label.textContent    = 'Connecting...';
  } else {
    dot.style.background = 'var(--danger)';        // Red dot
    dot.style.boxShadow  = '0 0 8px var(--danger)';
    label.textContent    = 'Connection Failed';
  }
}

/**
 * connectServer() — Called when "Connect" button in topbar is clicked.
 * Saves the server IP to Firebase and verifies database connection.
 */
function connectServer() {
  const ip = document.getElementById('serverIP').value.trim();
  updateConnectionStatus('connecting');

  // Save the typed IP to Firebase so other devices (ESP32) can read it
  if (ip) {
    db.ref(`${DB_PATHS.server}/ip`).set(ip) // ← REPLACE path if needed
      .then(() => console.log('Server IP saved to Firebase:', ip))
      .catch(err => console.error('Server IP save failed:', err.message));
  }

  // Monitor the Firebase built-in connection indicator
  // .info/connected is a special path that is true when online
  db.ref('.info/connected').on('value', (snap) => {
    updateConnectionStatus(snap.val() === true ? 'live' : 'failed');
  });
}


// ════════════════════════════════════════════════════════════
//  SECTION 14 — ROBOT CONTROL
//
//  Writes direction + speed to Firebase every time the
//  joystick moves. Your ESP32 should have a Firebase
//  listener on DB_PATHS.robot that calls motor functions.
//
//  ESP32 Arduino code example:
//    if (Firebase.RTDB.getJSON(&fbdo, "/medbot/robot")) {
//      String dir = fbdo.jsonObject()["direction"];
//      int speed  = fbdo.jsonObject()["speed"];
//      // drive motors based on dir
//    }
// ════════════════════════════════════════════════════════════

/**
 * move() — Sends a robot direction command to Firebase.
 * @param {string} dir - Direction: 'F'=forward, 'B'=backward, 'L'=left, 'R'=right, 'S'=stop
 */
function move(dir) {
  const speed = parseInt(document.getElementById('speedSlider').value); // 1–10

  db.ref(DB_PATHS.robot).set({   // ← REPLACE DB_PATHS.robot if using a different path
    direction: dir,               // ESP32 reads this and calls appropriate motor function
    speed:     speed,             // ESP32 maps this to PWM duty cycle (e.g. speed*25 for 0–250)
    timestamp: Date.now()         // Lets ESP32 ignore stale commands older than a few seconds
  }).catch(err => console.error('Robot move error:', err.message));
}

/** stopRobot() — Stops all motors and resets joystick visuals */
function stopRobot() {
  move('S');
  resetKnob();
  joystickActive = false;
  currentDir = 'S';
}

// ─── Joystick Direction Logic ─────────────────────────────

/**
 * getJoystickDir() — Converts drag offset (rx, ry) to a cardinal direction.
 * @param {number} rx     - X offset from joystick center (px)
 * @param {number} ry     - Y offset from joystick center (px)
 * @param {number} radius - Outer joystick radius (px)
 * @returns {string} Direction: 'F' | 'B' | 'L' | 'R' | 'S'
 */
function getJoystickDir(rx, ry, radius) {
  // Dead zone: if drag is less than 25% of radius, treat as STOP
  if (Math.sqrt(rx * rx + ry * ry) < radius * 0.25) return 'S';

  // Convert (rx, ry) to angle in degrees (-180 to +180)
  const angle = Math.atan2(-ry, rx) * 180 / Math.PI;

  if (angle >= -45  && angle < 45)   return 'R'; // Right
  if (angle >= 45   && angle < 135)  return 'F'; // Forward (up on screen)
  if (angle >= 135  || angle < -135) return 'L'; // Left
  return 'B';                                     // Backward (down on screen)
}

/** highlightJoystick() — Lights up the direction arrow in the joystick UI */
function highlightJoystick(dir) {
  // Remove highlight from all four direction icons
  ['jTop', 'jBot', 'jLft', 'jRgt'].forEach(id =>
    document.getElementById(id)?.classList.remove('active')
  );

  // Add highlight to the active direction
  const dirToId = { F: 'jTop', B: 'jBot', L: 'jLft', R: 'jRgt' };
  if (dirToId[dir]) document.getElementById(dirToId[dir])?.classList.add('active');

  // Light up the knob when moving (not stopped)
  document.getElementById('joystickKnob')?.classList.toggle('active', dir !== 'S');
}

/** updateKnobPos() — Moves the joystick knob visually within its boundary */
function updateKnobPos(rx, ry, radius) {
  const dist = Math.sqrt(rx * rx + ry * ry);
  const cap  = Math.min(dist, radius * 0.38) / (dist || 1); // Cap at 38% of radius
  document.getElementById('joystickKnob').style.transform =
    `translate(calc(-50% + ${rx * cap}px), calc(-50% + ${ry * cap}px))`;
}

/** resetKnob() — Returns the joystick knob to center position */
function resetKnob() {
  document.getElementById('joystickKnob').style.transform = 'translate(-50%, -50%)';
  highlightJoystick('S');
}

/** joystickStart() — Handles mouse drag start on the joystick element */
function joystickStart(e) {
  joystickActive = true;
  const rect = document.getElementById('joystickOuter').getBoundingClientRect();
  const cx   = rect.left + rect.width / 2;  // Center X of joystick
  const cy   = rect.top  + rect.height / 2; // Center Y of joystick

  function onMove(me) {
    if (!joystickActive) return;
    const rx  = me.clientX - cx; // Offset from center
    const ry  = me.clientY - cy;
    updateKnobPos(rx, ry, rect.width / 2);
    const dir = getJoystickDir(rx, ry, rect.width / 2);
    if (dir !== currentDir) {
      currentDir = dir;
      move(dir);             // Send to Firebase
      highlightJoystick(dir);
    }
  }

  function onEnd() {
    joystickActive = false;
    currentDir = 'S';
    move('S');               // Send STOP to Firebase when released
    resetKnob();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onEnd);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onEnd);
  onMove(e); // Fire immediately on first click
}

/** joystickTouchStart() — Touch equivalent of joystickStart for mobile */
function joystickTouchStart(e) {
  e.preventDefault(); // Prevent scrolling while dragging joystick
  joystickActive = true;
  const rect = document.getElementById('joystickOuter').getBoundingClientRect();
  const cx   = rect.left + rect.width / 2;
  const cy   = rect.top  + rect.height / 2;

  function onMove(me) {
    if (!joystickActive) return;
    const rx  = me.touches[0].clientX - cx;
    const ry  = me.touches[0].clientY - cy;
    updateKnobPos(rx, ry, rect.width / 2);
    const dir = getJoystickDir(rx, ry, rect.width / 2);
    if (dir !== currentDir) {
      currentDir = dir;
      move(dir);
      highlightJoystick(dir);
    }
  }

  function onEnd() {
    joystickActive = false;
    currentDir = 'S';
    move('S');
    resetKnob();
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend',  onEnd);
  }

  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend',  onEnd);
}

// ─── Keyboard Arrow Key Control ───────────────────────────
document.addEventListener('keydown', e => {
  const dirMap = { ArrowUp: 'F', ArrowDown: 'B', ArrowLeft: 'L', ArrowRight: 'R' };
  if (dirMap[e.key]) {
    e.preventDefault(); // Prevent the page from scrolling with arrow keys
    move(dirMap[e.key]);
    highlightJoystick(dirMap[e.key]);
  }
});

document.addEventListener('keyup', e => {
  // Stop robot when any arrow key is released
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    move('S');
    highlightJoystick('S');
  }
});


// ════════════════════════════════════════════════════════════
//  SECTION 15 — CAMERA FEED (ESP32-CAM)
//
//  Connects to the ESP32-CAM live MJPEG stream.
//  Default port is 81 with the standard CameraWebServer sketch.
//  Also saves/restores the camera IP from Firebase.
// ════════════════════════════════════════════════════════════

/**
 * connectCam() — Starts the ESP32-CAM live stream.
 * The IP typed in the input field is used to build the stream URL.
 */
function connectCam() {
  const ip = document.getElementById('camIP').value.trim();
  if (!ip) return;

  const img = document.getElementById('camStream');
  img.src = `http://${ip}:81/stream`; // ← REPLACE port if your ESP32-CAM uses a different one
  img.style.display = 'block';
  document.getElementById('camNoStream').style.display = 'none';

  // Save camera IP to Firebase so it persists across sessions
  db.ref(DB_PATHS.camera).set({
    ip:        ip,
    connected: true,
    timestamp: Date.now()
  }).catch(err => console.error('Camera IP save error:', err.message));
}

/**
 * disconnectCam() — Stops the stream and clears the video element.
 */
function disconnectCam() {
  const img = document.getElementById('camStream');
  img.src          = ''; // Setting src to empty stops the MJPEG stream
  img.style.display = 'none';
  document.getElementById('camNoStream').style.display = 'flex';

  // Update camera status in Firebase
  db.ref(DB_PATHS.camera).update({ connected: false })
    .catch(err => console.error('Camera disconnect error:', err.message));
}

/**
 * restoreCameraIP() — Loads previously saved camera IP from Firebase
 * and pre-fills the input field on startup.
 */
function restoreCameraIP() {
  // .once('value') reads one time only (not a real-time listener)
  db.ref(DB_PATHS.camera).once('value')
    .then((snapshot) => {
      const data = snapshot.val();
      if (data && data.ip) {
        document.getElementById('camIP').value = data.ip; // Pre-fill the IP input
      }
    })
    .catch(err => console.error('Camera IP restore error:', err.message));
}


// ════════════════════════════════════════════════════════════
//  SECTION 16 — AUDIO CONTROLS (Speaker & Microphone)
//
//  Speaker:    Dashboard tells ESP32 to play audio output
//  Microphone: Browser captures mic audio from user's laptop/phone
//
//  ESP32 should listen to DB_PATHS.audio and activate
//  its I2S speaker/microphone module accordingly.
// ════════════════════════════════════════════════════════════

/**
 * setAudio() — Turns speaker or microphone ON or OFF.
 * Updates UI and writes state to Firebase.
 * @param {string}  type  - 'spk' for speaker, 'mic' for microphone
 * @param {boolean} state - true = ON, false = OFF
 */
function setAudio(type, state) {
  if (type === 'spk') {
    spkOn = state;
    // Update speaker UI elements
    document.getElementById('spkState').textContent = state ? 'ON' : 'OFF';
    document.getElementById('spkState').className   = 'audio-state-badge' + (state ? ' on-spk' : '');
    document.getElementById('spkIcon').className    = state ? 'fas fa-volume-up' : 'fas fa-volume-mute';
    document.getElementById('spkOnBtn').className   = 'btn-audio-on' + (state ? ' active-spk' : '');

  } else { // type === 'mic'
    micOn = state;
    // Update microphone UI elements
    document.getElementById('micState').textContent = state ? 'ON' : 'OFF';
    document.getElementById('micState').className   = 'audio-state-badge' + (state ? ' on-mic' : '');
    document.getElementById('micIcon').className    = state ? 'fas fa-microphone' : 'fas fa-microphone-slash';
    document.getElementById('micOnBtn').className   = 'btn-audio-on' + (state ? ' active-mic' : '');

    if (state) {
      // Request microphone access from the browser
      // Browser will show a permission popup the first time
      navigator.mediaDevices?.getUserMedia({ audio: true })
        .then(stream => {
          micStream = stream; // Store reference to stop it later
          console.log('Microphone access granted');
        })
        .catch(err => {
          console.warn('Microphone access denied by browser:', err.message);
          // Revert UI if mic access was denied
          document.getElementById('micState').textContent = 'DENIED';
          document.getElementById('micOnBtn').className   = 'btn-audio-on';
          micOn = false;
        });
    } else {
      // Stop all audio tracks and release the microphone hardware
      if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
        console.log('Microphone released');
      }
    }
  }

  // Build the update object and write to Firebase
  // ESP32 listens here and activates I2S output/input accordingly
  const update = {};
  update[type === 'spk' ? 'speaker' : 'microphone'] = state;

  db.ref(DB_PATHS.audio).update(update)  // ← REPLACE DB_PATHS.audio if using different path
    .catch(err => console.error('Audio state write error:', err.message));
}


// ════════════════════════════════════════════════════════════
//  SECTION 17 — BUZZER ALERT
//
//  Writes a trigger to Firebase. ESP32 listens and sounds
//  the physical buzzer connected to its GPIO pin.
//
//  ESP32 Arduino example:
//    if (Firebase.RTDB.getBool(&fbdo, "/medbot/buzzer/active")) {
//      bool buzz = fbdo.boolData();
//      digitalWrite(BUZZER_PIN, buzz ? HIGH : LOW);
//    }
// ════════════════════════════════════════════════════════════

/**
 * soundBuzzer() — Manually triggers the alert buzzer.
 * Also called automatically when risk = DANGER and auto-buzzer is on.
 */
function soundBuzzer() {
  const btn = document.getElementById('buzzerBtn');

  // Visual feedback: flash button orange then reset after 1 second
  btn.style.background = 'rgba(255,183,0,0.3)';
  btn.style.boxShadow  = '0 0 24px rgba(255,183,0,0.5)';
  setTimeout(() => {
    btn.style.background = '';
    btn.style.boxShadow  = '';
  }, 1000);

  // Write buzzer trigger to Firebase
  // ↓ REPLACE "medbot/buzzer" if your ESP32 listens on a different path
  db.ref(DB_PATHS.buzzer).set({
    active:      true,
    triggeredBy: 'manual_dashboard',  // Useful for audit/log purposes
    timestamp:   Date.now()
  }).catch(err => console.error('Buzzer trigger error:', err.message));

  // Auto-reset after 3 seconds so the ESP32 buzzer stops automatically
  setTimeout(() => {
    db.ref(DB_PATHS.buzzer).update({ active: false })
      .catch(err => console.error('Buzzer auto-reset error:', err.message));
  }, 3000);
}


// ════════════════════════════════════════════════════════════
//  SECTION 18 — SETTINGS (Persist to Firebase)
//
//  When doctor changes a threshold in the Settings tab,
//  the new value is saved to Firebase and used immediately.
// ════════════════════════════════════════════════════════════

/**
 * saveSettings() — Writes all Settings tab values to Firebase.
 * Called automatically whenever any setting input changes.
 */
function saveSettings() {
  const settings = {
    refreshRateSeconds: parseInt(document.getElementById('refreshRate').value) || 2,
    hrWarningThreshold: parseInt(document.getElementById('hrThresh').value)    || 110,
    spo2AlertThreshold: parseInt(document.getElementById('spo2Thresh').value)  || 94,
    autoBuzzerEnabled:  document.getElementById('autoBuzzer').checked
    // ↑ REPLACE or ADD more fields if you add more setting inputs to the HTML
  };

  db.ref(DB_PATHS.settings).set(settings)
    .catch(err => console.error('Settings save error:', err.message));
}

/**
 * restoreSettings() — Loads saved settings from Firebase on startup.
 * Fills in the Settings tab inputs with the previously saved values.
 */
function restoreSettings() {
  db.ref(DB_PATHS.settings).once('value')
    .then((snapshot) => {
      const s = snapshot.val();
      if (!s) return; // No settings saved yet — use HTML defaults

      // Apply each setting to its input element if it was previously saved
      if (s.refreshRateSeconds !== undefined)
        document.getElementById('refreshRate').value  = s.refreshRateSeconds;
      if (s.hrWarningThreshold !== undefined)
        document.getElementById('hrThresh').value     = s.hrWarningThreshold;
      if (s.spo2AlertThreshold !== undefined)
        document.getElementById('spo2Thresh').value   = s.spo2AlertThreshold;
      if (s.autoBuzzerEnabled  !== undefined)
        document.getElementById('autoBuzzer').checked = s.autoBuzzerEnabled;
    })
    .catch(err => console.error('Settings restore error:', err.message));
}

// Auto-save whenever any setting changes (no "Save" button needed)
['refreshRate', 'hrThresh', 'spo2Thresh', 'autoBuzzer'].forEach(inputId => {
  document.getElementById(inputId)?.addEventListener('change', saveSettings);
});


// ════════════════════════════════════════════════════════════
//  SECTION 19 — DASHBOARD INITIALIZATION
//  This is called exactly once after a successful login.
//  It sets up all charts, listeners, and restores saved data.
// ════════════════════════════════════════════════════════════

/**
 * initDashboard() — Entry point for the dashboard after login.
 * Initializes charts, starts Firebase listeners, restores saved values.
 */
function initDashboard() {
  // ── Set today's date dynamically in the patient info card
  const today = new Date();
  document.getElementById('piDate').textContent =
    today.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  // ── Initialize Chart.js sparklines
  hrChartObj   = makeLineChart('hrChart',   '#ff4060'); // Red sparkline for Heart Rate
  spo2ChartObj = makeLineChart('spo2Chart', '#00e5a0'); // Green sparkline for SpO₂

  // ── Set gauge to zero/idle on startup
  setGauge(0);

  // ── Show "Connecting..." state in topbar while Firebase initializes
  updateConnectionStatus('connecting');

  // ── Monitor Firebase real-time connection state (built-in path)
  // .info/connected is true when online, false when offline
  db.ref('.info/connected').on('value', (snapshot) => {
    updateConnectionStatus(snapshot.val() === true ? 'live' : 'failed');
  });

  // ── Start the main data listener for vitals (HR & SpO₂)
  listenToVitals(activePatientId);

  // ── Start the patients list listener (for Patients tab)
  listenToPatients();

  // ── Restore saved settings from Firebase
  restoreSettings();

  // ── Restore previously entered camera IP from Firebase
  restoreCameraIP();

  // ── Restore previously entered server IP from Firebase (if saved)
  db.ref(`${DB_PATHS.server}/ip`).once('value')
    .then((snapshot) => {
      if (snapshot.val()) {
        document.getElementById('serverIP').value = snapshot.val();
      }
    })
    .catch(err => console.error('Server IP restore error:', err.message));
}
