"use strict";
// 서버가 페이지에 포함한 공통 문구를 사용한다. 업무 문구를 프론트에 복제하지 않는다.
window.errorMessages = JSON.parse(document.getElementById("server-error-messages").textContent);
