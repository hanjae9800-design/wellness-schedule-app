import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.APP_CONFIG;
const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const $ = (sel) => document.querySelector(sel);

let feedbackRows = [];
let currentFilter = "open";

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function boot() {
  try {
    await Promise.all([loadStats(), loadFeedback()]);
    wireUI();
  } catch (e) {
    console.error(e);
    $("#loadingVeil").textContent = "불러오는 중 오류가 발생했습니다: " + (e?.message || e);
    return;
  }
  $("#app").hidden = false;
  $("#loadingVeil").hidden = true;
}

async function loadStats() {
  const [{ count: projectCount }, { count: taskCount }, { count: viewCount }, { data: views }] = await Promise.all([
    supabase.from("projects").select("id", { count: "exact", head: true }),
    supabase.from("tasks").select("id", { count: "exact", head: true }),
    supabase.from("page_views").select("id", { count: "exact", head: true }),
    supabase.from("page_views").select("created_at").order("created_at", { ascending: false }).limit(5000)
  ]);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayCount = (views || []).filter(v => new Date(v.created_at) >= today).length;

  $("#statGrid").innerHTML = `
    <div class="stat-box"><div class="sk">전체 프로젝트</div><div class="sv">${projectCount ?? 0}</div></div>
    <div class="stat-box"><div class="sk">전체 업무</div><div class="sv">${taskCount ?? 0}</div></div>
    <div class="stat-box"><div class="sk">누적 방문</div><div class="sv">${viewCount ?? 0}</div></div>
    <div class="stat-box"><div class="sk">오늘 방문</div><div class="sv">${todayCount}</div></div>
  `;
  renderViewChart(views || []);
}

function renderViewChart(views) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    days.push(d);
  }
  const counts = days.map(d => {
    const next = new Date(d); next.setDate(next.getDate() + 1);
    return views.filter(v => { const t = new Date(v.created_at); return t >= d && t < next; }).length;
  });
  const max = Math.max(1, ...counts);
  $("#viewChart").innerHTML = days.map((d, i) => `
    <div class="bar-col">
      <div class="bar-count">${counts[i]}</div>
      <div class="bar-fill" style="height:${Math.max(2, counts[i] / max * 80)}px"></div>
      <div class="bar-label">${d.getMonth() + 1}/${d.getDate()}</div>
    </div>
  `).join("");
}

async function loadFeedback() {
  const { data, error } = await supabase.from("feedback").select("*, projects(name)").order("created_at", { ascending: false });
  if (error) throw error;
  feedbackRows = data || [];
  renderFeedback();
}
function renderFeedback() {
  const rows = feedbackRows.filter(f => currentFilter === "all" ? true : currentFilter === "open" ? f.status !== "resolved" : f.status === "resolved");
  const list = $("#feedbackList");
  if (!rows.length) {
    list.innerHTML = `<div class="empty-note">해당하는 피드백이 없습니다.</div>`;
    return;
  }
  list.innerHTML = rows.map(f => `
    <div class="feedback-card ${f.status === "resolved" ? "resolved" : ""}" data-id="${f.id}">
      <div class="feedback-top">
        <span class="feedback-meta">${fmtDateTime(f.created_at)}${f.projects?.name ? " · " + escapeHtml(f.projects.name) : ""}</span>
      </div>
      <div class="feedback-msg">${escapeHtml(f.message)}</div>
      <div class="feedback-actions">
        <button type="button" class="resolve-btn" data-action="toggle" data-id="${f.id}">${f.status === "resolved" ? "미해결로 되돌리기" : "해결 처리"}</button>
        <button type="button" class="del-btn" data-action="del" data-id="${f.id}">삭제</button>
      </div>
    </div>
  `).join("");
  list.querySelectorAll('[data-action="toggle"]').forEach(btn => {
    btn.addEventListener("click", () => toggleFeedback(btn.dataset.id));
  });
  list.querySelectorAll('[data-action="del"]').forEach(btn => {
    btn.addEventListener("click", () => deleteFeedback(btn.dataset.id));
  });
}
async function toggleFeedback(id) {
  const row = feedbackRows.find(f => f.id === id);
  if (!row) return;
  const newStatus = row.status === "resolved" ? "open" : "resolved";
  row.status = newStatus;
  renderFeedback();
  await supabase.from("feedback").update({ status: newStatus }).eq("id", id);
}
async function deleteFeedback(id) {
  if (!confirm("이 피드백을 삭제할까요?")) return;
  feedbackRows = feedbackRows.filter(f => f.id !== id);
  renderFeedback();
  await supabase.from("feedback").delete().eq("id", id);
}

function wireUI() {
  $("#feedbackFilter").querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      currentFilter = chip.dataset.filter;
      $("#feedbackFilter").querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === chip));
      renderFeedback();
    });
  });
}

boot();
