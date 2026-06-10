// gantt-diff-data.js  (v2)
//
// One repo, two views, three payload formats.
//
// VIEWS (?view= URL param):
//   view=approved   → render the approved plan only, zero diff chrome
//   view=diff       → render candidate with ghost bars (needs candidate)
//   (default)       → diff if a candidate is present, else approved
//
// PAYLOAD FORMATS (base64 or raw in #data= / ?data=):
//   A) JSON object       { "approved": <plan>, "candidate": <plan>|null, "today": "YYYY-MM-DD" }
//   B) Script-1 gantt    { dispatch_date, items: [...] }            (single plan = approved)
//   C) Legacy combined   15/06/2026, 0:00:00, {"Name":...}, {...}   (single plan = approved)
//      Dispatch prefix is D/M/YYYY by default; &dmy=0 switches to M/D/YYYY.
//
// Each <plan> inside format A can itself be a Script-1 gantt_json, a flat
// array of {Name, Phase, "Start date", "End date", Completed}, or a legacy
// combined string.
//
// COMPLETION: a process is completed ONLY when its completed flag is true
//   (accepted keys: is_completed / Completed / completed / isCompleted).
//   Dates NEVER imply completion. A process whose end has passed without
//   the flag is OVERDUE, not completed.

window.GanttDiffData = (function () {
  const MS_DAY = 86400000;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  let _approved = null;
  let _candidate = null;
  let _todayIso = null;
  let _view = 'auto';          // 'approved' | 'diff' | 'auto'
  let _loadError = null;
  let _usingDemo = false;
  let _dateFmtDMY = true;

  // ───────────────────────── date helpers
  function toMs(iso) {
    if (iso instanceof Date) return Date.UTC(iso.getUTCFullYear(), iso.getUTCMonth(), iso.getUTCDate());
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }
  function startOfUTCDay(d) { return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
  function isoFromMs(ms) {
    const d = new Date(ms);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function fmt(ms, opts = {}) {
    const d = new Date(ms);
    if (opts.full)  return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
    if (opts.short) return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
    if (opts.month) return MONTHS[d.getUTCMonth()];
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  }
  function daysBetween(a, b) { return Math.round((b - a) / MS_DAY); }
  function addDays(ms, n) { return ms + n * MS_DAY; }

  // ───────────────────────── payload reading
  function readPayload() {
    let raw = '';
    if (location.hash) {
      const h = location.hash.replace(/^#/, '');
      const m = h.match(/(?:^|&)data=([^&]+)/);
      raw = m ? decodeURIComponent(m[1]) : decodeURIComponent(h);
    } else if (location.search) {
      raw = new URLSearchParams(location.search).get('data') || '';
    }
    return raw || null;
  }

  function decodePayload(raw) {
    const trimmed = raw.trim();
    // Raw JSON or legacy combined string starting with a digit (dispatch date)
    if (trimmed[0] === '{' || trimmed[0] === '[' || /^\d/.test(trimmed)) return trimmed;
    let b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return decodeURIComponent(escape(atob(b64)));
  }

  // ───────────────────────── legacy combined string parsing
  function parseDispatchDate(s) {
    s = s.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const d = new Date(s);
      if (!isNaN(d.getTime())) return d;
    }
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
    if (m) {
      const part1 = parseInt(m[1], 10);
      const part2 = parseInt(m[2], 10);
      const year = parseInt(m[3], 10);
      let day, month;
      if (_dateFmtDMY) { day = part1; month = part2 - 1; }
      else            { month = part1 - 1; day = part2; }
      const d = new Date(Date.UTC(year, month, day));
      if (!isNaN(d.getTime())) return d;
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
    throw new Error('Could not parse dispatch date: "' + s + '"');
  }

  function parseCombinedString(text) {
    text = text.trim();
    if (text.startsWith('[')) return { dispatch: null, processes: JSON.parse(text) };
    const firstBrace = text.indexOf('{');
    if (firstBrace < 0) throw new Error('No process JSON found in input.');
    let dispatchStr = '';
    let processStr = '';
    if (firstBrace === 0) processStr = text;
    else {
      dispatchStr = text.slice(0, firstBrace).replace(/,\s*$/, '').trim();
      processStr = text.slice(firstBrace).trim();
    }
    if (processStr.startsWith('{')) processStr = '[' + processStr + ']';
    return {
      dispatch: dispatchStr ? parseDispatchDate(dispatchStr) : null,
      processes: JSON.parse(processStr),
    };
  }

  // ───────────────────────── normalization
  function readCompletedFlag(p) {
    return !!(p.is_completed || p.Completed || p.completed || p.isCompleted);
  }

  function parsePhase(raw) {
    const text = String(raw == null ? '' : raw).trim().toLowerCase();
    if (text === 'final') return 999;
    const n = parseInt(text, 10);
    return isNaN(n) ? 998 : n;
  }

  function flatProcess(p, i) {
    const name = p.Name || p.name || p.process || ('Process ' + (i + 1));
    const sRaw = p['Start date'] || p.start_date || p.startDate || p.start;
    const eRaw = p['End date'] || p.end_date || p.endDate || p.end;
    const sd = new Date(sRaw);
    const ed = new Date(eRaw);
    if (isNaN(sd.getTime()) || isNaN(ed.getTime())) {
      throw new Error('Invalid date for "' + name + '" (start="' + sRaw + '", end="' + eRaw + '")');
    }
    return {
      key: String(p.process_row_id || name),
      name: String(name),
      phase: parsePhase(p.Phase !== undefined ? p.Phase : p.phase),
      startIso: isoFromMs(startOfUTCDay(sd)),
      endIso: isoFromMs(startOfUTCDay(ed)),
      isCompleted: readCompletedFlag(p),
    };
  }

  // Accepts: Script-1 gantt_json, flat array, legacy combined string,
  //          or {dispatch_date, processes:[...]}.
  // Returns { dispatchIso|null, processes:[...] } or null.
  function normalizePlan(plan) {
    if (!plan) return null;

    if (typeof plan === 'string') {
      const combined = parseCombinedString(plan);
      return {
        dispatchIso: combined.dispatch ? isoFromMs(startOfUTCDay(combined.dispatch)) : null,
        processes: combined.processes.map((p, i) => flatProcess(p, i)),
      };
    }

    if (Array.isArray(plan)) {
      return { dispatchIso: null, processes: plan.map((p, i) => flatProcess(p, i)) };
    }

    if (plan.items && Array.isArray(plan.items)) {
      const processes = [];
      for (const item of plan.items) {
        const phase = parsePhase(item.phase_number);
        for (const pr of (item.processes || [])) {
          const name = pr.label || pr.process_name || pr.name || 'Unnamed';
          const sRaw = pr.start || pr.start_date;
          const eRaw = pr.end || pr.end_date;
          const sd = new Date(sRaw);
          const ed = new Date(eRaw);
          if (isNaN(sd.getTime()) || isNaN(ed.getTime())) {
            throw new Error('Invalid date for "' + name + '"');
          }
          processes.push({
            key: String(pr.process_row_id || name),
            name: String(name),
            phase,
            startIso: isoFromMs(startOfUTCDay(sd)),
            endIso: isoFromMs(startOfUTCDay(ed)),
            isCompleted: readCompletedFlag(pr),
          });
        }
      }
      return {
        dispatchIso: plan.dispatch_date ? String(plan.dispatch_date).slice(0, 10) : null,
        processes,
      };
    }

    if (plan.processes && Array.isArray(plan.processes)) {
      return {
        dispatchIso: plan.dispatch_date ? String(plan.dispatch_date).slice(0, 10) : null,
        processes: plan.processes.map((p, i) => flatProcess(p, i)),
      };
    }

    throw new Error('Unrecognized plan shape.');
  }

  // ───────────────────────── demo
  function loadDemo() {
    const approvedDemo = {
      dispatch_date: '2026-06-15',
      items: [
        { phase_number: 1, processes: [
          { process_row_id: 'a1', label: 'RM Procurement', start: '2026-05-08', end: '2026-05-14', is_completed: true },
          { process_row_id: 'a2', label: 'Laser cutting', start: '2026-05-12', end: '2026-05-18', is_completed: true },
        ]},
        { phase_number: 3, processes: [
          { process_row_id: 'a3', label: 'Turning — Machining', start: '2026-05-20', end: '2026-05-30', is_completed: true },
        ]},
        { phase_number: 5, processes: [
          { process_row_id: 'a7', label: 'Acid Cleaning', start: '2026-06-01', end: '2026-06-06' },
        ]},
        { phase_number: 6, processes: [
          { process_row_id: 'a4', label: 'Bead Blast', start: '2026-06-08', end: '2026-06-10' },
        ]},
        { phase_number: 'Final', processes: [
          { process_row_id: 'a5', label: 'Final QC & Packaging', start: '2026-06-11', end: '2026-06-13' },
          { process_row_id: 'a6', label: 'Finishing', start: '2026-06-17', end: '2026-06-19' },
        ]},
      ],
    };
    const candidateDemo = JSON.parse(JSON.stringify(approvedDemo));
    candidateDemo.items[4].processes[0].end = '2026-06-21';
    candidateDemo.items[3].processes[0].start = '2026-06-09';
    candidateDemo.items[3].processes[0].end = '2026-06-11';
    candidateDemo.items[4].processes.push({ process_row_id: 'n1', label: 'Extra inspection', start: '2026-06-19', end: '2026-06-20' });

    _approved = normalizePlan(approvedDemo);
    _candidate = normalizePlan(candidateDemo);
    _todayIso = '2026-06-10';
    _usingDemo = true;
  }

  // ───────────────────────── public: load
  function loadFromUrl() {
    try {
      const params = new URLSearchParams(location.search);
      if (params.get('dmy') === '0') _dateFmtDMY = false;
      const v = params.get('view');
      if (v === 'approved' || v === 'diff') _view = v;
      const todayOverride = params.get('today');

      const raw = readPayload();
      if (!raw) {
        loadDemo();
        if (todayOverride) _todayIso = todayOverride;
        return { ok: true, source: 'demo' };
      }

      const decoded = decodePayload(raw);

      // Try format A: JSON object with approved/candidate keys
      let parsedAsObject = null;
      if (decoded.trim()[0] === '{') {
        try {
          const obj = JSON.parse(decoded);
          if (obj && (Object.prototype.hasOwnProperty.call(obj, 'approved') || Object.prototype.hasOwnProperty.call(obj, 'candidate'))) {
            parsedAsObject = obj;
          } else if (obj && obj.items) {
            // Format B: a single gantt_json
            parsedAsObject = { approved: obj, candidate: null };
          }
        } catch (e) { /* fall through to legacy */ }
      }

      if (parsedAsObject) {
        _approved = normalizePlan(parsedAsObject.approved);
        _candidate = normalizePlan(parsedAsObject.candidate);
        if (parsedAsObject.today) _todayIso = parsedAsObject.today;
      } else {
        // Format C: legacy combined string → approved only
        _approved = normalizePlan(decoded);
        _candidate = null;
      }

      if (!_approved && !_candidate) throw new Error('Payload contains no plan.');
      if (!_approved) { _approved = _candidate; _candidate = null; }

      if (!_todayIso) _todayIso = todayOverride || isoFromMs(startOfUTCDay(new Date()));
      else if (todayOverride) _todayIso = todayOverride;

      _usingDemo = false;
      _loadError = null;
      return { ok: true, source: 'url' };
    } catch (e) {
      _loadError = e.message || String(e);
      return { ok: false, error: _loadError };
    }
  }

  function getError() { return _loadError; }

  // ───────────────────────── status (flag-driven completion)
  function deriveStatus(start, end, today, isCompleted) {
    if (isCompleted) return 'completed';
    if (today < start) return 'upcoming';
    if (today > end) return 'overdue';      // end passed, flag not set → late, NOT done
    return 'active';
  }

  // ───────────────────────── build
  function build() {
    if (_loadError) return null;

    const today = toMs(_todayIso);
    const diffRequested = _view === 'diff' || (_view === 'auto' && !!_candidate);
    const diffMode = diffRequested && !!_candidate;

    const dispatchIso = (diffMode && _candidate.dispatchIso) || _approved.dispatchIso || (_candidate && _candidate.dispatchIso);

    // Match approved↔candidate by process_row_id first; if the two plans key
    // differently (e.g. approved is a legacy string with no IDs, candidate has
    // IDs), fall back to matching by normalized name so the diff still works.
    const norm = (s) => String(s || '').trim().toLowerCase();
    const apById = new Map(_approved.processes.map(p => [p.key, p]));
    const apByName = new Map(_approved.processes.map(p => [norm(p.name), p]));
    const cdById = _candidate ? new Map(_candidate.processes.map(p => [p.key, p])) : new Map();
    const cdByName = _candidate ? new Map(_candidate.processes.map(p => [norm(p.name), p])) : new Map();

    const matchApproved = (p) => apById.get(p.key) || apByName.get(norm(p.name)) || null;
    const matchCandidateExists = (ap) => cdById.has(ap.key) || cdByName.has(norm(ap.name));

    const displayProcs = diffMode ? _candidate.processes : _approved.processes;
    const rows = [];
    const matchedApprovedKeys = new Set();

    for (const p of displayProcs) {
      const ap = diffMode ? matchApproved(p) : null;
      let diffStatus = 'unchanged';
      let ghost = null;
      if (diffMode) {
        if (!ap) diffStatus = 'added';
        else {
          matchedApprovedKeys.add(ap.key);
          if (ap.startIso !== p.startIso || ap.endIso !== p.endIso) {
            diffStatus = 'changed';
            ghost = { start: toMs(ap.startIso), end: toMs(ap.endIso) };
          }
        }
      }
      rows.push({
        key: p.key, name: p.name, phase: p.phase,
        start: toMs(p.startIso), end: toMs(p.endIso),
        isCompleted: p.isCompleted, diffStatus, ghost,
      });
    }

    if (diffMode) {
      for (const ap of _approved.processes) {
        // Removed only if neither its id nor its name matched a candidate process
        if (!matchedApprovedKeys.has(ap.key) && !matchCandidateExists(ap)) {
          rows.push({
            key: ap.key, name: ap.name, phase: ap.phase,
            start: toMs(ap.startIso), end: toMs(ap.endIso),
            isCompleted: ap.isCompleted, diffStatus: 'removed', ghost: null,
          });
        }
      }
    }

    const allStarts = rows.map(r => r.start).concat(rows.filter(r => r.ghost).map(r => r.ghost.start));
    const allEnds = rows.map(r => r.end).concat(rows.filter(r => r.ghost).map(r => r.ghost.end));
    const projStart = Math.min(...allStarts);
    const projEnd = Math.max(...allEnds);
    const dispatch = dispatchIso ? toMs(dispatchIso) : projEnd;

    const procs = rows.map(r => {
      if (r.diffStatus === 'removed') {
        return { ...r, status: 'removed', overshoots: false, overshootDays: 0, overdueDays: 0 };
      }
      const status = deriveStatus(r.start, r.end, today, r.isCompleted);
      const overshoots = r.end > dispatch && !r.isCompleted;
      const overshootDays = overshoots ? daysBetween(dispatch, r.end) : 0;
      const overdueDays = status === 'overdue' ? daysBetween(r.end, today) : 0;
      const totalDays = daysBetween(r.start, r.end) + 1;
      const progress = status === 'active'
        ? Math.max(0, Math.min(1, (daysBetween(r.start, today) + 1) / totalDays))
        : (status === 'completed' ? 1 : 0);
      return { ...r, status, overshoots, overshootDays, overdueDays, progress };
    });

    procs.sort((a, b) => a.phase - b.phase || a.start - b.start);

    const livingProcs = procs.filter(p => p.diffStatus !== 'removed');
    const planEnd = Math.max(...livingProcs.map(p => p.end));
    const approvedEnd = Math.max(..._approved.processes.map(p => toMs(p.endIso)));
    const dispatchDeltaDays = daysBetween(dispatch, planEnd);
    const endShiftDays = diffMode ? daysBetween(approvedEnd, planEnd) : 0;

    return {
      diffMode, today, dispatch,
      projStart, projEnd,
      processes: procs,
      dispatchDeltaDays, endShiftDays,
      daysToDispatch: daysBetween(today, dispatch),
      usingDemo: _usingDemo,
      MS_DAY,
    };
  }

  return { loadFromUrl, build, getError, fmt, toMs, daysBetween, addDays, isoFromMs, MS_DAY };
})();
