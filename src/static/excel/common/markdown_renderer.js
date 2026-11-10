"use strict";

(function () {
    function render(element, text) {
        var source = String(text == null ? "" : text);

        // 라이브러리 로드 실패 시에도 답변 원문은 보여준다.
        element.classList.remove("markdown-body");
        element.textContent = source;

        if (!window.marked || !window.DOMPurify ||
            !window.DOMPurify.isSupported) {
            return;
        }

        try {
            var html = window.marked.parse(source, {
                gfm: true,
                breaks: true,
                async: false
            });

            element.innerHTML = window.DOMPurify.sanitize(html, {
                ALLOWED_TAGS: [
                    "p", "br", "strong", "em", "del",
                    "h1", "h2", "h3", "h4", "h5", "h6",
                    "ul", "ol", "li", "blockquote",
                    "pre", "code", "hr",
                    "table", "thead", "tbody", "tfoot",
                    "tr", "th", "td", "a"
                ],
                ALLOWED_ATTR: ["href", "title", "start"],
                ALLOW_DATA_ATTR: false,
                ALLOW_ARIA_ATTR: false
            });

            element.classList.add("markdown-body");
        } catch (error) {
            element.textContent = source;
            console.error("Markdown 렌더링 실패", error);
        }
    }

    window.markdownRenderer = { render: render };
})();
