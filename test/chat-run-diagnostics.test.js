const test = require("node:test");
const assert = require("node:assert/strict");

const {
  redactSensitiveText,
  buildRunDiagnostics,
} = require("../src/chat/chat-run-diagnostics");

test("인증 헤더와 토큰 및 민감한 환경변수 값을 제거한다", () => {
  const input = [
    "Bearer bearer-token-value",
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "OPENAI_KEY=sk-example",
    "ANTHROPIC_TOKEN=sk-ant-example",
    "GITHUB_SECRET=ghp_example",
    "GITHUB_CREDENTIAL=gho_example",
    "SLACK_BOT_TOKEN=xoxb-example",
    "SLACK_USER_TOKEN=xoxp-example",
    "AWS_PASSWORD=AKIAEXAMPLE123456",
  ].join("\n");

  const result = redactSensitiveText(input);

  assert.match(result, /Bearer \[REDACTED\]/);
  assert.match(result, /Authorization: \[REDACTED\]/);
  assert.match(result, /OPENAI_KEY=\[REDACTED\]/);
  assert.match(result, /ANTHROPIC_TOKEN=\[REDACTED\]/);
  assert.match(result, /GITHUB_SECRET=\[REDACTED\]/);
  assert.match(result, /GITHUB_CREDENTIAL=\[REDACTED\]/);
  assert.match(result, /SLACK_BOT_TOKEN=\[REDACTED\]/);
  assert.match(result, /SLACK_USER_TOKEN=\[REDACTED\]/);
  assert.match(result, /AWS_PASSWORD=\[REDACTED\]/);

  assert.doesNotMatch(result, /bearer-token-value/);
  assert.doesNotMatch(result, /dXNlcjpwYXNzd29yZA/);
  assert.doesNotMatch(result, /sk-example/);
  assert.doesNotMatch(result, /sk-ant-example/);
  assert.doesNotMatch(result, /ghp_example/);
  assert.doesNotMatch(result, /gho_example/);
  assert.doesNotMatch(result, /xoxb-example/);
  assert.doesNotMatch(result, /xoxp-example/);
  assert.doesNotMatch(result, /AKIAEXAMPLE123456/);
});

test("xAI·Google·GitHub 세분화 토큰과 JWT를 제거하고 비슷한 패키지 이름은 남긴다", () => {
  // 실제 토큰 형식과 같은 문자열은 저장소 비밀 검사에 걸리므로 실행 시 조립한다.
  const secrets = [
    "xai-" + "A1".repeat(20),
    "ya29." + "a0Ab".repeat(8),
    "GOCSPX-" + "Qw".repeat(14),
    "AIza" + "Sy".repeat(17) + "Z",
    "github_pat_" + "11AB".repeat(8),
    "eyJhbGciOiJSUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" + ".c2lnbmF0dXJl",
  ];
  const result = redactSensitiveText(`${secrets.join("\n")}\nnpm install @xai-official/grok`);

  for (const secret of secrets) assert.equal(result.includes(secret), false, secret.slice(0, 8));
  assert.match(result, /@xai-official\/grok/);
});

test("Cookie·Set-Cookie 헤더는 공백이 섞인 값 전체를 가리고 코드 속 cookie 표기는 남긴다", () => {
  const headers = [
    "Cookie: session=synthetic; other=synthetic2",
    "< set-cookie: sid=synthetic3; Path=/; HttpOnly",
    'curl -H "Cookie: a=synthetic4; b=synthetic5" https://example.com/api',
  ];
  const result = redactSensitiveText(headers.join("\n"));

  assert.doesNotMatch(result, /synthetic/);
  assert.deepEqual(result.split("\n"), [
    "Cookie: [REDACTED]",
    "< set-cookie: [REDACTED]",
    'curl -H "Cookie: [REDACTED]',
  ]);

  const code = "const cookie: string = readCookie();\nThe cookie: it is stored per site.";
  assert.equal(redactSensitiveText(code), code);
});

test("curl 쿠키 옵션 값은 가리고 다른 도구의 -b 옵션과 쿠키 파일 경로는 남긴다", () => {
  const commands = [
    'curl -b "session=synthetic-a; other=synthetic-b" https://example.com/api',
    "curl --cookie 'sid=synthetic-c' https://example.com",
    "curl -sSLb sid=synthetic-d https://example.com",
    'curl.exe -b "a=synthetic-e" https://example.com',
  ];
  const result = redactSensitiveText(commands.join("\n"));

  assert.doesNotMatch(result, /synthetic/);
  assert.deepEqual(result.split("\n"), [
    "curl -b [REDACTED] https://example.com/api",
    "curl --cookie [REDACTED] https://example.com",
    "curl -sSLb [REDACTED] https://example.com",
    "curl.exe -b [REDACTED] https://example.com",
  ]);

  const unrelated = "git checkout -b feature-branch\npython bench.py -b 1\ncurl --cookie-jar jar.txt https://example.com";
  assert.equal(redactSensitiveText(unrelated), unrelated);
});

test("cookie: 가 반복되는 긴 줄도 선형 시간 안에 처리한다", () => {
  // 이름 길이 제한이 없으면 28만 자 입력에 15초 넘게 걸립니다.
  const started = Date.now();
  redactSensitiveText("cookie:".repeat(40_000));
  assert.ok(Date.now() - started < 2000, `${Date.now() - started}ms`);
});

test("'-'로 이어진 eyJ가 반복되는 긴 단어도 선형 시간 안에 처리한다", () => {
  // \b로 시작하면 51만 자 입력에 20초 넘게 걸립니다.
  const started = Date.now();
  redactSensitiveText("eyJaaaaaaaaaaaa-".repeat(32_000));
  assert.ok(Date.now() - started < 2000, `${Date.now() - started}ms`);
});

test("토큰 접두사로 시작하는 수백만 자 출력도 예외 없이 처리한다", () => {
  // base64url로 인코딩한 큰 JSON 등은 eyJ로 시작하는 긴 단어가 됩니다.
  const tail = "a".repeat(10_000_000);
  for (const prefix of ["eyJ", "xai-", "ya29.", "GOCSPX-", "github_pat_", "Cookie: a=", "curl -b ", "--cookie "]) {
    assert.doesNotThrow(() => redactSensitiveText(prefix + tail), prefix);
  }
});

test("사용자 홈 디렉터리 경로를 물결표로 치환한다", () => {
  const input =
    "C:\\Users\\아무개\\project C:/Users/Another/project /home/아무개/project /Users/someone/project";

  assert.equal(
    redactSensitiveText(input),
    "~\\project ~/project ~/project ~/project",
  );
});

test("stderr 꼬리는 제한 길이 안에서 마지막 부분과 잘림 표시를 보존한다", () => {
  const preservedTail = "마지막 오류 내용";
  const stderr = `${"앞".repeat(3000)}${preservedTail}`;

  const diagnostics = buildRunDiagnostics({ stderr });

  assert.ok(diagnostics.stderrTail.length <= 2048);
  assert.ok(diagnostics.stderrTail.startsWith("…(잘림)"));
  assert.ok(diagnostics.stderrTail.endsWith(preservedTail));
});

test("마지막 오류는 500자를 넘지 않고 잘림 표시를 남긴다", () => {
  const diagnostics = buildRunDiagnostics({
    lastError: "오류".repeat(400),
  });

  assert.ok(diagnostics.lastError.length <= 500);
  assert.ok(diagnostics.lastError.endsWith("…(잘림)"));
});

test("승인 상태 입력을 Boolean 값으로 강제한다", () => {
  const truthy = buildRunDiagnostics({
    autoApprove: "yes",
    approvedRetry: 1,
  });
  const falsy = buildRunDiagnostics({
    autoApprove: "",
    approvedRetry: 0,
  });

  assert.equal(truthy.autoApprove, true);
  assert.equal(truthy.approvedRetry, true);
  assert.equal(falsy.autoApprove, false);
  assert.equal(falsy.approvedRetry, false);
});

test("종료 코드가 정수가 아니면 null로 정규화한다", () => {
  assert.equal(buildRunDiagnostics({ exitCode: 1 }).exitCode, 1);
  assert.equal(buildRunDiagnostics({ exitCode: "1" }).exitCode, null);
  assert.equal(buildRunDiagnostics({ exitCode: 1.5 }).exitCode, null);
  assert.equal(buildRunDiagnostics({}).exitCode, null);
});

test("문자열이 아닌 값은 빈 문자열로 정규화한다", () => {
  assert.equal(redactSensitiveText(undefined), "");
  assert.equal(redactSensitiveText(null), "");
  assert.equal(redactSensitiveText(123), "");
  assert.equal(redactSensitiveText({ text: "secret" }), "");
});

test("ANSI 이스케이프 코드를 제거한다", () => {
  assert.equal(redactSensitiveText("\u001b[31m오류\u001b[0m"), "오류");
});

test("모든 진단 텍스트 필드를 빈 문자열이라도 포함한다", () => {
  const diagnostics = buildRunDiagnostics();

  assert.deepEqual(diagnostics, {
    provider: "",
    runId: "",
    exitCode: null,
    lastError: "",
    stderrTail: "",
    approvalSummary: "",
    approvalDetail: "",
    autoApprove: false,
    approvedRetry: false,
  });
});
