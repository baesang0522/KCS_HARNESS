"use strict";

(function () {
    async function requestJson(path, options) {
        var response = await fetch(path, options);
        var data = await response.json().catch(function () {
            return {};
        });

        if (!response.ok) {
            var detail = '요청 실패: HTTP ' + response.status;

            if (typeof data.detail === 'string') {
                detail = data.detail;
            } else if (Array.isArray(data.detail)) {
                detail += '\n' + data.detail.map(function (item) {
                    var field = (item.loc || []).join('.');
                    return field + ': ' + item.msg;
                }).join('\n');
            }
            var error = new Error(detail);
            error.status = response.status;
            throw error;
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
