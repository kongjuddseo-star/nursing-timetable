// 간호학과 시간표 자동 배치 엔진 (브라우저·Node 공용)
// 배치 방식: 조건 점수(반드시=큰 벌점, 가능하면=작은 벌점)를 최소화하는 담금질(simulated annealing)
const TT = (() => {
  const DAYS = ['월', '화', '수', '목', '금'];
  const H = 1000; // '반드시' 조건 1건 벌점
  const PRACTICE = new Set(['기본간호실습실', '시뮬레이션실습실', '실습실']);

  function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }
  function parseWeeks(str, total) {
    const s = String(str ?? '').trim();
    if (!s) return range(1, total);
    const out = new Set();
    for (const part of s.split(',')) {
      const p = part.trim(); if (!p) continue;
      const m = p.match(/^(\d+)\s*[~\-]\s*(\d+)$/);
      if (m) range(+m[1], +m[2]).forEach(w => out.add(w));
      else if (/^\d+$/.test(p)) out.add(+p);
    }
    return [...out].filter(w => w >= 1 && w <= total).sort((a, b) => a - b);
  }
  function parseAvail(v, okSet) {
    const s = String(v ?? '가능').trim();
    if (s === '' || s === '가능') return new Set(okSet);
    if (s === '불가') return new Set();
    if (s === '오전') return new Set([...okSet].filter(p => p <= 4));
    if (s === '오후') return new Set([...okSet].filter(p => p >= 6));
    const out = new Set();
    for (const part of s.split(',')) {
      const m = part.trim().match(/^(\d+)\s*[~\-]\s*(\d+)$/);
      if (m) range(+m[1], +m[2]).forEach(p => okSet.has(p) && out.add(p));
      else if (/^\d+$/.test(part.trim()) && okSet.has(+part.trim())) out.add(+part.trim());
    }
    return out;
  }
  const gradeNum = g => parseInt(String(g), 10);

  function buildModel(state) {
    const S = state.settings, W = +S.weeks || 15;
    const okList = S.periods.filter(p => p.ok).map(p => +p.n).sort((a, b) => a - b);
    const okSet = new Set(okList);
    const maxP = Math.max(...S.periods.map(p => +p.n));
    const runs = []; // 연속 교시 묶음 (점심에서 끊김)
    for (const p of okList) { const last = runs[runs.length - 1]; if (last && last[last.length - 1] === p - 1) last.push(p); else runs.push([p]); }
    const startsFor = len => { const out = []; for (let d = 0; d < 5; d++) for (const r of runs) for (let i = 0; i + len <= r.length; i++) out.push([d, r[i]]); return out; };
    const warnings = [];
    const classSize = {}; for (const c of state.classes) classSize[c.grade + '|' + c.sec] = +c.size || 0;
    const profMap = {};
    for (const p of state.profs) {
      const allow = DAYS.map(d => parseAvail(p.avail?.[d], okSet));
      profMap[p.name] = { ...p, allow, dislike: DAYS.map(() => new Set()), like: DAYS.map(() => new Set()), why: DAYS.map(() => ({})) };
      DAYS.forEach((d, i) => { for (const n of okList) if (!allow[i].has(n)) profMap[p.name].why[i][n] = '출강 요일·시간 외'; });
    }
    for (const c of state.conds || []) {
      const P = profMap[c.prof]; const di = DAYS.indexOf(c.day);
      if (!P || di < 0) { if (c.prof) warnings.push(`교수조건: "${c.prof} ${c.day}" 를 찾을 수 없음`); continue; }
      for (const n of range(+c.s || 1, +c.e || +c.s || 1)) {
        if (c.type === '불가(반드시)') { P.allow[di].delete(n); P.why[di][n] = c.reason || '교수 불가 시간'; }
        else if (c.type === '비선호') P.dislike[di].add(n);
        else if (c.type === '선호') P.like[di].add(n);
      }
    }
    const rooms = state.rooms.map((r, i) => ({ ...r, i }));
    const roomByName = {}; rooms.forEach(r => roomByName[r.name] = r);
    const classKeys = state.classes.map(c => c.grade + '|' + c.sec);
    const blocked = { C: {}, R: {}, P: {} }; // key -> Set('d|p')
    for (const b of state.blocked || []) {
      const di = DAYS.indexOf(b.day); if (di < 0) continue;
      const t = String(b.target || '').trim(); let type, keys = [];
      let m;
      if (/^전체/.test(t)) { type = 'C'; keys = classKeys; }
      else if ((m = t.match(/^(\d)\s*학년\s*([A-Z])?$/))) { type = 'C'; keys = classKeys.filter(k => k.startsWith(m[1] + '학년|') && (!m[2] || k.endsWith('|' + m[2]))); }
      else if (roomByName[t]) { type = 'R'; keys = [t]; }
      else if (profMap[t]) { type = 'P'; keys = [t]; }
      else { warnings.push(`막힌시간: 대상 "${t}" 를 찾을 수 없음`); continue; }
      for (const k of keys) { blocked[type][k] ??= {}; for (const n of range(+b.s, +b.e || +b.s)) blocked[type][k][di + '|' + n] = b.reason || '막힌 시간'; }
    }
    // 주차 → 원자 구간(비트) 압축
    const sessions = [];
    const raw = [];
    for (const c of state.courses) {
      if (c.place !== '배치') continue;
      const blocks = String(c.blocks || '').split('+').map(x => parseInt(x, 10)).filter(x => x > 0);
      if (!blocks.length) { warnings.push(`${c.grade} ${c.name} ${c.sec}: 블록 구성이 비어 있어 배치하지 못함`); continue; }
      const cw = parseWeeks(c.weeks, W);
      const team = (state.team || []).filter(t => t.grade === c.grade && t.name === c.name && (t.sec === '전체' || t.sec === c.sec) && String(t.weeks ?? '').trim());
      let profs;
      if (team.length) {
        const maxTeamWeek = Math.max(...team.flatMap(t => parseWeeks(t.weeks, W)));
        const scale = maxTeamWeek > cw[cw.length - 1]; // 예: 3학년 1~8주 운영인데 분담이 1~15주로 적힌 경우 → 비례 환산
        profs = team.map(t => {
          let ws = parseWeeks(t.weeks, W);
          if (scale) ws = [...new Set(ws.map(w => cw[Math.min(cw.length - 1, Math.ceil(w * cw.length / maxTeamWeek) - 1)]))];
          ws = ws.filter(w => cw.includes(w));
          return { name: t.prof, weeks: ws };
        }).filter(p => p.weeks.length);
        if (scale) warnings.push(`${c.grade} ${c.name}: 팀티칭 주차(최대 ${maxTeamWeek}주)를 운영 주차 ${c.weeks} 에 비례해서 맞춤`);
      } else profs = c.prof ? [{ name: c.prof, weeks: cw }] : [];
      for (const p of profs) if (!profMap[p.name]) { warnings.push(`${c.name} ${c.sec}: 교수 "${p.name}" 가 교수목록에 없음 (조건 없이 배치)`); profMap[p.name] = { name: p.name, dmax: 99, cmax: 99, allow: DAYS.map(() => new Set(okSet)), dislike: DAYS.map(() => new Set()), like: DAYS.map(() => new Set()), why: DAYS.map(() => ({})) }; }
      const members = (c.members && c.members.length ? c.members : [c.sec]).map(m => c.grade + '|' + m);
      const students = +c.students || members.reduce((a, k) => a + (classSize[k] || 0), 0);
      let cands;
      if (c.fixed && c.fixed.length) cands = c.fixed.map(n => roomByName[n]).filter(Boolean);
      else cands = rooms.filter(r => r.group === (c.need || '일반 강의실'));
      if (!cands.length && c.need !== '가상강의동') warnings.push(`${c.name} ${c.sec}: 쓸 수 있는 강의실이 없음 (필요 공간: ${c.need || '-'})`);
      const practice = PRACTICE.has(c.need);
      let fit = practice ? cands : cands.filter(r => (+r.cap || 0) >= students);
      const capBad = !practice && cands.length && !fit.length;
      if (capBad) { fit = cands; warnings.push(`${c.name} ${c.sec}: 수강 ${students}명이 들어갈 강의실이 없음`); }
      let st = null;
      blocks.forEach((len, bi) => {
        const starts = startsFor(len).filter(([d]) => !c.days?.length || c.days.includes(DAYS[d]));
        if (!starts.length) warnings.push(`${c.name} ${c.sec}: ${len}시간 연속 블록을 넣을 시간대가 없음`);
        raw.push({ id: c.id + '#' + bi, cid: c.id, c, len, bi, cw, profs, members, students, rooms: fit.map(r => r.i), capBad, starts, practice });
      });
    }
    // 원자 구간
    const sigs = new Map();
    for (let w = 1; w <= W; w++) {
      let sig = raw.map(r => (r.cw.includes(w) ? '1' : '0') + r.profs.map(p => p.weeks.includes(w) ? '1' : '0').join('')).join('');
      if (!sigs.has(sig)) sigs.set(sig, []);
      sigs.get(sig).push(w);
    }
    const atoms = [...sigs.values()].filter(ws => raw.some(r => r.cw.includes(ws[0])));
    const maskOf = ws => atoms.reduce((m, a, i) => (ws.includes(a[0]) ? m | (1 << i) : m), 0);
    for (const r of raw) {
      r.mask = maskOf(r.cw);
      r.profs = r.profs.map(p => ({ name: p.name, mask: maskOf(p.weeks) })).filter(p => p.mask);
      sessions.push(r);
    }
    return { S, W, warnings: [...new Set(warnings)], okList, okSet, maxP, runs, profMap, rooms, blocked, sessions, atoms, classSize, opts: state.ruleOpts || {} };
  }

  function createSolver(state) {
    const M = buildModel(state);
    const N = M.sessions.length, A = M.atoms.length;
    const sd = new Int8Array(N), sp = new Int8Array(N), sr = new Int16Array(N);
    const locked = new Uint8Array(N);
    const opts = M.opts;
    const sameDayW = opts.sameDay === '가능하면' ? 30 : H;
    const retakeW = state.settings.retake === '반드시' ? H : state.settings.retake === '가능하면' ? 40 : 0;
    const gapW = opts.gaps === '사용 안 함' ? 0 : opts.gaps === '반드시' ? 50 : 2;
    const lateW = opts.late === '사용 안 함' ? 0 : 0.6;
    const dayMax = +opts.classDayMax || 0;
    const consecW = opts.consec === '반드시' ? H : 25;
    // 자원별 구성원
    const res = new Map(); // key -> {type, members:[{s, mask, tag, role}]}
    const add = (key, type, m) => { if (!res.has(key)) res.set(key, { type, name: key.slice(2), members: [] }); res.get(key).members.push(m); };
    const sesKeys = M.sessions.map(() => []);
    const tagIds = new Map(); const tagId = t => { if (!tagIds.has(t)) tagIds.set(t, tagIds.size); return tagIds.get(t); };
    M.sessions.forEach((s, i) => {
      for (const p of s.profs) { add('P:' + p.name, 'P', { s: i, mask: p.mask }); sesKeys[i].push('P:' + p.name); }
      for (const k of s.members) { add('C:' + k, 'C', { s: i, mask: s.mask, tid: tagId(s.c.grade + '|' + s.c.name) }); sesKeys[i].push('C:' + k); }
      add('U:' + s.cid, 'U', { s: i, mask: s.mask }); sesKeys[i].push('U:' + s.cid);
      if (retakeW) {
        const g = gradeNum(s.c.grade);
        add('G:' + g, 'G', { s: i, mask: s.mask, role: 0 }); sesKeys[i].push('G:' + g);
        if (s.c.common) { add('G:' + (g + 1), 'G', { s: i, mask: s.mask, role: 1 }); sesKeys[i].push('G:' + (g + 1)); }
      }
    });
    const roomMembers = M.rooms.map(() => new Set());
    const cache = new Map();
    const P = M.maxP + 1;

    const ov = (i, j) => { // 두 수업이 겹치는 시간 수
      if (sd[i] !== sd[j] || !(M.sessions[i].mask & M.sessions[j].mask)) return 0;
      const a = Math.max(sp[i], sp[j]), b = Math.min(sp[i] + M.sessions[i].len, sp[j] + M.sessions[j].len);
      return b > a ? b - a : 0;
    };
    const ovm = (i, mi, j, mj) => (mi & mj) ? ovRaw(i, j) : 0;
    const ovRaw = (i, j) => { if (sd[i] !== sd[j]) return 0; const a = Math.max(sp[i], sp[j]), b = Math.min(sp[i] + M.sessions[i].len, sp[j] + M.sessions[j].len); return b > a ? b - a : 0; };
    // 자원마다 구별이 필요한 주차 구간만 미리 계산
    for (const r of res.values()) {
      const sig = new Map();
      for (let a = 0; a < A; a++) { const k = r.members.map(m => m.mask >> a & 1).join(''); if (!k.includes('1')) continue; if (!sig.has(k)) sig.set(k, a); }
      r.atoms = [...sig.values()];
    }
    const day = new Uint8Array(P);
    function evalRes(key) {
      if (key.charCodeAt(0) === 82) return evalRoom(+key.slice(2));
      const r = res.get(key); const mem = r.members; const n = mem.length;
      let cost = 0;
      if (r.type === 'U') {
        for (let x = 0; x < n; x++) for (let y = x + 1; y < n; y++) if (sd[mem[x].s] === sd[mem[y].s]) cost += sameDayW;
        return cost;
      }
      if (r.type === 'P') {
        const pr = M.profMap[r.name]; const bl = M.blocked.P[r.name];
        for (let x = 0; x < n; x++) {
          const i = mem[x].s, d = sd[i], e = sp[i] + M.sessions[i].len;
          for (let p = sp[i]; p < e; p++) {
            if (!pr.allow[d].has(p)) cost += H;
            if (bl && bl[d + '|' + p]) cost += H;
            if (pr.dislike[d].has(p)) cost += 3;
            if (pr.like[d].has(p)) cost -= 1;
          }
          for (let y = x + 1; y < n; y++) cost += H * ovm(i, mem[x].mask, mem[y].s, mem[y].mask);
        }
        const dmax = +pr.dmax || 99, cmax = +pr.cmax || 99;
        for (const a of r.atoms) for (let d = 0; d < 5; d++) {
          day.fill(0); let any = false;
          for (const m of mem) if (sd[m.s] === d && (m.mask >> a & 1)) { any = true; for (let p = sp[m.s]; p < sp[m.s] + M.sessions[m.s].len; p++) day[p] = 1; }
          if (!any) continue;
          let tot = 0, run = 0;
          for (let p = 1; p < P; p++) { if (day[p]) { tot++; run++; if (run > cmax) cost += consecW; } else run = 0; }
          if (tot > dmax) cost += H * (tot - dmax);
        }
        return cost;
      }
      if (r.type === 'C') {
        const bl = M.blocked.C[r.name];
        for (let x = 0; x < n; x++) {
          const i = mem[x].s, d = sd[i], e = sp[i] + M.sessions[i].len;
          for (let p = sp[i]; p < e; p++) { if (bl && bl[d + '|' + p]) cost += H; if (p >= 8) cost += lateW; }
          for (let y = x + 1; y < n; y++) if (mem[x].tid !== mem[y].tid) cost += H * ovm(i, mem[x].mask, mem[y].s, mem[y].mask);
        }
        if (gapW || dayMax) for (const a of r.atoms) for (let d = 0; d < 5; d++) {
          day.fill(0); let any = false;
          for (const m of mem) if (sd[m.s] === d && (m.mask >> a & 1)) { any = true; for (let p = sp[m.s]; p < sp[m.s] + M.sessions[m.s].len; p++) day[p] = 1; }
          if (!any) continue;
          let first = -1, last = -1, tot = 0;
          for (const p of M.okList) if (day[p]) { if (first < 0) first = p; last = p; tot++; }
          let gaps = 0; for (const p of M.okList) if (p > first && p < last && !day[p]) gaps++;
          cost += gapW * gaps * gaps;
          if (dayMax && tot > dayMax) cost += 15 * (tot - dayMax);
        }
        return cost;
      }
      if (r.type === 'G') {
        for (let x = 0; x < n; x++) for (let y = x + 1; y < n; y++) if (mem[x].role !== mem[y].role) cost += retakeW * ovm(mem[x].s, mem[x].mask, mem[y].s, mem[y].mask);
        return cost;
      }
      return 0;
    }
    function evalRoom(ri) {
      const room = M.rooms[ri]; const bl = M.blocked.R[room.name];
      let cost = 0; const L = [...roomMembers[ri]];
      for (let x = 0; x < L.length; x++) {
        const i = L[x], s = M.sessions[i], d = sd[i];
        if (!s.practice && (+room.cap || 0) < s.students) cost += 50;
        if (bl) for (let p = sp[i]; p < sp[i] + s.len; p++) if (bl[d + '|' + p]) cost += H;
        for (let y = x + 1; y < L.length; y++) cost += H * ov(i, L[y]);
      }
      return cost;
    }
    function keysOf(i, extraRoom) { const k = sesKeys[i].slice(); if (sr[i] >= 0) k.push('R:' + sr[i]); if (extraRoom != null && extraRoom >= 0) k.push('R:' + extraRoom); return k; }
    let total = 0;
    function fullEval() { cache.clear(); total = 0; for (const k of res.keys()) { const v = evalRes(k); cache.set(k, v); total += v; } M.rooms.forEach((_, ri) => { const v = evalRoom(ri); cache.set('R:' + ri, v); total += v; }); return total; }
    function setRoom(i, r) { if (sr[i] >= 0) roomMembers[sr[i]].delete(i); sr[i] = r; if (r >= 0) roomMembers[r].add(i); }
    // changes: [[i,d,p,r]]
    function tryChanges(changes, T) {
      const keys = new Set();
      for (const [i, , , r] of changes) for (const k of keysOf(i, r)) keys.add(k);
      let before = 0; for (const k of keys) before += cache.get(k) ?? 0;
      const old = changes.map(([i]) => [i, sd[i], sp[i], sr[i]]);
      for (const [i, d, p, r] of changes) { sd[i] = d; sp[i] = p; setRoom(i, r); }
      let after = 0; const nv = [];
      for (const k of keys) { const v = evalRes(k); nv.push([k, v]); after += v; }
      const delta = after - before;
      if (delta <= 0 || (T > 0 && Math.random() < Math.exp(-delta / T))) { for (const [k, v] of nv) cache.set(k, v); total += delta; return true; }
      for (const [i, d, p, r] of old) { sd[i] = d; sp[i] = p; setRoom(i, r); }
      return false;
    }
    const rnd = n => Math.floor(Math.random() * n);
    const pickRoom = (i, d, p) => {
      const s = M.sessions[i]; if (!s.rooms.length) return -1;
      let best = s.rooms[rnd(s.rooms.length)], bestC = 1e9;
      for (let t = 0; t < Math.min(4, s.rooms.length); t++) {
        const ri = t === 0 && sr[i] >= 0 && s.rooms.includes(sr[i]) ? sr[i] : s.rooms[rnd(s.rooms.length)];
        let c = 0;
        for (const j of roomMembers[ri]) if (j !== i && sd[j] === d && (M.sessions[j].mask & s.mask) && sp[j] < p + s.len && p < sp[j] + M.sessions[j].len) c++;
        if (!M.sessions[i].practice && (+M.rooms[ri].cap || 0) < s.students) c += 0.5;
        if (c < bestC) { bestC = c; best = ri; }
        if (c === 0) break;
      }
      return best;
    };
    // 초기 배치
    const lockMap = state.locked || {};
    const roomIdx = {}; M.rooms.forEach(r => roomIdx[r.name] = r.i);
    const prev = state.result?.assign || {};
    M.sessions.forEach((s, i) => {
      sr[i] = -1;
      const L = lockMap[s.id];
      const P0 = L || prev[s.id];
      if (P0 && s.starts.some(([d, p]) => d === P0.d && p === P0.p)) { sd[i] = P0.d; sp[i] = P0.p; setRoom(i, P0.room in roomIdx ? roomIdx[P0.room] : pickRoom(i, P0.d, P0.p)); if (L) locked[i] = 1; }
      else if (s.starts.length) { const [d, p] = s.starts[rnd(s.starts.length)]; sd[i] = d; sp[i] = p; setRoom(i, pickRoom(i, d, p)); }
      else { sd[i] = 0; sp[i] = M.okList[0]; }
    });
    fullEval();
    const movable = []; M.sessions.forEach((s, i) => { if (!locked[i] && s.starts.length) movable.push(i); });
    let best = total, bestState = null;
    const snap = () => ({ d: sd.slice(), p: sp.slice(), r: sr.slice() });
    bestState = snap();

    function greedy(order) {
      for (const i of order) {
        const s = M.sessions[i]; let bestC = null, bestD = Infinity;
        for (const [d, p] of s.starts) {
          const r = pickRoom(i, d, p);
          const keys = new Set(keysOf(i, r)); let before = 0; for (const k of keys) before += cache.get(k) ?? 0;
          const o = [sd[i], sp[i], sr[i]]; sd[i] = d; sp[i] = p; setRoom(i, r);
          let after = 0; for (const k of keys) after += evalRes(k);
          sd[i] = o[0]; sp[i] = o[1]; setRoom(i, o[2]);
          const delta = after - before + Math.random() * 0.01;
          if (delta < bestD) { bestD = delta; bestC = [i, d, p, r]; }
        }
        if (bestC) tryChanges([bestC], 0);
      }
    }
    async function run({ iterations = 300000, onProgress, yieldEvery = 5000, shouldStop } = {}) {
      if (!movable.length) return result();
      if (!Object.keys(prev).length) {
        const order = movable.slice().sort((a, b) => M.sessions[a].starts.length * (M.sessions[a].rooms.length || 1) - M.sessions[b].starts.length * (M.sessions[b].rooms.length || 1) || M.sessions[b].len - M.sessions[a].len);
        greedy(order);
        if (total < best) { best = total; bestState = snap(); }
      }
      const rounds = 3, per = Math.floor(iterations / rounds);
      for (let round = 0; round < rounds; round++) {
        if (round) { sd.set(bestState.d); sp.set(bestState.p); for (let i = 0; i < N; i++) setRoom(i, bestState.r[i]); fullEval(); }
        const T0 = round ? 150 : 1500, T1 = 0.3;
        for (let it = 0; it < per; it++) {
          const T = T0 * Math.pow(T1 / T0, it / per);
          const i = movable[rnd(movable.length)], s = M.sessions[i];
          const u = Math.random();
          if (u < 0.7) { const [d, p] = s.starts[rnd(s.starts.length)]; tryChanges([[i, d, p, pickRoom(i, d, p)]], T); }
          else if (u < 0.8) { if (s.rooms.length > 1) tryChanges([[i, sd[i], sp[i], s.rooms[rnd(s.rooms.length)]]], T); }
          else {
            const j = movable[rnd(movable.length)];
            if (j !== i && M.sessions[j].len === s.len && s.starts.some(([d, p]) => d === sd[j] && p === sp[j]) && M.sessions[j].starts.some(([d, p]) => d === sd[i] && p === sp[i]))
              tryChanges([[i, sd[j], sp[j], sr[i]], [j, sd[i], sp[i], sr[j]]], T);
          }
          if (total < best - 1e-9) { best = total; bestState = snap(); }
          const g = round * per + it;
          if (onProgress && g % yieldEvery === 0) { onProgress(g / iterations, best); await new Promise(r => setTimeout(r, 0)); if (shouldStop && shouldStop()) { round = rounds; break; } }
        }
      }
      sd.set(bestState.d); sp.set(bestState.p);
      for (let i = 0; i < N; i++) setRoom(i, bestState.r[i]);
      fullEval();
      return result();
    }

    function result() {
      const assign = {};
      M.sessions.forEach((s, i) => { if (s.starts.length) assign[s.id] = { d: sd[i], p: sp[i], room: sr[i] >= 0 ? M.rooms[sr[i]].name : '' }; });
      return { assign, score: Math.round(total), issues: check(state, assign, M), warnings: M.warnings, at: new Date().toISOString() };
    }
    return { model: M, run, result };
  }

  // 사람이 읽을 수 있는 점검 결과 (수동 수정 후에도 다시 씀)
  function check(state, assign, M) {
    M = M || buildModel(state);
    const issues = [];
    const label = s => `${s.c.grade} ${s.c.name}${s.c.sec ? ' ' + s.c.sec : ''}`;
    const atomTxt = mask => { const ws = M.atoms.filter((_, a) => mask >> a & 1).flat(); return ws.length === M.W || !ws.length ? '' : ` (${ws[0]}~${ws[ws.length - 1]}주)`; };
    const occ = {}; // key -> 'd|p|a' -> [labels]
    const put = (key, d, p, mask, lab, tag) => { for (let a = 0; a < M.atoms.length; a++) if (mask >> a & 1) { const k = d + '|' + p + '|' + a; ((occ[key] ??= {})[k] ??= []).push({ lab, tag, a }); } };
    const profDay = {};
    for (const s of M.sessions) {
      const A0 = assign[s.id];
      if (!A0) { issues.push({ level: '반드시', kind: '배치 불가', text: `${label(s)}: 넣을 수 있는 시간대가 없음` }); continue; }
      const { d, p, room } = A0;
      const when = `${DAYS[d]} ${p}${s.len > 1 ? '~' + (p + s.len - 1) : ''}교시`;
      for (const pr of s.profs) {
        const P = M.profMap[pr.name];
        const bad = []; for (let x = p; x < p + s.len; x++) if (!P.allow[d].has(x) || M.blocked.P[pr.name]?.[d + '|' + x]) bad.push(x);
        if (bad.length) issues.push({ level: '반드시', kind: '교수 불가 시간', who: pr.name, text: `${pr.name} — ${label(s)} ${when}: ${P.why[d][bad[0]] || M.blocked.P[pr.name]?.[d + '|' + bad[0]] || '불가 시간'}` });
        let dis = 0; for (let x = p; x < p + s.len; x++) if (P.dislike[d].has(x)) dis++;
        if (dis) issues.push({ level: '가능하면', kind: '비선호 시간', who: pr.name, text: `${pr.name} — ${label(s)} ${when}: 비선호 시간` });
        for (let x = p; x < p + s.len; x++) put('P:' + pr.name, d, x, pr.mask, label(s));
        (profDay[pr.name] ??= []).push({ d, p, len: s.len, mask: pr.mask });
      }
      for (const k of s.members) {
        for (let x = p; x < p + s.len; x++) { put('C:' + k, d, x, s.mask, label(s), s.c.grade + s.c.name); const b = M.blocked.C[k]?.[d + '|' + x]; if (b) issues.push({ level: '반드시', kind: '막힌 시간', text: `${label(s)} ${when}: ${k.replace('|', ' ')}반 막힌 시간(${b})` }); }
      }
      if (room) {
        for (let x = p; x < p + s.len; x++) put('R:' + room, d, x, s.mask, label(s));
        const R = M.rooms.find(r => r.name === room);
        if (R && !s.practice && (+R.cap || 0) < s.students) issues.push({ level: '가능하면', kind: '강의실 인원', text: `${label(s)}: ${room} 수용 ${R.cap}명 < 수강 ${s.students}명` });
      } else if (s.c.need !== '가상강의동') issues.push({ level: '반드시', kind: '강의실 없음', text: `${label(s)}: 배정할 강의실이 없음` });
    }
    const wk = atomsList => { const ws = atomsList.map(a => M.atoms[a]).flat().sort((x, y) => x - y); if (!ws.length || ws.length === M.W) return ''; const parts = []; let s0 = ws[0], pv = ws[0]; for (const w of ws.slice(1).concat([null])) { if (w === pv + 1) { pv = w; continue; } parts.push(s0 === pv ? '' + s0 : s0 + '~' + pv); s0 = pv = w; } return ' (' + parts.join(', ') + '주)'; };
    const grp = new Map();
    for (const key in occ) for (const k in occ[key]) {
      const L = occ[key][k];
      const tags = new Set(L.map(x => x.tag ?? x.lab));
      if (L.length > 1 && tags.size > 1) {
        const [d, p, a] = k.split('|').map(Number);
        const names = [...new Set(L.map(x => x.lab))].sort();
        const g = key + '|' + d + '|' + names.join('/');
        if (!grp.has(g)) grp.set(g, { key, d, ps: new Set(), atoms: new Set(), names });
        grp.get(g).ps.add(p); grp.get(g).atoms.add(a);
      }
    }
    for (const x of grp.values()) {
      const ps = [...x.ps].sort((a, b) => a - b);
      const typ = { P: '교수 겹침', C: '분반 겹침', R: '강의실 겹침' }[x.key[0]];
      issues.push({ level: '반드시', kind: typ, who: x.key[0] === 'P' ? x.key.slice(2) : undefined, text: `${x.key.slice(2).replace('|', ' ')}${x.key[0] === 'C' ? '반' : ''} ${DAYS[x.d]} ${ps[0]}${ps.length > 1 ? '~' + ps[ps.length - 1] : ''}교시${wk([...x.atoms])}: ${x.names.join(' / ')}` });
    }
    for (const name in profDay) {
      const P = M.profMap[name]; const dmax = +P.dmax || 99, cmax = +P.cmax || 99;
      for (let d = 0; d < 5; d++) {
        let worstH = 0, worstR = 0; const aH = [], aR = [];
        for (let a = 0; a < M.atoms.length; a++) {
          const hrs = new Set(); for (const x of profDay[name]) if (x.d === d && (x.mask >> a & 1)) for (let q = x.p; q < x.p + x.len; q++) hrs.add(q);
          if (hrs.size > dmax) { aH.push(a); worstH = Math.max(worstH, hrs.size); }
          let run = 0, mx = 0; for (let q = 1; q <= M.maxP; q++) { run = hrs.has(q) ? run + 1 : 0; mx = Math.max(mx, run); }
          if (mx > cmax) { aR.push(a); worstR = Math.max(worstR, mx); }
        }
        if (aH.length) issues.push({ level: '반드시', kind: '하루 최대 시수', who: name, text: `${name} ${DAYS[d]}요일${wk(aH)}: ${worstH}시간 (최대 ${dmax})` });
        if (aR.length) issues.push({ level: M.opts.consec === '반드시' ? '반드시' : '가능하면', kind: '연속 최대 시수', who: name, text: `${name} ${DAYS[d]}요일${wk(aR)}: ${worstR}시간 연속 (최대 ${cmax})` });
      }
    }
    const byCourse = {};
    for (const s of M.sessions) if (assign[s.id]) (byCourse[s.cid] ??= []).push([s, assign[s.id].d]);
    for (const cid in byCourse) { const L = byCourse[cid]; const days = L.map(x => x[1]); if (new Set(days).size < days.length) issues.push({ level: M.opts.sameDay === '가능하면' ? '가능하면' : '반드시', kind: '같은 날 같은 과목', text: `${label(L[0][0])}: 같은 요일에 두 번` }); }
    // 중복 제거
    const uniq = new Map(); for (const x of issues) uniq.set(x.kind + x.text, x);
    return [...uniq.values()];
  }
  return { DAYS, parseWeeks, buildModel, createSolver, check };
})();
if (typeof module !== 'undefined') module.exports = TT;
