"use strict";

(function () {
    window.createWorkspaceHistory = function (options) {
        var records = [];

        async function refreshSheets() {
            var entries = await window.workspaceStore.list();

            options.ui.savedWorkspaces(
                entries,
                options.getWorkspace()
            );

            return entries;
        }

        async function refreshJobs() {
            var workspace = options.getWorkspace();

            records = [];
            options.ui.jobs([], workspace);

            if (!workspace) return;

            records = await options.jobs.list(workspace);
            options.ui.jobs(records, workspace);
        }

        async function run(action) {
            if (options.isBusy()) return;

            options.setBusy(true);

            try {
                await action();
            } catch (error) {
                options.ui.status(error.message);
            } finally {
                options.setBusy(false);
            }
        }

        return {
            refreshSheets: refreshSheets,
            refreshJobs: refreshJobs,

            switchWorkspace: function () {
                return run(async function () {
                    var key = options.ui.savedWorkspace();

                    await options.save();

                    var entries = await window.workspaceStore.list();
                    var saved = entries.find(function (entry) {
                        return window.workspaceStore.identity(entry) === key;
                    });

                    if (!saved) {
                        throw new Error(
                            "선택한 작업 시트를 찾을 수 없습니다."
                        );
                    }

                    await options.activate(saved);

                    await refreshSheets();
                    await refreshJobs();

                    options.ui.status(
                        "작업 시트를 전환했습니다. " +
                        "현재 셀 값으로 이어서 작업합니다."
                    );
                });
            },

            resumeResult: function () {
                return run(async function () {
                    var id = options.ui.selectedJob();

                    await refreshJobs();

                    var job = records.find(function (item) {
                        return item.source.operation_job_id === id;
                    });

                    if (!job || job.status !== "APPLIED") {
                        throw new Error(
                            "적용 완료된 실행의 결과를 선택하세요."
                        );
                    }

                    await options.selectResult(job);

                    options.ui.status(
                        "이전 결과 열을 선택했습니다. " +
                        "다음 작업은 현재 표의 전체 행을 다시 읽습니다."
                    );
                });
            },

            reload: function () {
                return run(async function () {
                    await refreshSheets();
                    await refreshJobs();
                });
            }
        };
    };
})();
