"use strict";

(function () {
    var apiBase = window.location.pathname.split("/static/excel/")[0];

    async function requestJson(path, options) {
        var response;
        try {
            response = await fetch(apiBase + path, options);
        } catch (error) {
            if (error.name === "AbortError") throw error;
            throw new Error("서버에 연결하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.");
        }
        var data = await response.json().catch(function () { return null; });
        if (!response.ok) {
            // 업무·입력 오류 문구는 서버가 결정하고, 프론트는 그대로 표시한다.
            var detail = data && typeof data.detail === "string" && data.detail.trim()
                ? data.detail
                : "서버 요청에 실패했습니다. 잠시 후 다시 시도하세요. (HTTP " + response.status + ")";
            var error = new Error(detail);
            error.status = response.status;
            throw error;
        }
        if (!data || typeof data !== "object") {
            throw new Error("서버 응답을 읽지 못했습니다. 다시 시도하세요.");
        }

        return data;
    }

    function newRequestId() {
        // HTTP 개발 환경에서도 사용할 수 있는 UUID 생성
        var bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);

        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;

        var hex = Array.from(bytes, function (value) {
            return value.toString(16).padStart(2, '0');
        }).join('');

        return hex.slice(0, 8) + '-' +
            hex.slice(8, 12) + '-' +
            hex.slice(12, 16) + '-' +
            hex.slice(16, 20) + '-' +
            hex.slice(20);
    }

    window.apiClient = { requestJson: requestJson, newRequestId: newRequestId };
})();
