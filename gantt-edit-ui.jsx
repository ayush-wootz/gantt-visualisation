// gantt-edit-ui.jsx — shared UI bits for the editable Gantt:
// colors, icons, chips, popover contents, and the stylesheet.

(function () {
  const GE_C = {
    bg: '#171717', card: '#0e0e0e', line: '#262626',
    completed: '#52525b', completedTx: '#71717a',
    upcoming: '#a1a1aa',
    active: '#f59e0b',
    delayed: '#ef4444',
    dispatch: '#10b981',
    ai: '#818cf8', aiDeep: '#6366f1', pending: '#60a5fa',
    txt: '#e5e7eb', mut: '#9ca3af', dim: '#6b7280',
  };

  const GE_PATHS = {
    check: 'M5 13l4 4L19 7',
    pencil: 'M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z',
    spark: 'M12 3l1.9 5.7 5.6 2.3-5.6 2.3L12 19l-1.9-5.7L4.5 11l5.6-2.3L12 3z',
    lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z',
    chart: 'M3 3v18h18M8 14v4M13 9v9M18 12v6',
  };

  function GEIcon({ kind, size, color, sw }) {
    return (
      <svg width={size || 13} height={size || 13} viewBox="0 0 24 24" fill="none"
        stroke={color || 'currentColor'} strokeWidth={sw || 2} strokeLinecap="round"
        strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <path d={GE_PATHS[kind] || ''}></path>
      </svg>
    );
  }

  function GEChip({ num, label, tone }) {
    const tones = {
      danger: { color: '#fecaca', bg: 'rgba(239,68,68,0.14)', dot: '#ef4444' },
      active: { color: '#fde68a', bg: 'rgba(245,158,11,0.12)', dot: '#f59e0b' },
      upcoming: { color: '#e4e4e7', bg: 'rgba(161,161,170,0.10)', dot: '#a1a1aa' },
      muted: { color: '#9ca3af', bg: 'rgba(255,255,255,0.04)', dot: '#52525b' },
      ai: { color: '#c7d2fe', bg: 'rgba(99,102,241,0.14)', dot: '#818cf8' },
    };
    const s = tones[tone] || tones.muted;
    return (
      <span className="ge-chip" style={{ background: s.bg, color: s.color }}>
        <span className="ge-chip-dot" style={{ background: s.dot }}></span>
        <span className="ge-chip-num">{num}</span>
        <span className="ge-chip-lab">{label}</span>
      </span>
    );
  }

  // Completion-date classification: matches plan / off-plan-in-window / beyond window.
  function GEClassifyCompletion(p, win, v) {
    const GD = window.GanttEditData;
    if (v === p.end) return { tone: 'ok', text: 'Matches the planned finish — saved directly.' };
    if (GD.toMs(v) <= GD.toMs(win.end)) {
      const early = GD.toMs(v) < GD.toMs(p.end);
      return { tone: 'ok', text: 'Finished ' + (early ? 'earlier than planned' : 'a little later than planned') + ' (planned ' + GD.fmt(p.end) + ') — saved, the plan adjusts.' };
    }
    return { tone: 'info', text: 'Finishes past the Phase ' + p.phase + ' plan — later steps will be rescheduled when you save.' };
  }

  // ── popover: view mode, incomplete ───────────────────────────────────────
  function GEPopView({ p, win, today, expandInit, onComplete, onEdit, onClose }) {
    const GD = window.GanttEditData;
    const [open, setOpen] = React.useState(!!expandInit);
    const [v, setV] = React.useState(today);
    const note = GEClassifyCompletion(p, win, v);
    return (
      <div>
        <div className="ge-pop-ttl"><span>{p.name}</span><span className="ge-x" onClick={onClose}>×</span></div>
        <div className="ge-prow"><span>Start</span><b>{GD.fmt(p.start)}</b></div>
        <div className="ge-prow"><span>End</span><b>{GD.fmt(p.end)}</b></div>
        <div className="ge-prow"><span>Duration</span><b>{GD.durDays(p.start, p.end)} days</b></div>
        {!open ? (
          <button className="ge-pbtn solid" onClick={() => setOpen(true)}><GEIcon kind="check" size={12} sw={2.5}></GEIcon> Mark complete</button>
        ) : (
          <div>
            <div className="ge-df"><label>Done on</label><input type="date" value={v} min={p.start} max={today} onChange={(e) => setV(e.target.value)}></input></div>
            <div className={'ge-note ' + note.tone}>{note.text}</div>
            <button className="ge-pbtn solid" onClick={() => onComplete(v)}>Confirm completion</button>
          </div>
        )}
        <button className="ge-pbtn" onClick={onEdit}><GEIcon kind="pencil" size={12}></GEIcon> Edit dates</button>
      </div>
    );
  }

  // ── popover: view mode, completed ────────────────────────────────────────
  function GEPopDone({ p, onReopen, onClose }) {
    const GD = window.GanttEditData;
    return (
      <div>
        <div className="ge-pop-ttl">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{p.name} <GEIcon kind="check" size={13} sw={2.5} color="#34d399"></GEIcon></span>
          <span className="ge-x" onClick={onClose}>×</span>
        </div>
        <div className="ge-prow"><span>Ran</span><b>{GD.fmtRange(p.start, p.end)}</b></div>
        <div className="ge-prow"><span>Completed on</span><b style={{ color: '#34d399' }}>{GD.fmt(p.completedOn || p.end)}</b></div>
        <div className="ge-locked"><GEIcon kind="lock" size={11}></GEIcon> Dates are locked. Reopen the process to edit them.</div>
        <button className="ge-pbtn" onClick={onReopen}>Reopen process</button>
      </div>
    );
  }

  // ── popover: edit mode, completed (locked) ───────────────────────────────
  function GEPopLocked({ p, onReopen, onClose }) {
    const GD = window.GanttEditData;
    return (
      <div>
        <div className="ge-pop-ttl">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{p.name} <GEIcon kind="check" size={13} sw={2.5} color="#34d399"></GEIcon></span>
          <span className="ge-x" onClick={onClose}>×</span>
        </div>
        <div className="ge-prow"><span>Completed on</span><b style={{ color: '#34d399' }}>{GD.fmt(p.completedOn || p.end)}</b></div>
        <div className="ge-locked"><GEIcon kind="lock" size={11}></GEIcon> Completed processes can't be dragged. Reopen first to edit dates.</div>
        <button className="ge-pbtn" onClick={onReopen}>Reopen process</button>
      </div>
    );
  }

  // ── popover: edit mode, date editor ──────────────────────────────────────
  function GEPopEdit({ p, cur, win, isStaged, onApply, onClear, onClose }) {
    const GD = window.GanttEditData;
    const [s, setS] = React.useState(cur.start);
    const [e2, setE2] = React.useState(cur.end);
    const err = GD.toMs(e2) < GD.toMs(s);
    const out = !err && (GD.toMs(s) < GD.toMs(win.start) || GD.toMs(e2) > GD.toMs(win.end));
    return (
      <div>
        <div className="ge-pop-ttl"><span>Edit dates</span><span className="ge-x" onClick={onClose}>×</span></div>
        <div className="ge-sub">{p.name} · Phase {p.phase} window {GD.fmtRange(win.start, win.end)}</div>
        <div className="ge-df"><label>Start</label><input type="date" value={s} onChange={(e) => setS(e.target.value)}></input></div>
        <div className="ge-df"><label>End</label><input type="date" value={e2} onChange={(e) => setE2(e.target.value)}></input></div>
        {err && <div className="ge-note err">End must be on or after start.</div>}
        {!err && (out
          ? <div className="ge-note ai"><GEIcon kind="spark" size={11}></GEIcon> Extends the Phase {p.phase} window — saving stages this edit for AI regeneration.</div>
          : <div className="ge-note ok">Inside the Phase {p.phase} window — applies instantly, no AI run.</div>)}
        <button className={'ge-pbtn ' + (out ? 'ai' : 'solid')} disabled={err} onClick={() => onApply(s, e2)}>
          {out ? 'Stage for AI regeneration' : 'Apply — saves instantly'}
        </button>
        {isStaged && <button className="ge-pbtn" onClick={onClear}>Clear staged edit</button>}
      </div>
    );
  }

  // ── popover: candidate mode (read-only compare) ──────────────────────────
  function GEPopCandidate({ p, ghost, onClose }) {
    const GD = window.GanttEditData;
    return (
      <div>
        <div className="ge-pop-ttl"><span>{p.name}</span><span className="ge-x" onClick={onClose}>×</span></div>
        {ghost ? (
          <div>
            <div className="ge-prow"><span>Was</span><b style={{ color: '#71717a', textDecoration: 'line-through' }}>{GD.fmtRange(ghost.start, ghost.end)}</b></div>
            <div className="ge-prow"><span>Candidate</span><b style={{ color: '#c7d2fe' }}>{GD.fmtRange(p.start, p.end)}</b></div>
            <div className="ge-note ai">Part of the AI candidate — approve or discard from the header.</div>
          </div>
        ) : (
          <div className="ge-prow"><span>Unchanged</span><b>{GD.fmtRange(p.start, p.end)}</b></div>
        )}
      </div>
    );
  }

  function GEStyles() {
    return (
      <style>{`
      .ge-root{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#171717;color:#e5e7eb;padding:16px 18px 14px;box-sizing:border-box;min-height:100%}
      .ge-ribbon{position:fixed;bottom:12px;right:14px;z-index:50;font-size:10px;font-weight:700;letter-spacing:1.5px;padding:4px 10px;border-radius:999px;background:rgba(99,102,241,0.18);color:#c7d2fe;border:1px solid rgba(99,102,241,0.4)}
      .ge-top{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px}
      .ge-title{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;color:#fafafa;white-space:nowrap}
      .ge-title svg{opacity:.45}
      .ge-pill{font-size:9.5px;font-weight:700;letter-spacing:1px;padding:3px 9px;border-radius:999px;border:1px solid;white-space:nowrap}
      .ge-pill.live{color:#a1a1aa;border-color:#3f3f46;background:rgba(255,255,255,0.03)}
      .ge-pill.cand{color:#c7d2fe;border-color:rgba(129,140,248,.45);background:rgba(99,102,241,.12)}
      .ge-pill.edit{color:#fde68a;border-color:rgba(245,158,11,.45);background:rgba(245,158,11,.10)}
      .ge-actions{display:flex;gap:8px;align-items:center}
      .ge-btn{font-size:12px;font-weight:600;padding:6px 12px;border-radius:7px;border:1px solid #3f3f46;background:#1f1f1f;color:#d4d4d8;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
      .ge-btn:hover{background:#262626}
      .ge-btn:disabled{opacity:.35;cursor:default;pointer-events:none}
      .ge-btn.ai{background:rgba(99,102,241,.14);border-color:rgba(129,140,248,.5);color:#c7d2fe}
      .ge-btn.ai:hover{background:rgba(99,102,241,.24)}
      .ge-btn.solid{background:#fafafa;border-color:#fafafa;color:#111}
      .ge-btn.solid:hover{background:#e4e4e7}
      .ge-hrow{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:12px}
      .ge-chips{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
      .ge-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap}
      .ge-chip-dot{width:6px;height:6px;border-radius:50%}
      .ge-chip-num{font-size:13px;font-weight:800;font-variant-numeric:tabular-nums;color:#fafafa}
      .ge-chip-lab{opacity:.85}
      .ge-count{display:inline-flex;align-items:baseline;gap:8px}
      .ge-count-num{font-size:28px;font-weight:800;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;line-height:1}
      .ge-count-lab{font-size:11.5px;color:#9ca3af}
      .ge-banner{display:flex;gap:9px;align-items:center;font-size:12px;line-height:1.45;padding:8px 12px;border-radius:8px;margin-bottom:10px;border:1px solid}
      .ge-banner.edit{background:rgba(245,158,11,.07);border-color:rgba(245,158,11,.22);color:#fcd34d}
      .ge-banner.cand{background:rgba(99,102,241,.09);border-color:rgba(129,140,248,.3);color:#c7d2fe}
      .ge-banner b.warn{color:#fca5a5;font-weight:600}
      .ge-card{position:relative;background:#0e0e0e;border:1px solid #262626;border-radius:10px;overflow:hidden;box-shadow:inset 0 1px 0 rgba(255,255,255,0.02)}
      .ge-layer{position:relative;margin:0 20px}
      .ge-grid{position:absolute;top:48px;bottom:12px;width:1px;background:#222;pointer-events:none}
      .ge-axis-month{position:absolute;top:8px;font-size:10px;color:#6b7280;font-weight:700;letter-spacing:1.5px;pointer-events:none}
      .ge-axis-day{position:absolute;top:31px;font-size:11px;color:#9ca3af;font-weight:500;transform:translateX(-50%);pointer-events:none}
      .ge-zone{position:absolute;pointer-events:none;background:repeating-linear-gradient(45deg,rgba(239,68,68,.045) 0 1.5px,rgba(239,68,68,0) 1.5px 9px)}
      .ge-vline{position:absolute;pointer-events:none}
      .ge-badge{position:absolute;transform:translateX(-50%);font-size:10px;font-weight:800;letter-spacing:.5px;padding:3px 9px;border-radius:4px;white-space:nowrap;pointer-events:none}
      .ge-row{position:absolute;left:0;right:0}
      .ge-phase-rule{position:absolute;left:0;right:0;top:0;height:1px;background:#242424}
      .ge-phase-label{position:absolute;left:0;font-size:10px;font-weight:700;letter-spacing:2px;color:#71717a}
      .ge-phase-win{position:absolute;height:2px;border-radius:1px;background:rgba(245,158,11,.28);pointer-events:none}
      .ge-seg{position:absolute;box-sizing:border-box;pointer-events:none}
      .ge-stripe{background-image:repeating-linear-gradient(45deg,rgba(239,68,68,.30) 0 2px,rgba(239,68,68,.06) 2px 6px);border:1.5px solid #ef4444}
      .ge-label{position:absolute;white-space:nowrap;pointer-events:none;font-size:12.5px;transform:translateY(-50%)}
      .ge-pct{position:absolute;white-space:nowrap;pointer-events:none;font-size:10px;font-weight:700;color:#fffbeb;opacity:.85;transform:translate(-100%,-50%)}
      .ge-check{position:absolute;transform:translate(-100%,-50%);pointer-events:none;display:flex;opacity:.65}
      .ge-mini{position:absolute;transform:translateY(-50%);font-size:9.5px;font-weight:800;letter-spacing:.4px;padding:3px 7px;border-radius:4px;background:#ef4444;color:#fff;white-space:nowrap;pointer-events:none}
      .ge-tag{position:absolute;transform:translateY(-50%);font-size:9px;font-weight:800;letter-spacing:.8px;padding:2px 6px;border-radius:4px;background:rgba(99,102,241,.16);border:1px solid rgba(129,140,248,.5);color:#c7d2fe;white-space:nowrap;pointer-events:none;display:inline-flex;align-items:center;gap:3px}
      .ge-hit{position:absolute;border-radius:6px;z-index:5;cursor:pointer;touch-action:none}
      .ge-hit.ge-editable{cursor:grab}
      .ge-hit.ge-editable:active{cursor:grabbing}
      .ge-hit.ge-editable:hover{background:rgba(255,255,255,.045)}
      .ge-handle{position:absolute;top:50%;transform:translateY(-50%);width:6px;height:14px;border-radius:3px;background:rgba(255,255,255,.5);opacity:0;transition:opacity .12s;cursor:col-resize}
      .ge-hit.ge-editable:hover .ge-handle{opacity:1}
      .ge-handle.l{left:2px}.ge-handle.r{right:2px}
      .ge-tip{position:absolute;z-index:9;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;background:#fafafa;color:#111;padding:3px 9px;border-radius:5px;white-space:nowrap;transform:translateY(-100%);font-weight:600;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.4)}
      .ge-tip .ai{color:#4f46e5;font-weight:700}
      .ge-band{position:absolute;background:rgba(245,158,11,.05);border-left:1px dashed rgba(245,158,11,.55);border-right:1px dashed rgba(245,158,11,.55);z-index:1;pointer-events:none}
      .ge-band-lab{position:absolute;top:3px;left:6px;font-size:8.5px;letter-spacing:1.2px;font-weight:700;color:rgba(245,158,11,.75);white-space:nowrap}
      .ge-pop{position:absolute;z-index:20;background:#1b1b1d;border:1px solid #333;border-radius:10px;padding:12px;font-size:12px;box-shadow:0 12px 32px rgba(0,0,0,.55)}
      .ge-pop-ttl{display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:600;color:#fafafa;margin-bottom:8px;gap:8px}
      .ge-x{cursor:pointer;color:#6b7280;font-size:15px;line-height:1;padding:0 2px;flex-shrink:0}
      .ge-x:hover{color:#e5e7eb}
      .ge-sub{font-size:10.5px;color:#8b8b93;margin-bottom:7px;line-height:1.45}
      .ge-prow{display:flex;justify-content:space-between;gap:10px;padding:2.5px 0;color:#a1a1aa}
      .ge-prow b{color:#e5e7eb;font-weight:600;text-align:right}
      .ge-df{display:flex;align-items:center;gap:8px;background:#121214;border:1px solid #2c2c30;border-radius:6px;padding:6px 9px;margin-top:6px}
      .ge-df label{font-size:9.5px;color:#6b7280;width:42px;flex:none;text-transform:uppercase;letter-spacing:.5px}
      .ge-df input{flex:1;background:transparent;border:none;color:#e5e7eb;font-family:inherit;font-size:12px;outline:none;color-scheme:dark;min-width:0}
      .ge-note{font-size:10.5px;line-height:1.5;margin-top:7px;padding:6px 8px;border-radius:6px;display:flex;gap:6px;align-items:flex-start}
      .ge-note svg{margin-top:2px}
      .ge-note.ok{color:#86efac;background:rgba(16,185,129,.08)}
      .ge-note.warn{color:#fde68a;background:rgba(245,158,11,.09)}
      .ge-note.ai{color:#c7d2fe;background:rgba(99,102,241,.13)}
      .ge-note.err{color:#fca5a5;background:rgba(239,68,68,.10)}
      .ge-pbtn{width:100%;margin-top:7px;text-align:center;padding:6px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid #3f3f46;background:#222224;color:#d4d4d8;display:flex;align-items:center;justify-content:center;gap:6px;font-family:inherit}
      .ge-pbtn:hover{background:#2a2a2d}
      .ge-pbtn:disabled{opacity:.35;cursor:default;pointer-events:none}
      .ge-pbtn.solid{background:#fafafa;border-color:#fafafa;color:#111}
      .ge-pbtn.solid:hover{background:#e4e4e7}
      .ge-pbtn.ai{background:rgba(99,102,241,.16);border-color:rgba(129,140,248,.5);color:#c7d2fe}
      .ge-pbtn.ai:hover{background:rgba(99,102,241,.26)}
      .ge-locked{font-size:10.5px;color:#8b8b93;line-height:1.5;margin-top:7px;padding:6px 8px;background:#121214;border:1px solid #26262a;border-radius:6px;display:flex;gap:6px;align-items:flex-start}
      .ge-locked svg{margin-top:1px;flex-shrink:0}
      .ge-veil{position:absolute;inset:0;z-index:30;background:rgba(10,10,11,.82);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center}
      .ge-vbox{display:flex;flex-direction:column;align-items:center;gap:10px;font-size:13px;color:#c7d2fe;text-align:center}
      .ge-vbox small{font-size:11px;color:#6b7280}
      .ge-spin{width:22px;height:22px;border:2px solid rgba(129,140,248,.25);border-top-color:#818cf8;border-radius:50%;animation:gesp .7s linear infinite}
      @keyframes gesp{to{transform:rotate(360deg)}}
      .ge-foot{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px;font-size:11.5px;color:#8b8b93;min-height:22px}
      .ge-toast.ok{color:#6ee7b7}
      .ge-toast.warn{color:#fcd34d}
      .ge-toast.ai{color:#c7d2fe}
      .ge-toast.err{color:#fca5a5}
      .ge-chipedit{display:inline-flex;gap:6px;align-items:center;border:1px solid rgba(129,140,248,.4);background:rgba(99,102,241,.10);color:#c7d2fe;border-radius:999px;padding:3px 10px;font-size:10.5px;white-space:nowrap}
      .ge-chipedit button{all:unset;cursor:pointer;color:#818cf8;font-size:13px;line-height:1;padding:0 1px}
      .ge-chipedit button:hover{color:#e0e7ff}
      `}</style>
    );
  }

  Object.assign(window, {
    GE_C, GEIcon, GEChip, GEStyles, GEClassifyCompletion,
    GEPopView, GEPopDone, GEPopLocked, GEPopEdit, GEPopCandidate,
  });
})();
