// PostToolUse(Write|Edit) hook: plan.md 등 .md 파일이 생성/수정되면 백업 스크립트 실행
const { execFileSync } = require("child_process");

let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(data);
    const filePath = (input.tool_input && input.tool_input.file_path) || "";
    if (/\.md$/i.test(filePath)) {
      const reason = "file:" + filePath.split(/[\\/]/).pop();
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
