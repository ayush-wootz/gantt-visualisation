// gantt-edit.jsx — the editable Gantt component.
//
// Interactions (always editable — no separate edit mode):
//   Hover a bar → grab cursor, amber ring, edge handles, center grip, hint.
//   Drag a bar  → move; drag its edges → resize; click → popover for exact
//                 dates or to mark complete.
//   Any pending change (a dragged/typed date OR a mark-complete) stages and
//   shows the "Cancel / Approve plan" bar. Approve hits /schedule (recompute
//   downstream) then /approve back-to-back — no separate review step — and the
//   updated plan goes live in one click. A candidate loaded from data (an
//   existing draft) still shows ghost bars + Discard / Approve for review.

// ── CONFIG — set your endpoints here ──────────────────────────────────────
var GANTT_CONFIG = {
  SCHEDULE_URL:    'https://gantt-visualisation-dev.onrender.com/schedule',
  SCHEDULE_SECRET: 'ayush_Wootz_2026',
  APPROVE_URL:     'https://glide-gantt-ai-scheduler.onrender.com/approve',
  DISCARD_URL:     'https://gantt-visualisation-dev.onrender.com/discard',
};

(function () {
  const { useState, useRef, useEffect, useMemo } = React;

  const ROW_H = 34, ROW_DONE = 22, PHASE_H = 26, BAR_H = 22, BAR_DONE = 8;
  const TOP = 56, GROUP_GAP = 8, BOT = 16;
  const MAX_ZOOM = 1.7;
  // How long a toast holds the footer line before it falls back to the last
  // chat message. Errors linger longer — they're the ones worth reading twice.
  const TOAST_MS = 6000, TOAST_ERR_MS = 12000;

  // The chat message as stored carries machine-readable tails the thread view
  // parses into its own UI ("Changes since approved:" rows, "AI warnings:").
  // The footer wants only the prose the AI wrote, so strip them the same way
  // thread.html does. Safe on text that has neither.
  function chatProse(text) {
    let s = String(text == null ? '' : text).replace(/\\n/g, '\n').replace(/^\[DRAFT\]\s*/, '').trim();
    s = s.split(/\nChanges since approved:\s*/)[0];
    s = s.split(/\nAI warnings:\s*/)[0];
    s = s.split(/\nRecommendations:\s*/)[0];
    return s.trim();
  }

  function GanttEdit({ forced, embed }) {
    const GD = window.GanttEditData;
    const C = window.GE_C;
    const D = useMemo(() => GD.load(), []);
    const fx = useMemo(() => GD.fixtures(forced, D), [forced]);

    // A pending (unapproved) draft loaded from data becomes the EDITABLE base
    // plan — there's no read-only "review only" screen anymore. The approved
    // plan is kept aside for the Discard revert and the "vs approved" ghosts.
    const hasDraft = !!(D.candidateProcs && D.candidateProcs.length);
    const [procs, setProcs] = useState(() => fx.procs || (hasDraft ? D.candidateProcs : D.procs).map((p) => Object.assign({}, p)));
    const [phases, setPhases] = useState(() => D.phases);
    const [staged, setStaged] = useState(() => fx.staged || {});
    // `candidate` is now ONLY the design-canvas fixture state (?state=…); a real
    // loaded draft is handled by `pendingDraft` below, keeping it fully editable.
    const [candidate, setCandidate] = useState(() => fx.candidate || null);
    const [pendingDraft, setPendingDraft] = useState(hasDraft);
    // Last approved plan — the Discard revert target and the source of the
    // one-time ghost bars showing what the draft changed from approved.
    const approvedRef = useRef(D.procs);
    const draftGhosts = useMemo(function () {
      const g = {};
      if (hasDraft) D.procs.forEach(function (a) {
        const d = D.candidateProcs.find(function (x) { return x.id === a.id; });
        if (d && (d.start !== a.start || d.end !== a.end)) g[a.id] = { start: a.start, end: a.end };
      });
      return g;
    }, []);
    const [veil, setVeil] = useState(fx.veil || null);
    const [pop, setPop] = useState(() => fx.pop || null);
    const [drag, setDrag] = useState(() => fx.fakeDrag || null);
    const [toast, setToast] = useState(() => fx.toast || null);
    // Last chat message shown in the footer. Seeded from the page-load payload
    // (meta.last_message — Glide passes the newest "approval" row for this
    // assembly) and refreshed in-place from /approve's response, since the baked
    // payload can't update itself while the embed is open.
    const [lastMsg, setLastMsg] = useState(() => chatProse((D.meta || {}).last_message));
    const [msgOpen, setMsgOpen] = useState(false);
    const [msgClipped, setMsgClipped] = useState(false);
    const msgRef = useRef(null);
    const [cardW, setCardW] = useState(1200);
    const [cardH, setCardH] = useState(null); // null until measured — keeps zoom at 1x till then
    const [full, setFull] = useState(false);
    const cardRef = useRef(null);
    const rootRef = useRef(null);
    const dragRef = useRef(null);
    // Timestamp (ms) of the last move-drag end, used to swallow ONLY the
    // synthetic click that immediately follows it. A timestamp (vs a sticky
    // boolean) self-expires, so a drag whose click landed elsewhere can't leave
    // the guard stuck and eat a later, unrelated click on another process.
    const clickGuard = useRef(0);
    const timersRef = useRef([]);
    const didAutoScroll = useRef(false);

    useEffect(() => {
      const el = cardRef.current;
      if (!el) return;
      const ro = new ResizeObserver((es) => {
        for (const en of es) { setCardW(en.contentRect.width); setCardH(en.contentRect.height); }
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, []);
    useEffect(() => () => { timersRef.current.forEach((t) => { clearTimeout(t); clearInterval(t); }); }, []);

    // Toasts used to be permanent, which was fine when the footer had nothing
    // else to say. Now they'd bury the last chat message for the rest of the
    // session, so they expire and hand the line back. Skipped for the design
    // canvas (?state=…), whose canned toasts are the point of the fixture.
    useEffect(() => {
      if (!toast || forced) return;
      const t = setTimeout(() => setToast(null), toast.tone === 'err' ? TOAST_ERR_MS : TOAST_MS);
      return () => clearTimeout(t);
    }, [toast, forced]);

    // A new message always arrives collapsed.
    useEffect(() => { setMsgOpen(false); }, [lastMsg]);

    // Does the message overflow its one clamped line? Only then is the
    // click-to-expand affordance worth showing. Re-measured on width changes.
    // Skipped while expanded — the expanded box may well fit, and re-measuring
    // there would drop the affordance the user needs to collapse it again.
    useEffect(() => {
      if (msgOpen) return;
      const el = msgRef.current;
      if (!el) { setMsgClipped(false); return; }
      setMsgClipped(el.scrollHeight > el.clientHeight + 1);
    }, [lastMsg, cardW, toast, msgOpen, candidate]);

    // ── fullscreen (View Full) — real Fullscreen API, not a CSS trick, so it
    // can escape the small iframe box Glide's Web Embed gives us ────────────
    useEffect(() => {
      const onFsChange = () => setFull(!!(document.fullscreenElement || document.webkitFullscreenElement));
      document.addEventListener('fullscreenchange', onFsChange);
      document.addEventListener('webkitfullscreenchange', onFsChange);
      return () => {
        document.removeEventListener('fullscreenchange', onFsChange);
        document.removeEventListener('webkitfullscreenchange', onFsChange);
      };
    }, []);
    function toggleFull() {
      const isFull = document.fullscreenElement || document.webkitFullscreenElement;
      if (isFull) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
        return;
      }
      const el = rootRef.current;
      const req = el && (el.requestFullscreen || el.webkitRequestFullscreen);
      if (!req) {
        setToast({ tone: 'err', text: 'Full screen isn’t available here — this embed’s browser/container doesn’t support it.' });
        return;
      }
      const res = req.call(el);
      if (res && res.catch) {
        res.catch(() => setToast({ tone: 'err', text: 'Full screen was blocked by the embed container.' }));
      }
    }

    // ── derived plan + time scale ─────────────────────────────────────────
    // Live, client-side-only cascade preview: while staging (no candidate
    // loaded), an edit that pushes a phase's live work past its window
    // immediately shows every downstream, non-completed process shifted
    // forward too — same rule the backend enforces at approve time, just
    // visible right away instead of only after the fact.
    const liveCascaded = useMemo(() => GD.liveCascade(procs, staged), [procs, staged]);
    const shown = candidate ? candidate.procs : liveCascaded.procs;
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

    // ── zoom: if the card has more vertical room than the plan needs at its
    // base size, scale row/bar/phase sizing up to fill it (capped so a
    // 1-2 phase plan doesn't balloon absurdly). Never scales below 1x, and
    // stays at 1x until cardH has a real measured value. ───────────────────
    function measureContentHeight(rowH, rowDone, phaseH, groupGap) {
      let y = TOP, last = -1;
      for (const p of sorted) {
        if (p.phase !== last) {
          if (last !== -1) y += groupGap;
          y += phaseH;
          last = p.phase;
        }
        y += p.done ? rowDone : rowH;
      }
      return Math.max(y + BOT, TOP + 140);
    }
    const naturalH = measureContentHeight(ROW_H, ROW_DONE, PHASE_H, GROUP_GAP);
    const zoom = cardH && naturalH > 0 ? Math.max(1, Math.min(MAX_ZOOM, cardH / naturalH)) : 1;
    const Z_ROW_H = Math.round(ROW_H * zoom);
    const Z_ROW_DONE = Math.round(ROW_DONE * zoom);
    const Z_PHASE_H = Math.round(PHASE_H * zoom);
    const Z_BAR_H = Math.round(BAR_H * zoom);
    const Z_BAR_DONE = Math.round(BAR_DONE * zoom);
    const Z_GROUP_GAP = Math.round(GROUP_GAP * zoom);
    const Z_BOT = Math.round(BOT * zoom);

    // ── row layout ────────────────────────────────────────────────────────
    const layout = [];
    let chartH = TOP + 140;
    {
      let y = TOP, last = -1;
      for (const p of sorted) {
        if (p.phase !== last) {
          if (last !== -1) y += Z_GROUP_GAP;
          layout.push({ kind: 'phase', num: p.phase, label: p.phaseLabel || ('PHASE ' + p.phase), y });
          y += Z_PHASE_H;
          last = p.phase;
        }
        const h = p.done ? Z_ROW_DONE : Z_ROW_H;
        layout.push({ kind: 'proc', p, y, h });
        y += h;
      }
      chartH = Math.max(y + Z_BOT, chartH);
    }

    // ── on open, scroll to whatever needs attention first:
    // 1) the earliest incomplete step that's already overdue (past its end,
    //    not done) — even if that's outside today's phase;
    // 2) else the phase whose window contains today (nearest phase by date
    //    if today falls outside every window)
    // Waits for a real cardH measurement (not just mount) so it scrolls
    // against the final zoomed row positions, not the pre-zoom 1x layout. ──
    useEffect(() => {
      if (didAutoScroll.current || cardH == null) return;
      const el = cardRef.current;
      if (!el || !phases.length) return;
      didAutoScroll.current = true;
      const overdue = sorted.find((p) => GD.status(p, D.today) === 'delayed');
      if (overdue) {
        const row = layout.find((r) => r.kind === 'proc' && r.p.id === overdue.id);
        if (row) { el.scrollTop = Math.max(0, row.y - 60); return; }
      }
      const todayMs = GD.toMs(D.today);
      let target = phases[0].num, bestDist = Infinity;
      phases.forEach((w) => {
        const s = GD.toMs(w.start), e = GD.toMs(w.end);
        const dist = todayMs < s ? s - todayMs : todayMs > e ? todayMs - e : 0;
        if (dist < bestDist) { bestDist = dist; target = w.num; }
      });
      const row = layout.find((r) => r.kind === 'phase' && r.num === target);
      if (row) el.scrollTop = Math.max(0, row.y - 60);
    }, [cardH]);

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
    // Merges into any existing staged entry rather than replacing it, so a
    // reopen's `reopened`/`prevCompletedOn` flags survive every subsequent
    // drag/apply on that process \u2014 without this, the first date edit after a
    // reopen wiped those flags and the row silently re-locked as "done".
    function commitDates(p, s, e) {
      // Compare against the SAVED plan (procs), NOT p's current on-screen dates.
      // p is the displayed proc, which for an edited/cascaded bar sits at its
      // pending position \u2014 so `s === p.start` meant "matches where it is now",
      // and dropping the staged entry then snapped the bar back to its ORIGINAL
      // saved date. For any process whose baseline is later than where the user
      // moved it (every process after the first in a phase), that revert was a
      // forward "bounce". Only a return to the true baseline clears the edit.
      const base = procs.find(function (x) { return x.id === p.id; }) || p;
      const existing = staged[p.id];
      const wasReopened = !!(existing && existing.reopened);
      // For a reopened process, matching the baseline doesn't mean "nothing
      // pending" \u2014 the reopen itself is still an unapproved change.
      if (!wasReopened && s === base.start && e === base.end) {
        setStaged((prev) => { const n = Object.assign({}, prev); delete n[p.id]; return n; });
        return;
      }
      setStaged((prev) => {
        const entry = { start: s, end: e };
        if (wasReopened) { entry.reopened = true; entry.prevCompletedOn = existing.prevCompletedOn; }
        return Object.assign({}, prev, { [p.id]: entry });
      });
      const ext = outOf(p, s, e);
      setToast({ tone: ext ? 'info' : 'ok', text: p.name + ' \u2192 ' + GD.fmtRange(s, e) + (ext ? ' \u00b7 extends Phase ' + p.phase + ' \u2014 later steps shifted to fit; approve to apply.' : ' \u00b7 approve to apply.') });
    }
    function clearStaged(id) {
      setStaged((prev) => { const n = Object.assign({}, prev); delete n[id]; return n; });
    }
    function cancelChanges() {
      const had = stagedN > 0;
      setStaged({}); setPop(null); setDrag(null);
      if (had) setToast({ tone: 'warn', text: 'Changes discarded — plan unchanged.' });
    }
    // Reopen STAGES the process (same lifecycle as complete()/commitDates) —
    // it only actually reopens once the plan is approved. The `reopened` flag
    // set here now survives any number of later drags/edits (see commitDates),
    // so the user reopens once and can keep adjusting freely after that.
    function reopen(p) {
      setStaged((prev) => Object.assign({}, prev, { [p.id]: { start: p.start, end: p.end, reopened: true, prevCompletedOn: p.completedOn } }));
      setPop(null);
      setToast({ tone: 'ok', text: p.name + ' reopened — dates are editable again. Approve to apply.' });
    }
    // Marking complete now STAGES (like a date edit) so it shows in Save/Cancel
    // and commits with everything else on Save. Encoded as a staged entry with
    // a `done` flag; buildContext/saveAndApprove turn it into a completion for the AI.
    function complete(p, v) {
      const w = winOf(p.phase);
      const beyond = GD.toMs(v) > GD.toMs(w.end);
      setStaged((prev) => Object.assign({}, prev, { [p.id]: { start: p.start, end: v, done: true, completedOn: v } }));
      setPop(null);
      // Unlike commitDates, "shifted to fit" isn't guaranteed true here: a
      // completed process only feeds the phase's handover once every other
      // process in that phase is also done (liveCascade mirrors the backend's
      // rule) \u2014 with live siblings still open, this won't visibly shift
      // anything until they're resolved too, so the wording stays "will".
      setToast({ tone: beyond ? 'info' : 'ok', text: '\u2713 ' + p.name + ' set to complete (' + GD.fmt(v) + ')' + (beyond ? ' \u00b7 later steps shift when you approve.' : ' \u00b7 approve to apply.') });
    }

    // ── BUILD CONTEXT STRING for /schedule ─────────────────────────────────
    function buildContext(stagedMap) {
      const parts = [];
      Object.keys(stagedMap).forEach(function(id) {
        const p = procs.find(function(x) { return x.id === id; });
        if (!p) return;
        const e = stagedMap[id];
        if (e.done) {
          parts.push('Mark ' + p.name + ' as complete. Actual finish date: ' + (e.completedOn || e.end) + ' (planned was ' + p.end + ')');
          return;
        }
        if (e.reopened) {
          // A reopen can now carry a later date edit too (commitDates merges
          // into it instead of replacing it) — say so, or the AI only hears
          // about the reopen and recomputes from the old (still-completed) dates.
          let msg = 'Reopen ' + p.name + ' — mark it as NOT complete (it was previously marked done on ' + (e.prevCompletedOn || p.completedOn || 'an earlier date') + ')';
          const bits = [];
          if (e.start && e.start !== p.start) bits.push('start to ' + e.start);
          if (e.end   && e.end   !== p.end)   bits.push('end to '   + e.end);
          if (bits.length) msg += ', then change ' + bits.join(' and ');
          parts.push(msg + '.');
          return;
        }
        const bits = ['Change ' + p.name];
        if (e.start && e.start !== p.start) bits.push('start to ' + (e.start));
        if (e.end   && e.end   !== p.end)   bits.push('end to '   + (e.end));
        parts.push(bits.join(' '));
      });
      parts.push('Recompute the downstream schedule to avoid overlaps and respect the dispatch date of ' + D.dispatch + '.');
      return parts.join('. ');
    }

    // ── saveAndApprove: hits /schedule (recompute downstream) then /approve
    // back-to-back, then promotes the result straight to live — the edit path
    // no longer stops at a candidate review step. /approve needs the
    // draft_row_id that /schedule mints, hence the chain. ──────────────────
    function saveAndApprove(stagedMap) {
      if (veil) return; // already saving/approving — ignore repeat clicks
      setPop(null); setDrag(null);

      const msgs = [
        'Saving changes\u2026',
        'Updating the schedule\u2026',
        'Rescheduling later steps\u2026',
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
        context:            buildContext(stagedMap),
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

        // /approve targets the draft via meta.draft_row_id, which Glide bakes
        // into the page-load payload from the current_draft relation. Keep the
        // original passthrough: if the response ever surfaces one, use it; else
        // the loaded relation id stands. (If a first-ever edit ever fails to
        // approve in Glide because no draft existed at load, that's the spot to
        // resolve the draft by assembly+owner — mirroring /discard — server-side.)
        if (data.draft_row_id && D.meta) D.meta.draft_row_id = data.draft_row_id;

        // Parse updated processes from response gantt_json
        let newProcs = null;
        const gj = data.gantt_json || data.candidate_gantt_json || data;
        if (gj && gj.items) {
          newProcs = [];
          gj.items.forEach(function(phase) {
            const rawPhase = phase.phase_number != null ? phase.phase_number : (phase.phase != null ? phase.phase : null);
            (phase.processes || []).forEach(function(rp) {
              const local = procs.find(function(x) { return x.id === (rp.process_row_id || rp.id); });
              const pRaw = rp.phase_number != null ? rp.phase_number : rawPhase;
              newProcs.push({
                id:          rp.process_row_id || rp.id || (local && local.id),
                name:        rp.label || rp.process_name || rp.name || (local && local.name) || 'Process',
                phase:       (pRaw != null ? GD.phaseRank(pRaw) : (local && local.phase) || 1),
                phaseLabel:  (pRaw != null ? GD.phaseLabel(pRaw) : (local && local.phaseLabel) || 'PHASE 1'),
                start:       (rp.start || rp.start_date || '').slice(0, 10),
                end:         (rp.end   || rp.end_date   || '').slice(0, 10),
                done:        !!(rp.is_completed || rp.completed),
                completedOn: rp.completed_on || null,
              });
            });
          });
        }

        // Use backend-updated processes when present; else fall back to a local
        // cascade so the live plan still reflects the edit if the API omits them.
        const resultProcs = (newProcs && newProcs.length) ? newProcs : GD.cascade(procs, phases, stagedMap).procs;

        // Ensure any staged completions/reopens are reflected in the final procs
        Object.keys(stagedMap).forEach(function(id) {
          const e = stagedMap[id];
          if (!e) return;
          const q = resultProcs.find(function(x) { return x.id === id; });
          if (!q) return;
          if (e.done) { q.done = true; q.completedOn = e.completedOn || e.end; }
          else if (e.reopened) { q.done = false; q.completedOn = null; }
        });

        // Straight to approve — no candidate review stop.
        setVeil('Approving the plan…');
        const m2 = D.meta || {};
        return fetch(GANTT_CONFIG.APPROVE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-schedule-secret': GANTT_CONFIG.SCHEDULE_SECRET,
          },
          body: JSON.stringify({
            assembly_row_id: m2.assembly_row_id || '',
            assembly_number: m2.assembly_number || '',
            project_number:  m2.project_number  || '',
            draft_row_id:    m2.draft_row_id     || '',
            generated_by:    m2.generated_by     || '',
          }),
        })
        .then(function(res) {
          if (!res.ok) return res.text().then(function(t) { throw new Error('HTTP ' + res.status + ': ' + t); });
          return res.json();
        })
        .then(function(aj) {
          const m = chatProse(aj && aj.approval_summary);
          if (m) setLastMsg(m);
          return resultProcs;
        });
      })
      .then(function(resultProcs) {
        // Promote straight to live — this is now the approved baseline, and any
        // pending-draft state is resolved.
        const np = resultProcs.map(function(p) { return Object.assign({}, p); });
        approvedRef.current = np;
        setProcs(np);
        setPhases(GD.derivePhases(np));
        setCandidate(null);
        setPendingDraft(false);
        setStaged({});
        setPop(null);
        setVeil(null);
        setToast({ tone: 'ok', text: '✓ Plan approved — changes are now live.' });
      })
      .catch(function(err) {
        clearInterval(iv);
        setVeil(null);
        setToast({ tone: 'err', text: 'Approve failed: ' + err.message + ' — edits preserved, try again.' });
        console.error('saveAndApprove error:', err);
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
      .then(function(aj) {
        const m = chatProse(aj && aj.approval_summary);
        if (m) setLastMsg(m);
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

    // ── approveDraft: no-edit approval of a loaded pending draft. `procs`
    // already holds the draft, so this just commits it live via /approve (the
    // exact same call the candidate Approve made) and drops the pending state.
    // An EDITED draft goes through saveAndApprove instead. ─────────────────
    function approveDraft() {
      if (veil) return;
      const meta = D.meta || {};
      setVeil('Approving plan…');
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
      .then(function(aj) {
        const m = chatProse(aj && aj.approval_summary);
        if (m) setLastMsg(m);
        const np = procs.map(function(p) { return Object.assign({}, p); });
        approvedRef.current = np;        // the draft is the approved plan now
        setPhases(GD.derivePhases(np));
        setPendingDraft(false);
        setPop(null);
        setVeil(null);
        setToast({ tone: 'ok', text: '✓ Plan approved — changes are now live.' });
      })
      .catch(function(err) {
        setVeil(null);
        setToast({ tone: 'err', text: 'Approve failed: ' + err.message + ' — try again.' });
        console.error('approveDraft error:', err);
      });
    }

    function discard() {
      const meta = D.meta || {};

      setVeil('Discarding update…');

      fetch(GANTT_CONFIG.DISCARD_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-schedule-secret': GANTT_CONFIG.SCHEDULE_SECRET,
        },
        body: JSON.stringify({
          assembly_row_id: meta.assembly_row_id || '',
          generated_by:    meta.generated_by    || '',
        }),
      })
      .then(function(res) {
        if (!res.ok) return res.text().then(function(t) { throw new Error('HTTP ' + res.status + ': ' + t); });
      })
      .then(function() {
        // Draft removed on the server — revert the on-screen plan to the last
        // approved one and drop the pending/edit state.
        const np = approvedRef.current.map(function(p) { return Object.assign({}, p); });
        setProcs(np);
        setPhases(GD.derivePhases(np));
        setStaged({});
        setPendingDraft(false);
        setCandidate(null);
        setPop(null);
        setVeil(null);
        setToast({ tone: 'warn', text: 'Draft discarded — reverted to the last approved plan.' });
      })
      .catch(function(err) {
        setVeil(null);
        setToast({ tone: 'err', text: 'Discard failed: ' + err.message + ' — try again.' });
        console.error('discard error:', err);
      });
    }

    // ── drag ──────────────────────────────────────────────────────────────
    // The wall a process can't cross is the previous phase's handover — and it
    // MUST be the same handover liveCascade uses (GD.handoverEnd: live-only,
    // completed-fallback), or a late-completed process in the previous phase
    // sets a wall the cascade ignores, freezing/blocking downstream bars.
    // `shown` already carries each process's live-cascaded dates + effective
    // done state, so handoverEnd reads exactly what's on screen.
    function prevPhaseEnd(phaseNum) {
      return GD.handoverEnd(shown.filter((x) => x.phase === phaseNum));
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
        if (wall) {
          // Floor at the wall — but never shove a bar FORWARD past where it
          // already sits. A bar that already started before the wall (a
          // tolerated baseline overlap) stays put instead of snapping to the
          // wall the instant you grab it; a compliant bar still can't cross it.
          // Mirrors the popover's "only block if you moved the start earlier".
          const floor = GD.toMs(wall) <= GD.toMs(d.s0) ? wall : d.s0;
          if (GD.toMs(s) < GD.toMs(floor)) {
            s = floor;
            if (d.type === 'm') e = GD.addDays(s, dur);
          }
        }
      }
      return { s, e, wall };
    }
    function startDrag(ev, p) {
      // Every fresh gesture clears any stale click-guard up front, so a guard
      // left over from a drag whose click never landed can't suppress this
      // interaction's own click.
      clickGuard.current = 0;
      const st = staged[p.id] || {};
      // A staged "pending complete" (st.done) locks the bar the same way an
      // already-approved completion does — Clear completion is the way back.
      if ((p.done && !st.reopened) || st.done || candidate || veil) return;
      setPop(null);
      const r = ev.currentTarget.getBoundingClientRect();
      const off = ev.clientX - r.left;
      // Edge zones scale with bar width (capped at 12px) so a narrow ~1-day bar
      // still keeps a real center "move" zone — a fixed 12px edge on both sides
      // used to swallow a short bar entirely, forcing every grab into a resize
      // and making such bars effectively un-draggable.
      const edge = Math.max(3, Math.min(12, r.width * 0.25));
      const type = off < edge ? 'l' : off > r.width - edge ? 'r' : 'm';
      // s0/e0 are the row's current on-screen (cascaded) dates — same p.start/
      // p.end the bar renders at — so the drag starts exactly under the cursor.
      dragRef.current = { id: p.id, p, type, x0: ev.clientX, s0: p.start, e0: p.end, moved: false };
      ev.currentTarget.setPointerCapture(ev.pointerId);
    }
    function moveDrag(ev) {
      const d = dragRef.current;
      if (!d) return;
      // Stale-drag guard: onPointerMove fires on plain hover too. If a pointerup
      // was ever missed (pointer capture lost when React re-rendered the bar
      // mid-drag, release outside the frame, …), dragRef would linger and the
      // bar would "follow the cursor" untouched — the phantom-move / repulsion.
      // No button held (buttons === 0) means this is a hover: drop the ref, bail.
      if (ev.buttons === 0) { dragRef.current = null; setDrag(null); return; }
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
      clickGuard.current = Date.now();
      const r = calcDrag(d, ev.clientX);
      setDrag(null);
      if (r.s !== d.p.start || r.e !== d.p.end || staged[d.id]) commitDates(d.p, r.s, r.e);
    }
    function barClick(ev, p) {
      ev.stopPropagation();
      // Swallow only the click that fires right after a move-drag (same gesture,
      // within a short window). A stale guard self-expires, so it never eats a
      // genuine, later click on this or any other process.
      if (clickGuard.current && Date.now() - clickGuard.current < 350) { clickGuard.current = 0; return; }
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
      // p.start/p.end come from the live-cascaded array, so they ALREADY carry
      // this row's staged edit PLUS any realignment shift — that's the current
      // on-screen position. Use it for edited and non-edited rows alike; using
      // the raw staged date for edited rows froze them in place while their
      // non-edited siblings shifted, tearing a phase apart on a big realign.
      // liveCascaded.ghosts holds the true "before" (last saved) position.
      const liveGhost = !candidate ? liveCascaded.ghosts[p.id] : null;
      // One-time reference: for a loaded draft, show where this process sat in
      // the last APPROVED plan — until the user's own edit takes over the ghost.
      const draftGhost = (pendingDraft && !candidate) ? draftGhosts[p.id] : null;
      const ds = isDrag ? drag.start : p.start;
      const de = isDrag ? drag.end : p.end;
      // A staged reopen (GEPopDone → reopen()) makes the row behave as if
      // p.done were already false, until the plan is saved or the reopen is
      // cleared — procs itself isn't mutated until then.
      const effectivelyDone = p.done && !(st && st.reopened);
      const stt = GD.status({ done: effectivelyDone, start: ds, end: de }, D.today);
      const left = pct(ds), width = wPct(ds, de);
      const rightPct = left + width;
      const barH = effectivelyDone ? Z_BAR_DONE : Z_BAR_H;
      const barY = (row.h - barH) / 2;
      const edited = isDrag || !!st || !!candGhost || !!liveGhost || !!draftGhost;
      // During an active drag, the ghost is simply wherever this row was the
      // instant before this gesture (p.start/p.end, i.e. shown's position) —
      // for anything already committed, it's the true "before" from ghosts;
      // an untouched draft row falls back to its approved-plan position.
      const ghost = isDrag ? { start: p.start, end: p.end } : (candGhost || liveGhost || draftGhost || null);
      // A staged mark-complete (st.done) locks the bar immediately, same as an
      // already-completed one — prevents a stray drag from silently discarding
      // the pending completion (commitDates would otherwise overwrite it).
      const editable = !effectivelyDone && !(st && st.done) && !candidate && !veil;
      const overs = !effectivelyDone && GD.toMs(de) > GD.toMs(D.dispatch);
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
        } else if (liveGhost && !st && !isDrag) {
          // Not a direct edit — this row realigned because an earlier edit moved
          // a prior phase, and the cascade keeps the gap while avoiding overlap.
          // Shift can be either direction: +Nd later, −Nd earlier.
          const sd = liveCascaded.shiftDaysById[p.id] || 0;
          extras.push(<span key="lg" className="ge-tag" style={{ left: 'calc(' + rightPct + '% + 6px)', top: row.h / 2 }}>{(sd >= 0 ? '+' : '−') + Math.abs(sd) + 'd'}</span>);
          badgeRightPx = 56;
        } else if (draftGhost && !st && !isDrag) {
          // Untouched draft row whose dates differ from the last approved plan.
          extras.push(<span key="dg" className="ge-tag" style={{ left: 'calc(' + rightPct + '% + 6px)', top: row.h / 2 }}>CHANGED</span>);
          badgeRightPx = 56;
        }
        // pending completion marker (staged mark-complete)
        if (st && st.done) {
          extras.push(<span key="dk" className="ge-check" style={{ left: 'calc(' + left + '% - 6px)', top: row.h / 2, opacity: 1 }}><window.GEIcon kind="check" size={11} sw={2.5} color={C.dispatch}></window.GEIcon></span>);
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
        // extras.push(<span key="lt" className="ge-nudge" style={{ left: 'calc(' + todayPct + '% + 6px)', top: row.h / 2 }}>{lateN}d over · update?</span>);
      }

      const est = (p.name.length * 6.6 + 20) * zoom;
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
        <span key="lb" className="ge-label" style={Object.assign({ top: row.h / 2, color: labColor, fontWeight: labWeight, textDecoration: deco || 'none', fontSize: 12.5 * zoom }, labStyle)}>
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
          title={GD.fmtRange(ds, de) + ' · ' + GD.durDays(ds, de) + 'd'}>
          {editable && <div className="ge-frame" style={{ top: 7, height: barH }}></div>}
          {editable && <div className="ge-handle l"></div>}
          {editable && <div className="ge-handle r"></div>}
          {editable && <div className="ge-grip"><i></i><i></i><i></i><i></i><i></i><i></i></div>}
          {editable && <div className="ge-draghint">drag to move · edges resize</div>}
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
        // Current on-screen (cascaded) dates — matches the bar, so the popover
        // anchors to it and its date inputs open on where the row actually is.
        const ds = p.start, de = p.end;
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
        } else if (p.done && !(st && st.reopened)) {
          inner = <window.GEPopDone p={p} onReopen={() => reopen(p)} onClose={() => setPop(null)}></window.GEPopDone>;
        } else {
          inner = <window.GEPopEditFull key={p.id + (st ? '-st' : '')} p={p} cur={{ start: ds, end: de }} win={w} staged={st || null}
                    minStart={p.phase > 1 ? prevPhaseEnd(p.phase - 1) : null} today={D.today}
                    onApply={(s, e) => { commitDates(p, s, e); setPop(null); }}
                    onClear={() => { clearStaged(p.id); setPop(null); }}
                    onComplete={(v) => complete(p, v)}
                    onClose={() => setPop(null)}></window.GEPopEditFull>;
        }
        popEl = (
          <div className="ge-pop" style={sty} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            {inner}
          </div>
        );
      }
    }

    const candOverN = candidate ? candidate.procs.filter((p) => !p.done && GD.toMs(p.end) > GD.toMs(D.dispatch)).length : 0;
    const draftN = Object.keys(draftGhosts).length;

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
      <div className="ge-root" ref={rootRef} style={{ '--ge-scale': zoom }}
        onClick={() => setPop(null)}
        onPointerDown={() => { if (drag && !dragRef.current) setDrag(null); }}>
        <window.GEStyles></window.GEStyles>
        {!embed && D.source === 'demo' && <div className="ge-ribbon">DEMO DATA — PASS #data=… FOR A REAL PLAN</div>}

        <div className="ge-top">
          <div className="ge-count">
            <span className="ge-count-num" style={{ color: dtd < 0 ? C.delayed : '#fafafa' }}>{Math.abs(dtd)}</span>
            <span className="ge-count-lab">{dtd >= 0 ? 'days to dispatch' : 'days past dispatch'}</span>
          </div>
          <div className={'ge-actions' + (full ? ' big' : '')}>
            <button className="ge-btn icon-only ghost" onClick={toggleFull} title={full ? 'Exit full screen' : 'View full screen'}>
              <window.GEIcon kind={full ? 'minimize' : 'expand'} size={full ? 15 : 13} sw={2.5}></window.GEIcon>
            </button>
            {candidate ? (
              <React.Fragment>
                <button className="ge-btn" onClick={discard}>Discard</button>
                <button className="ge-btn solid" onClick={approve}><window.GEIcon kind="check" size={full ? 13 : 12} sw={2.5}></window.GEIcon> Approve plan</button>
              </React.Fragment>
            ) : stagedN > 0 ? (
              <React.Fragment>
                <button className="ge-btn" onClick={cancelChanges}>Cancel</button>
                <button className="ge-btn solid" onClick={() => saveAndApprove(staged)}>
                  <window.GEIcon kind="check" size={full ? 13 : 12} sw={2.5}></window.GEIcon> Approve plan
                </button>
              </React.Fragment>
            ) : pendingDraft ? (
              <React.Fragment>
                <button className="ge-btn" onClick={discard}>Discard</button>
                <button className="ge-btn solid" onClick={approveDraft}>
                  <window.GEIcon kind="check" size={full ? 13 : 12} sw={2.5}></window.GEIcon> Approve plan
                </button>
              </React.Fragment>
            ) : null}
          </div>
        </div>

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

        {pendingDraft && !candidate && (
          <div className="ge-banner cand">
            <window.GEIcon kind="check" size={13} sw={2.5}></window.GEIcon>
            <span>
              Pending draft{draftN > 0 ? ' — ' + draftN + ' step' + (draftN === 1 ? '' : 's') + ' changed from the last approved plan' : ''}. Edit if needed, then approve.
            </span>
          </div>
        )}

        <div className={'ge-card' + (candidate ? ' approval' : '')} ref={cardRef}>
          <div className={'ge-axis-sticky' + (candidate ? ' approval' : '')}>
            {months.map((m, i) => <div key={'m' + i} className="ge-axis-month" style={{ left: m.x + '%' }}>{m.label}</div>)}
            {ticks.map((t, i) => <div key={'d' + i} className="ge-axis-day" style={{ left: t.x + '%' }}>{t.label}</div>)}
            <div className="ge-badge" style={{ left: dispPct + '%', top: 5, background: C.dispatch, color: '#04150d', zIndex: 6 }}>DISPATCH · {GD.fmt(D.dispatch).toUpperCase()}</div>
            <div className="ge-badge" style={{ left: todayPct + '%', top: 5, background: '#fff', color: '#0b0d12', zIndex: 7 }}>TODAY · {GD.fmt(D.today).toUpperCase()}</div>
          </div>
          <div className="ge-layer" style={{ height: chartH }}>
            {ticks.map((t, i) => <div key={'g' + i} className="ge-grid" style={{ left: t.x + '%' }}></div>)}

            <div className="ge-zone" style={{ left: dispPct + '%', width: (100 - dispPct) + '%', top: 48, bottom: 10 }}></div>
            <div className="ge-vline" style={{ left: dispPct + '%', top: 48, bottom: 8, width: 2, marginLeft: -1, background: C.dispatch, boxShadow: '0 0 10px rgba(16,185,129,.4)', zIndex: 3 }}></div>

            {layout.map((r) => {
              if (r.kind === 'phase') {
                return (
                  <div key={'ph' + r.num} className="ge-row" style={{ top: r.y, height: Z_PHASE_H }}>
                    <div className="ge-phase-rule"></div>
                    <div className="ge-phase-label" style={{ top: Math.round(9 * zoom) }}>{r.label || ('PHASE ' + r.num)}</div>
                  </div>
                );
              }
              return renderProcRow(r);
            })}

            <div className="ge-vline" style={{ left: todayPct + '%', top: 44, bottom: 8, width: 10, marginLeft: -5, background: 'rgba(255,255,255,.05)', zIndex: 4 }}></div>
            <div className="ge-vline" style={{ left: todayPct + '%', top: 44, bottom: 8, width: 2, marginLeft: -1, background: '#fff', zIndex: 4 }}></div>

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

        {/* Footer line, in priority order: a transient toast from the action you
            just took, then the review hint while a candidate is on screen (it
            beats a stale approval note there), then the last chat message, then
            the interaction hint it replaces. */}
        <div className="ge-foot">
          {toast ? (
            <span className={'ge-toast ' + toast.tone}>{toast.text}</span>
          ) : candidate ? (
            <span>Click any bar to see what changed.</span>
          ) : lastMsg ? (
            <span
              ref={msgRef}
              className={'ge-msg' + (msgOpen ? ' exp' : '') + (msgClipped ? ' can' : '')}
              onClick={msgClipped ? () => setMsgOpen(!msgOpen) : undefined}
              title={msgClipped && !msgOpen ? 'Show full message' : undefined}
            >{lastMsg}</span>
          ) : (
            <span>Drag a bar to move it · drag an edge to resize · click a bar for exact dates or to mark complete.</span>
          )}
        </div>
      </div>
    );
  }

  window.GanttEdit = GanttEdit;
})();
