// Gantt Focus — single, story-driven view (status-driven colors).
//
// First-look story, no words required:
//   - Eye lands on the bright TODAY spine.
//   - Completed rows are quiet gray — they recede.
//   - Bars in AMBER are happening right now. Split into solid (done) and
//     outlined (remaining) so you see the % done at a glance.
//   - PALE outlined bars to the right of today are upcoming, planned.
//   - RED bars + striped extensions: delayed (past their end) — pulsing.
//   - RED stripes PAST the green DISPATCH line: this work won't make it.
//     Pulses softly. A counter at the top nags you to fix the plan.
//
// Phases are NOT colored on bars. Phase identity is conveyed by:
//   1. Row grouping (all phase-3 rows sit together).
//   2. A subtle phase header above each group.
// This keeps color = status (one meaning), grouping = phase (no clash).

(function () {
  const e = React.createElement;
  const fmt = window.GanttData.fmt;
  const daysBetween = window.GanttData.daysBetween;

  // Layout
  const ROW_H = 34;             // active / upcoming row height
  const ROW_H_DONE = 20;        // completed rows are tighter — they recede
  const PHASE_HEADER_H = 22;    // tightened
  const PHASE_GAP = 2;          // gap between phase groups
  const BAR_H = 22;
  const BAR_H_DONE = 6;
  const LEFT_PAD = 24;
  const RIGHT_PAD = 24;
  const TOP_PAD = 64;
  const BOTTOM_PAD = 24;

  // Status-only color palette. Calm + meaningful.
  const C = {
    completed:    '#52525b',  // muted slate
    completedTx:  '#71717a',
    upcoming:     '#a1a1aa',  // pale neutral
    upcomingFill: 'rgba(161,161,170,0.05)',
    active:       '#f59e0b',  // amber — single warm "this is happening"
    delayed:      '#ef4444',  // red — the only alert color
    dispatch:     '#10b981',  // green — the destination
  };

  function GanttFocus() {
    const D = window.GanttData.build();

    // Sort by phase, then start. Phase order ≈ time order, so the chart
    // still reads left-to-right as a flow.
    const procs = [...D.processes].sort((a, b) => a.phase - b.phase || a.start - b.start);

    const counts = {
      completed: procs.filter(p => p.status === 'completed').length,
      active: procs.filter(p => p.status === 'active').length,
      upcoming: procs.filter(p => p.status === 'upcoming').length,
      overshoot: procs.filter(p => p.overshoots).length,
    };
    // Countdown turns red ONLY when today is past the dispatch date.
    // Schedule overshoots are still surfaced via the "past dispatch" chip
    // and the per-bar striped overrun — the countdown itself stays calm.
    const headlineColor = D.daysToDispatch < 0 ? C.delayed : '#fafafa';

    return e('div', { className: 'gantt-focus-root' },
      e(StyleBlock, null),

      // ───── header — minimal, just the status chips + countdown
      e('div', { className: 'gf-header' },
        e('div', { className: 'gf-stat-row' },
          counts.overshoot > 0 && e(StatChip, { num: counts.overshoot, label: 'past dispatch', tone: 'danger' }),
          e(StatChip, { num: counts.active, label: 'in progress', tone: 'active' }),
          e(StatChip, { num: counts.upcoming, label: 'upcoming', tone: 'upcoming' }),
          e(StatChip, { num: counts.completed, label: 'done', tone: 'muted' }),
        ),
        e('div', { className: 'gf-countdown' },
          e('span', { className: 'gf-countdown-num', style: { color: headlineColor } }, Math.abs(D.daysToDispatch)),
          e('span', { className: 'gf-countdown-label' }, D.daysToDispatch >= 0 ? 'days to dispatch' : 'days past dispatch'),
        ),
      ),

      e(Chart, { D, procs }),
    );
  }

  // ------------------------------------------------------------------------
  function Chart({ D, procs }) {
    const containerRef = React.useRef(null);
    const [width, setWidth] = React.useState(1200);

    React.useEffect(() => {
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) setWidth(entry.contentRect.width);
      });
      if (containerRef.current) ro.observe(containerRef.current);
      return () => ro.disconnect();
    }, []);

    // Time range — extend right side to include any overshoot, plus
    // extra padding when overshoots exist so the "OVER" badge fits.
    const maxEnd = Math.max(...procs.map(p => p.end), D.dispatch);
    const hasOvershoot = procs.some(p => p.overshoots);
    const tMin = window.GanttData.addDays(D.projStart, -2);
    const tMax = window.GanttData.addDays(maxEnd, hasOvershoot ? 10 : 2);
    const totalDays = daysBetween(tMin, tMax) + 1;

    const chartW = Math.max(900, width);
    const usableW = chartW - LEFT_PAD - RIGHT_PAD;
    const dayW = usableW / (totalDays - 1);
    const dayToX = (ms) => LEFT_PAD + daysBetween(tMin, ms) * dayW;

    // Compute row positions, inserting phase header rows between groups.
    // Completed rows use a shorter ROW_H_DONE so they take less space.
    const rows = [];
    let lastPhase = -1;
    let yCursor = TOP_PAD;
    let scrollTargetY = null;
    for (const p of procs) {
      if (p.phase !== lastPhase) {
        if (lastPhase !== -1) yCursor += PHASE_GAP;
        // First phase whose group has any non-completed work → auto-scroll target
        if (scrollTargetY === null && procs.some(q => q.phase === p.phase && q.status !== 'completed')) {
          scrollTargetY = yCursor;
        }
        rows.push({ kind: 'phase', phase: p.phase, y: yCursor });
        yCursor += PHASE_HEADER_H;
        lastPhase = p.phase;
      }
      const rowH = p.status === 'completed' ? ROW_H_DONE : ROW_H;
      rows.push({ kind: 'proc', p, y: yCursor, rowH });
      yCursor += rowH;
    }
    const chartH = yCursor + BOTTOM_PAD;

    const todayX = dayToX(D.today);
    const dispatchX = dayToX(D.dispatch);

    // Auto-scroll so the first active phase header sits just under the date axis.
    React.useEffect(() => {
      if (scrollTargetY === null || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      // Pull view down so phase header is ~8px below the top of the chart container.
      const target = rect.top + window.scrollY + scrollTargetY - TOP_PAD + 6;
      if (target > 0 && target > window.scrollY) {
        window.scrollTo({ top: target, behavior: 'auto' });
      }
    }, [scrollTargetY]);

    return e('div', { className: 'gf-chart-wrap', ref: containerRef },
      e('svg', {
        width: chartW, height: chartH,
        viewBox: `0 0 ${chartW} ${chartH}`,
        className: 'gf-svg',
      },
        e('defs', null,
          // Red diagonal stripe pattern (for delayed overrun + overshoot)
          e('pattern', {
            id: 'gf-stripe', width: 6, height: 6,
            patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
          },
            e('rect', { width: 6, height: 6, fill: 'rgba(239,68,68,0.22)' }),
            e('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: C.delayed, strokeWidth: 2, opacity: 0.95 }),
          ),
          // "Past dispatch" full-height stripe (background of the cliff)
          e('pattern', {
            id: 'gf-stripe-bg', width: 8, height: 8,
            patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
          },
            e('rect', { width: 8, height: 8, fill: 'rgba(239,68,68,0.04)' }),
            e('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: '#ef4444', strokeWidth: 1, opacity: 0.15 }),
          ),
          // Soft glow for active bars
          e('filter', { id: 'gf-glow', x: '-10%', y: '-50%', width: '120%', height: '200%' },
            e('feGaussianBlur', { stdDeviation: '2', result: 'b' }),
            e('feMerge', null,
              e('feMergeNode', { in: 'b' }),
              e('feMergeNode', { in: 'SourceGraphic' }),
            ),
          ),
        ),

        // ─── "Past dispatch" zone background — subtle red wash that
        //     visually marks the cliff. If your bar drifts into here, you see it.
        e('rect', {
          x: dispatchX, y: TOP_PAD - 8,
          width: chartW - dispatchX - 0, height: chartH - TOP_PAD - BOTTOM_PAD + 16,
          fill: 'url(#gf-stripe-bg)',
        }),

        // ─── Date axis
        e(DateAxis, { tMin, tMax, totalDays, dayToX, chartH }),

        // ─── Dispatch marker (the goal — vivid green vertical line)
        e('g', { className: 'gf-dispatch' },
          e('line', {
            x1: dispatchX, y1: TOP_PAD - 6,
            x2: dispatchX, y2: chartH - BOTTOM_PAD + 4,
            stroke: C.dispatch, strokeWidth: 2,
          }),
          // Faint glow
          e('line', {
            x1: dispatchX, y1: TOP_PAD - 6,
            x2: dispatchX, y2: chartH - BOTTOM_PAD + 4,
            stroke: C.dispatch, strokeWidth: 8, opacity: 0.12,
          }),
          e('rect', { x: dispatchX - 42, y: TOP_PAD - 28, width: 84, height: 20, rx: 4, fill: C.dispatch }),
          e('text', { x: dispatchX, y: TOP_PAD - 14, fontSize: 11, fontWeight: 800, fill: '#062314', textAnchor: 'middle', letterSpacing: 0.5 }, 'DISPATCH'),
        ),

        // ─── Rows
        ...rows.map((r, i) => {
          if (r.kind === 'phase') {
            return e(PhaseHeader, { key: 'ph' + i, y: r.y, phase: window.GanttData.PHASE_META[r.phase], chartW });
          }
          return e(ProcessBar, {
            key: r.p.name, p: r.p, y: r.y, rowH: r.rowH, dayToX, dayW, D, dispatchX, chartW,
          });
        }),

        // ─── TODAY spine — drawn last so it overlays everything
        e('g', { className: 'gf-today-spine' },
          e('line', {
            x1: todayX, y1: TOP_PAD - 4,
            x2: todayX, y2: chartH - BOTTOM_PAD + 4,
            stroke: '#fff', strokeWidth: 10, opacity: 0.06,
          }),
          e('line', {
            x1: todayX, y1: TOP_PAD - 4,
            x2: todayX, y2: chartH - BOTTOM_PAD + 4,
            stroke: '#ffffff', strokeWidth: 2,
          }),
          e('rect', { x: todayX - 46, y: 8, width: 92, height: 20, rx: 4, fill: '#ffffff' }),
          e('text', { x: todayX, y: 22, fontSize: 11, fontWeight: 800, fill: '#0b0d12', textAnchor: 'middle', letterSpacing: 0.5 },
            'TODAY · ' + fmt(D.today, { short: true }).toUpperCase()),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------------
  function DateAxis({ tMin, tMax, totalDays, dayToX, chartH }) {
    let tickEvery;
    if (totalDays <= 21) tickEvery = 2;
    else if (totalDays <= 60) tickEvery = 5;
    else if (totalDays <= 120) tickEvery = 7;
    else tickEvery = 14;

    const ticks = [];
    const months = [];
    let lastMonth = null;
    for (let i = 0; i < totalDays; i++) {
      const ms = window.GanttData.addDays(tMin, i);
      const d = new Date(ms);
      const mo = d.getUTCMonth();
      if (mo !== lastMonth) {
        months.push({ x: dayToX(ms), label: window.GanttData.fmt(ms, { month: true }).toUpperCase() });
        lastMonth = mo;
      }
      if (i % tickEvery === 0) ticks.push({ x: dayToX(ms), label: d.getUTCDate() });
    }

    return e('g', { className: 'gf-axis' },
      ...months.map((m, i) => e('text', {
        key: 'mo' + i, x: m.x + 4, y: 50,
        fontSize: 10, fill: '#6b7280', fontWeight: 700, letterSpacing: 1.5,
      }, m.label)),
      ...ticks.map((t, i) => e('g', { key: 't' + i },
        e('text', { x: t.x, y: 36, fontSize: 11, fill: '#9ca3af', textAnchor: 'middle', fontWeight: 500 }, t.label),
        e('line', {
          x1: t.x, y1: TOP_PAD - 6, x2: t.x, y2: chartH - BOTTOM_PAD,
          stroke: '#2a2a2a', strokeWidth: 1,
        }),
      )),
    );
  }

  // ------------------------------------------------------------------------
  function PhaseHeader({ y, phase, chartW }) {
    return e('g', { className: 'gf-phase-header' },
      e('line', {
        x1: LEFT_PAD, y1: y + 0.5,
        x2: chartW - RIGHT_PAD, y2: y + 0.5,
        stroke: '#2a2a2a', strokeWidth: 1,
      }),
      e('text', {
        x: LEFT_PAD, y: y + 20,
        fontSize: 10, fontWeight: 700, letterSpacing: 2,
        fill: '#71717a',
      }, 'PHASE ' + phase.num),
    );
  }

  // ------------------------------------------------------------------------
  function ProcessBar({ p, y, rowH, dayToX, dayW, D, dispatchX, chartW }) {
    const status = p.status;
    const overshoots = p.overshoots;

    const xStart = dayToX(p.start);
    const xEnd = dayToX(p.end) + dayW * 0.5;
    const w = xEnd - xStart;

    const barH = status === 'completed' ? BAR_H_DONE : BAR_H;
    const barY = y + (rowH - barH) / 2;
    const rowMidY = y + rowH / 2 + 4;
    const labelText = p.name;
    const fitsInside = w >= labelText.length * 6.5 + 16;

    // Label position
    const todayX = dayToX(D.today);
    let labelX, labelAnchor;
    if (fitsInside) {
      labelX = xStart + 10;
      labelAnchor = 'start';
    } else {
      const placeRight = xStart < todayX - 30;
      labelX = placeRight ? xEnd + 8 : xStart - 8;
      labelAnchor = placeRight ? 'start' : 'end';
    }

    // ───────────── completed
    if (status === 'completed') {
      return e('g', { className: 'gf-row gf-row-completed' },
        e('rect', { x: xStart, y: barY, width: w, height: barH, rx: 2, fill: C.completed, opacity: 0.4 }),
        e('text', {
          x: labelX, y: rowMidY,
          fontSize: 12, fill: C.completedTx,
          textAnchor: labelAnchor,
          textDecoration: 'line-through', fontWeight: 500,
        }, labelText),
        e('text', { x: xStart - 6, y: rowMidY, fontSize: 11, fill: C.dispatch, opacity: 0.6, textAnchor: 'end' }, '✓'),
      );
    }

    // ───────────── upcoming
    if (status === 'upcoming') {
      // Split bar if it overshoots dispatch
      const onTimeW = overshoots ? Math.max(0, dispatchX - xStart) : w;
      const overshootW = overshoots ? Math.max(0, xEnd - dispatchX) : 0;
      return e('g', { className: 'gf-row gf-row-upcoming' },
        // Main planned portion (cool outline)
        onTimeW > 0 && e('rect', {
          x: xStart, y: barY, width: onTimeW, height: barH, rx: 4,
          fill: C.upcomingFill, stroke: C.upcoming, strokeWidth: 1.5,
        }),
        // Overshoot portion (red striped, urgent)
        overshootW > 0 && e('rect', {
          x: dispatchX, y: barY, width: overshootW, height: barH, rx: 4,
          fill: 'url(#gf-stripe)', stroke: C.delayed, strokeWidth: 1.5,
          className: 'gf-pulse',
        }),
        // Label
        e('text', {
          x: labelX, y: rowMidY,
          fontSize: 13, fontWeight: 600,
          fill: overshoots ? '#fecaca' : '#d4d4d8',
          textAnchor: labelAnchor,
        }, labelText),
        // "OVER DISPATCH" badge if overshoots
        overshoots && e('g', { className: 'gf-pulse' },
          e('rect', {
            x: xEnd + 6, y: barY + 2,
            width: 102, height: barH - 4, rx: 3,
            fill: C.delayed,
          }),
          e('text', {
            x: xEnd + 57, y: barY + barH / 2 + 4,
            fontSize: 10, fontWeight: 800, fill: '#fff', textAnchor: 'middle', letterSpacing: 0.3,
          }, p.overshootDays + ' DAY' + (p.overshootDays === 1 ? '' : 'S') + ' OVER'),
        ),
      );
    }

    // ───────────── active
    if (status === 'active') {
      const filledW = Math.max(0, Math.min(w, todayX - xStart));
      const remW = w - filledW;
      // Active that also overshoots: rare but handle it — paint the
      // post-dispatch slice in red stripe.
      const overshootStart = overshoots ? Math.max(todayX, dispatchX) : null;
      const remOnTimeW = overshoots ? Math.max(0, dispatchX - Math.max(todayX, xStart)) : remW;
      const remOverW = overshoots ? Math.max(0, xEnd - dispatchX) : 0;

      return e('g', { className: 'gf-row gf-row-active' },
        // Done portion (solid amber, glowing)
        e('rect', {
          x: xStart, y: barY, width: filledW, height: barH, rx: 4,
          fill: C.active,
          filter: 'url(#gf-glow)',
        }),
        // Remaining on-time (outlined amber)
        remOnTimeW > 0 && e('rect', {
          x: todayX, y: barY, width: remOnTimeW, height: barH, rx: 4,
          fill: 'rgba(245,158,11,0.10)',
          stroke: C.active, strokeWidth: 1.5,
        }),
        // Remaining past-dispatch (red striped)
        remOverW > 0 && e('rect', {
          x: dispatchX, y: barY, width: remOverW, height: barH, rx: 4,
          fill: 'url(#gf-stripe)',
          stroke: C.delayed, strokeWidth: 1.5,
          className: 'gf-pulse',
        }),
        // Label
        fitsInside ? e('text', {
          x: xStart + 10, y: rowMidY,
          fontSize: 13, fontWeight: 700, fill: '#ffffff', textAnchor: 'start',
        }, labelText)
        : e('text', {
          x: labelX, y: rowMidY,
          fontSize: 12.5, fontWeight: 700, fill: '#fef3c7', textAnchor: labelAnchor,
        }, labelText),
        // % badge
        w >= 80 && e('text', {
          x: xEnd - 6, y: rowMidY,
          fontSize: 10, fontWeight: 700, fill: '#fffbeb', opacity: 0.85, textAnchor: 'end',
        }, Math.round(p.progress * 100) + '%'),
      );
    }

    // ───────────── delayed
    const overrunStartX = dayToX(p.end) + dayW * 0.5;
    return e('g', { className: 'gf-row gf-row-delayed' },
      // Original planned bar — red outlined (the work isn't done)
      e('rect', {
        x: xStart, y: barY, width: w, height: barH, rx: 4,
        fill: 'rgba(239,68,68,0.18)',
        stroke: C.delayed, strokeWidth: 1.5,
      }),
      // Overrun extension (striped, pulsing)
      e('rect', {
        x: overrunStartX, y: barY, width: todayX - overrunStartX, height: barH, rx: 4,
        fill: 'url(#gf-stripe)',
        className: 'gf-pulse',
      }),
      // Label
      fitsInside ? e('text', {
        x: xStart + 10, y: rowMidY,
        fontSize: 12.5, fontWeight: 700, fill: '#fecaca', textAnchor: 'start',
      }, labelText)
      : e('text', {
        x: labelX, y: rowMidY,
        fontSize: 12.5, fontWeight: 700, fill: '#fecaca', textAnchor: labelAnchor,
      }, labelText),
      // Days-late badge
      e('g', { className: 'gf-pulse' },
        e('rect', {
          x: todayX + 6, y: barY + 2,
          width: 72, height: barH - 4, rx: 3,
          fill: C.delayed,
        }),
        e('text', {
          x: todayX + 42, y: barY + barH / 2 + 4,
          fontSize: 10, fontWeight: 800, fill: '#fff', textAnchor: 'middle', letterSpacing: 0.3,
        }, p.overdueDays + ' DAY' + (p.overdueDays === 1 ? '' : 'S') + ' LATE'),
      ),
    );
  }

  // ------------------------------------------------------------------------
  function StatChip({ num, label, tone, pulse }) {
    const toneStyles = {
      danger:   { color: '#fecaca', bg: 'rgba(239,68,68,0.16)', dot: '#ef4444' },
      active:   { color: '#fde68a', bg: 'rgba(245,158,11,0.14)', dot: '#f59e0b' },
      upcoming: { color: '#e4e4e7', bg: 'rgba(161,161,170,0.10)', dot: '#a1a1aa' },
      muted:    { color: '#9ca3af', bg: 'rgba(255,255,255,0.04)', dot: '#52525b' },
    };
    const s = toneStyles[tone];
    return e('div', { className: 'gf-chip' + (pulse ? ' gf-chip-pulse' : ''), style: { background: s.bg, color: s.color } },
      e('span', { className: 'gf-chip-dot', style: { background: s.dot } }),
      e('span', { className: 'gf-chip-num' }, num),
      e('span', { className: 'gf-chip-label' }, label),
    );
  }

  // ------------------------------------------------------------------------
  function StyleBlock() {
    return e('style', null, `
      .gantt-focus-root {
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: #171717;
        color: #e5e7eb;
        padding: 18px 20px 20px;
        box-sizing: border-box;
      }
      .gf-header {
        display: flex; justify-content: space-between; align-items: center;
        gap: 20px; flex-wrap: wrap; margin-bottom: 16px;
      }
      .gf-stat-row {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      }
      .gf-chip {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 10px; border-radius: 999px;
        font-size: 11.5px; font-weight: 600; white-space: nowrap;
      }
      .gf-chip-dot { width: 6px; height: 6px; border-radius: 50%; }
      .gf-chip-num { font-size: 14px; font-weight: 800; font-variant-numeric: tabular-nums; color: #fafafa; }
      .gf-chip-label { opacity: 0.85; }
      .gf-chip-pulse { /* blinking removed — static red is enough */ }
      .gf-countdown { display: inline-flex; align-items: baseline; gap: 8px; }
      .gf-countdown-num {
        font-size: 30px; font-weight: 800; letter-spacing: -0.03em;
        font-variant-numeric: tabular-nums; line-height: 1;
      }
      .gf-countdown-label { font-size: 12px; color: #9ca3af; }
      .gf-chart-wrap {
        background: #0e0e0e;
        border: 1px solid #262626;
        border-radius: 10px;
        overflow: hidden;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
      }
      .gf-svg { display: block; width: 100%; }
      .gf-pulse { /* blinking removed — static red is enough */ }
    `);
  }

  window.GanttFocus = GanttFocus;
})();
