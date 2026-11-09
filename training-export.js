// ── Training export ──
// Builds a dated export folder with three files:
//   imfl-2026-raw-data.json        raw localStorage state + normalized sessions/weeks/insights
//   imfl-2026-training-report.pdf  session log, weekly charts + tables, key insights
//   imfl-2026-training-data.xlsx   same data as sortable/filterable sheets
// Chromium browsers write a real folder via the File System Access API;
// everything else gets a .zip containing that folder.
// Relies on globals from the main script (PLAN, completions, customWorkouts, ...).

const EX_LIBS = {
  jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  autotable:
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
  xlsx: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
};
const EX_START = '2026-05-23';
const EX_RACE_DIST = { swim: 4224, bike: 112, run: 26.2 }; // yds, mi, mi
// Print palette (validated on white): swim, bike, run, other
const EX_COLOR = {
  swim: '#0284c7',
  bike: '#ca8a04',
  run: '#dc2626',
  other: '#8b8b8b',
  target: '#525252',
  ink: '#1a1a1a',
  muted: '#6b6b6b',
  grid: '#e7e7e7',
  brand: '#e8002d',
};
const EX_MOD_LABEL = {
  swim: 'Swim',
  bike: 'Bike',
  run: 'Run',
  cf: 'CrossFit',
  ar: 'Recovery',
  race: 'Race',
};

const _exLoaded = {};
function exLoadScript(url) {
  if (!_exLoaded[url])
    _exLoaded[url] = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = url;
      el.onload = resolve;
      el.onerror = () => {
        delete _exLoaded[url];
        reject(new Error('Could not load ' + url));
      };
      document.head.appendChild(el);
    });
  return _exLoaded[url];
}

// ── Formatting ──
function exHM(min) {
  return min > 0 ? fmtTime(Math.round(min)) : '0:00';
}
function exHrs(min) {
  return Math.round((min / 60) * 10) / 10;
}
function exNum(v, dec = 0) {
  return v == null || !isFinite(v)
    ? '-'
    : v.toLocaleString('en-US', {
        minimumFractionDigits: dec,
        maximumFractionDigits: dec,
      });
}
function exFmtDate(str, opts = { month: 'short', day: 'numeric' }) {
  return new Date(str + 'T12:00:00').toLocaleDateString('en-US', opts);
}
function exWeekOf(dateStr) {
  const diff = Math.round(
    (new Date(dateStr + 'T12:00:00') - new Date(EX_START + 'T12:00:00')) /
      864e5,
  );
  return Math.floor(diff / 7) + 1;
}
function exPhaseOf(wk) {
  if (wk >= 25) return 'Race';
  const ph = PHASE_CONFIG.find((p) => p.weeks.includes(wk));
  return ph ? ph.name : '';
}
function exWeekRange(wk) {
  const s = addDays(EX_START, (wk - 1) * 7);
  return `${exFmtDate(s)} - ${exFmtDate(addDays(s, 6))}`;
}
// jsPDF's built-in fonts are Latin-1 only
function exPdfText(s) {
  return String(s == null ? '' : s)
    .replace(/[–—]/g, '-')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/→/g, '->')
    .replace(/[^\x00-\xFF]/g, '')
    .trim();
}

function exYdsK(v) {
  return v === 0 ? '0' : exNum(v / 1000, v % 1000 ? 1 : 0) + 'k';
}

// ── Data collection ──
function exLegsOf(type, c) {
  const dur = c.duration || 0;
  if (type === 'swim') return [{ mod: 'swim', dist: c.distance || 0, min: dur }];
  if (type === 'swimrun') {
    const legs = [
      {
        mod: 'swim',
        dist: c.swimDist != null ? c.swimDist : c.distance || 0,
        min: c.swimDur != null ? c.swimDur : dur,
        leg: 'swim+run',
      },
    ];
    if (c.runDist || c.runDur)
      legs.push({ mod: 'run', dist: c.runDist || 0, min: c.runDur || 0, leg: 'swim+run' });
    return legs;
  }
  if (type === 'brick')
    return [
      {
        mod: 'bike',
        dist: c.bikeDist != null ? c.bikeDist : c.distance || 0,
        min: c.bikeDur || 0,
        leg: 'brick',
      },
      { mod: 'run', dist: c.runDist || 0, min: c.runDur || 0, leg: 'brick' },
    ];
  if (type === 'bike' || type === 'run' || type === 'race')
    return [{ mod: type, dist: c.distance || 0, min: dur }];
  return [{ mod: type === 'ar' ? 'ar' : 'cf', dist: 0, min: dur }];
}

function exCollect() {
  const sessions = [];
  PLAN.forEach((s, idx) => {
    if (deletedSessions.has(s.id)) return;
    const c = completions[s.id];
    if (!c) return;
    sessions.push({
      id: s.id,
      source: 'plan',
      order: idx,
      date: effectiveDate(s),
      type: s.type,
      title: s.title,
      plannedMinutes: s.targetDuration || null,
      plannedDistance: s.targetDistance || null,
      plannedUnit: s.unit || null,
      note: '',
      loggedAt: c.loggedAt || null,
      legs: exLegsOf(s.type, c),
    });
  });
  Object.values(customWorkouts).forEach((w) => {
    if (!w.done || !w.date) return;
    sessions.push({
      id: w.id,
      source: 'custom',
      order: 1e6,
      date: w.date,
      type: w.type,
      title: w.title || EX_MOD_LABEL[w.type] || w.type,
      plannedMinutes: null,
      plannedDistance: null,
      plannedUnit: null,
      note: w.note || '',
      loggedAt: w.loggedAt || null,
      legs: exLegsOf(w.type, w),
    });
  });
  sessions.sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.order - b.order,
  );

  // Flatten to one row per leg; a brick shares its overall # across both legs
  const modCount = {};
  const rows = [];
  sessions.forEach((s, i) => {
    s.n = i + 1;
    s.week = exWeekOf(s.date);
    s.phase = exPhaseOf(s.week);
    s.minutes = s.legs.reduce((t, l) => t + l.min, 0);
    s.legs.forEach((l) => {
      modCount[l.mod] = (modCount[l.mod] || 0) + 1;
      const miles = l.mod === 'swim' ? l.dist / 1760 : l.dist;
      const mph = l.dist > 0 && l.min > 0 ? miles / (l.min / 60) : null;
      let pace = null,
        paceUnit = '';
      if (l.dist > 0 && l.min > 0 && l.mod === 'swim') {
        pace = l.min / (l.dist / 100);
        paceUnit = '/100yd';
      } else if (l.dist > 0 && l.min > 0 && (l.mod === 'run' || l.mod === 'race')) {
        pace = l.min / l.dist;
        paceUnit = '/mi';
      }
      rows.push({
        n: s.n,
        modN: modCount[l.mod],
        date: s.date,
        day: exFmtDate(s.date, { weekday: 'short' }),
        week: s.week,
        phase: s.phase,
        modality: l.mod,
        modalityLabel: EX_MOD_LABEL[l.mod] + (l.leg ? ` (${l.leg})` : ''),
        title: s.title,
        distance: l.dist || null,
        unit: l.dist ? (l.mod === 'swim' ? 'yds' : 'mi') : '',
        minutes: l.min,
        mph,
        pace,
        paceUnit,
        note: s.note,
        source: s.source,
        sessionId: s.id,
      });
    });
  });
  return { sessions, rows };
}

function exWeekly(rows, sessions) {
  const maxWk = Math.min(25, Math.max(1, ...rows.map((r) => r.week)));
  const weeks = [];
  let cum = { swim: 0, bike: 0, run: 0 };
  for (let w = 1; w <= maxWk; w++) {
    const wr = rows.filter((r) => r.week === w);
    const sum = (mod, key) =>
      wr.filter((r) => r.modality === mod).reduce((t, r) => t + (r[key] || 0), 0);
    const wk = {
      week: w,
      dates: exWeekRange(w),
      phase: exPhaseOf(w),
      swimYds: sum('swim', 'distance'),
      bikeMi: sum('bike', 'distance'),
      runMi: sum('run', 'distance'),
      swimMin: sum('swim', 'minutes'),
      bikeMin: sum('bike', 'minutes'),
      runMin: sum('run', 'minutes'),
      otherMin: sum('cf', 'minutes') + sum('ar', 'minutes') + sum('race', 'minutes'),
    };
    wk.totalMin = wk.swimMin + wk.bikeMin + wk.runMin + wk.otherMin;
    // Speed from distance-and-time legs only, so time-only logs don't skew it
    const speed = (mod) => {
      const rr = wr.filter((r) => r.modality === mod && r.distance && r.minutes);
      const d = rr.reduce((t, r) => t + r.distance, 0);
      const m = rr.reduce((t, r) => t + r.minutes, 0);
      return d && m ? { d, m } : null;
    };
    const sw = speed('swim'),
      bk = speed('bike'),
      rn = speed('run');
    wk.swimPace = sw ? sw.m / (sw.d / 100) : null;
    wk.bikeMph = bk ? bk.d / (bk.m / 60) : null;
    wk.runPace = rn ? rn.m / rn.d : null;
    wk.longestSwim = Math.max(0, ...wr.filter((r) => r.modality === 'swim').map((r) => r.distance || 0));
    wk.longestRide = Math.max(0, ...wr.filter((r) => r.modality === 'bike').map((r) => r.distance || 0));
    wk.longestRun = Math.max(0, ...wr.filter((r) => r.modality === 'run').map((r) => r.distance || 0));

    const planned = activePlan().filter((s) => effectiveWeek(s) === w);
    wk.planned = planned.length;
    wk.plannedDone = planned.filter((s) => completions[s.id]).length;
    wk.extra = sessions.filter((s) => s.week === w && s.source === 'custom').length;
    wk.sessionsDone = wk.plannedDone + wk.extra;
    wk.completionPct = wk.planned ? (wk.plannedDone / wk.planned) * 100 : null;

    cum = { swim: cum.swim + wk.swimYds, bike: cum.bike + wk.bikeMi, run: cum.run + wk.runMi };
    wk.cumSwim = cum.swim;
    wk.cumBike = cum.bike;
    wk.cumRun = cum.run;
    const t = PACE_TARGETS[Math.min(w, 24)];
    wk.target = t ? { bench: t.bench, plan: t.plan } : null;
    weeks.push(wk);
  }
  weeks.forEach((wk, i) => {
    const prev = weeks[i - 1];
    wk.wowPct = prev && prev.totalMin > 0 ? ((wk.totalMin - prev.totalMin) / prev.totalMin) * 100 : null;
  });
  return weeks;
}

// ── Insights ──
function exInsights(rows, sessions, weeks) {
  const out = [];
  const bench = [];
  const byMod = (m) => rows.filter((r) => r.modality === m);
  const totalMin = rows.reduce((t, r) => t + r.minutes, 0);
  const swimYds = byMod('swim').reduce((t, r) => t + (r.distance || 0), 0);
  const bikeMi = byMod('bike').reduce((t, r) => t + (r.distance || 0), 0);
  const runMi = byMod('run').reduce((t, r) => t + (r.distance || 0), 0);
  const first = sessions[0]?.date,
    last = sessions[sessions.length - 1]?.date;

  out.push({
    title: 'Total training load',
    value: `${exNum(totalMin / 60, 1)} hrs`,
    detail: `${sessions.length} sessions from ${exFmtDate(first)} to ${exFmtDate(last)}. Swim ${exNum(swimYds)} yds (${exNum(swimYds / 1760, 1)} mi), bike ${exNum(bikeMi, 1)} mi, run ${exNum(runMi, 1)} mi - ${exNum(swimYds / 1760 + bikeMi + runMi, 1)} mi of swim/bike/run in total.`,
  });
  bench.push(['Total training hours', exNum(totalMin / 60, 1)]);
  bench.push(['Total sessions', String(sessions.length)]);

  // Adherence to the plan, counting only sessions already due
  const today = localDate(0);
  const due = activePlan().filter((s) => effectiveDate(s) <= today);
  const dueDone = due.filter((s) => completions[s.id]).length;
  if (due.length) {
    const pct = (dueDone / due.length) * 100;
    const skipped = {};
    due
      .filter((s) => !completions[s.id])
      .forEach((s) => (skipped[s.type] = (skipped[s.type] || 0) + 1));
    const topSkip = Object.entries(skipped).sort((a, b) => b[1] - a[1])[0];
    out.push({
      title: 'Plan adherence',
      value: `${exNum(pct)}%`,
      detail: `${dueDone} of ${due.length} planned sessions completed` +
        (deletedSessions.size ? ` (${deletedSessions.size} removed from the calendar)` : '') +
        (topSkip ? `. Most-missed type: ${EX_MOD_LABEL[topSkip[0]] || topSkip[0]} (${topSkip[1]}).` : '. Nothing missed.') +
        (() => {
          const n = sessions.filter((s) => s.source === 'custom').length;
          return n ? ` Plus ${n} extra session${n === 1 ? '' : 's'} you added yourself.` : '';
        })(),
    });
    bench.push(['Plan adherence', `${exNum(pct)}%`]);
  }

  const peak = weeks.reduce((a, b) => (b.totalMin > a.totalMin ? b : a), weeks[0]);
  if (peak && peak.totalMin) {
    out.push({
      title: 'Peak week',
      value: `Week ${peak.week} - ${exNum(peak.totalMin / 60, 1)} hrs`,
      detail: `${peak.dates} (${peak.phase}). Swim ${exHM(peak.swimMin)}, bike ${exHM(peak.bikeMin)}, run ${exHM(peak.runMin)}, other ${exHM(peak.otherMin)}. ${exNum(peak.bikeMi, 1)} mi ridden and ${exNum(peak.runMi, 1)} mi run that week.`,
    });
    bench.push(['Peak week hours', `${exNum(peak.totalMin / 60, 1)} (wk ${peak.week})`]);
  }

  // Longest session per discipline vs race distance
  [
    ['swim', 'Longest swim', 'yds'],
    ['bike', 'Longest ride', 'mi'],
    ['run', 'Longest run', 'mi'],
  ].forEach(([m, label, unit]) => {
    const r = byMod(m).reduce((a, b) => ((b.distance || 0) > (a?.distance || 0) ? b : a), null);
    if (!r || !r.distance) return;
    const pct = (r.distance / EX_RACE_DIST[m]) * 100;
    out.push({
      title: label,
      value: `${exNum(r.distance, m === 'swim' ? 0 : 1)} ${unit}`,
      detail: `${exFmtDate(r.date, { weekday: 'short', month: 'short', day: 'numeric' })} in ${exHM(r.minutes)} - ${exNum(pct)}% of race distance.`,
    });
    bench.push([label, `${exNum(r.distance, m === 'swim' ? 0 : 1)} ${unit} (${exHM(r.minutes)})`]);
  });

  // Speed trend: least-squares slope per week + early vs late comparison
  const trend = (m, toY, fmtY, betterLower, unitTxt) => {
    const rr = byMod(m).filter((r) => r.distance && r.minutes);
    if (rr.length < 4) return;
    const pts = rr.map((r) => [
      (new Date(r.date + 'T12:00:00') - new Date(EX_START + 'T12:00:00')) / 864e5 / 7,
      toY(r),
    ]);
    const reg = linReg(pts);
    const third = Math.max(1, Math.floor(rr.length / 3));
    const avg = (arr) => arr.reduce((t, p) => t + p[1], 0) / arr.length;
    const early = avg(pts.slice(0, third)),
      late = avg(pts.slice(-third));
    const delta = late - early;
    const improved = betterLower ? delta < 0 : delta > 0;
    out.push({
      title: `${EX_MOD_LABEL[m]} speed trend`,
      value: `${fmtY(early)} -> ${fmtY(late)}`,
      detail: `Average of your first ${third} vs last ${third} ${EX_MOD_LABEL[m].toLowerCase()} sessions: ${improved ? 'faster' : 'slower'} by ${fmtY(Math.abs(delta), true)}${unitTxt}. Trend line: ${reg ? (reg.slope >= 0 ? '+' : '-') + fmtY(Math.abs(reg.slope), true) + unitTxt + ' per week' : 'n/a'}. Longer, aerobic sessions late in a build often lower average speed - compare against distance.`,
    });
  };
  trend('swim', (r) => r.pace, (v) => fmtPaceMin(v) + '/100yd', true, '');
  trend('bike', (r) => r.mph, (v, d) => exNum(v, d ? 2 : 1) + ' mph', false, '');
  trend('run', (r) => r.pace, (v) => fmtPaceMin(v) + '/mi', true, '');

  // Best efforts over meaningful distances (>= 40% of the longest of each)
  const best = (m, label, cmp, fmt) => {
    const rr = byMod(m).filter((r) => r.distance && r.minutes);
    if (!rr.length) return;
    const longest = Math.max(...rr.map((r) => r.distance));
    const pool = rr.filter((r) => r.distance >= longest * 0.4);
    const r = pool.reduce((a, b) => (cmp(b, a) ? b : a));
    out.push({
      title: label,
      value: fmt(r),
      detail: `${exNum(r.distance, m === 'swim' ? 0 : 1)} ${r.unit} on ${exFmtDate(r.date)} in ${exHM(r.minutes)} (best among sessions >= ${exNum(longest * 0.4, m === 'swim' ? 0 : 1)} ${r.unit}).`,
    });
    bench.push([label, fmt(r)]);
  };
  best('swim', 'Fastest swim', (a, b) => a.pace < b.pace, (r) => fmtPaceMin(r.pace) + '/100yd');
  best('bike', 'Fastest ride', (a, b) => a.mph > b.mph, (r) => exNum(r.mph, 1) + ' mph');
  best('run', 'Fastest run', (a, b) => a.pace < b.pace, (r) => fmtPaceMin(r.pace) + '/mi');

  // Consistency: streaks and training days
  const days = [...new Set(sessions.map((s) => s.date))].sort();
  let streak = 1,
    bestStreak = days.length ? 1 : 0,
    bestEnd = days[0];
  for (let i = 1; i < days.length; i++) {
    streak = addDays(days[i - 1], 1) === days[i] ? streak + 1 : 1;
    if (streak > bestStreak) {
      bestStreak = streak;
      bestEnd = days[i];
    }
  }
  if (days.length) {
    const span =
      Math.round((new Date(last + 'T12:00:00') - new Date(first + 'T12:00:00')) / 864e5) + 1;
    const restDow = [0, 0, 0, 0, 0, 0, 0];
    for (let d = first; d <= last; d = addDays(d, 1))
      if (!days.includes(d)) restDow[new Date(d + 'T12:00:00').getDay()]++;
    const dows = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const restMax = Math.max(...restDow);
    out.push({
      title: 'Consistency',
      value: `${bestStreak}-day streak`,
      detail: `Longest run of consecutive training days ended ${exFmtDate(bestEnd)}. You trained on ${days.length} of ${span} days (${exNum((days.length / span) * 100)}%).` +
        (restMax ? ` Most common day off: ${dows[restDow.indexOf(restMax)]}.` : ''),
    });
    bench.push(['Longest training streak', `${bestStreak} days`]);
  }

  // Load progression (10% rule) and recovery weeks
  const ramps = weeks.filter((w) => w.wowPct != null && w.wowPct > 10 && w.totalMin > 60);
  const drops = weeks.filter((w) => w.wowPct != null && w.wowPct < -25);
  const jump = ramps.reduce((a, b) => (b.wowPct > (a?.wowPct || 0) ? b : a), null);
  out.push({
    title: 'Load progression',
    value: `${ramps.length} build weeks > +10%`,
    detail: (jump ? `Biggest jump: week ${jump.week} (+${exNum(jump.wowPct)}% hours vs prior week). ` : '') +
      (drops.length ? `Down weeks (>25% drop): ${drops.map((w) => 'wk ' + w.week).join(', ')} - your recovery/taper rhythm.` : 'No clear down weeks.'),
  });

  // Where the time went vs where race-day time goes
  const modMin = (m) => byMod(m).reduce((t, r) => t + r.minutes, 0);
  const tri = modMin('swim') + modMin('bike') + modMin('run');
  if (tri) {
    const pj = ['swim', 'bike', 'run'].map((k) => parseTimeToMins((projections[k] || PROJ_DEFAULTS[k]).time));
    const pjT = pj.reduce((a, b) => a + b, 0) || 1;
    const pc = (v, t) => exNum((v / t) * 100) + '%';
    out.push({
      title: 'Time split vs race split',
      value: `${pc(modMin('swim'), tri)} / ${pc(modMin('bike'), tri)} / ${pc(modMin('run'), tri)}`,
      detail: `Swim / bike / run share of training time. Your race projection splits ${pc(pj[0], pjT)} / ${pc(pj[1], pjT)} / ${pc(pj[2], pjT)}. CrossFit + recovery added ${exNum((modMin('cf') + modMin('ar')) / 60, 1)} hrs on top.`,
    });
  }

  // Hours per phase
  const phases = {};
  weeks.forEach((w) => {
    if (w.week > 24) return; // race week isn't a training phase
    if (!phases[w.phase]) phases[w.phase] = { min: 0, n: 0 };
    phases[w.phase].min += w.totalMin;
    phases[w.phase].n++;
  });
  out.push({
    title: 'Hours by phase',
    value: (() => {
      const [p, v] = Object.entries(phases).reduce((a, b) => (b[1].min / b[1].n > a[1].min / a[1].n ? b : a));
      return `${p}: ${exNum(v.min / 60 / v.n, 1)} h/wk`;
    })(),
    detail: Object.entries(phases)
      .map(([p, v]) => `${p}: ${exNum(v.min / 60, 1)} h (${exNum(v.min / 60 / v.n, 1)}/wk)`)
      .join(' | '),
  });

  // Cumulative volume vs plan targets at the last training week
  const lastTgt = [...weeks].reverse().find((w) => w.target && w.week <= 24);
  if (lastTgt) {
    const t = lastTgt.target.plan;
    out.push({
      title: `Volume vs plan (thru wk ${lastTgt.week})`,
      value: `${exNum((lastTgt.cumSwim / t.swim) * 100)}% / ${exNum((lastTgt.cumBike / t.bike) * 100)}% / ${exNum((lastTgt.cumRun / t.run) * 100)}%`,
      detail: `Swim / bike / run cumulative volume vs plan target - swim ${exNum((lastTgt.cumSwim / t.swim) * 100)}%, bike ${exNum((lastTgt.cumBike / t.bike) * 100)}%, run ${exNum((lastTgt.cumRun / t.run) * 100)}%. Vs benchmark target - swim ${exNum((lastTgt.cumSwim / lastTgt.target.bench.swim) * 100)}%, bike ${exNum((lastTgt.cumBike / lastTgt.target.bench.bike) * 100)}%, run ${exNum((lastTgt.cumRun / lastTgt.target.bench.run) * 100)}%.`,
    });
  }

  // Race result, if logged
  const race = rows.find((r) => r.modality === 'race');
  if (race && race.minutes) {
    const proj = parseTimeToMins((projections.total || PROJ_DEFAULTS.total).time);
    const diff = race.minutes - proj;
    out.push({
      title: 'Race day',
      value: exHM(race.minutes),
      detail: `Logged finish vs your ${exHM(proj)} projection: ${diff <= 0 ? exHM(-diff) + ' faster' : exHM(diff) + ' slower'}. The number to beat next time.`,
    });
    bench.unshift(['Race finish time', exHM(race.minutes)]);
  }
  return { insights: out, benchmarks: bench };
}

// ── Chart rendering (offscreen canvas -> JPEG for the PDF) ──
function exChart(o) {
  const S = 3,
    W = o.w,
    H = o.h;
  const cv = document.createElement('canvas');
  cv.width = W * S;
  cv.height = H * S;
  const ctx = cv.getContext('2d');
  ctx.scale(S, S);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  const font = (sz, wt = 400) => `${wt} ${sz}px "DM Sans", Helvetica, Arial, sans-serif`;

  ctx.fillStyle = EX_COLOR.ink;
  ctx.font = font(13, 600);
  ctx.textBaseline = 'top';
  ctx.fillText(o.title, 0, 2);
  if (o.subtitle) {
    ctx.fillStyle = EX_COLOR.muted;
    ctx.font = font(10);
    ctx.fillText(o.subtitle, 0, 19);
  }
  // Legend for 2+ series, right-aligned
  if (o.series.length > 1) {
    ctx.font = font(10);
    let x = W;
    [...o.series].reverse().forEach((s) => {
      const tw = ctx.measureText(s.name).width;
      x -= tw;
      ctx.fillStyle = EX_COLOR.muted;
      ctx.fillText(s.name, x, 4);
      x -= 14;
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      if (o.kind === 'line') {
        ctx.lineWidth = 2;
        ctx.setLineDash(s.dash || []);
        ctx.beginPath();
        ctx.moveTo(x, 10);
        ctx.lineTo(x + 11, 10);
        ctx.stroke();
        ctx.setLineDash([]);
      } else ctx.fillRect(x + 1, 5, 9, 9);
      x -= 12;
    });
  }

  const top = o.subtitle ? 40 : 30,
    bottom = H - 22,
    left = 44,
    right = W - 6;
  const n = o.labels.length;
  let vals = [];
  if (o.kind === 'stack')
    vals = o.labels.map((_, i) => o.series.reduce((t, s) => t + (s.data[i] || 0), 0));
  else o.series.forEach((s) => s.data.forEach((v) => v != null && vals.push(v)));
  if (o.refLine != null) vals.push(o.refLine);
  let yMin = o.yMin != null ? o.yMin : 0;
  let yMax = Math.max(...vals, 0);
  if (o.yMin == null && o.kind === 'line' && o.fitMin && vals.length) {
    const lo = Math.min(...vals);
    yMin = Math.max(0, lo - (yMax - lo) * 0.15);
  }
  if (yMax <= yMin) yMax = yMin + 1;
  // Round axis ends to a 1/2/2.5/5 step so ticks land on readable values
  const raw = (yMax - yMin) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw);
  yMin = Math.floor(yMin / step) * step;
  yMax = Math.ceil((yMax + step * 0.05) / step) * step;
  const ticks = Math.round((yMax - yMin) / step);
  const Y = (v) => bottom - ((v - yMin) / (yMax - yMin)) * (bottom - top);
  const band = (right - left) / Math.max(n, 1);
  const X = (i) => left + band * (i + 0.5);

  ctx.font = font(9);
  ctx.textBaseline = 'middle';
  for (let t = 0; t <= ticks; t++) {
    const v = yMin + step * t;
    const y = Y(v);
    ctx.strokeStyle = t === 0 ? '#bdbdbd' : EX_COLOR.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, Math.round(y) + 0.5);
    ctx.lineTo(right, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.fillStyle = EX_COLOR.muted;
    ctx.textAlign = 'right';
    ctx.fillText((o.yFmt || exNum)(v), left - 6, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const every = Math.ceil(n / 13);
  o.labels.forEach((l, i) => {
    if (i % every === 0 || i === n - 1) ctx.fillText(l, X(i), bottom + 6);
  });
  if (o.refLine != null) {
    ctx.strokeStyle = EX_COLOR.target;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(left, Y(o.refLine));
    ctx.lineTo(right, Y(o.refLine));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = EX_COLOR.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(o.refLabel || '', left + 4, Y(o.refLine) - 2);
  }

  const roundTop = (x, y, w, h, r) => {
    r = Math.min(r, w / 2, h);
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
  };
  if (o.kind === 'stack') {
    const bw = Math.min(band * 0.68, 26);
    o.labels.forEach((_, i) => {
      let acc = 0;
      const segs = o.series.map((s) => s.data[i] || 0);
      const topIdx = segs.map((v, k) => (v > 0 ? k : -1)).filter((k) => k >= 0).pop();
      segs.forEach((v, k) => {
        if (v <= 0) return;
        const y0 = Y(yMin + acc),
          y1 = Y(yMin + acc + v);
        ctx.fillStyle = o.series[k].color;
        const h = Math.max(0, y0 - y1 - (acc > 0 ? 2 : 0)); // 2px surface gap between segments
        if (k === topIdx) roundTop(X(i) - bw / 2, y1, bw, h, 3);
        else ctx.fillRect(X(i) - bw / 2, y1, bw, h);
        acc += v;
      });
    });
  } else if (o.kind === 'bar') {
    const k = o.series.length;
    const bw = Math.min((band * 0.72) / k, 22);
    o.series.forEach((s, si) => {
      ctx.fillStyle = s.color;
      s.data.forEach((v, i) => {
        if (!v) return;
        const x = X(i) - (bw * k) / 2 + si * bw + 1;
        roundTop(x, Y(v), bw - 2, Y(yMin) - Y(v), 3);
      });
    });
  } else {
    o.series.forEach((s, si) => {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.setLineDash(s.dash || []);
      ctx.beginPath();
      let pen = false;
      s.data.forEach((v, i) => {
        if (v == null) return (pen = false);
        pen ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v));
        pen = true;
      });
      ctx.stroke();
      ctx.setLineDash([]);
      if (!s.dash)
        s.data.forEach((v, i) => {
          if (v == null) return;
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(X(i), Y(v), 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = s.color;
          ctx.beginPath();
          ctx.arc(X(i), Y(v), 2.6, 0, Math.PI * 2);
          ctx.fill();
        });
      // Direct label on the final point of the primary series
      if (si === 0) {
        const li = s.data.map((v, i) => (v != null ? i : -1)).filter((i) => i >= 0).pop();
        if (li != null) {
          ctx.fillStyle = EX_COLOR.ink;
          ctx.font = font(9, 600);
          ctx.textAlign = li > n * 0.8 ? 'right' : 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText((o.labelFmt || o.yFmt || exNum)(s.data[li]), X(li) + (li > n * 0.8 ? -6 : 6), Y(s.data[li]) - 5);
        }
      }
    });
  }
  return { url: cv.toDataURL('image/jpeg', 0.92), w: W, h: H };
}

// Calendar heatmap: columns = training weeks, rows = Sat..Fri
function exHeatmap(sessions, weeks) {
  const S = 3,
    W = 720,
    H = 214;
  const cv = document.createElement('canvas');
  cv.width = W * S;
  cv.height = H * S;
  const ctx = cv.getContext('2d');
  ctx.scale(S, S);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  const font = (sz, wt = 400) => `${wt} ${sz}px "DM Sans", Helvetica, Arial, sans-serif`;
  const perDay = {};
  sessions.forEach((s) => (perDay[s.date] = (perDay[s.date] || 0) + s.minutes));
  // Single-hue sequential ramp (brand red), light -> dark, fixed minute buckets
  const ramp = ['#fde4e7', '#f9aab5', '#f0637a', '#d01f40', '#8c0019'];
  const edges = [0, 45, 90, 150, 240];
  const keyLbl = ['< 45', '45-90', '90-150', '150-240', '240+'];
  const colorFor = (m) => ramp[edges.filter((e) => m >= e).length - 1];
  ctx.fillStyle = EX_COLOR.ink;
  ctx.font = font(13, 600);
  ctx.textBaseline = 'top';
  ctx.fillText('Training calendar - minutes per day', 0, 2);
  const left = 34,
    top = 28,
    cols = weeks.length;
  const cell = Math.min(22, (W - left - 10) / cols);
  const dows = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  ctx.font = font(9);
  ctx.textBaseline = 'middle';
  dows.forEach((d, r) => {
    ctx.fillStyle = EX_COLOR.muted;
    ctx.textAlign = 'right';
    ctx.fillText(d, left - 6, top + r * cell + cell / 2);
  });
  weeks.forEach((w, c) => {
    for (let r = 0; r < 7; r++) {
      const date = addDays(EX_START, (w.week - 1) * 7 + r);
      const m = perDay[date] || 0;
      ctx.fillStyle = m ? colorFor(m) : '#f2f2f2';
      ctx.beginPath();
      ctx.roundRect(left + c * cell + 1, top + r * cell + 1, cell - 2, cell - 2, 3);
      ctx.fill();
    }
    ctx.fillStyle = EX_COLOR.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    if (c % 2 === 0 || c === weeks.length - 1)
      ctx.fillText('W' + w.week, left + c * cell + cell / 2, top + 7 * cell + 4);
  });
  // Scale key
  const kx = left + cols * cell + 24;
  if (kx + 80 < W) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = EX_COLOR.muted;
    ctx.fillText('min/day', kx, top + 6);
    ramp.forEach((col, i) => {
      ctx.fillStyle = col;
      ctx.fillRect(kx, top + 18 + i * 16, 12, 12);
      ctx.fillStyle = EX_COLOR.muted;
      ctx.fillText(keyLbl[i], kx + 18, top + 24 + i * 16);
    });
  }
  return { url: cv.toDataURL('image/jpeg', 0.92), w: W, h: H };
}

// ── PDF ──
function exBuildPdf(data) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const PW = doc.internal.pageSize.getWidth(),
    PH = doc.internal.pageSize.getHeight(),
    M = 36;
  const { rows, sessions, weeks, insights, benchmarks } = data;
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const T = (s, x, y, opt) => doc.text(exPdfText(s), x, y, opt);
  const tableBase = {
    theme: 'striped',
    margin: { left: M, right: M, top: 48, bottom: 36 },
    styles: { fontSize: 8, cellPadding: 3, textColor: rgb(EX_COLOR.ink), lineColor: [230, 230, 230] },
    headStyles: { fillColor: [20, 20, 20], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [246, 246, 246] },
  };
  const table = (head, body, extra = {}) => {
    doc.autoTable({
      ...tableBase,
      head: [head.map(exPdfText)],
      body: body.map((r) => r.map((c) => exPdfText(c))),
      ...extra,
      didParseCell: (h) => {
        if (h.section !== 'head') return;
        const a = (extra.columnStyles?.[h.column.index] || {}).halign || extra.styles?.halign;
        if (a) h.cell.styles.halign = a;
      },
    });
    return doc.lastAutoTable.finalY;
  };
  const section = (num, title, sub) => {
    doc.addPage();
    doc.setFillColor(...rgb(EX_COLOR.brand));
    doc.rect(M, M, 4, 26, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.setTextColor(...rgb(EX_COLOR.ink));
    T(`${num}  ${title}`, M + 12, M + 13);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...rgb(EX_COLOR.muted));
    T(sub, M + 12, M + 27);
    return M + 44;
  };
  const sub = (title, y) => {
    if (y > PH - 120) {
      doc.addPage();
      y = 56;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...rgb(EX_COLOR.ink));
    T(title, M, y);
    return y + 10;
  };
  const img = (c, x, y, w) => {
    const h = (c.h / c.w) * w;
    doc.addImage(c.url, 'JPEG', x, y, w, h);
    return y + h;
  };
  const labels = weeks.map((w) => 'W' + w.week);
  const totalMin = rows.reduce((t, r) => t + r.minutes, 0);

  // Cover
  doc.setFillColor(8, 8, 8);
  doc.rect(0, 0, PW, 210, 'F');
  doc.setFillColor(...rgb(EX_COLOR.brand));
  doc.rect(0, 210, PW, 5, 'F');
  doc.setTextColor(255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(34);
  T('IRONMAN FLORIDA 2026', M, 92);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'normal');
  T('Training Export  |  Panama City Beach  |  Nov 7, 2026', M, 122);
  doc.setFontSize(10);
  doc.setTextColor(170);
  T(
    `${sessions.length ? exFmtDate(sessions[0].date, { month: 'long', day: 'numeric', year: 'numeric' }) + ' - ' + exFmtDate(sessions[sessions.length - 1].date, { month: 'long', day: 'numeric', year: 'numeric' }) : ''}   |   Exported ${new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })}`,
    M,
    150,
  );
  const tiles = [
    ['Training hours', exNum(totalMin / 60, 1)],
    ['Sessions', String(sessions.length)],
    ['Swim', exNum(rows.filter((r) => r.modality === 'swim').reduce((t, r) => t + (r.distance || 0), 0)) + ' yds'],
    ['Bike', exNum(rows.filter((r) => r.modality === 'bike').reduce((t, r) => t + (r.distance || 0), 0), 1) + ' mi'],
    ['Run', exNum(rows.filter((r) => r.modality === 'run').reduce((t, r) => t + (r.distance || 0), 0), 1) + ' mi'],
  ];
  const tw = (PW - 2 * M - 4 * 12) / 5;
  tiles.forEach(([l, v], i) => {
    const x = M + i * (tw + 12);
    doc.setDrawColor(225);
    doc.setFillColor(250, 250, 250);
    doc.roundedRect(x, 245, tw, 70, 4, 4, 'FD');
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...rgb(EX_COLOR.muted));
    T(l.toUpperCase(), x + 12, 266);
    doc.setFontSize(22);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...rgb(EX_COLOR.ink));
    T(v, x + 12, 298);
  });
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  T('Contents', M, 360);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  [
    '1   Session log - every logged session with overall and per-discipline numbering',
    '2   Weekly trends - hours, distance, cumulative volume vs targets, speed, sessions (chart + table each)',
    '3   Key insights & trends - load, adherence, bests, consistency, benchmarks to beat next time',
  ].forEach((l, i) => T(l, M, 382 + i * 18));
  doc.setFontSize(9);
  doc.setTextColor(...rgb(EX_COLOR.muted));
  T('Swim distances in yards; swim pace per 100 yd. Brick and swim+run sessions show one row per leg sharing the overall session #.', M, PH - M);

  // Section 1 — session log
  section('1', 'Session Log', `${sessions.length} sessions, ${rows.length} rows (multi-sport sessions are split by leg)`);
  table(
    ['#', 'Mod #', 'Date', 'Wk', 'Discipline', 'Session', 'Distance', 'Time', 'Avg Speed', 'Pace'],
    rows.map((r) => [
      r.n,
      r.modN,
      exFmtDate(r.date, { weekday: 'short', month: 'short', day: 'numeric' }),
      r.week,
      r.modalityLabel,
      r.title + (r.note ? ` - ${r.note}` : ''),
      r.distance ? `${exNum(r.distance, r.unit === 'yds' ? 0 : 2)} ${r.unit}` : '-',
      exHM(r.minutes),
      r.mph ? exNum(r.mph, 1) + ' mph' : '-',
      r.pace ? fmtPaceMin(r.pace) + r.paceUnit : '-',
    ]),
    {
      startY: M + 50,
      columnStyles: {
        0: { halign: 'right', cellWidth: 28 },
        1: { halign: 'right', cellWidth: 38 },
        3: { halign: 'right', cellWidth: 26 },
        4: { cellWidth: 92, cellPadding: { top: 3, bottom: 3, left: 8, right: 3 } },
        6: { halign: 'right' },
        7: { halign: 'right' },
        8: { halign: 'right' },
        9: { halign: 'right' },
      },
      // Discipline color as a marker, not as text color
      didDrawCell: (h) => {
        if (h.section !== 'body' || h.column.index !== 4) return;
        const mod = rows[h.row.index].modality;
        const col = EX_COLOR[mod] || EX_COLOR.other;
        doc.setFillColor(...rgb(col));
        doc.rect(h.cell.x, h.cell.y + 2, 2.5, h.cell.height - 4, 'F');
      },
    },
  );

  // Section 2 — weekly trends: each chart page is followed by its table page
  const FW = PW - 2 * M;
  const tablePage = (title, head, body, extra) => {
    doc.addPage();
    table(head, body, { startY: sub(title + ' - table', 56) + 2, ...extra });
  };
  // Three disciplines stacked on a shared week axis so they line up for comparison
  const stackOf3 = (y, specs) =>
    specs.forEach((o, i) => img(exChart({ w: 720, h: 158, labels, ...o }), M, y + i * 166, FW));
  const right = (...cols) => Object.fromEntries(cols.map((c) => [c, { halign: 'right' }]));

  let y = section('2', 'Weekly Trends', 'Each chart page is followed by the table it was drawn from');
  y = sub('Weekly training hours by discipline', y);
  img(
    exChart({
      w: 720,
      h: 400,
      kind: 'stack',
      title: 'Hours per week',
      labels,
      yFmt: (v) => exNum(v, 0) + 'h',
      series: [
        { name: 'Swim', color: EX_COLOR.swim, data: weeks.map((w) => w.swimMin / 60) },
        { name: 'Bike', color: EX_COLOR.bike, data: weeks.map((w) => w.bikeMin / 60) },
        { name: 'Run', color: EX_COLOR.run, data: weeks.map((w) => w.runMin / 60) },
        { name: 'CrossFit / recovery / race', color: EX_COLOR.other, data: weeks.map((w) => w.otherMin / 60) },
      ],
    }),
    M,
    y,
    FW,
  );
  tablePage(
    'Weekly training hours',
    ['Week', 'Dates', 'Phase', 'Swim', 'Bike', 'Run', 'Other', 'Total', 'vs prior wk'],
    weeks.map((w) => [
      w.week, w.dates, w.phase, exHM(w.swimMin), exHM(w.bikeMin), exHM(w.runMin), exHM(w.otherMin), exHM(w.totalMin),
      w.wowPct == null ? '-' : (w.wowPct >= 0 ? '+' : '') + exNum(w.wowPct) + '%',
    ]),
    { columnStyles: { ...right(3, 4, 5, 6, 8), 7: { halign: 'right', fontStyle: 'bold' } } },
  );

  doc.addPage();
  stackOf3(sub('Weekly distance', 56), [
    { kind: 'bar', title: 'Swim (yds)', yFmt: exYdsK, series: [{ name: 'Swim', color: EX_COLOR.swim, data: weeks.map((w) => w.swimYds) }] },
    { kind: 'bar', title: 'Bike (mi)', series: [{ name: 'Bike', color: EX_COLOR.bike, data: weeks.map((w) => w.bikeMi) }] },
    { kind: 'bar', title: 'Run (mi)', series: [{ name: 'Run', color: EX_COLOR.run, data: weeks.map((w) => w.runMi) }] },
  ]);
  tablePage(
    'Weekly distance',
    ['Week', 'Phase', 'Swim yds', 'Bike mi', 'Run mi', 'Total mi', 'Longest swim', 'Longest ride', 'Longest run'],
    weeks.map((w) => [
      w.week, w.phase, exNum(w.swimYds), exNum(w.bikeMi, 1), exNum(w.runMi, 1), exNum(w.swimYds / 1760 + w.bikeMi + w.runMi, 1),
      w.longestSwim ? exNum(w.longestSwim) : '-', w.longestRide ? exNum(w.longestRide, 1) : '-', w.longestRun ? exNum(w.longestRun, 1) : '-',
    ]),
    { columnStyles: { ...right(2, 3, 4, 6, 7, 8), 5: { halign: 'right', fontStyle: 'bold' } } },
  );

  doc.addPage();
  const tgt = (m, kind) => weeks.map((w) => (w.target ? w.target[kind][m] : null));
  stackOf3(
    sub('Cumulative distance vs targets', 56),
    [
      ['Swim (yds)', EX_COLOR.swim, 'cumSwim', 'swim', exYdsK],
      ['Bike (mi)', EX_COLOR.bike, 'cumBike', 'bike', undefined],
      ['Run (mi)', EX_COLOR.run, 'cumRun', 'run', undefined],
    ].map(([t, col, k, m, f]) => ({
      kind: 'line', title: t, yFmt: f,
      series: [
        { name: 'Actual', color: col, data: weeks.map((w) => w[k]) },
        { name: 'Plan target', color: EX_COLOR.target, dash: [5, 3], data: tgt(m, 'plan') },
        { name: 'Bench target', color: '#a3a3a3', dash: [2, 3], data: tgt(m, 'bench') },
      ],
    })),
  );
  const pct = (a, b) => (b ? exNum((a / b) * 100) + '%' : '-');
  tablePage(
    'Cumulative distance vs targets',
    ['Week', 'Swim yds', 'Plan', 'Bench', '% plan', 'Bike mi', 'Plan', 'Bench', '% plan', 'Run mi', 'Plan', 'Bench', '% plan'],
    weeks.map((w) => {
      const t = w.target;
      return [
        w.week,
        exNum(w.cumSwim), t ? exNum(t.plan.swim) : '-', t ? exNum(t.bench.swim) : '-', t ? pct(w.cumSwim, t.plan.swim) : '-',
        exNum(w.cumBike, 1), t ? exNum(t.plan.bike, 1) : '-', t ? exNum(t.bench.bike, 1) : '-', t ? pct(w.cumBike, t.plan.bike) : '-',
        exNum(w.cumRun, 1), t ? exNum(t.plan.run, 1) : '-', t ? exNum(t.bench.run, 1) : '-', t ? pct(w.cumRun, t.plan.run) : '-',
      ];
    }),
    { styles: { ...tableBase.styles, halign: 'right' }, columnStyles: { 1: { fontStyle: 'bold' }, 5: { fontStyle: 'bold' }, 9: { fontStyle: 'bold' } } },
  );

  doc.addPage();
  stackOf3(sub('Average speed per week', 56), [
    { kind: 'line', fitMin: true, title: 'Swim pace (min/100yd, lower = faster)', yFmt: fmtPaceMin, series: [{ name: 'Swim', color: EX_COLOR.swim, data: weeks.map((w) => w.swimPace) }] },
    { kind: 'line', fitMin: true, title: 'Bike speed (mph)', yFmt: (v) => exNum(v, 1), series: [{ name: 'Bike', color: EX_COLOR.bike, data: weeks.map((w) => w.bikeMph) }] },
    { kind: 'line', fitMin: true, title: 'Run pace (min/mi, lower = faster)', yFmt: fmtPaceMin, series: [{ name: 'Run', color: EX_COLOR.run, data: weeks.map((w) => w.runPace) }] },
  ]);
  tablePage(
    'Average speed per week',
    ['Week', 'Phase', 'Swim /100yd', 'Bike mph', 'Run /mi', 'Run mph'],
    weeks.map((w) => [
      w.week, w.phase,
      w.swimPace ? fmtPaceMin(w.swimPace) : '-',
      w.bikeMph ? exNum(w.bikeMph, 1) : '-',
      w.runPace ? fmtPaceMin(w.runPace) : '-',
      w.runPace ? exNum(60 / w.runPace, 1) : '-',
    ]),
    { columnStyles: right(2, 3, 4, 5) },
  );

  doc.addPage();
  img(
    exChart({
      w: 720, h: 400, kind: 'bar', title: 'Sessions per week', labels,
      series: [
        { name: 'Planned', color: '#c4c4c4', data: weeks.map((w) => w.planned) },
        { name: 'Completed', color: EX_COLOR.swim, data: weeks.map((w) => w.sessionsDone) },
      ],
    }),
    M, sub('Sessions completed vs planned', 56), FW,
  );
  tablePage(
    'Sessions completed vs planned',
    ['Week', 'Dates', 'Planned', 'Planned done', 'Extra (added)', 'Total done', 'Completion'],
    weeks.map((w) => [w.week, w.dates, w.planned, w.plannedDone, w.extra, w.sessionsDone, w.completionPct == null ? '-' : exNum(w.completionPct) + '%']),
    { columnStyles: { ...right(2, 3, 4, 5), 6: { halign: 'right', fontStyle: 'bold' } } },
  );

  // Section 3 — insights
  y = section('3', 'Key Insights & Trends', 'Computed from your logged sessions - the benchmarks to compare your next build against');
  const cw = (PW - 2 * M - 24) / 3;
  let col = 0,
    rowTop = y,
    rowH = 0;
  insights.forEach((ins) => {
    doc.setFontSize(8.5);
    const lines = doc.splitTextToSize(exPdfText(ins.detail), cw - 20);
    const h = 52 + lines.length * 10.5;
    if (rowTop + h > PH - M) {
      doc.addPage();
      rowTop = 56;
      col = 0;
      rowH = 0;
    }
    const x = M + col * (cw + 12);
    doc.setDrawColor(228);
    doc.setFillColor(250, 250, 250);
    doc.roundedRect(x, rowTop, cw, h, 4, 4, 'FD');
    doc.setFillColor(...rgb(EX_COLOR.brand));
    doc.rect(x, rowTop + 8, 2.5, 14, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...rgb(EX_COLOR.muted));
    T(ins.title.toUpperCase(), x + 10, rowTop + 18);
    doc.setFontSize(15);
    doc.setTextColor(...rgb(EX_COLOR.ink));
    T(ins.value, x + 10, rowTop + 38);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(70);
    doc.text(lines, x + 10, rowTop + 54);
    rowH = Math.max(rowH, h);
    col++;
    if (col === 3) {
      col = 0;
      rowTop += rowH + 12;
      rowH = 0;
    }
  });

  // Keep flowing on the current page while the next block fits
  const fit = (h, y0) => {
    if (y0 + h <= PH - M) return y0;
    doc.addPage();
    return 56;
  };
  y = fit(250, rowTop + (col ? rowH + 12 : 0) + 14);
  y = sub('Longest session each week, as % of race distance', y);
  y = img(
    exChart({
      w: 720, h: 220, kind: 'line', title: 'Longest session vs race distance',
      subtitle: 'Swim 2.4 mi (4,224 yds) | Bike 112 mi | Run 26.2 mi', labels,
      yFmt: (v) => exNum(v) + '%', refLine: 100, refLabel: 'Race distance',
      series: [
        { name: 'Swim', color: EX_COLOR.swim, data: weeks.map((w) => (w.longestSwim ? (w.longestSwim / EX_RACE_DIST.swim) * 100 : null)) },
        { name: 'Bike', color: EX_COLOR.bike, data: weeks.map((w) => (w.longestRide ? (w.longestRide / EX_RACE_DIST.bike) * 100 : null)) },
        { name: 'Run', color: EX_COLOR.run, data: weeks.map((w) => (w.longestRun ? (w.longestRun / EX_RACE_DIST.run) * 100 : null)) },
      ],
    }),
    M, y, PW - 2 * M,
  );
  y = img(exHeatmap(sessions, weeks), M, fit(215, y + 14), PW - 2 * M);
  y = sub('Benchmarks to beat next time', y + 18);
  table(['Benchmark', 'This build'], benchmarks, {
    startY: y,
    tableWidth: 360,
    columnStyles: { 1: { halign: 'right', fontStyle: 'bold' } },
  });

  // Running header/footer on every page except the cover
  const pages = doc.getNumberOfPages();
  for (let p = 2; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...rgb(EX_COLOR.muted));
    T('IRONMAN Florida 2026 | Training Export', M, PH - 18);
    T(`${p} / ${pages}`, PW - M, PH - 18, { align: 'right' });
  }
  return doc.output('blob');
}

// ── Excel ──
function exBuildXlsx(data) {
  const { rows, weeks, insights, benchmarks } = data;
  const wb = XLSX.utils.book_new();
  const r1 = (v, d = 1) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
  const add = (name, aoa, widths) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = widths.map((w) => ({ wch: w }));
    if (aoa.length > 1)
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) };
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  add(
    'Sessions',
    [
      ['Session #', 'Discipline #', 'Date', 'Day', 'Week', 'Phase', 'Discipline', 'Session', 'Distance', 'Unit', 'Minutes', 'Time (h:mm)', 'Avg mph', 'Pace (min)', 'Pace unit', 'Pace (m:ss)', 'Note', 'Source'],
      ...rows.map((r) => [
        r.n, r.modN, new Date(r.date + 'T00:00:00'), r.day, r.week, r.phase, r.modalityLabel, r.title,
        r.distance, r.unit, r.minutes, exHM(r.minutes), r1(r.mph, 2), r1(r.pace, 3), r.paceUnit,
        r.pace ? fmtPaceMin(r.pace) : '', r.note, r.source,
      ]),
    ],
    [9, 11, 11, 6, 6, 13, 18, 26, 10, 6, 9, 11, 9, 10, 9, 11, 30, 8],
  );
  add(
    'Weekly',
    [
      ['Week', 'Dates', 'Phase', 'Swim yds', 'Bike mi', 'Run mi', 'Swim min', 'Bike min', 'Run min', 'Other min', 'Total hrs', 'WoW %', 'Swim /100yd (min)', 'Bike mph', 'Run /mi (min)', 'Longest swim', 'Longest ride', 'Longest run', 'Cum swim', 'Cum bike', 'Cum run', 'Plan swim', 'Plan bike', 'Plan run', 'Bench swim', 'Bench bike', 'Bench run', 'Planned', 'Planned done', 'Extra', 'Completion %'],
      ...weeks.map((w) => [
        w.week, w.dates, w.phase, w.swimYds, r1(w.bikeMi), r1(w.runMi), w.swimMin, w.bikeMin, w.runMin, w.otherMin,
        exHrs(w.totalMin), r1(w.wowPct), r1(w.swimPace, 3), r1(w.bikeMph, 2), r1(w.runPace, 3),
        w.longestSwim || null, w.longestRide || null, w.longestRun || null,
        w.cumSwim, r1(w.cumBike), r1(w.cumRun),
        w.target?.plan.swim ?? null, w.target?.plan.bike ?? null, w.target?.plan.run ?? null,
        w.target?.bench.swim ?? null, w.target?.bench.bike ?? null, w.target?.bench.run ?? null,
        w.planned, w.plannedDone, w.extra, r1(w.completionPct),
      ]),
    ],
    [6, 16, 13, ...Array(28).fill(11)],
  );
  add('Insights', [['Insight', 'Value', 'Detail'], ...insights.map((i) => [i.title, i.value, i.detail])], [28, 26, 120]);
  add('Benchmarks', [['Benchmark', 'This build'], ...benchmarks], [28, 26]);
  return new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellDates: true })], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

// ── Raw JSON ──
function exBuildJson(data) {
  return new Blob(
    [
      JSON.stringify(
        {
          schema: 'imfl-training-export/1',
          exportedAt: new Date().toISOString(),
          race: { name: 'IRONMAN Florida', date: '2026-11-07', location: 'Panama City Beach', trainingStart: EX_START },
          units: { swim: 'yds', bike: 'mi', run: 'mi', duration: 'minutes', swimPace: 'min per 100 yds', runPace: 'min per mi' },
          // Exactly what the tracker keeps in localStorage, so it can be restored later
          raw: {
            completions,
            customWorkouts,
            positions,
            deletedSessions: [...deletedSessions],
            projections,
          },
          sessions: data.sessions.map(({ order, ...s }) => s),
          rows: data.rows,
          weekly: data.weeks,
          insights: data.insights,
          benchmarks: data.benchmarks,
          plan: PLAN.map(({ detail, ...s }) => s),
          paceTargets: PACE_TARGETS.slice(1),
        },
        null,
        2,
      ),
    ],
    { type: 'application/json' },
  );
}

async function exportTrainingData() {
  const btn = document.getElementById('export-btn');
  const label = btn ? btn.innerHTML : '';
  const folder = `IMFL-2026-Training-Export_${localDate(0)}`;
  // Ask for the destination first — the picker needs the click's user activation
  let dir = null;
  if (window.showDirectoryPicker) {
    try {
      dir = await window.showDirectoryPicker({ id: 'imfl-export', mode: 'readwrite', startIn: 'documents' });
    } catch (e) {
      if (e.name === 'AbortError') return;
      dir = null;
    }
  }
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Exporting…';
    }
    const { sessions, rows } = exCollect();
    if (!sessions.length) {
      alert('No logged sessions to export yet.');
      if (btn) btn.innerHTML = label;
      return;
    }
    await exLoadScript(EX_LIBS.jspdf);
    await Promise.all([exLoadScript(EX_LIBS.autotable), exLoadScript(EX_LIBS.xlsx), dir ? null : exLoadScript(EX_LIBS.jszip)]);
    await document.fonts.ready;
    const weeks = exWeekly(rows, sessions);
    const { insights, benchmarks } = exInsights(rows, sessions, weeks);
    const data = { sessions, rows, weeks, insights, benchmarks };
    const files = {
      'imfl-2026-raw-data.json': exBuildJson(data),
      'imfl-2026-training-report.pdf': exBuildPdf(data),
      'imfl-2026-training-data.xlsx': exBuildXlsx(data),
    };
    if (dir) {
      const sub = await dir.getDirectoryHandle(folder, { create: true });
      for (const [name, blob] of Object.entries(files)) {
        const fh = await sub.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
      }
    } else {
      const zip = new JSZip();
      const f = zip.folder(folder);
      Object.entries(files).forEach(([name, blob]) => f.file(name, blob));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await zip.generateAsync({ type: 'blob' }));
      a.download = folder + '.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    if (btn) btn.textContent = '✓ Exported';
    setTimeout(() => btn && (btn.innerHTML = label), 2500);
  } catch (e) {
    console.error(e);
    alert('Export failed: ' + e.message);
    if (btn) btn.innerHTML = label;
  } finally {
    if (btn) btn.disabled = false;
  }
}
