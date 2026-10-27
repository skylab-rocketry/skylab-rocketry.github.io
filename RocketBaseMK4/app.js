'use strict';

/* ============================================================
 *  RocketBase Ground Control
 *
 *  Devices (Web Serial, Chrome/Chromium):
 *    1. RocketBase Transceiver  — telemetry + commands (filtered)
 *    2. Launch Button (optional)— physical STATUS_ON / STATUS_OFF
 *
 *  Inbound telemetry:  UPDT{json}   (also accepts RECV-prefixed lines)
 *  Outbound commands:  ARM / DISARM / FIRE / CTD<N> / ABORT
 * ============================================================ */

const PREFIX = 'UPDT';
const BAUD = 115200;
const TILT_LIMIT = 30;
const VOLT_SCALE = (3.3 / 65535) * (977 / 10917);
const LINK_STALE_MS = 3000;   // display only — never used to block commands

/* Only the receiver firmware with VID:PID = 2E8A:5242.
 * Shift+Connect lists every serial port (escape hatch). */
const USB_FILTERS = [{ usbVendorId: 0x2E8A, usbProductId: 0x5242 }];

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const els = {
  noSerialBanner: $('noSerialBanner'),
  alertBanner: $('alertBanner'), alertText: $('alertText'),
  errBanner: $('errBanner'), errTitle: $('errTitle'), errText: $('errText'),

  rxDot: $('rxDot'), rxState: $('rxState'), connectBtn: $('connectBtn'),
  btnDot: $('btnDot'), btnState: $('btnState'), connectButtonBtn: $('connectButtonBtn'),

  countdownDisplay: $('countdownDisplay'), countdownValue: $('countdownValue'),
  cdChip: $('cdChip'), countdownNote: $('countdownNote'), latencyInput: $('latencyInput'),

  armSwitch: $('armSwitch'), armChip: $('armChip'), armSub: $('armSub'),

  ledFire: $('ledFire'), txtFire: $('txtFire'),
  ledSafe: $('ledSafe'), txtSafe: $('txtSafe'),
  ledCtn: $('ledCtn'), txtCtn: $('txtCtn'),

  tiltGauge: $('tiltGauge'), tiltValue: $('tiltValue'), tiltNote: $('tiltNote'),

  rcntAdc: $('rcntAdc'), rcntVolt: $('rcntVolt'),
  tmValue: $('tmValue'), lastUpdate: $('lastUpdate'), msgCount: $('msgCount'),

  cdSec: $('cdSec'), startBtn: $('startBtn'), abortBtn: $('abortBtn'),

  btnCardChip: $('btnCardChip'), btnCardDot: $('btnCardDot'),
  btnLastTitle: $('btnLastTitle'), btnLastSub: $('btnLastSub'),
  buttonConnectCard: $('buttonConnectCard'),

  logList: $('logList'), logChip: $('logChip'),
};

const ledRefs = [
  { el: els.ledFire, txt: els.txtFire },   // FIRE
  { el: els.ledSafe, txt: els.txtSafe },   // SAFE
  { el: els.ledCtn, txt: els.txtCtn },     // CONTINUITY
];

/* ---------- State ---------- */
function newConn() {
  return { port: null, writer: null, reader: null, connecting: false };
}

const state = {
  rx: newConn(),
  btn: newConn(),
  rxBuffer: '',
  btnBuffer: '',
  msgCount: 0,
  lastUpdate: null,
  latencyMs: 0,
  ctdnAnchor: null,
  alert: false,
  receiverAlert: false,
  btnLastEvent: null,
  btnLastAt: 0,
  fields: {
    ast: 0, fst: 0, cnt: 0, rcnt: null,
    tilt: null, safe: 0, ctdn: -1, tm: 0, alr: 0, err: '',
  },
};

const supported = 'serial' in navigator;

/* ============================================================
 *  TILT GAUGE
 * ============================================================ */
(function buildGauge() {
  const NS = 'http://www.w3.org/2000/svg';
  const cx = 190, cy = 175, r = 130;
  const from = -45, to = 45;
  const ang = (deg) => ((deg / 45) * 45 + -90) * (Math.PI / 180);
  const pt = (deg, rad) => [cx + rad * Math.cos(ang(deg)), cy + rad * Math.sin(ang(deg))];

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 380 220');
  svg.innerHTML = '';

  for (const [d1, d2] of [[30, 45], [-45, -30]]) {
    const p1 = pt(d1, r), p2 = pt(d2, r);
    const arc = document.createElementNS(NS, 'path');
    arc.setAttribute('class', 'zone');
    arc.setAttribute('d',
      `M ${p1[0]} ${p1[1]} A ${r} ${r} 0 0 1 ${p2[0]} ${p2[1]} L ${cx} ${cy} Z`);
    svg.appendChild(arc);
  }

  const pLo = pt(from, r), pHi = pt(to, r);
  const arc = document.createElementNS(NS, 'path');
  arc.setAttribute('class', 'arc');
  arc.setAttribute('d', `M ${pLo[0]} ${pLo[1]} A ${r} ${r} 0 0 1 ${pHi[0]} ${pHi[1]}`);
  svg.appendChild(arc);

  for (let d = from; d <= to; d += 5) {
    const major = d % 10 === 0;
    const p1 = pt(d, r - (major ? 12 : 7));
    const p2 = pt(d, r + 2);
    const tick = document.createElementNS(NS, 'line');
    tick.setAttribute('x1', p1[0]); tick.setAttribute('y1', p1[1]);
    tick.setAttribute('x2', p2[0]); tick.setAttribute('y2', p2[1]);
    tick.setAttribute('class', Math.abs(d) >= TILT_LIMIT ? 'tick tick-danger' : 'tick');
    svg.appendChild(tick);

    if (major) {
      const lp = pt(d, r - 26);
      const lbl = document.createElementNS(NS, 'text');
      lbl.setAttribute('class', 'tick-label');
      lbl.setAttribute('x', lp[0]); lbl.setAttribute('y', lp[1]);
      lbl.setAttribute('text-anchor', 'middle');
      lbl.setAttribute('dominant-baseline', 'middle');
      lbl.textContent = d === 0 ? '0°' : `${d}°`;
      svg.appendChild(lbl);
    }
  }

  const needle = document.createElementNS(NS, 'line');
  needle.setAttribute('class', 'needle');
  needle.setAttribute('x1', cx); needle.setAttribute('y1', cy);
  needle.setAttribute('x2', pt(0, r - 20)[0]); needle.setAttribute('y2', pt(0, r - 20)[1]);
  svg.appendChild(needle);

  const center = document.createElementNS(NS, 'circle');
  center.setAttribute('class', 'needle-center');
  center.setAttribute('cx', cx); center.setAttribute('cy', cy);
  center.setAttribute('r', 6);
  svg.appendChild(center);

  els.tiltGauge.appendChild(svg);
  els._gauge = { needle, cx, cy, r };
})();

function setNeedle(tiltDeg) {
  const g = els._gauge;
  const clamped = Math.max(-45, Math.min(45, tiltDeg));
  const a = ((clamped / 45) * 45 + -90) * (Math.PI / 180);
  const len = g.r - 20;
  g.needle.setAttribute('x2', g.cx + len * Math.cos(a));
  g.needle.setAttribute('y2', g.cy + len * Math.sin(a));
}

/* ============================================================
 *  CONNECTIONS
 * ============================================================ */
async function connectDevice(kind, showAll) {
  const conn = kind === 'rx' ? state.rx : state.btn;
  if (conn.port || conn.connecting) return;

  conn.connecting = true;
  render();

  try {
    const selected = await navigator.serial.requestPort(
      kind === 'rx' && !showAll ? { filters: USB_FILTERS } : {}
    );
    await selected.open({ baudRate: BAUD });
    conn.port = selected;

    if (kind === 'rx') {
      conn.writer = selected.writable.getWriter();
      log('sys', 'Transceiver connected');
    } else {
      log('sys', 'Launch Button connected');
    }

    readLoop(kind, selected);
  } catch (err) {
    if (err && err.name === 'NotFoundError') {
      log('sys', kind === 'rx'
        ? 'No RocketBase Transceiver selected. (Shift+Connect shows every serial port.)'
        : 'No Launch Button selected.');
    } else {
      log('warn', `Connect failed: ${err.message || err}`);
    }
  } finally {
    conn.connecting = false;
    render();
  }
}

async function disconnectDevice(kind) {
  const conn = kind === 'rx' ? state.rx : state.btn;
  const port = conn.port;
  if (!port) return;

  conn.port = null;
  const writer = conn.writer;
  conn.writer = null;
  conn.reader = null;

  try { if (writer) await writer.releaseLock(); } catch (_) { /* ignore */ }
  try { await port.close(); } catch (_) { /* ignore */ }

  if (kind === 'rx') {
    resetTelemetry();
    log('sys', 'Transceiver disconnected');
  } else {
    state.btnLastEvent = null;
    state.btnLastAt = 0;
    state.btnBuffer = '';
    log('sys', 'Launch Button disconnected');
  }

  render();
}

async function readLoop(kind, port) {
  const conn = kind === 'rx' ? state.rx : state.btn;
  const decoder = new TextDecoder();

  try {
    while (port.readable) {
      const reader = port.readable.getReader();
      conn.reader = reader;

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });

          if (kind === 'rx') {
            state.rxBuffer += text;
            processRxLines();
          } else {
            state.btnBuffer += text;
            processBtnLines();
          }
        }
      } finally {
        try { reader.releaseLock(); } catch (_) { /* ignore */ }
      }
    }
  } catch (err) {
    if (conn.port === port) {
      log('warn', `${kind === 'rx' ? 'Transceiver' : 'Launch Button'} read error: ${err.message || err}`);
    }
  }

  if (conn.port === port) await disconnectDevice(kind);
}

function resetTelemetry() {
  state.fields = {
    ast: 0, fst: 0, cnt: 0, rcnt: null,
    tilt: null, safe: 0, ctdn: -1, tm: 0, alr: 0, err: '',
  };
  state.msgCount = 0;
  state.lastUpdate = null;
  state.ctdnAnchor = null;
  state.alert = false;
  state.receiverAlert = false;
  state.rxBuffer = '';
}

/* ============================================================
 *  RECEIVER LINES
 * ============================================================ */
function processRxLines() {
  let idx;
  while ((idx = state.rxBuffer.indexOf('\n')) !== -1) {
    let line = state.rxBuffer.slice(0, idx).trim();
    state.rxBuffer = state.rxBuffer.slice(idx + 1);
    if (!line) continue;

    if (line.startsWith('RECV')) line = line.slice(4).trim();

    if (line.startsWith(PREFIX)) handleUpdate(line.slice(PREFIX.length));
    else if (line.startsWith('ALERT')) handleAlertLine(line);
    else if (line.startsWith('Sent ')) { /* echo of a command from the receiver */ }
    else if (line.startsWith('Air rate') || line.startsWith('UART')) { /* boot noise */ }
    else log('warn', `Ignored: ${line}`);
  }
}

function handleUpdate(payload) {
  let data;
  try {
    data = JSON.parse(payload);
  } catch (_) {
    log('warn', `Malformed telemetry: ${payload}`);
    return;
  }

  const wasAlert = state.alert;
  state.msgCount++;
  state.lastUpdate = Date.now();

  state.fields = {
    ast: data.ast === 1 ? 1 : 0,
    fst: data.fst === 1 ? 1 : 0,
    cnt: data.cnt === 1 ? 1 : 0,
    rcnt: typeof data.rcnt === 'number' ? data.rcnt : null,
    tilt: data.tilt === null || data.tilt === undefined ? null : Number(data.tilt),
    safe: data.safe === 1 ? 1 : 0,
    ctdn: Number.isFinite(Number(data.ctdn)) ? Number(data.ctdn) : -1,
    tm: Number(data.tm) || 0,
    alr: data.alr === 1 ? 1 : 0,
    err: data.err || '',
  };

  state.alert = state.fields.alr === 1;

  if (state.alert !== wasAlert) {
    log(state.alert ? 'alert' : 'sys', state.alert
      ? 'ALERT — accelerometer unavailable: launch allowed WITHOUT tilt/acceleration checks'
      : 'Alert cleared — accelerometer available again');
  }

  if (state.fields.ctdn >= 0) {
    state.ctdnAnchor = {
      raw: state.fields.ctdn,
      value: state.fields.ctdn - state.latencyMs / 1000,
      time: Date.now(),
    };
  } else {
    state.ctdnAnchor = null;
  }

  render();
  log('rx', `UPDT${JSON.stringify(data)}`);
}

function handleAlertLine(line) {
  const clear = /CLEAR/i.test(line);
  state.receiverAlert = !clear;

  if (clear) {
    log('sys', 'Receiver: alert cleared');
  } else {
    log('alert', line);
  }

  render();
}

/* ============================================================
 *  LAUNCH BUTTON LINES
 * ============================================================ */
function processBtnLines() {
  let idx;
  while ((idx = state.btnBuffer.indexOf('\n')) !== -1) {
    const line = state.btnBuffer.slice(0, idx).trim();
    state.btnBuffer = state.btnBuffer.slice(idx + 1);
    if (!line) continue;

    if (line === 'STATUS_ON') onLaunchButtonPressed();
    else if (line === 'STATUS_OFF') onLaunchButtonReleased();
    else log('sys', `Button device: ${line}`);
  }
}

function onLaunchButtonPressed() {
  state.btnLastEvent = 'down';
  state.btnLastAt = Date.now();

  // Nessun controllo qui: il pulsante fisico invia solo la richiesta.
  // Tutte le verifiche (ARM, continuita', safety) le fa la base.
  log('alert', 'Physical launch button pressed');
  if (sendCommand('FIRE\n', 'physical launch')) {
    log('tx', 'FIRE request sent — the base performs all checks');
  }
  render();
}

function onLaunchButtonReleased() {
  state.btnLastEvent = 'up';
  state.btnLastAt = Date.now();
  log('sys', 'Physical launch button released');
  render();
}

/* ============================================================
 *  COMMANDS
 *  The UI never validates a launch. It only sends commands and
 *  displays whatever the base reports in telemetry.
 * ============================================================ */
function sendCommand(cmd, label) {
  if (!state.rx.port || !state.rx.writer) {
    log('warn', `Cannot send ${label} — transceiver not connected`);
    return false;
  }
  try {
    state.rx.writer.write(new TextEncoder().encode(cmd));
    log('tx', cmd.replace(/\n$/, ''));
    return true;
  } catch (err) {
    log('warn', `Send failed: ${err.message || err}`);
    return false;
  }
}

function onArmToggle() {
  // ARM/DISARM pilotano direttamente il MOSFET: nessuna logica qui.
  const next = state.fields.ast !== 1;
  sendCommand(next ? 'ARM\n' : 'DISARM\n', next ? 'ARM on' : 'ARM off');
  render();
}

function onStart() {
  // Invia il valore cosi' com'e': la base valida il countdown.
  const raw = String(els.cdSec.value).trim();
  sendCommand(`CTD${raw}\n`, `countdown ${raw}s`);
  render();
}

function onAbort() {
  sendCommand('ABORT\n', 'abort');
  render();
}

/* ============================================================
 *  RENDERING
 * ============================================================ */
function fmtNum(v, digits = 0) {
  if (v === null || v === undefined || isNaN(v)) return '--';
  return Number(v).toFixed(digits);
}

function setLed(ref, on, color) {
  ref.el.querySelector('.led').dataset.state = on ? color : 'off';
}

function ctdnRemainingNow() {
  if (!state.ctdnAnchor) return null;
  return Math.max(0, state.ctdnAnchor.value - (Date.now() - state.ctdnAnchor.time) / 1000);
}

function linkStale() {
  return !!state.rx.port &&
    (!state.lastUpdate || Date.now() - state.lastUpdate > LINK_STALE_MS);
}

function updateCountdownDisplay() {
  const f = state.fields;
  const alert = state.alert || state.receiverAlert;
  const stale = linkStale();
  const degradedNote = alert ? ' · DEGRADED — no tilt check' : '';

  if (!state.ctdnAnchor || stale) {
    els.countdownValue.textContent = stale ? 'NO LINK' : 'READY';
    els.countdownDisplay.dataset.active = 'false';
    els.countdownDisplay.dataset.warn = 'false';
    els.countdownNote.textContent = stale
      ? 'Telemetry lost — launch is not possible.'
      : state.rx.port
        ? 'Idle — no countdown in progress'
        : 'Waiting for the transceiver…';
    return;
  }

  const rem = ctdnRemainingNow();
  els.countdownValue.textContent = `${rem.toFixed(1)}s`;
  els.countdownDisplay.dataset.active = 'true';
  els.countdownDisplay.dataset.warn = rem <= 5 ? 'true' : 'false';
  els.countdownNote.textContent = (rem <= 5
    ? 'T-minus — under 5 seconds!'
    : `Countdown in progress — raw ${f.ctdn}s · latency ${state.latencyMs}ms`) + degradedNote;
}

function render() {
  const f = state.fields;
  const now = Date.now();
  const rxOn = !!state.rx.port;
  const btnOn = !!state.btn.port;
  const alert = state.alert || state.receiverAlert;
  const armOn = f.ast === 1;
  const stale = linkStale();

  /* ---------- devices ---------- */
  els.rxDot.dataset.state = rxOn ? 'on' : 'off';
  els.rxState.textContent = state.rx.connecting
    ? 'Connecting…'
    : rxOn
      ? (state.lastUpdate ? 'Receiving telemetry' : 'Waiting for data')
      : 'Not connected';
  els.connectBtn.textContent = rxOn ? 'Disconnect' : 'Connect';
  els.connectBtn.disabled = state.rx.connecting || !supported;

  els.btnDot.dataset.state = btnOn ? 'on' : 'off';
  els.btnState.textContent = state.btn.connecting
    ? 'Connecting…'
    : btnOn
      ? (state.btnLastEvent === 'down' ? 'Pressed' : 'Ready')
      : 'Optional · off';
  els.connectButtonBtn.textContent = btnOn ? 'Disconnect' : 'Connect';
  els.connectButtonBtn.disabled = state.btn.connecting || !supported;

  els.btnCardDot.dataset.state = btnOn ? 'on' : 'off';
  els.btnCardChip.textContent = btnOn ? 'CONNECTED' : 'OPTIONAL';
  els.btnCardChip.className = 'chip' + (btnOn ? ' ok' : '');
  els.buttonConnectCard.textContent = btnOn ? 'Disconnect device' : 'Connect device';
  els.buttonConnectCard.disabled = state.btn.connecting || !supported;

  els.btnLastTitle.textContent = btnOn
    ? (state.btnLastEvent === 'down'
      ? 'Button pressed'
      : state.btnLastEvent === 'up'
        ? 'Button released'
        : 'Waiting for a press')
    : 'No device';
  els.btnLastSub.textContent = btnOn
    ? (state.btnLastAt
      ? `Last event ${new Date(state.btnLastAt).toLocaleTimeString()}`
      : 'Ready — press the button to launch.')
    : 'Connect the device to enable the physical launch button.';

  /* ---------- arm ---------- */
  els.armSwitch.setAttribute('aria-checked', armOn ? 'true' : 'false');
  els.armSwitch.disabled = !rxOn;
  els.armChip.textContent = armOn ? 'ARMED' : 'OFF';
  els.armChip.className = 'chip' + (armOn ? ' ok' : '');
  els.armSub.textContent = !rxOn
    ? 'Disconnected'
    : stale
      ? 'No telemetry'
      : armOn
        ? 'Live — ignition circuit enabled'
        : 'Off';

  /* ---------- countdown ---------- */
  updateCountdownDisplay();

  if (stale) {
    els.cdChip.textContent = 'NO LINK';
    els.cdChip.className = 'chip danger';
  } else if (state.ctdnAnchor) {
    const rem = ctdnRemainingNow();
    els.cdChip.textContent = 'T-MINUS';
    els.cdChip.className = 'chip' + (rem <= 5 ? ' danger' : ' ok');
  } else if (f.fst === 1) {
    els.cdChip.textContent = 'FIRING';
    els.cdChip.className = 'chip danger';
  } else {
    els.cdChip.textContent = 'IDLE';
    els.cdChip.className = 'chip';
  }

  /* ---------- banners ---------- */
  if (alert) {
    els.alertText.textContent =
      'Accelerometer not available — DEGRADED MODE. ' +
      'Launch is permitted, but tilt/acceleration checks are disabled.';
    els.alertBanner.classList.remove('hidden');
  } else {
    els.alertBanner.classList.add('hidden');
  }

  if (f.err && f.err.trim() !== '') {
    els.errTitle.textContent = 'Base';
    els.errText.textContent = f.err;
    els.errBanner.classList.remove('hidden');
  } else {
    els.errBanner.classList.add('hidden');
  }

  /* ---------- LEDs ---------- */
  setLed(ledRefs[0], !stale && f.fst === 1, 'red');
  els.txtFire.textContent = stale ? 'UNKNOWN' : (f.fst === 1 ? 'FIRED' : 'IDLE');

  if (alert) {
    setLed(ledRefs[1], true, 'blue');
    els.txtSafe.textContent = 'DEGRADED';
  } else if (!rxOn || stale) {
    setLed(ledRefs[1], false, 'green');
    els.txtSafe.textContent = 'UNKNOWN';
  } else {
    setLed(ledRefs[1], f.safe === 1, f.safe === 1 ? 'green' : 'red');
    els.txtSafe.textContent = f.safe === 1 ? 'SAFE' : 'NOT SAFE';
  }

  setLed(ledRefs[2], !stale && f.cnt === 1, 'green');
  els.txtCtn.textContent = stale ? 'UNKNOWN' : (f.cnt === 1 ? 'CONNECTED' : 'OPEN');

  /* ---------- tilt ---------- */
  if (stale) {
    els.tiltValue.textContent = '--';
    els.tiltValue.dataset.danger = 'false';
    setNeedle(0);
    els.tiltNote.textContent = 'Telemetry lost — tilt unknown';
  } else if (alert) {
    els.tiltValue.textContent = '--';
    els.tiltValue.dataset.danger = 'false';
    setNeedle(0);
    els.tiltNote.textContent = 'Accelerometer unavailable — tilt check disabled (degraded mode)';
  } else if (f.tilt !== null && !isNaN(f.tilt)) {
    const t = Number(f.tilt);
    els.tiltValue.textContent = t.toFixed(2);
    els.tiltValue.dataset.danger = Math.abs(t) > TILT_LIMIT ? 'true' : 'false';
    setNeedle(t);
    els.tiltNote.textContent = Math.abs(t) > TILT_LIMIT
      ? `WARNING — base is beyond ${TILT_LIMIT}°`
      : `Within safe limit (≤ ${TILT_LIMIT}°)`;
  } else {
    els.tiltValue.textContent = '--';
    els.tiltValue.dataset.danger = 'false';
    setNeedle(0);
    els.tiltNote.textContent = rxOn ? 'Waiting for telemetry…' : 'Connect the transceiver.';
  }

  /* ---------- link ---------- */
  if (f.rcnt !== null && !isNaN(f.rcnt)) {
    els.rcntAdc.textContent = Math.round(f.rcnt);
    els.rcntVolt.textContent = (f.rcnt * VOLT_SCALE).toFixed(3);
  } else {
    els.rcntAdc.textContent = '--';
    els.rcntVolt.textContent = '--';
  }

  els.tmValue.textContent = f.tm ? Number(f.tm).toFixed(0) : '--';
  els.lastUpdate.textContent = state.lastUpdate
    ? new Date(state.lastUpdate).toLocaleTimeString()
    : '--';
  els.msgCount.textContent = state.msgCount;
  els.logChip.textContent = state.msgCount;

  /* ---------- commands ---------- */
  els.startBtn.disabled = !rxOn || !supported;
  els.abortBtn.disabled = !rxOn || !supported;
}

/* ============================================================
 *  EVENT LOG
 * ============================================================ */
function log(kind, body) {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.dataset.kind = kind;

  const t = document.createElement('span');
  t.className = 'log-time';
  t.textContent = `[${time}] `;

  const b = document.createElement('span');
  b.className = 'log-body';
  b.textContent = body;

  entry.appendChild(t);
  entry.appendChild(b);

  const empty = els.logList.querySelector('.log-empty');
  if (empty) empty.remove();

  els.logList.appendChild(entry);
  while (els.logList.children.length > 120) {
    els.logList.removeChild(els.logList.firstChild);
  }
  els.logList.scrollTop = els.logList.scrollHeight;
}

/* ============================================================
 *  LATENCY
 * ============================================================ */
function onLatencyChange() {
  const v = parseInt(els.latencyInput.value, 10);
  state.latencyMs = Number.isFinite(v) && v >= 0 ? v : 0;
  els.latencyInput.value = state.latencyMs;
  localStorage.setItem('rbgu.latencyMs', String(state.latencyMs));
  if (state.ctdnAnchor) {
    state.ctdnAnchor.value = state.ctdnAnchor.raw - state.latencyMs / 1000;
    updateCountdownDisplay();
  }
}

/* Smooth local tick for the countdown display. */
setInterval(() => {
  render();
}, 200);

/* ============================================================
 *  INIT
 * ============================================================ */
const savedLatency = parseInt(localStorage.getItem('rbgu.latencyMs') || '0', 10);
state.latencyMs = Number.isFinite(savedLatency) && savedLatency >= 0 ? savedLatency : 0;
els.latencyInput.value = state.latencyMs;

if (!supported) {
  els.noSerialBanner.classList.remove('hidden');
  els.connectBtn.disabled = true;
  els.connectButtonBtn.disabled = true;
  els.buttonConnectCard.disabled = true;
  els.startBtn.disabled = true;
  els.abortBtn.disabled = true;
} else {
  if (navigator.serial.addEventListener) {
    navigator.serial.addEventListener('connect', () => log('sys', 'A serial port became available'));
    navigator.serial.addEventListener('disconnect', () => log('sys', 'A serial port was disconnected'));
  }
}

els.connectBtn.addEventListener('click', (e) => {
  if (state.rx.port) return disconnectDevice('rx');
  return connectDevice('rx', e.shiftKey);
});

els.connectButtonBtn.addEventListener('click', () => {
  if (state.btn.port) return disconnectDevice('btn');
  return connectDevice('btn', true);
});

els.buttonConnectCard.addEventListener('click', () => {
  if (state.btn.port) return disconnectDevice('btn');
  return connectDevice('btn', true);
});

els.armSwitch.addEventListener('click', onArmToggle);
els.startBtn.addEventListener('click', onStart);
els.abortBtn.addEventListener('click', onAbort);
els.cdSec.addEventListener('keydown', (e) => { if (e.key === 'Enter') onStart(); });
els.latencyInput.addEventListener('input', onLatencyChange);

log('sys', supported
  ? 'Ready — connect the RocketBase Transceiver. The Launch Button is optional (Shift+Connect shows all ports).'
  : 'Web Serial API not available. Use Chrome/Chromium.');

render();
