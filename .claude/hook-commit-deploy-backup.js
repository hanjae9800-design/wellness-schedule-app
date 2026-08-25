// PostToolUse(Bash) hook: git commit / wrangler pages deploy 실행 시 백업 스크립트 실행
const { execFileSync } = require("child_process");

let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(data);
    const cmd = (input.tool_input && input.tool_input.command) || "";
    let reason = null;
    if (/\bgit\s+commit\b/.test(cmd)) reason = "commit";
    else if (/wrangler\s+pages\s+deploy\b/.test(cmd)) reason = "deploy";
    if (reason) {
      execFileSync(
        "bash",
        [__dirname + "/backup-to-github.sh", reason],
        { stdio: "ignore" }
      );
    }
  } catch (e) {
    // 백업 실패가 작업 흐름을 막지 않도록 무시
  }
});
