"use strict";

(function () {
    window.createOperationJobs = function (api, getConversationId) {
        function post(path, body, signal) {
            return api.requestJson(path, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(body),
                signal: signal
            });
        }

        function path(job, action) {
            return "/operation-jobs/" +
                encodeURIComponent(job.source.operation_job_id) +
                "/" + action +
                "?conversation_id=" +
                encodeURIComponent(job.source.conversation_id);
        }

        return {
            create: function (workspace, target, operation) {
                var models = workspace.columns.filter(function (column) { return column.role === "model_spec"; });
                return post("/operation-jobs", {
                    operation_job_id: api.newRequestId(),
                    conversation_id: getConversationId(),
                    workspace_id: workspace.workspace_id,
                    worksheet_id: workspace.worksheet_id,
                    table_id: String(workspace.table_id),
                    task_type: workspace.task_type,
                    row_filter: workspace.row_filter || null,
                    model_spec_column_id: models.length === 1 ? String(models[0].column_id) : null,
                    row_start: target.row_start,
                    row_count: target.row_count,
                    operation: operation
                });
            },

            preview: function (job, rows, signal, selectedCount) {
                return post(
                    path(job, "preview"),
                    {rows: rows, selected_count: selectedCount || rows.length},
                    signal
                );
            },

            beginApply: function (job, output) {
                return post(path(job, "apply"), output);
            },

            status: function (job, status, ids) {
                return post(path(job, "status"), {
                    status: status,
                    result_column_ids: ids || []
                });
            }
        };
    };
})();