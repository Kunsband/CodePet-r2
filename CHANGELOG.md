# Release notes / 릴리즈 노트

## 1.0.9 — 2026-10-15

### English

- Added Claude and Grok accounts as separate chat participants alongside Codex.
- Unified account selection with independent logins, model choices, mentions, and task traces.
- Fixed AGY command approval requests being shown as errors, and prevented sandbox setup failures from offering an unsandboxed retry.
- Fixed Windows sandbox login conflicts between Codex account participants.
- Fixed Claude's PowerShell execution when using the Microsoft Store version of PowerShell.
- Aligned the pet and notification settings.
- Added access to in-progress commands and full tool records, with paged compression instead of trace size limits or automatic expiry.
- Removed the remaining cumulative output limit from Grok's Docker write runs.

### 한국어

- Codex에 이어 Claude·Grok의 저장 계정도 별도 채팅 참가자로 추가할 수 있습니다.
- 계정 선택을 하나로 통합하고 로그인·모델 선택·멘션·작업 기록을 참가자별로 구분합니다.
- AGY 명령 승인 요청이 오류로 표시되는 문제를 수정하고, 샌드박스 초기화 실패 시 격리 해제 재시도를 제안하지 않도록 했습니다.
- 여러 Codex 계정이 참여할 때 Windows 샌드박스 로그인이 충돌하는 문제를 수정했습니다.
- Microsoft Store판 PowerShell을 사용할 때 Claude의 명령 실행이 실패하는 문제를 수정했습니다.
- 펫과 알림 설정의 항목 정렬을 수정했습니다.
- 실행 중 명령과 전체 도구 기록을 조회할 수 있도록 하고, 기록의 용량·보존 기간 제한을 분할 압축 저장으로 대체했습니다.
- Grok의 Docker 쓰기 실행에 남아 있던 누적 출력량 제한을 제거했습니다.

## 1.0.8 — 2026-10-15

### English

- Added Work mode to hide the pet, character avatars, and emotes.
- Deliver group messages to all selected agents at once and show replies as they finish. Discussions retain turn order.
- Added separate Codex account participants with independent mentions, model settings, and task traces, using one CLI installation.
- Applied the existing font-size setting to chat messages and the input.

### 한국어

- 펫과 채팅 캐릭터·이모티콘을 숨기는 회사 모드를 추가했습니다.
- 여러 수신자에게 같은 메시지를 동시에 전달하고 완료 순서대로 답변을 표시합니다. 토론은 기존 순서를 유지합니다.
- CLI 추가 설치 없이 Codex 계정별 참가자·멘션·모델 설정·작업 기록을 구분합니다.
- 기존 글자 크기 설정을 채팅 본문과 입력창에도 적용했습니다.

## 1.0.7 — 2026-10-14

### English

- Restored each agent's original character emoticons.
- Removed bundled model and reasoning lists and automatic overrides. Choices are retrieved from the installed CLI; failed lookups and unsupported saved selections block execution.
- Distinguished missing CLI, required login, and model lookup failures; recheck unavailable agents when returning to the chat.

### 한국어

- 에이전트마다 원래 캐릭터 이모티콘을 사용하도록 복구했습니다.
- 고정 모델·추론 목록과 임의 기본 선택을 제거했습니다. 설치된 CLI에서 선택지를 조회하며, 조회 실패나 지원되지 않는 저장 설정으로는 실행하지 않습니다.
- CLI 미설치·로그인 필요·모델 조회 실패를 구분하고 채팅으로 돌아오면 사용할 수 없던 에이전트를 다시 확인합니다.

## 1.0.6 — 2026-10-14

### English

- Agents can retrieve one another's saved tool activity and results within the same chat, without expanding workspace permissions.
- Trace storage is capped at 64KiB per run, 1MiB per chat, and 16MiB overall, with seven-day retention and credential redaction.
- Fixed agent runs stopping at the default 2 MiB cumulative output limit.
- Chat opens with up to 50 recent messages and loads older history when scrolling upward.
- Preserved the reading position during history loading and incoming replies; added retry for failed history loads.
- Reduced chat memory use and batched streaming display updates.
- Updated the English and Korean guides with current chat features and usage.

### 한국어

- 같은 대화방의 에이전트들이 필요할 때 서로의 도구 실행·결과 기록을 조회합니다. 워크스페이스 권한은 유지합니다.
- 작업 기록을 실행당 64KiB·대화방당 1MiB·전체 16MiB·최대 7일로 제한하고 자격 증명 패턴을 가립니다.
- 누적 출력이 기본 2MiB 제한을 넘으면 에이전트 실행이 중단되던 문제를 수정했습니다.
- 최근 대화를 최대 50개씩 표시하고 위로 스크롤하면 이전 기록을 불러옵니다.
- 이전 기록을 불러오거나 새 답변이 도착해도 읽던 위치를 유지하며, 기록 로딩 실패 시 재시도를 지원합니다.
- 채팅 메모리 사용량과 스트리밍 화면 갱신을 개선했습니다.
- 영어·한국어 사용 안내를 현재 채팅 기능과 사용법에 맞춰 갱신했습니다.
