// PostToolUse(Bash) hook: git commit 또는 wrangler pages deploy 실행 시
// 실제 사이트 코드 변경사항을 GitHub에 자동 커밋+푸시
const { execFileSync } = require("child_process");
const path = require("path");

let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(data);
    const cmd = (input.tool_input && input.tool_input.command) || "";
    if (!/\bgit\s+commit\b/.test(cmd) && !/wrangler\s+pages\s+deploy\b/.test(cmd)) return;
    const projectDir = process.env.CLAUDE_PROJECT_DIR || path.join(__dirname, "..");
    const opts = { cwd: projectDir, stdio: "ignore", timeout: 20000 };
    execFileSync("git", ["add", "-A"], opts);
    try {
      execFileSync("git", ["diff", "--cached", "--quiet"], opts);
    } catch (e) {
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      execFileSync("git", ["commit", "-m", `자동 백업 (배포 체크포인트) ${ts}`], opts);
    }
    execFileSync("git", ["push"], opts);
  } catch (e) {
    // 실패해도 작업 흐름을 절대 막지 않음 (네트워크 문제, 인증 만료 등)
  }
});
