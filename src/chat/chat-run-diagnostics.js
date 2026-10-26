// 에이전트 실행 실패 기록에서 민감정보를 제거하고 기록 길이를 제한한다.

const TRUNCATION_MARKER = "…(잘림)";

function redactSensitiveText(text) {
  if (typeof text !== "string") {
    return "";
  }

  return text
    // ANSI 이스케이프 코드를 제거한다.
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/\x9B[0-?]*[ -/]*[@-~]/g, "")
    // 인증 헤더와 Bearer 토큰 값을 제거한다.
    .replace(/(\bAuthorization\s*:\s*)[^\r\n]*/gi, "$1[REDACTED]")
    .replace(/(\bBearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    // Cookie·Set-Cookie 헤더는 "a=1; b=2"처럼 공백이 섞이므로 값 전체를 줄 끝까지 제거한다.
    // 이름=값 형태가 이어질 때만 헤더로 보고, 코드의 "cookie: string" 같은 표기는 남긴다.
    .replace(/(\b(?:set-)?cookie\s*:\s*)(?=[^\s;,=]+=)[^\r\n]*/gi, "$1[REDACTED]")
    // curl 쿠키 옵션 값을 제거한다. --cookie는 curl 전용 표기라 어디서나 보고,
    // -b는 다른 도구의 옵션과 겹치므로 같은 줄의 curl 뒤에서만 본다. -sSb처럼 붙여 쓴
    // 짧은 옵션도 b가 마지막이면 쿠키 값을 받는다.
    .replace(/(--cookie(?:\s+|=))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/gi, "$1[REDACTED]")
    .replace(/\bcurl\b[^\r\n]*/gi, (command) =>
      command.replace(/(\s-[A-Za-z]*b\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/g, "$1[REDACTED]"))
    // 알려진 API 키 및 토큰 접두사로 시작하는 값을 제거한다.
    .replace(
      /\b(?:sk-ant-|sk-|ghp_|gho_|xoxb-|xoxp-|AKIA)[A-Za-z0-9._-]+/gi,
      "[REDACTED]",
    )
    // xAI·Google·GitHub 세분화 토큰은 접두사가 패키지 이름과 겹칠 수 있어 길이까지 확인한다.
    // V8에서 {n,}은 수백만 자 단어에서 스택을 넘기므로 {n}과 *로 나눠 쓴다.
    .replace(
      /\b(?:xai-[A-Za-z0-9]{20}[A-Za-z0-9]*|ya29\.[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*|GOCSPX-[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*|AIza[A-Za-z0-9_-]{35}|github_pat_[A-Za-z0-9_]{20}[A-Za-z0-9_]*)/g,
      "[REDACTED]",
    )
    // OAuth id_token 등 JWT 형식 값을 제거한다.
    .replace(/\beyJ[\w-]{10}[\w-]*\.eyJ[\w-]{10}[\w-]*\.[\w-]*/g, "[REDACTED]")
    // 민감한 이름을 가진 환경변수 대입식의 값 부분을 제거한다.
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi,
      "$1[REDACTED]",
    )
    // 사용자 홈 디렉터리 경로에서 사용자 이름을 숨긴다.
    .replace(/C:[\\/]Users[\\/][^\\/\s]+/gi, "~")
    .replace(/\/(?:home|Users)\/[^/\s]+/g, "~");
}

function truncateEnd(text, maximumLength) {
  if (text.length <= maximumLength) {
    return text;
  }

  return (
    text.slice(0, maximumLength - TRUNCATION_MARKER.length) +
    TRUNCATION_MARKER
  );
}

function truncateStart(text, maximumLength) {
  if (text.length <= maximumLength) {
    return text;
  }

  return (
    TRUNCATION_MARKER +
    text.slice(-(maximumLength - TRUNCATION_MARKER.length))
  );
}

function buildRunDiagnostics(input) {
  const source = input && typeof input === "object" ? input : {};

  return {
    provider:
      source.provider === null || source.provider === undefined
        ? ""
        : String(source.provider),
    runId:
      source.runId === null || source.runId === undefined
        ? ""
        : String(source.runId),
    exitCode: Number.isInteger(source.exitCode) ? source.exitCode : null,
    lastError: truncateEnd(redactSensitiveText(source.lastError), 500),
    stderrTail: truncateStart(redactSensitiveText(source.stderr), 2048),
    approvalSummary: truncateEnd(
      redactSensitiveText(source.approvalSummary),
      200,
    ),
    approvalDetail: truncateEnd(
      redactSensitiveText(source.approvalDetail),
      2000,
    ),
    autoApprove: Boolean(source.autoApprove),
    approvedRetry: Boolean(source.approvedRetry),
  };
}

module.exports = {
  redactSensitiveText,
  buildRunDiagnostics,
};
