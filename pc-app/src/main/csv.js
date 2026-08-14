'use strict';

/**
 * PulseNX — session CSV export and history import.
 *
 * Columns: Timestamp, Elapsed Time (s), Heart Rate (BPM), RR-Interval (ms),
 *          Training Zone, Stress Index
 *
 * The importer matches columns by header NAME rather than position and honours
 * quoting, so a file exported from another tool (or one whose timestamps carry
 * commas) still loads.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CSV_HEADER = 'Timestamp,Elapsed Time (s),Heart Rate (BPM),RR-Interval (ms),Training Zone,Stress Index';

function quote(value) {
  return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
}

function buildCsv(rows) {
  const lines = [CSV_HEADER];
  for (const row of rows || []) {
    lines.push([
      quote(row.time),
      row.elapsed != null ? row.elapsed : '',
      row.bpm != null ? row.bpm : '',
      row.rr != null ? row.rr : '',
      quote(row.zone),
      row.stress != null ? row.stress : ''
    ].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function defaultFileName(now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '');
  return `pulsenx_session_${date}_${time}.csv`;
}

/** Splits one CSV record, honouring "quoted, fields" and "" escapes. */
function splitCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      fields.push(current);
      current = '';
    } else current += ch;
  }

  fields.push(current);
  return fields.map((f) => f.trim());
}

function findColumn(headers, ...needles) {
  const normalized = headers.map((h) => h.toLowerCase());
  for (const needle of needles) {
    const idx = normalized.findIndex((h) => h.includes(needle));
    if (idx !== -1) return idx;
  }
  return -1;
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Parses a session CSV into chart-ready series plus summary statistics.
 * Returns `{ok:false, error}` instead of throwing so the renderer can show the
 * problem inline rather than through a blocking dialog.
 */
function parseSessionCsv(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'The file is empty.' };
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return { ok: false, error: 'The file contains no data rows.' };
  }

  const headers = splitCsvLine(lines[0]);
  const bpmIdx = findColumn(headers, 'heart rate', 'bpm');
  const elapsedIdx = findColumn(headers, 'elapsed');
  const stressIdx = findColumn(headers, 'stress');

  if (bpmIdx === -1) {
    return { ok: false, error: "No 'Heart Rate (BPM)' column found in this CSV." };
  }

  const labels = [];
  const hr = [];
  const stress = [];

  let hrSum = 0;
  let hrMin = null;
  let hrMax = null;
  let stressSum = 0;
  let stressCount = 0;
  let duration = 0;

  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i]);
    const bpm = parseFloat(parts[bpmIdx]);
    if (!Number.isFinite(bpm)) continue;

    // A file without an elapsed column still plots: fall back to the row index
    // as a second-resolution timeline.
    const elapsedRaw = elapsedIdx === -1 ? NaN : parseFloat(parts[elapsedIdx]);
    const elapsed = Number.isFinite(elapsedRaw) ? elapsedRaw : hr.length;

    duration = Math.max(duration, elapsed);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(Math.floor(elapsed % 60)).padStart(2, '0');
    labels.push(`${mins}:${secs}`);

    const rounded = Math.round(bpm);
    hr.push(rounded);
    hrSum += rounded;
    hrMin = hrMin === null ? rounded : Math.min(hrMin, rounded);
    hrMax = hrMax === null ? rounded : Math.max(hrMax, rounded);

    let stressValue = null;
    if (stressIdx !== -1) {
      const parsed = parseFloat(parts[stressIdx]);
      if (Number.isFinite(parsed)) {
        stressValue = Math.round(parsed);
        stressSum += stressValue;
        stressCount++;
      }
    }
    stress.push(stressValue);
  }

  if (hr.length === 0) {
    return { ok: false, error: 'No usable heart-rate rows found.' };
  }

  return {
    ok: true,
    labels,
    hr,
    // All-null stress means the file had no stress data; hand back an empty
    // series so the renderer can hide the second axis.
    stress: stress.some((v) => v !== null) ? stress : [],
    stats: {
      min: hrMin,
      max: hrMax,
      avg: Math.round(hrSum / hr.length),
      stressAvg: stressCount > 0 ? Math.round(stressSum / stressCount) : null,
      duration: formatDuration(duration),
      durationSec: Math.round(duration),
      samples: hr.length
    }
  };
}

/**
 * Opens the native save dialog and writes the session.
 * Only the main process may show native dialogs, which is why this lives here.
 */
async function exportSession(rows, { dialog, app, window } = {}) {
  if (!rows || rows.length === 0) {
    return { ok: false, error: 'Nothing recorded yet.' };
  }

  let defaultDir;
  try {
    defaultDir = app ? app.getPath('downloads') : os.homedir();
  } catch (err) {
    defaultDir = os.homedir();
  }

  const fileName = defaultFileName();
  let target = null;

  if (dialog) {
    const result = await dialog.showSaveDialog(window || undefined, {
      title: 'Export PulseNX Session',
      defaultPath: path.join(defaultDir, fileName),
      filters: [{ name: 'CSV Session Log', extensions: ['csv'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    target = result.filePath;
  } else {
    target = path.join(defaultDir, fileName);
  }

  try {
    await fs.promises.writeFile(target, buildCsv(rows), 'utf8');
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = {
  CSV_HEADER,
  buildCsv,
  parseSessionCsv,
  splitCsvLine,
  exportSession,
  defaultFileName,
  formatDuration
};
