import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.APP_CONFIG;
const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const PALETTE = Array.from({ length: 30 }, (_, i) => getComputedStyle(document.documentElement).getPropertyValue(`--p${i + 1}`).trim());
const STATUS_LABEL = { todo: "예정", doing: "진행중", done: "완료" };
const DAYPX = 28;

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

// ---------- entry (no password gate: anyone with the link can edit) ----------
function getProjectIdFromUrl() {
  return new URLSearchParams(location.search).get("p");
}

async function initGate() {
  state.editMode = true;
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
let selectedProjectIds = new Set();

async function enterLanding() {
  logPageView("landing", null);
  const { data, error } = await supabase.from("projects").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  landingProjects = data || [];
  renderLanding();
  wireLandingUI();
  $("#landing").hidden = false;
}
function renderLanding() {
  const list = $("#projectList");
  if (!landingProjects.length) {
    list.innerHTML = `<div class="empty-note">아직 만들어진 프로젝트가 없습니다. 아래에서 새로 만들어보세요.</div>`;
  } else {
    list.innerHTML = landingProjects.map(p => `
      <div class="project-card" data-id="${p.id}">
        <label class="pc-check"><input type="checkbox" class="pc-checkbox" data-id="${p.id}" ${selectedProjectIds.has(p.id) ? "checked" : ""}></label>
        <a class="pc-body" href="?p=${p.id}">
          <div class="pc-eyebrow">${escapeHtml(p.org || "")}${p.dept ? " / " + escapeHtml(p.dept) : ""}</div>
          <div class="pc-name">${escapeHtml(p.name || "(제목 없음)")} 추진일정</div>
          <div class="pc-meta">생성일 ${p.created_at ? p.created_at.slice(0, 10) : ""}</div>
        </a>
        <button type="button" class="pc-del" data-id="${p.id}" aria-label="삭제">✕</button>
      </div>
    `).join("");
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
    const name = $("#newNameInput").value.trim();
    if (!name) { $("#newNameInput").focus(); return; }
    const { data, error } = await supabase.from("projects").insert({ org, dept, name }).select().single();
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
  $("#app").hidden = false;
  $("#modeBadge").textContent = "✏️ 편집 가능";
  $("#modeBadge").classList.add("edit");
  renderAll();
  wireStaticUI();
  subscribeRealtime();
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
function renderHeader() {
  const p = state.project;
  if (!p) return;
  $("#orgInput").value = p.org || "";
  $("#deptInput").value = p.dept || "";
  $("#projNameInput").value = p.name || "";
  const disabled = !state.editMode;
  $("#orgInput").disabled = disabled;
  $("#deptInput").disabled = disabled;
  $("#projNameInput").disabled = disabled;
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
  tbody.innerHTML = state.tasks.map((t, idx) => `
    <tr draggable="${state.editMode}" data-id="${t.id}">
      <td class="col-drag"><span class="drag-handle">⠿</span></td>
      <td><span class="phase-pill" style="background:${t.phase_color}" data-action="color" data-id="${t.id}">
        <input value="${escapeHtml(t.phase_name)}" data-field="phase_name" data-id="${t.id}" ${dis}>
      </span></td>
      <td><input value="${escapeHtml(t.name)}" data-field="name" data-id="${t.id}" ${dis} placeholder="업무명"></td>
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
  `).join("");

  tbody.querySelectorAll("input,select").forEach(el => {
    el.addEventListener("change", () => updateTaskField(el.dataset.id, el.dataset.field, el.value));
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
function buildGanttHtml(tasks, daypx) {
  const dated = tasks.filter(t => t.start_date && t.end_date);
  if (!dated.length) return `<div style="color:var(--ink-muted);font-size:12px;padding:10px;">시작일/종료일을 입력하면 타임라인이 표시됩니다.</div>`;
  const minDate = dated.reduce((m, t) => t.start_date < m ? t.start_date : m, dated[0].start_date);
  const maxDate = dated.reduce((m, t) => t.end_date > m ? t.end_date : m, dated[0].end_date);
  const totalDays = Math.max(1, daysBetween(minDate, maxDate) + 1);
  const rulerCols = [];
  for (let i = 0; i <= totalDays; i += 7) rulerCols.push(i);
  let html = `<div class="gantt-ruler" style="width:${totalDays * daypx}px">`;
  rulerCols.forEach(d => {
    const dt = new Date(minDate); dt.setDate(dt.getDate() + d);
    html += `<span style="width:${7 * daypx}px;flex:none">${dt.getMonth() + 1}/${dt.getDate()}</span>`;
  });
  html += `</div>`;
  tasks.forEach(t => {
    if (!t.start_date || !t.end_date) return;
    const off = daysBetween(minDate, t.start_date);
    const len = Math.max(1, daysBetween(t.start_date, t.end_date) + 1);
    html += `<div class="gantt-row" style="grid-template-columns:160px 1fr;width:${160 + totalDays * daypx}px">
      <div class="gantt-row-label">${escapeHtml(t.name || "(제목 없음)")}</div>
      <div class="gantt-track" style="width:${totalDays * daypx}px">
        <div class="gantt-bar" style="left:${off * daypx}px;width:${len * daypx - 3}px;background:${t.phase_color}" title="${escapeHtml(t.name)}"></div>
      </div>
    </div>`;
  });
  return html;
}

function renderCards() {
  const list = $("#cardList");
  const dis = !state.editMode ? "disabled" : "";
  list.innerHTML = state.tasks.map((t, idx) => `
    <div class="task-card" data-id="${t.id}">
      <div class="card-top">
        <span class="phase-pill" style="background:${t.phase_color}" data-action="color" data-id="${t.id}">
          <input value="${escapeHtml(t.phase_name)}" data-field="phase_name" data-id="${t.id}" ${dis}>
        </span>
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
  `).join("");

  list.querySelectorAll("input,select").forEach(el => {
    el.addEventListener("change", () => updateTaskField(el.dataset.id, el.dataset.field, el.value));
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
  picker.style.top = (window.scrollY + rect.bottom + 6) + "px";
  picker.style.left = Math.min(window.scrollX + rect.left, window.innerWidth - 220) + "px";
  const current = state.tasks.find(t => t.id === taskId)?.phase_color;
  picker.innerHTML = PALETTE.map(c => `<span class="color-swatch ${c === current ? "selected" : ""}" style="background:${c}" data-color="${c}"></span>`).join("");
  picker.hidden = false;
  picker.querySelectorAll(".color-swatch").forEach(sw => {
    sw.addEventListener("click", () => {
      updateTaskField(taskId, "phase_color", sw.dataset.color);
      picker.hidden = true;
    });
  });
  const closeOnOutside = (e) => {
    if (!picker.contains(e.target)) { picker.hidden = true; document.removeEventListener("click", closeOnOutside, true); }
  };
  setTimeout(() => document.addEventListener("click", closeOnOutside, true), 0);
}

// ---------- mobile gantt overlay ----------
function wireStaticUI() {
  $("#orgInput").addEventListener("change", () => updateProjectField("org", $("#orgInput").value));
  $("#deptInput").addEventListener("change", () => updateProjectField("dept", $("#deptInput").value));
  $("#projNameInput").addEventListener("change", () => updateProjectField("name", $("#projNameInput").value));
  $("#addTaskBtnDesktop").addEventListener("click", addTask);
  $("#addTaskBtnMobile").addEventListener("click", addTask);
  $("#addTaskBtnDesktop").hidden = !state.editMode;
  $("#addTaskBtnMobile").hidden = !state.editMode;
  $("#timelineOpenBtn").addEventListener("click", () => {
    $("#ganttOverlayBody").innerHTML = buildGanttHtml(state.tasks, 18);
    $("#ganttOverlay").hidden = false;
  });
  $("#timelineCloseBtn").addEventListener("click", () => { $("#ganttOverlay").hidden = true; });
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
