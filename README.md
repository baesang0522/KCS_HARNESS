# KCS_HARNESS

Excel 추가 기능에서 원본 데이터를 작업표로 가져와 정제·비교하고 PDF 근거와 함께 검토하는 PoC다. 서버는 모델 호출·검증·실행 기록을 맡고, 실제 Excel 값 읽기·쓰기는 추가 기능이 수행한다.

## 어디부터 볼지

- [코드 지도](docs/architecture.md): 폴더·파일별 역할, 호출 흐름, 상태 소유권, 수정 위치.
- [요청·Excel 적용 로그](docs/logging.md): 요청 ID로 미리보기·적용·완료 미확인·복구 기록 찾기.
- [현재 사용 안내](docs/usage.md): 화면과 채팅 작업, 저장·복구, 현재 제약.
- [개발 계획·완료 이력](docs/development.md): 미완료 계획과 과거 검증 기록.
- [이전 기능 설명](docs/history.md): 과거 UI·보류 기능의 설명 보관. 현재 사용법과 구분한다.

## 실행

Python 3.12 이상, `uv`, Codex CLI가 필요하다. 외부 모델은 먼저 `codex login`을 완료한다. 프로젝트 루트에서:

```sh
./start-external.sh
```

실행 파일은 잠금 파일 기준으로 의존성을 준비하고 `KCS_ENV=external`, 단일 프로세스로 서버를 시작한다.

- 화면: [Excel 작업창](http://localhost:8000/static/excel/taskpane-current.html)
- API: [API 문서](http://localhost:8000/docs)
- 종료: `Ctrl+C`
- 환경 선택·모델 연결: `src/settings.py`, `src/config.yml`, `src/runtime.py`. `KCS_ENV`로 `internal` 또는 `external`을 선택한다.

대화·문서·조사·실행 기록은 서버 메모리에 있다. 서버 재시작 시 사라지며 여러 프로세스에 공유되지 않으므로 `--workers 1`을 유지한다. Excel에 기록된 값과 통합문서 작업 정보는 별도로 남는다.

## 테스트

프로젝트 루트에서 실행한다. 아래 회귀 테스트는 실제 모델을 호출하지 않는다. 프론트 테스트에는 Node.js가 필요하다.

```sh
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests/backend -p 'test_*.py'
node --test tests/frontend/*.cjs
```

`tests/backend/`는 API·검증·상태 전환, `tests/frontend/`는 Excel/DOM 대역을 통한 읽기·쓰기·복구, `tests/helpers/`는 그 대역을 담당한다. 실제 Excel의 화면·계산 엔진과 실제 모델 해석은 별도로 확인한다.

`scripts/evaluate_routing.py`, `scripts/evaluate_agent.py`는 설정된 **실제 모델을 호출**하는 합성 데이터 점검이다. 실제 Excel 파일은 읽거나 수정하지 않는다. 실행 환경에 맞춰 `PYTHONPATH=src KCS_ENV=external .venv/bin/python scripts/evaluate_agent.py`처럼 실행한다. 라우팅 평가의 도움 카드 사례는 보류된 흐름을 포함하므로 현재 기능 지원 판정과 구분한다.

## 디버깅 로그

서버 표준 출력에 `print(..., flush=True)`로 한 줄 JSON을 남긴다.

- `conversation_id`·`request_id`: 대화와 요청 연결.
- `graph_id`·`tool_call_id`: 모델 선택과 도구 실행 연결.
- `run_id`·실행 결과의 `step_id`: Excel 왕복 실행 연결.
- `model.*`: 작업 문맥·대화·선택한 도구·오류·시간.
- `tool.*`: 도구 이름·인자·결과·오류·재시도 여부.
- `agent.advance.*`, `agent.failed`: Excel에서 돌아온 결과와 다음 단계.
- `origin_request_id`·`job_id`: 원래 채팅과 정제·수식 작업 연결.
- `operation.*`, `formula.*`, `write_recovery.*`: 미리보기·적용 시작·완료 보고·복구 상태. 단계 처리 완료와 실제 적용 완료(`APPLIED`)를 구분한다. 자세한 예시는 [로그 안내](docs/logging.md)를 참고한다.

구조화된 비밀번호·API 키·토큰 필드는 가린다. 업무 데이터·자유 입력은 기록되므로 공유 전에 확인한다. 별도 로그 파일 저장·순환은 없으며 필요하면 서버 출력을 파일로 저장한다.

## PDF 기준 모델명 추출

- 모델명 PDF의 검토 내용을 반영한 뒤 “모델명 추출해줘”라고 요청하면, 현재 작업 범위의 모델규격명에서 기준 모델명을 대조한다.
- 기존 채팅 미리보기에서 확인·적용하며 새 열 `모델명`, `모델명 종류`를 함께 만든다. 종류는 PDF 분류 그대로 사용한다.
- 대소문자·연속 공백을 통일하고 모델 표기의 경계를 확인한다. 하이픈 등 기호와 괄호 속 별칭을 임의로 바꾸거나 유사도로 추정하지 않는다.
- 복수 모델·분류는 같은 순서로 줄바꿈해 보존한다. 미검출은 두 열 모두 빈칸이며 MODEL·GRADE 등의 보조 추출을 자동 실행하지 않는다.
- PDF 목록 변경·미반영 수정·원본 변경은 새 미리보기를 요구한다. 모델명 일치는 두께·HS 등 추가 조건 충족 판정이 아니다.
