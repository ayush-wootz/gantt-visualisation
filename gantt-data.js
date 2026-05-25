// gantt-data.js
//
// Provides window.GanttData with two responsibilities:
//   1. Load schedule data — either from URL query/hash (?data=… or #data=…)
//      or fall back to a built-in demo so previewing the file alone works.
//   2. Derive status (completed / active / upcoming / overshoot) from dates.
//
// URL data format (same as the original index.html — fully backwards-compat):
//
//   ?data=<dispatch>, {process}, {process}, ...
//   ?data=[<process>, <process>, ...]          (no dispatch)
//   #data=<base64-of-above>
//
//   <dispatch>  e.g. "8/15/2026, 12:00:00 AM"  (D/M/YYYY by default)
//   <process>   { Name, Phase, "Start date", "End date" }   (any case)
//
// Optional URL params (additions):
//   &today=YYYY-MM-DD       Override "today" for screenshots/demos.
//   &dmy=0                  Switch date format to M/D/YYYY.

window.GanttData = (function () {
  const MS_DAY = 86400000;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // ───────────────────────────────── Defaults / demo data
  const TODAY_DEFAULT    = '2026-06-22';
  const DISPATCH_DEFAULT = '2026-08-15';
  const PROCESSES_DEFAULT = [
    { name: 'Design review',             phase: 1, start: '2026-05-15', end: '2026-05-22' },
    { name: 'BOM finalization',          phase: 1, start: '2026-05-20', end: '2026-06-01' },
    { name: 'Raw material procurement',  phase: 2, start: '2026-05-25', end: '2026-06-18' },
    { name: 'Vendor confirm',            phase: 2, start: '2026-06-01', end: '2026-06-20' },
    { name: 'CNC machining',             phase: 3, start: '2026-06-12', end: '2026-07-05' },
    { name: 'Sheet metal fab',           phase: 3, start: '2026-06-18', end: '2026-07-08' },
    { name: 'Welding',                   phase: 3, start: '2026-06-28', end: '2026-07-10' },
    { name: 'Surface treatment',         phase: 4, start: '2026-07-05', end: '2026-07-18' },
    { name: 'Sub-assembly',              phase: 5, start: '2026-07-15', end: '2026-07-28' },
    { name: 'Final assembly',            phase: 5, start: '2026-07-28', end: '2026-08-09' },
    { name: 'QC & testing',              phase: 6, start: '2026-08-06', end: '2026-08-15' },
    { name: 'Packing & dispatch',        phase: 6, start: '2026-08-14', end: '2026-08-18' },
  ];

  // Phase metadata used by the renderer. The 'color' here is no longer
  // applied to bars (status drives bar color) — it is only kept for the
  // tiny optional accent on phase headers. Phases beyond the table fall
  // back to a generic entry from getPhase().
  // Phase names are intentionally generic — bar color is driven by status,
  // not by phase, so we only need a stable color per phase number for any
  // future accent use. Display name is always "Phase N".
  const PHASE_COLORS = ['#6366f1', '#0ea5e9', '#f59e0b', '#8b5cf6', '#10b981', '#d946ef', '#14b8a6', '#f43f5e'];
  function getPhase(num) {
    const color = PHASE_COLORS[(num - 1) % PHASE_COLORS.length] || '#71717a';
    return { num, name: 'Phase ' + num, color };
  }

  // ───────────────────────────────── Mutable current state
  let _todayIso    = TODAY_DEFAULT;
  let _dispatchIso = DISPATCH_DEFAULT;
  let _processes   = PROCESSES_DEFAULT;
  let _loadError   = null;
  let _usingDemo   = true;
  let _dateFmtDMY  = true;

  // ───────────────────────────────── Helpers
  function toMs(iso) {
    if (iso instanceof Date) return Date.UTC(iso.getUTCFullYear(), iso.getUTCMonth(), iso.getUTCDate());
    const [y, m, d] = String(iso).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }
  function startOfUTCDay(d) {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  function fmt(ms, opts = {}) {
    const d = new Date(ms);
    if (opts.full)     return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
    if (opts.short)    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
    if (opts.day)      return d.getUTCDate();
    if (opts.dayShort) return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
    if (opts.month)    return MONTHS[d.getUTCMonth()];
    if (opts.weekday)  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  }
  function daysBetween(a, b) { return Math.round((b - a) / MS_DAY); }
  function addDays(ms, n)    { return ms + n * MS_DAY; }
  function isoFromMs(ms) {
    const d = new Date(ms);
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return d.getUTCFullYear() + '-' + m + '-' + dd;
  }

  // ───────────────────────────────── URL parsing (ported from original)
  function readPayload() {
    let raw = '';
    if (location.hash) {
      const h = location.hash.replace(/^#/, '');
      const m = h.match(/(?:^|&)data=([^&]+)/);
      if (m) raw = decodeURIComponent(m[1]);
      else raw = decodeURIComponent(h);
    } else if (location.search) {
      const params = new URLSearchParams(location.search);
      raw = params.get('data') || '';
    }
    return raw || null;
  }

  function decodePayload(raw) {
    const trimmed = raw.trim();
    if (trimmed[0] === '{' || trimmed[0] === '[' || /^\d/.test(trimmed)) return trimmed;
    try {
      let b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      return decodeURIComponent(escape(atob(b64)));
    } catch (e) {
      return trimmed;
    }
  }

  function parseDispatchDate(s) {
    s = s.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const d = new Date(s);
      if (!isNaN(d.getTime())) return d;
    }
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
    if (m) {
      let part1 = parseInt(m[1], 10);
      let part2 = parseInt(m[2], 10);
      const year = parseInt(m[3], 10);
      let day, month;
      if (_dateFmtDMY) { day = part1; month = part2 - 1; }
      else            { month = part1 - 1; day = part2; }
      let hour = m[4] ? parseInt(m[4], 10) : 0;
      const min = m[5] ? parseInt(m[5], 10) : 0;
      const sec = m[6] ? parseInt(m[6], 10) : 0;
      const ampm = m[7] ? m[7].toUpperCase() : null;
      if (ampm === 'PM' && hour < 12) hour += 12;
      if (ampm === 'AM' && hour === 12) hour = 0;
      const d = new Date(Date.UTC(year, month, day, hour, min, sec));
      if (!isNaN(d.getTime())) return d;
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
    throw new Error('Could not parse dispatch date: "' + s + '"');
  }

  function parseCombined(text) {
    text = text.trim();
    if (text.startsWith('[')) return { dispatch: null, processes: JSON.parse(text) };
    const firstBrace = text.indexOf('{');
    if (firstBrace < 0) throw new Error('No process JSON found in input.');
    let dispatchStr = '';
    let processStr  = '';
    if (firstBrace === 0) processStr = text;
    else {
      dispatchStr = text.slice(0, firstBrace).replace(/,\s*$/, '').trim();
      processStr  = text.slice(firstBrace).trim();
    }
    if (processStr.startsWith('{')) processStr = '[' + processStr + ']';
    const processes = JSON.parse(processStr);
    const dispatch  = dispatchStr ? parseDispatchDate(dispatchStr) : null;
    return { dispatch, processes };
  }

  function normalize(arr) {
    if (!Array.isArray(arr)) {
      if (arr && typeof arr === 'object') arr = [arr];
      else throw new Error('Process input is not an array');
    }
    return arr.map((p, i) => {
      const name = p.Name || p.name || p.process || ('Process ' + (i + 1));
      const sRaw = p['Start date'] || p.start_date || p.startDate || p.start;
      const eRaw = p['End date']   || p.end_date   || p.endDate   || p.end;
      const phaseRaw = p.Phase !== undefined ? p.Phase : (p.phase !== undefined ? p.phase : 1);
      const phase = parseInt(phaseRaw, 10) || 1;
      const sd = new Date(sRaw);
      const ed = new Date(eRaw);
      if (isNaN(sd.getTime()) || isNaN(ed.getTime())) {
        throw new Error('Invalid date for "' + name + '" (start="' + sRaw + '", end="' + eRaw + '")');
      }
      return {
        name: String(name),
        phase,
        startIso: isoFromMs(startOfUTCDay(sd)),
        endIso:   isoFromMs(startOfUTCDay(ed)),
      };
    });
  }

  // ───────────────────────────────── Public: load from URL
  function loadFromUrl() {
    try {
      // Optional date-format flag
      const params = new URLSearchParams(location.search);
      if (params.get('dmy') === '0') _dateFmtDMY = false;

      // Optional today override (handy for screenshots/demos)
      const todayOverride = params.get('today');
      if (todayOverride) _todayIso = todayOverride;
      else _todayIso = isoFromMs(startOfUTCDay(new Date())); // real today by default in URL mode

      const raw = readPayload();
      if (!raw) {
        // No URL data → keep demo defaults (and a fixed demo today).
        _usingDemo = true;
        _todayIso = TODAY_DEFAULT;
        return { ok: true, source: 'demo' };
      }

      const decoded = decodePayload(raw);
      const combined = parseCombined(decoded);
      const processes = normalize(combined.processes);

      _processes = processes;
      if (combined.dispatch) _dispatchIso = isoFromMs(startOfUTCDay(combined.dispatch));
      _usingDemo = false;
      _loadError = null;
      return { ok: true, source: 'url' };
    } catch (e) {
      _loadError = e.message || String(e);
      _usingDemo = false;
      return { ok: false, error: _loadError };
    }
  }

  // Programmatic setter (alternative to URL loading).
  function setData({ processes, dispatch, today }) {
    if (processes) _processes = normalize(processes);
    if (dispatch)  _dispatchIso = typeof dispatch === 'string' ? dispatch : isoFromMs(startOfUTCDay(new Date(dispatch)));
    if (today)     _todayIso    = typeof today    === 'string' ? today    : isoFromMs(startOfUTCDay(new Date(today)));
    _usingDemo = false;
    _loadError = null;
  }

  // ───────────────────────────────── Core: build enriched dataset
  function build() {
    if (_loadError) return null;
    const today    = toMs(_todayIso);
    const dispatch = toMs(_dispatchIso);

    const procs = _processes.map(p => {
      const start = toMs(p.startIso || p.start);
      const end   = toMs(p.endIso   || p.end);
      const totalDays = daysBetween(start, end) + 1;

      let status, progressDays;
      if (today > end)         { status = 'completed'; progressDays = totalDays; }
      else if (today < start)  { status = 'upcoming';  progressDays = 0; }
      else                     { status = 'active';    progressDays = daysBetween(start, today) + 1; }

      const progress       = Math.max(0, Math.min(1, progressDays / totalDays));
      const overshoots     = end > dispatch;
      const overshootDays  = overshoots ? daysBetween(dispatch, end) : 0;

      return {
        name: p.name, phase: p.phase,
        start, end, totalDays, status, progress, progressDays,
        overshoots, overshootDays,
      };
    });

    // Project-wide bounds
    const projStart = Math.min(...procs.map(p => p.start));
    const projEnd   = Math.max(...procs.map(p => p.end));
    const totalDays = daysBetween(projStart, projEnd) + 1;
    const elapsedDays = Math.max(0, Math.min(totalDays, daysBetween(projStart, today) + 1));
    const projProgress = elapsedDays / totalDays;

    // Phase aggregates
    const phaseGroups = {};
    procs.forEach(p => { (phaseGroups[p.phase] = phaseGroups[p.phase] || []).push(p); });
    const phases = Object.keys(phaseGroups).map(k => +k).sort((a, b) => a - b).map(num => {
      const list = phaseGroups[num];
      const start = Math.min(...list.map(p => p.start));
      const end   = Math.max(...list.map(p => p.end));
      const meta  = getPhase(num);
      let status;
      if (list.every(p => p.status === 'completed')) status = 'completed';
      else if (today > end)                          status = 'completed';
      else if (today < start)                        status = 'upcoming';
      else                                           status = 'active';
      const totalDaysP   = daysBetween(start, end) + 1;
      const progressDays = status === 'completed' ? totalDaysP :
                           status === 'upcoming'  ? 0 :
                           daysBetween(start, today) + 1;
      const progress = Math.max(0, Math.min(1, progressDays / totalDaysP));
      return {
        num, name: meta.name, color: meta.color,
        start, end, totalDays: totalDaysP, processes: list, status, progress, progressDays,
      };
    });

    const slackDays      = daysBetween(projEnd, dispatch);
    const daysToDispatch = daysBetween(today, dispatch);

    return {
      today, dispatch,
      projStart, projEnd, totalDays, elapsedDays, projProgress,
      processes: procs, phases,
      slackDays, daysToDispatch,
      MS_DAY,
      usingDemo: _usingDemo,
    };
  }

  function getError() { return _loadError; }

  return {
    build, loadFromUrl, setData, getError, getPhase,
    fmt, toMs, daysBetween, addDays, isoFromMs,
    MS_DAY,
    // Back-compat alias (some old call sites read PHASE_META[n]):
    PHASE_META: new Proxy({}, { get: (_, k) => getPhase(+k) }),
  };
})();
