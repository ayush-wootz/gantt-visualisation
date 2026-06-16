// gantt-edit-data.js — data layer for the editable Gantt.
//
// Responsibilities:
//   1. Load plan data from #data= / ?data= (edit.html payload shape:
//      { approved, candidate, meta } or a bare gantt_json) — falls back to demo.
//   2. Derive phase windows (the AI plan's planned span per phase).
//   3. status() — completed / delayed / active / upcoming from dates + done flag.
//   4. cascade() — simulates the AI regeneration: staged edits that extend a
//      phase window shift every non-done process in later phases by the
//      extension, producing a candidate plan + ghosts of the old dates.
//   5. fixtures() — canned states for the design-states canvas (?state=…).

window.GanttEditData = (function () {
  const MS_DAY = 86400000;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // ── phase ranking ───────────────────────────────────────────────────────
  // Text phases ("Final", "Pre-final") must always sort AFTER numbered phases.
  // RM procurement "0" stays first. Returns a sortable number; phaseLabel()
  // gives the human-facing label.
  function phaseRank(phase) {
    const s = String(phase == null ? '' : phase).toLowerCase().trim();
    if (s === 'final') return 9999;
    if (s === 'pre-final' || s === 'prefinal' || s === 'pre final') return 9998;
    const n = parseInt(s, 10);
    return isNaN(n) ? 9997 : n;
  }
  function phaseLabel(phase) {
    const s = String(phase == null ? '' : phase).trim();
    const low = s.toLowerCase();
    if (low === 'final') return 'FINAL';
    if (low === 'pre-final' || low === 'prefinal' || low === 'pre final') return 'PRE-FINAL';
    // numeric or anything else → "PHASE n"
    return 'PHASE ' + s;
  }

  // ── demo plan (deterministic: today is pinned) ──────────────────────────
  const TODAY_DEFAULT = '2026-06-22';
  const DISPATCH_DEFAULT = '2026-08-15';
  const DEMO = [
    { id: 'p1',  name: 'Design review',            phase: 1, phaseLabel: 'PHASE 1', start: '2026-05-15', end: '2026-05-22', done: true,  completedOn: '2026-05-22' },
    { id: 'p2',  name: 'BOM finalization',         phase: 1, phaseLabel: 'PHASE 1', start: '2026-05-20', end: '2026-06-01', done: true,  completedOn: '2026-06-01' },
    { id: 'p3',  name: 'Raw material procurement', phase: 2, phaseLabel: 'PHASE 2', start: '2026-05-25', end: '2026-06-18', done: true,  completedOn: '2026-06-18' },
    { id: 'p4',  name: 'Vendor confirm',           phase: 2, phaseLabel: 'PHASE 2', start: '2026-06-01', end: '2026-06-20', done: false, completedOn: null },
    { id: 'p5',  name: 'CNC machining',            phase: 3, phaseLabel: 'PHASE 3', start: '2026-06-12', end: '2026-07-05', done: false, completedOn: null },
    { id: 'p6',  name: 'Sheet metal fab',          phase: 3, phaseLabel: 'PHASE 3', start: '2026-06-18', end: '2026-07-08', done: false, completedOn: null },
    { id: 'p7',  name: 'Welding',                  phase: 3, phaseLabel: 'PHASE 3', start: '2026-06-28', end: '2026-07-10', done: false, completedOn: null },
    { id: 'p8',  name: 'Surface treatment',        phase: 4, phaseLabel: 'PHASE 4', start: '2026-07-05', end: '2026-07-18', done: false, completedOn: null },
    { id: 'p9',  name: 'Sub-assembly',             phase: 5, phaseLabel: 'PHASE 5', start: '2026-07-15', end: '2026-07-28', done: false, completedOn: null },
    { id: 'p10', name: 'Final assembly',           phase: 5, phaseLabel: 'PHASE 5', start: '2026-07-28', end: '2026-08-09', done: false, completedOn: null },
    { id: 'p11', name: 'QC & testing',             phase: 6, phaseLabel: 'PHASE 6', start: '2026-08-06', end: '2026-08-15', done: false, completedOn: null },
    { id: 'p12', name: 'Packing & dispatch',       phase: 6, phaseLabel: 'PHASE 6', start: '2026-08-14', end: '2026-08-18', done: false, completedOn: null },
  ];

  // ── date helpers ────────────────────────────────────────────────────────
  function toMs(iso) {
    const p = String(iso).slice(0, 10).split('-').map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2]);
  }
  function isoFromMs(ms) {
    const d = new Date(ms);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function fmt(iso, opts) {
    opts = opts || {};
    const d = new Date(toMs(iso));
    if (opts.month) return MONTHS[d.getUTCMonth()];
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  }
  function fmtRange(a, b) { return fmt(a) + ' \u2013 ' + fmt(b); }
  function daysBetween(a, b) { return Math.round((toMs(b) - toMs(a)) / MS_DAY); }
  function durDays(a, b) { return daysBetween(a, b) + 1; }
  function addDays(iso, n) { return isoFromMs(toMs(iso) + n * MS_DAY); }

  // ── status ──────────────────────────────────────────────────────────────
  function status(p, today) {
    if (p.done) return 'completed';
    if (toMs(p.end) < toMs(today)) return 'delayed';
    if (toMs(p.start) <= toMs(today)) return 'active';
    return 'upcoming';
  }

  // Phases keyed by rank now, carrying their display label.
  function derivePhases(procs) {
    const m = {};
    procs.forEach(function (p) {
      const w = m[p.phase] || (m[p.phase] = { num: p.phase, label: p.phaseLabel || ('PHASE ' + p.phase), start: p.start, end: p.end });
      if (toMs(p.start) < toMs(w.start)) w.start = p.start;
      if (toMs(p.end) > toMs(w.end)) w.end = p.end;
    });
    return Object.values(m).sort(function (a, b) { return a.num - b.num; });
  }

  // ── payload parsing (edit.html-compatible) ──────────────────────────────
  let _today = TODAY_DEFAULT, _dispatch = DISPATCH_DEFAULT, _procs = DEMO;
  let _source = 'demo', _meta = {}, _phaseWin = null, _loaded = null;
  let _candidateProcs = null;

  function parseItems(plan) {
    const procs = [], phaseWin = {};
    (plan.items || []).forEach(function (ph) {
      const rawPhase = ph.phase_number != null ? ph.phase_number : (ph.phase != null ? ph.phase : 0);
      const rank = phaseRank(rawPhase);
      const label = phaseLabel(rawPhase);
      if (ph.start && ph.end) phaseWin[rank] = { num: rank, label: label, start: String(ph.start).slice(0, 10), end: String(ph.end).slice(0, 10) };
      (ph.processes || []).forEach(function (p, i) {
        const s = p.start || p.start_date, e = p.end || p.end_date;
        if (!s || !e) return;
        // process may carry its own phase_number; prefer it, else inherit parent
        const pRaw = p.phase_number != null ? p.phase_number : rawPhase;
        procs.push({
          id: p.process_row_id || p.id || ('ph' + rank + '-' + i),
          name: p.label || p.process_name || p.name || 'Process',
          phase: phaseRank(pRaw),
          phaseLabel: phaseLabel(pRaw),
          start: String(s).slice(0, 10),
          end: String(e).slice(0, 10),
          done: !!(p.is_completed || p.completed || p.Completed),
          completedOn: p.completed_on || null,
        });
      });
    });
    return { procs: procs, phaseWin: phaseWin };
  }

  function loadFromUrl() {
    try {
      let raw = '';
      if (location.hash) {
        const h = location.hash.replace(/^#/, '');
        const m = h.match(/(?:^|&)data=([^&]+)/);
        raw = m ? decodeURIComponent(m[1]) : '';
      }
      if (!raw && location.search) raw = new URLSearchParams(location.search).get('data') || '';
      const todayParam = new URLSearchParams(location.search).get('today');
      if (!raw) { if (todayParam) _today = todayParam; return; }
      let txt = raw.trim();
      if (txt[0] !== '{' && txt[0] !== '[') {
        let b64 = txt.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        txt = decodeURIComponent(escape(atob(b64)));
      }
      const json = JSON.parse(txt);
      const approvedPlan = json.approved || json;
      const candidatePlan = json.candidate || null;
      const plan = approvedPlan;
      const parsed = parseItems(plan);
      if (!parsed.procs.length) return;
      _procs = parsed.procs;
      _source = 'url';
      _meta = json.meta || {};
      _dispatch = (_meta.dispatch_date || plan.dispatch_date || DISPATCH_DEFAULT).slice(0, 10);
      _phaseWin = Object.keys(parsed.phaseWin).length ? parsed.phaseWin : null;
      _today = todayParam || new Date().toISOString().slice(0, 10);
      if (candidatePlan) {
        const cp = parseItems(candidatePlan);
        _candidateProcs = cp.procs.length ? cp.procs : null;
      } else {
        _candidateProcs = null;
      }
    } catch (e) {
      console.warn('GanttEditData: payload parse failed, using demo.', e);
    }
  }

  function load() {
    if (_loaded) return _loaded;
    loadFromUrl();
    const procs = _procs.map(function (p) { return Object.assign({}, p); });
    const phases = _phaseWin
      ? Object.values(_phaseWin).sort(function (a, b) { return a.num - b.num; })
      : derivePhases(procs);
    _loaded = { procs: procs, phases: phases, today: _today, dispatch: _dispatch, source: _source, meta: _meta, candidateProcs: _candidateProcs };
    return _loaded;
  }

  // ── AI cascade simulation ────────────────────────────────────────────────
  function cascade(procs, phases, staged) {
    const map = {};
    procs.forEach(function (p) { map[p.id] = Object.assign({}, p); });
    const editedIds = Object.keys(staged).filter(function (id) { return map[id]; });
    editedIds.forEach(function (id) {
      const e = staged[id];
      if (e.start) map[id].start = e.start;
      if (e.end) map[id].end = e.end;
    });

    let shift = 0, minPhase = Infinity;
    editedIds.forEach(function (id) {
      const p = map[id];
      const win = phases.find(function (w) { return w.num === p.phase; });
      if (!win) return;
      const ext = daysBetween(win.end, p.end);
      if (ext > 0) { if (ext > shift) shift = ext; if (p.phase < minPhase) minPhase = p.phase; }
      if (daysBetween(p.start, win.start) > 0 && p.phase < minPhase) minPhase = p.phase;
    });

    const shiftedIds = [];
    if (shift > 0 && minPhase < Infinity) {
      Object.values(map).forEach(function (p) {
        if (p.done || p.phase <= minPhase || editedIds.indexOf(p.id) >= 0) return;
        p.start = addDays(p.start, shift);
        p.end = addDays(p.end, shift);
        shiftedIds.push(p.id);
      });
    }

    const ghosts = {};
    procs.forEach(function (p) {
      const q = map[p.id];
      if (q.start !== p.start || q.end !== p.end) ghosts[p.id] = { start: p.start, end: p.end };
    });

    return {
      procs: procs.map(function (p) { return map[p.id]; }),
      editedIds: editedIds,
      shiftedIds: shiftedIds,
      shiftDays: shift,
      ghosts: ghosts,
    };
  }

  // ── canned states for the design canvas ─────────────────────────────────
  function fixtures(kind, state) {
    if (!kind || kind === 'view') return {};
    const procs = state.procs.map(function (p) { return Object.assign({}, p); });
    const phases = state.phases, today = state.today;
    const act = procs.filter(function (p) { return status(p, today) === 'active'; });
    const up = procs.filter(function (p) { return status(p, today) === 'upcoming'; });
    const tgtPop = act[0] || up[0] || procs[0];
    const tgtDrag = act[1] || act[0] || procs[0];
    const tgtAI = up[0] || act[0] || procs[0];
    function winOf(n) { return phases.find(function (w) { return w.num === n; }); }

    if (kind === 'popover') return { pop: { id: tgtPop.id, expand: true } };

    if (kind === 'edit') {
      const w = winOf(tgtAI.phase);
      let s = addDays(tgtAI.start, -2);
      if (toMs(s) < toMs(w.start)) s = w.start;
      const e = addDays(tgtAI.end, -2);
      const moved = procs.map(function (p) { return p.id === tgtAI.id ? Object.assign({}, p, { start: s, end: e }) : p; });
      return { mode: 'edit', procs: moved, toast: { tone: 'ok', text: '\u2713 ' + tgtAI.name + ' \u2192 ' + fmtRange(s, e) + ' — inside the ' + (tgtAI.phaseLabel || 'phase') + ' window, saved instantly.' } };
    }

    if (kind === 'drag') {
      const s = addDays(tgtDrag.start, 2), e = addDays(tgtDrag.end, 2);
      const w = winOf(tgtDrag.phase);
      const out = toMs(s) < toMs(w.start) || toMs(e) > toMs(w.end);
      return { mode: 'edit', fakeDrag: { id: tgtDrag.id, start: s, end: e, out: out } };
    }

    if (kind === 'ai') {
      const w = winOf(tgtAI.phase);
      const st = {}; st[tgtAI.id] = { start: tgtAI.start, end: addDays(w.end, 6) };
      return { mode: 'edit', staged: st, toast: { tone: 'ai', text: tgtAI.name + ' now extends the ' + (tgtAI.phaseLabel || 'phase') + ' window — staged for AI regeneration.' } };
    }

    if (kind === 'regen') return { veil: 'Recomputing downstream phases\u2026' };

    if (kind === 'candidate') {
      const w = winOf(tgtAI.phase);
      const st = {}; st[tgtAI.id] = { start: tgtAI.start, end: addDays(w.end, 6) };
      return { candidate: cascade(procs, phases, st), toast: { tone: 'ai', text: 'Candidate ready — review the cascaded dates, then approve to go live.' } };
    }

    return {};
  }

  return {
    load: load, fixtures: fixtures, cascade: cascade, derivePhases: derivePhases,
    status: status, toMs: toMs, isoFromMs: isoFromMs, fmt: fmt, fmtRange: fmtRange,
    daysBetween: daysBetween, durDays: durDays, addDays: addDays, MONTHS: MONTHS,
    phaseRank: phaseRank, phaseLabel: phaseLabel,
  };
})();
