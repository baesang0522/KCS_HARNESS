# KCS_HARNESS
harness demo

workflows/service build_followup_messages 수정 필요

## 작업 API

모델규격 정제와 해외거래처 정제는 같은 `/jobs` API를 사용한다.
요청 데이터의 `samples` 또는 `rows` 구조로 작업 서비스를 선택하고, 생성된 작업 종류에 따라
`GET /jobs/{job_id}`와 `POST /jobs/{job_id}/analyze`가 해당 서비스를 호출한다.

해외거래처 정제는 같은 국가코드에서 정규화 상호가 같거나 문자열 유사도가 0.9 이상이며
기존 해외거래처부호가 다른 행을 후보로 만든다. 모델은 후보를 검토해 최종 검토 후보와 근거만
제공하며 승인, 대표 부호 선택, 엑셀 반영은 수행하지 않는다. 입력 행 수 제한은 없고 Excel 범위는
1,000행씩 나눠 읽는다.
