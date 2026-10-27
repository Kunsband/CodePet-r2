// 에이전트 실행 실패 기록에서 민감정보를 제거하고 기록 길이를 제한한다.

const TRUNCATION_MARKER = "…(잘림)";

// curl의 -b·--cookie 값을 가린다. curl이 명령의 첫 단어가 아니어도(timeout 10 curl, xargs curl,
// if curl, JSON에 담긴 "bash -lc 'curl …'") 같은 명령 구간에서 curl 뒤에 오면 가리되, 셸처럼
// 따옴표·이스케이프·줄 이음(\ ^ `)·명령 구분자(; | && ( ) ` #)를 해석해 구분자 뒤 다른 명령의
// -b(git checkout -b, cut -b)는 남긴다. 따옴표 구간 안에 든 명령도 4단계까지 들여다본다.
// 단어를 모으지 않고 한 번에 처리하며, 문자를 훑는 횟수가 중첩 깊이로 제한되어 선형 시간이다.
const CURL_ARGUMENT_OPTIONS = new Set("AbcCdDeEFHKmoPQrtTuUwxXyYz");
const MAX_NESTED_COMMAND_DEPTH = 4;
const MAX_QUOTED_VALUE_EXTENSION = 4096;

function isLineContinuation(text, index) {
  const next = text[index + 1];
  return next === "\n" || (next === "\r" && text[index + 2] === "\n");
}

function isBlank(char) {
  return char === undefined || char === " " || char === "\t" || char === "\r" || char === "\n";
}

// & 하나는 URL 쿼리(a=1&b=2)나 2>&1에도 쓰이므로, &&이거나 앞뒤가 공백일 때만 구분자로 본다.
function isSeparator(text, index) {
  const char = text[index];
  if (char === ";" || char === "|" || char === "(" || char === ")" || char === "`") return true;
  if (char !== "&") return false;
  const previous = text[index - 1];
  const next = text[index + 1];
  return next === "&" || previous === "&" || isBlank(next) || previous === " " || previous === "\t";
}

function scanCommands(text, from, to, spans, depth) {
  // 한 명령 구간의 상태: curl을 지났는지, 다음 단어를 가릴지(-b 값), 건너뛸지(다른 옵션의 값)
  let curlSeen = false;
  let maskNext = false;
  let skipNext = false;
  const maskWord = (start, end, openQuote) => {
    // 줄을 넘는 따옴표 값은 닫는 따옴표까지 가린다(멀리 있으면 줄 끝까지만).
    if (openQuote) {
      const close = text.slice(end, end + MAX_QUOTED_VALUE_EXTENSION).indexOf(openQuote);
      if (close !== -1) end += close + 1;
    }
    spans.push([start, end]);
  };
  const handleWord = (start, end, quoted, openQuote) => {
    if (maskNext) {
      maskNext = false;
      maskWord(start, end, openQuote);
      return;
    }
    // 단어마다 문자열을 잘라 정규식을 돌리지 않도록, 필요한 경우에만 확인한다.
    if (skipNext) {
      skipNext = false;
    } else if (text.startsWith("--cookie", start)) {
      if (end === start + 8) {
        maskNext = true;
        return;
      }
      if (text[start + 8] === "=") {
        maskWord(start + 9, end, openQuote);
        return;
      }
    } else if (curlSeen && text[start] === "-" && end - start > 1 && text[start + 1] !== "-") {
      // -sSLb 값처럼 붙여 쓴 짧은 옵션: b보다 앞에 인자를 받는 옵션이 있으면 그 뒤는 그 옵션의 값이다.
      for (let at = start + 1; at < end; at += 1) {
        if (text[at] === "b") {
          if (at + 1 < end) maskWord(at + 1, end, openQuote);
          else maskNext = true;
          return;
        }
        if (CURL_ARGUMENT_OPTIONS.has(text[at])) {
          if (at + 1 === end) skipNext = true;
          return;
        }
      }
      return;
    } else if (end - start >= 4 && /[le]["'^]*$/i.test(text.slice(Math.max(start, end - 8), end))
      && /(?:^|[\\/])curl(?:\.exe)?$/i.test(text.slice(start, end).replace(/["'^]/g, ""))) {
      curlSeen = true;
    }
    if (quoted && depth < MAX_NESTED_COMMAND_DEPTH) {
      for (const [quoteFrom, quoteTo] of quoted) {
        if (/curl|--cookie/i.test(text.slice(quoteFrom, quoteTo))) scanCommands(text, quoteFrom, quoteTo, spans, depth + 1);
      }
    }
  };
  let index = from;
  while (index < to) {
    const char = text[index];
    if ((char === "\\" || char === "^" || char === "`") && isLineContinuation(text, index)) {
      index += text[index + 1] === "\r" ? 3 : 2;
      continue;
    }
    // #로 시작하는 단어부터는 주석이므로 다른 명령으로 본다. 주석 안의 curl 예시는 계속 살핀다.
    if (char === "\n" || char === "#" || isSeparator(text, index)) {
      curlSeen = false;
      maskNext = false;
      skipNext = false;
      index += 1;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      index += 1;
      continue;
    }
    const start = index;
    let quoted = null;
    let quote = null;
    let quoteStart = -1;
    while (index < to) {
      const current = text[index];
      if (quote) {
        if (current === "\n") break;
        if (current === "\\" && quote === '"' && index + 1 < to && text[index + 1] !== "\n") {
          index += 2;
          continue;
        }
        if (current === quote) {
          (quoted || (quoted = [])).push([quoteStart + 1, index]);
          quote = null;
        }
        index += 1;
        continue;
      }
      if (current === '"' || current === "'") {
        quote = current;
        quoteStart = index;
        index += 1;
        continue;
      }
      if ((current === "\\" || current === "^" || current === "`") && isLineContinuation(text, index)) break;
      // \x는 bash, ^x는 cmd의 이스케이프이므로 다음 문자까지 같은 단어로 본다(sid=a^&b=1).
      if ((current === "\\" || current === "^") && index + 1 < to && text[index + 1] !== "\n") {
        index += 2;
        continue;
      }
      if (isBlank(current) || isSeparator(text, index)) break;
      index += 1;
    }
    if (quote) (quoted || (quoted = [])).push([quoteStart + 1, index]);
    handleWord(start, index, quoted, quote);
  }
}

function redactCurlCookies(text) {
  if (!/curl|--cookie/i.test(text)) return text;
  const spans = [];
  scanCommands(text, 0, text.length, spans, 0);
  if (spans.length === 0) return text;
  // 단어 순서대로 쌓이므로 대개 이미 정렬돼 있다. 어긋났을 때만 정렬한다.
  if (spans.some((span, i) => i > 0 && span[0] < spans[i - 1][0])) spans.sort((left, right) => left[0] - right[0]);
  const parts = [];
  let copied = 0;
  for (const [start, end] of spans) {
    if (start < copied || end <= start) continue;
    parts.push(text.slice(copied, start), "[REDACTED]");
    copied = end;
  }
  parts.push(text.slice(copied));
  return parts.join("");
}

// Scan each base64url run once. A '-' remains a valid JWT boundary, without
// retrying the rest of a long run at every '-eyJ' occurrence.
function redactJwt(text) {
  const runs = /[\w-]+/g;
  const payload = /eyJ[\w-]{10}[\w-]*\.[\w-]*/y;
  const parts = [];
  let copied = 0, match;
  while ((match = runs.exec(text))) {
    const candidate = /(?:^|-)eyJ/.exec(match[0]);
    if (!candidate) continue;
    const start = match.index + candidate.index + (candidate[0][0] === '-' ? 1 : 0);
    if (runs.lastIndex - start < 13 || text[runs.lastIndex] !== '.') continue;
    payload.lastIndex = runs.lastIndex + 1;
    if (!payload.test(text)) continue;
    parts.push(text.slice(copied, start), '[REDACTED]');
    copied = runs.lastIndex = payload.lastIndex;
  }
  parts.push(text.slice(copied));
  return parts.join('');
}

function redactSensitiveText(text) {
  if (typeof text !== "string") {
    return "";
  }

  const withoutHeaders = text
    // ANSI 이스케이프 코드를 제거한다.
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/\x9B[0-?]*[ -/]*[@-~]/g, "")
    // 인증 헤더와 Bearer 토큰 값을 제거한다.
    .replace(/(\bAuthorization\s*:\s*)[^\r\n]*/gi, "$1[REDACTED]")
    .replace(/(\bBearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    // Cookie·Set-Cookie 헤더는 "a=1; b=2"처럼 공백이 섞이므로 값 전체를 줄 끝까지 제거한다.
    // 같은 줄에서 HTTP 토큰 문자로 된 이름=값이 이어질 때만 헤더로 보아, 코드의
    // "cookie: string"이나 압축된 JS의 "cookie:function(e){…}", "cookie:e=>…" 같은 표기는 남긴다.
    // HTTP 토큰에는 콜론이 없어 긴 이름도 cookie: 사이를 다시 훑지 않는다.
    // == 뒤의 &·? 등도 유효한 쿠키 값이다. 비교식 오탐 예외는 JS 객체의
    // {cookie:… / ,cookie:… 위치에만 적용하고 실제 헤더 값은 전부 가린다.
    .replace(/(\b(?:set-)?cookie[ \t]*:[ \t]*)(?=[!#$%&'*+.^_`|~0-9A-Za-z-]+=(?!>))[^\r\n]*/gi,
      (header, prefix, offset, input) => {
        const before = input.slice(Math.max(0, offset - 256), offset);
        const value = header.slice(prefix.length);
        if (/[{,][ \t]*$/.test(before)
          && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+==[^\s;"'\\?,(){}&|!<>]{0,256}[?,(){}&|!<>]/.test(value)) return header;
        return prefix + "[REDACTED]";
      });

  return redactJwt(redactCurlCookies(withoutHeaders))
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
