# Release notes / 릴리즈 노트

## 1.0.6 — 2026-10-14

### English

- Fixed agent runs stopping at the default 2 MiB cumulative output limit.
- Chat opens with up to 50 recent messages and loads older history when scrolling upward.
- Preserved the reading position during history loading and incoming replies; added retry for failed history loads.
- Reduced chat memory use and batched streaming display updates.
- Updated the English and Korean guides with current chat features and usage.

### 한국어

- 누적 출력이 기본 2MiB 제한을 넘으면 에이전트 실행이 중단되던 문제를 수정했습니다.
- 최근 대화를 최대 50개씩 표시하고 위로 스크롤하면 이전 기록을 불러옵니다.
- 이전 기록을 불러오거나 새 답변이 도착해도 읽던 위치를 유지하며, 기록 로딩 실패 시 재시도를 지원합니다.
- 채팅 메모리 사용량과 스트리밍 화면 갱신을 개선했습니다.
- 영어·한국어 사용 안내를 현재 채팅 기능과 사용법에 맞춰 갱신했습니다.
