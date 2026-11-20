# 채팅에서 Excel 적용까지 로그 읽기

서버 표준 출력의 한 줄 JSON 로그를 사용한다. LangSmith 연동이나 별도 로그 저장소는 추가하지 않았다. 로그 출력 실패가 실제 작업을 실패시키지 않도록 `services/debug_log.py`에서 처리한다.

## 어떤 ID로 찾는가

| 필드 | 의미 |
| --- | --- |
| `conversation_id` | 대화 ID |
| `request_id` | 현재 채팅 또는 에이전트 왕복 요청 ID. 기존 취소·중복 요청 처리에 사용 |
| `origin_request_id` | 해당 작업을 시작하거나 에이전트를 재개한 채팅 요청 ID |
| `job_id`, `job_kind` | 정제 또는 수식 작업 ID와 종류 |
| `workspace_id` | 작업표 연결 ID. 작업표 밖 수식 작업은 없을 수 있음 |
| `run_id`, `step_id` | 에이전트 실행과 단계. `agent.job_bound`에서 작업 ID와 연결 |
| `preview_id` | 수식 계산 계획 ID |

채팅의 `request_id`가 작업 생성 요청의 `origin_request_id`로 전달되어 작업에 보관된다. 에이전트는 Excel과 왕복할 때 현재 `request_id`를 갱신하므로, 별도의 `origin_request_id`를 보관한다. 새 목표나 명시적인 재개는 그 채팅 요청으로 갱신한다. 이미 생성한 작업의 출처는 바뀌지 않는다. 후속 작업도 같은 출처를 전달받으며 서로 다른 작업 ID로 구분한다.

구버전 클라이언트나 채팅을 거치지 않은 호출은 `origin_request_id`를 생략할 수 있다. 이 경우 `null`이며 대화·작업 ID로 추적한다. 추적 ID는 인증·승인 근거로 사용하지 않는다.

## 정제 예시: 공급자명 앞뒤 공백을 새 열로 저장

각 단계의 `.started`는 요청 처리 시작, `.completed`는 해당 API 처리 완료다. 예외는 `.failed`로 기록한다. **`.completed`라는 이름만으로 Excel 적용 완료를 판단하지 않는다.** 최종 `status`를 확인한다.

```text
chat.received                      request_id=R
model.* / tool.*                   request_id=R
operation.create.completed         origin_request_id=R job_id=J status=CREATED
operation.preview.completed        origin_request_id=R job_id=J status=CREATED
operation.status.completed         origin_request_id=R job_id=J status=PREVIEW_READY
  [사용자가 미리보기를 확인하고 적용]
operation.apply_start.completed    origin_request_id=R job_id=J status=APPLYING
write_recovery.evidence.completed  origin_request_id=R job_id=J status=APPLYING
  [Excel에서 실제 값 기록]
operation.status.completed         origin_request_id=R job_id=J status=APPLIED
```

- 미리보기는 여러 묶음으로 계산하므로 `operation.preview`가 반복될 수 있다. `batch_row_count`, `selected_count`, `result_row_count`, `changed_count`로 구분한다. `changed_count`는 해당 묶음의 계산 결과이며 실제 저장 건수로 해석하지 않는다.
- `PREVIEW_READY`: 미리보기 준비 완료. 셀 쓰기 완료가 아니다.
- `APPLYING`: 서버가 적용 시작을 허용했다. 실제 셀 쓰기는 프런트의 기존 Excel 코드가 수행한다.
- `APPLIED`: 기존 검증을 통과한 클라이언트 완료 보고가 서버에 기록됐다.
- `NO_CHANGE`, `CANCELLED`, `FAILED`: 변경 없음·취소·실패 상태. 적용 성공으로 보지 않는다.
- `UNKNOWN`: 쓰기가 일부 또는 전부 반영됐을 가능성이 있지만 완료 확인이 되지 않았다. 자동으로 다시 쓰지 않는다.
- `previous_status`, `reported_status`, 최종 `status`를 구분한다. 거절된 상태 보고에는 최종 성공 상태가 기록되지 않는다.
- `replayed=true`는 같은 생성·완료 요청 등의 재보고를 식별한다. 실제 Excel을 다시 썼다는 뜻이 아니다.

기존 순수 연산 진단은 `operation.execute` JSON 로그로 유지한다. 이 보조 이벤트에는 작업 ID가 없으므로 요청 연결은 `operation.preview` 등 위 작업 이벤트를 기준으로 한다.

## 수식과 복구

수식도 `formula.create` → `formula.preview` → `formula.apply_start` → `formula.status`로 연결한다. 수식 미리보기는 실제 계산값이 아니라 계산 계획이다. `formula.status`의 `APPLIED`는 값 고정 후 완료 보고, `UNKNOWN`은 완료 미확인 보고다. 기존 본문 없는 `/unknown` 요청도 허용한다.

쓰기 전 증거 저장은 `write_recovery.evidence`, 이후 읽기 전용 대조·사용자 확인은 `write_recovery.check`로 남긴다. 후자는 `method`가 `comparison` 또는 `user`이며 `conclusion`과 최종 상태를 기록한다. 복구 확인으로 `APPLIED`가 돼도 셀을 다시 작성한 것은 아니다.

프런트가 기존 실패 보고를 보낼 수 있으면 오류 문구를 `client_error`로 기록한다. 통신이 완전히 끊겨 보고가 도착하지 않으면 서버에는 마지막 수신 상태만 남는다. 새로운 진단 요청이나 자동 재시도는 추가하지 않는다. Excel 쓰기 이전의 모든 화면 오류·사용자 조작을 별도로 수집하는 기능은 아니다.

## 데이터와 시간의 의미

새 작업 로그는 ID·단계·상태·행 수·결과 열 ID·오류·시간을 기록한다. 셀 배열, 수식 본문, PDF 원문, 쓰기 증거의 값·해시를 새 작업 로그에 복사하지 않는다. 기존 모델·도구 로그는 종전처럼 작업 문맥·인자·응답을 기록하므로 업무 데이터가 포함될 수 있다. 오류 문구에도 데이터가 들어갈 수 있다.

`elapsed_ms`는 각 API 처리 시간이다. 사용자 승인 대기 시간이나 Excel 쓰기 시간 전체가 아니다. 별도 로그 파일 저장·순환은 없으며 서버 출력을 파일로 저장했다면 `rg '요청-ID-또는-작업-ID' server.log`로 연결된 기록을 찾을 수 있다.

## 구현 위치

- `static/excel/chat/chat.js`, `chat/agent.js`, `taskpane.js`: 채팅·에이전트 응답의 출처 전달.
- `workspace/workspace.js`, `operations/operations.js`, `operation_jobs.js`: 현재 작업 출처를 생성 요청에 전달. 미리보기·적용·완료는 기존 작업 ID 사용.
- `formula/formula.js`: 수식 생성 출처 및 기존 실패 보고의 오류 문구 전달.
- `services/agent_runs/schemas.py`, `service.py`: 에이전트 원래 요청 보관과 공개 응답.
- `services/operations/jobs.py`, `services/formula/schemas.py`: 선택적 출처·진단 입력 필드.
- `api/operation_jobs.py`, `formula_jobs.py`, `write_recovery.py`, `agent_runs.py`: 기존 검증·상태 전환 주변의 로그.
- `services/debug_log.py`: 공통 JSON 출력, 비밀 필드 마스킹, 단계별 시간·오류 기록.
