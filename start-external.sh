#!/usr/bin/env bash
set -euo pipefail

# 다른 폴더에서 실행해도 이 프로젝트의 설정과 가상환경을 사용한다.
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

for program in uv codex; do
    if ! command -v "$program" >/dev/null 2>&1; then
        printf '실행에 필요한 %s 명령을 찾을 수 없어. 설치 후 다시 실행해줘.\n' "$program" >&2
        exit 1
    fi
done

# 사용자가 별도로 설치한 패키지는 유지한다.
uv sync --locked --inexact
export KCS_ENV=external

printf '\n외부용 서버 시작 (Codex CLI 연결)\n'
printf '화면: http://localhost:8000/static/excel/taskpane-current.html\n'
printf 'API: http://localhost:8000/docs\n'
printf '종료: Ctrl+C / 모델 호출에는 codex login이 필요해.\n\n'
exec .venv/bin/python -m uvicorn main:app --app-dir "$PROJECT_DIR/src" --host 127.0.0.1 --port 8000 --workers 1
