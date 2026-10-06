"""Excel이 이전 화면 파일을 재사용하지 않도록 버전이 붙은 자산을 전달한다."""
import hashlib
import re
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter()
ROOT = Path(__file__).resolve().parents[1] / "static" / "excel"


@router.get("/static/excel/taskpane.html", response_class=HTMLResponse, include_in_schema=False)
@router.get("/static/excel/taskpane-current.html", response_class=HTMLResponse, include_in_schema=False)
def taskpane():
    def versioned(match):
        path = match[2]
        version = hashlib.sha256((ROOT / path).read_bytes()).hexdigest()[:12]
        return f'{match[1]}="{path}?v={version}"'

    html = re.sub(r'(src|href)="([^"?]+\.(?:js|css))"', versioned,
                  (ROOT / "taskpane.html").read_text())
    build = hashlib.sha256(html.encode()).hexdigest()[:12]
    html = html.replace('name="kcs-ui-version" content="local"', f'name="kcs-ui-version" content="{build}"')
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})
