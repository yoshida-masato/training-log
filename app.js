'use strict';
/* Training Log — ローカルファースト筋トレ記録 PWA
 * データは全て IndexedDB に保存（通信・ログイン不要）。起動時に全件メモリに載せて即応答。
 * データモデル:
 *   exercises: { id, category, name, order }
 *   sessions:  { id, date(YYYY-MM-DD), location }
 *   logs:      { id, exerciseId, sessionId, sets: [{w,r,s}], updatedAt }
 */

/* ---------- IndexedDB ---------- */
const IDB_NAME = 'training-log';
const IDB_VER = 1;
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('exercises')) db.createObjectStore('exercises', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('logs')) db.createObjectStore('logs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode) { return _db.transaction(store, mode).objectStore(store); }
function idbGetAll(store) {
  return new Promise((res, rej) => { const r = tx(store, 'readonly').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function idbPut(store, val) {
  return new Promise((res, rej) => { const r = tx(store, 'readwrite').put(val); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}
function idbDelete(store, key) {
  return new Promise((res, rej) => { const r = tx(store, 'readwrite').delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}
function idbClear(store) {
  return new Promise((res, rej) => { const r = tx(store, 'readwrite').clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}
function idbBulkPut(store, vals) {
  return new Promise((res, rej) => {
    const t = _db.transaction(store, 'readwrite'); const os = t.objectStore(store);
    vals.forEach((v) => os.put(v));
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  });
}
async function metaGet(key, dflt) {
  return new Promise((res) => { const r = tx('meta', 'readonly').get(key); r.onsuccess = () => res(r.result ? r.result.value : dflt); r.onerror = () => res(dflt); });
}
function metaSet(key, value) { return idbPut('meta', { key, value }); }

/* ---------- In-memory store ---------- */
const DB = { exercises: [], sessions: [], logs: [] };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2));

async function loadAll() {
  const [ex, se, lo] = await Promise.all([idbGetAll('exercises'), idbGetAll('sessions'), idbGetAll('logs')]);
  DB.exercises = ex; DB.sessions = se; DB.logs = lo;
}

/* ---------- Date helpers ---------- */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const WD = ['日', '月', '火', '水', '木', '金', '土'];
function fmtDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  const wd = WD[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${wd})`;
}
function fmtDateFull(str) { const [y, m, d] = str.split('-').map(Number); return `${y}/${m}/${d}`; }

/* ---------- Data access ---------- */
function sessionKey(date, location) { return date + ' ' + (location || ''); }
function findSession(date, location) { return DB.sessions.find((s) => s.date === date && (s.location || '') === (location || '')); }
async function getOrCreateSession(date, location) {
  let s = findSession(date, location);
  if (!s) { s = { id: uid(), date, location: location || '' }; DB.sessions.push(s); await idbPut('sessions', s); }
  return s;
}
function logFor(exerciseId, sessionId) { return DB.logs.find((l) => l.exerciseId === exerciseId && l.sessionId === sessionId); }
function logsOfExercise(exerciseId) {
  return DB.logs.filter((l) => l.exerciseId === exerciseId && l.sets && l.sets.length)
    .map((l) => ({ log: l, session: DB.sessions.find((s) => s.id === l.sessionId) }))
    .filter((x) => x.session)
    .sort((a, b) => (a.session.date < b.session.date ? 1 : -1)); // 新しい順
}
// 現在セッションを除いた直近の記録（前回）
function previousLogs(exerciseId, currentSessionId, limit) {
  return logsOfExercise(exerciseId).filter((x) => x.log.sessionId !== currentSessionId).slice(0, limit || 2);
}
async function saveLog(exerciseId, sessionId, sets) {
  let l = logFor(exerciseId, sessionId);
  if (sets.length === 0) {
    if (l) { DB.logs = DB.logs.filter((x) => x.id !== l.id); await idbDelete('logs', l.id); }
    return;
  }
  if (!l) { l = { id: uid(), exerciseId, sessionId, sets: [], updatedAt: 0 }; DB.logs.push(l); }
  l.sets = sets; l.updatedAt = Date.now();
  await idbPut('logs', l);
}
async function addExercise(category, name) {
  const order = DB.exercises.length ? Math.max(...DB.exercises.map((e) => e.order || 0)) + 1 : 0;
  const e = { id: uid(), category: (category || '').trim(), name: name.trim(), order };
  DB.exercises.push(e); await idbPut('exercises', e); return e;
}
function findExerciseByName(name) { const n = name.trim(); return DB.exercises.find((e) => e.name === n); }
function categories() {
  const set = [];
  DB.exercises.slice().sort(byOrder).forEach((e) => { const c = e.category || 'その他'; if (!set.includes(c)) set.push(c); });
  return set;
}
const byOrder = (a, b) => (a.order || 0) - (b.order || 0);

/* ---------- Set formatting ---------- */
function fmtSet(st) { return st.s > 1 ? `${trimNum(st.w)}×${st.r} ×${st.s}` : `${trimNum(st.w)}×${st.r}`; }
function trimNum(n) { return Number.isInteger(n) ? String(n) : String(n); }
function summarizeSets(sets) { return sets.map(fmtSet).join(', '); }
function totalSetCount(sets) { return sets.reduce((a, s) => a + (s.s || 1), 0); }

/* ---------- App state ---------- */
const state = { tab: 'home', date: todayStr(), location: '', query: '', cat: '__all', histExerciseId: null };

/* ---------- Rendering ---------- */
const $ = (id) => document.getElementById(id);
function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

let toastTimer = null;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

function render() {
  renderHeader();
  renderNav();
  if (state.tab === 'home') renderHome();
  else if (state.tab === 'exercises') renderExercises();
  else if (state.tab === 'data') renderData();
  else if (state.tab === 'history') renderHistory();
}

function renderHeader() {
  const head = $('header');
  if (state.tab !== 'home') { head.innerHTML = `<div class="session-bar"><div class="date">${tabTitle()}</div></div>`; return; }
  head.innerHTML = '';
  const bar = h(`<div class="session-bar">
      <button class="icon" id="date-btn">${esc(fmtDate(state.date))}</button>
      <input class="loc" id="loc-input" placeholder="場所（例: AF神宮外苑）" value="${esc(state.location)}" />
    </div>`);
  head.appendChild(bar);
  head.appendChild(h(`<div class="search"><input id="search-input" placeholder="種目を検索…" value="${esc(state.query)}" /></div>`));
  const cats = categories();
  const chips = h(`<div class="chips"></div>`);
  chips.appendChild(chip('すべて', '__all'));
  cats.forEach((c) => chips.appendChild(chip(c, c)));
  head.appendChild(chips);

  $('date-btn').onclick = pickDate;
  const loc = $('loc-input');
  loc.onchange = () => { state.location = loc.value.trim(); metaSet('lastLocation', state.location); };
  const s = $('search-input');
  s.oninput = () => { state.query = s.value; renderHomeList(); };
}
function chip(label, key) {
  const el = h(`<button class="chip ${state.cat === key ? 'active' : ''}">${esc(label)}</button>`);
  el.onclick = () => { state.cat = key; render(); };
  return el;
}
function tabTitle() { return { exercises: '種目の管理', data: 'データ', history: '履歴' }[state.tab] || ''; }

function pickDate() {
  const inp = h(`<input type="date" value="${esc(state.date)}" style="position:fixed;opacity:0;pointer-events:none">`);
  document.body.appendChild(inp);
  inp.onchange = () => { if (inp.value) { state.date = inp.value; render(); } inp.remove(); };
  inp.onblur = () => setTimeout(() => inp.remove(), 200);
  inp.focus(); inp.click(); if (inp.showPicker) try { inp.showPicker(); } catch (e) {}
}

function renderHome() { renderHomeList(); }
function renderHomeList() {
  const main = $('main');
  const sess = findSession(state.date, state.location);
  const sessId = sess ? sess.id : null;
  const q = state.query.trim().toLowerCase();
  let list = DB.exercises.slice().sort(byOrder);
  if (state.cat !== '__all') list = list.filter((e) => (e.category || 'その他') === state.cat);
  if (q) list = list.filter((e) => e.name.toLowerCase().includes(q) || (e.category || '').toLowerCase().includes(q));

  if (DB.exercises.length === 0) {
    main.innerHTML = `<div class="empty">まだ種目がありません。<br>下の「データ」からスプレッドシートを取り込むか、<br>「種目」から追加してください。</div>`;
    return;
  }
  main.innerHTML = '';
  let curCat = null;
  list.forEach((e) => {
    const cat = e.category || 'その他';
    if (!q && cat !== curCat) { curCat = cat; main.appendChild(h(`<div class="cat-head">${esc(cat)}</div>`)); }
    const todayLog = sessId ? logFor(e.id, sessId) : null;
    const prev = previousLogs(e.id, sessId, 1)[0];
    const done = todayLog && todayLog.sets.length;
    const row = h(`<div class="ex ${done ? 'done' : ''}">
        <div class="info">
          <div class="name">${esc(e.name)}</div>
          ${prev ? `<div class="sub">前回 ${esc(fmtDate(prev.session.date))}: ${esc(summarizeSets(prev.log.sets))}</div>` : `<div class="sub">記録なし</div>`}
          ${done ? `<div class="today">今日: ${esc(summarizeSets(todayLog.sets))}</div>` : ''}
        </div>
        ${done ? `<div class="badge">${totalSetCount(todayLog.sets)}</div>` : ''}
      </div>`);
    row.onclick = () => openLog(e);
    main.appendChild(row);
  });
}

/* ---------- Log detail sheet ---------- */
const sheet = { open: false };
function openSheet(title, bodyEl) {
  $('sheet-title').textContent = title;
  const body = $('sheet-body'); body.innerHTML = ''; body.appendChild(bodyEl);
  $('sheet-backdrop').classList.add('open'); sheet.open = true;
}
function closeSheet() { $('sheet-backdrop').classList.remove('open'); sheet.open = false; }

async function openLog(ex) {
  const sess = await getOrCreateSession(state.date, state.location);
  const existing = logFor(ex.id, sess.id);
  let sets = existing ? existing.sets.map((s) => ({ ...s })) : [];
  const prev = previousLogs(ex.id, sess.id, 3);
  // steppers 初期値: 今日の最終セット → 前回の最初のセット → 既定
  const seed = sets.length ? sets[sets.length - 1] : (prev[0] ? prev[0].log.sets[0] : { w: 20, r: 10, s: 1 });
  const cur = { w: seed.w, r: seed.r, s: 1 };

  const body = h(`<div>
    <div id="prev-wrap"></div>
    <div class="steppers">
      ${stepper('重量', 'w', cur.w, 'kg')}
      ${stepper('レップ', 'r', cur.r, '')}
      ${stepper('セット', 's', cur.s, '')}
    </div>
    <div class="btn-row" style="margin-bottom:10px">
      <button class="primary" id="add-set">記録する</button>
      ${prev[0] ? `<button class="secondary" id="same-prev">前回と同じ</button>` : ''}
    </div>
    <div id="sets-wrap"></div>
  </div>`);

  // 前回パネル
  const pw = body.querySelector('#prev-wrap');
  if (prev.length) {
    const p = h(`<div class="prev-panel"><div class="label">これまでの記録</div></div>`);
    prev.forEach((x) => p.appendChild(h(`<div class="prev-line">${esc(fmtDate(x.session.date))} ${x.session.location ? '· ' + esc(x.session.location) : ''} — ${esc(summarizeSets(x.log.sets))}</div>`)));
    const more = h(`<div class="prev-line" style="margin-top:6px"><button class="chip" id="hist-btn">全履歴を見る →</button></div>`);
    p.appendChild(more); pw.appendChild(p);
  }

  const setsWrap = body.querySelector('#sets-wrap');
  function persist() { saveLog(ex.id, sess.id, sets); }
  function renderSets() {
    setsWrap.innerHTML = '';
    if (!sets.length) { setsWrap.appendChild(h(`<div class="hint">まだ記録がありません。上で数値を合わせて「記録する」。</div>`)); return; }
    sets.forEach((st, i) => {
      const row = h(`<div class="set-row">
          <div class="idx">${i + 1}</div>
          <div class="vals"><b>${trimNum(st.w)}</b> kg × <b>${st.r}</b> ${st.s > 1 ? `× <b>${st.s}</b>セット` : ''}</div>
          <button class="del">🗑</button>
        </div>`);
      row.querySelector('.vals').onclick = () => { cur.w = st.w; cur.r = st.r; cur.s = st.s; syncSteppers(); };
      row.querySelector('.del').onclick = (ev) => { ev.stopPropagation(); sets.splice(i, 1); persist(); renderSets(); refreshBadgeLater(); };
      setsWrap.appendChild(row);
    });
  }
  function syncSteppers() { ['w', 'r', 's'].forEach((k) => { const el = body.querySelector(`#st-${k} .val input`); if (el) el.value = trimNum(cur[k]); }); }

  // stepper handlers
  bindStepper(body, 'w', cur, 2.5, 0, persist);
  bindStepper(body, 'r', cur, 1, 0, persist);
  bindStepper(body, 's', cur, 1, 1, persist);

  body.querySelector('#add-set').onclick = () => {
    const w = cur.w, r = cur.r, s = Math.max(1, cur.s | 0);
    const last = sets[sets.length - 1];
    if (last && last.w === w && last.r === r) last.s += s; // 同一(重量×レップ)は自動でセット数に合算
    else sets.push({ w, r, s });
    persist(); renderSets(); refreshBadgeLater();
    if (navigator.vibrate) navigator.vibrate(15);
    toast('記録しました');
  };
  const sp = body.querySelector('#same-prev');
  if (sp) sp.onclick = () => { const f = prev[0].log.sets[0]; cur.w = f.w; cur.r = f.r; cur.s = f.s; syncSteppers(); };
  const hb = body.querySelector('#hist-btn');
  if (hb) hb.onclick = () => { closeSheet(); state.tab = 'history'; state.histExerciseId = ex.id; render(); };

  renderSets();
  openSheet(ex.name, body);
}
function refreshBadgeLater() { if (state.tab === 'home') renderHomeList(); }

function stepper(cap, key, val, unit) {
  return `<div class="stepper" id="st-${key}">
    <div class="cap">${cap}${unit ? ' (' + unit + ')' : ''}</div>
    <div class="val"><input inputmode="decimal" value="${trimNum(val)}" /></div>
    <div class="btns"><button data-d="-1">−</button><button data-d="1">＋</button></div>
  </div>`;
}
function bindStepper(root, key, cur, step, min, onchange) {
  const box = root.querySelector(`#st-${key}`);
  const input = box.querySelector('.val input');
  box.querySelectorAll('.btns button').forEach((b) => {
    b.onclick = () => {
      const d = Number(b.dataset.d) * step;
      let v = (parseFloat(input.value) || 0) + d;
      if (v < min) v = min;
      v = Math.round(v * 100) / 100;
      cur[key] = v; input.value = trimNum(v);
      if (navigator.vibrate) navigator.vibrate(8);
    };
  });
  input.onchange = () => { let v = parseFloat(input.value); if (isNaN(v)) v = min; if (v < min) v = min; cur[key] = v; input.value = trimNum(v); };
  input.onfocus = () => input.select();
}

/* ---------- Exercises management ---------- */
function renderExercises() {
  const main = $('main');
  main.innerHTML = '';
  const add = h(`<div style="margin-bottom:14px">
      <div class="row2"><input id="ne-cat" class="loc" placeholder="部位（例: 胸）" style="border-radius:10px"><input id="ne-name" class="loc" placeholder="種目名" style="border-radius:10px"></div>
      <button class="ghost" id="ne-add" style="margin-top:8px">＋ 種目を追加</button>
    </div>`);
  main.appendChild(add);
  $('ne-add').onclick = async () => {
    const name = $('ne-name').value.trim(); if (!name) { toast('種目名を入力'); return; }
    await addExercise($('ne-cat').value, name); $('ne-name').value = ''; renderExercises(); toast('追加しました');
  };
  const cats = categories();
  cats.forEach((c) => {
    main.appendChild(h(`<div class="cat-head">${esc(c)}</div>`));
    DB.exercises.filter((e) => (e.category || 'その他') === c).sort(byOrder).forEach((e) => {
      const row = h(`<div class="list-manage-row"><div class="info"><div>${esc(e.name)}</div></div>
        <button class="up">↑</button><button class="edit">編集</button><button class="del">削除</button></div>`);
      row.querySelector('.up').onclick = () => moveExerciseUp(e);
      row.querySelector('.edit').onclick = () => editExercise(e);
      row.querySelector('.del').onclick = () => delExercise(e);
      main.appendChild(row);
    });
  });
  if (!DB.exercises.length) main.appendChild(h(`<div class="empty">種目がありません。上から追加、または「データ」で取り込み。</div>`));
}
async function moveExerciseUp(e) {
  const sorted = DB.exercises.slice().sort(byOrder);
  const i = sorted.findIndex((x) => x.id === e.id);
  if (i <= 0) return;
  const prev = sorted[i - 1];
  const t = e.order; e.order = prev.order; prev.order = t;
  await Promise.all([idbPut('exercises', e), idbPut('exercises', prev)]);
  renderExercises();
}
function editExercise(e) {
  const body = h(`<div>
    <div class="field"><label>部位</label><input id="ee-cat" value="${esc(e.category)}"></div>
    <div class="field"><label>種目名</label><input id="ee-name" value="${esc(e.name)}"></div>
    <button class="primary" id="ee-save">保存</button>
  </div>`);
  openSheet('種目を編集', body);
  body.querySelector('#ee-save').onclick = async () => {
    e.category = body.querySelector('#ee-cat').value.trim();
    e.name = body.querySelector('#ee-name').value.trim() || e.name;
    await idbPut('exercises', e); closeSheet(); renderExercises(); toast('保存しました');
  };
}
async function delExercise(e) {
  const n = DB.logs.filter((l) => l.exerciseId === e.id).length;
  if (!confirm(`「${e.name}」を削除しますか？${n ? `\n記録 ${n} 件も削除されます。` : ''}`)) return;
  DB.logs = DB.logs.filter((l) => l.exerciseId !== e.id);
  for (const l of DB.logs) {} // no-op
  const toDel = (await idbGetAll('logs')).filter((l) => l.exerciseId === e.id);
  await Promise.all(toDel.map((l) => idbDelete('logs', l.id)));
  DB.exercises = DB.exercises.filter((x) => x.id !== e.id);
  await idbDelete('exercises', e.id);
  renderExercises();
}

/* ---------- History ---------- */
function renderHistory() {
  const main = $('main'); main.innerHTML = '';
  const sel = h(`<div class="field"><label>種目</label><select id="hist-sel"></select></div>`);
  main.appendChild(sel);
  const s = sel.querySelector('#hist-sel');
  DB.exercises.slice().sort(byOrder).forEach((e) => {
    const o = h(`<option value="${e.id}">${esc((e.category ? e.category + ' / ' : '') + e.name)}</option>`);
    if (e.id === state.histExerciseId) o.selected = true;
    s.appendChild(o);
  });
  if (!state.histExerciseId && DB.exercises.length) state.histExerciseId = DB.exercises.slice().sort(byOrder)[0].id;
  s.onchange = () => { state.histExerciseId = s.value; renderHistory(); };
  const wrap = h(`<div id="hist-list" style="margin-top:6px"></div>`); main.appendChild(wrap);
  if (!state.histExerciseId) { wrap.innerHTML = `<div class="empty">種目がありません。</div>`; return; }
  const rows = logsOfExercise(state.histExerciseId);
  if (!rows.length) { wrap.innerHTML = `<div class="empty">この種目の記録はまだありません。</div>`; return; }
  rows.forEach((x) => {
    wrap.appendChild(h(`<div class="hist-day">
      <div class="d">${esc(fmtDateFull(x.session.date))} <span style="font-weight:400;color:var(--muted)">${esc(fmtDate(x.session.date))}</span></div>
      ${x.session.location ? `<div class="l">${esc(x.session.location)}</div>` : ''}
      <div class="s">${esc(summarizeSets(x.log.sets))}</div>
    </div>`));
  });
}

/* ---------- Data: import / export ---------- */
function renderData() {
  const main = $('main'); main.innerHTML = '';
  const stats = h(`<div class="prev-panel"><div class="label">現在のデータ</div>
    <div class="prev-line">種目 ${DB.exercises.length} · セッション ${DB.sessions.length} · 記録 ${DB.logs.length}</div></div>`);
  main.appendChild(stats);

  main.appendChild(h(`<div class="cat-head">バックアップ</div>`));
  const exp = h(`<div>
    <button class="ghost" id="exp-json" style="margin-bottom:8px">JSONで書き出し（バックアップ）</button>
    <button class="ghost" id="exp-tsv" style="margin-bottom:8px">TSVで書き出し（スプレッドシート形式）</button>
    <div class="field"><label>JSONから復元 / 取り込み（マージ）</label><input type="file" id="imp-json" accept="application/json,.json"></div>
  </div>`);
  main.appendChild(exp);
  $('exp-json').onclick = exportJSON;
  $('exp-tsv').onclick = exportTSV;
  $('imp-json').onchange = (e) => { const f = e.target.files[0]; if (f) importJSONFile(f); };

  main.appendChild(h(`<div class="cat-head">スプレッドシートから取り込み</div>`));
  const imp = h(`<div>
    <div class="field"><label>Googleスプレッドシートを TSV/CSV で書き出して貼り付け（またはファイル選択）</label>
      <textarea id="imp-text" placeholder="ここに貼り付け…"></textarea></div>
    <div class="field"><input type="file" id="imp-file" accept=".tsv,.csv,text/tab-separated-values,text/csv,text/plain"></div>
    <div class="row2">
      <div class="field"><label>部位の列 (A=1)</label><input id="imp-catcol" type="number" inputmode="numeric" value="1" min="1"></div>
      <div class="field"><label>種目名の列 (B=2)</label><input id="imp-namecol" type="number" inputmode="numeric" value="2" min="1"></div>
    </div>
    <div class="row2">
      <div class="field"><label>日付の行 (1)</label><input id="imp-daterow" type="number" inputmode="numeric" value="1" min="1"></div>
      <div class="field"><label>場所の行 (2)</label><input id="imp-locrow" type="number" inputmode="numeric" value="2" min="1"></div>
    </div>
    <div class="row2">
      <div class="field"><label>データ開始行 (3)</label><input id="imp-startrow" type="number" inputmode="numeric" value="3" min="1"></div>
      <div class="field"><label>左端(最古)列の年</label><input id="imp-year" type="number" value="${new Date().getFullYear() - 5}" inputmode="numeric"></div>
    </div>
    <button class="secondary" id="imp-preview" style="width:100%">プレビュー</button>
    <div id="imp-result"></div>
    <div class="hint">既定値はあなたの形式（A列=部位, B列=種目名, 1行目=日付, 2行目=場所, 3行目からデータ）に合わせてあります。ズレる時だけ数値を変えて再プレビュー。<br>
      見出しが日付でも中身が種目名の列は日付列から自動除外します（種目名列に日付が混ざっても誤爆しません）。<br>
      年は列に書かれていないため、左端(最古)列の年を起点に、月がリセットされるたびに翌年へ繰り上げて推定します。<b>プレビューの「種目名の例」と期間を必ず確認</b>してから取り込んでください。</div>
  </div>`);
  main.appendChild(imp);
  $('imp-file').onchange = (e) => { const f = e.target.files[0]; if (f) f.text().then((t) => { $('imp-text').value = t; toast('読み込みました。プレビューを押してください'); }); };
  $('imp-preview').onclick = () => previewGridImport();

  main.appendChild(h(`<div class="cat-head" style="color:var(--danger)">危険な操作</div>`));
  const dz = h(`<button class="secondary" id="wipe" style="color:var(--danger);border-color:var(--danger);width:100%">全データを削除</button>`);
  main.appendChild(dz);
  $('wipe').onclick = async () => {
    if (!confirm('本当に全データを削除しますか？先にJSONバックアップを取ることを推奨します。')) return;
    if (!confirm('取り消せません。削除を実行しますか？')) return;
    await Promise.all([idbClear('exercises'), idbClear('sessions'), idbClear('logs')]);
    DB.exercises = []; DB.sessions = []; DB.logs = []; renderData(); toast('削除しました');
  };
}

function download(filename, text, type) {
  const blob = new Blob([text], { type: type || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 500);
}
function exportJSON() {
  const data = { app: 'training-log', version: 1, exportedAt: new Date().toISOString(), exercises: DB.exercises, sessions: DB.sessions, logs: DB.logs };
  download(`training-log-backup-${todayStr()}.json`, JSON.stringify(data), 'application/json');
  toast('JSONを書き出しました');
}
function exportTSV() {
  // 種目(行) × セッション(列) の wide 形式で再構成
  const sessions = DB.sessions.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const exs = DB.exercises.slice().sort(byOrder);
  const rows = [];
  rows.push(['', ''].concat(sessions.map((s) => fmtDate(s.date))));
  rows.push(['', 'kg,rep,set'].concat(sessions.map((s) => s.location || '')));
  exs.forEach((e) => {
    const row = [e.category || '', e.name];
    sessions.forEach((s) => {
      const l = logFor(e.id, s.id);
      row.push(l && l.sets.length ? l.sets.map((st) => `${trimNum(st.w)},${st.r},${st.s}`).join('\n') : '');
    });
    rows.push(row);
  });
  const tsv = rows.map((r) => r.map(tsvCell).join('\t')).join('\n');
  download(`training-log-${todayStr()}.tsv`, tsv, 'text/tab-separated-values');
  toast('TSVを書き出しました');
}
function tsvCell(v) { v = String(v == null ? '' : v); return /[\t\n"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

async function importJSONFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.exercises)) { toast('形式が不正です'); return; }
    if (!confirm(`このバックアップをマージしますか？\n種目 ${data.exercises.length} / セッション ${(data.sessions || []).length} / 記録 ${(data.logs || []).length}`)) return;
    // マージ: 種目は名前、セッションは(日付,場所)で突き合わせ。ID衝突を避けて再マッピング。
    const exMap = {};
    for (const e of data.exercises) {
      let cur = findExerciseByName(e.name);
      if (!cur) cur = await addExercise(e.category, e.name);
      exMap[e.id] = cur.id;
    }
    const seMap = {};
    for (const s of (data.sessions || [])) { const cur = await getOrCreateSession(s.date, s.location || ''); seMap[s.id] = cur.id; }
    for (const l of (data.logs || [])) {
      const eid = exMap[l.exerciseId], sid = seMap[l.sessionId];
      if (!eid || !sid || !Array.isArray(l.sets)) continue;
      await saveLog(eid, sid, l.sets.map((s) => ({ w: +s.w, r: +s.r, s: +s.s || 1 })));
    }
    toast('取り込みました'); render();
  } catch (err) { toast('読み込み失敗: ' + err.message); }
}

/* ---------- Grid (spreadsheet) import ---------- */
function parseDelimited(text) {
  const delim = (text.split('\n')[0].includes('\t')) ? '\t' : ',';
  const rows = []; let row = [], field = '', i = 0, inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  row.push(field); rows.push(row);
  // 末尾の空行を除去
  while (rows.length && rows[rows.length - 1].every((x) => (x || '').trim() === '')) rows.pop();
  return rows;
}
const DATE_RE = /(\d{1,2})\s*[\/月.\-]\s*(\d{1,2})/;
function parseSetCell(cell) {
  if (!cell) return [];
  return cell.split(/[\n\r]+/).map((line) => {
    const m = line.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+)/);
    if (!m) return null;
    return { w: parseFloat(m[1]), r: parseFloat(m[2]), s: parseInt(m[3], 10) || 1 };
  }).filter(Boolean);
}

function isSetCellText(s) { return /^\s*-?\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+/.test((s || '').split(/[\n\r]+/)[0] || ''); }
let _pendingImport = null;
function previewGridImport() {
  const text = $('imp-text').value;
  const resultEl = $('imp-result'); resultEl.innerHTML = '';
  if (!text.trim()) { toast('データを貼り付けてください'); return; }
  const grid = parseDelimited(text);
  if (grid.length < 2) { toast('行が足りません'); return; }

  // 手動指定（1始まり）→ 0始まりへ。未入力/不正は自動フォールバック。
  const to0 = (id, dflt) => { const v = parseInt(($(id) || {}).value, 10); return Number.isFinite(v) && v >= 1 ? v - 1 : dflt; };
  const dateRowIdx = to0('imp-daterow', 0);
  const locRowIdx = to0('imp-locrow', dateRowIdx + 1);
  const dataStart = to0('imp-startrow', locRowIdx + 1);
  const catCol = to0('imp-catcol', -1);
  const nameCol = to0('imp-namecol', 0);
  if (nameCol === catCol) { resultEl.innerHTML = `<div class="hint" style="color:var(--danger)">部位の列と種目名の列が同じです。別々にしてください。</div>`; return; }
  const dateRow = grid[dateRowIdx] || [];
  const locRow = grid[locRowIdx] || [];

  // セッション列 = 見出しが日付 かつ ラベル列(部位/種目名)ではない。
  // さらに、データ部が「文字だけ（種目名）」の列は見出しが日付でも除外（誤爆防止）。
  const dataCols = [];
  for (let c = 0; c < dateRow.length; c++) {
    if (c === catCol || c === nameCol) continue;
    const m = (dateRow[c] || '').match(DATE_RE);
    if (!m) continue;
    let setLike = 0, textLike = 0;
    for (let r = dataStart; r < grid.length; r++) {
      const cell = (grid[r] && grid[r][c] || '').trim(); if (!cell) continue;
      if (isSetCellText(cell)) setLike++; else textLike++;
    }
    if (textLike > setLike && setLike === 0) continue; // 中身が種目名などの列は日付列にしない
    dataCols.push({ col: c, m: [parseInt(m[1], 10), parseInt(m[2], 10)] });
  }
  if (!dataCols.length) { resultEl.innerHTML = `<div class="hint" style="color:var(--danger)">日付列を検出できませんでした。「日付の行」が正しいか、1行目に 7/2(木) のような日付が並んでいるか確認してください。</div>`; return; }

  // 年推定: 左端(最古)の年から、月がリセット(m<前のm)するたびに+1
  let year = parseInt($('imp-year').value, 10) || (new Date().getFullYear() - 5);
  let prevM = -1;
  const colDate = {};
  dataCols.forEach((dc) => { const [m, d] = dc.m; if (prevM !== -1 && m < prevM) year++; prevM = m; colDate[dc.col] = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; });

  // 集計。部位(カテゴリ)は結合セル対策で空欄なら直前の値を継承（前方補完）。
  const exNames = []; const catByName = {}; let logCount = 0, setCount = 0;
  const parsed = { sessions: [], entries: [] };
  dataCols.forEach((dc) => parsed.sessions.push({ col: dc.col, date: colDate[dc.col], location: (locRow[dc.col] || '').trim() }));
  let lastCat = '';
  for (let r = dataStart; r < grid.length; r++) {
    const row = grid[r] || [];
    const rawCat = catCol >= 0 ? (row[catCol] || '').trim() : '';
    if (rawCat) lastCat = rawCat;
    const cat = rawCat || lastCat;
    const name = (row[nameCol] || '').trim(); if (!name) continue;
    if (!(name in catByName)) { exNames.push(name); catByName[name] = cat; }
    dataCols.forEach((dc) => {
      const sets = parseSetCell(row[dc.col] || '');
      if (sets.length) { parsed.entries.push({ name, cat: catByName[name] || cat, date: colDate[dc.col], location: (locRow[dc.col] || '').trim(), sets }); logCount++; setCount += totalSetCount(sets); }
    });
  }
  const dates = parsed.sessions.map((s) => s.date).sort();
  const catCount = new Set(exNames.map((n) => catByName[n] || 'その他')).size;
  const sample = exNames.slice(0, 8).map((n) => `${catByName[n] || 'その他'} / ${n}`);
  _pendingImport = parsed;
  resultEl.innerHTML = '';
  resultEl.appendChild(h(`<div class="prev-panel">
    <div class="label">プレビュー（取り込む前に確認）</div>
    <div class="prev-line">種目: ${exNames.length}　部位: ${catCount}</div>
    <div class="prev-line">日付列: ${dataCols.length}　記録: ${logCount}（合計 ${setCount} セット）</div>
    <div class="prev-line">期間: ${dates.length ? fmtDateFull(dates[0]) + ' 〜 ' + fmtDateFull(dates[dates.length - 1]) : '-'}</div>
    <div class="label" style="margin-top:8px">種目名の例（部位 / 種目名）</div>
    ${sample.map((s) => `<div class="prev-line">${esc(s)}</div>`).join('') || '<div class="prev-line">-</div>'}
  </div>`));
  const badName = exNames.length <= 12 && exNames.every((n) => n.length <= 2);
  if (badName) resultEl.appendChild(h(`<div class="hint" style="color:var(--danger)">種目名が部位名(胸/背 等)ばかりのようです。列指定が逆かも。「部位の列」「種目名の列」を確認して再プレビューしてください。</div>`));
  if (dates.length && (dates[0] < '1990' || dates[dates.length - 1] > String(new Date().getFullYear() + 1))) {
    resultEl.appendChild(h(`<div class="hint" style="color:var(--danger)">期間が不自然です。左端列の年を調整して再プレビューしてください。</div>`));
  }
  const btn = h(`<button class="primary" id="imp-commit" style="width:100%;margin-top:8px">この内容で取り込む</button>`);
  resultEl.appendChild(btn);
  btn.onclick = commitGridImport;
}
async function commitGridImport() {
  if (!_pendingImport) return;
  const btn = $('imp-commit'); if (btn) { btn.disabled = true; btn.textContent = '取り込み中…'; }
  const p = _pendingImport;
  try {
    // 種目
    const exByName = {};
    // 元の並び順を維持するため entries 出現順で種目を作成
    const seen = [];
    for (const e of p.entries) if (!seen.includes(e.name)) seen.push(e.name);
    for (const s of p.sessions) { /* セッション作成 */ }
    for (const name of seen) {
      let cur = findExerciseByName(name);
      if (!cur) { const cat = (p.entries.find((x) => x.name === name) || {}).cat || ''; cur = await addExercise(cat, name); }
      exByName[name] = cur;
    }
    // セッション
    const sesByKey = {};
    for (const s of p.sessions) { const cur = await getOrCreateSession(s.date, s.location); sesByKey[sessionKey(s.date, s.location)] = cur; }
    // 記録（同一種目×セッションはマージせず置換：同じ列に複数値は無い前提）
    for (const e of p.entries) {
      const ex = exByName[e.name] || await addExercise(e.cat, e.name);
      const ses = sesByKey[sessionKey(e.date, e.location)] || await getOrCreateSession(e.date, e.location);
      const existing = logFor(ex.id, ses.id);
      const merged = existing ? existing.sets.concat(e.sets) : e.sets;
      await saveLog(ex.id, ses.id, merged);
    }
    _pendingImport = null;
    toast('取り込み完了');
    state.tab = 'home'; render();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'この内容で取り込む'; }
    toast('取り込み失敗: ' + err.message);
  }
}

/* ---------- Nav ---------- */
function renderNav() {
  const nav = $('nav');
  const items = [
    ['home', '📋', '記録'],
    ['history', '📈', '履歴'],
    ['exercises', '🏋️', '種目'],
    ['data', '💾', 'データ'],
  ];
  nav.innerHTML = '';
  items.forEach(([key, ico, label]) => {
    const b = h(`<button class="${state.tab === key ? 'active' : ''}"><span class="ico">${ico}</span><span>${label}</span></button>`);
    b.onclick = () => { state.tab = key; render(); };
    nav.appendChild(b);
  });
}

/* ---------- Boot ---------- */
$('sheet-close').onclick = closeSheet;
$('sheet-backdrop').onclick = (e) => { if (e.target === $('sheet-backdrop')) closeSheet(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheet.open) closeSheet(); });

(async function boot() {
  try {
    _db = await openDB();
    await loadAll();
    state.location = await metaGet('lastLocation', '');
  } catch (err) {
    document.getElementById('main').innerHTML = '<div class="empty">起動に失敗しました: ' + esc(err.message) + '</div>';
    return;
  }
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
