import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.APP_CONFIG;
const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

// 서로 뚜렷이 구분되고, 진행중(초록)/지연(빨강)/완료(회색) 상태 색상과도 겹치지 않도록 정리한 팔레트 (style.css --p1~--p10)
const PALETTE = Array.from({ length: 10 }, (_, i) => getComputedStyle(document.documentElement).getPropertyValue(`--p${i + 1}`).trim());
const STATUS_LABEL = { todo: "예정", doing: "진행중", done: "완료" };
const DAYPX = 20;

let state = { project: null, tasks: [], editMode: false };
let saveTimers = new Map();
let taskFilters = { phase: "", status: "", owner: "", today: false };
// gantt and table collapse state are independent: collapsing a 구분 in one view doesn't affect the other.
let collapsedPhasesGantt = new Set();
let collapsedPhasesTable = new Set();
let collapsedOwnersTable = new Set();
// which desktop board section is showing: "all" | "gantt" | "table" | "owner" (담당자별 업무)
let viewMode = "all";
// task ids whose "세부내용" (담당자/시작일/종료일/비고) row is expanded in the 업무 목록 table; session-only, not persisted.
let openDetailRows = new Set();
// pointer-based row reorder tracking (threshold-based: a plain click never moves a row, only a real press-and-move does)
let dragTracking = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------- light / dark theme toggle ----------
function loadTheme() {
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") return saved;
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}
let currentTheme = loadTheme();
function applyTheme() {
  document.documentElement.setAttribute("data-theme", currentTheme);
  const btn = document.getElementById("themeToggleBtn");
  if (btn) btn.textContent = currentTheme === "dark" ? "☀️" : "🌙";
}
applyTheme();
function wireThemeToggle() {
  const btn = document.getElementById("themeToggleBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    currentTheme = currentTheme === "dark" ? "light" : "dark";
    try { localStorage.setItem("theme", currentTheme); } catch (e) {}
    applyTheme();
  });
}
wireThemeToggle();

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

// ---------- assignee list (PM + 팀원) ----------
// ---------- task list filters (구분/현황/담당자) ----------
function taskMatchesFilters(t) {
  if (taskFilters.phase && (t.phase_name || "") !== taskFilters.phase) return false;
  if (taskFilters.status && deriveTaskStatus(t).key !== taskFilters.status) return false;
  if (taskFilters.owner && (t.owner || "") !== taskFilters.owner) return false;
  if (taskFilters.today) {
    const today = new Date().toISOString().slice(0, 10);
    if (t.start_date && t.start_date > today) return false;
    if (t.end_date && t.end_date < today) return false;
  }
  return true;
}
function renderFilterOptions() {
  const phases = [...new Set(state.tasks.map(t => (t.phase_name || "").trim()).filter(Boolean))];
  const owners = [...new Set(state.tasks.map(t => (t.owner || "").trim()).filter(Boolean))];
  if (taskFilters.phase && !phases.includes(taskFilters.phase)) taskFilters.phase = "";
  if (taskFilters.owner && !owners.includes(taskFilters.owner)) taskFilters.owner = "";

  const phaseHtml = `<option value="">구분</option>` + phases.map(name => `<option value="${escapeHtml(name)}" ${taskFilters.phase === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
  const ownerHtml = `<option value="">담당자</option>` + owners.map(name => `<option value="${escapeHtml(name)}" ${taskFilters.owner === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
  ["#filterPhase", "#filterPhaseMobile"].forEach(sel => { const el = $(sel); if (el) el.innerHTML = phaseHtml; });
  ["#filterOwner", "#filterOwnerMobile"].forEach(sel => { $(sel).innerHTML = ownerHtml; });
  ["#filterStatus", "#filterStatusMobile"].forEach(sel => { $(sel).value = taskFilters.status; });
}
function applyTaskFilters() {
  const byOwner = viewMode === "owner";
  $$("#taskTbody tr[data-id]:not(.task-detail-row)").forEach(row => {
    const t = state.tasks.find(x => x.id === row.dataset.id);
    const groupCollapsed = t && (byOwner ? isOwnerCollapsed(t.owner) : isPhaseCollapsed(t.phase_name, "table"));
    row.hidden = !(t && taskMatchesFilters(t)) || groupCollapsed;
  });
  $$("#cardList .task-card").forEach(card => {
    const t = state.tasks.find(x => x.id === card.dataset.id);
    card.hidden = !(t && taskMatchesFilters(t));
  });
}
function wireTodayFilter() {
  ["#todayFilterBtn", "#todayFilterBtnMobile"].forEach(sel => {
    const btn = $(sel);
    btn.classList.toggle("active", taskFilters.today);
    btn.addEventListener("click", () => {
      taskFilters.today = !taskFilters.today;
      $$(".today-filter-btn").forEach(b => b.classList.toggle("active", taskFilters.today));
      applyTaskFilters();
    });
  });
}
function applyChecklistModeUI() {
  const isChecklist = state.project.type === "checklist";
  $("#viewNavToggleBtn").hidden = isChecklist;
  $("#todayFilterBtn").hidden = !isChecklist;
  $("#todayFilterBtnMobile").hidden = !isChecklist;
  // PM(프로젝트 매니저)은 프로젝트 추진일정에만 해당하는 개념이라 체크리스트에서는 숨김
  $("#pmInput").hidden = isChecklist;
  $("#pmSep").hidden = isChecklist;
  if (isChecklist) {
    taskFilters.today = true;
    wireTodayFilter();
  }
}
function getAssigneeOptions() {
  const p = state.project;
  if (!p) return [];
  const names = [p.pm, ...(p.team_members || "").split(",")]
    .map(s => (s || "").trim())
    .filter(Boolean);
  return [...new Set(names)];
}
function buildOwnerSelectHtml(owner, taskId, dis) {
  const options = getAssigneeOptions();
  const current = (owner || "").trim();
  if (current && !options.includes(current)) options.push(current);
  const optsHtml = [`<option value=""${current ? "" : " selected"}>미배정</option>`]
    .concat(options.map(name => `<option value="${escapeHtml(name)}"${name === current ? " selected" : ""}>${escapeHtml(name)}</option>`))
    .join("");
  return `<select data-field="owner" data-id="${taskId}" ${dis}>${optsHtml}</select>`;
}
function buildTaskStatusSelectHtml(t, ts, dis) {
  const todoLabel = ts.key === "delayed" ? "지연" : "예정";
  return `<select class="task-status-badge ${ts.key}" data-field="status" data-id="${t.id}" ${dis}>
    <option value="todo" ${t.status === "todo" ? "selected" : ""}>${todoLabel}</option>
    <option value="doing" ${t.status === "doing" ? "selected" : ""}>진행중</option>
    <option value="done" ${t.status === "done" ? "selected" : ""}>완료</option>
  </select>`;
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
function buildProjectCardHtml(p) {
  const prog = landingProgress[p.id];
  const total = prog ? prog.total : 0;
  const done = prog ? prog.done : 0;
  const pct = total ? Math.round(done / total * 100) : 0;
  const st = deriveProjectStatusFromMinStart(p.status || "todo", prog ? prog.minStart : null);
  const isChecklist = p.type === "checklist";
  return `
  <div class="project-card" data-id="${p.id}">
    <label class="pc-check"><input type="checkbox" class="pc-checkbox" data-id="${p.id}" ${selectedProjectIds.has(p.id) ? "checked" : ""}></label>
    <a class="pc-body" href="?p=${p.id}">
      <div class="pc-eyebrow">${escapeHtml(p.org || "")}${p.dept ? " / " + escapeHtml(p.dept) : ""}${!isChecklist && p.pm ? " / PM " + escapeHtml(p.pm) : ""}</div>
      <div class="pc-name">${escapeHtml(p.name || "(제목 없음)")}${isChecklist ? "" : " 추진일정"}</div>
      <div class="pc-meta">생성일 ${p.created_at ? p.created_at.slice(0, 10) : ""} · <span class="proj-status-badge ${st.key}">${st.label}</span> · <span class="pc-mode ${p.mode === "edit" ? "edit" : ""}">${p.mode === "edit" ? "✏️ 편집 가능" : "🔒 보기 전용"}</span></div>
      <div class="pc-progress">
        <div class="pc-progress-bar"><div class="pc-progress-fill" style="width:${pct}%"></div></div>
        <span class="pc-progress-label">${total ? `${pct}% (${done}/${total})` : "업무 없음"}</span>
      </div>
    </a>
    <button type="button" class="pc-del" data-id="${p.id}" aria-label="삭제">✕</button>
  </div>
`;
}
function wireProjectCardList(list) {
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
}
function renderProjectGroup(selector, projects, emptyText) {
  const list = $(selector);
  list.innerHTML = projects.length
    ? projects.map(buildProjectCardHtml).join("")
    : `<div class="empty-note">${emptyText}</div>`;
  wireProjectCardList(list);
}
function renderLanding() {
  const timelineProjects = landingProjects.filter(p => p.type !== "checklist");
  const checklistProjects = landingProjects.filter(p => p.type === "checklist");
  renderProjectGroup("#projectList", timelineProjects, "아직 만들어진 프로젝트가 없습니다. 아래에서 새로 만들어보세요.");
  renderProjectGroup("#checklistList", checklistProjects, "아직 만들어진 업무 체크리스트가 없습니다. 아래에서 새로 만들어보세요.");
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
  const createProject = async (type) => {
    const org = $("#newOrgInput").value.trim();
    const dept = $("#newDeptInput").value.trim();
    const pm = type === "checklist" ? "" : $("#newPmInput").value.trim();
    const name = $("#newNameInput").value.trim();
    if (!name) { $("#newNameInput").focus(); return; }
    const { data, error } = await supabase.from("projects").insert({ org, dept, pm, name, mode: "view", status: "todo", type }).select().single();
    if (error) { console.error(error); return; }
    location.href = "?p=" + data.id;
  };
  $("#newProjectBtn").addEventListener("click", () => createProject("timeline"));
  $("#newChecklistBtn").addEventListener("click", () => createProject("checklist"));
}

// ---------- project detail ----------
async function enterProject(projectId) {
  await loadProject(projectId);
  if (!state.project) { location.href = "./"; return; }
  collapsedPhasesGantt = loadCollapsedPhases(state.project.id, "gantt");
  collapsedPhasesTable = loadCollapsedPhases(state.project.id, "table");
  collapsedOwnersTable = loadCollapsedOwners(state.project.id);
  viewMode = state.project.type === "checklist" ? "all" : loadViewMode(state.project.id);
  logPageView("project", projectId);
  await loadTasks();
  state.editMode = state.project.mode === "edit";
  $("#app").hidden = false;
  applyChecklistModeUI();
  renderAll();
  applyViewMode();
  wireStaticUI();
  wireModeToggle();
  wireViewNav();
  wireFileImportDragDrop();
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
    state.tasks.sort((a, b) => a.sort_order - b.sort_order);
    renderAll();
    return;
  }
  if (payload.eventType === "DELETE") {
    state.tasks = state.tasks.filter(t => t.id !== payload.old.id);
    renderAll();
    return;
  }
  // UPDATE: patch only the affected row/card so other rows aren't yanked out
  // from under an in-progress click (this was causing missed clicks when
  // assigning 담당자 on several tasks back-to-back).
  const i = state.tasks.findIndex(t => t.id === payload.new.id);
  if (i < 0) return;
  state.tasks[i] = payload.new;
  patchTaskRow(payload.new.id);
  patchTaskCard(payload.new.id);
  applyTaskFilters();
  renderStats();
  renderOwnerSummary();
  renderLegend();
  renderGantt();
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
  debounceSave("task-" + id + "-" + field, async () => {
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
  renderOwnerSummary();
  renderLegend();
  renderTable();
  renderGantt();
  renderCards();
}
function refreshTaskDerivedViews() {
  renderStats();
  renderOwnerSummary();
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
  renderTeamChips();
  $("#teamAddBtn").hidden = disabled;
  const st = deriveProjectStatus(p.status || "todo", state.tasks);
  const badge = $("#statusBadge");
  badge.textContent = st.label;
  badge.className = "proj-status-badge " + st.key;
  $("#statusSelect").value = p.status || "todo";
  $("#statusSelect").disabled = disabled;
}
function getTeamMembers() {
  return (state.project.team_members || "").split(",").map(s => s.trim()).filter(Boolean);
}
function saveTeamMembers(names) {
  const value = names.join(", ");
  state.project.team_members = value;
  updateProjectField("team_members", value);
  renderTeamChips();
  renderTable();
  renderCards();
}
function renderTeamChips() {
  const row = $("#teamChipRow");
  const names = getTeamMembers();
  row.innerHTML = names.map(name => `
    <span class="team-chip">${escapeHtml(name)}${state.editMode ? `<button type="button" class="team-chip-del" data-name="${escapeHtml(name)}" aria-label="삭제">✕</button>` : ""}</span>
  `).join("");
  row.querySelectorAll(".team-chip-del").forEach(btn => {
    btn.addEventListener("click", () => removeTeamMember(btn.dataset.name));
  });
}
function addTeamMember() {
  const input = prompt("추가할 팀원 이름을 입력하세요");
  const name = (input || "").trim();
  if (!name) return;
  const names = getTeamMembers();
  if (names.includes(name)) return;
  names.push(name);
  saveTeamMembers(names);
}
function removeTeamMember(name) {
  const names = getTeamMembers().filter(n => n !== name);
  saveTeamMembers(names);
}
function renderStats() {
  const total = state.tasks.length;
  const done = state.tasks.filter(t => t.status === "done").length;
  const doing = state.tasks.filter(t => t.status === "doing").length;
  const delayed = state.tasks.filter(t => deriveTaskStatus(t).key === "delayed").length;
  $("#stats").innerHTML = `
    <div class="stat-chip">전체 <b>${total}</b></div>
    <div class="stat-chip">완료 <b>${done}</b></div>
    <div class="stat-chip">진행중 <b>${doing}</b></div>
    <div class="stat-chip delayed">지연 <b>${delayed}</b></div>
    <div class="stat-chip">진행률 <b>${total ? Math.round(done / total * 100) : 0}%</b></div>
  `;
}
function renderOwnerSummary() {
  const el = $("#ownerSummary");
  if (el.hidden) return;
  const groups = new Map();
  state.tasks.forEach(t => {
    const owner = (t.owner || "").trim() || "미배정";
    if (!groups.has(owner)) groups.set(owner, { total: 0, doing: 0, delayed: 0, done: 0, todo: 0 });
    const g = groups.get(owner);
    g.total++;
    g[deriveTaskStatus(t).key]++;
  });
  const owners = [...groups.keys()].sort((a, b) => a === "미배정" ? 1 : b === "미배정" ? -1 : groups.get(b).total - groups.get(a).total);
  if (!owners.length) { el.innerHTML = `<div class="owner-summary-empty">업무가 없습니다</div>`; return; }
  el.innerHTML = owners.map(owner => {
    const g = groups.get(owner);
    const donePct = g.total ? Math.round(g.done / g.total * 100) : 0;
    return `
    <div class="owner-summary-row">
      <div class="owner-summary-name">${escapeHtml(owner)}</div>
      <div class="owner-summary-counts">
        <span class="owner-count total">전체 ${g.total}</span>
        <span class="owner-count doing">진행중 ${g.doing}</span>
        <span class="owner-count delayed">지연 ${g.delayed}</span>
        <span class="owner-count done">완료 ${g.done}</span>
      </div>
      <div class="owner-summary-bar"><div class="owner-summary-bar-fill" style="width:${donePct}%"></div></div>
      <div class="owner-summary-pct">${donePct}%</div>
    </div>`;
  }).join("");
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

// ---------- phase (구분) grouping / collapse ----------
function phaseKeyOf(name) {
  return (name || "").trim();
}
function groupTasksByPhase(tasks) {
  const order = [];
  const map = new Map();
  tasks.forEach(t => {
    const key = phaseKeyOf(t.phase_name);
    if (!map.has(key)) { map.set(key, { key, color: t.phase_color, tasks: [] }); order.push(key); }
    map.get(key).tasks.push(t);
  });
  return order.map(k => map.get(k));
}
function isPhaseCollapsed(phaseName, view) {
  const set = view === "gantt" ? collapsedPhasesGantt : collapsedPhasesTable;
  return set.has(phaseKeyOf(phaseName));
}
function loadCollapsedPhases(pid, view) {
  try { return new Set(JSON.parse(localStorage.getItem(`collapsedPhases_${view}_${pid}`) || "[]")); } catch (e) { return new Set(); }
}
function saveCollapsedPhases(view) {
  if (!state.project) return;
  const set = view === "gantt" ? collapsedPhasesGantt : collapsedPhasesTable;
  try { localStorage.setItem(`collapsedPhases_${view}_${state.project.id}`, JSON.stringify([...set])); } catch (e) {}
}
function togglePhase(key, view) {
  const set = view === "gantt" ? collapsedPhasesGantt : collapsedPhasesTable;
  if (set.has(key)) set.delete(key);
  else set.add(key);
  saveCollapsedPhases(view);
  if (view === "gantt") {
    renderGantt();
  } else {
    renderTable();
    applyTaskFilters();
  }
}
function wirePhaseToggles(container, view) {
  container.querySelectorAll(".phase-group-toggle").forEach(btn => {
    const holder = btn.closest("[data-phase]");
    if (!holder) return;
    btn.addEventListener("click", () => togglePhase(holder.dataset.phase, view));
  });
}
function wirePhaseColorDots(container) {
  container.querySelectorAll(".phase-group-dot-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (state.editMode) openPhaseColorPicker(btn, btn.dataset.phase);
    });
  });
}
function wirePhaseStatChips(container) {
  container.querySelectorAll(".phase-group-stat-chip").forEach(chip => {
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      openPhaseStatusPopover(chip, chip.dataset.phase, chip.dataset.status);
    });
  });
}
function wirePhaseNameEdit(container) {
  container.querySelectorAll(".phase-group-name-editable").forEach(span => {
    span.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.editMode) startPhaseRename(span);
    });
  });
}
function startPhaseRename(span) {
  const oldKey = span.dataset.phase;
  const input = document.createElement("input");
  input.className = "phase-group-name-input";
  input.value = oldKey;
  span.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    const newKey = input.value.trim();
    input.replaceWith(span);
    if (newKey && newKey !== oldKey) renamePhaseGroup(oldKey, newKey);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.value = oldKey; input.blur(); }
  });
  input.addEventListener("blur", commit);
  input.addEventListener("click", (e) => e.stopPropagation());
}
function renamePhaseGroup(oldKey, newKey) {
  const groupTasks = state.tasks.filter(t => phaseKeyOf(t.phase_name) === oldKey);
  groupTasks.forEach(t => updateTaskField(t.id, "phase_name", newKey));
  [["table", collapsedPhasesTable], ["gantt", collapsedPhasesGantt]].forEach(([view, set]) => {
    if (set.has(oldKey)) { set.delete(oldKey); set.add(newKey); saveCollapsedPhases(view); }
  });
  refreshTaskDerivedViews();
}
function buildPhaseHeaderInnerHtml(g, collapsed, showDot = true, nameEditable = false) {
  const total = g.tasks.length;
  const done = g.tasks.filter(t => deriveTaskStatus(t).key === "done").length;
  const dotHtml = showDot ? `<span class="phase-group-dot" style="background:${g.color || PALETTE[0]}"></span>` : "";
  const nameHtml = nameEditable
    ? `<span class="phase-group-name phase-group-name-editable" data-phase="${escapeHtml(g.key)}" title="클릭하면 이름을 바꿀 수 있어요">${escapeHtml(g.key || "구분")}</span>`
    : `<span class="phase-group-name">${escapeHtml(g.key || "구분")}</span>`;
  return `
    <span class="phase-group-caret ${collapsed ? "collapsed" : ""}">▾</span>
    ${dotHtml}
    ${nameHtml}
    <span class="phase-group-count">${done}/${total}</span>
  `;
}
function buildPhaseGroupStatChipsHtml(g) {
  const c = { todo: 0, doing: 0, delayed: 0, done: 0 };
  g.tasks.forEach(t => c[deriveTaskStatus(t).key]++);
  return `<span class="phase-group-stats">
    <span class="phase-group-stat-chip owner-count todo" data-phase="${escapeHtml(g.key)}" data-status="todo">예정 ${c.todo}</span>
    <span class="phase-group-stat-chip owner-count doing" data-phase="${escapeHtml(g.key)}" data-status="doing">진행중 ${c.doing}</span>
    <span class="phase-group-stat-chip owner-count delayed" data-phase="${escapeHtml(g.key)}" data-status="delayed">지연 ${c.delayed}</span>
    <span class="phase-group-stat-chip owner-count done" data-phase="${escapeHtml(g.key)}" data-status="done">완료 ${c.done}</span>
  </span>`;
}
function buildPhaseGroupHeaderRowHtml(g, collapsed) {
  const dotBtn = `<button type="button" class="phase-group-dot phase-group-dot-btn" style="background:${g.color || PALETTE[0]}" data-action="phase-color" data-phase="${escapeHtml(g.key)}" title="클릭하면 이 구분 전체 업무의 색을 바꿀 수 있어요" ${!state.editMode ? "disabled" : ""}></button>`;
  return `<tr class="phase-group-row" data-phase="${escapeHtml(g.key)}">
    <td colspan="5">
      <div class="phase-group-toggle-wrap">
        ${dotBtn}
        <div class="phase-group-toggle" role="button" tabindex="0">${buildPhaseHeaderInnerHtml(g, collapsed, false, true)}</div>
        ${buildPhaseGroupStatChipsHtml(g)}
      </div>
    </td>
  </tr>`;
}

// ---------- 담당자 grouping / collapse (table's "담당자별 업무" view) ----------
function groupTasksByOwner(tasks) {
  const order = [];
  const map = new Map();
  tasks.forEach(t => {
    const key = (t.owner || "").trim() || "미배정";
    if (!map.has(key)) { map.set(key, { key, tasks: [] }); order.push(key); }
    map.get(key).tasks.push(t);
  });
  return order.map(k => map.get(k));
}
function ownerKeyOf(owner) {
  return (owner || "").trim() || "미배정";
}
function isOwnerCollapsed(owner) {
  return collapsedOwnersTable.has(ownerKeyOf(owner));
}
function loadCollapsedOwners(pid) {
  try { return new Set(JSON.parse(localStorage.getItem(`collapsedOwners_table_${pid}`) || "[]")); } catch (e) { return new Set(); }
}
function saveCollapsedOwners() {
  if (!state.project) return;
  try { localStorage.setItem(`collapsedOwners_table_${state.project.id}`, JSON.stringify([...collapsedOwnersTable])); } catch (e) {}
}
function toggleOwnerGroup(key) {
  if (collapsedOwnersTable.has(key)) collapsedOwnersTable.delete(key);
  else collapsedOwnersTable.add(key);
  saveCollapsedOwners();
  renderTable();
  applyTaskFilters();
}
function wireOwnerToggles(container) {
  container.querySelectorAll(".phase-group-toggle").forEach(btn => {
    const holder = btn.closest("[data-owner]");
    if (!holder) return;
    btn.addEventListener("click", () => toggleOwnerGroup(holder.dataset.owner));
  });
}
function buildOwnerGroupHeaderRowHtml(g, collapsed) {
  return `<tr class="phase-group-row" data-owner="${escapeHtml(g.key)}">
    <td colspan="5"><button type="button" class="phase-group-toggle">${buildPhaseHeaderInnerHtml(g, collapsed, false)}</button></td>
  </tr>`;
}

function buildTaskRowHtml(t, dis) {
  const ts = deriveTaskStatus(t);
  const open = openDetailRows.has(t.id);
  return `
    <tr data-id="${t.id}">
      <td class="col-drag"><span class="drag-handle">⠿</span></td>
      <td class="col-name"><input value="${escapeHtml(t.name)}" data-field="name" data-id="${t.id}" ${dis} placeholder="업무명"></td>
      <td class="col-taskstatus">${buildTaskStatusSelectHtml(t, ts, dis)}</td>
      <td class="col-detail"><button type="button" class="detail-btn ${open ? "open" : ""}" data-action="detail" data-id="${t.id}"><span class="detail-car">▾</span> 세부내용</button></td>
      <td class="col-del">${state.editMode ? `<button class="del-btn" data-action="del" data-id="${t.id}">✕</button>` : ""}</td>
    </tr>
    ${buildTaskDetailRowHtml(t, dis, open)}
  `;
}
function buildTaskDetailRowHtml(t, dis, open) {
  return `<tr class="task-detail-row" data-id="${t.id}" ${open ? "" : "hidden"}>
    <td colspan="5">
      <div class="task-detail-inner">
        <div class="task-detail-field"><label>담당자</label>${buildOwnerSelectHtml(t.owner, t.id, dis)}</div>
        <div class="task-detail-field"><label>시작일</label><input type="date" value="${t.start_date || ""}" data-field="start_date" data-id="${t.id}" ${dis}></div>
        <div class="task-detail-field"><label>종료일</label><input type="date" value="${t.end_date || ""}" data-field="end_date" data-id="${t.id}" ${dis}></div>
        <div class="task-detail-field"><label>선행업무</label>${buildDependencyFieldHtml(t)}</div>
        <div class="task-detail-field"><label>비고</label><textarea class="autosize-textarea" rows="1" data-field="note" data-id="${t.id}" ${dis} placeholder="-">${escapeHtml(t.note)}</textarea></div>
      </div>
    </td>
  </tr>`;
}
function parseDependencyIds(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(id => typeof id === "string") : [];
  } catch (e) { return []; }
}
function buildDependencyFieldHtml(t) {
  const editable = state.editMode;
  const ids = parseDependencyIds(t.dependency);
  const chips = ids.map(id => {
    const dt = state.tasks.find(x => x.id === id);
    if (!dt) return "";
    return `<span class="dep-chip">${escapeHtml(dt.name || "(제목 없음)")}${editable ? `<button type="button" class="dep-chip-del" data-id="${t.id}" data-dep-id="${id}" aria-label="삭제">✕</button>` : ""}</span>`;
  }).join("");
  const addBtn = editable ? `<button type="button" class="dep-add-btn" data-action="dep-pick" data-id="${t.id}">+ 선택</button>` : "";
  const emptyHtml = (!chips && !editable) ? `<span class="dep-empty">-</span>` : "";
  return `<div class="dep-chip-row" data-id="${t.id}">${chips}${emptyHtml}${addBtn}</div>`;
}
function wireDependencyField(container) {
  container.querySelectorAll('[data-action="dep-pick"]').forEach(el => el.addEventListener("click", () => {
    if (state.editMode) openDependencyPicker(el, el.dataset.id);
  }));
  container.querySelectorAll(".dep-chip-del").forEach(el => el.addEventListener("click", () => {
    const t = state.tasks.find(x => x.id === el.dataset.id);
    if (!t) return;
    const ids = parseDependencyIds(t.dependency).filter(id => id !== el.dataset.depId);
    updateTaskField(t.id, "dependency", ids.length ? JSON.stringify(ids) : "");
    refreshDependencyField(t.id);
  }));
}
function refreshDependencyField(taskId) {
  const row = document.querySelector(`.dep-chip-row[data-id="${taskId}"]`);
  const t = state.tasks.find(x => x.id === taskId);
  if (!row || !t) return;
  row.outerHTML = buildDependencyFieldHtml(t);
  const newRow = document.querySelector(`.dep-chip-row[data-id="${taskId}"]`);
  if (newRow) wireDependencyField(newRow.parentElement);
}
function openDependencyPicker(anchorEl, taskId) {
  const picker = $("#depPicker");
  const others = state.tasks.filter(x => x.id !== taskId);
  const t = state.tasks.find(x => x.id === taskId);
  const selected = new Set(parseDependencyIds(t?.dependency));
  if (!others.length) {
    picker.innerHTML = `<div class="dep-picker-empty">선택할 수 있는 다른 업무가 없습니다</div>`;
  } else {
    const groups = groupTasksByPhase(others);
    picker.innerHTML = groups.map(g => `
      <div class="dep-picker-group">
        <div class="dep-picker-phase-label">${escapeHtml(g.key || "구분")}</div>
        ${g.tasks.map(dt => `
          <label class="dep-picker-item">
            <input type="checkbox" data-dep-id="${dt.id}" ${selected.has(dt.id) ? "checked" : ""}>
            <span>${escapeHtml(dt.name || "(제목 없음)")}</span>
          </label>
        `).join("")}
      </div>
    `).join("");
  }
  const rect = anchorEl.getBoundingClientRect();
  picker.hidden = false;
  const pickerHeight = Math.min(picker.scrollHeight || 200, 320);
  let top = rect.bottom + 6;
  if (top + pickerHeight > window.innerHeight) top = Math.max(8, rect.top - pickerHeight - 6);
  picker.style.top = top + "px";
  picker.style.left = Math.min(rect.left, window.innerWidth - 260) + "px";
  picker.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener("change", () => {
      const ids = new Set(parseDependencyIds(state.tasks.find(x => x.id === taskId)?.dependency));
      if (cb.checked) ids.add(cb.dataset.depId); else ids.delete(cb.dataset.depId);
      updateTaskField(taskId, "dependency", ids.size ? JSON.stringify([...ids]) : "");
      refreshDependencyField(taskId);
    });
  });
  const closeOnOutside = (e) => {
    if (!picker.contains(e.target) && e.target !== anchorEl) { picker.hidden = true; document.removeEventListener("click", closeOnOutside, true); }
  };
  setTimeout(() => document.addEventListener("click", closeOnOutside, true), 0);
}
const PHASE_STAT_LABEL = { todo: "예정", doing: "진행중", delayed: "지연", done: "완료" };
function openPhaseStatusPopover(anchorEl, phaseKey, statusKey) {
  const popover = $("#phaseStatPopover");
  const matched = state.tasks.filter(t => phaseKeyOf(t.phase_name) === phaseKey && deriveTaskStatus(t).key === statusKey);
  popover.innerHTML = `
    <div class="dep-picker-phase-label">${escapeHtml(phaseKey || "구분")} · ${PHASE_STAT_LABEL[statusKey]} ${matched.length}건</div>
    ${matched.length ? matched.map(t => `
      <div class="dep-picker-item phase-stat-item" data-id="${t.id}">
        <span>${escapeHtml(t.name || "(제목 없음)")}${t.owner ? ` · ${escapeHtml(t.owner)}` : ""}</span>
      </div>
    `).join("") : `<div class="dep-picker-empty">해당 업무가 없습니다</div>`}
  `;
  const rect = anchorEl.getBoundingClientRect();
  popover.hidden = false;
  const h = Math.min(popover.scrollHeight || 200, 320);
  let top = rect.bottom + 6;
  if (top + h > window.innerHeight) top = Math.max(8, rect.top - h - 6);
  popover.style.top = top + "px";
  popover.style.left = Math.min(rect.left, window.innerWidth - 260) + "px";
  popover.querySelectorAll(".phase-stat-item").forEach(item => {
    item.addEventListener("click", () => {
      const id = item.dataset.id;
      openDetailRows.add(id);
      if (isPhaseCollapsed(phaseKey, "table")) togglePhase(phaseKey, "table");
      else { renderTable(); applyTaskFilters(); }
      popover.hidden = true;
      requestAnimationFrame(() => {
        const row = document.querySelector(`#taskTbody tr[data-id="${id}"]:not(.task-detail-row)`);
        row?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  });
  const closePopoverOnOutside = (e) => {
    if (!popover.contains(e.target) && e.target !== anchorEl) { popover.hidden = true; document.removeEventListener("click", closePopoverOnOutside, true); }
  };
  setTimeout(() => document.addEventListener("click", closePopoverOnOutside, true), 0);
}
function autosizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}
function toggleTaskDetail(id) {
  if (openDetailRows.has(id)) openDetailRows.delete(id);
  else openDetailRows.add(id);
  const tbody = $("#taskTbody");
  if (!tbody) return;
  const btn = tbody.querySelector(`tr[data-id="${id}"]:not(.task-detail-row) [data-action="detail"]`);
  const detailTr = tbody.querySelector(`tr.task-detail-row[data-id="${id}"]`);
  const isOpen = openDetailRows.has(id);
  if (btn) btn.classList.toggle("open", isOpen);
  if (detailTr) {
    detailTr.hidden = !isOpen;
    if (isOpen) detailTr.querySelectorAll("textarea.autosize-textarea").forEach(autosizeTextarea);
  }
}
function wireTaskRowEl(tr) {
  tr.querySelectorAll("input,select,textarea").forEach(el => {
    el.addEventListener("change", () => {
      updateTaskField(el.dataset.id, el.dataset.field, el.value);
      if (["status", "start_date", "end_date", "phase_name"].includes(el.dataset.field)) refreshTaskDerivedViews();
    });
  });
  tr.querySelectorAll("textarea.autosize-textarea").forEach(el => el.addEventListener("input", () => autosizeTextarea(el)));
  if (!tr.hidden) tr.querySelectorAll("textarea.autosize-textarea").forEach(autosizeTextarea);
  tr.querySelectorAll('[data-action="del"]').forEach(el => el.addEventListener("click", () => deleteTask(el.dataset.id)));
  tr.querySelectorAll('[data-action="detail"]').forEach(el => el.addEventListener("click", () => toggleTaskDetail(el.dataset.id)));
  wireDependencyField(tr);
}
function patchTaskRow(taskId) {
  const t = state.tasks.find(x => x.id === taskId);
  const tbody = $("#taskTbody");
  if (!tbody) return;
  const oldTr = tbody.querySelector(`tr[data-id="${taskId}"]:not(.task-detail-row)`);
  const oldDetailTr = tbody.querySelector(`tr.task-detail-row[data-id="${taskId}"]`);
  if (!t || !oldTr) return;
  if (oldTr.contains(document.activeElement) || (oldDetailTr && oldDetailTr.contains(document.activeElement))) return;
  const dis = !state.editMode ? "disabled" : "";
  const wrapper = document.createElement("tbody");
  wrapper.innerHTML = buildTaskRowHtml(t, dis);
  const newTr = wrapper.children[0];
  const newDetailTr = wrapper.children[1];
  oldTr.replaceWith(newTr);
  if (oldDetailTr) oldDetailTr.replaceWith(newDetailTr);
  else newTr.after(newDetailTr);
  wireTaskRowEl(newTr);
  wireTaskRowEl(newDetailTr);
}
function renderTable() {
  const tbody = $("#taskTbody");
  const dis = !state.editMode ? "disabled" : "";
  const byOwner = viewMode === "owner";
  const groups = byOwner ? groupTasksByOwner(state.tasks) : groupTasksByPhase(state.tasks);
  tbody.innerHTML = groups.map(g => {
    const collapsed = byOwner ? isOwnerCollapsed(g.key) : isPhaseCollapsed(g.key, "table");
    const headerHtml = byOwner ? buildOwnerGroupHeaderRowHtml(g, collapsed) : buildPhaseGroupHeaderRowHtml(g, collapsed);
    return headerHtml + g.tasks.map(t => buildTaskRowHtml(t, dis)).join("");
  }).join("") + (state.editMode ? `
    <tr class="add-task-row">
      <td colspan="5"><button type="button" class="add-task-row-btn" id="addTaskBtnDesktop">+ 업무 추가</button></td>
    </tr>
  ` : "");

  tbody.querySelectorAll("tr[data-id]").forEach(wireTaskRowEl);
  if (byOwner) { wireOwnerToggles(tbody); } else { wirePhaseToggles(tbody, "table"); wirePhaseColorDots(tbody); wirePhaseNameEdit(tbody); wirePhaseStatChips(tbody); }
  const addBtn = tbody.querySelector("#addTaskBtnDesktop");
  if (addBtn) addBtn.addEventListener("click", addTask);
  wireDragReorder(tbody);
}

// Threshold-based reorder: a plain click (no meaningful movement) never moves a row, only
// pressing and actually dragging past DRAG_THRESHOLD px does. Row-level pointerdown just
// records a candidate; the real drag/drop logic lives in the document-level pointermove/
// pointerup listeners wired once in wireStaticUI(). Main rows only: each task's own
// task-detail-row travels along with it as a pair, never dropped on independently.
const DRAG_THRESHOLD = 6;
function wireDragReorder(tbody) {
  tbody.querySelectorAll("tr[data-id]:not(.task-detail-row)").forEach(row => {
    row.addEventListener("pointerdown", (e) => {
      if (e.target.matches('input[data-field="name"]')) return;
      if (e.button !== 0) return;
      const detailEl = tbody.querySelector(`tr.task-detail-row[data-id="${row.dataset.id}"]`);
      dragTracking = { row, detailEl, startX: e.clientX, startY: e.clientY, dragging: false };
    });
  });
}

function renderGantt() {
  const wrap = $("#gantt");
  if (!state.tasks.length) { wrap.innerHTML = `<div style="color:var(--ink-muted);font-size:12px;padding:10px;">일정을 추가하면 타임라인이 표시됩니다.</div>`; return; }
  wrap.innerHTML = buildGanttHtml(state.tasks, DAYPX, true, true);
  wireGanttResizer();
  wirePhaseToggles(wrap, "gantt");
}
function loadGanttLabelWidth() {
  const v = parseInt(localStorage.getItem("ganttLabelWidth") || "", 10);
  return Number.isFinite(v) && v >= 100 && v <= 400 ? v : 260;
}
let ganttLabelWidth = loadGanttLabelWidth();
function wireGanttResizer() {
  const handle = $("#ganttResizer");
  if (!handle) return;
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = ganttLabelWidth;
    handle.classList.add("active");
    document.body.style.cursor = "col-resize";
    const onMove = (ev) => {
      ganttLabelWidth = Math.max(100, Math.min(400, Math.round(startWidth + (ev.clientX - startX))));
      renderGantt();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      try { localStorage.setItem("ganttLabelWidth", String(ganttLabelWidth)); } catch (e) {}
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
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
function buildGanttTaskRowHtml(t, minDate, daypx, trackWidth, rowWidth) {
  if (!t.start_date || !t.end_date) return "";
  const off = daysBetween(minDate, t.start_date);
  const len = Math.max(1, daysBetween(t.start_date, t.end_date) + 1);
  const ts = deriveTaskStatus(t);
  let barColor = t.phase_color;
  if (ts.key === "delayed") barColor = "var(--delay)";
  else if (ts.key === "done") barColor = "var(--ink-muted)";
  else if (ts.key === "doing") barColor = "var(--accent)";
  const barLeft = off * daypx;
  const barWidth = len * daypx - 3;
  const labelHtml = ts.key === "todo" ? "" : `<span class="gantt-bar-label">${ts.label}</span>`;
  const ownerText = t.owner ? escapeHtml(t.owner) : "미배정";
  return `<div class="gantt-row" style="grid-template-columns:${ganttLabelWidth}px 1fr;width:${rowWidth}px">
    <div class="gantt-row-label">
      <div class="gantt-row-name-box" title="${escapeHtml(t.phase_name || "구분")} · ${escapeHtml(t.name || "")}">${escapeHtml(t.name || "(제목 없음)")}</div>
      <div class="gantt-row-owner-col">${ownerText}</div>
      <div class="gantt-row-status-col"><span class="task-status-badge ${ts.key}">${ts.label}</span></div>
    </div>
    <div class="gantt-track" style="width:${trackWidth}px">
      <div class="gantt-bar ${ts.key}" style="left:${barLeft}px;width:${barWidth}px;background:${barColor}" title="${escapeHtml(t.name)}">${labelHtml}</div>
    </div>
  </div>`;
}
// grouped=true shows collapsible 구분 group headers (desktop board); grouped=false renders
// a flat list with no headers (mobile timeline overlay doesn't have the grouping feature yet).
// extendRange=true pads the timeline forward to span at least 3 months from the earliest task
// (desktop only, for now) and switches the ruler to a daily tick per day instead of weekly.
function buildGanttHtml(tasks, daypx, grouped = true, extendRange = false) {
  const dated = tasks.filter(t => t.start_date && t.end_date);
  if (!dated.length) return `<div style="color:var(--ink-muted);font-size:12px;padding:10px;">시작일/종료일을 입력하면 타임라인이 표시됩니다.</div>`;
  const minDate = dated.reduce((m, t) => t.start_date < m ? t.start_date : m, dated[0].start_date);
  let maxDate = dated.reduce((m, t) => t.end_date > m ? t.end_date : m, dated[0].end_date);
  if (extendRange) {
    const minEnd = new Date(minDate);
    minEnd.setMonth(minEnd.getMonth() + 3);
    minEnd.setDate(minEnd.getDate() - 1);
    const minEndStr = minEnd.toISOString().slice(0, 10);
    if (minEndStr > maxDate) maxDate = minEndStr;
  }
  const totalDays = Math.max(1, daysBetween(minDate, maxDate) + 1);
  const trackWidth = totalDays * daypx;
  const rowWidth = ganttLabelWidth + trackWidth;

  const monthSegments = buildGanttMonthSegments(minDate, totalDays);
  let html = `<div class="gantt-month-row" style="width:${rowWidth}px">
    <div class="gantt-spacer" style="width:${ganttLabelWidth}px"><div class="gantt-resizer" id="ganttResizer" title="드래그해서 업무명 폭 조정"></div></div>
    <div class="gantt-month-track" style="width:${trackWidth}px">
      ${monthSegments.map((s, i) => `<span class="${i % 2 === 1 ? "alt" : ""}" style="width:${s.days * daypx}px">${s.label}</span>`).join("")}
    </div>
  </div>`;

  const rulerStep = extendRange ? 1 : 7;
  const rulerCols = [];
  for (let i = 0; i <= totalDays; i += rulerStep) rulerCols.push(i);
  html += `<div class="gantt-ruler${extendRange ? " gantt-ruler-daily" : ""}" style="width:${rowWidth}px">
    <div class="gantt-spacer" style="width:${ganttLabelWidth}px"></div>
    <div class="gantt-ruler-track" style="width:${trackWidth}px">
      ${rulerCols.map(d => {
        const dt = new Date(minDate); dt.setDate(dt.getDate() + d);
        const label = extendRange ? String(dt.getDate()) : `${dt.getMonth() + 1}/${dt.getDate()}`;
        return `<span style="width:${rulerStep * daypx}px;flex:none">${label}</span>`;
      }).join("")}
    </div>
  </div>`;

  if (grouped) {
    const groups = groupTasksByPhase(tasks);
    groups.forEach(g => {
      const collapsed = isPhaseCollapsed(g.key, "gantt");
      const groupColor = g.color || PALETTE[0];
      const groupDated = g.tasks.filter(t => t.start_date && t.end_date);
      let groupBarHtml = "";
      if (groupDated.length) {
        const gMin = groupDated.reduce((m, t) => t.start_date < m ? t.start_date : m, groupDated[0].start_date);
        const gMax = groupDated.reduce((m, t) => t.end_date > m ? t.end_date : m, groupDated[0].end_date);
        const gOff = daysBetween(minDate, gMin);
        const gLen = Math.max(1, daysBetween(gMin, gMax) + 1);
        groupBarHtml = `<div class="gantt-group-bar" style="left:${gOff * daypx}px;width:${gLen * daypx - 3}px;background:${groupColor}"></div>`;
      }
      html += `<div class="gantt-row gantt-phase-row" data-phase="${escapeHtml(g.key)}" style="grid-template-columns:${ganttLabelWidth}px 1fr;width:${rowWidth}px">
        <div class="gantt-row-label gantt-phase-label" style="background:${groupColor}">
          <button type="button" class="phase-group-toggle" style="background:${groupColor}">${buildPhaseHeaderInnerHtml(g, collapsed)}</button>
        </div>
        <div class="gantt-track" style="width:${trackWidth}px">${groupBarHtml}</div>
      </div>`;

      if (collapsed) return;
      g.tasks.forEach(t => { html += buildGanttTaskRowHtml(t, minDate, daypx, trackWidth, rowWidth); });
    });
  } else {
    tasks.forEach(t => { html += buildGanttTaskRowHtml(t, minDate, daypx, trackWidth, rowWidth); });
  }

  let cursorDays = 0;
  monthSegments.forEach((s, i) => {
    cursorDays += s.days;
    if (i < monthSegments.length - 1) {
      const lineLeft = ganttLabelWidth + cursorDays * daypx;
      html += `<div class="gantt-month-line" style="left:${lineLeft}px"></div>`;
    }
  });

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayOffsetDays = daysBetween(minDate, todayStr);
  if (todayOffsetDays >= 0 && todayOffsetDays <= totalDays) {
    const todayLeft = ganttLabelWidth + todayOffsetDays * daypx;
    const todayLabelDate = new Date(todayStr);
    html += `<div class="gantt-today-line" style="left:${todayLeft}px"><span class="gantt-today-label">오늘 (${todayLabelDate.getMonth() + 1}/${todayLabelDate.getDate()})</span></div>`;
  }
  return html;
}

function buildTaskCardHtml(t, idx, dis) {
  const ts = deriveTaskStatus(t);
  return `
    <div class="task-card" data-id="${t.id}">
      <div class="card-top">
        <span class="phase-pill" style="background:${t.phase_color}" data-action="color" data-id="${t.id}" title="클릭하면 색상을 바꿀 수 있어요">
          <input value="${escapeHtml(t.phase_name)}" data-field="phase_name" data-id="${t.id}" ${dis}>
        </span>
        ${buildTaskStatusSelectHtml(t, ts, dis)}
        ${state.editMode ? `<div class="move-btns">
          <button class="icon-btn" data-action="up" data-id="${t.id}" ${idx === 0 ? "disabled" : ""}>▲</button>
          <button class="icon-btn" data-action="down" data-id="${t.id}" ${idx === state.tasks.length - 1 ? "disabled" : ""}>▼</button>
          <button class="icon-btn" data-action="del" data-id="${t.id}">✕</button>
        </div>` : ""}
      </div>
      <input class="card-name-input" value="${escapeHtml(t.name)}" data-field="name" data-id="${t.id}" ${dis} placeholder="업무명">
      <div class="card-row">
        <div class="card-field"><label>담당자</label>${buildOwnerSelectHtml(t.owner, t.id, dis)}</div>
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
}
function wireTaskCardEl(card) {
  card.querySelectorAll("input,select").forEach(el => {
    el.addEventListener("change", () => {
      updateTaskField(el.dataset.id, el.dataset.field, el.value);
      if (["status", "start_date", "end_date", "phase_name"].includes(el.dataset.field)) refreshTaskDerivedViews();
    });
  });
  card.querySelectorAll('[data-action="del"]').forEach(el => el.addEventListener("click", () => deleteTask(el.dataset.id)));
  card.querySelectorAll('[data-action="up"]').forEach(el => el.addEventListener("click", () => moveTask(el.dataset.id, -1)));
  card.querySelectorAll('[data-action="down"]').forEach(el => el.addEventListener("click", () => moveTask(el.dataset.id, 1)));
  card.querySelectorAll('[data-action="color"]').forEach(el => el.addEventListener("click", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (state.editMode) openColorPicker(el, el.dataset.id);
  }));
}
function patchTaskCard(taskId) {
  const idx = state.tasks.findIndex(x => x.id === taskId);
  const list = $("#cardList");
  if (!list || idx < 0) return;
  const oldCard = list.querySelector(`.task-card[data-id="${taskId}"]`);
  if (!oldCard) return;
  if (oldCard.contains(document.activeElement)) return;
  const dis = !state.editMode ? "disabled" : "";
  const wrapper = document.createElement("div");
  wrapper.innerHTML = buildTaskCardHtml(state.tasks[idx], idx, dis);
  const newCard = wrapper.firstElementChild;
  wireTaskCardEl(newCard);
  oldCard.replaceWith(newCard);
}
function renderCards() {
  const list = $("#cardList");
  const dis = !state.editMode ? "disabled" : "";
  list.innerHTML = state.tasks.map((t, idx) => buildTaskCardHtml(t, idx, dis)).join("") + (state.editMode ? `<button type="button" class="add-task-card-btn" id="addTaskBtnMobile">+ 업무 추가</button>` : "");

  list.querySelectorAll(".task-card").forEach(wireTaskCardEl);
  const addBtnMobile = list.querySelector("#addTaskBtnMobile");
  if (addBtnMobile) addBtnMobile.addEventListener("click", addTask);

  renderFilterOptions();
  applyTaskFilters();
}

// ---------- color picker ----------
function openColorPickerCore(anchorEl, currentColor, onSelect) {
  const picker = $("#colorPicker");
  const rect = anchorEl.getBoundingClientRect();
  const pickerHeight = 90;
  let top = rect.bottom + 6;
  if (top + pickerHeight > window.innerHeight) top = Math.max(8, rect.top - pickerHeight - 6);
  picker.style.top = top + "px";
  picker.style.left = Math.min(rect.left, window.innerWidth - 220) + "px";
  picker.innerHTML = PALETTE.map(c => `<span class="color-swatch ${c === currentColor ? "selected" : ""}" style="background:${c}" data-color="${c}"></span>`).join("");
  picker.hidden = false;
  picker.querySelectorAll(".color-swatch").forEach(sw => {
    sw.addEventListener("click", () => {
      picker.hidden = true;
      onSelect(sw.dataset.color);
    });
  });
  const closeOnOutside = (e) => {
    if (!picker.contains(e.target)) { picker.hidden = true; document.removeEventListener("click", closeOnOutside, true); }
  };
  setTimeout(() => document.addEventListener("click", closeOnOutside, true), 0);
}
function openColorPicker(anchorEl, taskId) {
  const current = state.tasks.find(t => t.id === taskId)?.phase_color;
  openColorPickerCore(anchorEl, current, (color) => {
    updateTaskField(taskId, "phase_color", color);
    renderAll();
  });
}
function openPhaseColorPicker(anchorEl, phaseKey) {
  const groupTasks = state.tasks.filter(t => phaseKeyOf(t.phase_name) === phaseKey);
  openColorPickerCore(anchorEl, groupTasks[0]?.phase_color, (color) => {
    groupTasks.forEach(t => updateTaskField(t.id, "phase_color", color));
    renderAll();
  });
}

// ---------- task table column resize ----------
const COL_WIDTH_KEY = "taskTableColWidths";
const COL_MIN_WIDTH = { name: 90, owner: 90 };
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

// ---------- desktop view switcher (전체업무 / 간트차트 / 업무 목록 / 담당자별 업무) ----------
const VIEW_MODES = ["all", "gantt", "table", "owner"];
function loadViewMode(pid) {
  const v = localStorage.getItem("viewMode_" + pid);
  return VIEW_MODES.includes(v) ? v : "all";
}
function saveViewMode() {
  if (!state.project) return;
  try { localStorage.setItem("viewMode_" + state.project.id, viewMode); } catch (e) {}
}
function applyViewMode() {
  const showGantt = viewMode === "all" || viewMode === "gantt";
  const showTable = viewMode !== "gantt";
  $("#ganttViewGroup").hidden = !showGantt;
  $("#tableViewGroup").hidden = !showTable;
  $("#tableSectionTitle").textContent = viewMode === "owner" ? "담당자별 업무" : "업무 목록";
  $$(".view-nav-item[data-view]").forEach(btn => btn.classList.toggle("active", btn.dataset.view === viewMode));
  renderTable();
}
function setViewMode(mode) {
  if (!VIEW_MODES.includes(mode)) return;
  viewMode = mode;
  saveViewMode();
  applyViewMode();
  closeViewNav();
}
function openViewNav() {
  $("#viewNavPanel").hidden = false;
  $("#viewNavBackdrop").hidden = false;
}
function closeViewNav() {
  $("#viewNavPanel").hidden = true;
  $("#viewNavBackdrop").hidden = true;
}
function wireViewNav() {
  $("#viewNavToggleBtn").addEventListener("click", () => {
    if ($("#viewNavPanel").hidden) openViewNav(); else closeViewNav();
  });
  $("#viewNavBackdrop").addEventListener("click", closeViewNav);
  $$(".view-nav-item[data-view]").forEach(btn => btn.addEventListener("click", () => setViewMode(btn.dataset.view)));
}

// ---------- mobile gantt overlay ----------
function wireStaticUI() {
  document.addEventListener("pointermove", (e) => {
    if (!dragTracking) return;
    if (!dragTracking.dragging) {
      const moved = Math.hypot(e.clientX - dragTracking.startX, e.clientY - dragTracking.startY);
      if (moved < DRAG_THRESHOLD) return;
      dragTracking.dragging = true;
      dragTracking.row.classList.add("dragging");
    }
    const overRow = document.elementFromPoint(e.clientX, e.clientY)?.closest("tr[data-id]:not(.task-detail-row)");
    if (!overRow || overRow === dragTracking.row) return;
    const rect = overRow.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    const targetDetail = overRow.parentNode.querySelector(`tr.task-detail-row[data-id="${overRow.dataset.id}"]`);
    overRow.parentNode.insertBefore(dragTracking.row, before ? overRow : (targetDetail ? targetDetail.nextSibling : overRow.nextSibling));
    if (dragTracking.detailEl) overRow.parentNode.insertBefore(dragTracking.detailEl, dragTracking.row.nextSibling);
  });
  document.addEventListener("pointerup", () => {
    if (!dragTracking) return;
    if (dragTracking.dragging) {
      dragTracking.row.classList.remove("dragging");
      const tbody = $("#taskTbody");
      const ids = Array.from(tbody.querySelectorAll("tr[data-id]:not(.task-detail-row)")).map(r => r.dataset.id);
      state.tasks.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      persistOrder();
    }
    dragTracking = null;
  });
  const wireFilterPair = (key, ids) => {
    ids.forEach(id => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("change", () => {
        taskFilters[key] = el.value;
        ids.forEach(otherId => { const other = $(otherId); if (other && otherId !== id) other.value = taskFilters[key]; });
        applyTaskFilters();
      });
    });
  };
  wireFilterPair("phase", ["#filterPhase", "#filterPhaseMobile"]);
  wireFilterPair("status", ["#filterStatus", "#filterStatusMobile"]);
  wireFilterPair("owner", ["#filterOwner", "#filterOwnerMobile"]);
  $("#orgInput").addEventListener("change", () => updateProjectField("org", $("#orgInput").value));
  $("#deptInput").addEventListener("change", () => updateProjectField("dept", $("#deptInput").value));
  $("#pmInput").addEventListener("change", () => {
    updateProjectField("pm", $("#pmInput").value);
    renderTable();
    renderCards();
  });
  $("#teamAddBtn").addEventListener("click", addTeamMember);
  $("#projNameInput").addEventListener("change", () => updateProjectField("name", $("#projNameInput").value));
  $("#statusSelect").addEventListener("change", () => {
    updateProjectField("status", $("#statusSelect").value);
    renderHeader();
  });
  $("#timelineOpenBtn").addEventListener("click", () => {
    $("#ganttOverlayBody").innerHTML = buildGanttHtml(state.tasks, 14, false);
    $("#ganttOverlay").hidden = false;
  });
  $("#timelineCloseBtn").addEventListener("click", () => { $("#ganttOverlay").hidden = true; });
  $("#ownerSummaryToggleBtn").addEventListener("click", () => {
    $("#ownerSummary").hidden = !$("#ownerSummary").hidden;
    renderOwnerSummary();
  });
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

// ---------- 파일 드래그앤드롭 → AI가 읽고 업무 자동 생성 ----------
const IMPORT_ALLOWED_EXT = /\.(txt|md|markdown|pdf)$/i;
let importDragDepth = 0;

function wireFileImportDragDrop() {
  const overlay = $("#importDropOverlay");
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");

  window.addEventListener("dragenter", (e) => {
    if (!state.project || !state.editMode || !hasFiles(e)) return;
    importDragDepth++;
    overlay.hidden = false;
  });
  window.addEventListener("dragover", (e) => {
    if (overlay.hidden) return;
    e.preventDefault();
  });
  window.addEventListener("dragleave", () => {
    if (importDragDepth === 0) return;
    importDragDepth--;
    if (importDragDepth === 0) overlay.hidden = true;
  });
  window.addEventListener("drop", async (e) => {
    if (!state.project || !state.editMode) return;
    e.preventDefault();
    importDragDepth = 0;
    overlay.hidden = true;
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) await startFileImport(file);
  });
}

function showImportStatus(text, autoHideMs) {
  const el = $("#importStatusBanner");
  el.textContent = text;
  el.hidden = false;
  if (autoHideMs) setTimeout(() => { el.hidden = true; }, autoHideMs);
}

function openImportModePopup(fileName) {
  return new Promise((resolve) => {
    const modal = $("#importModeModal");
    $("#importFileName").textContent = fileName;
    modal.hidden = false;
    const done = (result) => { modal.hidden = true; resolve(result); };
    $("#importModeCancelBtn").onclick = () => done(null);
    $("#importModeOverwriteBtn").onclick = () => done("overwrite");
    $("#importModeAppendBtn").onclick = () => done("append");
  });
}

async function startFileImport(file) {
  if (!IMPORT_ALLOWED_EXT.test(file.name)) {
    showImportStatus("txt, md, pdf 파일만 지원합니다.", 4000);
    return;
  }
  const mode = await openImportModePopup(file.name);
  if (!mode) return;

  showImportStatus("AI가 파일을 분석하고 있습니다...");
  try {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/import-schedule", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "가져오기 요청이 실패했습니다.");
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    if (!tasks.length) { showImportStatus("문서에서 업무를 찾지 못했습니다.", 4000); return; }
    await applyImportedTasks(tasks, mode);
    showImportStatus(`${tasks.length}개 업무를 가져왔습니다.`, 3000);
  } catch (e) {
    console.error(e);
    showImportStatus("가져오기 실패: " + (e.message || "알 수 없는 오류"), 5000);
  }
}

function normalizeImportDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : null;
}

async function applyImportedTasks(tasks, mode) {
  if (mode === "overwrite") {
    await supabase.from("tasks").delete().eq("project_id", state.project.id);
    state.tasks = [];
  }
  const maxOrder = state.tasks.reduce((m, t) => Math.max(m, t.sort_order), 0);
  const phaseColorMap = new Map();
  let colorIdx = 0;
  const rows = tasks.map((t, i) => {
    const phaseName = (t.phase_name || "구분").trim() || "구분";
    if (!phaseColorMap.has(phaseName)) {
      phaseColorMap.set(phaseName, PALETTE[colorIdx % PALETTE.length]);
      colorIdx++;
    }
    return {
      project_id: state.project.id,
      phase_name: phaseName,
      phase_color: phaseColorMap.get(phaseName),
      name: (t.name || "").trim(),
      owner: (t.owner || "").trim(),
      start_date: normalizeImportDate(t.start_date),
      end_date: normalizeImportDate(t.end_date),
      status: "todo",
      sort_order: maxOrder + 1 + i
    };
  }).filter(r => r.name);

  const { data, error } = await supabase.from("tasks").insert(rows).select();
  if (error) { console.error(error); throw new Error("저장에 실패했습니다: " + error.message); }
  state.tasks.push(...data);
  renderAll();
}

wireFeedbackUI();
initGate();
