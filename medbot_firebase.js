// ================================================================
//  medbot_firebase.js  —  MedBot Dashboard · Project PRAKALP  v2.0
//  Firebase Compat SDK v10  |  Load Firebase SDKs in HTML first
// ================================================================
//
//  SECTION MAP
//  1.  Firebase config + initialization        (REPLACE PLACEHOLDERS)
//  2.  Global constants & state
//  3.  Login / Logout
//  4.  Tab switching
//  5.  Dashboard init  (called once after login)
//  6.  Firebase connection watcher
//  7.  Chart.js setup for HR and SpO₂
//  8.  Active patient watcher  →  Commands/activePatient
//  9.  Vitals listener          →  vitals/{patientId}/
//  10. Patient info listener    →  patients/{patientId}/
//  11. PDF report listener      →  reports/{patientId}/pdfUrl
//  12. Patients-list table builder
//  13. Open patient PDF report
//  14. AI risk assessment  (Z-score + segmented meter)
//  15. Add New Patient modal
//  16. Robot joystick
//  17. Keyboard arrow-key control
//  18. Speed slider
//  19. Camera feed (ESP32-CAM)
//  20. Audio  (Speaker / Microphone toggles)
//  21. Settings helpers
// ================================================================


// ── 1. FIREBASE CONFIG ───────────────────────────────────────────
//
//  Your project credentials — replace if you rotate keys.
//  Firebase Console → Project Settings → Your Apps → SDK setup.
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

// Wrapped in try-catch: a Firebase init error must never block the login UI
let db = null, storage = null;
try {
  firebase.initializeApp(firebaseConfig);
  db      = firebase.database();
  storage = firebase.storage();
} catch (e) {
  console.error('Firebase init failed:', e.message);
}


// ── 2. GLOBAL CONSTANTS & STATE ──────────────────────────────────

// Alert thresholds — no longer buried in settings inputs
const HR_THRESHOLD   = 110;   // bpm — alert if HR > this
const SPO2_THRESHOLD = 94;    // %   — alert if SpO₂ < this

// Charts
const MAX_POINTS = 20;
const hrData     = { labels: [], values: [] };
const spo2Data   = { labels: [], values: [] };
let hrChartInstance   = null;
let spo2ChartInstance = null;

// Z-score rolling window
const Z_WINDOW    = 15;
const hrRolling   = [];
const spo2Rolling = [];

// App state
let isLoggedIn          = false;
let loggedInDoctorId    = '';
let activePatientId     = 'p1';      // from Commands/activePatient
let notificationsEnabled = false;

// Per-patient PDF URL cache: { patientId: url }
const pdfUrlCache = {};
// Track which patients already have a report listener attached
const reportListeners = {};

// Firebase refs for detach-able listeners
let vitalsRef  = null;
let infoRef    = null;

// Robot state
let joystickActive   = false;
let currentDirection = 'stop';
let speakerOn        = false;
let micOn            = false;


// ================================================================
//  3. LOGIN / LOGOUT
// ================================================================

function doLogin() {
  const id   = document.getElementById('doctorID').value.trim();
  const pass = document.getElementById('doctorPass').value;
  const err  = document.getElementById('loginError');

  if (!id || !pass) {
    err.textContent = '⚠  Please enter both Doctor ID and password.';
    return;
  }

  // Hardcoded demo credentials — replace with Firebase Auth for production
  if (id === 'DOC001' && pass === 'admin123') {
    err.textContent    = '';
    loggedInDoctorId   = id;
    isLoggedIn         = true;
    document.getElementById('loginOverlay').style.display = 'none';
    initDashboard();
  } else {
    err.textContent = '✖  Invalid credentials.';
    document.getElementById('doctorPass').value = '';
  }
}

function doLogout() {
  if (!confirm('Log out of MedBot Dashboard?')) return;
  // Send STOP before leaving
  sendRobotCommand('stop');
  isLoggedIn = false;

  // Clear form
  document.getElementById('doctorID').value          = '';
  document.getElementById('doctorPass').value        = '';
  document.getElementById('loginError').textContent  = '';
  document.getElementById('loginOverlay').style.display = 'flex';
}


// ================================================================
//  4. TAB SWITCHING
// ================================================================

function switchTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
}


// ================================================================
//  5. DASHBOARD INIT
// ================================================================

function initDashboard() {
  initCharts();
  initJoystick();
  initKeyboard();
  initSpeedSlider();
  initAdminProfile();

  // Guard: only start Firebase listeners if db initialized successfully
  if (!db) {
    console.warn('Firebase unavailable — UI-only mode active.');
    return;
  }
  watchConnection();
  watchActivePatient();
  watchPatientsList();
  loadSavedCamIP();
}


// ================================================================
//  6. FIREBASE CONNECTION WATCHER
// ================================================================
//
//  Firebase exposes a special .info/connected boolean that flips
//  the instant the SDK gains or loses its real-time connection.
//  We mirror this to both the topbar dot AND the Settings sync badge.
//

function watchConnection() {
  db.ref('.info/connected').on('value', snap => {
    const online = snap.val() === true;

    // Topbar indicator
    const dot   = document.getElementById('simDot');
    const label = document.getElementById('simLabel');
    dot.style.background = online ? 'var(--accent)' : 'var(--danger)';
    dot.style.boxShadow  = online ? '0 0 8px var(--accent)' : '0 0 8px var(--danger)';
    label.textContent    = online ? 'Firebase Live' : 'Reconnecting...';

    // Settings tab sync badge
    const syncDot   = document.getElementById('syncDot');
    const syncLabel = document.getElementById('syncLabel');
    if (syncDot && syncLabel) {
      syncDot.style.background = online ? 'var(--accent)' : 'var(--danger)';
      syncLabel.textContent    = online ? 'Connected · Real-time' : 'Disconnected';
    }
  });
}


// ================================================================
//  7. CHART.JS SETUP
// ================================================================

function initCharts() {
  const shared = {
    responsive           : true,
    maintainAspectRatio  : false,
    animation            : { duration: 400 },
    plugins              : { legend: { display: false } },
    scales: {
      x: { display: false },
      y: {
        grid   : { color: 'rgba(255,255,255,0.04)' },
        ticks  : { color: '#8090b8', font: { size: 10 }, maxTicksLimit: 4 }
      }
    }
  };

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
          pointRadius    : 0,
          tension        : 0.4,
          fill           : true
        }]
      },
      options: shared
    }
  );

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
      options: shared
    }
  );
}

// Append one data point; trim to MAX_POINTS; re-render
function pushChartPoint(store, chart, label, value, max) {
  store.labels.push(label);
  store.values.push(value);
  if (store.labels.length > max) { store.labels.shift(); store.values.shift(); }
  chart.update();
}

// Append value to rolling statistics window
function pushRolling(arr, value, max) {
  arr.push(value);
  if (arr.length > max) arr.shift();
}


// ================================================================
//  8. ACTIVE PATIENT WATCHER
// ================================================================
//
//  WHY: Commands/activePatient holds the current patient ID the robot
//  is monitoring (e.g. "p1"). When this changes (operator switches
//  patient), we detach old listeners and attach new ones so the
//  dashboard always shows the correct patient's data.
//

function watchActivePatient() {
  db.ref('Commands/activePatient').on('value', snap => {
    const pid = snap.val() || 'p1';

    // Detach stale listeners
    if (vitalsRef) vitalsRef.off('value');
    if (infoRef)   infoRef.off('value');

    activePatientId = pid;

    // Attach listeners for new active patient
    vitalsRef = db.ref(`vitals/${pid}`);
    vitalsRef.on('value', handleVitals);

    infoRef = db.ref(`patients/${pid}`);
    infoRef.on('value', handlePatientInfo);

    // Ensure PDF listener is running for this patient too
    watchPatientReport(pid);

    // Update the active patient label in robot card
    const el = document.getElementById('activePatientLabel');
    if (el) el.textContent = pid.toUpperCase();
  });
}


// ================================================================
//  9. VITALS LISTENER  →  vitals/{patientId}/
// ================================================================
//
//  Firebase Schema:
//    vitals/{patientId}/
//      hr        : number   (heart rate, bpm)
//      spo2      : number   (oxygen saturation, %)
//      timestamp : number   (Unix ms from ESP32)
//
//  Supports old field names (heartRate, SpO2) for backwards compat.
//

function handleVitals(snap) {
  const data = snap.val();
  if (!data) return;

  const hr   = Number(data.hr   ?? data.heartRate ?? 0);
  const spo2 = Number(data.spo2 ?? data.SpO2      ?? 0);
  const ts   = data.timestamp
    ? new Date(data.timestamp).toLocaleTimeString()
    : new Date().toLocaleTimeString();

  // ── Update big number displays ──────────────────────────────
  if (hr > 0) {
    document.getElementById('hrVal').textContent = hr;
    document.getElementById('hrConnect').style.display = 'none';
  }
  if (spo2 > 0) {
    document.getElementById('spo2Val').textContent = spo2;
    document.getElementById('spo2Connect').style.display = 'none';
  }

  document.getElementById('hrBase').textContent   = `Normal: 60 – ${HR_THRESHOLD} bpm`;
  document.getElementById('spo2Base').textContent = `Normal: ≥ ${SPO2_THRESHOLD}%`;

  // ── Push to rolling chart ────────────────────────────────────
  const label = String(ts).slice(-8);
  if (hr   > 0) pushChartPoint(hrData,   hrChartInstance,   label, hr,   MAX_POINTS);
  if (spo2 > 0) pushChartPoint(spo2Data, spo2ChartInstance, label, spo2, MAX_POINTS);

  // ── Push to Z-score window ───────────────────────────────────
  if (hr   > 0) pushRolling(hrRolling,   hr,   Z_WINDOW);
  if (spo2 > 0) pushRolling(spo2Rolling, spo2, Z_WINDOW);

  // ── AI Risk Assessment ───────────────────────────────────────
  if (hr > 0 && spo2 > 0) updateAIRisk(hr, spo2);
}


// ================================================================
//  10. PATIENT INFO LISTENER  →  patients/{patientId}/
// ================================================================
//
//  Firebase Schema:
//    patients/{patientId}/
//      name      : string
//      age       : number
//      gender    : string
//      email     : string
//      createdAt : number  (Unix ms timestamp)
//

function handlePatientInfo(snap) {
  const info = snap.val();
  if (!info) return;

  const val = v =>
    (v !== undefined && v !== null && String(v).trim() !== '') ? v : '—';

  document.getElementById('piName').textContent   = val(info.name);
  document.getElementById('piID').textContent     = `Patient · ${activePatientId.toUpperCase()}`;
  document.getElementById('piAge').textContent    = val(info.age);
  document.getElementById('piGender').textContent = val(info.gender);
  document.getElementById('piEmail').textContent  = val(info.email);
  document.getElementById('piDate').textContent   = info.createdAt
    ? new Date(info.createdAt).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })
    : val(info.date ?? info.admissionDate);

  // Switch skeleton → active view
  document.getElementById('patientAwaiting').style.display      = 'none';
  document.getElementById('patientOfflineStatus').style.display = 'none';
  document.getElementById('patientActive').style.display        = 'flex';
}


// ================================================================
//  11. PDF REPORT LISTENER  →  reports/{patientId}/pdfUrl
// ================================================================
//
//  HOW IT WORKS:
//  1.  Backend (Python / any service) generates a PDF, uploads it to
//      Firebase Storage, retrieves the download URL, and writes:
//        reports/{patientId}/pdfUrl = "<firebase_storage_download_url>"
//
//  2.  This listener fires the instant that write happens (no refresh).
//      It stores the latest URL in pdfUrlCache[patientId].
//
//  3.  When user clicks "View Report" for a patient, openPatientReport()
//      reads from pdfUrlCache — always the freshest URL, never stale.
//
//  DO NOT:  hardcode URLs · cache on page load only · fetch just once
//

function watchPatientReport(patientId) {
  // Avoid attaching duplicate listeners
  if (reportListeners[patientId]) return;
  reportListeners[patientId] = true;

  db.ref(`reports/${patientId}`).on('value', snap => {
    const data = snap.val();
    if (data && data.pdfUrl) {
      // Always overwrite with newest URL
      pdfUrlCache[patientId] = data.pdfUrl;
    }
  });
}


// ================================================================
//  12. PATIENTS LIST TABLE
// ================================================================
//
//  Reads the entire patients/ node in real-time. Renders a table row
//  for each patient (S.No, Patient ID, Name, View Report button).
//  Also kicks off a report listener for every patient it discovers.
//

function watchPatientsList() {
  db.ref('patients').on('value', snap => {
    renderPatientsTable(snap);
  });
}

function renderPatientsTable(snapshot) {
  const tbody    = document.getElementById('patientsTableBody');
  const countEl  = document.getElementById('patientCount');
  tbody.innerHTML = '';

  if (!snapshot || !snapshot.exists()) {
    tbody.innerHTML = '<tr><td colspan="4" class="table-empty">No patients found in database.</td></tr>';
    if (countEl) countEl.textContent = '0 patients';
    return;
  }

  let serial = 1;
  snapshot.forEach(child => {
    const pid  = child.key;
    const info = child.val() || {};

    // Ensure report listener is running for this patient
    watchPatientReport(pid);

    const tr = document.createElement('tr');
    tr.className = 'patient-row';
    tr.innerHTML = `
      <td class="td-serial">${serial}</td>
      <td class="td-pid">${pid.toUpperCase()}</td>
      <td class="td-name">${info.name || '—'}</td>
      <td class="td-action">
  <button class="btn-view-report" onclick="openPatientReport('${pid}')">
    <i class="fas fa-file-pdf"></i> View Report
  </button>
  <button class="btn-delete-patient" onclick="deletePatient('${pid}')">
    <i class="fas fa-trash-alt"></i> Delete
  </button>
</td>
    `;
    tbody.appendChild(tr);
    serial++;
  });
// ── Delete a patient and all their data from Firebase ────────────
async function deletePatient(patientId) {
  if (!confirm(`Delete patient ${patientId.toUpperCase()} and all their data?\nThis cannot be undone.`)) return;

  try {
    // Remove all data nodes for this patient in parallel
    await Promise.all([
      db.ref(`patients/${patientId}`).remove(),
      db.ref(`vitals/${patientId}`).remove(),
      db.ref(`reports/${patientId}`).remove(),
      db.ref(`patientLogs/${patientId}`).remove()
    ]);

    // If the deleted patient was the active one, clear the dashboard card
    if (patientId === activePatientId) {
      clearPatientDisplay();
    }

  } catch (err) {
    alert(`Failed to delete patient: ${err.message}`);
  }
}
  if (countEl) countEl.textContent = `${serial - 1} patient${serial - 1 !== 1 ? 's' : ''}`;
}


// ================================================================
//  13. OPEN PATIENT PDF REPORT
// ================================================================
//
//  Opens the latest PDF for a patient. Uses the pdfUrlCache that is
//  kept fresh by the real-time listener in watchPatientReport().
//  Falls back to a one-time fetch if the listener hasn't fired yet.
//

function openPatientReport(patientId) {
  const url = pdfUrlCache[patientId];
  if (url) {
    window.open(url, '_blank');
    return;
  }

  // Listener may not have fired yet — fetch once
  db.ref(`reports/${patientId}/pdfUrl`).once('value', snap => {
    const fetched = snap.val();
    if (fetched) {
      pdfUrlCache[patientId] = fetched;
      window.open(fetched, '_blank');
    } else {
      alert(`No report available for patient ${patientId.toUpperCase()} yet.\nAsk the backend to generate one.`);
    }
  });
}


// ================================================================
//  14. AI RISK ASSESSMENT  (Z-score + segmented meter)
// ================================================================
//
//  HOW Z-SCORE WORKS:
//  We track the patient's last Z_WINDOW readings. Z-score measures
//  how far the CURRENT value has drifted from the patient's own
//  recent baseline. This catches slow deterioration that static
//  threshold checks would miss.
//
//  Z > 2 → WARNING  |  Z > 3 (or threshold breach) → DANGER
//

function updateAIRisk(hr, spo2) {
  const hrZ   = calcZScore(hr,   hrRolling);
  const spo2Z = calcZScore(spo2, spo2Rolling);

  document.getElementById('hrZ').textContent   = hrZ.toFixed(2);
  document.getElementById('spo2Z').textContent = spo2Z.toFixed(2);

  const maxZ      = Math.max(hrZ, spo2Z);
  const riskScore = Math.min(100, Math.round((maxZ / 3) * 100));

  // Animate segmented risk meter
  updateRiskMeter(riskScore);
  document.getElementById('riskScore').textContent = riskScore;

  const badge    = document.getElementById('riskBadge');
  const riskLbl  = document.getElementById('riskLabel');
  const confLbl  = document.getElementById('confLabel');
  const anomaly  = document.getElementById('anomaly');
  const aiCard   = document.getElementById('aiCard');
  const threshOk = hr <= HR_THRESHOLD && spo2 >= SPO2_THRESHOLD;

  badge.className = 'risk-badge ';

  if (maxZ >= 2 || !threshOk) {
    badge.className += 'danger';
    riskLbl.textContent = 'HIGH RISK';
    confLbl.textContent = `Z-score: ${maxZ.toFixed(2)} — Significant anomaly detected`;
    anomaly.textContent = 'YES';
    anomaly.style.color = 'var(--danger)';
    aiCard.classList.add('danger-pulse');

    // Browser push notification (if user granted permission)
    if (notificationsEnabled && Notification.permission === 'granted') {
      new Notification('⚠ MedBot Alert', {
        body: `High risk detected for patient ${activePatientId.toUpperCase()}. HR: ${hr} bpm, SpO₂: ${spo2}%`
      });
    }
  } else if (maxZ >= 1) {
    badge.className += 'warning';
    riskLbl.textContent = 'ELEVATED';
    confLbl.textContent = `Z-score: ${maxZ.toFixed(2)} — Mild deviation, monitor closely`;
    anomaly.textContent = 'MILD';
    anomaly.style.color = 'var(--warn)';
    aiCard.classList.remove('danger-pulse');
  } else {
    badge.className += 'normal';
    riskLbl.textContent = 'NORMAL';
    confLbl.textContent = `Z-score: ${maxZ.toFixed(2)} — All vitals within acceptable range`;
    anomaly.textContent = 'NO';
    anomaly.style.color = 'var(--accent)';
    aiCard.classList.remove('danger-pulse');
  }
}

// Standard deviation–based Z-score calculation
function calcZScore(value, history) {
  if (history.length < 3) return 0;
  const mean     = history.reduce((a, b) => a + b, 0) / history.length;
  const variance = history.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / history.length;
  const stddev   = Math.sqrt(variance);
  if (stddev < 0.01) return 0;
  return Math.abs((value - mean) / stddev);
}

// Animate the segmented risk meter bar
// score: 0 (safe) → 100 (critical)
function updateRiskMeter(score) {
  const s    = Math.min(100, Math.max(0, score));
  const fill = document.getElementById('riskFill');
  if (!fill) return;

  fill.style.width = s + '%';

  // Color transitions across zones
  if (s > 66) {
    fill.style.background =
      'linear-gradient(90deg, var(--accent) 0%, var(--warn) 40%, var(--danger) 100%)';
  } else if (s > 33) {
    fill.style.background =
      'linear-gradient(90deg, var(--accent) 0%, var(--warn) 100%)';
  } else {
    fill.style.background = 'var(--accent)';
  }
}


// ================================================================
//  15. ADD NEW PATIENT MODAL
// ================================================================
//
//  FLOW ON SUBMIT:
//  1. Archive current active patient → patientLogs/{oldId}
//  2. Write new patient data → patients/{newId}
//  3. Write vitals placeholder → vitals/{newId}
//  4. Update Commands/activePatient → {newId}
//  5. UI updates automatically via existing listeners
//

function openAddPatientModal() {
  document.getElementById('addPatientModal').style.display = 'flex';
}

function closeAddPatientModal() {
  document.getElementById('addPatientModal').style.display = 'none';
  // Clear form fields
  ['newPatName', 'newPatAge', 'newPatEmail'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const genderEl = document.getElementById('newPatGender');
  if (genderEl) genderEl.selectedIndex = 0;
  document.getElementById('modalError').textContent = '';
}

async function submitAddPatient() {
  const name   = (document.getElementById('newPatName').value  || '').trim();
  const age    = (document.getElementById('newPatAge').value   || '').trim();
  const gender = (document.getElementById('newPatGender').value|| '').trim();
  const email  = (document.getElementById('newPatEmail').value || '').trim();
  const errEl  = document.getElementById('modalError');

  if (!name) { errEl.textContent = '⚠  Name is required.'; return; }
  errEl.textContent = '';

  const submitBtn = document.getElementById('modalSubmitBtn');
  submitBtn.textContent  = 'Saving...';
  submitBtn.disabled     = true;

  try {
    const now          = Date.now();
    const newPatientId = `p${now}`;

    // 1. Archive previous active patient to patientLogs (non-blocking)
    if (activePatientId) {
      const prevSnap = await db.ref(`patients/${activePatientId}`).once('value');
      if (prevSnap.exists()) {
        await db.ref(`patientLogs/${activePatientId}`).set({
          ...prevSnap.val(),
          archivedAt: now
        });
      }
    }

    // 2. Write new patient profile
    await db.ref(`patients/${newPatientId}`).set({
      name,
      age        : age ? Number(age) : null,
      gender     : gender || null,
      email      : email  || null,
      createdAt  : now
    });

    // 3. Initialize empty vitals node so listeners don't error
    await db.ref(`vitals/${newPatientId}`).set({
      hr       : 0,
      spo2     : 0,
      timestamp: now
    });

    // 4. Make new patient the active patient for the robot + dashboard
    await db.ref('Commands/activePatient').set(newPatientId);

    closeAddPatientModal();
  } catch (err) {
    errEl.textContent = `⚠  Error: ${err.message}`;
  } finally {
    submitBtn.textContent = 'Add Patient';
    submitBtn.disabled    = false;
  }
}


// ================================================================
//  16. ROBOT JOYSTICK
// ================================================================
//
//  Drag position is converted to a direction angle, then written
//  to Commands/robot/ in Firebase. The ESP32 reads and drives motors.
//  Only writes on DIRECTION CHANGE to stay within Firebase rate limits.
//

function initJoystick() {
  // All listeners are attached inline via joystickStart / joystickTouchStart
  // (called from HTML onmousedown / ontouchstart)
}

function joystickStart(e) {
  e.preventDefault();
  joystickActive = true;
  document.addEventListener('mousemove', joystickMove);
  document.addEventListener('mouseup',   joystickEnd);
  joystickMove(e);
}

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

function joystickProcess(clientX, clientY) {
  const outer = document.getElementById('joystickOuter');
  const rect  = outer.getBoundingClientRect();
  const cx = rect.left + rect.width  / 2;
  const cy = rect.top  + rect.height / 2;
  const dx = clientX - cx;
  const dy = clientY - cy;
  const dist   = Math.sqrt(dx * dx + dy * dy);
  const maxR   = 50;
  const cX     = dist > maxR ? (dx / dist) * maxR : dx;
  const cY     = dist > maxR ? (dy / dist) * maxR : dy;

  document.getElementById('joystickKnob').style.transform =
    `translate(calc(-50% + ${cX}px), calc(-50% + ${cY}px))`;
  document.getElementById('joystickKnob').classList.add('active');

  let dir = 'stop';
  if (dist > 20) {
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    if      (angle > -45  && angle <=  45)  dir = 'right';
    else if (angle > 45   && angle <= 135)  dir = 'backward';
    else if (angle > 135  || angle <= -135) dir = 'left';
    else                                    dir = 'forward';
  }

  ['jTop','jBot','jLft','jRgt'].forEach(id =>
    document.getElementById(id).classList.remove('active'));
  const zoneMap = { forward:'jTop', backward:'jBot', left:'jLft', right:'jRgt' };
  if (zoneMap[dir]) document.getElementById(zoneMap[dir]).classList.add('active');

  if (dir !== currentDirection) {
    currentDirection = dir;
    sendRobotCommand(dir);
  }
}

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

function resetJoystick() {
  const knob = document.getElementById('joystickKnob');
  knob.style.transform = 'translate(-50%, -50%)';
  knob.classList.remove('active');
  ['jTop','jBot','jLft','jRgt'].forEach(id =>
    document.getElementById(id).classList.remove('active'));
  stopRobot();
}

function stopRobot() {
  currentDirection = 'stop';
  sendRobotCommand('stop');
}

// Write direction + speed + timestamp to Commands/robot/ in Firebase
function sendRobotCommand(direction) {
  const speed = Number(document.getElementById('speedSlider').value) || 5;
  db.ref('Commands/robot').update({
    direction,
    speed,
    timestamp: Date.now()
  });
}


// ================================================================
//  17. KEYBOARD ARROW-KEY CONTROL
// ================================================================

function initKeyboard() {
  const arrowMap = {
    ArrowUp   : 'forward',
    ArrowDown : 'backward',
    ArrowLeft : 'left',
    ArrowRight: 'right'
  };

  document.addEventListener('keydown', e => {
    if (!isLoggedIn || !arrowMap[e.key]) return;
    e.preventDefault();
    if (arrowMap[e.key] !== currentDirection) {
      currentDirection = arrowMap[e.key];
      sendRobotCommand(arrowMap[e.key]);
    }
  });

  document.addEventListener('keyup', e => {
    if (!isLoggedIn) return;
    if (arrowMap[e.key]) stopRobot();
  });
}


// ================================================================
//  18. SPEED SLIDER
// ================================================================

function initSpeedSlider() {
  document.getElementById('speedSlider').addEventListener('input', function () {
    document.getElementById('speedVal').textContent = this.value;
    if (currentDirection !== 'stop') {
      db.ref('Commands/robot/speed').set(Number(this.value));
    }
  });
}


// ================================================================
//  19. CAMERA FEED (ESP32-CAM)
// ================================================================

function connectCam() {
  const ip = (document.getElementById('camIP').value || '').trim();
  if (!ip) { alert('Enter ESP32-CAM IP address first.'); return; }

  const img      = document.getElementById('camStream');
  const noStream = document.getElementById('camNoStream');

  img.src               = `http://${ip}/stream`;
  img.style.display     = 'block';
  noStream.style.display = 'none';

  // Persist IP so it auto-loads on next login
  db.ref('devices/cam/ip').set(ip);
}

function disconnectCam() {
  const img      = document.getElementById('camStream');
  const noStream = document.getElementById('camNoStream');
  img.src               = '';
  img.style.display     = 'none';
  noStream.style.display = 'flex';
}

function loadSavedCamIP() {
  db.ref('devices/cam/ip').once('value', snap => {
    const ip = snap.val();
    if (ip && ip !== '0.0.0.0') {
      document.getElementById('camIP').value = ip;
    }
  });
}


// ================================================================
//  20. AUDIO — Speaker and Microphone toggles
// ================================================================

function setAudio(device, on) {
  if (device === 'spk') {
    speakerOn = on;
    document.getElementById('spkState').textContent = on ? 'ON' : 'OFF';
    document.getElementById('spkState').className   = 'audio-state-badge' + (on ? ' on-spk' : '');
    document.getElementById('spkIcon').className    = on ? 'fas fa-volume-up' : 'fas fa-volume-mute';
    document.getElementById('spkOnBtn').className   = 'btn-audio-on' + (on ? ' active-spk' : '');
    db.ref('Commands/audio/speaker').set(on);

  } else if (device === 'mic') {
    micOn = on;
    document.getElementById('micState').textContent = on ? 'ON' : 'OFF';
    document.getElementById('micState').className   = 'audio-state-badge' + (on ? ' on-mic' : '');
    document.getElementById('micIcon').className    = on ? 'fas fa-microphone' : 'fas fa-microphone-slash';
    document.getElementById('micOnBtn').className   = 'btn-audio-on' + (on ? ' active-mic' : '');
    db.ref('Commands/audio/mic').set(on);

    if (on) navigator.mediaDevices?.getUserMedia({ audio: true }).catch(() => {});
  }
}


// ================================================================
//  21. SETTINGS HELPERS
// ================================================================

function initAdminProfile() {
  const nameEl  = document.getElementById('adminName');
  const emailEl = document.getElementById('adminEmail');
  if (nameEl)  nameEl.textContent  = 'Dr. Administrator';
  if (emailEl) emailEl.textContent = `${loggedInDoctorId} · admin@medbot.in`;
}
// ── Clear active patient card back to skeleton state ──────────────
function clearPatientDisplay() {
  document.getElementById('patientAwaiting').style.display = 'flex';
  document.getElementById('patientActive').style.display   = 'none';
  ['piName','piID','piAge','piGender','piEmail','piDate']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '—';
    });
}
function toggleNotifications(checked) {
  notificationsEnabled = checked;
  if (checked) {
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    } else if (Notification.permission === 'denied') {
      alert('Notifications are blocked. Enable them in browser settings.');
      document.getElementById('notifToggle').checked = false;
      notificationsEnabled = false;
    }
  }
}


// ================================================================
//  END OF medbot_firebase.js  v2.0
// ================================================================
//
//  FIREBASE SCHEMA (strict — ESP32 must write to these exact paths):
//
//  patients/{patientId}/
//    name       : string
//    age        : number
//    gender     : string
//    email      : string
//    createdAt  : number (Unix ms)
//
//  vitals/{patientId}/
//    hr         : number  (heart rate, bpm)
//    spo2       : number  (SpO₂, %)
//    timestamp  : number  (Unix ms)
//
//  reports/{patientId}/
//    pdfUrl     : string  (Firebase Storage download URL)
//
//  Commands/
//    activePatient : string  (e.g. "p1")
//    robot/
//      direction   : string  (forward|backward|left|right|stop)
//      speed       : number  (1–10)
//      timestamp   : number
//    audio/
//      speaker     : boolean
//      mic         : boolean
//  devices/
//    cam/
//      ip          : string
//
//  patientLogs/{patientId}/  ← auto-created when new patient is added
//    (copy of patients/{patientId} + archivedAt timestamp)
//
// ================================================================
