// gantt-edit.jsx — the editable Gantt component.
//
// Interactions:
//   VIEW  — click a bar → popover (details / mark complete / jump to edit).
//   EDIT  — drag a bar to move, drag its edges to resize, or click for exact
//           dates. The phase window (from the AI plan) is the rule:
//             · dates stay inside the window  → applies instantly, no AI
//             · dates stretch the window      → staged (indigo) → "Regenerate
//               with AI" builds a candidate plan with cascaded downstream shifts
//   CANDIDATE — ghost bars show the old dates; approve to go live or discard.

// ── CONFIG — set your endpoints here ──────────────────────────────────────
var GANTT_CONFIG = {
  SCHEDULE_URL:    'https://glide-gantt-ai-scheduler.onrender.com/schedule',
  SCHEDULE_SECRET: 'ayush_Wootz_2026',
  APPROVE_URL:     'https://glide-gantt-ai-scheduler.onrender.com/approve',
};

(function () {
  const { useState, useRef, useEffect, useMemo } = React;

  const ROW_H = 34, ROW_DONE = 22, PHASE_H = 26, BAR_H = 22, BAR_DONE = 8;
  const TOP = 56, GROUP_GAP = 8, BOT = 16;

  function GanttEdit({ forced, embed }) {
    const GD = window.GanttEditData;
    const C = window.GE_C;
    const D = useMemo(() => GD.load(), []);
    const fx = useMemo(() => GD.fixtures(forced, D), [forced]);

    const [procs, setProcs] = useState(() => fx.procs || D.procs);
    const [phases, setPhases] = useState(() => D.phases);
    const [mode, setMode] = useState(fx.mode || 'view');
    const [staged, setStaged] = useState(() => fx.staged || {});
    const [candidate, setCandidate] = useState(() => fx.candidate || null);
    const [veil, setVeil] = useState(fx.veil || null);
    const [pop, setPop] = useState(() => fx.pop || null);
    const [drag, setDrag] = useState(() => fx.fakeDrag || null);
    const [toast, setToast] = useState(() => fx.toast || null);
    const [cardW, setCardW] = useState(1200);
    const cardRef = useRef(null);
    const dragRef = useRef(null);
    const clickGuard = useRef(false);
    const timersRef = useRef([]);

    useEffect(() => {
      const el = cardRef.current;
      if (!el) return;
      const ro = new ResizeObserver((es) => { for (const en of es) setCardW(en.contentRect.width); });
      ro.observe(el);
      return () => ro.disconnect();
    }, []);
    useEffect(() => () => { timersRef.current.forEach((t) => { clearTimeout(t); clearInterval(t); }); }, []);

    // ── derived plan + time scale ─────────────────────────────────────────
    const shown = candidate ? candidate.procs : procs;
    const sorted = useMemo(
      () => [...shown].sort((a, b) => a.phase - b.phase || GD.toMs(a.start) - GD.toMs(b.start)),
      [shown]
    );

    let minS = D.dispatch, maxE = D.dispatch;
    const consider = (s, e) => {
      if (GD.toMs(s) < GD.toMs(minS)) minS = s;
      if (GD.toMs(e) > GD.toMs(maxE)) maxE = e;
    };
    sorted.forEach((p) => {
      consider(p.start, p.end);
      const st = staged[p.id];
      if (st) consider(st.start || p.start, st.end || p.end);
    });
    consider(D.today, D.today);
    const hasOver = sorted.some((p) => {
      const e = (staged[p.id] && staged[p.id].end) || p.end;
      return !p.done && GD.toMs(e) > GD.toMs(D.dispatch);
    });
    const tMin = GD.addDays(minS, -2);
    const tMax = GD.addDays(maxE, hasOver ? 9 : 4);
    const span = GD.daysBetween(tMin, tMax);
    const pct = (iso) => (GD.daysBetween(tMin, iso) / span) * 100;
    const wPct = (s, e) => ((GD.daysBetween(s, e) + 0.7) / span) * 100;
    const layerW = Math.max(640, cardW - 40);
    const dayPx = layerW / span;
    const todayPct = pct(D.today), dispPct = pct(D.dispatch);

    // ── row layout ────────────────────────────────────────────────────────
    const layout = [];
    let chartH = TOP + 140;
    {
      let y = TOP, last = -1;
      for (const p of sorted) {
        if (p.phase !== last) {
          if (last !== -1) y += GROUP_GAP;
          layout.push({ kind: 'phase', num: p.phase, y });
          y += PHASE_H;
          last = p.phase;
        }
        const h = p.done ? ROW_DONE : ROW_H;
        layout.push({ kind: 'proc', p, y, h });
        y += h;
      }
      chartH = Math.max(y + BOT, chartH);
    }

    const winOf = (num) => phases.find((w) => w.num === num) || { num, start: tMin, end: tMax };
    const outOf = (p, s, e) => {
      const w = winOf(p.phase);
      return GD.toMs(s) < GD.toMs(w.start) || GD.toMs(e) > GD.toMs(w.end);
    };

    // ── counts ────────────────────────────────────────────────────────────
    const cnt = { done: 0, active: 0, up: 0, late: 0, over: 0 };
    sorted.forEach((p) => {
      const s = GD.status(p, D.today);
      if (s === 'completed') cnt.done++;
      else if (s === 'active') cnt.active++;
      else if (s === 'upcoming') cnt.up++;
      else cnt.late++;
      if (!p.done && GD.toMs(p.end) > GD.toMs(D.dispatch)) cnt.over++;
    });
    const stagedN = Object.keys(staged).length;
    const dtd = GD.daysBetween(D.today, D.dispatch);

    // ── actions ───────────────────────────────────────────────────────────
    function commitDates(p, s, e) {
      if (s === p.start && e === p.end) {
        setStaged((prev) => { const n = Object.assign({}, prev); delete n[p.id]; return n; });
        return;
      }
      setStaged((prev) => Object.assign({}, prev, { [p.id]: { start: s, end: e } }));
      const ext = outOf(p, s, e);
      setToast({ tone: ext ? 'info' : 'ok', text: p.name + ' \u2192 ' + GD.fmtRange(s, e) + (ext ? ' \u00b7 extends Phase ' + p.phase + ', later steps shift when you save.' : ' \u00b7 save the plan to apply.') });
    }
    function clearStaged(id) {
      setStaged((prev) => { const n = Object.assign({}, prev); delete n[id]; return n; });
    }
    function enterEdit() { setMode('edit'); setToast(null); }
    function exitEdit() {
      const had = stagedN > 0;
      setMode('view'); setStaged({}); setPop(null); setDrag(null);
      if (had) setToast({ tone: 'warn', text: 'Edits discarded — plan unchanged.' });
    }
    function reopen(p) {
      setProcs((prev) => prev.map((x) => (x.id === p.id ? Object.assign({}, x, { done: false, completedOn: null }) : x)));
      setPop(null);
      setToast({ tone: 'ok', text: p.name + ' reopened — dates are editable again.' });
    }
    function complete(p, v) {
      const w = winOf(p.phase);
      if (GD.toMs(v) <= GD.toMs(w.end)) {
        setProcs((prev) => prev.map((x) => (x.id === p.id ? Object.assign({}, x, { done: true, completedOn: v, end: v }) : x)));
        setPop(null);
        setToast({ tone: 'ok', text: '\u2713 ' + p.name + ' marked complete (' + GD.fmt(v) + ').' });
      } else {
        setPop(null);
        runRegen({ [p.id]: { start: p.start, end: v } }, { id: p.id, on: v });
      }
    }

    // ── BUILD CONTEXT STRING for /schedule ─────────────────────────────────
    function buildContext(stagedMap, completion) {
      const parts = [];
      Object.keys(stagedMap).forEach(function(id) {
        const p = procs.find(function(x) { return x.id === id; });
        if (!p) return;
        const e = stagedMap[id];
        const bits = ['Change ' + p.name];
        if (e.start && e.start !== p.start) bits.push('start to ' + (e.start));
        if (e.end   && e.end   !== p.end)   bits.push('end to '   + (e.end));
        parts.push(bits.join(' '));
      });
      if (completion) {
        const cp = procs.find(function(x) { return x.id === completion.id; });
        if (cp) parts.push('Mark ' + cp.name + ' as complete. Actual finish date: ' + completion.on + ' (planned was ' + cp.end + ')');
      }
      parts.push('Recompute the downstream schedule to avoid overlaps and respect the dispatch date of ' + D.dispatch + '.');
      return parts.join('. ');
    }

    // ── runRegen: hits /schedule, returns candidate ───────────────────────
    function runRegen(stagedMap, completion) {
      setMode('view'); setPop(null); setDrag(null);

      const msgs = [
        'Saving changes\u2026',
        'Updating the schedule\u2026',
        'Rescheduling later steps\u2026',
        'Preparing the updated plan\u2026',
      ];
      let i = 0;
      setVeil(msgs[0]);
      const iv = setInterval(() => { i++; if (i < msgs.length) setVeil(msgs[i]); }, 950);
      timersRef.current.push(iv);

      // Build payload — same shape as the original /schedule call
      const meta = D.meta || {};
      const payload = {
        assembly_row_id:    meta.assembly_row_id    || '',
        assembly_number:    meta.assembly_number    || '',
        project_number:     meta.project_number     || '',
        dispatch_date:      meta.dispatch_date      || D.dispatch,
        planned_start_date: meta.planned_start_date || '',
        generated_by:       meta.generated_by       || '',
        draft_mode:         true,
        draft_row_id:       meta.draft_row_id       || '',
        update_glide:       true,
        context:            buildContext(stagedMap, completion),
        // Full current state so the backend/Claude has complete context
        current_processes:  procs.map(function(p) {
          return {
            process_row_id:   p.id,
            process_name:     p.name,
            phase_number:     String(p.phase),
            start_date:       p.start,
            end_date:         p.end,
            is_completed:     p.done,
            completed_on:     p.completedOn || null,
          };
        }),
      };

      fetch(GANTT_CONFIG.SCHEDULE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-schedule-secret': GANTT_CONFIG.SCHEDULE_SECRET,
        },
        body: JSON.stringify(payload),
      })
      .then(function(res) {
        if (!res.ok) return res.text().then(function(t) { throw new Error('HTTP ' + res.status + ': ' + t); });
        return res.json();
      })
      .then(function(data) {
        clearInterval(iv);

        // Update draft_row_id for subsequent approve call
        if (data.draft_row_id && D.meta) D.meta.draft_row_id = data.draft_row_id;

        // Parse updated processes from response gantt_json
        let newProcs = null;
        const gj = data.gantt_json || data.candidate_gantt_json || data;
        if (gj && gj.items) {
          newProcs = [];
          gj.items.forEach(function(phase) {
            (phase.processes || []).forEach(function(rp) {
              const local = procs.find(function(x) { return x.id === (rp.process_row_id || rp.id); });
              newProcs.push({
                id:          rp.process_row_id || rp.id || (local && local.id),
                name:        rp.label || rp.process_name || rp.name || (local && local.name) || 'Process',
                phase:       parseInt(phase.phase_number || phase.phase || 1, 10),
                start:       (rp.start || rp.start_date || '').slice(0, 10),
                end:         (rp.end   || rp.end_date   || '').slice(0, 10),
                done:        !!(rp.is_completed || rp.completed),
                completedOn: rp.completed_on || null,
              });
            });
          });
        }

        // If backend returns updated processes, use them; else fall back to local cascade
        let result;
        if (newProcs && newProcs.length) {
          const ghosts = {};
          procs.forEach(function(p) {
            const q = newProcs.find(function(x) { return x.id === p.id; });
            if (q && (q.start !== p.start || q.end !== p.end)) ghosts[p.id] = { start: p.start, end: p.end };
          });
          const editedIds = Object.keys(stagedMap);
          const shiftedIds = newProcs
            .filter(function(q) { return ghosts[q.id] && editedIds.indexOf(q.id) < 0; })
            .map(function(q) { return q.id; });
          result = { procs: newProcs, editedIds, shiftedIds, shiftDays: 0, ghosts };
        } else {
          // Fallback: local cascade simulation
          result = GD.cascade(procs, phases, stagedMap);
          if (completion) {
            const q = result.procs.find(function(x) { return x.id === completion.id; });
            if (q) { q.done = true; q.completedOn = completion.on; }
          }
        }

        setCandidate(result);
        setStaged({});
        setVeil(null);
        setToast({ tone: 'info', text: 'Plan updated — review what changed, then approve.' });
      })
      .catch(function(err) {
        clearInterval(iv);
        setVeil(null);
        setMode('edit');
        setToast({ tone: 'err', text: 'Save failed: ' + err.message + ' — edits preserved, try again.' });
        console.error('runRegen error:', err);
      });
    }

    // ── approve: hits /approve, then promotes candidate to live ────────────
    function approve() {
      if (!candidate) return;
      const meta = D.meta || {};

      setVeil('Approving plan\u2026');

      fetch(GANTT_CONFIG.APPROVE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-schedule-secret': GANTT_CONFIG.SCHEDULE_SECRET,
        },
        body: JSON.stringify({
          assembly_row_id: meta.assembly_row_id || '',
          assembly_number: meta.assembly_number || '',
          project_number:  meta.project_number  || '',
          draft_row_id:    meta.draft_row_id     || '',
          generated_by:    meta.generated_by     || '',
        }),
      })
      .then(function(res) {
        if (!res.ok) return res.text().then(function(t) { throw new Error('HTTP ' + res.status + ': ' + t); });
        return res.json();
      })
      .then(function() {
        const np = candidate.procs.map(function(p) { return Object.assign({}, p); });
        setProcs(np);
        setPhases(GD.derivePhases(np));
        setCandidate(null);
        setPop(null);
        setVeil(null);
        setToast({ tone: 'ok', text: '\u2713 Plan approved — changes are now live.' });
      })
      .catch(function(err) {
        setVeil(null);
        setToast({ tone: 'err', text: 'Approve failed: ' + err.message + ' — try again.' });
        console.error('approve error:', err);
      });
    }

    function discard() {
      setCandidate(null); setPop(null);
      setToast({ tone: 'warn', text: 'Update discarded — plan unchanged.' });
    }

    // ── drag ──────────────────────────────────────────────────────────────
    function prevPhaseEnd(phaseNum) {
      const inPhase = shown.filter((x) => x.phase === phaseNum);
      if (!inPhase.length) return null;
      return inPhase.reduce((mx, x) => {
        const e = (!candidate && staged[x.id] && staged[x.id].end) || x.end;
        return GD.toMs(e) > GD.toMs(mx) ? e : mx;
      }, inPhase[0].end);
    }
    function calcDrag(d, clientX) {
      const dd = Math.round((clientX - d.x0) / dayPx);
      const dur = GD.daysBetween(d.s0, d.e0);
      let s = d.s0, e = d.e0;
      if (d.type === 'm') { s = GD.addDays(d.s0, dd); e = GD.addDays(d.e0, dd); }
      else if (d.type === 'l') { s = GD.addDays(d.s0, dd); if (GD.toMs(s) > GD.toMs(e)) s = e; }
      else { e = GD.addDays(d.e0, dd); if (GD.toMs(e) < GD.toMs(s)) e = s; }
      let wall = null;
      if (d.p.phase > 1) {
        wall = prevPhaseEnd(d.p.phase - 1);
        if (wall && GD.toMs(s) < GD.toMs(wall)) {
          s = wall;
          if (d.type === 'm') e = GD.addDays(s, dur);
        }
      }
      return { s, e, wall };
    }
    function startDrag(ev, p) {
      if (mode !== 'edit' || p.done || candidate || veil) return;
      setPop(null);
      const r = ev.currentTarget.getBoundingClientRect();
      const off = ev.clientX - r.left;
      const type = off < 12 ? 'l' : off > r.width - 12 ? 'r' : 'm';
      const st = staged[p.id] || {};
      dragRef.current = { id: p.id, p, type, x0: ev.clientX, s0: st.start || p.start, e0: st.end || p.end, moved: false };
      ev.currentTarget.setPointerCapture(ev.pointerId);
    }
    function moveDrag(ev) {
      const d = dragRef.current;
      if (!d) return;
      if (Math.abs(ev.clientX - d.x0) > 4) d.moved = true;
      if (!d.moved) return;
      const r = calcDrag(d, ev.clientX);
      setDrag({ id: d.id, start: r.s, end: r.e, out: outOf(d.p, r.s, r.e), wall: r.wall });
    }
    function endDrag(ev) {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      if (!d.moved) { setDrag(null); return; }
      clickGuard.current = true;
      const r = calcDrag(d, ev.clientX);
      setDrag(null);
      if (r.s !== d.p.start || r.e !== d.p.end || staged[d.id]) commitDates(d.p, r.s, r.e);
    }
    function barClick(ev, p) {
      ev.stopPropagation();
      if (clickGuard.current) { clickGuard.current = false; return; }
      if (veil) return;
      setPop((prev) => (prev && prev.id === p.id ? null : { id: p.id }));
    }

    // ── axis ──────────────────────────────────────────────────────────────
    const ticks = [], months = [];
    {
      let lastM = -1;
      const every = span <= 21 ? 2 : span <= 60 ? 5 : span <= 120 ? 7 : 14;
      for (let i = 0; i < span; i++) {
        const iso = GD.addDays(tMin, i);
        const d = new Date(GD.toMs(iso));
        if (d.getUTCMonth() !== lastM) {
          months.push({ x: pct(iso), label: GD.fmt(iso, { month: true }).toUpperCase() });
          lastM = d.getUTCMonth();
        }
        if (i % every === 0) ticks.push({ x: pct(iso), label: d.getUTCDate() });
      }
    }

    // ── bar row renderer ──────────────────────────────────────────────────
    function renderProcRow(row) {
      const p = row.p;
      const st = staged[p.id];
      const isDrag = drag && drag.id === p.id;
      const candGhost = candidate ? candidate.ghosts[p.id] : null;
      const ds = isDrag ? drag.start : (st && st.start) || p.start;
      const de = isDrag ? drag.end : (st && st.end) || p.end;
      const stt = GD.status({ done: p.done, start: ds, end: de }, D.today);
      const left = pct(ds), width = wPct(ds, de);
      const rightPct = left + width;
      const barH = p.done ? BAR_DONE : BAR_H;
      const barY = (row.h - barH) / 2;
      const edited = isDrag || !!st || !!candGhost;
      const ghost = (isDrag || st) ? { start: p.start, end: p.end } : candGhost;
      const editable = mode === 'edit' && !p.done && !candidate && !veil;
      const overs = !p.done && GD.toMs(de) > GD.toMs(D.dispatch);
      const segs = [], extras = [];
      let badgeRightPx = 8;

      if (edited) {
        const tone = C.active;
        const fill = 'rgba(245,158,11,0.10)';
        if (ghost && (ghost.start !== ds || ghost.end !== de)) {
          segs.push(<div key="g" className="ge-seg" style={{ left: pct(ghost.start) + '%', width: wPct(ghost.start, ghost.end) + '%', top: barY, height: barH, borderRadius: 5, border: '1.5px dashed #3f3f46' }}></div>);
        }
        segs.push(<div key="m" className="ge-seg" style={{ left: left + '%', width: width + '%', top: barY, height: barH, borderRadius: 5, border: '1.5px ' + (st && !isDrag ? 'dashed' : 'solid') + ' ' + tone, background: fill }}></div>);
        if (overs) {
          const oL = Math.max(left, dispPct);
          if (rightPct > oL) segs.push(<div key="o" className="ge-seg ge-stripe" style={{ left: oL + '%', width: (rightPct - oL) + '%', top: barY, height: barH, borderRadius: 5 }}></div>);
        }
        if (candGhost) {
          const isShift = candidate.shiftedIds.indexOf(p.id) >= 0;
          extras.push(<span key="cb" className="ge-tag" style={{ left: 'calc(' + rightPct + '% + 6px)', top: row.h / 2 }}>{isShift ? '+' + candidate.shiftDays + 'd' : 'CHANGED'}</span>);
          badgeRightPx = 56;
        }
      } else if (stt === 'completed') {
        segs.push(<div key="b" className="ge-seg" style={{ left: left + '%', width: width + '%', top: barY, height: barH, borderRadius: 4, background: '#404048', opacity: 0.85, border: '1px solid #52525b' }}></div>);
        extras.push(<span key="ck" className="ge-check" style={{ left: 'calc(' + left + '% - 6px)', top: row.h / 2 }}><window.GEIcon kind="check" size={11} sw={2.5} color={C.dispatch}></window.GEIcon></span>);
      } else if (stt === 'upcoming') {
        if (overs) {
          const onW = Math.max(0, dispPct - left);
          if (onW > 0) segs.push(<div key="b" className="ge-seg" style={{ left: left + '%', width: onW + '%', top: barY, height: barH, borderRadius: 5, border: '1.5px solid ' + C.upcoming, background: 'rgba(161,161,170,0.05)' }}></div>);
          segs.push(<div key="o" className="ge-seg ge-stripe" style={{ left: Math.max(left, dispPct) + '%', width: (rightPct - Math.max(left, dispPct)) + '%', top: barY, height: barH, borderRadius: 5 }}></div>);
          extras.push(<span key="ov" className="ge-mini" style={{ left: 'calc(' + rightPct + '% + 6px)', top: row.h / 2 }}>{GD.daysBetween(D.dispatch, de)} DAY{GD.daysBetween(D.dispatch, de) === 1 ? '' : 'S'} OVER</span>);
          badgeRightPx = 100;
        } else {
          segs.push(<div key="b" className="ge-seg" style={{ left: left + '%', width: width + '%', top: barY, height: barH, borderRadius: 5, border: '1.5px solid ' + C.upcoming, background: 'rgba(161,161,170,0.05)' }}></div>);
        }
      } else if (stt === 'active') {
        const fillW = Math.max(0, Math.min(width, todayPct - left));
        if (fillW > 0) segs.push(<div key="f" className="ge-seg" style={{ left: left + '%', width: fillW + '%', top: barY, height: barH, borderRadius: 5, background: C.active, boxShadow: '0 0 10px rgba(245,158,11,.35)' }}></div>);
        const remL = left + fillW;
        const remOnR = overs ? Math.max(remL, dispPct) : rightPct;
        if (remOnR > remL) segs.push(<div key="r" className="ge-seg" style={{ left: remL + '%', width: (remOnR - remL) + '%', top: barY, height: barH, borderRadius: 5, border: '1.5px solid ' + C.active, background: 'rgba(245,158,11,0.10)' }}></div>);
        if (overs && rightPct > dispPct) {
          segs.push(<div key="o" className="ge-seg ge-stripe" style={{ left: Math.max(remL, dispPct) + '%', width: (rightPct - Math.max(remL, dispPct)) + '%', top: barY, height: barH, borderRadius: 5 }}></div>);
        }
        if ((width / 100) * layerW >= 90) {
          extras.push(<span key="pc" className="ge-pct" style={{ left: 'calc(' + rightPct + '% - 6px)', top: row.h / 2 }}>{Math.round((fillW / width) * 100)}%</span>);
        }
      } else {
        segs.push(<div key="b" className="ge-seg" style={{ left: left + '%', width: width + '%', top: barY, height: barH, borderRadius: 5, border: '1.5px solid ' + C.active, background: 'rgba(245,158,11,0.10)' }}></div>);
        if (todayPct > rightPct) segs.push(<div key="o" className="ge-seg ge-stripe-amber" style={{ left: rightPct + '%', width: (todayPct - rightPct) + '%', top: barY, height: barH, borderRadius: 5, borderLeft: 'none' }}></div>);
        const lateN = GD.daysBetween(de, D.today);
        extras.push(<span key="lt" className="ge-nudge" style={{ left: 'calc(' + todayPct + '% + 6px)', top: row.h / 2 }}>{lateN}d over · update?</span>);
      }

      const est = p.name.length * 6.6 + 20;
      const fits = (width / 100) * layerW > est;
      let labColor = '#d4d4d8', deco, labWeight = 600;
      if (stt === 'completed') { labColor = '#a1a1aa'; deco = undefined; labWeight = 500; }
      else if (edited) { labColor = '#fff'; labWeight = 700; }
      else if (stt === 'delayed') { labColor = '#fde68a'; labWeight = 700; }
      else if (stt === 'active') { labColor = '#fff'; labWeight = 700; }
      let labStyle, placeRight = true;
      if (fits) labStyle = { left: 'calc(' + left + '% + 10px)' };
      else {
        placeRight = left < todayPct - 2;
        if (stt === 'delayed') placeRight = false;
        labStyle = placeRight
          ? { left: 'calc(' + rightPct + '% + ' + badgeRightPx + 'px)' }
          : { left: 'calc(' + left + '% - 8px)', transform: 'translate(-100%,-50%)' };
      }
      const label = (
        <span key="lb" className="ge-label" style={Object.assign({ top: row.h / 2, color: labColor, fontWeight: labWeight, textDecoration: deco || 'none', fontSize: 12.5 }, labStyle)}>
          {p.name}
        </span>
      );

      const estPct = (est / layerW) * 100;
      let hitLeftPct = left, hitWidthPct = width;
      if (!editable && !fits) {
        if (placeRight) hitWidthPct = width + (badgeRightPx / layerW) * 100 + estPct;
        else { hitLeftPct = Math.max(0, left - estPct); hitWidthPct = rightPct - hitLeftPct; }
      }
      const hit = (
        <div key="ht"
          className={'ge-hit' + (editable ? ' ge-editable' : '')}
          style={{ left: hitLeftPct + '%', width: hitWidthPct + '%', top: barY - 7, height: Math.max(barH + 14, 22) }}
          onPointerDown={editable ? (e) => startDrag(e, p) : undefined}
          onPointerMove={editable ? moveDrag : undefined}
          onPointerUp={editable ? endDrag : undefined}
          onPointerCancel={editable ? endDrag : undefined}
          onClick={(e) => barClick(e, p)}
          title={p.name + ' · ' + GD.fmtRange(ds, de)}>
          {editable && <div className="ge-handle l"></div>}
          {editable && <div className="ge-handle r"></div>}
        </div>
      );

      return (
        <div key={p.id} className="ge-row" style={{ top: row.y, height: row.h }}>
          {segs}{extras}{label}{hit}
        </div>
      );
    }

    // ── drag chrome ────────────────────────────────────────────────────────
    const dProc = drag ? sorted.find((x) => x.id === drag.id) : null;
    let tip = null;
    const wallLine = (drag && drag.wall && dProc)
      ? <div className="ge-vline" style={{ left: pct(drag.wall) + '%', top: 44, bottom: 8, width: 2, marginLeft: -1, borderLeft: '2px dashed rgba(161,161,170,0.5)', zIndex: 6 }}></div>
      : null;
    if (dProc) {
      const row = layout.find((r) => r.kind === 'proc' && r.p.id === drag.id);
      if (row) {
        const clamped = drag.wall && GD.toMs(drag.start) <= GD.toMs(drag.wall);
        tip = (
          <div className="ge-tip" style={{ left: pct(drag.start) + '%', top: row.y - 4 }}>
            {clamped
              ? <span>Can't go earlier · <span className="ext">Phase {dProc.phase - 1} ends {GD.fmt(drag.wall)}</span></span>
              : <span>{GD.fmtRange(drag.start, drag.end)} · {GD.durDays(drag.start, drag.end)}d{drag.out ? <span className="ext"> · extends Phase {dProc.phase}</span> : null}</span>}
          </div>
        );
      }
    }

    // ── popover ───────────────────────────────────────────────────────────
    let popEl = null;
    if (pop) {
      const row = layout.find((r) => r.kind === 'proc' && r.p.id === pop.id);
      if (row) {
        const p = row.p;
        const st = staged[p.id];
        const ds = (st && st.start) || p.start, de = (st && st.end) || p.end;
        const w = winOf(p.phase);
        const popW = 252;
        let lpx = (pct(ds) / 100) * layerW;
        if (lpx + popW > layerW - 4) lpx = layerW - popW - 4;
        if (lpx < 4) lpx = 4;
        const below = row.y < chartH * 0.55;
        const sty = { left: lpx, width: popW };
        if (below) sty.top = row.y + row.h + 8; else sty.bottom = chartH - row.y + 8;
        let inner;
        if (candidate) {
          inner = <window.GEPopCandidate p={p} ghost={candidate.ghosts[p.id]} onClose={() => setPop(null)}></window.GEPopCandidate>;
        } else if (mode === 'edit') {
          inner = p.done
            ? <window.GEPopLocked p={p} onReopen={() => reopen(p)} onClose={() => setPop(null)}></window.GEPopLocked>
            : <window.GEPopEdit key={p.id + (st ? '-st' : '')} p={p} cur={{ start: ds, end: de }} win={w} isStaged={!!st}
                minStart={p.phase > 1 ? prevPhaseEnd(p.phase - 1) : null}
                onApply={(s, e) => { commitDates(p, s, e); setPop(null); }}
                onClear={() => { clearStaged(p.id); setPop(null); }}
                onClose={() => setPop(null)}></window.GEPopEdit>;
        } else {
          inner = p.done
            ? <window.GEPopDone p={p} onReopen={() => reopen(p)} onClose={() => setPop(null)}></window.GEPopDone>
            : <window.GEPopView key={p.id} p={p} win={w} today={D.today} expandInit={!!pop.expand}
                onComplete={(v) => complete(p, v)}
                onEdit={() => enterEdit()}
                onClose={() => setPop(null)}></window.GEPopView>;
        }
        popEl = (
          <div className="ge-pop" style={sty} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            {inner}
          </div>
        );
      }
    }

    const candOverN = candidate ? candidate.procs.filter((p) => !p.done && GD.toMs(p.end) > GD.toMs(D.dispatch)).length : 0;

    const hasInvalid = shown.some((p) => !p.start || !p.end);
    if (hasInvalid) {
      return (
        <div className="ge-root">
          <window.GEStyles></window.GEStyles>
          <div style={{ padding: '40px 20px', textAlign: 'center', color: '#e5e7eb' }}>
            <div style={{ fontSize: '16px', fontWeight: '600', marginBottom: '8px' }}>Manufacturing sequence updated</div>
            <div style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '24px' }}>Refresh to show latest timelines</div>
            <button style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #3f3f46', background: '#1f1f1f', color: '#d4d4d8', cursor: 'pointer', fontSize: '12px', fontWeight: '600' }} onClick={() => window.location.reload()}>Refresh</button>
          </div>
        </div>
      );
    }

    return (
      <div className="ge-root"
        onClick={() => setPop(null)}
        onPointerDown={() => { if (drag && !dragRef.current) setDrag(null); }}>
        <window.GEStyles></window.GEStyles>
        {!embed && D.source === 'demo' && <div className="ge-ribbon">DEMO DATA — PASS #data=… FOR A REAL PLAN</div>}

        <div className="ge-top">
          <div className="ge-count">
            <span className="ge-count-num" style={{ color: dtd < 0 ? C.delayed : '#fafafa' }}>{Math.abs(dtd)}</span>
            <span className="ge-count-lab">{dtd >= 0 ? 'days to dispatch' : 'days past dispatch'}</span>
          </div>
          <div className="ge-actions">
            {candidate ? (
              <React.Fragment>
                <button className="ge-btn" onClick={discard}>Discard</button>
                <button className="ge-btn solid" onClick={approve}><window.GEIcon kind="check" size={12} sw={2.5}></window.GEIcon> Approve plan</button>
              </React.Fragment>
            ) : mode === 'edit' ? (
              <React.Fragment>
                <button className="ge-btn" onClick={exitEdit}>{stagedN ? 'Cancel' : 'Done'}</button>
                <button className="ge-btn solid" disabled={!stagedN} onClick={() => runRegen(staged)}>
                  <window.GEIcon kind="check" size={12} sw={2.5}></window.GEIcon> Save plan{stagedN ? ' (' + stagedN + ')' : ''}
                </button>
              </React.Fragment>
            ) : (
              !veil && <button className="ge-btn" onClick={enterEdit}><window.GEIcon kind="pencil" size={12}></window.GEIcon> Edit plan</button>
            )}
          </div>
        </div>

        {mode === 'edit' && !candidate && (
          <div className="ge-banner edit">
            <window.GEIcon kind="pencil" size={13}></window.GEIcon>
            <span>Edit mode — drag a bar to move it, drag an edge to resize, or click for exact dates. Hit <b>Save plan</b> when you're done.</span>
          </div>
        )}
        {candidate && (
          <div className="ge-banner cand">
            <window.GEIcon kind="check" size={13} sw={2.5}></window.GEIcon>
            <span>
              Updated plan — {candidate.editedIds.length} change{candidate.editedIds.length === 1 ? '' : 's'}{candidate.shiftedIds.length > 0 ? ', ' + candidate.shiftedIds.length + ' later step' + (candidate.shiftedIds.length === 1 ? '' : 's') + ' moved' + (candidate.shiftDays ? ' +' + candidate.shiftDays + 'd' : '') : ''}.
              {candOverN > 0 && <b className="warn"> {candOverN} now land{candOverN === 1 ? 's' : ''} past dispatch.</b>}
              {' '}Review the changes, then approve.
            </span>
          </div>
        )}

        <div className={'ge-card' + (candidate ? ' approval' : '')} ref={cardRef}>
          <div className="ge-layer" style={{ height: chartH }}>
            {ticks.map((t, i) => <div key={'g' + i} className="ge-grid" style={{ left: t.x + '%' }}></div>)}
            {months.map((m, i) => <div key={'m' + i} className="ge-axis-month" style={{ left: m.x + '%' }}>{m.label}</div>)}
            {ticks.map((t, i) => <div key={'d' + i} className="ge-axis-day" style={{ left: t.x + '%' }}>{t.label}</div>)}

            <div className="ge-zone" style={{ left: dispPct + '%', width: (100 - dispPct) + '%', top: 48, bottom: 10 }}></div>
            <div className="ge-vline" style={{ left: dispPct + '%', top: 48, bottom: 8, width: 2, marginLeft: -1, background: C.dispatch, boxShadow: '0 0 10px rgba(16,185,129,.4)', zIndex: 3 }}></div>
            <div className="ge-badge" style={{ left: dispPct + '%', top: 5, background: C.dispatch, color: '#04150d', zIndex: 6 }}>DISPATCH · {GD.fmt(D.dispatch).toUpperCase()}</div>

            {layout.map((r) => {
              if (r.kind === 'phase') {
                return (
                  <div key={'ph' + r.num} className="ge-row" style={{ top: r.y, height: PHASE_H }}>
                    <div className="ge-phase-rule"></div>
                    <div className="ge-phase-label" style={{ top: 9 }}>PHASE {r.num}</div>
                  </div>
                );
              }
              return renderProcRow(r);
            })}

            <div className="ge-vline" style={{ left: todayPct + '%', top: 44, bottom: 8, width: 10, marginLeft: -5, background: 'rgba(255,255,255,.05)', zIndex: 4 }}></div>
            <div className="ge-vline" style={{ left: todayPct + '%', top: 44, bottom: 8, width: 2, marginLeft: -1, background: '#fff', zIndex: 4 }}></div>
            <div className="ge-badge" style={{ left: todayPct + '%', top: 5, background: '#fff', color: '#0b0d12', zIndex: 7 }}>TODAY · {GD.fmt(D.today).toUpperCase()}</div>

            {wallLine}
            {tip}
            {popEl}
          </div>

          {veil && (
            <div className="ge-veil">
              <div className="ge-vbox">
                <div className="ge-spin"></div>
                <span>{veil}</span>
                <small>This usually takes 10–20 seconds</small>
              </div>
            </div>
          )}
        </div>

        <div className="ge-foot">
          {toast
            ? <span className={'ge-toast ' + toast.tone}>{toast.text}</span>
            : <span>{candidate
                ? 'Click any bar to see what changed.'
                : mode === 'edit'
                  ? 'Drag bars to move · drag edges to resize · click a bar for exact dates.'
                  : 'Click a bar for details or to mark a process complete.'}</span>}
          <span style={{ marginLeft: 'auto', fontSize: '10px', color: '#4b5563', fontStyle: 'italic' }}>
            AI-generated plan — dates are estimates, please review before dispatch.
          </span>
        </div>
      </div>
    );
  }

  window.GanttEdit = GanttEdit;
})();
