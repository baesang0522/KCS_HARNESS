# Coder·Reviewer 개발 작업 절차

이 문서는 `baesang0522/KCS_HARNESS`의 Issue를 구현하고 별도 리뷰를 거쳐 병합하는 수동 작업 안내다. 기능 사용법은 [사용 안내](usage.md), 수정할 코드 위치는 [코드 지도](architecture.md), 개발 계획과 과거 기록은 [개발 계획](development.md)을 참고한다. 작업 규칙은 [AGENTS.md](../AGENTS.md)를 따른다.

```text
Issue 선택 → Coder 전용 브랜치·Worktree → 구현·테스트 → 사용자 PR 생성 요청
  → PR·최신 SHA 인계 → 별도 Reviewer 검토 → 문제 있으면 Coder 수정·테스트·push
  → 새 SHA로 Reviewer 재검토 → 사용자 승인·병합 요청
  → Reviewer가 GitHub 승인 → Reviewer가 조건 재확인·병합
```

2026-11-28 확인 기준, CI(커밋마다 자동 실행하는 검사), `main` 브랜치 보호, Issue·PR 이벤트에 따른 Coder/Reviewer 자동 실행은 아직 미구축이다. GitHub Actions 워크플로는 0개이고 `main` 보호와 저장소 ruleset도 설정돼 있지 않다. Issue 등록·PR 생성만으로 다음 작업이 시작되지 않는다. 사용자가 각 채팅에 요청하고 결과를 전달한다. 검사 목록이 비어 있는 상태는 CI 통과가 아니다.

## 1. 준비와 역할 분리

Git, GitHub CLI(`gh`), Python 3.12 이상, `uv`, Node.js가 필요하다. 프로젝트의 `.python-version`은 3.12이며, 의존성은 `pyproject.toml`과 `uv.lock`으로 관리한다. 저장소 루트에서 원격과 인증을 확인한다.

```sh
git remote -v
gh auth status
gh repo view baesang0522/KCS_HARNESS --json nameWithOwner,defaultBranchRef
```

인증되지 않았다면 `gh auth login`으로 로그인한다. 원격이 대상 저장소인지 확인하고, 기준 브랜치는 사용자 지정 또는 기존 PR의 대상 브랜치를 따른다. 둘 다 없으면 저장소 기본 브랜치를 사용한다. 이 문서 작성 시 기본 브랜치는 `main`이다.

| 담당 | 할 일 | 다음 단계에 전달할 것 |
| --- | --- | --- |
| 사용자 | Issue와 완료 조건 선택, 별도 채팅 준비, Coder에 PR 생성 요청·Reviewer에 승인·병합 요청 | Issue URL, 각 단계의 결과 |
| Coder 채팅 | 구현, 재현·회귀 테스트, 요청받은 커밋·push·PR 생성, 리뷰 지적 수정 | 변경 내용, 테스트 결과, PR URL, 최신 원격 SHA |
| Reviewer 채팅 | 독립 검토·재검토, 별도 Worktree 검증, 요청받은 GitHub 승인·조건 충족 후 병합 | 검토 SHA, 문제의 위치·발생 조건·영향·근거, 검증 결과, 승인·병합 상태 |

SHA는 특정 커밋을 가리키는 식별자다. 같은 PR도 push 후에는 SHA가 바뀌므로 리뷰와 테스트가 어느 코드 기준인지 함께 기록한다. Coder의 자체 점검은 독립 리뷰를 대신하지 않으며 Coder는 PR 승인·병합을 수행하지 않는다. Reviewer는 코드를 수정하지 않고 Coder에 수정 요청을 돌려준다. 승인·병합은 사용자가 해당 PR에 요청한 범위에서만 진행한다.

채팅에서 사용할 공통 스킬은 아래와 같다. 실행 환경에 해당 스킬이 제공되는지 확인하고, 없으면 설치·연결한 뒤 진행한다. 스킬 원문은 공통 관리 대상이며 이 저장소에 복사하지 않는다.

| 스킬 | 요청할 시점 |
| --- | --- |
| `issue-search` / `issue-create` | 이슈 조회 / 합의한 작업 등록 |
| `issue-implement` | 이슈 구현 또는 리뷰 지적 수정 |
| `commit-message` | 실제 변경에 맞는 한국어 Conventional Commits 메시지 작성 |
| `pr-create` | 검증한 변경을 커밋·push하고 PR 생성 |
| `pr-review` | 별도 Reviewer의 검토·재검토와 요청받은 GitHub 승인 |
| `pr-merge` | Reviewer가 승인·검증 조건을 확인한 뒤 요청받은 PR 병합 |

## 2. Issue 선택과 Coder 작업 시작

미해결 목록과 선택한 Issue의 본문·댓글을 읽는다. `N`은 실제 이슈 번호로 바꾼다. 목록이 조회 한도에 도달하면 추가 페이지를 확인한다.

```sh
gh issue list --repo baesang0522/KCS_HARNESS --state open --limit 100
gh issue view N --repo baesang0522/KCS_HARNESS --comments
```

기대 동작, 변경 범위, 완료 조건이 없는 부분은 먼저 정한다. 예를 들어 [#56](https://github.com/baesang0522/KCS_HARNESS/issues/56)은 이 문서 하나만 추가하며 앱 코드·설정은 바꾸지 않는 작업이다.

사용자가 구현용 채팅에 보낼 요청 예시:

```text
이 채팅은 Coder야.
issue-implement 스킬로 baesang0522/KCS_HARNESS의 Issue #56을 구현해.
Issue 전용 브랜치와 Worktree에서 작업하고 기존 미커밋 변경은 건드리지 마.
완료 조건을 검증하고 기준 브랜치, 작업 브랜치, Worktree 경로,
변경 내용, 테스트 결과와 미검증 항목을 보고해.
아직 PR 생성이나 병합은 하지 마.
```

Worktree는 같은 저장소의 별도 작업 폴더다. 원래 폴더의 미커밋 변경을 유지하면서 이슈별 브랜치에서 작업할 수 있다. 시작 전에 `git status --short --branch`, `git worktree list --porcelain`, 로컬·원격 브랜치와 기존 PR을 확인한다. 같은 이슈의 작업인지 커밋·PR까지 대조하고 재사용 여부를 결정한다. 다른 작업이 섞였거나 다른 세션이 사용 중이면 덮어쓰지 않는다.

아래는 **기존 작업이 없고 브랜치·경로가 비어 있을 때만** 쓰는 #56 생성 예시다. 원래 저장소 루트에서 실행한다. 다른 이슈는 번호와 설명을 바꾸고, 기본 브랜치가 변경되면 기준 참조도 바꾼다.

```sh
git fetch origin
git worktree add --no-track -b codex/issue-56-development-workflow ../KCS_HARNESS-issue-56 origin/main
cd ../KCS_HARNESS-issue-56
git status --short --branch
git branch --show-current
```

`fetch`가 실패하면 최신 기준을 확보하지 못한 것이므로 원인을 해결한 뒤 진행한다. 이미 해당 이슈 Worktree가 있다면 확인한 경로를 재사용한다. 경로·브랜치 충돌을 `--force`, reset, 삭제로 우회하지 않는다. 원래 폴더를 stash하거나 브랜치를 전환할 필요는 없다.

이후 조회·수정·테스트는 선택한 Worktree 루트에서 실행한다. 해당 Worktree의 `AGENTS.md`와 수정 경로 하위 규칙을 다시 읽는다. `.venv`나 원래 폴더의 미커밋 설정은 자동 복사되지 않는다. 필요한 환경은 새로 준비하고, 다른 작업의 변경이나 비밀 설정을 통째로 복사하지 않는다.

## 3. 구현과 검증

기존 구현과 호출부를 읽고 필요한 부분만 변경한다. 버그는 가능한 한 실제 사용 경로로 재현 테스트를 작성해 수정 전 실패를 확인하고, 수정 후 같은 테스트와 관련 회귀 테스트를 실행한다. 새 기능은 완료 조건을 테스트로 표현한다. 문서만 바꾸는 작업은 경로·명령·링크·설명과 변경 파일 범위를 검증한다.

Worktree 루트에서 의존성을 준비한다. 이 명령은 `start-external.sh`의 설치 방식과 같으며 잠금 파일을 갱신하지 않는다.

```sh
uv sync --locked --inexact
```

[README의 테스트 안내](../README.md#테스트)에 있는 전체 회귀 명령은 다음과 같다. 백엔드와 프론트엔드를 각각 실행하고 종료 코드와 최종 요약을 모두 확인한다.

```sh
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests/backend -p 'test_*.py'
node --test tests/frontend/*.cjs
```

| 경로 | 검증 범위 |
| --- | --- |
| `tests/backend/` | API, 입력·출력 검증, 작업 상태 전환, 문서 처리 등 |
| `tests/frontend/` | Excel·화면 대역을 이용한 읽기·쓰기, 작업 전환, 복구 등 |
| `tests/helpers/` | 프론트 테스트에서 사용하는 Excel API·DOM 대역 |

이 회귀 테스트는 실제 모델을 호출하지 않는다. 다만 `tests/backend/test_prompt_startup.py`의 `test_external_server_starts_with_real_runtime_and_prompts`는 `external` 설정으로 서버 초기화를 검증하므로 Worktree의 `src/config.yml`이 필요하다. 설정을 읽는 곳은 `src/settings.py`의 `load_settings()`이며, 런타임 초기화는 `src/runtime.py`의 `create_runtime()`이 맡는다. 설정 오류나 의존성 누락으로 실행되지 않은 검사는 통과로 기록하지 않는다.

관련 테스트만 먼저 실행할 때는 실제 파일명을 지정한다. 예를 들어 문서 처리 테스트는 다음과 같다.

```sh
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests/backend -p 'test_documents.py'
node --test tests/frontend/test_documents.cjs
```

실제 Excel 화면·계산 엔진·모델 해석은 위 테스트가 대신하지 않는다. 그 동작을 바꾸면 [사용 안내](usage.md)와 [README 실행 안내](../README.md#실행)에 따라 별도 확인한다. `scripts/evaluate_agent.py`, `scripts/evaluate_routing.py`는 실제 모델을 호출하는 평가 스크립트이므로 일반 회귀 테스트와 구분한다. 실행하지 못한 검증은 이유와 함께 남긴다.

마지막으로 변경 범위를 확인한다.

```sh
git status --short
git diff --check
git diff
git diff --cached
```

새 파일은 일반 `git diff`에 나타나지 않으므로 `git status`에서 찾고 내용을 직접 읽는다. 보고에는 실행한 명령, 성공·실패 및 건수, 미검증 사항을 적는다. 실패한 검사를 통과시키려고 검증 기준을 약화하지 않는다.

## 4. 커밋과 PR 생성

사용자가 구현 결과를 확인하고 다음 단계로 진행하려면 같은 Coder 채팅에 요청한다.

```text
pr-create 스킬로 Issue #56의 검증한 변경을 커밋·push하고 PR을 만들어.
이슈 범위의 파일만 포함하고, commit-message 규칙으로 메시지를 작성해.
본문에 변경 이유, 완료 조건 충족 여부, 테스트 결과와 Closes #56을 넣어.
Reviewer에게 전달할 PR URL과 최신 원격 head SHA를 보고해. 병합은 하지 마.
```

전체 완료가 아닌 부분 작업이면 `Closes #56` 대신 `Refs #56`을 사용한다. 기존 열린 PR이 있으면 중복 생성하지 않고 해당 PR을 갱신한다. PR 대상 브랜치는 앞서 정한 기준 브랜치다.

커밋 메시지는 `type(scope): 설명` 형식이며 scope는 생략할 수 있다. 타입은 영문 소문자, 설명은 실제 변경을 나타내는 한국어로 작성한다. 예시:

```text
docs: Coder·Reviewer 개발 작업 절차 추가
fix(excel): 열 이름 변경 후 검토 데이터 반영 실패 수정
test: PDF 수정 반영 후 작업 범위 회귀 검사 추가
```

예시는 형식 안내다. 실제 diff에 없는 수정이나 테스트 결과를 메시지에 넣지 않는다. 커밋 전에 포함할 파일만 지정해 스테이징하고 `git diff --cached`로 다른 작업이 섞이지 않았는지 확인한다.

Coder는 다음 정보를 묶어서 보고하고 사용자가 Reviewer 채팅에 전달한다: 저장소·Issue URL, PR URL, 기준 브랜치, 최신 원격 head SHA, 변경 목적·주요 파일, 완료 조건, 테스트 명령·결과·미검증 항목. PR 번호는 이슈 번호와 다를 수 있다.

## 5. 독립 리뷰와 수정·재검토

별도 Reviewer 채팅을 열고 아래 자리표시자를 실제 값으로 바꿔 요청한다. 아래 예시는 검토·보고만 요청하며, 승인·병합까지 요청하는 예시는 6절에 있다. 채팅 이름만 바꾸거나 같은 구현 채팅에 리뷰를 요청하는 것은 독립 리뷰가 아니다.

```text
이 채팅은 Reviewer야.
pr-review 스킬로 <PR URL>을 검토해. 관련 이슈는 #56이고 인계 SHA는 <SHA>야.
최신 head SHA와 대조하고, Coder와 별도인 Worktree에서 필요한 테스트를 실행해.
코드는 수정하지 말고 심각도, 파일·줄, 발생 조건, 영향, 근거를 보고해.
검토 SHA, 테스트 결과, 미검증 사항과 Coder에게 보낼 수정 요청도 정리해.
GitHub에 리뷰를 게시하거나 병합하지 마.
```

Reviewer는 `gh pr view <PR URL> --json headRefOid,baseRefName`으로 최신 커밋을 확인한다. 실행 검증은 해당 SHA를 가져온 뒤 별도 폴더에서 한다. 아래 자리표시자는 실제 값으로 바꾸며, 이미 존재하는 경로를 덮어쓰지 않는다.

```sh
git fetch origin pull/<PR번호>/head
git rev-parse FETCH_HEAD
```

가져온 SHA가 앞서 확인한 최신 head SHA와 일치하는지 대조한다. 다르면 PR을 다시 조회하고 최신 커밋을 가져온 뒤 진행한다. 일치하면 다음과 같이 생성한다.

```sh
git worktree add --detach ../KCS_HARNESS-pr-<PR번호>-review-<짧은SHA> <확인한-head-SHA>
```

`--detach`는 Coder 브랜치를 움직이지 않고 특정 커밋을 검토하기 위한 방식이다. 리뷰 폴더에서 `git rev-parse HEAD`가 검토 SHA인지 확인하고, 3절대로 독립 환경과 테스트를 준비한다. 보고 직전 최신 SHA가 바뀌었다면 변경분을 다시 검토한다.

문제가 있으면 사용자가 원래 Coder 채팅에 전달한다.

```text
Issue #56의 기존 브랜치·Worktree에서 아래 리뷰 지적을 수정해.
PR: <PR URL>
검토 SHA: <SHA>
지적: <파일·줄 / 발생 조건 / 영향 / 근거>
재현·회귀 테스트를 실행하고, 지적을 적용하지 않는다면 이유를 설명해.
수정 파일만 커밋·push하고 새 원격 head SHA와 항목별 결과를 보고해.
병합은 하지 마.
```

그 결과를 Reviewer에게 전달해 “`<PR URL>`의 새 SHA `<SHA>`를 재검토하고, 기존 지적 해결 여부와 새 회귀 문제를 확인해”라고 요청한다. 코드를 다시 바꾸면 이전 SHA의 리뷰·테스트만으로 최종 완료를 판단하지 않는다.

Reviewer의 결론은 `수정 필요`, `발견한 문제 없음`, `검증 미완료`를 구분한다. 채팅의 리뷰 결과는 GitHub 승인 완료를 뜻하지 않는다.

현재 공통 스킬에서는 `gh api user`의 로그인 계정이 PR 작성자와 같거나 승인 권한이 부족하면 **GitHub 승인·병합 흐름을 모두 중단**한다. 별도 Reviewer 채팅도 같은 GitHub 계정을 쓰면 이 제약이 적용된다. 채팅상 검토 결과와 중단 사유는 보고할 수 있지만, 승인 불가 상태에서 병합만 진행하지 않는다. 계정 전환이나 보호 규칙 완화로 우회하지 않으며, 채팅의 “발견한 문제 없음”을 유효한 GitHub 승인으로 대신하지 않는다.

## 6. Reviewer 승인·병합 요청과 종료

사용자는 Reviewer 채팅에 검토·승인·조건 충족 시 병합까지 함께 요청할 수 있다. 앞서 검토만 요청했다면 완료 조건 충족과 지적 해결을 확인한 뒤 같은 Reviewer에게 아래 요청을 전달한다. 이미 해당 PR의 승인·병합까지 요청했다면 조건 충족 후 같은 권한을 다시 묻지 않는다.

```text
Reviewer로서 pr-review 스킬로 <PR URL>의 최신 SHA를 검토·재검토하고,
문제와 미완료 검증이 없으면 검토한 SHA에 대해 GitHub 승인을 제출해.
PR 작성자와 로그인 계정이 같거나 승인 권한이 부족하면 승인·병합을 중단하고 보고해.
승인 후 pr-merge 스킬로 리뷰·미해결 대화, 테스트·CI, 충돌과 보호 규칙을 확인해.
모든 조건을 충족하면 검증한 SHA를 지정해 병합하고, 아니면 중단 사유를 보고해.
```

Reviewer는 최신 head SHA에 대한 독립 리뷰와 유효한 GitHub 승인을 확인한다. 승인만 요청받았다면 승인 결과를 보고하고 종료하며, 병합까지 요청받았어도 승인 후 병합 검증을 생략하지 않는다. 검토 SHA·판정, GitHub 승인 상태, 병합 완료·대기·중단 상태와 사유를 구분해 보고한다.

현재 CI가 없으므로 `gh pr checks`의 빈 결과를 성공으로 해석하지 않는다. 최신 SHA에 대한 로컬 테스트와 수동 검증 근거를 확인하고, 필요한 검증이 미완료면 병합하지 않는다. 이후 보호 규칙·필수 CI·승인이 추가되면 그 조건도 충족해야 한다. 검사 우회나 관리자 강제 병합은 하지 않는다.

병합 직전에 커밋이 바뀌면 새 SHA를 다시 검증한다. 병합 결과는 PR의 실제 상태와 대상 브랜치로 확인한다. 병합 대기열 진입은 병합 완료와 구분한다. Worktree와 브랜치는 후속 작업을 위해 유지하며, 다른 세션의 미커밋 변경이나 작업 폴더를 자동 정리하지 않는다.
