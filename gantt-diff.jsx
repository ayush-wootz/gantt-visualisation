// gantt-diff.jsx  (v2)
//
// Changes vs v1:
//   - Header stripped to the minimum: countdown + (diff mode only) one
//     "+Nd vs approved" delta. No chips, no legend, no mode tag.
//   - Completed = flag only (data layer). Completed bars are now clearly
//     visible: 12px solid bar, brighter label, green tick. No strikethrough.
//   - "Overdue" replaces date-derived "delayed": end passed, flag false →
//     red outline + striped overrun from END to TODAY (work that should
//     have finished by now).
//   - RED ONLY WHERE THE BAR IS: overshoot stripes start at
//     max(barStart, dispatchX) — a bar entirely past dispatch is fully
//     striped from its own start, never from the dispatch line backwards.
//   - Diff signal moved onto the bars: changed bars get a solid amber
//     2px outline + ghost above + dashed connector; added bars get a teal
//     2px outline + NEW tag; removed rows are dim struck ghosts.

(function () {
  const e = React.createElement;
  const G = window.GanttDiffData;
  const fmt = G.fmt;

  const ROW_H = 34;
  const ROW_H_DONE = 26;
  const ROW_H_REMOVED = 22;
  const PHASE_HEADER_H = 22;
  const PHASE_GAP = 2;
  const BAR_H = 22;
  const BAR_H_DONE = 12;
  const GHOST_H = 6;
  const LEFT_PAD = 24;
  const RIGHT_PAD = 24;
  const TOP_PAD = 64;
  const BOTTOM_PAD = 24;

  const C = {
    completed: '#71717a',
    completedTx: '#a1a1aa',
    upcoming: '#a1a1aa',
    upcomingFill: 'rgba(161,161,170,0.05)',
    active: '#f59e0b',
    delayed: '#ef4444',
    dispatch: '#10b981',
    ghost: '#9ca3af',
    added: '#14b8a6',
    changed: '#f59e0b',
  };

  function GanttDiff() {
    const D = G.build();
    const headlineColor = D.daysToDispatch < 0 ? C.delayed : '#fafafa';

    return e('div', { className: 'gd-root' },
      e(StyleBlock, null),
      e('div', { className: 'gd-header' },
        e('div', null,
          D.diffMode && D.endShiftDays !== 0 && e('span', {
            className: 'gd-shift',
            style: { color: D.endShiftDays > 0 ? '#fca5a5' : '#86efac' },
          }, (D.endShiftDays > 0 ? '+' : '') + D.endShiftDays + 'd vs approved'),
        ),
        e('div', { className: 'gd-countdown' },
          e('b', { style: { color: headlineColor } }, Math.abs(D.daysToDispatch)),
          ' ' + (D.daysToDispatch >= 0 ? 'days to dispatch' : 'days past dispatch')),
      ),
      e(Chart, { D }),
    );
  }

  // ------------------------------------------------------------------------
  function Chart({ D }) {
    const procs = D.processes;
    const containerRef = React.useRef(null);
    const [width, setWidth] = React.useState(1200);
    const [tip, setTip] = React.useState(null);   // { p, x, y } | null

    React.useEffect(() => {
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) setWidth(entry.contentRect.width);
      });
      if (containerRef.current) ro.observe(containerRef.current);
      return () => ro.disconnect();
    }, []);

    const maxEnd = Math.max(...procs.map(p => p.end), D.dispatch, D.today);
    const hasOvershoot = procs.some(p => p.overshoots);
    const tMin = G.addDays(Math.min(D.projStart, D.today), -2);
    const tMax = G.addDays(maxEnd, hasOvershoot ? 10 : 2);
    const totalDays = G.daysBetween(tMin, tMax) + 1;

    const chartW = Math.max(900, width);
    const usableW = chartW - LEFT_PAD - RIGHT_PAD;
    const dayW = usableW / (totalDays - 1);
    const dayToX = (ms) => LEFT_PAD + G.daysBetween(tMin, ms) * dayW;

    const rows = [];
    let lastPhase = null;
    let yCursor = TOP_PAD;
    for (const p of procs) {
      if (p.phase !== lastPhase) {
        if (lastPhase !== null) yCursor += PHASE_GAP;
        rows.push({ kind: 'phase', phase: p.phase, y: yCursor });
        yCursor += PHASE_HEADER_H;
        lastPhase = p.phase;
      }
      const rowH = p.diffStatus === 'removed' ? ROW_H_REMOVED
                 : p.status === 'completed' ? ROW_H_DONE
                 : ROW_H;
      rows.push({ kind: 'proc', p, y: yCursor, rowH });
      yCursor += rowH;
    }
    const chartH = yCursor + BOTTOM_PAD;

    const todayX = dayToX(D.today);
    const dispatchX = dayToX(D.dispatch);

    // Click-only: clicking a bar/label toggles its tooltip. Clicking the same
    // one again, or the empty chart background, closes it.
    const clickTip = (p, evt) => {
      const wrap = containerRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      if (tip && tip.p.key === p.key) { setTip(null); return; }
      setTip({ p, x: evt.clientX - rect.left, y: evt.clientY - rect.top });
    };

    return e('div', { className: 'gd-chart-wrap', ref: containerRef, style: { position: 'relative' } },
      e('svg', {
        width: chartW, height: chartH, viewBox: `0 0 ${chartW} ${chartH}`, className: 'gd-svg',
        onClick: (evt) => { if (evt.target.tagName === 'svg') setTip(null); },
      },
        e('defs', null,
          e('pattern', { id: 'gd-stripe', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
            e('rect', { width: 6, height: 6, fill: 'rgba(239,68,68,0.22)' }),
            e('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: C.delayed, strokeWidth: 2, opacity: 0.95 }),
          ),
          e('pattern', { id: 'gd-stripe-bg', width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
            e('rect', { width: 8, height: 8, fill: 'rgba(239,68,68,0.04)' }),
            e('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: '#ef4444', strokeWidth: 1, opacity: 0.15 }),
          ),
          e('filter', { id: 'gd-glow', x: '-10%', y: '-50%', width: '120%', height: '200%' },
            e('feGaussianBlur', { stdDeviation: '2', result: 'b' }),
            e('feMerge', null, e('feMergeNode', { in: 'b' }), e('feMergeNode', { in: 'SourceGraphic' })),
          ),
        ),

        e('rect', {
          x: dispatchX, y: TOP_PAD - 8,
          width: Math.max(0, chartW - dispatchX), height: chartH - TOP_PAD - BOTTOM_PAD + 16,
          fill: 'url(#gd-stripe-bg)',
        }),

        e(DateAxis, { tMin, totalDays, dayToX, chartH }),

        e('g', null,
          e('line', { x1: dispatchX, y1: TOP_PAD - 6, x2: dispatchX, y2: chartH - BOTTOM_PAD + 4, stroke: C.dispatch, strokeWidth: 2 }),
          e('line', { x1: dispatchX, y1: TOP_PAD - 6, x2: dispatchX, y2: chartH - BOTTOM_PAD + 4, stroke: C.dispatch, strokeWidth: 8, opacity: 0.12 }),
          e('rect', { x: dispatchX - 42, y: TOP_PAD - 28, width: 84, height: 20, rx: 4, fill: C.dispatch }),
          e('text', { x: dispatchX, y: TOP_PAD - 14, fontSize: 11, fontWeight: 800, fill: '#062314', textAnchor: 'middle', letterSpacing: 0.5 }, 'DISPATCH'),
        ),

        ...rows.map((r, i) => {
          if (r.kind === 'phase') return e(PhaseHeader, { key: 'ph' + i, y: r.y, phaseNum: r.phase, chartW });
          return e(DiffBar, {
            key: r.p.key + '-' + i, p: r.p, y: r.y, rowH: r.rowH, dayToX, dayW, dispatchX, todayX, chartW,
            onClick: clickTip,
          });
        }),

        e('g', null,
          e('line', { x1: todayX, y1: TOP_PAD - 4, x2: todayX, y2: chartH - BOTTOM_PAD + 4, stroke: '#fff', strokeWidth: 10, opacity: 0.06 }),
          e('line', { x1: todayX, y1: TOP_PAD - 4, x2: todayX, y2: chartH - BOTTOM_PAD + 4, stroke: '#ffffff', strokeWidth: 2 }),
          e('rect', { x: todayX - 46, y: 8, width: 92, height: 20, rx: 4, fill: '#ffffff' }),
          e('text', { x: todayX, y: 22, fontSize: 11, fontWeight: 800, fill: '#0b0d12', textAnchor: 'middle', letterSpacing: 0.5 },
            'TODAY · ' + fmt(D.today, { short: true }).toUpperCase()),
        ),
      ),
      tip && e(Tooltip, { tip, chartW }),
    );
  }

  // ------------------------------------------------------------------------
  function Tooltip({ tip, chartW }) {
    const p = tip.p;
    const W = 210;
    let left = tip.x + 14;
    if (left + W > chartW - 8) left = tip.x - W - 14;
    if (left < 8) left = 8;
    const top = Math.max(8, tip.y + 14);

    const statusLabel = {
      completed: 'Completed', active: 'In progress', upcoming: 'Upcoming',
      overdue: 'Overdue', removed: 'Removed',
    }[p.status] || p.status;
    const statusColor = {
      completed: '#86efac', active: '#fde68a', upcoming: '#d4d4d8',
      overdue: '#fca5a5', removed: '#9ca3af',
    }[p.status] || '#d4d4d8';

    const rows = [];
    rows.push(['Status', statusLabel, statusColor]);

    if (p.ghost) {
      rows.push(['Current', fmt(p.ghost.start, { short: true }) + ' → ' + fmt(p.ghost.end, { short: true }), '#9ca3af']);
      rows.push(['Proposed', fmt(p.start, { short: true }) + ' → ' + fmt(p.end, { short: true }), '#fde68a']);
    } else {
      rows.push(['Start', fmt(p.start, { full: true }), '#e5e7eb']);
      rows.push(['End', fmt(p.end, { full: true }), '#e5e7eb']);
    }

    return e('div', { className: 'gd-tip', style: { left, top, width: W } },
      e('div', { className: 'gd-tip-title' }, p.name),
      e('div', { className: 'gd-tip-rows' },
        ...rows.map((r, i) => e('div', { key: i, className: 'gd-tip-row' },
          e('span', { className: 'gd-tip-k' }, r[0]),
          e('span', { className: 'gd-tip-v', style: { color: r[2] } }, r[1]),
        )),
      ),
    );
  }

  // ------------------------------------------------------------------------
  function DateAxis({ tMin, totalDays, dayToX, chartH }) {
    let tickEvery;
    if (totalDays <= 21) tickEvery = 2;
    else if (totalDays <= 60) tickEvery = 5;
    else if (totalDays <= 120) tickEvery = 7;
    else tickEvery = 14;

    const ticks = [];
    const months = [];
    let lastMonth = null;
    for (let i = 0; i < totalDays; i++) {
      const ms = G.addDays(tMin, i);
      const d = new Date(ms);
      if (d.getUTCMonth() !== lastMonth) {
        months.push({ x: dayToX(ms), label: fmt(ms, { month: true }).toUpperCase() });
        lastMonth = d.getUTCMonth();
      }
      if (i % tickEvery === 0) ticks.push({ x: dayToX(ms), label: d.getUTCDate() });
    }

    return e('g', null,
      ...months.map((m, i) => e('text', { key: 'mo' + i, x: m.x + 4, y: 50, fontSize: 10, fill: '#6b7280', fontWeight: 700, letterSpacing: 1.5 }, m.label)),
      ...ticks.map((t, i) => e('g', { key: 't' + i },
        e('text', { x: t.x, y: 36, fontSize: 11, fill: '#9ca3af', textAnchor: 'middle', fontWeight: 500 }, t.label),
        e('line', { x1: t.x, y1: TOP_PAD - 6, x2: t.x, y2: chartH - BOTTOM_PAD, stroke: '#2a2a2a', strokeWidth: 1 }),
      )),
    );
  }

  function PhaseHeader({ y, phaseNum, chartW }) {
    const label = phaseNum === 999 ? 'FINAL PHASE' : phaseNum === 998 ? 'UNASSIGNED' : 'PHASE ' + phaseNum;
    return e('g', null,
      e('line', { x1: LEFT_PAD, y1: y + 0.5, x2: chartW - RIGHT_PAD, y2: y + 0.5, stroke: '#2a2a2a', strokeWidth: 1 }),
      e('text', { x: LEFT_PAD, y: y + 16, fontSize: 10, fontWeight: 700, letterSpacing: 2, fill: '#71717a' }, label),
    );
  }

  // ------------------------------------------------------------------------
  function DiffBar({ p, y, rowH, dayToX, dayW, dispatchX, todayX, chartW, onClick }) {
    const xStart = dayToX(p.start);
    const xEnd = dayToX(p.end) + dayW * 0.5;
    const w = xEnd - xStart;

    // Hit targets: bar + label only, click-only (no hover).
    // Computed per-branch below via makeHits(barXY) so the rect matches the
    // actual bar, and a label rect matches where the process name is drawn.
    const labelW = (txt) => String(txt || '').length * 7 + 8;  // rough text width
    const clickHandler = (ev) => { ev.stopPropagation(); onClick && onClick(p, ev); };

    // hitBar: transparent rect over the bar; hitLabel: rect over the name text.
    const makeHits = (bx, by, bw_, bh, lblX, lblAnchor, lblTxt, lblY) => {
      const hits = [];
      // bar hit
      hits.push(e('rect', {
        key: 'hitbar', x: bx, y: by - 3, width: Math.max(bw_, 8), height: bh + 6,
        fill: 'transparent', style: { cursor: 'pointer' }, onClick: clickHandler,
      }));
      // label hit — position depends on text anchor
      if (lblTxt) {
        const lw = labelW(lblTxt);
        const lx = lblAnchor === 'end' ? lblX - lw : lblX;
        hits.push(e('rect', {
          key: 'hitlbl', x: lx, y: (lblY || by) - 11, width: lw, height: 18,
          fill: 'transparent', style: { cursor: 'pointer' }, onClick: clickHandler,
        }));
      }
      return hits;
    };
    const wrap = (...kids) => e('g', { className: 'gd-bar-row' }, ...kids);

    // ───────── removed (diff mode only)
    if (p.diffStatus === 'removed') {
      const barY = y + (rowH - GHOST_H) / 2;
      return wrap(
        e('rect', { x: xStart, y: barY, width: w, height: GHOST_H, rx: 2, fill: C.ghost, opacity: 0.3 }),
        e('text', {
          x: xStart - 8, y: y + rowH / 2 + 4, fontSize: 11.5, fill: '#71717a',
          textAnchor: 'end', textDecoration: 'line-through',
        }, p.name),
        e('text', { x: xEnd + 8, y: y + rowH / 2 + 4, fontSize: 9, fontWeight: 700, fill: '#71717a', letterSpacing: 1 }, 'REMOVED'),
        ...makeHits(xStart, barY, w, GHOST_H, xStart - 8, 'end', p.name, y + rowH / 2 + 4),
      );
    }

    const isDone = p.status === 'completed';
    const barH = isDone ? BAR_H_DONE : BAR_H;
    const barY = y + (rowH - barH) / 2;
    const rowMidY = y + rowH / 2 + 4;
    const labelText = p.name;
    const fitsInside = !isDone && w >= labelText.length * 6.5 + 16;

    let labelX, labelAnchor;
    if (fitsInside) { labelX = xStart + 10; labelAnchor = 'start'; }
    else {
      const placeRight = xStart < todayX - 30;
      labelX = placeRight ? xEnd + 8 : xStart - 8;
      labelAnchor = placeRight ? 'start' : 'end';
    }

    // Ghost (approved position) — only for changed processes in diff mode
    const ghostEls = [];
    if (p.ghost) {
      const gx1 = dayToX(p.ghost.start);
      const gx2 = dayToX(p.ghost.end) + dayW * 0.5;
      const ghostY = Math.max(y + 1, barY - GHOST_H - 2);
      ghostEls.push(
        e('rect', { key: 'gh', x: gx1, y: ghostY, width: gx2 - gx1, height: GHOST_H, rx: 2, fill: C.ghost, opacity: 0.3 }),
        e('line', {
          key: 'gc', x1: gx2, y1: ghostY + GHOST_H / 2, x2: xEnd, y2: barY + barH / 2,
          stroke: C.ghost, strokeWidth: 1, strokeDasharray: '2,3', opacity: 0.55,
        }),
      );
    }

    // Diff outline: amber for changed, teal for added — drawn over the bar
    const diffOutline = p.diffStatus === 'changed' ? C.changed
                      : p.diffStatus === 'added' ? C.added
                      : null;
    const diffEls = [];
    if (diffOutline && !isDone) {
      diffEls.push(e('rect', {
        key: 'do', x: xStart - 1.5, y: barY - 1.5, width: w + 3, height: barH + 3,
        rx: 5, fill: 'none', stroke: diffOutline, strokeWidth: 2,
      }));
    }
    if (p.diffStatus === 'added') {
      diffEls.push(e('text', {
        key: 'newtag', x: labelAnchor === 'end' ? labelX - labelText.length * 7 - 10 : labelX + labelText.length * 6.8 + 8,
        y: rowMidY, fontSize: 9, fontWeight: 800, fill: C.added, letterSpacing: 1,
        textAnchor: labelAnchor === 'end' ? 'end' : 'start',
      }, 'NEW'));
    }

    // ───────── completed — visible now: 12px solid bar, bright label
    if (isDone) {
      return wrap(
        ...ghostEls,
        e('rect', { x: xStart, y: barY, width: w, height: barH, rx: 3, fill: C.completed, opacity: 0.75 }),
        e('text', { x: xStart - 6, y: rowMidY, fontSize: 11, fill: C.dispatch, textAnchor: 'end' }, '✓'),
        e('text', {
          x: xEnd + 8, y: rowMidY, fontSize: 12, fill: C.completedTx, fontWeight: 500, textAnchor: 'start',
        }, labelText),
        ...diffEls,
        ...makeHits(xStart, barY, w, barH, xEnd + 8, 'start', labelText, rowMidY),
      );
    }

    // Shared geometry for the red zone — RED ONLY WHERE THE BAR IS.
    // redStart = the later of (bar start, dispatch line).
    const crossesDispatch = p.overshoots;
    const redStart = Math.max(xStart, dispatchX);
    const redW = crossesDispatch ? Math.max(0, xEnd - redStart) : 0;
    const onTimeW = crossesDispatch ? Math.max(0, Math.min(xEnd, dispatchX) - xStart) : w;

    // ───────── upcoming
    if (p.status === 'upcoming') {
      return wrap(
        ...ghostEls,
        onTimeW > 0 && e('rect', {
          x: xStart, y: barY, width: onTimeW, height: barH, rx: 4,
          fill: C.upcomingFill, stroke: C.upcoming, strokeWidth: 1.5,
        }),
        redW > 0 && e('rect', {
          x: redStart, y: barY, width: redW, height: barH, rx: 4,
          fill: 'url(#gd-stripe)', stroke: C.delayed, strokeWidth: 1.5,
        }),
        e('text', {
          x: labelX, y: rowMidY, fontSize: 13, fontWeight: 600,
          fill: crossesDispatch ? '#fecaca' : '#d4d4d8', textAnchor: labelAnchor,
        }, labelText),
        crossesDispatch && e('g', null,
          e('rect', { x: xEnd + 6, y: barY + 2, width: 96, height: barH - 4, rx: 3, fill: C.delayed }),
          e('text', {
            x: xEnd + 54, y: barY + barH / 2 + 4, fontSize: 10, fontWeight: 800,
            fill: '#fff', textAnchor: 'middle', letterSpacing: 0.3,
          }, p.overshootDays + ' DAY' + (p.overshootDays === 1 ? '' : 'S') + ' OVER'),
        ),
        ...diffEls,
        ...makeHits(xStart, barY, w, barH, labelX, labelAnchor, labelText, rowMidY),
      );
    }

    // ───────── overdue: end has passed, completed flag is false
    if (p.status === 'overdue') {
      return wrap(
        ...ghostEls,
        e('rect', {
          x: xStart, y: barY, width: w, height: barH, rx: 4,
          fill: 'rgba(239,68,68,0.18)', stroke: C.delayed, strokeWidth: 1.5,
        }),
        // Striped overrun: planned end → today
        todayX > xEnd && e('rect', {
          x: xEnd, y: barY, width: todayX - xEnd, height: barH, rx: 4,
          fill: 'url(#gd-stripe)',
        }),
        e('text', {
          x: labelX, y: rowMidY, fontSize: 12.5, fontWeight: 700,
          fill: '#fecaca', textAnchor: labelAnchor,
        }, labelText),
        e('g', null,
          e('rect', { x: todayX + 6, y: barY + 2, width: 76, height: barH - 4, rx: 3, fill: C.delayed }),
          e('text', {
            x: todayX + 44, y: barY + barH / 2 + 4, fontSize: 10, fontWeight: 800,
            fill: '#fff', textAnchor: 'middle', letterSpacing: 0.3,
          }, p.overdueDays + ' DAY' + (p.overdueDays === 1 ? '' : 'S') + ' LATE'),
        ),
        ...diffEls,
        ...makeHits(xStart, barY, w, barH, labelX, labelAnchor, labelText, rowMidY),
      );
    }

    // ───────── active
    const filledW = Math.max(0, Math.min(w, todayX - xStart));
    const remStart = Math.max(todayX, xStart);
    // On-time remainder runs from today to min(end, dispatch); red runs from
    // max(start, dispatch, today→clamped) to end.
    const remOnTimeW = crossesDispatch
      ? Math.max(0, Math.min(xEnd, dispatchX) - remStart)
      : Math.max(0, xEnd - remStart);
    const activeRedStart = Math.max(redStart, remStart);
    const activeRedW = crossesDispatch ? Math.max(0, xEnd - activeRedStart) : 0;

    return wrap(
      ...ghostEls,
      filledW > 0 && e('rect', { x: xStart, y: barY, width: filledW, height: barH, rx: 4, fill: C.active, filter: 'url(#gd-glow)' }),
      remOnTimeW > 0 && e('rect', {
        x: remStart, y: barY, width: remOnTimeW, height: barH, rx: 4,
        fill: 'rgba(245,158,11,0.10)', stroke: C.active, strokeWidth: 1.5,
      }),
      activeRedW > 0 && e('rect', {
        x: activeRedStart, y: barY, width: activeRedW, height: barH, rx: 4,
        fill: 'url(#gd-stripe)', stroke: C.delayed, strokeWidth: 1.5,
      }),
      e('text', {
        x: labelX, y: rowMidY, fontSize: fitsInside ? 13 : 12.5, fontWeight: 700,
        fill: fitsInside ? '#ffffff' : '#fef3c7', textAnchor: labelAnchor,
      }, labelText),
      w >= 80 && e('text', {
        x: xEnd - 6, y: rowMidY, fontSize: 10, fontWeight: 700,
        fill: '#fffbeb', opacity: 0.85, textAnchor: 'end',
      }, Math.round(p.progress * 100) + '%'),
      ...diffEls,
      ...makeHits(xStart, barY, w, barH, labelX, labelAnchor, labelText, rowMidY),
    );
  }

  // ------------------------------------------------------------------------
  function StyleBlock() {
    return e('style', null, `
      .gd-root {
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: #171717; color: #e5e7eb;
        padding: 18px 20px 20px; box-sizing: border-box;
      }
      .gd-header {
        display: flex; justify-content: space-between; align-items: baseline;
        gap: 16px; flex-wrap: wrap; margin-bottom: 12px;
      }
      .gd-shift { font-size: 12.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
      .gd-countdown { font-size: 12px; color: #9ca3af; }
      .gd-countdown b { font-size: 28px; font-weight: 800; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; margin-right: 4px; }
      .gd-chart-wrap {
        background: #0e0e0e; border: 1px solid #262626;
        border-radius: 10px; overflow: hidden;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
      }
      .gd-svg { display: block; width: 100%; }
      .gd-bar-row:hover { opacity: 0.96; }
      .gd-tip {
        position: absolute; z-index: 20; pointer-events: none;
        background: #1c1c1c; border: 1px solid #3a3a3a;
        border-radius: 8px; padding: 10px 12px;
        box-shadow: 0 6px 20px rgba(0,0,0,0.45);
      }
      .gd-tip-title { font-size: 13px; font-weight: 700; color: #fafafa; margin-bottom: 8px; }
      .gd-tip-rows { display: flex; flex-direction: column; gap: 4px; }
      .gd-tip-row { display: flex; justify-content: space-between; gap: 14px; font-size: 12px; }
      .gd-tip-k { color: #9ca3af; }
      .gd-tip-v { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
    `);
  }

  window.GanttDiff = GanttDiff;
})();
