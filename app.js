import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.APP_CONFIG;
const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

// 진행중(초록)/지연(빨강)/완료(회색) 상태 색상과 헷갈릴 수 있는 팔레트 색은 선택지에서 제외합니다.
const STATUS_LIKE_COLORS = new Set(["#16a34a", "#15803d", "#dc2626", "#65a30d", "#b91c1c", "#059669", "#475569", "#e11d48"]);
const PALETTE = Array.from({ length: 30 }, (_, i) => getComputedStyle(document.documentElement).getPropertyValue(`--p${i + 1}`).trim())
  .filter(c => !STATUS_LIKE_COLORS.has(c.toLowerCase()));
const STATUS_LABEL = { todo: "예정", doing: "진행중", done: "완료" };
const DAYPX = 20;

let state = { project: null, tasks: [], editMode: false };
let saveTimers = new Map();

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function fmtDate(d) {
  if (!d) return "";
  return d;
}
function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

// ---------- project-level status (예정 / 지연 / 진행중 / 완료) ----------
function deriveProjectStatusFromMinStart(status, minStart) {
  if (status === "doing") return { key: "doing", label: "진행중" };
  if (status === "done") return { key: "done", label: "완료" };
  if (!minStart) return { key: "todo", label: "예정" };
  const today = new Date().toISOString().slice(0, 10);
  if (minStart < today) return { key: "delayed", label: "지연" };
  return { key: "todo", label: "예정" };
}
function deriveProjectStatus(status, tasks) {
  const dated = (tasks || []).filter(t => t.start_date);
  const minStart = dated.length ? dated.reduce((m, t) => t.start_date < m ? t.start_date : m, dated[0].start_date) : null;
  return deriveProjectStatusFromMinStart(status, minStart);
}

// ---------- task-level status (예정 / 지연 / 진행중 / 완료) ----------
function deriveTaskStatus(t) {
  if (t.status === "doing") return { key: "doing", label: "진행중" };
  if (t.status === "done") return { key: "done", label: "완료" };
  if (t.start_date) {
    const today = new Date().toISOString().slice(0, 10);
    if (t.start_date < today) return { key: "delayed", label: "지연" };
  }
  return { key: "todo", label: "예정" };
}

// ---------- entry (no password gate: anyone with the link can edit) ----------
function getProjectIdFromUrl() {
  return new URLSearchParams(location.search).get("p");
}

async function initGate() {
  const pid = getProjectIdFromUrl();
  try {
    if (pid) {
      await enterProject(pid);
    } else {
      await enterLanding();
    }
  } catch (e) {
    console.error(e);
    $("#loadingVeil").textContent = "불러오는 중 오류가 발생했습니다: " + (e?.message || e);
    return;
  }
  $("#loadingVeil").hidden = true;
}

// ---------- usage tracking ----------
function logPageView(page, projectId) {
  supabase.from("page_views").insert({ page, project_id: projectId || null }).then(() => {}, () => {});
}

// ---------- landing (project list) ----------
let landingProjects = [];
let landingProgress = {};
let selectedProjectIds = new Set();

async function enterLanding() {
  logPageView("landing", null);
  const { data, error } = await supabase.from("projects").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  landingProjects = data || [];
  await loadLandingProgress();
  renderLanding();
  wireLandingUI();
  $("#landing").hidden = false;
}
async function loadLandingProgress() {
  const { data, error } = await supabase.from("tasks").select("project_id, status, start_date");
  if (error) { console.error(error); landingProgress = {}; return; }
  const stats = {};
  (data || []).forEach(t => {
    if (!stats[t.project_id]) stats[t.project_id] = { total: 0, done: 0, minStart: null };
    const s = stats[t.project_id];
    s.total += 1;
    if (t.status === "done") s.done += 1;
    if (t.start_date && (!s.minStart || t.start_date < s.minStart)) s.minStart = t.start_date;
  });
  landingProgress = stats;
}
function renderLanding() {
  const list = $("#projectList");
  if (!landingProjects.length) {
    list.innerHTML = `<div class="empty-note">아직 만들어진 프로젝트가 없습니다. 아래에서 새로 만들어보세요.</div>`;
  } else {
    list.innerHTML = landingProjects.map(p => {
      const prog = landingProgress[p.id];
      const total = prog ? prog.total : 0;
      const done = prog ? prog.done : 0;
      const pct = total ? Math.round(done / total * 100) : 0;
      const st = deriveProjectStatusFromMinStart(p.status || "todo", prog ? prog.minStart : null);
      return `
      <div class="project-card" data-id="${p.id}">
        <label class="pc-check"><input type="checkbox" class="pc-checkbox" data-id="${p.id}" ${selectedProjectIds.has(p.id) ? "checked" : ""}></label>
        <a class="pc-body" href="?p=${p.id}">
          <div class="pc-eyebrow">${escapeHtml(p.org || "")}${p.dept ? " / " + escapeHtml(p.dept) : ""}${p.pm ? " / PM " + escapeHtml(p.pm) : ""}</div>
          <div class="pc-name">${escapeHtml(p.name || "(제목 없음)")} 추진일정</div>
          <div class="pc-meta">생성일 ${p.created_at ? p.created_at.slice(0, 10) : ""} · <span class="proj-status-badge ${st.key}">${st.label}</span> · <span class="pc-mode ${p.mode === "edit" ? "edit" : ""}">${p.mode === "edit" ? "✏️ 편집 가능" : "🔒 보기 전용"}</span></div>
          <div class="pc-progress">
            <div class="pc-progress-bar"><div class="pc-progress-fill" style="width:${pct}%"></div></div>
            <span class="pc-progress-label">${total ? `${pct}% (${done}/${total})` : "업무 없음"}</span>
          </div>
        </a>
        <button type="button" class="pc-del" data-id="${p.id}" aria-label="삭제">✕</button>
      </div>
    `;
    }).join("");
  }
  list.querySelectorAll(".pc-checkbox").forEach(cb => {
    cb.addEventListener("change", () => {
      if (cb.checked) selectedProjectIds.add(cb.dataset.id);
      else selectedProjectIds.delete(cb.dataset.id);
      updateBulkBar();
    });
  });
  list.querySelectorAll(".pc-del").forEach(btn => {
    btn.addEventListener("click", () => deleteProjects([btn.dataset.id]));
  });
  updateBulkBar();
}
function updateBulkBar() {
  const bar = $("#bulkBar");
  if (selectedProjectIds.size > 0) {
    bar.hidden = false;
    $("#bulkCount").textContent = `${selectedProjectIds.size}개 선택됨`;
  } else {
    bar.hidden = true;
  }
}
async function deleteProjects(ids) {
  const names = landingProjects.filter(p => ids.includes(p.id)).map(p => p.name || "(제목 없음)").join(", ");
  const ok = confirm(`${ids.length}개 프로젝트를 삭제할까요?\n(${names})\n\n포함된 모든 업무 데이터도 함께 삭제되며 되돌릴 수 없습니다.`);
  if (!ok) return;
  const { error } = await supabase.from("projects").delete().in("id", ids);
  if (error) { console.error(error); alert("삭제 중 오류가 발생했습니다: " + error.message); return; }
  landingProjects = landingProjects.filter(p => !ids.includes(p.id));
  ids.forEach(id => selectedProjectIds.delete(id));
  renderLanding();
}
function wireLandingUI() {
  $("#bulkDeleteBtn").addEventListener("click", () => deleteProjects([...selectedProjectIds]));
  $("#bulkClearBtn").addEventListener("click", () => { selectedProjectIds.clear(); renderLanding(); });
  $("#newProjectBtn").addEventListener("click", async () => {
    const org = $("#newOrgInput").value.trim();
    const dept = $("#newDeptInput").value.trim();
    const pm = $("#newPmInput").value.trim();
    const name = $("#newNameInput").value.trim();
    if (!name) { $("#newNameInput").focus(); return; }
    const { data, error } = await supabase.from("projects").insert({ org, dept, pm, name, mode: "view", status: "todo" }).select().single();
    if (error) { console.error(error); return; }
    location.href = "?p=" + data.id;
  });
}

// ---------- project detail ----------
async function enterProject(projectId) {
  await loadProject(projectId);
  if (!state.project) { location.href = "./"; return; }
  logPageView("project", projectId);
  await loadTasks();
  state.editMode = state.project.mode === "edit";
  $("#app").hidden = false;
  renderAll();
  wireStaticUI();
  wireModeToggle();
  subscribeRealtime();
}

function renderModeBadge() {
  const badge = $("#modeBadge");
  badge.textContent = state.editMode ? "✏️ 편집 가능" : "🔒 보기 전용";
  badge.classList.toggle("edit", state.editMode);
}
function wireModeToggle() {
  renderModeBadge();
  $("#modeToggleBtn").textContent = state.editMode ? "보기 전용으로 잠그기" : "편집 모드로 전환";
  $("#modeToggleBtn").onclick = async () => {
    const newMode = state.editMode ? "view" : "edit";
    state.editMode = newMode === "edit";
    state.project.mode = newMode;
    renderModeBadge();
    $("#modeToggleBtn").textContent = state.editMode ? "보기 전용으로 잠그기" : "편집 모드로 전환";
    renderAll();
    await supabase.from("projects").update({ mode: newMode }).eq("id", state.project.id);
  };
}

async function loadProject(projectId) {
  const { data, error } = await supabase.from("projects").select("*").eq("id", projectId).maybeSingle();
  if (error) { console.error(error); return; }
  state.project = data || null;
}
async function loadTasks() {
  if (!state.project) return;
  const { data, error } = await supabase.from("tasks").select("*").eq("project_id", state.project.id).order("sort_order", { ascending: true });
  if (error) { console.error(error); return; }
  state.tasks = data || [];
}

function subscribeRealtime() {
  if (!state.project) return;
  supabase.channel("tasks-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `project_id=eq.${state.project.id}` }, (payload) => {
      applyRemoteTaskChange(payload);
    })
    .subscribe();
  supabase.channel("project-changes")
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "projects", filter: `id=eq.${state.project.id}` }, (payload) => {
      state.project = { ...state.project, ...payload.new };
      renderHeader();
    })
    .subscribe();
}
function applyRemoteTaskChange(payload) {
  if (payload.eventType === "INSERT") {
    if (!state.tasks.find(t => t.id === payload.new.id)) state.tasks.push(payload.new);
  } else if (payload.eventType === "UPDATE") {
    const i = state.tasks.findIndex(t => t.id === payload.new.id);
    if (i >= 0) state.tasks[i] = payload.new;
  } else if (payload.eventType === "DELETE") {
    state.tasks = state.tasks.filter(t => t.id !== payload.old.id);
  }
  state.tasks.sort((a, b) => a.sort_order - b.sort_order);
  renderAll();
}

// ---------- save helpers ----------
function showSaving() {
  $("#savingDot").hidden = false;
  clearTimeout(showSaving._t);
  showSaving._t = setTimeout(() => { $("#savingDot").hidden = true; }, 900);
}
function debounceSave(key, fn, delay = 500) {
  if (saveTimers.has(key)) clearTimeout(saveTimers.get(key));
  saveTimers.set(key, setTimeout(async () => { await fn(); showSaving(); }, delay));
}
async function updateProjectField(field, value) {
  state.project[field] = value;
  debounceSave("project", async () => {
    await supabase.from("projects").update({ [field]: value }).eq("id", state.project.id);
  });
}
async function updateTaskField(id, field, value) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  t[field] = value;
  debounceSave("task-" + id, async () => {
    await supabase.from("tasks").update({ [field]: value, updated_at: new Date().toISOString() }).eq("id", id);
  });
}
async function addTask() {
  const maxOrder = state.tasks.reduce((m, t) => Math.max(m, t.sort_order), 0);
  const row = {
    project_id: state.project.id, phase_name: "구분", phase_color: PALETTE[state.tasks.length % PALETTE.length],
    name: "", owner: "", status: "todo", sort_order: maxOrder + 1
  };
  const { data, error } = await supabase.from("tasks").insert(row).select().single();
  if (error) { console.error(error); return; }
  state.tasks.push(data);
  renderAll();
}
async function deleteTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  renderAll();
  await supabase.from("tasks").delete().eq("id", id);
}
async function persistOrder() {
  state.tasks.forEach((t, i) => { t.sort_order = i; });
  renderAll();
  showSaving();
  await Promise.all(state.tasks.map((t, i) => supabase.from("tasks").update({ sort_order: i }).eq("id", t.id)));
}
function moveTask(id, dir) {
  const i = state.tasks.findIndex(t => t.id === id);
  const j = i + dir;
  if (j < 0 || j >= state.tasks.length) return;
  [state.tasks[i], state.tasks[j]] = [state.tasks[j], state.tasks[i]];
  persistOrder();
}

// ---------- render ----------
function renderAll() {
  renderHeader();
  renderStats();
  renderLegend();
  renderTable();
  renderGantt();
  renderCards();
}
function refreshTaskDerivedViews() {
  renderStats();
  renderTable();
  renderGantt();
  renderCards();
}
function renderHeader() {
  const p = state.project;
  if (!p) return;
  $("#orgInput").value = p.org || "";
  $("#deptInput").value = p.dept || "";
  $("#pmInput").value = p.pm || "";
  $("#projNameInput").value = p.name || "";
  const disabled = !state.editMode;
  $("#orgInput").disabled = disabled;
  $("#deptInput").disabled = disabled;
  $("#pmInput").disabled = disabled;
  $("#projNameInput").disabled = disabled;
  const st = deriveProjectStatus(p.status || "todo", state.tasks);
  const badge = $("#statusBadge");
  badge.textContent = st.label;
  badge.className = "proj-status-badge " + st.key;
  $("#statusSelect").value = p.status || "todo";
  $("#statusSelect").disabled = disabled;
}
function renderStats() {
  const total = state.tasks.length;
  const done = state.tasks.filter(t => t.status === "done").length;
  const doing = state.tasks.filter(t => t.status === "doing").length;
  $("#stats").innerHTML = `
    <div class="stat-chip">전체 <b>${total}</b></div>
    <div class="stat-chip">완료 <b>${done}</b></div>
    <div class="stat-chip">진행중 <b>${doing}</b></div>
    <div class="stat-chip">진행률 <b>${total ? Math.round(done / total * 100) : 0}%</b></div>
  `;
}
function renderLegend() {
  const phases = [...new Map(state.tasks.map(t => [t.phase_name, t.phase_color])).entries()];
  const html = phases.map(([name, color]) => `<span class="legend-chip" style="background:${color}">${escapeHtml(name || "구분")}</span>`).join("");
  $("#legendDesktop").innerHTML = html;
  $("#legendMobile").innerHTML = html;
}
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderTable() {
  const tbody = $("#taskTbody");
  const dis = !state.editMode ? "disabled" : "";
  tbody.innerHTML = state.tasks.map((t, idx) => {
    const ts = deriveTaskStatus(t);
    return `
    <tr draggable="${state.editMode}" data-id="${t.id}">
      <td class="col-drag"><span class="drag-handle">⠿</span></td>
      <td class="col-color"><button type="button" class="color-swatch-btn" style="background:${t.phase_color}" data-action="color" data-id="${t.id}" title="클릭하면 색상을 바꿀 수 있어요" ${dis}></button></td>
      <td class="col-phase"><span class="phase-pill" style="background:${t.phase_color}">
        <input value="${escapeHtml(t.phase_name)}" data-field="phase_name" data-id="${t.id}" ${dis}>
      </span></td>
      <td><input value="${escapeHtml(t.name)}" data-field="name" data-id="${t.id}" ${dis} placeholder="업무명"></td>
      <td class="col-taskstatus"><span class="task-status-badge ${ts.key}">${ts.label}</span></td>
      <td><input value="${escapeHtml(t.owner)}" data-field="owner" data-id="${t.id}" ${dis} placeholder="담당자"></td>
      <td><input type="date" value="${t.start_date || ""}" data-field="start_date" data-id="${t.id}" ${dis}></td>
      <td><input type="date" value="${t.end_date || ""}" data-field="end_date" data-id="${t.id}" ${dis}></td>
      <td><input value="${escapeHtml(t.dependency)}" data-field="dependency" data-id="${t.id}" ${dis} placeholder="-"></td>
      <td><select class="status-select" data-status="${t.status}" data-field="status" data-id="${t.id}" ${dis}>
        <option value="todo" ${t.status === "todo" ? "selected" : ""}>예정</option>
        <option value="doing" ${t.status === "doing" ? "selected" : ""}>진행중</option>
        <option value="done" ${t.status === "done" ? "selected" : ""}>완료</option>
      </select></td>
      <td><input value="${escapeHtml(t.note)}" data-field="note" data-id="${t.id}" ${dis} placeholder="-"></td>
      <td class="col-del">${state.editMode ? `<button class="del-btn" data-action="del" data-id="${t.id}">✕</button>` : ""}</td>
    </tr>
  `;
  }).join("");

  tbody.querySelectorAll("input,select").forEach(el => {
    el.addEventListener("change", () => {
      updateTaskField(el.dataset.id, el.dataset.field, el.value);
      if (["status", "start_date", "end_date"].includes(el.dataset.field)) refreshTaskDerivedViews();
    });
    if (el.dataset.field === "status") {
      el.addEventListener("change", () => { el.dataset.status = el.value; });
    }
  });
  tbody.querySelectorAll('[data-action="del"]').forEach(el => el.addEventListener("click", () => deleteTask(el.dataset.id)));
  tbody.querySelectorAll('[data-action="color"]').forEach(el => el.addEventListener("click", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (state.editMode) openColorPicker(el, el.dataset.id);
  }));
  wireDragReorder(tbody);
}

function wireDragReorder(tbody) {
  let dragEl = null;
  tbody.querySelectorAll("tr").forEach(row => {
    row.addEventListener("dragstart", () => { dragEl = row; row.classList.add("dragging"); });
    row.addEventListener("dragend", () => { row.classList.remove("dragging"); dragEl = null; });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!dragEl || dragEl === row) return;
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      row.parentNode.insertBefore(dragEl, before ? row : row.nextSibling);
    });
    row.addEventListener("drop", () => {
      const ids = Array.from(tbody.querySelectorAll("tr")).map(r => r.dataset.id);
      state.tasks.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      persistOrder();
    });
  });
}

function renderGantt() {
  const wrap = $("#gantt");
  if (!state.tasks.length) { wrap.innerHTML = `<div style="color:var(--ink-muted);font-size:12px;padding:10px;">일정을 추가하면 타임라인이 표시됩니다.</div>`; return; }
  wrap.innerHTML = buildGanttHtml(state.tasks, DAYPX);
}
const GANTT_LABEL_W = 160;
function buildGanttMonthSegments(minDate, totalDays) {
  const segments = [];
  let cur = new Date(minDate);
  const rangeEnd = new Date(minDate);
  rangeEnd.setDate(rangeEnd.getDate() + totalDays - 1);
  while (cur <= rangeEnd) {
    const y = cur.getFullYear(), m = cur.getMonth();
    const monthLastDay = new Date(y, m + 1, 0);
    const segEnd = monthLastDay < rangeEnd ? monthLastDay : rangeEnd;
    const lengthDays = daysBetween(cur, segEnd) + 1;
    segments.push({ label: `${y}년 ${m + 1}월`, days: lengthDays });
    cur = new Date(segEnd);
    cur.setDate(cur.getDate() + 1);
  }
  return segments;
}
function buildGanttHtml(tasks, daypx) {
  const dated = tasks.filter(t => t.start_date && t.end_date);
  if (!dated.length) return `<div style="color:var(--ink-muted);font-size:12px;padding:10px;">시작일/종료일을 입력하면 타임라인이 표시됩니다.</div>`;
  const minDate = dated.reduce((m, t) => t.start_date < m ? t.start_date : m, dated[0].start_date);
  const maxDate = dated.reduce((m, t) => t.end_date > m ? t.end_date : m, dated[0].end_date);
  const totalDays = Math.max(1, daysBetween(minDate, maxDate) + 1);
  const trackWidth = totalDays * daypx;
  const rowWidth = GANTT_LABEL_W + trackWidth;

  const monthSegments = buildGanttMonthSegments(minDate, totalDays);
  let html = `<div class="gantt-month-row" style="width:${rowWidth}px">
    <div class="gantt-spacer"></div>
    <div class="gantt-month-track" style="width:${trackWidth}px">
      ${monthSegments.map(s => `<span style="width:${s.days * daypx}px">${s.label}</span>`).join("")}
    </div>
  </div>`;

  const rulerCols = [];
  for (let i = 0; i <= totalDays; i += 7) rulerCols.push(i);
  html += `<div class="gantt-ruler" style="width:${rowWidth}px">
    <div class="gantt-spacer"></div>
    <div class="gantt-ruler-track" style="width:${trackWidth}px">
      ${rulerCols.map(d => {
        const dt = new Date(minDate); dt.setDate(dt.getDate() + d);
        return `<span style="width:${7 * daypx}px;flex:none">${dt.getMonth() + 1}/${dt.getDate()}</span>`;
      }).join("")}
    </div>
  </div>`;

  tasks.forEach(t => {
    if (!t.start_date || !t.end_date) return;
    const off = daysBetween(minDate, t.start_date);
    const len = Math.max(1, daysBetween(t.start_date, t.end_date) + 1);
    const ts = deriveTaskStatus(t);
    let barColor = t.phase_color;
    if (ts.key === "delayed") barColor = "var(--critical)";
    else if (ts.key === "done") barColor = "var(--ink-muted)";
    const barLeft = off * daypx;
    const barWidth = len * daypx - 3;
    const labelHtml = ts.key === "todo" ? "" : `<span class="gantt-bar-label">${ts.label}</span>`;
    html += `<div class="gantt-row" style="grid-template-columns:${GANTT_LABEL_W}px 1fr;width:${rowWidth}px">
      <div class="gantt-row-label">
        <div class="gantt-row-phase"><span class="gantt-row-phase-dot" style="background:${t.phase_color}"></span>${escapeHtml(t.phase_name || "구분")}</div>
        <div class="gantt-row-name">${escapeHtml(t.name || "(제목 없음)")}</div>
      </div>
      <div class="gantt-track" style="width:${trackWidth}px">
        <div class="gantt-bar ${ts.key}" style="left:${barLeft}px;width:${barWidth}px;background:${barColor}" title="${escapeHtml(t.name)}">${labelHtml}</div>
      </div>
    </div>`;
  });

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayOffsetDays = daysBetween(minDate, todayStr);
  if (todayOffsetDays >= 0 && todayOffsetDays <= totalDays) {
    const todayLeft = GANTT_LABEL_W + todayOffsetDays * daypx;
    html += `<div class="gantt-today-line" style="left:${todayLeft}px"><span class="gantt-today-label">오늘</span></div>`;
  }
  return html;
}

function renderCards() {
  const list = $("#cardList");
  const dis = !state.editMode ? "disabled" : "";
  list.innerHTML = state.tasks.map((t, idx) => {
    const ts = deriveTaskStatus(t);
    return `
    <div class="task-card" data-id="${t.id}">
      <div class="card-top">
        <span class="phase-pill" style="background:${t.phase_color}" data-action="color" data-id="${t.id}" title="클릭하면 색상을 바꿀 수 있어요">
          <input value="${escapeHtml(t.phase_name)}" data-field="phase_name" data-id="${t.id}" ${dis}>
        </span>
        <span class="task-status-badge ${ts.key}">${ts.label}</span>
        ${state.editMode ? `<div class="move-btns">
          <button class="icon-btn" data-action="up" data-id="${t.id}" ${idx === 0 ? "disabled" : ""}>▲</button>
          <button class="icon-btn" data-action="down" data-id="${t.id}" ${idx === state.tasks.length - 1 ? "disabled" : ""}>▼</button>
          <button class="icon-btn" data-action="del" data-id="${t.id}">✕</button>
        </div>` : ""}
      </div>
      <input class="card-name-input" value="${escapeHtml(t.name)}" data-field="name" data-id="${t.id}" ${dis} placeholder="업무명">
      <div class="card-row">
        <div class="card-field"><label>담당자</label><input value="${escapeHtml(t.owner)}" data-field="owner" data-id="${t.id}" ${dis}></div>
        <div class="card-field"><label>상태</label><select data-field="status" data-id="${t.id}" ${dis}>
          <option value="todo" ${t.status === "todo" ? "selected" : ""}>예정</option>
          <option value="doing" ${t.status === "doing" ? "selected" : ""}>진행중</option>
          <option value="done" ${t.status === "done" ? "selected" : ""}>완료</option>
        </select></div>
      </div>
      <div class="card-row">
        <div class="card-field"><label>시작일</label><input type="date" value="${t.start_date || ""}" data-field="start_date" data-id="${t.id}" ${dis}></div>
        <div class="card-field"><label>종료일</label><input type="date" value="${t.end_date || ""}" data-field="end_date" data-id="${t.id}" ${dis}></div>
      </div>
      <div class="card-row">
        <div class="card-field"><label>선행업무</label><input value="${escapeHtml(t.dependency)}" data-field="dependency" data-id="${t.id}" ${dis}></div>
      </div>
      <div class="card-row">
        <div class="card-field"><label>비고</label><input value="${escapeHtml(t.note)}" data-field="note" data-id="${t.id}" ${dis}></div>
      </div>
    </div>
  `;
  }).join("");

  list.querySelectorAll("input,select").forEach(el => {
    el.addEventListener("change", () => {
      updateTaskField(el.dataset.id, el.dataset.field, el.value);
      if (["status", "start_date", "end_date"].includes(el.dataset.field)) refreshTaskDerivedViews();
    });
  });
  list.querySelectorAll('[data-action="del"]').forEach(el => el.addEventListener("click", () => deleteTask(el.dataset.id)));
  list.querySelectorAll('[data-action="up"]').forEach(el => el.addEventListener("click", () => moveTask(el.dataset.id, -1)));
  list.querySelectorAll('[data-action="down"]').forEach(el => el.addEventListener("click", () => moveTask(el.dataset.id, 1)));
  list.querySelectorAll('[data-action="color"]').forEach(el => el.addEventListener("click", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (state.editMode) openColorPicker(el, el.dataset.id);
  }));
}

// ---------- color picker ----------
function openColorPicker(anchorEl, taskId) {
  const picker = $("#colorPicker");
  const rect = anchorEl.getBoundingClientRect();
  const pickerHeight = 190;
  let top = rect.bottom + 6;
  if (top + pickerHeight > window.innerHeight) top = Math.max(8, rect.top - pickerHeight - 6);
  picker.style.top = top + "px";
  picker.style.left = Math.min(rect.left, window.innerWidth - 220) + "px";
  const current = state.tasks.find(t => t.id === taskId)?.phase_color;
  picker.innerHTML = PALETTE.map(c => `<span class="color-swatch ${c === current ? "selected" : ""}" style="background:${c}" data-color="${c}"></span>`).join("");
  picker.hidden = false;
  picker.querySelectorAll(".color-swatch").forEach(sw => {
    sw.addEventListener("click", () => {
      updateTaskField(taskId, "phase_color", sw.dataset.color);
      picker.hidden = true;
      renderAll();
    });
  });
  const closeOnOutside = (e) => {
    if (!picker.contains(e.target)) { picker.hidden = true; document.removeEventListener("click", closeOnOutside, true); }
  };
  setTimeout(() => document.addEventListener("click", closeOnOutside, true), 0);
}

// ---------- task table column resize ----------
const COL_WIDTH_KEY = "taskTableColWidths";
const COL_MIN_WIDTH = { phase: 64, name: 90, owner: 60, start: 104, end: 104, dep: 60, status: 70, note: 60 };
const DEFAULT_MIN_COL_WIDTH = 50;
function loadColWidths() {
  try { return JSON.parse(localStorage.getItem(COL_WIDTH_KEY) || "{}"); } catch (e) { return {}; }
}
function saveColWidths(widths) {
  try { localStorage.setItem(COL_WIDTH_KEY, JSON.stringify(widths)); } catch (e) {}
}
function applyColWidths() {
  const widths = loadColWidths();
  Object.keys(widths).forEach(key => {
    const col = document.querySelector(`col[data-colkey="${key}"]`);
    if (col) col.style.width = widths[key] + "px";
  });
}
function wireColumnResize() {
  applyColWidths();
  let active = null;
  let startX = 0;
  let startWidth = 0;
  $$(".col-resizer").forEach(handle => {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const key = handle.dataset.colkey;
      const col = document.querySelector(`col[data-colkey="${key}"]`);
      if (!col) return;
      active = { key, col };
      startX = e.clientX;
      startWidth = col.getBoundingClientRect().width;
      handle.classList.add("active");
      document.body.style.cursor = "col-resize";
    });
  });
  document.addEventListener("mousemove", (e) => {
    if (!active) return;
    const min = COL_MIN_WIDTH[active.key] || DEFAULT_MIN_COL_WIDTH;
    const newWidth = Math.max(min, Math.round(startWidth + (e.clientX - startX)));
    active.col.style.width = newWidth + "px";
  });
  document.addEventListener("mouseup", () => {
    if (!active) return;
    const widths = loadColWidths();
    widths[active.key] = parseInt(active.col.style.width, 10);
    saveColWidths(widths);
    $$(".col-resizer.active").forEach(h => h.classList.remove("active"));
    document.body.style.cursor = "";
    active = null;
  });
}

// ---------- mobile gantt overlay ----------
function wireStaticUI() {
  $("#orgInput").addEventListener("change", () => updateProjectField("org", $("#orgInput").value));
  $("#deptInput").addEventListener("change", () => updateProjectField("dept", $("#deptInput").value));
  $("#pmInput").addEventListener("change", () => updateProjectField("pm", $("#pmInput").value));
  $("#projNameInput").addEventListener("change", () => updateProjectField("name", $("#projNameInput").value));
  $("#statusSelect").addEventListener("change", () => {
    updateProjectField("status", $("#statusSelect").value);
    renderHeader();
  });
  $("#addTaskBtnDesktop").addEventListener("click", addTask);
  $("#addTaskBtnMobile").addEventListener("click", addTask);
  $("#addTaskBtnDesktop").hidden = !state.editMode;
  $("#addTaskBtnMobile").hidden = !state.editMode;
  $("#timelineOpenBtn").addEventListener("click", () => {
    $("#ganttOverlayBody").innerHTML = buildGanttHtml(state.tasks, 14);
    $("#ganttOverlay").hidden = false;
  });
  $("#timelineCloseBtn").addEventListener("click", () => { $("#ganttOverlay").hidden = true; });
  wireColumnResize();
}

// ---------- feedback ----------
function wireFeedbackUI() {
  const modal = $("#feedbackModal");
  const openModal = () => {
    $("#feedbackText").value = "";
    $("#feedbackStatus").hidden = true;
    modal.hidden = false;
    $("#feedbackText").focus();
  };
  const closeModal = () => { modal.hidden = true; };

  $("#feedbackFab").addEventListener("click", openModal);
  $("#feedbackCancelBtn").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  $("#feedbackSubmitBtn").addEventListener("click", async () => {
    const message = $("#feedbackText").value.trim();
    if (!message) { $("#feedbackText").focus(); return; }
    const statusEl = $("#feedbackStatus");
    statusEl.hidden = false;
    statusEl.textContent = "제출 중…";
    const { error } = await supabase.from("feedback").insert({
      project_id: state.project?.id || null,
      message,
      page_url: location.href
    });
    if (error) {
      console.error(error);
      statusEl.textContent = "제출 실패: " + error.message;
      return;
    }
    statusEl.textContent = "제보해주셔서 감사합니다!";
    setTimeout(closeModal, 1200);
  });
}

wireFeedbackUI();
initGate();
